import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

export const HOME = path.resolve(process.env.ROBERT_HOME || path.join(os.homedir(), '.robert'));

export const paths = {
  home: HOME,
  env: path.join(HOME, '.env'),
  config: path.join(HOME, 'config.json'),
  db: path.join(HOME, 'robert.db'),
  media: path.join(HOME, 'media'),
  modelsCache: path.join(HOME, 'models-cache.json'),
  /** Optional override of prompts/system.md. */
  prompt: path.join(HOME, 'system-prompt.md'),
};

export const REPO_ROOT = path.resolve(import.meta.dirname, '..');

export type Mode = 'smart' | 'direct';

export interface Models {
  /** Default conversational model (per-chat overrides live in the database). */
  chat: string;
  /** Cheap model deciding whether an implicit message is addressed to Robert. */
  judge: string;
  /** Model that maintains the rolling summary of older conversation. */
  summary: string;
  /** Describes images when the chat model can't see them. */
  vision: string;
  /** Speech-to-text for voice, audio and video. */
  transcribe: string;
  /** Text-to-speech for voice replies. */
  tts: string;
  /** Image generation. */
  image: string;
}

export interface Config {
  /** Telegram user id of the owner. Only the owner can change models and approve groups. */
  ownerId: number;
  botUsername: string;
  /** Names Robert answers to in plain text (in addition to @username). */
  names: string[];
  timezone: string;
  models: Models;
  /** Shown as buttons by /model. */
  modelPresets: string[];
  ttsVoice: string;
  defaultMode: Mode;
  /** Stop calling paid models for the rest of the UTC day once this is spent. 0 = unlimited. */
  dailyBudgetUsd: number;
  /** Approximate token budget for raw recent messages in the context. */
  historyTokens: number;
  /** How many recent images/documents are attached as real media (older ones become text). */
  maxAttachments: number;
  maxAsksPerUserPerHour: number;
  /** Delete messages and media older than this many days. 0 = keep forever. */
  retentionDays: number;
  /** 'owner': only the owner can DM Robert. 'members': anyone seen in an approved group can. */
  allowDms: 'owner' | 'members';
}

export const DEFAULTS: Config = {
  ownerId: 0,
  botUsername: '',
  names: ['Robert'],
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  models: {
    chat: 'meta/muse-spark-open',
    judge: 'anthropic/claude-haiku-5.5',
    summary: 'anthropic/claude-haiku-5.5',
    vision: 'anthropic/claude-haiku-5.5',
    transcribe: 'openai/gpt-4o-mini-transcribe',
    tts: 'google/gemini-3.8-flash-tts',
    image: 'google/gemini-3.1-flash-image',
  },
  modelPresets: [
    'meta/muse-spark-open',
    'anthropic/claude-sonnet-5.5',
    'anthropic/claude-opus-5.5',
    'openai/gpt-6.1-sol',
    'google/gemini-3.8-flash',
    'deepseek/deepseek-v4.1-flash',
    'moonshotai/kimi-k3',
  ],
  ttsVoice: 'Kore',
  defaultMode: 'smart',
  dailyBudgetUsd: 5,
  historyTokens: 24000,
  maxAttachments: 4,
  maxAsksPerUserPerHour: 40,
  retentionDays: 0,
  allowDms: 'owner',
};

/** Loads HOME/.env into process.env without overriding variables that are already set (and non-empty). */
export function loadEnvFile(file = paths.env): void {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const [k, v] of Object.entries(parseEnv(text))) {
    if (!process.env[k]) process.env[k] = v;
  }
}

export function loadConfig(file = paths.config): Config {
  let raw: Partial<Config> = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Can't read ${file}: ${(err as Error).message}`);
  }
  const cfg: Config = { ...DEFAULTS, ...raw, models: { ...DEFAULTS.models, ...raw.models } };
  if (process.env.ROBERT_OWNER_ID) cfg.ownerId = Number(process.env.ROBERT_OWNER_ID);
  return cfg;
}

/** Writes only the settings that differ from the defaults, so new defaults reach old installs. */
export function saveConfig(cfg: Config, file = paths.config): void {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    const d = (DEFAULTS as unknown as Record<string, unknown>)[k];
    if (k === 'models') {
      const m = Object.fromEntries(Object.entries(v as Models).filter(([mk, mv]) => mv !== (DEFAULTS.models as unknown as Record<string, string>)[mk]));
      if (Object.keys(m).length) out.models = m;
    } else if (JSON.stringify(v) !== JSON.stringify(d)) {
      out[k] = v;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, JSON.stringify(out, null, 2) + '\n', 0o600);
}

export function writeFileAtomic(file: string, data: string, mode = 0o600): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

/** Updates keys in HOME/.env, keeping other lines. The file is only readable by the owner. */
export function writeEnvFile(values: Record<string, string>, file = paths.env): void {
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  } catch {}
  for (const [k, v] of Object.entries(values)) {
    if (/[\r\n]/.test(v)) throw new Error(`${k} contains a newline`);
    const line = `${k}=${JSON.stringify(v)}`;
    const i = lines.findIndex((l) => l.startsWith(`${k}=`));
    if (i >= 0) lines[i] = line;
    else lines.push(line);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, lines.join('\n') + '\n', 0o600);
}

export interface Secrets {
  openrouterKey: string;
  botToken: string;
}

export function readSecrets(): Partial<Secrets> {
  return {
    openrouterKey: process.env.OPENROUTER_API_KEY?.trim() || undefined,
    botToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
  };
}

export function requireSecrets(): Secrets {
  const s = readSecrets();
  const missing = [!s.openrouterKey && 'OPENROUTER_API_KEY', !s.botToken && 'TELEGRAM_BOT_TOKEN'].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `Missing ${missing.join(' and ')}.\n` +
        `Run \`npm run setup\`, or set them in the environment or in ${paths.env}.`,
    );
  }
  return s as Secrets;
}

/** True inside the Docker image, where services are managed by Docker instead. */
export const IN_CONTAINER = process.env.ROBERT_CONTAINER === '1';
