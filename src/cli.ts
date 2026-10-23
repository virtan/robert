import { autoRetry } from '@grammyjs/auto-retry';
import { Bot, GrammyError } from 'grammy';
import { Robert } from './bot.ts';
import { Brain } from './brain.ts';
import { loadConfig, loadEnvFile, paths, requireSecrets, saveConfig } from './config.ts';
import { DB } from './db.ts';
import { log, redact } from './log.ts';
import { Catalog } from './models.ts';
import { OpenRouter } from './openrouter.ts';

const HELP = `Robert — an AI assistant for Telegram groups, powered by OpenRouter

Usage: robert <command>

  setup                      Interactive setup: OpenRouter key, bot creation, owner, preferences
  start                      Run the bot (what the service runs)
  doctor                     Check the installation and explain how to fix problems
  service install [--system] Run Robert in the background (systemd on Linux, launchd on macOS)
  service uninstall          Remove the background service
  service restart            Restart the background service

Data directory: ${paths.home} (set ROBERT_HOME to change it)
`;

export async function main(argv: string[]): Promise<void> {
  const [cmd = 'help', sub, ...rest] = argv;
  switch (cmd) {
    case 'setup': {
      const { runSetup } = await import('./setup/wizard.ts');
      await runSetup();
      process.exit(0);
    }
    case 'start':
      return start();
    case 'doctor': {
      const { runDoctor } = await import('./doctor.ts');
      process.exit((await runDoctor()) ? 0 : 1);
    }
    case 'service': {
      const svc = await import('./service.ts');
      if (sub === 'install') process.exit(svc.installService({ system: rest.includes('--system') }) ? 0 : 1);
      if (sub === 'uninstall') return svc.uninstallService();
      if (sub === 'restart') process.exit(svc.restartService() ? 0 : 1);
      throw new Error('Usage: robert service install [--system] | uninstall | restart');
    }
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return;
    default:
      throw new Error(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

async function start(): Promise<void> {
  loadEnvFile();
  const secrets = requireSecrets();
  redact(secrets.botToken);
  redact(secrets.openrouterKey);
  const config = loadConfig();

  const db = new DB(paths.db);
  const or = new OpenRouter(secrets.openrouterKey);
  const catalog = new Catalog(or, paths.modelsCache);
  const brain = new Brain({ db, or, catalog, config, mediaDir: paths.media, persistConfig: () => saveConfig(config) });

  const bot = new Bot(secrets.botToken);
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 60 }));
  const robert = new Robert({ bot, brain, token: secrets.botToken });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: shutting down`);
    const force = setTimeout(() => process.exit(1), 20_000);
    force.unref();
    await robert.stop().catch(() => {});
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error('unhandled rejection:', err));

  // Telegram or the network may be unreachable at boot; keep trying instead of exiting.
  for (let attempt = 1; ; attempt++) {
    try {
      await robert.start();
      return;
    } catch (err) {
      if (stopping) return;
      if (err instanceof GrammyError && err.error_code === 401) {
        throw new Error('Telegram rejected the bot token (401). Run `npm run setup` or fix TELEGRAM_BOT_TOKEN.');
      }
      const delay = Math.min(60, 5 * attempt);
      log.error(`bot stopped: ${(err as Error).message}; restarting in ${delay}s`);
      await new Promise((r) => setTimeout(r, delay * 1000));
    }
  }
}
