import { Api as BotApi } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { DB } from '../db.ts';
import { IN_CONTAINER, loadConfig, loadEnvFile, paths, presetIds, presetNote, readSecrets, saveConfig, writeEnvFile, type Config } from '../config.ts';
import { ffmpeg } from '../media.ts';
import { OpenRouter } from '../openrouter.ts';
import { installService } from '../service.ts';
import { askApiCredentials, createBotWithUserAccount, suggestUsername, TOKEN_RE, validUsername, type CreatedBot } from './botfather.ts';
import { ask, askRequired, askSecret, bold, choose, confirm, dim, fail, ok, say, step, warn } from './ui.ts';

const STEPS = 5;

export async function runSetup(): Promise<void> {
  say(bold('\nRobert setup'));
  say(`Settings, secrets and the message database go in ${bold(paths.home)} (only your user can read them).`);
  say(dim('Set ROBERT_HOME to use another directory. Press Ctrl-C to stop at any time.'));

  loadEnvFile();
  const cfg = loadConfig();
  const shellEnv = { ...readSecrets() };

  step(1, STEPS, 'OpenRouter');
  const openrouterKey = await setupOpenRouter(shellEnv.openrouterKey);

  step(2, STEPS, 'Telegram bot');
  const tg = await setupBot(shellEnv.botToken, cfg);

  step(3, STEPS, 'Owner');
  if (tg.ownerId) {
    cfg.ownerId = tg.ownerId;
    ok(`Owner: ${tg.ownerName} (id ${tg.ownerId})`);
  } else if (cfg.ownerId && (await confirm(`Keep owner id ${cfg.ownerId}?`))) {
    ok(`Owner: id ${cfg.ownerId}`);
  } else {
    cfg.ownerId = await claimOwner(tg.api, tg.me);
  }
  cfg.botUsername = tg.me.username;

  step(4, STEPS, 'Preferences');
  await preferences(cfg, tg.me);

  writeEnvFile({ OPENROUTER_API_KEY: openrouterKey, TELEGRAM_BOT_TOKEN: tg.token });
  saveConfig(cfg);
  ok(`Saved ${paths.env} and ${paths.config}`);
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN !== tg.token) {
    warn('TELEGRAM_BOT_TOKEN is also set in your shell environment and would override the saved one. Unset it.');
  }
  if (tg.group) {
    const db = new DB(paths.db);
    db.upsertChat(tg.group.id, tg.group.type, tg.group.title);
    db.setChatStatus(tg.group.id, 'approved', cfg.ownerId);
    db.close();
    ok(`"${tg.group.title}" is approved`);
  }

  step(5, STEPS, 'Run');
  if (await ffmpeg()) ok('ffmpeg found: video and voice replies get full support');
  else {
    warn('ffmpeg not found. Robert works without it, but it can\'t look inside videos and sends voice replies as MP3.');
    say(`  Install it with ${bold(process.platform === 'darwin' ? 'brew install ffmpeg' : 'sudo apt install ffmpeg')} (or your package manager).`);
  }
  say('');
  if (IN_CONTAINER) {
    say(`Start it with ${bold('docker compose up -d')}; logs: ${bold('docker compose logs -f')}.`);
  } else if (await confirm('Install Robert as a background service that starts automatically?')) {
    installService({});
  } else {
    say(`Start it any time with ${bold('npm start')} (or ${bold('node bin/robert.ts start')}).`);
  }
  say('');
  say(bold('Next:'));
  say(`  • Add @${tg.me.username} to a group. When you add it yourself it's approved automatically;`);
  say('    if someone else adds it, you get a message with Approve / Leave buttons.');
  say(`  • In the group, mention @${tg.me.username}, reply to it, or say "${cfg.names[0]}". /help shows commands.`);
  say(`  • Check everything any time with ${bold('npm run doctor')}.`);
}

async function setupOpenRouter(fromEnv: string | undefined): Promise<string> {
  let key = fromEnv;
  if (key) {
    const info = await checkKey(key);
    if (info && (await confirm(`Use the OpenRouter key already configured (${info})?`))) return key;
  } else {
    say('Robert uses OpenRouter to reach models from Anthropic, OpenAI, Google and others with one key.');
    say(`Create a key at ${bold('https://openrouter.ai/settings/keys')} (you can set a credit limit on the key).`);
  }
  for (;;) {
    key = await askSecret('OpenRouter API key');
    const info = await checkKey(key);
    if (info) {
      ok(`Key works (${info})`);
      return key;
    }
  }
}

async function checkKey(key: string): Promise<string | null> {
  try {
    const k = await new OpenRouter(key).keyInfo();
    const credit = k.limitRemaining === null ? 'no limit on the key' : `$${k.limitRemaining.toFixed(2)} left on the key`;
    return `${k.label || 'key'}, ${credit}`;
  } catch (err) {
    fail(`OpenRouter rejected the key: ${(err as Error).message}`);
    return null;
  }
}

interface BotSetup {
  token: string;
  api: BotApi;
  me: UserFromGetMe;
  ownerId?: number;
  ownerName?: string;
  group?: CreatedBot['group'];
}

