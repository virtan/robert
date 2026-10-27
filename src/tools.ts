import fs from 'node:fs';
import type { Brain } from './brain.ts';
import { body, displayName, isImage, localTime } from './context.ts';
import type { ChatRow, MessageRow } from './db.ts';
import { log } from './log.ts';
import { dataUrl, extFromMime, saveMedia, toVoiceOgg } from './media.ts';
import { DEFAULT_ANSWER_SIZE, describeModel, isGeneric, modelEntry, switchNote, wantsMore } from './models.ts';
import { presetIds, presetNote } from './config.ts';
import { runJs } from './sandbox/run.ts';
import type { CatalogModel, Tool } from './openrouter.ts';
import { parseWhen } from './time.ts';

/** How tools reach Telegram. Implemented by the bot; faked in tests. */
export interface Outbox {
  sendPhoto(chatId: number, data: Buffer, opts: { caption?: string; replyTo?: number; threadId?: number | null }): Promise<number>;
  sendVoice(chatId: number, data: Buffer, opts: { mp3: boolean; replyTo?: number; threadId?: number | null }): Promise<number>;
}

export interface ToolEnv {
  brain: Brain;
  chat: ChatRow;
  trigger: MessageRow;
  outbox: Outbox;
}

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): Tool => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

export function toolDefinitions(opts: { runCode: boolean }): Tool[] {
  return [
    { type: 'openrouter:web_search', parameters: { max_results: 5 } },
    { type: 'openrouter:web_fetch', parameters: { max_content_tokens: 12000 } },
    fn('search_history', 'Search all stored messages in this chat. Returns full messages with sender, date and time. ' +
      'Words match by prefix; queries with emoji or symbols match exactly. Use order "oldest" for questions like "the first time…".', {
      query: { type: 'string', description: 'Words, an emoji or an exact phrase. May be empty when filtering by sender only.' },
      from: { type: 'string', description: 'Optional sender name or @username to filter by.' },
      order: { type: 'string', enum: ['relevance', 'oldest', 'newest'], description: 'Default: relevance.' },
      limit: { type: 'integer', minimum: 1, maximum: 30 },
    }, ['query']),
    fn('look_at', 'Examine the image, video frame or PDF attached to a message in this chat, and answer a question about it.', {
      message_id: { type: 'integer', description: 'Telegram message id (the #number in the header).' },
      question: { type: 'string', description: 'What you want to know about it.' },
    }, ['message_id', 'question']),
    fn('create_reminder', 'Schedule a message to this chat at a given time.', {
      when: { type: 'string', description: 'Local date and time, e.g. "2026-10-24 09:00". Use an explicit offset only if the user gave another time zone.' },
      text: { type: 'string', description: 'What to remind about, phrased to be read at that time.' },
      repeat: { type: 'string', enum: ['none', 'daily', 'weekly'] },
    }, ['when', 'text']),
    fn('watch_for_message', 'Do something when a given person next writes in this chat, e.g. "when Igor shows up, ' +
      'suggest the change to him". You will be woken by their next message and given the task.', {
      person: { type: 'string', description: 'Their @username or name as it appears in the chat.' },
      task: { type: 'string', description: 'What to do then, written as an instruction to yourself, with all needed context.' },
      days: { type: 'integer', minimum: 1, maximum: 90, description: 'Give up after this many days (default 30).' },
    }, ['person', 'task']),
    fn('list_reminders', 'List upcoming reminders and waiting tasks (watch_for_message) in this chat.', {}),
    fn('cancel_reminder', 'Cancel a reminder or a waiting task in this chat.', {
      id: { type: 'integer' },
      kind: { type: 'string', enum: ['reminder', 'watch'], description: 'Default: reminder.' },
    }, ['id']),
    fn('generate_image', 'Create an image (or edit images from the chat) and send it to the chat.', {
      prompt: { type: 'string', description: 'Detailed description of the image to create, in English.' },
      aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'] },
      reference_message_ids: { type: 'array', items: { type: 'integer' }, description: 'Messages whose images to use as references or to edit.' },
    }, ['prompt']),
    fn('send_voice', 'Say something as a voice message in the chat. Use when asked to speak, read aloud or answer by voice.', {
      text: { type: 'string', description: 'Exactly what to say. Plain spoken language, no Markdown.' },
      style: { type: 'string', description: 'Optional delivery instructions, e.g. "cheerful", "slowly".' },
    }, ['text']),
    ...(opts.runCode ? [fn('run_js', 'Run JavaScript in an isolated sandbox and get its output: for arithmetic, counting, ' +
      'dates, puzzles and brute-force checks. Synchronous ES2023 with BigInt; no network, files, timers or modules. ' +
      'Print with console.log; the value of the last expression is returned too. Limits: 5 s, 64 MB.', {
      code: { type: 'string' },
    }, ['code'])] : []),
    fn('find_models', 'List AI models Robert can use, each with what it is best for and its cost per answer. Without a ' +
      'query, returns the short list of recommended models; query "all" returns a longer list of current models; a query ' +
      'such as "opus" or "gemini flash" searches the whole OpenRouter catalog. Show each model on its own line as ' +
      '"Name — best for … (cost)", keeping the strengths and costs; leave out ids unless asked.', {
      query: { type: 'string', description: 'Optional. Empty: recommended models; "all": more models; or model name words.' },
    }),
    fn('switch_model', 'Change the AI model Robert uses. Only works when the owner asked.', {
      query: { type: 'string', description: 'Model id or a loose name like "opus" or "gemini flash".' },
      scope: { type: 'string', enum: ['chat', 'global'], description: 'This chat only (default) or the default for all chats.' },
    }, ['query']),
  ];
}

