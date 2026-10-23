import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Mode } from './config.ts';

export type ChatStatus = 'approved' | 'pending' | 'rejected' | 'left';

export interface ChatRow {
  id: number;
  type: string;
  title: string | null;
  status: ChatStatus;
  added_by: number | null;
  model: string | null;
  mode: Mode | null;
  summary: string | null;
  /** messages.id of the last message folded into the summary. */
  summary_upto: number;
}

export type MessageKind =
  | 'text' | 'photo' | 'sticker' | 'voice' | 'audio' | 'video' | 'video_note' | 'animation'
  | 'document' | 'location' | 'contact' | 'poll' | 'other';

export interface MessageRow {
  id: number;
  chat_id: number;
  tg_id: number | null;
  thread_id: number | null;
  user_id: number | null;
  user_name: string | null;
  username: string | null;
  is_self: number;
  date: number;
  reply_to: number | null;
  forwarded_from: string | null;
  kind: MessageKind;
  /** Text or caption as written. */
  text: string | null;
  /** Transcript of audio, or the text content of a document. */
  extracted: string | null;
  /** Cached description of an image, for models that can't see. */
  description: string | null;
  media_path: string | null;
  media_mime: string | null;
  media_name: string | null;
  duration: number | null;
}

export type NewMessage = Omit<MessageRow, 'id' | 'extracted' | 'description' | 'is_self'> &
  Partial<Pick<MessageRow, 'extracted' | 'description' | 'is_self'>>;

