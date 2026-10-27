/**
 * Long-term memory: durable facts about a chat (people, dates, places, contacts, plans, events,
 * technologies), each with who mentioned it. A cheap model reads new messages in batches and adds,
 * updates or retires facts; the answering model sees them in its prompt and can search, add and
 * forget them with tools.
 */
import { body, estimateTokens, header, localTime } from './context.ts';
import { MEMORY_CATEGORIES, type DB, type MemoryCategory, type MemoryRow, type MessageRow } from './db.ts';

/** Read new messages for memories after this many arrive… */
export const MEMORY_EVERY = 30;
/** …or once the chat has been quiet this long with at least MEMORY_MIN_NEW new messages. */
export const MEMORY_IDLE_MS = 15 * 60_000;
export const MEMORY_MIN_NEW = 5;
/** How much of the memory goes into the answering prompt. */
const PROMPT_TOKENS = 3000;
const CHUNK_TOKENS = 20_000;

const SECRET_WORDS = /seed phrase|recovery phrase|mnemonic|private key|secret key|password|passcode|pin code|cvv|сид|мнемоник|приватн\p{L}* ключ|секретн\p{L}* ключ|парол/iu;

/**
 * Things that must never be stored even if someone posted them: credentials, keys, seed phrases,
 * card numbers. Public wallet addresses are fine.
 */
export function looksSecret(text: string): boolean {
  if (SECRET_WORDS.test(text)) return true;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return true;
  if (/\b(?:0x)?[0-9a-f]{64}\b/i.test(text)) return true; // raw 32-byte keys
  if (/\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/.test(text)) return true; // Bitcoin WIF keys
  if (/\b(?:\d[ -]?){15,18}\d\b/.test(text)) return true; // card numbers
  return false;
}

const EXTRACT_SYSTEM = `You maintain the long-term memory of a Telegram group chat for its AI assistant.
Read the new messages and decide what is worth remembering for months. Record durable facts only:
- person: who people are, roles, relationships, birthdays, where they live or work
- date: deadlines, appointments, anniversaries, scheduled events (always with the full date)
- place: addresses, venues, cities and places people mention as relevant to them
- contact: phone numbers, emails, websites, public crypto wallet addresses, accounts
- plan: plans, decisions, commitments ("Anna will book the hotel")
- event: big things that happened (moves, new jobs, births, purchases, trips)
- tech: technologies, tools, products and services people use or work with
- preference: strong likes, dislikes, allergies, habits
- other: anything else clearly worth keeping
Skip small talk, jokes, questions, opinions of the moment, and anything only relevant for minutes or
hours. Don't record what the assistant said unless people confirmed it. NEVER record passwords, private
keys, seed or recovery phrases, card numbers, one-time codes or any other secret, even if posted.

Each fact must stand on its own: name the people, resolve "tomorrow" to a date, keep numbers exact.
Write facts in the main language of the chat. If a new message changes a stored fact, update it; if a
stored fact is no longer true (a cancelled plan, a past one-off event that no longer matters), remove it.
Don't add duplicates of stored facts.

Reply with JSON only:
{"add": [{"category": "...", "about": "who or what it concerns", "fact": "...", "message_id": 123}],
 "update": [{"id": 5, "fact": "..."}],
 "remove": [7]}
Use empty arrays when there is nothing to change.`;

interface Extracted {
  add?: { category?: string; about?: string; fact?: string; message_id?: number | string }[];
  update?: { id?: number; fact?: string }[];
  remove?: (number | string)[];
}

export function memoryLine(m: MemoryRow, tz: string): string {
  const said = m.said_by ? `, said by ${m.said_by}` : '';
  return `#${m.id} [${m.category}] ${m.about ? `${m.about}: ` : ''}${m.fact} (${localTime(m.updated_at, tz, true).slice(0, 10)}${said})`;
}

/** The memory section of the answering prompt, newest first, within a token budget. */
export function memoryPrompt(db: DB, chatId: number, tz: string): string {
  const all = db.listMemories(chatId);
  if (!all.length) return '';
  const lines: string[] = [];
  let tokens = 0;
  for (const m of all) {
    const line = `- ${memoryLine(m, tz)}`;
    tokens += estimateTokens(line);
    if (tokens > PROMPT_TOKENS) break;
    lines.push(line);
  }
  const more = all.length > lines.length ? `\n(${all.length - lines.length} older memories not shown; use search_memory.)` : '';
  return `\n## Long-term memory of this chat\nFacts noted from earlier conversations (#id, category, when, who said it). ` +
    `They may be outdated; newer messages win.\n${lines.join('\n')}${more}\n`;
}

/** Calls the model; separated so the brain can supply its client, model and budget checks. */
export type Complete = (system: string, user: string) => Promise<string | null>;

/**
 * Reads messages after chat.memory_upto and updates the memories. Returns the number of changes.
 */
export async function extractMemories(db: DB, chatId: number, tz: string, complete: Complete): Promise<number> {
  const chat = db.getChat(chatId);
  if (!chat) return 0;
  const rows = db.recent(chatId, chat.memory_upto, 400).reverse();
  if (!rows.length) return 0;
  let changes = 0;
  for (let i = 0; i < rows.length; ) {
    let chunk = '';
    const batch: MessageRow[] = [];
    let prev: number | undefined;
    while (i < rows.length && estimateTokens(chunk) < CHUNK_TOKENS) {
      const m = rows[i++];
      chunk += `${m.is_self ? `[#${m.tg_id} ASSISTANT]` : header(m, tz, prev, db, 'the assistant')}\n${body(m).slice(0, 3000)}\n\n`;
      prev = m.date;
      batch.push(m);
    }
    const stored = db.listMemories(chatId, 300).map((m) => memoryLine(m, tz)).join('\n') || '(none yet)';
    const text = await complete(EXTRACT_SYSTEM, `Stored memories:\n${stored}\n\nNew messages:\n${chunk}`);
    changes += apply(db, chatId, batch, parse(text));
    db.setMemoryUpto(chatId, batch.at(-1)!.id);
  }
  return changes;
}

function parse(text: string | null): Extracted {
  const json = text?.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return {};
  try {
    return JSON.parse(json) as Extracted;
  } catch {
    return {};
  }
}

function apply(db: DB, chatId: number, batch: MessageRow[], x: Extracted): number {
  let changes = 0;
  for (const id of x.remove ?? []) if (db.removeMemory(chatId, Number(id))) changes++;
  for (const u of x.update ?? []) {
    const fact = u.fact?.trim();
    if (fact && !looksSecret(fact) && db.updateMemory(chatId, Number(u.id), fact.slice(0, 500))) changes++;
  }
  for (const a of x.add ?? []) {
    const fact = a.fact?.trim();
    if (!fact || looksSecret(fact) || looksSecret(a.about ?? '')) continue;
    // Attribute it to the sender of the source message, rather than trusting the model's guess.
    const src = batch.find((m) => m.tg_id === Number(String(a.message_id ?? '').replace('#', '')));
    const category = (MEMORY_CATEGORIES as readonly string[]).includes(a.category ?? '') ? (a.category as MemoryCategory) : 'other';
    db.addMemory({
      chat_id: chatId,
      category,
      about: a.about?.trim().slice(0, 120) || null,
      fact: fact.slice(0, 500),
      said_by: src ? (src.is_self ? 'the assistant' : src.user_name || src.username) : null,
      said_by_id: src?.user_id ?? null,
      source_tg_id: src?.tg_id ?? null,
    });
    changes++;
  }
  return changes;
}