export function toolsHelp(opts: { runCode: boolean }): string {
  return TOOLS_HELP + (opts.runCode ? '\n- run_js: run JavaScript in a sandbox to calculate, count or brute-force; trust its output over mental math.' : '');
}

const TOOLS_HELP = `- Web search and web page fetching for anything current or outside your knowledge.
- search_history: search everything stored from this chat, by words, emoji or sender.
- look_at: examine an image, video frame or PDF from any message in this chat.
- create_reminder / list_reminders / cancel_reminder: scheduled messages to this chat.
- watch_for_message: act when a given person next writes here (the only way to do something "when X shows up").
- generate_image: create or edit images; the image is sent to the chat directly.
- send_voice: answer with a voice message. If you used it, reply NOREPLY unless you have something to add in text.
- find_models / switch_model: look up and change the AI model (switching is owner-only).`;

export async function runTool(name: string, rawArgs: string, env: ToolEnv): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return 'Error: arguments were not valid JSON.';
  }
  log.info(`tool ${name} in chat ${env.chat.id}`);
  try {
    switch (name) {
      case 'search_history': return searchHistory(env, args);
      case 'look_at': return await lookAt(env, args);
      case 'create_reminder': return createReminder(env, args);
      case 'list_reminders': return listReminders(env);
      case 'cancel_reminder':
        if (args.kind === 'watch') return env.brain.db.cancelWatch(env.chat.id, Number(args.id)) ? 'Cancelled.' : 'No such waiting task in this chat.';
        return env.brain.db.cancelReminder(env.chat.id, Number(args.id)) ? 'Cancelled.' : 'No such active reminder in this chat.';
      case 'watch_for_message': return watchForMessage(env, args);
      case 'run_js':
        if (!env.brain.config.runCode) return 'Error: code execution is disabled.';
        return await runJs(String(args.code ?? ''));
      case 'generate_image': return await generateImage(env, args);
      case 'send_voice': return await sendVoice(env, args);
      case 'find_models': return await findModels(env, args);
      case 'switch_model': return await switchModel(env, args);
      default: return `Error: unknown tool ${name}.`;
    }
  } catch (err) {
    log.warn(`tool ${name} failed:`, err);
    return `Error: ${(err as Error).message}`;
  }
}

function searchHistory(env: ToolEnv, a: Record<string, unknown>): string {
  const limit = Math.min(Number(a.limit) || 10, 30);
  const order = (['oldest', 'newest'].includes(String(a.order)) ? a.order : 'relevance') as 'relevance' | 'oldest' | 'newest';
  const rows = env.brain.db.search(env.chat.id, String(a.query ?? ''), limit, { from: a.from ? String(a.from) : undefined, order });
  if (!rows.length) return 'No matching messages. Don\'t claim anything about them.';
  const tz = env.brain.config.timezone;
  if (order === 'relevance') rows.sort((x, y) => x.id - y.id);
  return `${rows.length} message(s), ${order === 'relevance' ? 'in chronological order' : `${order} first`}:\n\n` + rows
    .map((m) => {
      const edited = m.edited_at ? ` (edited ${localTime(m.edited_at, tz, true)})` : '';
      return `#${m.tg_id} ${localTime(m.date, tz, true)}${edited} ${m.is_self ? 'you' : displayName(m)}:\n${body(m).slice(0, 2000)}`;
    })
    .join('\n\n');
}

