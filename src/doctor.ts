import fs from 'node:fs';
import { Api as BotApi } from 'grammy';
import { loadConfig, loadEnvFile, paths, presetIds, readSecrets } from './config.ts';
import { DB } from './db.ts';
import { ffmpeg } from './media.ts';
import { OpenRouter } from './openrouter.ts';
import { bold, fail, ok, say, warn } from './setup/ui.ts';

/** Checks the installation end to end and explains how to fix what's wrong. Returns false on errors. */
export async function runDoctor(): Promise<boolean> {
  let healthy = true;
  const bad = (s: string) => {
    healthy = false;
    fail(s);
  };
  say(bold('Robert doctor'));

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 18)) ok(`Node.js ${process.versions.node}`);
  else bad(`Node.js ${process.versions.node} is too old; Robert needs 22.18 or newer.`);

  if (await ffmpeg()) ok('ffmpeg available');
  else warn('ffmpeg not found (optional: needed for video frames and OGG voice replies)');

  loadEnvFile();
  const cfg = loadConfig();
  ok(`Data directory ${paths.home}`);
  try {
    const mode = fs.statSync(paths.env).mode & 0o777;
    if (mode & 0o077) warn(`${paths.env} is readable by others; run: chmod 600 ${paths.env}`);
  } catch {}

  const s = readSecrets();
  if (!s.openrouterKey) bad('OPENROUTER_API_KEY is not set (run `npm run setup`)');
  if (!s.botToken) bad('TELEGRAM_BOT_TOKEN is not set (run `npm run setup`)');

  if (s.botToken) {
    try {
      const me = await new BotApi(s.botToken).getMe();
      ok(`Telegram bot @${me.username}`);
      if (!me.can_read_all_group_messages) {
        bad('Group privacy mode is on: in @BotFather use /setprivacy → Disable, then re-add the bot to groups.');
      }
      if (cfg.botUsername && cfg.botUsername !== me.username) warn(`config.json says @${cfg.botUsername}; the token belongs to @${me.username}`);
      const hook = await new BotApi(s.botToken).getWebhookInfo();
      if (hook.url) warn(`A webhook is set (${hook.url}); Robert removes it when it starts polling.`);
    } catch (err) {
      bad(`Telegram rejected the bot token: ${(err as Error).message}`);
    }
  }
  if (cfg.ownerId) ok(`Owner id ${cfg.ownerId}`);
  else bad('No owner configured (run `npm run setup` or set ROBERT_OWNER_ID)');

  if (s.openrouterKey) {
    const or = new OpenRouter(s.openrouterKey);
    try {
      const k = await or.keyInfo();
      ok(`OpenRouter key works${k.limitRemaining !== null ? ` ($${k.limitRemaining.toFixed(2)} left on the key)` : ''}`);
      if (k.limitRemaining !== null && k.limitRemaining < 1) warn('Less than $1 left on the OpenRouter key.');
    } catch (err) {
      bad(`OpenRouter: ${(err as Error).message}`);
    }
    try {
      const chat = new Set((await or.models()).map((m) => m.id));
      const speech = new Set((await or.models({ output_modalities: 'speech' })).map((m) => m.id));
      const stt = new Set((await or.models({ output_modalities: 'transcription' })).map((m) => m.id));
      const images = new Set((await or.imageModels()).map((m) => m.id));
      const check = (label: string, id: string, set: Set<string>) =>
        set.has(id) ? ok(`${label}: ${id}`) : bad(`${label} model "${id}" isn't available on OpenRouter; change models.${label.split(' ')[0]} in ${paths.config}`);
      check('chat', cfg.models.chat, chat);
      check('judge', cfg.models.judge, chat);
      check('summary', cfg.models.summary, chat);
      check('memory', cfg.models.memory, chat);
      check('vision', cfg.models.vision, chat);
      check('transcribe', cfg.models.transcribe, stt);
      check('tts', cfg.models.tts, speech);
      check('image', cfg.models.image, images);
      for (const p of presetIds(cfg)) if (!chat.has(p)) warn(`/model preset ${p} isn't available any more`);
    } catch (err) {
      warn(`Couldn't check models: ${(err as Error).message}`);
    }
  }

  if (fs.existsSync(paths.db)) {
    const db = new DB(paths.db);
    const chats = db.approvedChats();
    ok(`${chats.length} approved chat(s)${chats.length ? ': ' + chats.map((c) => c.title ?? c.id).join(', ') : ''}`);
    ok(`Spent today: $${db.spentToday().toFixed(3)}${cfg.dailyBudgetUsd ? ` of $${cfg.dailyBudgetUsd}` : ''}`);
    db.close();
  }

  say(healthy ? bold('\nAll good.') : bold('\nSome checks failed; see above.'));
  return healthy;
}
