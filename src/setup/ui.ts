import readline from 'node:readline/promises';
import { scrub } from '../log.ts';

const tty = process.stdout.isTTY;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = paint('1');
export const dim = paint('2');
export const green = paint('32');
export const yellow = paint('33');
export const red = paint('31');
export const cyan = paint('36');

/** Prints a line; tokens registered with log.redact() are blanked out. */
export const say = (s = '') => process.stdout.write(scrub(s) + '\n');
export const ok = (s: string) => say(`${green('✓')} ${s}`);
export const warn = (s: string) => say(`${yellow('!')} ${s}`);
export const fail = (s: string) => say(`${red('✗')} ${s}`);
export const step = (n: number, total: number, title: string) => say(`\n${bold(cyan(`[${n}/${total}]`))} ${bold(title)}`);

export async function ask(question: string, def?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve, reject) => {
      rl.once('close', () => reject(new Error('\nInput ended before setup finished.')));
      rl.question(`${question}${def ? dim(` [${def}]`) : ''}: `).then(resolve, reject);
    });
    return answer.trim() || def || '';
  } finally {
    rl.close();
  }
}

export async function askRequired(question: string, validate?: (s: string) => string | null): Promise<string> {
  for (;;) {
    const a = await ask(question);
    const err = !a ? 'Please enter a value.' : validate?.(a);
    if (!err) return a;
    fail(err);
  }
}

/** Reads a line without echoing it (falls back to a normal prompt when stdin isn't a terminal). */
export async function askSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(question);
  process.stdout.write(`${question}: `);
  return new Promise((resolve, reject) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (err) reject(err);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else if (ch >= ' ') {
          value += ch;
          process.stdout.write('•');
        }
      }
    };
    stdin.on('data', onData);
  });
}

export async function confirm(question: string, def = true): Promise<boolean> {
  const a = (await ask(`${question} ${dim(def ? '(Y/n)' : '(y/N)')}`)).toLowerCase();
  if (!a) return def;
  return a.startsWith('y') || a.startsWith('д');
}

export async function choose(question: string, options: string[], def = 0): Promise<number> {
  say(question);
  options.forEach((o, i) => say(`  ${bold(String(i + 1))}. ${o}`));
  for (;;) {
    const a = await ask('Choose', String(def + 1));
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
    fail(`Enter a number from 1 to ${options.length}.`);
  }
}