function watchForMessage(env: ToolEnv, a: Record<string, unknown>): string {
  const { brain, chat, trigger } = env;
  const person = String(a.person ?? '').trim();
  const task = String(a.task ?? '').trim().slice(0, 2000);
  if (!person || !task) return 'Error: both person and task are needed.';
  const member = brain.db.findMember(chat.id, person);
  const days = Math.min(Math.max(Number(a.days) || 30, 1), 90);
  const id = brain.db.addWatch({
    chat_id: chat.id,
    thread_id: trigger.thread_id,
    created_by: trigger.user_id,
    created_by_name: trigger.user_name,
    user_id: member?.user_id ?? null,
    user_key: (member?.username ?? person.replace(/^@/, '')).toLowerCase(),
    task,
    expires_at: Math.floor(Date.now() / 1000) + days * 86_400,
  });
  const who = member ? displayName(member) : person;
  return `Waiting task #${id} saved: when ${who} next writes here (within ${days} days), you'll be asked to: ${task}` +
    (member ? '' : `\nNote: nobody called "${person}" has written here yet; it will match their @username or name.`);
}

async function lookAt(env: ToolEnv, a: Record<string, unknown>): Promise<string> {
  const m = env.brain.db.getMessage(env.chat.id, Number(a.message_id));
  if (!m) return 'No such message in this chat.';
  if (!m.media_path) return 'That message has no image or PDF.';
  return env.brain.lookAt(m, String(a.question || 'Describe it in detail.'), env.chat.id);
}

function createReminder(env: ToolEnv, a: Record<string, unknown>): string {
  const tz = env.brain.config.timezone;
  const due = parseWhen(String(a.when ?? ''), tz);
  if (!due) return 'Error: could not parse "when"; use the form 2026-10-24 09:00.';
  if (due < Date.now() / 1000 - 60) return 'Error: that time is in the past.';
  const repeat = (['daily', 'weekly'].includes(String(a.repeat)) ? a.repeat : 'none') as 'none' | 'daily' | 'weekly';
  const id = env.brain.db.addReminder({
    chat_id: env.chat.id,
    thread_id: env.trigger.thread_id,
    created_by: env.trigger.user_id,
    created_by_name: env.trigger.user_name,
    due_at: due,
    text: String(a.text ?? '').slice(0, 2000),
    repeat,
  });
  return `Reminder #${id} set for ${localTime(due, tz, true)} (${tz})${repeat !== 'none' ? `, repeating ${repeat}` : ''}.`;
}

function listReminders(env: ToolEnv): string {
  const tz = env.brain.config.timezone;
  const reminders = env.brain.db.listReminders(env.chat.id)
    .map((r) => `reminder #${r.id} ${localTime(r.due_at, tz, true)}${r.repeat !== 'none' ? ` (${r.repeat})` : ''}: ${r.text}`);
  const watches = env.brain.db.listWatches(env.chat.id)
    .map((w) => `watch #${w.id} when ${w.user_key} writes (until ${localTime(w.expires_at, tz, true)}): ${w.task}`);
  return [...reminders, ...watches].join('\n') || 'No upcoming reminders or waiting tasks.';
}

