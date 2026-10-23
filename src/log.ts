const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.ROBERT_LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;
const secrets = new Set<string>();

/** Registers a value that must never appear in logs (tokens end up in URLs and error messages). */
export function redact(secret: string | undefined): void {
  if (secret && secret.length >= 8) secrets.add(secret);
}

function scrub(text: string): string {
  for (const s of secrets) text = text.split(s).join('<redacted>');
  return text;
}

function fmt(arg: unknown): string {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function write(level: Level, args: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${scrub(args.map(fmt).join(' '))}`;
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (...a: unknown[]) => write('debug', a),
  info: (...a: unknown[]) => write('info', a),
  warn: (...a: unknown[]) => write('warn', a),
  error: (...a: unknown[]) => write('error', a),
};
