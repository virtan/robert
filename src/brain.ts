import fs from 'node:fs';
import type { Config } from './config.ts';
import { body, buildContext, displayName, estimateTokens, header, isImage, isPdf, loadTemplate, renderSystem } from './context.ts';
import type { ChatRow, DB, MessageRow, NewMessage } from './db.ts';
import { log } from './log.ts';
import { dataUrl } from './media.ts';
import type { Catalog } from './models.ts';
import { OpenRouterError, type ChatMessage, type ChatRequest, type ContentPart, type OpenRouter } from './openrouter.ts';
import { runTool, toolDefinitions, TOOLS_HELP, type Outbox } from './tools.ts';

const MAX_STEPS = 8;
export const NOREPLY = 'NOREPLY';

export interface BrainDeps {
  db: DB;
  or: OpenRouter;
  catalog: Catalog;
  config: Config;
  mediaDir: string;
  /** Persists config changes made at runtime (e.g. the global model). */
  persistConfig?: () => void;
}

/** Everything that talks to the LLM: answering, judging, summarizing, describing media. */
export class Brain {
  readonly db: DB;
  readonly or: OpenRouter;
  readonly catalog: Catalog;
  readonly config: Config;
  readonly mediaDir: string;
  readonly persistConfig: () => void;

  constructor(deps: BrainDeps) {
    this.db = deps.db;
    this.or = deps.or;
    this.catalog = deps.catalog;
    this.config = deps.config;
    this.mediaDir = deps.mediaDir;
    this.persistConfig = deps.persistConfig ?? (() => {});
    this.or.onUsage = ({ kind, model, usage, chatId }) =>
      this.db.addUsage({ chatId, kind, model, cost: usage?.cost, promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens });
  }

  modelFor(chat: ChatRow): string {
    return chat.model || this.config.models.chat;
  }

  overBudget(): boolean {
    return this.config.dailyBudgetUsd > 0 && this.db.spentToday() >= this.config.dailyBudgetUsd;
  }

  ownerName(): string {
    const row = this.db.sql
      .prepare('SELECT user_name, username FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 1')
      .get(this.config.ownerId) as { user_name: string | null; username: string | null } | undefined;
    return row ? displayName(row) : `Telegram user ${this.config.ownerId}`;
  }

  /** Stores a message Robert sent, so it's part of the history. */
  recordSelf(chatId: number, tgId: number, m: Partial<NewMessage>): number {
    return this.db.insertMessage({
      chat_id: chatId, tg_id: tgId, thread_id: m.thread_id ?? null, user_id: null, user_name: this.config.names[0] || 'Robert',
      username: this.config.botUsername, is_self: 1, date: Math.floor(Date.now() / 1000), reply_to: m.reply_to ?? null,
      forwarded_from: null, kind: m.kind ?? 'text', text: m.text ?? null, extracted: m.extracted ?? null,
      media_path: m.media_path ?? null, media_mime: m.media_mime ?? null, media_name: null, duration: null,
    });
  }

  // ---- answering

  /** Runs the model with tools. Returns the text to send, or null when there is nothing to say. */
  async respond(chat: ChatRow, trigger: MessageRow, reason: 'direct' | 'judge', outbox: Outbox): Promise<string | null> {
    await this.catalog.ensure();
    const model = this.modelFor(chat);
    try {
      return await this.respondWith(chat, trigger, reason, outbox, model, true);
    } catch (err) {
      // Some providers reject attachments the catalog says they accept; retry once as text.
      if (err instanceof OpenRouterError && err.status === 400 && /image|file|pdf|media|modalit/i.test(err.message)) {
        log.warn(`model ${model} rejected media, retrying text-only: ${err.message}`);
        return this.respondWith(chat, trigger, reason, outbox, model, false);
      }
      throw err;
    }
  }