async function generateImage(env: ToolEnv, a: Record<string, unknown>): Promise<string> {
  const { brain, chat, trigger } = env;
  if (brain.overBudget()) return 'Error: the daily budget is used up.';
  const refs: string[] = [];
  for (const id of (Array.isArray(a.reference_message_ids) ? a.reference_message_ids : []).slice(0, 4)) {
    const m = brain.db.getMessage(chat.id, Number(id));
    if (m && isImage(m)) {
      try {
        refs.push(dataUrl(m.media_mime!, fs.readFileSync(m.media_path!)));
      } catch {}
    }
  }
  const prompt = String(a.prompt ?? '');
  const images = await brain.or.image({
    model: brain.config.models.image,
    prompt,
    aspect_ratio: a.aspect_ratio ? String(a.aspect_ratio) : undefined,
    input_references: refs,
    chatId: chat.id,
  });
  if (!images.length) return 'Error: the image model returned nothing (possibly refused the prompt).';
  const sent: number[] = [];
  for (const img of images) {
    const tgId = await env.outbox.sendPhoto(chat.id, img.data, { replyTo: trigger.tg_id ?? undefined, threadId: trigger.thread_id });
    const file = saveMedia(brain.mediaDir, chat.id, img.data, extFromMime(img.mime, 'png'));
    brain.recordSelf(chat.id, tgId, { kind: 'photo', text: `(generated image) ${prompt}`, media_path: file, media_mime: img.mime, thread_id: trigger.thread_id });
    sent.push(tgId);
  }
  return `Image sent to the chat as message #${sent.join(', #')}.`;
}

async function sendVoice(env: ToolEnv, a: Record<string, unknown>): Promise<string> {
  const { brain, chat, trigger } = env;
  if (brain.overBudget()) return 'Error: the daily budget is used up.';
  const text = String(a.text ?? '').slice(0, 4000);
  if (!text.trim()) return 'Error: nothing to say.';
  const mp3 = await brain.or.speech({
    model: brain.config.models.tts,
    input: text,
    voice: brain.config.ttsVoice || undefined,
    instructions: a.style ? String(a.style) : undefined,
    chatId: chat.id,
  });
  const ogg = await toVoiceOgg(mp3);
  const tgId = await env.outbox.sendVoice(chat.id, ogg ?? mp3, { mp3: !ogg, replyTo: trigger.tg_id ?? undefined, threadId: trigger.thread_id });
  brain.recordSelf(chat.id, tgId, { kind: 'voice', extracted: text, thread_id: trigger.thread_id });
  return `Voice message sent as #${tgId}.`;
}

async function findModels(env: ToolEnv, a: Record<string, unknown>): Promise<string> {
  const { brain, chat } = env;
  await brain.catalog.ensure();
  const query = String(a.query ?? '');
  const current = brain.modelFor(chat);
  const size = brain.db.typicalAnswerSize() ?? undefined;
  const entry = (m: CatalogModel) => `- ${modelEntry(m, { note: presetNote(brain.config, m.id), size, current: m.id === current })}`;
  const costNote = `Costs are estimates for a typical answer here (~${Math.round((size ?? DEFAULT_ANSWER_SIZE).prompt / 1000)}k tokens in, ` +
    `${(size ?? DEFAULT_ANSWER_SIZE).completion} out); long answers and web searches cost more.`;
  if (isGeneric(query)) {
    const list = wantsMore(query)
      ? brain.catalog.featured(presetIds(brain.config))
      : presetIds(brain.config).map((id) => brain.catalog.get(id)).filter((m) => !!m);
    return `${wantsMore(query) ? 'Current models' : 'Recommended models (ask for "all models" for more)'}:\n${list.map(entry).join('\n')}\n${costNote}`;
  }
  const { candidates } = brain.catalog.resolve(query);
  if (!candidates.length) return 'No models match. Call find_models without a query for the recommended models.';
  return `${candidates.map(entry).join('\n')}\n${costNote}`;
}

async function switchModel(env: ToolEnv, a: Record<string, unknown>): Promise<string> {
  const { brain, chat, trigger } = env;
  if (trigger.user_id !== brain.config.ownerId) {
    return 'Refused: only the owner can change the model. Tell the user that.';
  }
  await brain.catalog.ensure();
  const { match, candidates } = brain.catalog.resolve(String(a.query ?? ''));
  if (!match) return 'No model matches that. Use find_models to search.';
  const global = a.scope === 'global';
  if (global) {
    brain.config.models.chat = match.id;
    brain.persistConfig();
  } else {
    brain.db.setChatModel(chat.id, match.id);
  }
  const others = candidates.slice(1, 4).map((m) => m.id).join(', ');
  return `Switched ${global ? 'the default model for all chats' : 'this chat'} to ${describeModel(match, match.id)}.` +
    (others ? ` Other matches were: ${others}.` : '') + ' The change applies from the next message.\n' +
    switchNote(match, brain.config.historyTokens) + '\nTell the user this briefly.';
}
