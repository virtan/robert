import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bot } from 'grammy';
import type { Message, Update } from 'grammy/types';
import { Robert } from '../src/bot.ts';
import { Brain } from '../src/brain.ts';
import { DEFAULTS, type Config } from '../src/config.ts';
import { DB } from '../src/db.ts';
import { Catalog } from '../src/models.ts';
import { OpenRouter, type ChatRequest } from '../src/openrouter.ts';
import { fakeModel } from './fixtures.ts';

export const OWNER = { id: 1, is_bot: false, first_name: 'Olga', username: 'olga' };
export const ALICE = { id: 2, is_bot: false, first_name: 'Alice', username: 'alice' };
export const BOT = {
  id: 99, is_bot: true as const, first_name: 'Robert', username: 'robert_test_bot',
  can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false,
  can_manage_bots: false, supports_join_request_queries: false,
};
export const GROUP = { id: -1001, type: 'supergroup' as const, title: 'Friends' };

export type ChatReply = Record<string, unknown> | ((req: ChatRequest) => Record<string, unknown> | Promise<Record<string, unknown>>);

/** A Robert wired to a fake Telegram and a scripted fake OpenRouter. */
export class Harness {
  readonly calls: { method: string; payload: Record<string, unknown> }[] = [];
  readonly orRequests: { path: string; body: Record<string, unknown> }[] = [];
  /** Responses for main-model chat calls, consumed in order. */
  readonly chatReplies: ChatReply[] = [];
  judgeReply: Record<string, unknown> = { respond: false };
  transcript = 'hello there';
  readonly config: Config;
  readonly db: DB;
  readonly robert: Robert;
  readonly dir: string;
  private nextId = 1000;
  private updateId = 1;

  constructor(over: Partial<Config> = {}) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'robert-test-'));
    this.config = structuredClone({ ...DEFAULTS, ownerId: OWNER.id, botUsername: BOT.username, timezone: 'UTC', ...over });
    this.db = new DB(':memory:');
    const or = new OpenRouter('sk-test', { fetch: this.openrouterFetch });
    const catalog = new Catalog(or, null);
    catalog.load([
      fakeModel(this.config.models.chat, 'Main', 3, ['text', 'image', 'file']),
      fakeModel(this.config.models.judge, 'Judge', 2),
      fakeModel('anthropic/claude-opus-5.5', 'Anthropic: Claude Opus 5.5', 5),
      fakeModel('vendor/blind', 'Blind', 1, ['text'], false),
    ]);
    const brain = new Brain({ db: this.db, or, catalog, config: this.config, mediaDir: path.join(this.dir, 'media') });
    const bot = new Bot('123:TEST', { botInfo: BOT });
    bot.api.config.use(async (_prev, method, payload) => {
      this.calls.push({ method, payload: payload as Record<string, unknown> });
      return { ok: true, result: this.telegramResult(method, payload as Record<string, unknown>) } as never;
    });
    this.robert = new Robert({ bot, brain, token: '123:TEST', fetch: this.fileFetch, judgeDebounceMs: 5 });
  }

  close(): void {
    this.db.close();
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  private telegramResult(method: string, p: Record<string, unknown>): unknown {
    if (method === 'getFile') return { file_id: p.file_id, file_unique_id: 'u', file_path: `files/${p.file_id}` };
    if (method.startsWith('send') && method !== 'sendChatAction') {
      return { message_id: this.nextId++, date: 0, chat: { id: p.chat_id, type: 'supergroup' }, from: BOT, text: p.text };
    }
    return true;
  }

  private fileFetch = (async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]))) as unknown as typeof fetch;

  private openrouterFetch = (async (url: string, init: RequestInit) => {
    const p = new URL(url).pathname.replace('/api/v1', '');
    const body = init.body ? JSON.parse(String(init.body)) : {};
    this.orRequests.push({ path: p, body });
    const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    if (p === '/audio/transcriptions') return json({ text: this.transcript, usage: { cost: 0.001 } });
    if (p === '/audio/speech') return new Response(new Uint8Array([1, 2, 3]));
    if (p === '/images') return json({ data: [{ b64_json: Buffer.from('png').toString('base64'), media_type: 'image/png' }], usage: { cost: 0.04 } });
    if (p === '/chat/completions') {
      if (isJudge(body)) return json(completion(JSON.stringify(this.judgeReply)));
      const next = this.chatReplies.shift() ?? completion('default answer');
      return json(typeof next === 'function' ? await next(body) : next);
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  /** Delivers a message update and waits until Robert is done with it. */
  async send(m: Partial<Message> & { from?: typeof OWNER }, chat: Message['chat'] = GROUP as never): Promise<Message> {
    const message = await this.deliver(m, chat);
    await this.robert.idle();
    return message;
  }

  /** Delivers a message without waiting for Robert to finish processing it. */
  async deliver(m: Partial<Message> & { from?: typeof OWNER }, chat: Message['chat'] = GROUP as never): Promise<Message> {
    const message = { message_id: this.nextId++, date: Math.floor(Date.now() / 1000), chat, from: ALICE, ...m } as Message;
    await this.robert.bot.handleUpdate({ update_id: this.updateId++, message } as Update);
    return message;
  }

  async update(u: Omit<Update, 'update_id'>): Promise<void> {
    await this.robert.bot.handleUpdate({ update_id: this.updateId++, ...u } as Update);
    await this.robert.idle();
  }

  async addToGroup(by = OWNER): Promise<void> {
    await this.update({
      my_chat_member: {
        chat: GROUP, from: by, date: 0,
        old_chat_member: { status: 'left', user: BOT },
        new_chat_member: { status: 'member', user: BOT },
      },
    } as never);
  }

  sent(method = 'sendMessage') {
    return this.calls.filter((c) => c.method === method);
  }

  mainRequests() {
    return this.orRequests.filter((r) => r.path === '/chat/completions' && !isJudge(r.body));
  }
}

export function completion(content: string | null, toolCalls?: { name: string; args: unknown }[]): Record<string, unknown> {
  return {
    id: 'gen', model: 'x',
    choices: [{
      finish_reason: toolCalls ? 'tool_calls' : 'stop',
      message: {
        role: 'assistant', content,
        ...(toolCalls ? { tool_calls: toolCalls.map((t, i) => ({ id: `call_${i}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}),
      },
    }],
    usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.01 },
  };
}

export const mention = (text: string) => ({
  text,
  entities: [{ type: 'mention' as const, offset: text.indexOf('@'), length: '@robert_test_bot'.length }],
});
export const command = (text: string) => ({ text, entities: [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0].length }] });

const isJudge = (body: Record<string, unknown>) => JSON.stringify(body.messages ?? '').includes('You watch a Telegram group chat');
