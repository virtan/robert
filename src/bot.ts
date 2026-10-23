import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy';
import type { Chat, ChatMemberUpdated, Message } from 'grammy/types';
import { NOREPLY, type Brain } from './brain.ts';
import type { ChatRow, MessageKind, MessageRow, NewMessage } from './db.ts';
import { markdownToHtml, markdownToPlain, splitMarkdown } from './format.ts';
import { log } from './log.ts';
import {
  audioFormat, decodeText, extFromMime, isTextDocument, MAX_DOWNLOAD, removeMedia, saveMedia, toSpeechMp3, videoFrame,
} from './media.ts';
import { describeModel } from './models.ts';
import { OpenRouterError } from './openrouter.ts';
import type { Outbox } from './tools.ts';
import { isCommandForOtherBot, isDirect, nameRegex, parseCommand, realReplyTo, type Command } from './triggers.ts';

const JUDGE_DEBOUNCE_MS = 3000;
const JUDGE_MAX_WAIT_MS = 10_000;
const SUMMARY_EVERY = 40;
const MAX_TEXT_DOC_CHARS = 60_000;
const MAX_TRANSCRIBE_SECONDS = 30 * 60;

export interface RobertDeps {
  bot: Bot;
  brain: Brain;
  token: string;
  fetch?: typeof fetch;
  /** How long to wait for a burst of messages to end before judging it. */
  judgeDebounceMs?: number;
}

type Queue = Map<number, Promise<void>>;

/** The Telegram side: ingests every message, decides when to answer, and sends replies. */
export class Robert {
  readonly bot: Bot;
  readonly brain: Brain;
  private readonly token: string;
  private readonly fetch: typeof fetch;
  private readonly ingestQ: Queue = new Map();
  private readonly replyQ: Queue = new Map();
  private readonly judging = new Map<number, { pending: MessageRow[]; first: number; timer?: NodeJS.Timeout }>();
  private readonly asks = new Map<number, number[]>();
  private readonly noticed = new Set<string>();
  private readonly sinceSummary = new Map<number, number>();
  /** Per chat, the newest message id that an answer already took into account. */
  private readonly answeredUpto = new Map<number, number>();
  private timers: NodeJS.Timeout[] = [];
  private names: RegExp | null;
  private readonly judgeDebounceMs: number;

  constructor(deps: RobertDeps) {
    this.bot = deps.bot;
    this.brain = deps.brain;
    this.token = deps.token;
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.judgeDebounceMs = deps.judgeDebounceMs ?? JUDGE_DEBOUNCE_MS;
    this.names = nameRegex(this.brain.config.names);
    this.install();
  }

  private get cfg() {
    return this.brain.config;
  }

  private get db() {
    return this.brain.db;
  }

  private get me() {
    return this.bot.botInfo;
  }

  // ---- lifecycle

  private install(): void {
    const bot = this.bot;
    bot.on('message', (ctx) => {
      this.enqueue(this.ingestQ, ctx.chat.id, () => this.onMessage(ctx.message));
    });
    bot.on('edited_message', (ctx) => {
      const m = ctx.editedMessage;
      this.enqueue(this.ingestQ, m.chat.id, async () => {
        this.db.updateText(m.chat.id, m.message_id, m.text ?? m.caption ?? null);
      });
    });
    bot.on('my_chat_member', (ctx) => this.onMembership(ctx.myChatMember));
    bot.on('callback_query:data', (ctx) => this.onCallback(ctx));
    bot.catch((err) => log.error('update failed:', err.error));
  }

