/**
 * Creates the bot through @BotFather by logging in as the owner with a Telegram user client
 * (MTProto). Bots can't be created through the Bot API, so this is the only way to automate it.
 * The user session lives only in memory and is logged out at the end.
 */
import { askRequired, askSecret, choose, dim, fail, ok, say, warn } from './ui.ts';

export interface CreatedBot {
  token: string;
  username: string;
  ownerId: number;
  ownerName: string;
  /** Group the bot was added to, with its Bot API chat id. */
  group?: { id: number; title: string; type: 'group' | 'supergroup' };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const TOKEN_RE = /\d{6,}:[A-Za-z0-9_-]{30,}/;

export function validUsername(u: string): string | null {
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(u)) return 'Use 5–32 letters, digits or underscores, starting with a letter.';
  if (!/bot$/i.test(u)) return 'Bot usernames must end in "bot".';
  return null;
}

async function loadGramJs() {
  // GramJS probes for localStorage, which makes recent Node versions print a warning.
  const emit = process.emitWarning;
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    if (String(w).includes('localStorage')) return;
    (emit as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  const [{ TelegramClient, Api }, { StringSession }, { Logger, LogLevel }] = await Promise.all([
    import('telegram'),
    import('telegram/sessions/index.js'),
    import('telegram/extensions/Logger.js'),
  ]);
  return { TelegramClient, Api, StringSession, Logger, LogLevel };
}

export async function createBotWithUserAccount(opts: {
  apiId: number;
  apiHash: string;
  botName: string;
  username: string;
  about: string;
}): Promise<CreatedBot> {
  const { TelegramClient, Api, StringSession, Logger, LogLevel } = await loadGramJs();
  const client = new TelegramClient(new StringSession(''), opts.apiId, opts.apiHash, {
    connectionRetries: 3,
    baseLogger: new Logger(LogLevel.NONE),
  });

  await client.start({
    phoneNumber: () => askRequired('Your phone number, international format (e.g. +14155550123)'),
    phoneCode: () => askRequired('The login code Telegram just sent you (look in the Telegram app)'),
    password: (hint?: string) => askSecret(`Two-step verification password${hint ? ` (hint: ${hint})` : ''}`),
    onError: async (err: Error) => {
      fail(err.message);
      // Stop on errors that retrying can't fix.
      return /API_ID|API_HASH|BANNED|FLOOD|AUTH_RESTART/i.test(err.message);
    },
  });

  try {
    const me = (await client.getMe()) as InstanceType<typeof Api.User>;
    const ownerId = Number(me.id.toString());
    const ownerName = [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || String(ownerId);
    ok(`Logged in as ${ownerName}${me.username ? ` (@${me.username})` : ''}`);

    const botFather = await client.getEntity('BotFather');
    const talk = async (text: string): Promise<string> => {
      const sent = await client.sendMessage(botFather, { message: text });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        await sleep(900);
        const [last] = await client.getMessages(botFather, { limit: 1 });
        if (last && last.id > sent.id && !last.out) return last.message ?? '';
      }
      throw new Error(`@BotFather didn't answer "${text}" in time.`);
    };

    say(dim('Talking to @BotFather…'));
    await talk('/cancel');
    let reply = await talk('/newbot');
    if (!/name/i.test(reply)) throw new Error(`@BotFather refused: ${reply.split('\n')[0]}`);
    await talk(opts.botName);

    let username = opts.username;
    let token: string | undefined;
    for (;;) {
      reply = await talk(username);
      token = reply.match(TOKEN_RE)?.[0];
      if (token) break;
      fail(`@BotFather: ${reply.split('\n')[0]}`);
      username = await askRequired('Try another username (must end in "bot")', validUsername);
    }
    ok(`Created @${username}`);

    // Let the bot see every group message, not only commands and mentions.
    await talk('/setprivacy');
    await talk(`@${username}`);
    reply = await talk('Disable');
    if (/disabled|success/i.test(reply)) ok('Group privacy mode disabled (the bot can read group messages)');
    else warn(`Couldn't confirm privacy mode change: ${reply.split('\n')[0]}`);

    for (const [cmd, text] of [['/setabouttext', opts.about], ['/setdescription', opts.about]] as const) {
      try {
        await talk(cmd);
        await talk(`@${username}`);
        await talk(text);
      } catch {}
    }
    await talk('/cancel').catch(() => {});

    // Opening the chat lets the bot message the owner (approval requests, warnings).
    await client.sendMessage(username, { message: '/start' }).catch(() => {});

    const group = await pickGroup(client, Api, username);
    return { token, username, ownerId, ownerName, group };
  } finally {
    try {
      await client.invoke(new Api.auth.LogOut());
      ok('Logged out of your Telegram account; the temporary session is gone');
    } catch {
      warn('Could not log out the temporary session. Remove it in Telegram → Settings → Devices.');
    }
    await client.destroy().catch(() => {});
  }
}

type GramJs = Awaited<ReturnType<typeof loadGramJs>>;

async function pickGroup(
  client: InstanceType<GramJs['TelegramClient']>,
  Api: GramJs['Api'],
  username: string,
): Promise<CreatedBot['group']> {
  const dialogs = (await client.getDialogs({ limit: 300 })).filter((d) => d.isGroup && d.entity);
  if (!dialogs.length) {
    say('No groups found on your account. Add the bot to a group later from Telegram.');
    return undefined;
  }
  const shown = dialogs.slice(0, 30);
  const idx = await choose(
    'Add the bot to one of your groups now? (you can add it to more groups later from Telegram)',
    ['Skip', ...shown.map((d) => d.title ?? '(untitled)')],
    0,
  );
  if (idx === 0) return undefined;
  const d = shown[idx - 1];
  const ent = d.entity!;
  try {
    if (ent instanceof Api.Channel) {
      await client.invoke(new Api.channels.InviteToChannel({ channel: ent, users: [username] }));
      ok(`Added @${username} to "${d.title}"`);
      return { id: Number(`-100${ent.id.toString()}`), title: d.title ?? '', type: 'supergroup' };
    }
    if (ent instanceof Api.Chat) {
      await client.invoke(new Api.messages.AddChatUser({ chatId: ent.id, userId: username, fwdLimit: 0 }));
      ok(`Added @${username} to "${d.title}"`);
      return { id: -Number(ent.id.toString()), title: d.title ?? '', type: 'group' };
    }
  } catch (err) {
    fail(`Couldn't add the bot: ${(err as Error).message}. Add it from the group's member list instead.`);
  }
  return undefined;
}

export function suggestUsername(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'r$1') || 'robert';
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `${base.slice(0, 20)}_${rand}_bot`;
}

export async function askApiCredentials(): Promise<{ apiId: number; apiHash: string }> {
  say('To act on your behalf, Telegram requires an "API ID" for your account (free, takes a minute):');
  say('  1. Open https://my.telegram.org and log in with your phone number.');
  say('  2. Choose "API development tools" and create an app (any name and short name; platform "Other").');
  say('  3. Copy the App api_id and App api_hash shown there.');
  say(dim('These are used only during this setup and are not saved.'));
  const apiId = Number(await askRequired('api_id', (s) => (/^\d+$/.test(s) ? null : 'api_id is a number.')));
  const apiHash = await askSecret('api_hash');
  if (!/^[a-f0-9]{32}$/i.test(apiHash)) warn('That api_hash looks unusual (expected 32 hex characters); trying anyway.');
  return { apiId, apiHash };
}