async function setupBot(fromEnv: string | undefined, cfg: Config): Promise<BotSetup> {
  if (fromEnv) {
    const me = await getMe(fromEnv);
    if (me && (await confirm(`Use the existing bot @${me.username}?`))) return withPrivacy({ token: fromEnv, api: new BotApi(fromEnv), me });
  }
  const how = await choose('How do you want to get a bot?', [
    `Create one for me automatically ${dim('(logs in to your Telegram account once, talks to @BotFather, then logs out)')}`,
    `I'll create it myself in @BotFather and paste the token`,
  ]);
  if (how === 0) {
    try {
      const { apiId, apiHash } = await askApiCredentials();
      const botName = await ask('Bot display name', cfg.names[0] || 'Robert');
      const username = await askRequired(`Bot username ${dim(`(e.g. ${suggestUsername(botName)})`)}`, validUsername);
      const created = await createBotWithUserAccount({
        apiId, apiHash, botName, username,
        about: `${botName} is an AI assistant for group chats. Add me to a group and ask me anything.`,
      });
      const me = await getMe(created.token);
      if (!me) throw new Error('The new bot token did not work.');
      if (!cfg.names.includes(botName)) cfg.names = [botName, ...cfg.names.filter((n) => n !== 'Robert')];
      return withPrivacy({ ...created, api: new BotApi(created.token), me });
    } catch (err) {
      fail((err as Error).message);
      say('Falling back to manual setup.');
    }
  }
  say('In Telegram, open @BotFather and:');
  say(`  1. Send ${bold('/newbot')}, choose a name (e.g. Robert) and a username ending in "bot".`);
  say(`  2. Send ${bold('/setprivacy')}, pick your bot, choose ${bold('Disable')} (so it can read group messages).`);
  say('  3. Copy the token BotFather gave you (looks like 123456789:AA…).');
  for (;;) {
    const token = await askSecret('Bot token');
    if (!TOKEN_RE.test(token)) {
      fail('That does not look like a bot token.');
      continue;
    }
    const me = await getMe(token);
    if (me) return withPrivacy({ token, api: new BotApi(token), me });
  }
}

async function getMe(token: string): Promise<UserFromGetMe | null> {
  try {
    const me = await new BotApi(token).getMe();
    ok(`Bot @${me.username} (id ${me.id})`);
    return me;
  } catch (err) {
    fail(`Telegram rejected the token: ${(err as Error).message}`);
    return null;
  }
}

/** Makes sure group privacy mode is off; otherwise the bot only sees commands and mentions. */
async function withPrivacy(s: BotSetup): Promise<BotSetup> {
  while (!s.me.can_read_all_group_messages) {
    warn('Group privacy mode is ON for this bot, so it would only see messages that mention it.');
    say(`  In @BotFather send ${bold('/setprivacy')}, choose @${s.me.username}, then ${bold('Disable')}.`);
    say('  If the bot is already in groups, remove it and add it back afterwards.');
    const a = await ask('Press Enter when done, or type "skip" to continue anyway');
    if (a.toLowerCase() === 'skip') break;
    s.me = await s.api.getMe();
  }
  if (s.me.can_read_all_group_messages) ok('The bot can read all group messages');
  return s;
}

/** Waits for the owner to message the bot and records their user id. */
async function claimOwner(api: BotApi, me: UserFromGetMe): Promise<number> {
  await api.deleteWebhook().catch(() => {});
  say(`Open ${bold(`https://t.me/${me.username}`)} from your own Telegram account and press Start (or send any message).`);
  say(dim('Waiting… (stop Robert first if it is already running elsewhere)'));
  let offset: number | undefined;
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const updates = await api.getUpdates({ offset, timeout: 30, allowed_updates: ['message'] }).catch((err) => {
      fail(err.message);
      return [];
    });
    for (const u of updates) {
      offset = u.update_id + 1;
      const m = u.message;
      if (!m?.from || m.chat.type !== 'private') continue;
      const who = `${[m.from.first_name, m.from.last_name].filter(Boolean).join(' ')}${m.from.username ? ` (@${m.from.username})` : ''}`;
      if (await confirm(`Message from ${bold(who)}, id ${m.from.id}. Is this you?`)) {
        await api.getUpdates({ offset, timeout: 0 }).catch(() => {});
        await api.sendMessage(m.chat.id, '✅ You are my owner now. Add me to a group and I\'ll start helping there.').catch(() => {});
        ok(`Owner: ${who}`);
        return m.from.id;
      }
    }
  }
  throw new Error('Timed out waiting for a message. Run `npm run setup` again.');
}

async function preferences(cfg: Config, me: UserFromGetMe): Promise<void> {
  say(`Besides @${me.username}, Robert answers when someone uses its name in a message.`);
  say(dim('Separate names with commas, and include the nicknames people will actually use (Rob, Роб, Роби).'));
  say(dim('End a name with * to also match inflected forms (e.g. Роберт* → Роберта, Роберту). Change later with /names.'));
  const names = await ask('Names', cfg.names.join(', '));
  cfg.names = names.split(',').map((n) => n.trim()).filter(Boolean);
  if (!cfg.names.length) cfg.names = [me.first_name];

  const tz = await ask('Time zone for reminders', cfg.timezone);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    cfg.timezone = tz;
  } catch {
    warn(`Unknown time zone "${tz}", keeping ${cfg.timezone}.`);
  }

  const presets = presetIds(cfg);
  const label = (id: string) => (presetNote(cfg, id) ? `${id} ${dim(`— ${presetNote(cfg, id)}`)}` : id);
  const idx = await choose('Default model (you can change it from Telegram later with /model)', [...presets.map(label), 'Other (type an OpenRouter model id)'],
    Math.max(0, presets.indexOf(cfg.models.chat)));
  cfg.models.chat = idx < presets.length ? presets[idx] : await askRequired('Model id (e.g. anthropic/claude-sonnet-5.5)');

  const budget = await ask('Daily spending limit in USD (0 = no limit)', String(cfg.dailyBudgetUsd));
  if (!Number.isNaN(Number(budget))) cfg.dailyBudgetUsd = Number(budget);
}
