import fs from 'node:fs';
import { paths, REPO_ROOT, type Config } from './config.ts';
import type { ChatRow, DB, MessageRow } from './db.ts';
import { dataUrl } from './media.ts';
import type { ChatMessage, ContentPart } from './openrouter.ts';
import type { Reason } from './brain.ts';
import path from 'node:path';

/** Rough token estimate; errs high for non-Latin scripts, which tokenize less efficiently. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 3);
const IMAGE_TOKENS = 1200;

export function localTime(unix: number, tz: string, withDate = false): string {
  const d = new Date(unix * 1000);
  const opts: Intl.DateTimeFormatOptions = { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  if (withDate) Object.assign(opts, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return new Intl.DateTimeFormat('sv-SE', opts).format(d);
}

export function displayName(m: Pick<MessageRow, 'user_name' | 'username'>): string {
  const name = m.user_name || m.username || 'someone';
  return m.username && m.user_name ? `${name} (@${m.username})` : name;
}

/**
 * `[#123 Anna (@anna) 14:05, edited 14:07 ↩ #120 Boris: "the start of it…"]`. The reply part quotes
 * the replied-to message, so a reply makes sense even when that message is out of view.
 */
export function header(m: MessageRow, tz: string, prevDate?: number, db?: DB, self = 'you'): string {
  // Show the date only when the day changes, to keep headers short.
  const newDay = !prevDate || localTime(prevDate, tz, true).slice(0, 10) !== localTime(m.date, tz, true).slice(0, 10);
  const when = localTime(m.date, tz, newDay);
  const edited = m.edited_at ? `, edited ${localTime(m.edited_at, tz)}` : '';
  return `[#${m.tg_id} ${displayName(m)} ${when}${edited}${m.reply_to ? ` ↩ ${replyNote(m, db, self)}` : ''}]`;
}

const QUOTE_CHARS = 120;

