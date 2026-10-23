import type { Message, MessageEntity } from 'grammy/types';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Matches any configured name as a whole word, in any script. A trailing "*" makes it a stem, so
 * "Роберт*" also matches inflected forms like "Роберта" and "Роберту".
 */
export function nameRegex(names: string[]): RegExp | null {
  const alts = names
    .map((n) => n.trim())
    .filter(Boolean)
    .map((n) => (n.endsWith('*') ? `${esc(n.slice(0, -1))}[\\p{L}]{0,3}` : esc(n)));
  if (!alts.length) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alts.join('|')})(?![\\p{L}\\p{N}_])`, 'iu');
}

function entities(msg: Message): { text: string; list: MessageEntity[] } {
  return { text: msg.text ?? msg.caption ?? '', list: msg.entities ?? msg.caption_entities ?? [] };
}

export function mentionsBot(msg: Message, botUsername: string, botId: number): boolean {
  const { text, list } = entities(msg);
  const handle = `@${botUsername}`.toLowerCase();
  return list.some(
    (e) =>
      (e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === handle) ||
      (e.type === 'text_mention' && e.user.id === botId),
  );
}

/** In forum topics every message "replies" to the topic's first message; that isn't a real reply. */
export function realReplyTo(msg: Message): Message | undefined {
  const r = msg.reply_to_message;
  if (!r) return undefined;
  if (msg.is_topic_message && r.message_id === msg.message_thread_id) return undefined;
  return r;
}

export function isReplyToBot(msg: Message, botId: number): boolean {
  return realReplyTo(msg)?.from?.id === botId;
}

export type Command = { name: string; args: string };

/** Parses "/cmd@bot args". Returns null for non-commands and for commands aimed at other bots. */
export function parseCommand(msg: Message, botUsername: string): Command | null {
  const { text, list } = entities(msg);
  const e = list[0];
  if (!e || e.type !== 'bot_command' || e.offset !== 0) return null;
  const [name, target] = text.slice(1, e.length).split('@');
  if (target && target.toLowerCase() !== botUsername.toLowerCase()) return null;
  return { name: name.toLowerCase(), args: text.slice(e.length).trim() };
}

export function isCommandForOtherBot(msg: Message, botUsername: string): boolean {
  const { text, list } = entities(msg);
  const e = list[0];
  if (!e || e.type !== 'bot_command' || e.offset !== 0) return false;
  const target = text.slice(1, e.length).split('@')[1];
  return !!target && target.toLowerCase() !== botUsername.toLowerCase();
}

/** Whether Robert was addressed explicitly. `extra` is text derived from media, e.g. a transcript. */
export function isDirect(
  msg: Message,
  opts: { botId: number; botUsername: string; names: RegExp | null; extra?: string | null },
): boolean {
  if (msg.chat.type === 'private') return true;
  if (mentionsBot(msg, opts.botUsername, opts.botId) || isReplyToBot(msg, opts.botId)) return true;
  if (!opts.names) return false;
  const text = [msg.text ?? msg.caption ?? '', opts.extra ?? ''].join('\n');
  return opts.names.test(text);
}