  async start(): Promise<void> {
    await this.bot.init();
    if (this.cfg.botUsername !== this.me.username) {
      this.cfg.botUsername = this.me.username;
      this.brain.persistConfig();
    }
    log.info(`Robert is @${this.me.username}; owner ${this.cfg.ownerId}; default model ${this.cfg.models.chat}`);
    if (!this.cfg.ownerId) log.warn('No owner configured: run `npm run setup` or set ROBERT_OWNER_ID. Nobody can approve groups.');
    if (!this.me.can_read_all_group_messages) {
      const fix = 'Group privacy mode is ON, so I only see commands and mentions in groups. Fix: in @BotFather send ' +
        `/setprivacy, pick @${this.me.username}, choose Disable, then remove me from each group and add me back.`;
      log.warn(fix);
      await this.notifyOwner(fix);
    }
    await this.setCommands().catch((err) => log.warn('setMyCommands failed:', err.message));
    this.brain.catalog.ensure().catch(() => {});

    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.timers.push(setInterval(() => this.tickReminders().catch((e) => log.error('reminders:', e)), 20_000));
    const prune = () => this.prune();
    prune();
    this.timers.push(setInterval(prune, 6 * 3600_000));

    await this.bot.start({
      allowed_updates: ['message', 'edited_message', 'my_chat_member', 'callback_query'],
      onStart: () => log.info('listening for updates'),
    });
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const j of this.judging.values()) clearTimeout(j.timer);
    await this.bot.stop();
    await Promise.allSettled([...this.ingestQ.values(), ...this.replyQ.values()]);
  }

  /** Runs tasks for one chat in order, without blocking other chats or the update loop. */
  private enqueue(q: Queue, chatId: number, task: () => Promise<void>): Promise<void> {
    const next = (q.get(chatId) ?? Promise.resolve())
      .then(task)
      .catch((err) => log.error(`chat ${chatId}:`, err));
    q.set(chatId, next);
    next.finally(() => q.get(chatId) === next && q.delete(chatId));
    return next;
  }

  /** Resolves when all queued work has finished (used by tests). */
  async idle(): Promise<void> {
    for (let i = 0; i < 400; i++) {
      const all = [...this.ingestQ.values(), ...this.replyQ.values()];
      if (!all.length && !this.judging.size) return;
      await Promise.allSettled(all);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  // ---- incoming messages

  private async onMessage(msg: Message): Promise<void> {
    if (msg.migrate_to_chat_id) {
      this.db.migrateChat(msg.chat.id, msg.migrate_to_chat_id);
      log.info(`chat ${msg.chat.id} migrated to ${msg.migrate_to_chat_id}`);
      return;
    }
    if (msg.from?.id === this.me.id) return;
    if (msg.new_chat_title) this.db.upsertChat(msg.chat.id, msg.chat.type, msg.new_chat_title);
    if (!hasContent(msg)) return;

    const chat = this.admit(msg);
    const cmd = parseCommand(msg, this.me.username);
    if (!chat) return;
    if (chat.status !== 'approved') {
      if (cmd?.name === 'approve' && msg.from?.id === this.cfg.ownerId) await this.approve(chat.id, msg.from.id);
      return;
    }

    const row = await this.ingest(msg, chat);
    if (cmd && COMMANDS[cmd.name]) {
      await this.command(cmd, msg, chat);
      return;
    }
    this.countForSummary(chat.id);
    if (msg.from?.is_bot || isCommandForOtherBot(msg, this.me.username)) return;

    const audioText = ['voice', 'audio', 'video', 'video_note'].includes(row.kind) ? row.extracted : null;
    if (isDirect(msg, { botId: this.me.id, botUsername: this.me.username, names: this.names, extra: audioText })) {
      if (!this.allowAsk(msg.from?.id)) {
        await this.sendText(chat.id, 'You\'ve asked me a lot this hour; let\'s pause for a bit.', { replyTo: msg.message_id, threadId: row.thread_id, record: false });
        return;
      }
      this.enqueue(this.replyQ, chat.id, () => this.answer(chat.id, row, 'direct'));
    } else if ((chat.mode ?? this.cfg.defaultMode) === 'smart') {
      this.scheduleJudge(chat.id, row);
    }
  }

  /** Returns the chat row if Robert may store messages from this chat. */
  private admit(msg: Message): ChatRow | null {
    const c = msg.chat;
    const existing = this.db.getChat(c.id);
    const title = chatTitle(c);
    const chat = this.db.upsertChat(c.id, c.type, title);
    const uid = msg.from?.id;
    if (c.type === 'private') {
      const allowed = uid === this.cfg.ownerId || (this.cfg.allowDms === 'members' && !!uid && this.db.isKnownMember(uid));
      if (allowed && chat.status !== 'approved') this.db.setChatStatus(c.id, 'approved', uid);
      if (!allowed) {
        log.info(`ignored DM from user ${uid} (@${msg.from?.username ?? '-'})`);
        if (this.notice(`dm:${uid}`)) {
          void this.bot.api.sendMessage(c.id, 'Hi! I only work in group chats my owner has approved.').catch(() => {});
        }
        return null;
      }
      return this.db.getChat(c.id)!;
    }
    if (!existing) {
      // Already in a group Robert has no record of (e.g. added before it was running).
      this.db.setChatStatus(c.id, 'pending');
      void this.askOwnerToApprove(c.id, title, msg.from);
    }
    return this.db.getChat(c.id)!;
  }

  private async ingest(msg: Message, chat: ChatRow): Promise<MessageRow> {
    const from = msg.from;
    const sender = msg.sender_chat;
    const base: NewMessage = {
      chat_id: chat.id,
      tg_id: msg.message_id,
      thread_id: msg.is_topic_message ? (msg.message_thread_id ?? null) : null,
      user_id: from?.id ?? null,
      user_name: sender && sender.id !== chat.id ? chatTitle(sender) : [from?.first_name, from?.last_name].filter(Boolean).join(' ') || null,
      username: sender && 'username' in sender ? (sender.username ?? null) : (from?.username ?? null),
      date: msg.date,
      reply_to: realReplyTo(msg)?.message_id ?? null,
      forwarded_from: forwardOrigin(msg),
      kind: 'text',
      text: msg.text ?? msg.caption ?? null,
      media_path: null,
      media_mime: null,
      media_name: null,
      duration: null,
    };
    try {
      await this.attachMedia(msg, base);
    } catch (err) {
      log.warn(`media processing failed for ${chat.id}/${msg.message_id}:`, (err as Error).message);
    }
    const id = this.db.insertMessage(base);
    return this.db.byId(id)!;
  }

  private async attachMedia(msg: Message, m: NewMessage): Promise<void> {
    const chatId = m.chat_id;
    const save = (data: Buffer, ext: string, mime: string) => {
      m.media_path = saveMedia(this.brain.mediaDir, chatId, data, ext);
      m.media_mime = mime;
    };

    if (msg.photo?.length) {
      m.kind = 'photo';
      const best = [...msg.photo].reverse().find((p) => (p.file_size ?? 0) <= MAX_DOWNLOAD) ?? msg.photo[0];
      const data = await this.download(best.file_id, best.file_size);
      if (data) save(data, 'jpg', 'image/jpeg');
    } else if (msg.sticker) {
      const s = msg.sticker;
      m.kind = 'sticker';
      m.text = [s.emoji, s.set_name ? `(sticker set ${s.set_name})` : ''].filter(Boolean).join(' ');
      if (!s.is_animated) {
        const data = await this.download(s.file_id, s.file_size);
        if (data && !s.is_video) save(data, 'webp', 'image/webp');
        else if (data) {
          const frame = await videoFrame(data, 'webm', 0);
          if (frame) save(frame, 'jpg', 'image/jpeg');
        }
      }
    } else if (msg.voice || msg.audio) {
      const a = (msg.voice ?? msg.audio)!;
      m.kind = msg.voice ? 'voice' : 'audio';
      m.duration = a.duration;
      if (msg.audio) m.media_name = [msg.audio.performer, msg.audio.title].filter(Boolean).join(' – ') || msg.audio.file_name || null;
      const data = await this.download(a.file_id, a.file_size);
      if (!data) {
        m.extracted = '(too large for me to download)';
        return;
      }
      const fmt = msg.voice ? 'ogg' : audioFormat(a.mime_type, msg.audio?.file_name);
      save(data, fmt, a.mime_type || 'audio/ogg');
      if (a.duration <= MAX_TRANSCRIBE_SECONDS) m.extracted = await this.transcribe(chatId, data, fmt, false);
    } else if (msg.video || msg.video_note || msg.animation) {
      const v = (msg.video ?? msg.video_note ?? msg.animation)!;
      m.kind = msg.video ? 'video' : msg.video_note ? 'video_note' : 'animation';
      m.duration = v.duration;
      const data = await this.download(v.file_id, v.file_size);
      if (!data) {
        m.extracted = '(too large for me to download)';
        return;
      }
      const ext = extFromMime('mime_type' in v ? v.mime_type : undefined, 'mp4');
      const frame = await videoFrame(data, ext, Math.min(1, (v.duration || 0) / 2));
      if (frame) save(frame, 'jpg', 'image/jpeg');
      if (!msg.animation && v.duration <= MAX_TRANSCRIBE_SECONDS) m.extracted = await this.transcribe(chatId, data, ext, true);
    } else if (msg.document) {
      const d = msg.document;
      m.kind = 'document';
      m.media_name = d.file_name ?? null;
      const mime = d.mime_type ?? '';
      const data = await this.download(d.file_id, d.file_size);
      if (!data) {
        m.extracted = '(too large for me to download)';
        return;
      }
      if (mime === 'application/pdf' || d.file_name?.toLowerCase().endsWith('.pdf')) save(data, 'pdf', 'application/pdf');
      else if (/^image\/(jpeg|png|webp|gif)$/.test(mime)) save(data, extFromMime(mime), mime);
      else if (mime.startsWith('audio/')) {
        const fmt = audioFormat(mime, d.file_name);
        save(data, fmt, mime);
        m.extracted = await this.transcribe(chatId, data, fmt, false);
      } else if (mime.startsWith('video/')) {
        const frame = await videoFrame(data, extFromMime(mime, 'mp4'));
        if (frame) save(frame, 'jpg', 'image/jpeg');
        m.extracted = await this.transcribe(chatId, data, extFromMime(mime, 'mp4'), true);
      } else if (isTextDocument(d.file_name, mime)) {
        const text = decodeText(data);
        if (text) m.extracted = text.length > MAX_TEXT_DOC_CHARS ? `${text.slice(0, MAX_TEXT_DOC_CHARS)}\n…(truncated)` : text;
      }
    } else if (msg.location) {
      m.kind = 'location';
      const v = msg.venue;
      m.text = `${v ? `${v.title}, ${v.address} ` : ''}(${msg.location.latitude}, ${msg.location.longitude})`;
    } else if (msg.contact) {
      m.kind = 'contact';
      m.text = `${[msg.contact.first_name, msg.contact.last_name].filter(Boolean).join(' ')} ${msg.contact.phone_number}`;
    } else if (msg.poll) {
      m.kind = 'poll';
      m.text = `${msg.poll.question}\n${msg.poll.options.map((o) => `- ${o.text}`).join('\n')}`;
    } else if (!m.text) {
      m.kind = 'other' as MessageKind;
    }
  }

  private async transcribe(chatId: number, data: Buffer, format: string, isVideo: boolean): Promise<string | null> {
    if (this.brain.overBudget()) return null;
    let audio = { data, format };
    if (isVideo || !['ogg', 'mp3', 'wav', 'm4a', 'flac', 'webm', 'aac'].includes(format)) {
      const mp3 = await toSpeechMp3(data, format);
      if (mp3) audio = { data: mp3, format: 'mp3' };
    }
    try {
      return (await this.brain.or.transcribe(audio, { model: this.cfg.models.transcribe, chatId })) || null;
    } catch (err) {
      log.warn('transcription failed:', (err as Error).message);
      return null;
    }
  }

  private async download(fileId: string, size?: number): Promise<Buffer | null> {
    if (size && size > MAX_DOWNLOAD) return null;
    const file = await this.bot.api.getFile(fileId);
    if (!file.file_path) return null;
    const res = await this.fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // ---- deciding to speak

  private allowAsk(uid: number | undefined): boolean {
    if (!uid || uid === this.cfg.ownerId) return true;
    const now = Date.now();
    const list = (this.asks.get(uid) ?? []).filter((t) => now - t < 3600_000);
    list.push(now);
    this.asks.set(uid, list);
    return list.length <= this.cfg.maxAsksPerUserPerHour;
  }

  private scheduleJudge(chatId: number, row: MessageRow): void {
    const st = this.judging.get(chatId) ?? { pending: [], first: Date.now() };
    st.pending.push(row);
    clearTimeout(st.timer);
    const wait = Math.max(0, Math.min(this.judgeDebounceMs, st.first + JUDGE_MAX_WAIT_MS - Date.now()));
    st.timer = setTimeout(() => {
      this.judging.delete(chatId);
      this.enqueue(this.replyQ, chatId, () => this.runJudge(chatId, st.pending));
    }, wait);
    this.judging.set(chatId, st);
  }

  private async runJudge(chatId: number, pending: MessageRow[]): Promise<void> {
    const chat = this.db.getChat(chatId);
    if (!chat || chat.status !== 'approved' || (chat.mode ?? this.cfg.defaultMode) !== 'smart' || this.brain.overBudget()) return;
    // Messages an answer already saw don't need judging; ones that arrived while Robert was typing do.
    const candidates = pending.filter((p) => p.id > (this.answeredUpto.get(chatId) ?? 0));
    if (!candidates.length) return;
    let target: MessageRow | null = null;
    try {
      target = await this.brain.judge(chat, candidates);
    } catch (err) {
      log.warn('judge failed:', (err as Error).message);
    }
    if (target && this.allowAsk(target.user_id ?? undefined)) {
      log.info(`chat ${chatId}: judge picked #${target.tg_id}`);
      await this.answer(chatId, target, 'judge');
    }
  }

  private async answer(chatId: number, trigger: MessageRow, reason: 'direct' | 'judge'): Promise<void> {
    const chat = this.db.getChat(chatId);
    if (!chat || chat.status !== 'approved') return;
    const reply = { replyTo: trigger.tg_id ?? undefined, threadId: trigger.thread_id };
    if (this.brain.overBudget()) {
      if (reason === 'direct' && this.notice(`budget:${chatId}:${new Date().toISOString().slice(0, 10)}`)) {
        await this.sendText(chatId, `I've reached today's spending limit ($${this.cfg.dailyBudgetUsd}). I'll be back tomorrow (UTC), or the owner can raise it with /budget.`, { ...reply, record: false });
      }
      return;
    }
    const stopTyping = this.typing(chatId, trigger.thread_id);
    this.answeredUpto.set(chatId, Math.max(trigger.id, this.answeredUpto.get(chatId) ?? 0));
    try {
      const text = await this.brain.respond(chat, trigger, reason, this.outbox);
      if (text && text !== NOREPLY) await this.sendText(chatId, text, reply);
    } catch (err) {
      log.error(`answer in ${chatId} failed:`, err);
      if (reason === 'direct') await this.sendText(chatId, friendlyError(err), { ...reply, record: false });
    } finally {
      stopTyping();
    }
  }

  private countForSummary(chatId: number): void {
    const n = (this.sinceSummary.get(chatId) ?? 0) + 1;
    this.sinceSummary.set(chatId, n);
    if (n < SUMMARY_EVERY) return;
    this.sinceSummary.set(chatId, 0);
    this.enqueue(this.replyQ, chatId, async () => {
      await this.brain.maybeSummarize(chatId).catch((err) => log.warn('summary failed:', err.message));
    });
  }

  // ---- sending

  readonly outbox: Outbox = {
    sendPhoto: async (chatId, data, o) =>
      (await this.bot.api.sendPhoto(chatId, new InputFile(data, 'image.png'), {
        caption: o.caption,
        ...threadOpts(o.threadId),
        ...(o.replyTo ? { reply_parameters: { message_id: o.replyTo, allow_sending_without_reply: true } } : {}),
      })).message_id,
    sendVoice: async (chatId, data, o) =>
      (await this.bot.api.sendVoice(chatId, new InputFile(data, o.mp3 ? 'voice.mp3' : 'voice.ogg'), {
        ...threadOpts(o.threadId),
        ...(o.replyTo ? { reply_parameters: { message_id: o.replyTo, allow_sending_without_reply: true } } : {}),
      })).message_id,
  };

  async sendText(
    chatId: number,
    md: string,
    o: { replyTo?: number; threadId?: number | null; record?: boolean; keyboard?: InlineKeyboard } = {},
  ): Promise<number[]> {
    const ids: number[] = [];
    const chunks = splitMarkdown(md);
    for (const [i, chunk] of chunks.entries()) {
      const opts = {
        ...threadOpts(o.threadId),
        link_preview_options: { is_disabled: true },
        ...(i === 0 && o.replyTo ? { reply_parameters: { message_id: o.replyTo, allow_sending_without_reply: true } } : {}),
        ...(i === chunks.length - 1 && o.keyboard ? { reply_markup: o.keyboard } : {}),
      };
      let sent: Message.TextMessage;
      try {
        sent = await this.bot.api.sendMessage(chatId, markdownToHtml(chunk), { ...opts, parse_mode: 'HTML' });
      } catch (err) {
        if (!(err instanceof GrammyError) || !/parse|entit|tag/i.test(err.description)) throw err;
        sent = await this.bot.api.sendMessage(chatId, markdownToPlain(chunk), opts);
      }
      ids.push(sent.message_id);
      if (o.record !== false) {
        this.brain.recordSelf(chatId, sent.message_id, { text: chunk, thread_id: o.threadId ?? null, reply_to: i === 0 ? (o.replyTo ?? null) : null });
      }
    }
    return ids;
  }

  private typing(chatId: number, threadId: number | null): () => void {
    const tick = () => this.bot.api.sendChatAction(chatId, 'typing', threadOpts(threadId)).catch(() => {});
    void tick();
    const t = setInterval(tick, 4500);
    return () => clearInterval(t);
  }

  private notice(key: string): boolean {
    if (this.noticed.has(key)) return false;
    this.noticed.add(key);
    return true;
  }

  private async notifyOwner(text: string, keyboard?: InlineKeyboard): Promise<void> {
    if (!this.cfg.ownerId) return;
    try {
      await this.bot.api.sendMessage(this.cfg.ownerId, text, keyboard ? { reply_markup: keyboard } : {});
    } catch (err) {
      log.warn(`couldn't message the owner (have they pressed Start in a DM with the bot?): ${(err as Error).message}`);
    }
  }

  // ---- groups and approval

  private async onMembership(u: ChatMemberUpdated): Promise<void> {
    const c = u.chat;
    if (c.type === 'private') return;
    const inside = (s: string) => s === 'member' || s === 'administrator' || s === 'restricted';
    const joined = inside(u.new_chat_member.status) && !inside(u.old_chat_member.status);
    const left = !inside(u.new_chat_member.status);
    const chat = this.db.upsertChat(c.id, c.type, chatTitle(c));
    if (left) {
      this.db.setChatStatus(c.id, 'left');
      this.noticed.delete(`approve:${c.id}`);
      log.info(`removed from chat ${c.id} (${chatTitle(c)})`);
      return;
    }
    if (!joined) return;
    if (u.from.id === this.cfg.ownerId || chat.status === 'approved') {
      await this.approve(c.id, u.from.id);
    } else {
      this.db.setChatStatus(c.id, 'pending', u.from.id);
      await this.askOwnerToApprove(c.id, chatTitle(c), u.from);
    }
  }

  private async askOwnerToApprove(chatId: number, title: string | null, by?: { id: number; first_name?: string; username?: string }): Promise<void> {
    if (!this.notice(`approve:${chatId}`)) return;
    log.info(`chat ${chatId} (${title}) is waiting for the owner's approval`);
    const who = by ? `${by.first_name ?? ''}${by.username ? ` (@${by.username})` : ''}`.trim() : 'someone';
    await this.notifyOwner(
      `${who} added me to "${title ?? chatId}". I'll stay silent and won't store anything there until you approve.`,
      new InlineKeyboard().text('✅ Approve', `ap:${chatId}`).text('🚪 Leave', `lv:${chatId}`),
    );
  }

  private async approve(chatId: number, by: number): Promise<void> {
    const wasApproved = this.db.getChat(chatId)?.status === 'approved';
    this.db.setChatStatus(chatId, 'approved', by);
    log.info(`chat ${chatId} approved`);
    if (!wasApproved || this.notice(`hello:${chatId}`)) {
      const name = this.cfg.names[0] || 'Robert';
      await this.sendText(
        chatId,
        `Hi, I'm ${name} 👋 I read along and help when you ask: mention @${this.me.username}, reply to me, or just ` +
          `say "${name}". I can search the web, read photos, voice messages and documents, set reminders, draw ` +
          'pictures and answer by voice. I remember what\'s said here to keep context; the owner can erase it ' +
          'with /forget. /help lists commands.',
        { record: false },
      ).catch((err) => log.warn('greeting failed:', err.message));
    }
  }

  private async onCallback(ctx: Context): Promise<void> {
    const q = ctx.callbackQuery!;
    const [kind, arg] = (q.data ?? '').split(':');
    if (ctx.from?.id !== this.cfg.ownerId) {
      await ctx.answerCallbackQuery({ text: 'Only the owner can do that.' });
      return;
    }
    const target = Number(arg);
    if (kind === 'ap') {
      await this.approve(target, ctx.from.id);
      await ctx.editMessageText(`✅ Approved "${this.db.getChat(target)?.title ?? target}".`).catch(() => {});
    } else if (kind === 'lv') {
      this.db.setChatStatus(target, 'rejected');
      await this.bot.api.leaveChat(target).catch(() => {});
      await ctx.editMessageText(`🚪 Left "${this.db.getChat(target)?.title ?? target}".`).catch(() => {});
    } else if (kind === 'md' && ctx.chat) {
      const model = arg === 'default' ? null : this.cfg.modelPresets[Number(arg)];
      this.db.setChatModel(ctx.chat.id, model ?? null);
      await ctx.editMessageText(`Model for this chat: ${model ?? `default (${this.cfg.models.chat})`}`).catch(() => {});
    }
    await ctx.answerCallbackQuery().catch(() => {});
  }

  // ---- commands

  private async command(cmd: Command, msg: Message, chat: ChatRow): Promise<void> {
    const isOwner = msg.from?.id === this.cfg.ownerId;
    const reply = (text: string, keyboard?: InlineKeyboard) =>
      this.sendText(chat.id, text, { replyTo: msg.message_id, threadId: msg.is_topic_message ? msg.message_thread_id : null, record: false, keyboard });
    const spec = COMMANDS[cmd.name];
    if (spec.owner && !isOwner) {
      await reply('Only the owner can do that.');
      return;
    }
    await this.brain.catalog.ensure();
    switch (cmd.name) {
      case 'start':
      case 'help':
        await reply(helpText(this.cfg.names[0] || 'Robert', this.me.username, isOwner));
        break;
      case 'model': {
        const current = this.brain.modelFor(chat);
        if (!cmd.args) {
          const kb = new InlineKeyboard();
          this.cfg.modelPresets.forEach((id, i) => kb.text(id === current ? `• ${id}` : id, `md:${i}`).row());
          kb.text('Reset to default', 'md:default');
          await reply(`Current model: ${describeModel(this.brain.catalog.get(current), current)}` +
            (isOwner ? '\n\nPick one, or send /model <name>. Use /model global <name> to change the default everywhere.' : ''),
          isOwner ? kb : undefined);
          break;
        }
        if (!isOwner) {
          await reply('Only the owner can change the model.');
          break;
        }
        const global = /^global\s+/i.test(cmd.args);
        const query = cmd.args.replace(/^global\s+/i, '');
        if (query === 'default') {
          this.db.setChatModel(chat.id, null);
          await reply(`This chat now uses the default model, ${this.cfg.models.chat}.`);
          break;
        }
        const { match, candidates } = this.brain.catalog.resolve(query);
        if (!match) {
          await reply('No model matches that. Try /models <words>.');
          break;
        }
        if (global) {
          this.cfg.models.chat = match.id;
          this.brain.persistConfig();
        } else {
          this.db.setChatModel(chat.id, match.id);
        }
        const others = candidates.slice(1, 4).map((m) => `\`${m.id}\``).join(', ');
        await reply(`${global ? 'Default model' : 'Model for this chat'}: ${describeModel(match, match.id)}` +
          (others ? `\nOther matches: ${others}` : ''));
        break;
      }
      case 'models': {
        const { candidates } = cmd.args ? this.brain.catalog.resolve(cmd.args) : { candidates: this.cfg.modelPresets.map((id) => this.brain.catalog.get(id)).filter((m) => !!m) };
        await reply(candidates.length ? candidates.map((m) => `• ${describeModel(m, m.id)}`).join('\n') : 'No models match.');
        break;
      }
      case 'mode': {
        const mode = cmd.args.toLowerCase();
        if (mode !== 'smart' && mode !== 'direct') {
          await reply(`Mode: ${chat.mode ?? this.cfg.defaultMode}.\n• smart — answer when addressed, and when a cheap model thinks I'm being asked implicitly\n• direct — answer only when mentioned, replied to or called by name\nChange with /mode smart or /mode direct.`);
          break;
        }
        this.db.setChatMode(chat.id, mode);
        await reply(`Mode set to ${mode}.`);
        break;
      }
      case 'status': {
        const spent = this.db.spentToday();
        const count = (this.db.sql.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get(chat.id) as { n: number }).n;
        const reminders = this.db.listReminders(chat.id).length;
        const budget = this.cfg.dailyBudgetUsd ? ` of $${this.cfg.dailyBudgetUsd}` : '';
        await reply([
          `Model: ${this.brain.modelFor(chat)}${chat.model ? '' : ' (default)'}`,
          `Mode: ${chat.mode ?? this.cfg.defaultMode}`,
          `Spent today: $${spent.toFixed(3)}${budget}`,
          `Messages remembered here: ${count}${chat.summary ? ' (older ones summarized)' : ''}`,
          `Upcoming reminders: ${reminders}`,
          `Time zone: ${this.cfg.timezone}`,
        ].join('\n'));
        break;
      }
      case 'summary':
        await reply(chat.summary ? `What I remember from earlier:\n\n${chat.summary}` : 'Nothing summarized yet; I still see the whole recent conversation.');
        break;
      case 'forget': {
        removeMedia(this.db.forgetChat(chat.id));
        await reply('Done: I erased everything I stored from this chat.');
        break;
      }
      case 'budget': {
        const v = Number(cmd.args.replace('$', ''));
        if (!cmd.args || Number.isNaN(v) || v < 0) {
          await reply(`Daily budget: ${this.cfg.dailyBudgetUsd ? `$${this.cfg.dailyBudgetUsd}` : 'unlimited'}. Change with /budget <usd> (0 = unlimited).`);
          break;
        }
        this.cfg.dailyBudgetUsd = v;
        this.brain.persistConfig();
        await reply(`Daily budget set to ${v ? `$${v}` : 'unlimited'}.`);
        break;
      }
      case 'approve':
        await reply('This chat is already approved.');
        break;
      case 'leave':
        await reply('Bye! 👋');
        this.db.setChatStatus(chat.id, 'rejected');
        await this.bot.api.leaveChat(chat.id).catch(() => {});
        break;
    }
  }

  private async setCommands(): Promise<void> {
    const list = Object.entries(COMMANDS)
      .filter(([name, c]) => c.menu && name !== 'start')
      .map(([command, c]) => ({ command, description: c.menu! }));
    await this.bot.api.setMyCommands(list);
  }

  // ---- background jobs

  async tickReminders(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    for (const r of this.db.dueReminders(now)) {
      const chat = this.db.getChat(r.chat_id);
      if (chat?.status === 'approved') {
        const by = r.created_by_name ? `\n_(reminder set by ${r.created_by_name})_` : '';
        try {
          await this.sendText(r.chat_id, `⏰ ${r.text}${by}`, { threadId: r.thread_id });
        } catch (err) {
          log.warn(`reminder ${r.id} failed:`, (err as Error).message);
          if (!(err instanceof GrammyError && err.error_code === 403)) continue;
        }
      }
      if (r.repeat === 'none' || chat?.status !== 'approved') this.db.completeReminder(r.id);
      else {
        const step = r.repeat === 'daily' ? 86_400 : 7 * 86_400;
        let due = r.due_at;
        while (due <= now) due += step;
        this.db.rescheduleReminder(r.id, due);
      }
    }
  }

  private prune(): void {
    if (!this.cfg.retentionDays) return;
    const files = this.db.prune(Math.floor(Date.now() / 1000) - this.cfg.retentionDays * 86_400);
    removeMedia(files);
  }
}

const COMMANDS: Record<string, { owner?: boolean; menu?: string }> = {
  start: {},
  help: { menu: 'What I can do' },
  model: { menu: 'Show or change the AI model' },
  models: { menu: 'Search available models' },
  mode: { owner: true, menu: 'When I join the conversation' },
  status: { menu: 'Model, spending and memory' },
  summary: { menu: 'What I remember from earlier' },
  forget: { owner: true, menu: 'Erase this chat from my memory' },
  budget: { owner: true },
  approve: { owner: true },
  leave: { owner: true },
};

function helpText(name: string, username: string, owner: boolean): string {
  return [
    `I'm ${name}. I read this chat and answer when you mention @${username}, reply to me, or call me ${name}.`,
    'I can search the web, read links, photos, PDFs and voice messages, search our chat history, set reminders, draw images and talk.',
    '',
    '/model — show the current AI model',
    '/models <words> — search available models',
    '/status — model, spending and memory',
    '/summary — what I remember from earlier',
    ...(owner
      ? ['', 'Owner only:', '/model <name> — use another model here (/model global <name> for all chats)', '/mode smart|direct — whether I also answer implicit requests', '/budget <usd> — daily spending limit', '/forget — erase this chat from my memory', '/leave — remove me from this group']
      : []),
    '',
    'Everything said here is stored on my server so I can remember context.',
  ].join('\n');
}

function friendlyError(err: unknown): string {
  if (err instanceof OpenRouterError) {
    if (err.status === 402) return '⚠️ The OpenRouter account is out of credits.';
    if (err.status === 404) return `⚠️ The model isn't available (${err.message}). The owner can switch with /model.`;
    if (err.status === 429) return '⚠️ The model is rate-limited right now. Try again in a minute.';
    return `⚠️ The model returned an error: ${err.message.slice(0, 300)}`;
  }
  if ((err as Error)?.name === 'TimeoutError') return '⚠️ That took too long. Please try again.';
  return '⚠️ Something went wrong on my side. Please try again in a minute.';
}

function hasContent(m: Message): boolean {
  return !!(m.text || m.caption || m.photo || m.sticker || m.voice || m.audio || m.video || m.video_note || m.animation ||
    m.document || m.location || m.contact || m.poll);
}

function chatTitle(c: Chat | Message['sender_chat'] & {}): string | null {
  if ('title' in c && c.title) return c.title;
  if ('first_name' in c) return [c.first_name, c.last_name].filter(Boolean).join(' ');
  return null;
}

function forwardOrigin(m: Message): string | null {
  const o = m.forward_origin;
  if (!o) return null;
  switch (o.type) {
    case 'user': return [o.sender_user.first_name, o.sender_user.last_name].filter(Boolean).join(' ');
    case 'hidden_user': return o.sender_user_name;
    case 'chat': return o.sender_chat.title ?? 'a chat';
    case 'channel': return o.chat.title ?? 'a channel';
    default: return 'elsewhere';
  }
}

function threadOpts(threadId: number | null | undefined): { message_thread_id?: number } {
  return threadId ? { message_thread_id: threadId } : {};
}