export function snippet(text: string, max = QUOTE_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function replyNote(m: MessageRow, db: DB | undefined, self: string): string {
  const target = db?.getMessage(m.chat_id, m.reply_to!);
  if (target) {
    const who = target.is_self ? self : target.user_name || target.username || 'someone';
    // Telegram's quote is the part the sender selected, so it beats the start of the message.
    const text = m.reply_quote || body(target);
    return `#${m.reply_to} ${who}: "${snippet(text)}"`;
  }
  return m.reply_quote ? `#${m.reply_to}: "${snippet(m.reply_quote)}"` : `#${m.reply_to}`;
}

const KIND_LABEL: Record<string, string> = {
  photo: 'photo', sticker: 'sticker', voice: 'voice message', audio: 'audio', video: 'video',
  video_note: 'video message', animation: 'GIF', document: 'file', location: 'location',
  contact: 'contact', poll: 'poll', other: 'unsupported message',
};

/** The textual body of a message, without media. */
export function body(m: MessageRow): string {
  const out: string[] = [];
  if (m.forwarded_from) out.push(`(forwarded from ${m.forwarded_from})`);
  if (m.kind !== 'text') {
    const dur = m.duration ? ` ${Math.floor(m.duration / 60)}:${String(m.duration % 60).padStart(2, '0')}` : '';
    const name = m.media_name ? ` "${m.media_name}"` : '';
    out.push(`[${KIND_LABEL[m.kind] ?? m.kind}${name}${dur}]`);
  }
  if (m.text) out.push(m.text);
  if (m.extracted) {
    const isAudio = ['voice', 'audio', 'video', 'video_note'].includes(m.kind);
    out.push(isAudio ? `Transcript: ${m.extracted}` : `Content:\n${m.extracted}`);
  }
  return out.join('\n');
}

export function isImage(m: MessageRow): boolean {
  return !!m.media_path && !!m.media_mime?.startsWith('image/');
}

export function isPdf(m: MessageRow): boolean {
  return !!m.media_path && m.media_mime === 'application/pdf';
}

export interface ContextInput {
  db: DB;
  config: Config;
  chat: ChatRow;
  model: string;
  trigger: MessageRow;
  /** 'direct': Robert was addressed; 'judge': the judge thinks Robert was implicitly asked; or a waiting task. */
  reason: Reason;
  /** Token budget for recent messages (already fitted to the model's context window). */
  historyTokens: number;
  canSee: boolean;
  canReadFiles: boolean;
  /** Describes an image for models that can't see; returns null on failure. */
  describe: (m: MessageRow) => Promise<string | null>;
  system: string;
}

export interface Context {
  messages: ChatMessage[];
  hasFiles: boolean;
}

export async function buildContext(input: ContextInput): Promise<Context> {
  const { db, config, chat, trigger } = input;
  const tz = config.timezone;

  // Newest first, until the token budget is used. The trigger is always included.
  const rows: MessageRow[] = [];
  let tokens = 0;
  for (const m of db.recent(chat.id, chat.summary_upto, 500)) {
    if (m.id > trigger.id) continue;
    const t = estimateTokens(body(m)) + 20 + (isImage(m) ? IMAGE_TOKENS : 0);
    if (rows.length && tokens + t > input.historyTokens) break;
    tokens += t;
    rows.push(m);
  }
  if (!rows.some((r) => r.id === trigger.id)) rows.unshift(trigger);

  const replied = trigger.reply_to ? db.getMessage(chat.id, trigger.reply_to) : undefined;
  const repliedOutside = !!replied && !rows.some((r) => r.id === replied.id);
  if (repliedOutside) rows.push(replied!);
  rows.sort((a, b) => a.id - b.id);

  // Decide which media to attach: the trigger and the message it replies to first, then the newest.
  const attach = new Set<number>();
  const order = [trigger, ...(replied ? [replied] : []), ...[...rows].reverse()];
  for (const m of order) {
    if (attach.size >= config.maxAttachments) break;
    if (isImage(m) || isPdf(m)) attach.add(m.id);
  }

  const segments: { role: 'user' | 'assistant'; parts: ContentPart[] }[] = [];
  let hasFiles = false;
  let prevDate: number | undefined;
  for (const m of rows) {
    const parts: ContentPart[] = [];
    if (m.is_self) {
      parts.push({ type: 'text', text: body(m) || '(empty)' });
    } else {
      if (repliedOutside && m.id === replied!.id) {
        parts.push({ type: 'text', text: '(an earlier message, quoted because the current one replies to it:)' });
      }
      parts.push({ type: 'text', text: `${header(m, tz, prevDate, db)}\n${body(m)}`.trim() });
      if (attach.has(m.id)) parts.push(...(await mediaParts(m, input)));
      else if (isImage(m)) parts.push({ type: 'text', text: m.description ? `(image: ${m.description})` : '(image not shown; use look_at to examine it)' });
      else if (isPdf(m)) parts.push({ type: 'text', text: '(PDF not attached; use look_at to read it)' });
      if (parts.some((p) => p.type === 'file')) hasFiles = true;
    }
    prevDate = m.date;
    const role = m.is_self ? 'assistant' : 'user';
    const last = segments.at(-1);
    if (last && last.role === role) last.parts.push(...parts);
    else segments.push({ role, parts });
  }

  const who = displayName(trigger);
  const r = input.reason;
  const note =
    r === 'direct'
      ? `(${who} addressed you directly in message #${trigger.tg_id}: answer it.)`
      : r === 'judge'
        ? `(Nobody addressed you by name, but message #${trigger.tg_id} from ${who} seems to be asking you. ` +
          'Answer it if so; otherwise reply NOREPLY.)'
        : `(${who} just wrote message #${trigger.tg_id}. Earlier, ${r.by ?? 'someone'} asked you to do this when ` +
          `${who} showed up: "${r.task}". Do it now, addressing ${who}. If their message also asks you something, answer that too.)`;
  const lastSeg = segments.at(-1);
  if (lastSeg?.role === 'user') lastSeg.parts.push({ type: 'text', text: note });
  else segments.push({ role: 'user', parts: [{ type: 'text', text: note }] });
  if (segments[0].role === 'assistant') segments.unshift({ role: 'user', parts: [{ type: 'text', text: '(earlier conversation omitted)' }] });

  const messages: ChatMessage[] = [{ role: 'system', content: input.system }];
  for (const s of segments) {
    if (s.role === 'assistant') {
      messages.push({ role: 'assistant', content: s.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n\n') });
    } else {
      messages.push({ role: 'user', content: mergeText(s.parts) });
    }
  }
  return { messages, hasFiles };
}

/** Joins adjacent text parts so providers see fewer, larger blocks. */
function mergeText(parts: ContentPart[]): ContentPart[] {
  const out: ContentPart[] = [];
  for (const p of parts) {
    const last = out.at(-1);
    if (p.type === 'text' && last?.type === 'text') last.text += `\n\n${p.text}`;
    else out.push(p.type === 'text' ? { ...p } : p);
  }
  return out;
}

async function mediaParts(m: MessageRow, input: ContextInput): Promise<ContentPart[]> {
  let data: Buffer;
  try {
    data = fs.readFileSync(m.media_path!);
  } catch {
    return [{ type: 'text', text: '(the file is no longer available)' }];
  }
  if (isImage(m)) {
    if (input.canSee) return [{ type: 'image_url', image_url: { url: dataUrl(m.media_mime!, data) } }];
    const d = m.description ?? (await input.describe(m));
    return [{ type: 'text', text: d ? `(image: ${d})` : '(image: could not be described)' }];
  }
  if (isPdf(m)) {
    if (!input.canReadFiles) return [{ type: 'text', text: '(PDF not attached; use look_at to read it)' }];
    return [{ type: 'file', file: { filename: m.media_name || 'document.pdf', file_data: dataUrl('application/pdf', data) } }];
  }
  return [];
}

// ---- system prompt

export function loadTemplate(): string {
  try {
    return fs.readFileSync(paths.prompt, 'utf8');
  } catch {
    return fs.readFileSync(path.join(REPO_ROOT, 'prompts', 'system.md'), 'utf8');
  }
}

export function renderSystem(
  template: string,
  v: { config: Config; chat: ChatRow; model: string; tools: string; ownerName: string; about?: string },
): string {
  const { config, chat } = v;
  const aliases = config.names.length > 1 ? `People may also call you ${config.names.slice(1).join(', ')}.` : '';
  const chatDesc = chat.type === 'private' ? 'a private chat with the owner' : `the group "${chat.title ?? chat.id}"`;
  const summary = chat.summary ? `\n## What happened earlier in this chat\n${chat.summary}\n` : '';
  const vars: Record<string, string> = {
    name: config.names[0] || 'Robert',
    username: config.botUsername,
    aliases,
    now: localTime(Math.floor(Date.now() / 1000), config.timezone, true) +
      `, ${new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: config.timezone }).format(new Date())}`,
    timezone: config.timezone,
    chat: chatDesc,
    model: v.model,
    tools: v.tools,
    about: v.about ?? '',
    owner: v.ownerName,
    summary,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '').replace(/\n{3,}/g, '\n\n').trim();
}