  private async respondWith(
    chat: ChatRow, trigger: MessageRow, reason: 'direct' | 'judge', outbox: Outbox, model: string, media: boolean,
  ): Promise<string | null> {
    const useTools = this.catalog.supports(model, 'tools');
    const system = renderSystem(loadTemplate(), {
      config: this.config,
      chat,
      model,
      ownerName: this.ownerName(),
      tools: useTools ? TOOLS_HELP : 'None: this model does not support tools. Say so if asked to search, remind or create media.',
    });
    const ctx = await buildContext({
      db: this.db, config: this.config, chat, model, trigger, reason, system,
      canSee: media && this.catalog.supports(model, 'image'),
      canReadFiles: media,
      describe: (m) => this.describe(m, chat.id),
    });
    const req: ChatRequest = { model, messages: ctx.messages, max_tokens: 4096 };
    if (useTools) {
      req.tools = toolDefinitions();
      req.max_tool_calls = 10;
    }
    if (ctx.hasFiles) {
      req.plugins = [{ id: 'file-parser', pdf: { engine: this.catalog.supports(model, 'file') ? 'native' : 'cloudflare-ai' } }];
    }

    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await this.or.chat(req, { kind: 'chat', chatId: chat.id });
      const msg = res.choices[0].message;
      const calls = (msg.tool_calls ?? []).filter((c) => c.type === 'function');
      if (!calls.length) return finalText(msg);
      req.messages.push({
        role: 'assistant',
        content: msg.content ?? null,
        tool_calls: calls,
        ...(msg.reasoning_details ? { reasoning_details: msg.reasoning_details } : {}),
      });
      for (const c of calls) {
        const result = await runTool(c.function.name, c.function.arguments, { brain: this, chat, trigger, outbox });
        req.messages.push({ role: 'tool', tool_call_id: c.id, content: result });
      }
    }
    req.messages.push({ role: 'user', content: 'Tool budget exhausted. Give your final answer now, without tools.' });
    const res = await this.or.chat({ ...req, tool_choice: 'none' }, { kind: 'chat', chatId: chat.id });
    return finalText(res.choices[0].message);
  }

  // ---- media understanding

  /** One-off look at an image or PDF, using the vision model. */
  async lookAt(m: MessageRow, question: string, chatId: number): Promise<string> {
    let data: Buffer;
    try {
      data = fs.readFileSync(m.media_path!);
    } catch {
      return 'The file is no longer available.';
    }
    const part: ContentPart = isPdf(m)
      ? { type: 'file', file: { filename: m.media_name || 'document.pdf', file_data: dataUrl('application/pdf', data) } }
      : { type: 'image_url', image_url: { url: dataUrl(m.media_mime!, data) } };
    const model = this.config.models.vision;
    const res = await this.or.chat(
      {
        model,
        max_tokens: 1500,
        messages: [{ role: 'user', content: [{ type: 'text', text: `${question}\n\nContext: ${body(m).slice(0, 1000)}` }, part] }],
        ...(isPdf(m) ? { plugins: [{ id: 'file-parser', pdf: { engine: this.catalog.supports(model, 'file') ? 'native' : 'cloudflare-ai' } }] } : {}),
      },
      { kind: 'vision', chatId },
    );
    return finalText(res.choices[0].message) ?? 'No answer.';
  }

  /** Cached description of an image for models that can't see. */
  async describe(m: MessageRow, chatId: number): Promise<string | null> {
    if (m.description) return m.description;
    if (!isImage(m) || this.overBudget()) return null;
    try {
      const d = await this.lookAt(
        m,
        'Describe this image for someone who cannot see it, in 2-5 sentences. Transcribe any important text exactly.',
        chatId,
      );
      this.db.setDescription(m.id, d);
      return d;
    } catch (err) {
      log.warn('image description failed:', (err as Error).message);
      return null;
    }
  }

  // ---- judging implicit requests

  /** Picks the message among `candidates` that implicitly asks Robert for something, if any. */
  async judge(chat: ChatRow, candidates: MessageRow[]): Promise<MessageRow | null> {
    if (!candidates.length) return null;
    const newest = candidates.at(-1)!;
    // Include anything Robert said since, so the judge knows what was already answered.
    const recent = this.db.recent(chat.id, 0, 16).filter((m) => m.id <= newest.id || m.is_self).reverse();
    const tz = this.config.timezone;
    const transcript = recent
      .map((m) => (m.is_self ? `[#${m.tg_id} ASSISTANT]\n` : `${header(m, tz)}\n`) + body(m).slice(0, 600))
      .join('\n\n');
    const [name, ...aliases] = this.config.names;
    const ids = candidates.map((c) => c.tg_id);
    const system =
      `You watch a Telegram group chat that includes an AI assistant called ${name || 'Robert'} (@${this.config.botUsername}` +
      `${aliases.length ? `; also called ${aliases.join(', ')}` : ''}). Decide whether any of the NEW messages ` +
      `(ids ${ids.map((i) => `#${i}`).join(', ')}) asks the assistant to do something: answer, explain, look up, check, ` +
      'translate, summarize, remind, draw, or similar. Count indirect requests ("let\'s ask the bot", "can the AI check", ' +
      'a name in another language or a nickname, or a follow-up question to the assistant right after it spoke). ' +
      'Do NOT count people talking to each other, questions aimed at a specific person, rhetorical questions, or ' +
      'merely mentioning the assistant. When unsure, answer false.\n' +
      'Reply with JSON only: {"respond": true|false, "message_id": <id or null>}';
    const res = await this.or.chat(
      {
        model: this.config.models.judge,
        max_tokens: 300,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: transcript },
        ],
      },
      { kind: 'judge', chatId: chat.id },
    );
    const text = finalText(res.choices[0].message) ?? '';
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    try {
      const v = JSON.parse(json) as { respond?: boolean; message_id?: number | string | null };
      if (!v.respond) return null;
      const id = Number(String(v.message_id ?? '').replace('#', ''));
      return candidates.find((c) => c.tg_id === id) ?? newest;
    } catch {
      return null;
    }
  }

  // ---- rolling summary

  /** Folds old messages into the chat summary once the unsummarized history gets long. */
  async maybeSummarize(chatId: number): Promise<boolean> {
    const chat = this.db.getChat(chatId);
    if (!chat) return false;
    const rows = this.db.recent(chat.id, chat.summary_upto, 5000);
    const sizes = rows.map((m) => estimateTokens(body(m)) + 20);
    const total = sizes.reduce((a, b) => a + b, 0);
    if (total < this.config.historyTokens * 1.5 || this.overBudget()) return false;

    // Keep the newest ~75% of the budget raw; fold the rest, oldest first, in bounded chunks.
    let keep = 0;
    let kept = 0;
    while (kept < rows.length && keep + sizes[kept] < this.config.historyTokens * 0.75) keep += sizes[kept++];
    const fold = rows.slice(kept).reverse();
    let summary = chat.summary ?? '';
    const tz = this.config.timezone;
    for (let i = 0; i < fold.length; ) {
      let chunk = '';
      let last = fold[i];
      while (i < fold.length && estimateTokens(chunk) < 30_000) {
        const m = fold[i++];
        chunk += `${m.is_self ? `[#${m.tg_id} ${this.config.names[0]} (assistant)]` : header(m, tz)}\n${body(m).slice(0, 4000)}\n\n`;
        last = m;
      }
      const res = await this.or.chat(
        {
          model: this.config.models.summary,
          max_tokens: 1500,
          messages: [
            {
              role: 'system',
              content:
                'You maintain the running memory of a Telegram group chat for its AI assistant. Merge the previous ' +
                'summary with the new messages into an updated summary of at most 500 words, in the main language of ' +
                'the chat. Keep: who is who, facts people shared about themselves, decisions, plans and dates, open ' +
                'questions, preferences, and what the assistant was asked and answered. Drop small talk. ' +
                'Refer to messages by #id when useful. Output only the summary.',
            },
            { role: 'user', content: `Previous summary:\n${summary || '(none)'}\n\nNew messages:\n${chunk}` },
          ],
        },
        { kind: 'summary', chatId },
      );
      summary = finalText(res.choices[0].message) ?? summary;
      this.db.setSummary(chat.id, summary, last.id);
    }
    log.info(`chat ${chatId}: summarized ${fold.length} older messages`);
    return true;
  }
}

export function finalText(msg: ChatMessage): string | null {
  const c = msg.content;
  const text = (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p.type === 'text' ? p.text : '')).join('') : '').trim();
  if (!text || text === NOREPLY || /^NOREPLY\W*$/.test(text)) return null;
  return text;
}