export interface ReminderRow {
  id: number;
  chat_id: number;
  thread_id: number | null;
  created_by: number | null;
  created_by_name: string | null;
  due_at: number;
  text: string;
  repeat: 'none' | 'daily' | 'weekly';
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  added_by INTEGER,
  model TEXT,
  mode TEXT,
  summary TEXT,
  summary_upto INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  tg_id INTEGER,
  thread_id INTEGER,
  user_id INTEGER,
  user_name TEXT,
  username TEXT,
  is_self INTEGER NOT NULL DEFAULT 0,
  date INTEGER NOT NULL,
  reply_to INTEGER,
  forwarded_from TEXT,
  kind TEXT NOT NULL,
  text TEXT,
  extracted TEXT,
  description TEXT,
  media_path TEXT,
  media_mime TEXT,
  media_name TEXT,
  duration INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_tg ON messages(chat_id, tg_id) WHERE tg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(body, tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  thread_id INTEGER,
  created_by INTEGER,
  created_by_name TEXT,
  due_at INTEGER NOT NULL,
  text TEXT NOT NULL,
  repeat TEXT NOT NULL DEFAULT 'none',
  done INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders(done, due_at);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL DEFAULT (unixepoch()),
  chat_id INTEGER,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  prompt_tokens INTEGER,
  completion_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
`;

const n = (v: unknown): SQLInputValue => (v === undefined ? null : (v as SQLInputValue));

export class DB {
  readonly sql: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.sql = new DatabaseSync(file);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.sql.exec(SCHEMA);
    if (file !== ':memory:') fs.chmodSync(file, 0o600);
  }

  close(): void {
    this.sql.close();
  }

  // ---- chats

  getChat(id: number): ChatRow | undefined {
    return this.sql.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined;
  }

  upsertChat(id: number, type: string, title: string | null): ChatRow {
    this.sql
      .prepare(
        `INSERT INTO chats (id, type, title) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET type = excluded.type, title = excluded.title, updated_at = unixepoch()`,
      )
      .run(id, type, title);
    return this.getChat(id)!;
  }

  setChatStatus(id: number, status: ChatStatus, addedBy?: number): void {
    this.sql
      .prepare('UPDATE chats SET status = ?, added_by = COALESCE(?, added_by), updated_at = unixepoch() WHERE id = ?')
      .run(status, n(addedBy), id);
  }

  setChatModel(id: number, model: string | null): void {
    this.sql.prepare('UPDATE chats SET model = ?, updated_at = unixepoch() WHERE id = ?').run(model, id);
  }

  setChatMode(id: number, mode: Mode | null): void {
    this.sql.prepare('UPDATE chats SET mode = ?, updated_at = unixepoch() WHERE id = ?').run(mode, id);
  }

  setSummary(id: number, summary: string | null, upto: number): void {
    this.sql.prepare('UPDATE chats SET summary = ?, summary_upto = ?, updated_at = unixepoch() WHERE id = ?').run(summary, upto, id);
  }

  approvedChats(): ChatRow[] {
    return this.sql.prepare("SELECT * FROM chats WHERE status = 'approved' ORDER BY id").all() as unknown as ChatRow[];
  }

  /** A basic group became a supergroup and got a new id. */
  migrateChat(from: number, to: number): void {
    const old = this.getChat(from);
    if (!old || this.getChat(to)) return;
    this.sql.exec('BEGIN');
    try {
      this.sql.prepare("UPDATE chats SET id = ?, type = 'supergroup' WHERE id = ?").run(to, from);
      this.sql.prepare('UPDATE messages SET chat_id = ? WHERE chat_id = ?').run(to, from);
      this.sql.prepare('UPDATE reminders SET chat_id = ? WHERE chat_id = ?').run(to, from);
      this.sql.exec('COMMIT');
    } catch (err) {
      this.sql.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- messages

  insertMessage(m: NewMessage): number {
    const r = this.sql
      .prepare(
        `INSERT INTO messages (chat_id, tg_id, thread_id, user_id, user_name, username, is_self, date, reply_to,
           forwarded_from, kind, text, extracted, description, media_path, media_mime, media_name, duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, tg_id) WHERE tg_id IS NOT NULL DO NOTHING`,
      )
      .run(
        m.chat_id, n(m.tg_id), n(m.thread_id), n(m.user_id), n(m.user_name), n(m.username), m.is_self ?? 0, m.date,
        n(m.reply_to), n(m.forwarded_from), m.kind, n(m.text), n(m.extracted), n(m.description), n(m.media_path),
        n(m.media_mime), n(m.media_name), n(m.duration),
      );
    if (r.changes === 0) return this.getMessage(m.chat_id, m.tg_id!)!.id;
    const id = Number(r.lastInsertRowid);
    this.reindex(id);
    return id;
  }

  updateText(chatId: number, tgId: number, text: string | null): MessageRow | undefined {
    this.sql.prepare('UPDATE messages SET text = ? WHERE chat_id = ? AND tg_id = ?').run(text, chatId, tgId);
    const m = this.getMessage(chatId, tgId);
    if (m) this.reindex(m.id);
    return m;
  }

  setExtracted(id: number, extracted: string | null): void {
    this.sql.prepare('UPDATE messages SET extracted = ? WHERE id = ?').run(extracted, id);
    this.reindex(id);
  }

  setDescription(id: number, description: string): void {
    this.sql.prepare('UPDATE messages SET description = ? WHERE id = ?').run(description, id);
  }

  private reindex(id: number): void {
    const m = this.byId(id);
    this.sql.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(id);
    const body = [m?.text, m?.extracted].filter(Boolean).join('\n');
    if (body) this.sql.prepare('INSERT INTO messages_fts (rowid, body) VALUES (?, ?)').run(id, body);
  }

  byId(id: number): MessageRow | undefined {
    return this.sql.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  }

  getMessage(chatId: number, tgId: number): MessageRow | undefined {
    return this.sql.prepare('SELECT * FROM messages WHERE chat_id = ? AND tg_id = ?').get(chatId, tgId) as
      | MessageRow
      | undefined;
  }

  /** Newest first. */
  recent(chatId: number, afterId: number, limit: number): MessageRow[] {
    return this.sql
      .prepare('SELECT * FROM messages WHERE chat_id = ? AND id > ? ORDER BY id DESC LIMIT ?')
      .all(chatId, afterId, limit) as unknown as MessageRow[];
  }

  /** Oldest first. */
  range(chatId: number, afterId: number, uptoId: number): MessageRow[] {
    return this.sql
      .prepare('SELECT * FROM messages WHERE chat_id = ? AND id > ? AND id <= ? ORDER BY id')
      .all(chatId, afterId, uptoId) as unknown as MessageRow[];
  }

  search(chatId: number, query: string, limit: number, fromUser?: string): MessageRow[] {
    const words = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 12) ?? [];
    const who = fromUser?.replace(/^@/, '').toLowerCase();
    const filter = (rows: MessageRow[]) =>
      who
        ? rows.filter((r) => r.username?.toLowerCase() === who || r.user_name?.toLowerCase().includes(who))
        : rows;
    if (!words.length) {
      if (!who) return [];
      return filter(this.recent(chatId, 0, 2000)).slice(0, limit);
    }
    const run = (match: string) =>
      this.sql
        .prepare(
          `SELECT m.* FROM messages_fts f JOIN messages m ON m.id = f.rowid
           WHERE messages_fts MATCH ? AND m.chat_id = ? ORDER BY bm25(messages_fts) LIMIT ?`,
        )
        .all(match, chatId, who ? limit * 10 : limit) as unknown as MessageRow[];
    const terms = words.map((w) => `"${w}"*`);
    let rows = filter(run(terms.join(' ')));
    if (!rows.length && terms.length > 1) rows = filter(run(terms.join(' OR ')));
    return rows.slice(0, limit);
  }

  /** Has this user written in any approved chat? Used to allow DMs from group members. */
  isKnownMember(userId: number): boolean {
    return !!this.sql
      .prepare(
        "SELECT 1 FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.user_id = ? AND c.status = 'approved' LIMIT 1",
      )
      .get(userId);
  }

  forgetChat(chatId: number): string[] {
    const media = (this.sql
      .prepare('SELECT media_path FROM messages WHERE chat_id = ? AND media_path IS NOT NULL')
      .all(chatId) as { media_path: string }[]).map((r) => r.media_path);
    this.sql.exec('BEGIN');
    try {
      this.sql.prepare('DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE chat_id = ?)').run(chatId);
      this.sql.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId);
      this.sql.prepare('UPDATE chats SET summary = NULL, summary_upto = 0 WHERE id = ?').run(chatId);
      this.sql.exec('COMMIT');
    } catch (err) {
      this.sql.exec('ROLLBACK');
      throw err;
    }
    return media;
  }

  /** Deletes messages older than the cutoff; returns media files to remove. */
  prune(beforeUnix: number): string[] {
    const media = (this.sql
      .prepare('SELECT media_path FROM messages WHERE date < ? AND media_path IS NOT NULL')
      .all(beforeUnix) as { media_path: string }[]).map((r) => r.media_path);
    this.sql.prepare('DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE date < ?)').run(beforeUnix);
    this.sql.prepare('DELETE FROM messages WHERE date < ?').run(beforeUnix);
    return media;
  }

  // ---- reminders

  addReminder(r: Omit<ReminderRow, 'id'>): number {
    const res = this.sql
      .prepare('INSERT INTO reminders (chat_id, thread_id, created_by, created_by_name, due_at, text, repeat) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(r.chat_id, n(r.thread_id), n(r.created_by), n(r.created_by_name), r.due_at, r.text, r.repeat);
    return Number(res.lastInsertRowid);
  }

  dueReminders(now: number): ReminderRow[] {
    return this.sql.prepare('SELECT * FROM reminders WHERE done = 0 AND due_at <= ? ORDER BY due_at').all(now) as unknown as ReminderRow[];
  }

  listReminders(chatId: number): ReminderRow[] {
    return this.sql
      .prepare('SELECT * FROM reminders WHERE done = 0 AND chat_id = ? ORDER BY due_at')
      .all(chatId) as unknown as ReminderRow[];
  }

  completeReminder(id: number): void {
    this.sql.prepare('UPDATE reminders SET done = 1 WHERE id = ?').run(id);
  }

  rescheduleReminder(id: number, dueAt: number): void {
    this.sql.prepare('UPDATE reminders SET due_at = ? WHERE id = ?').run(dueAt, id);
  }

  cancelReminder(chatId: number, id: number): boolean {
    return this.sql.prepare('UPDATE reminders SET done = 1 WHERE id = ? AND chat_id = ? AND done = 0').run(id, chatId).changes > 0;
  }

  // ---- usage

  addUsage(u: { chatId?: number; kind: string; model: string; cost?: number; promptTokens?: number; completionTokens?: number }): void {
    this.sql
      .prepare('INSERT INTO usage (chat_id, kind, model, cost, prompt_tokens, completion_tokens) VALUES (?, ?, ?, ?, ?, ?)')
      .run(n(u.chatId), u.kind, u.model, u.cost ?? 0, n(u.promptTokens), n(u.completionTokens));
  }

  /** USD spent since the start of the current UTC day. */
  spentToday(): number {
    const start = Math.floor(Date.now() / 86_400_000) * 86_400;
    const r = this.sql.prepare('SELECT COALESCE(SUM(cost), 0) AS c FROM usage WHERE ts >= ?').get(start) as { c: number };
    return r.c;
  }

  spentBreakdown(sinceUnix: number): { kind: string; cost: number; calls: number }[] {
    return this.sql
      .prepare('SELECT kind, SUM(cost) AS cost, COUNT(*) AS calls FROM usage WHERE ts >= ? GROUP BY kind ORDER BY cost DESC')
      .all(sinceUnix) as unknown as { kind: string; cost: number; calls: number }[];
  }
}
