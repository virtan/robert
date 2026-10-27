/**
 * Logs in to a Telegram user account with GramJS, either by scanning a QR code with the Telegram app
 * or with a login code. GramJS's own client.start() hides where Telegram sent the code (the app, SMS,
 * email, or a channel third-party apps can't use), so this drives the auth calls itself and tells the
 * user where to look, offers to re-send the code another way, and falls back to QR.
 */
import qrcode from 'qrcode-terminal';
import type { Api as ApiNs, TelegramClient } from 'telegram';
import { ask, askRequired, askSecret, bold, choose, dim, fail, say, warn } from './ui.ts';

type Api = typeof ApiNs;
type User = InstanceType<Api['User']>;
type SentCode = InstanceType<Api['auth']['SentCode']>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errorCode = (err: unknown) => (err as { errorMessage?: string }).errorMessage ?? (err as Error).message ?? String(err);

/** Raised when the code route can't work; the caller switches to QR. */
class UseQr extends Error {}

/** Turns Telegram's error codes into advice. */
function friendly(err: unknown): Error {
  const code = errorCode(err);
  const seconds = (err as { seconds?: number }).seconds;
  if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/.test(code)) return new Error('Telegram rejected the api_id/api_hash. Copy them again from https://my.telegram.org → API development tools.');
  if (/PHONE_NUMBER_INVALID/.test(code)) return new Error('Telegram says that phone number is invalid. Use the international format with the country code.');
  if (/PHONE_NUMBER_BANNED|USER_DEACTIVATED/.test(code)) return new Error('Telegram says this account is banned or deactivated.');
  if (/FLOOD/.test(code)) return new Error(`Too many login attempts; Telegram asks to wait${seconds ? ` ${Math.ceil(seconds / 60)} minutes` : ''} before trying again.`);
  return err instanceof Error ? err : new Error(code);
}

export async function loginUser(client: TelegramClient, Api: Api, apiId: number, apiHash: string): Promise<User> {
  try {
    return await login(client, Api, apiId, apiHash);
  } catch (err) {
    throw friendly(err);
  }
}

async function login(client: TelegramClient, Api: Api, apiId: number, apiHash: string): Promise<User> {
  await client.connect();
  const how = await choose('How do you want to log in to Telegram?', [
    'Scan a QR code with the Telegram app on your phone (most reliable)',
    'Phone number and login code',
  ], 0);
  if (how === 1) {
    try {
      return await loginWithCode(client, Api, apiId, apiHash);
    } catch (err) {
      if (!(err instanceof UseQr)) throw err;
      if (err.message) warn(err.message);
      say('Switching to QR code login.');
    }
  }
  return loginWithQr(client, Api, apiId, apiHash);
}

async function withPassword(client: TelegramClient, apiId: number, apiHash: string): Promise<User> {
  say('This account has two-step verification.');
  return (await client.signInWithPassword({ apiId, apiHash }, {
    password: (hint?: string) => askSecret(`Two-step verification password${hint ? ` (hint: ${hint})` : ''}`),
    onError: async (err: Error) => {
      fail(err.message);
      return /FLOOD|AUTH_RESTART/i.test(err.message);
    },
  })) as User;
}

// ── QR code ──────────────────────────────────────────────────────────────────────────────────────────

async function loginWithQr(client: TelegramClient, Api: Api, apiId: number, apiHash: string): Promise<User> {
  let scanned = false;
  client.addEventHandler((update: unknown) => {
    if (update instanceof Api.UpdateLoginToken) scanned = true;
  });
  say('');
  say(`On your phone open Telegram → ${bold('Settings → Devices → Link Desktop Device')} and scan this code.`);
  say(dim('The code refreshes every 30 seconds. Press Ctrl+C to cancel.'));
  let drawn = 0;
  const tty = process.stdout.isTTY;

  for (;;) {
    let result;
    try {
      result = await client.invoke(new Api.auth.ExportLoginToken({ apiId, apiHash, exceptIds: [] }));
    } catch (err) {
      if (errorCode(err) === 'SESSION_PASSWORD_NEEDED') return withPassword(client, apiId, apiHash);
      throw err;
    }
    if (result instanceof Api.auth.LoginTokenMigrateTo) {
      await (client as unknown as { _switchDC(dc: number): Promise<void> })._switchDC(result.dcId);
      try {
        result = await client.invoke(new Api.auth.ImportLoginToken({ token: result.token }));
      } catch (err) {
        if (errorCode(err) === 'SESSION_PASSWORD_NEEDED') return withPassword(client, apiId, apiHash);
        throw err;
      }
    }
    if (result instanceof Api.auth.LoginTokenSuccess) {
      if (result.authorization instanceof Api.auth.Authorization) return result.authorization.user as User;
      throw new Error('Telegram asked to sign up; this account does not exist yet.');
    }
    if (!(result instanceof Api.auth.LoginToken)) throw new Error(`Unexpected QR login reply: ${result.className}`);
    if (scanned) {
      // Accepted on the phone, but the authorization isn't ready yet.
      await sleep(1000);
      continue;
    }

    // Redraw the code in place, so a refresh doesn't scroll the terminal.
    const url = `tg://login?token=${Buffer.from(result.token).toString('base64url')}`;
    const art = await new Promise<string>((resolve) => qrcode.generate(url, { small: true }, resolve));
    if (tty && drawn) process.stdout.write(`\x1b[${drawn}A\x1b[J`);
    process.stdout.write(art + '\n');
    drawn = art.split('\n').length;

    // Wait for the scan or for the token to expire; then export again, which also returns the
    // authorization once the code was accepted (in case the update was missed).
    const until = Math.min(result.expires * 1000, Date.now() + 30_000);
    while (!scanned && Date.now() < until - 1000) await sleep(500);
    if (scanned) say(dim('Scanned, finishing login…'));
  }
}

// ── Login code ───────────────────────────────────────────────────────────────────────────────────────

function normalizePhone(s: string): string {
  return s.replace(/[\s()\-.]/g, '').replace(/^00/, '+');
}

/** Says where the code went; throws UseQr when the user can't receive it this way. */
function explain(sent: SentCode, Api: Api, phone: string): void {
  const t = sent.type;
  if (t instanceof Api.auth.SentCodeTypeApp) {
    say(`Telegram sent the code ${bold('inside the Telegram app')}, not by SMS: look for a message from the`);
    say('official "Telegram" account (blue check mark) on a phone or computer where you are logged in.');
  } else if (t instanceof Api.auth.SentCodeTypeSms || t instanceof Api.auth.SentCodeTypeSmsWord || t instanceof Api.auth.SentCodeTypeSmsPhrase) {
    say(`Telegram sent the code ${bold(`by SMS to ${phone}`)}.`);
  } else if (t instanceof Api.auth.SentCodeTypeCall) {
    say(`Telegram is ${bold(`calling ${phone}`)} to read the code out.`);
  } else if (t instanceof Api.auth.SentCodeTypeFlashCall || t instanceof Api.auth.SentCodeTypeMissedCall) {
    const prefix = t instanceof Api.auth.SentCodeTypeMissedCall ? ` starting with ${t.prefix}` : '';
    say(`Telegram will give you ${bold('a missed call')} from a number${prefix}: the code is the last digits of that number.`);
  } else if (t instanceof Api.auth.SentCodeTypeEmailCode) {
    say(`Telegram sent the code ${bold(`by email to ${t.emailPattern}`)} (your Telegram login email).`);
  } else if (t instanceof Api.auth.SentCodeTypeFragmentSms) {
    say(`Telegram sent the code to your anonymous number: open ${bold(t.url)} to read it.`);
  } else if (t instanceof Api.auth.SentCodeTypeSetUpEmailRequired) {
    throw new UseQr('Telegram wants a login email set up before it sends a code to this app.');
  } else if (t instanceof Api.auth.SentCodeTypeFirebaseSms) {
    if (!sent.nextType) throw new UseQr('Telegram chose an SMS route that only official Telegram apps can receive.');
    say('Telegram chose an SMS route that only official Telegram apps can receive; press Enter to get the code another way.');
  } else {
    say(`Telegram sent the code (${(t as { className: string }).className}).`);
  }
}

function nextTypeName(sent: SentCode, Api: Api): string | null {
  const n = sent.nextType;
  if (!n) return null;
  if (n instanceof Api.auth.CodeTypeSms) return 'by SMS';
  if (n instanceof Api.auth.CodeTypeCall) return 'by phone call';
  if (n instanceof Api.auth.CodeTypeFlashCall || n instanceof Api.auth.CodeTypeMissedCall) return 'by missed call';
  if (n instanceof Api.auth.CodeTypeFragmentSms) return 'via Fragment';
  return 'another way';
}

async function loginWithCode(client: TelegramClient, Api: Api, apiId: number, apiHash: string): Promise<User> {
  const phone = normalizePhone(await askRequired('Your phone number, international format (e.g. +14155550123)', (s) =>
    /^\+?\d{7,15}$/.test(normalizePhone(s)) ? null : 'Enter digits with the country code, e.g. +14155550123.'));

  const send = async (): Promise<SentCode> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await client.invoke(new Api.auth.SendCode({ phoneNumber: phone, apiId, apiHash, settings: new Api.CodeSettings({}) }));
        if (r instanceof Api.auth.SentCodeSuccess) throw new UseQr('Telegram logged in without a code, which this setup does not handle.');
        return r;
      } catch (err) {
        // GramJS has already switched to the right data center when this is raised.
        if (/MIGRATE/.test(errorCode(err)) && attempt < 2) continue;
        throw err;
      }
    }
  };

  let sent = await send();
  for (;;) {
    explain(sent, Api, phone);
    const next = nextTypeName(sent, Api);
    say(dim(next
      ? `No code? Press Enter to have it sent ${next}${sent.timeout ? ` (possible after ${sent.timeout}s)` : ''}, or type qr to scan a QR code instead.`
      : 'No code? Type qr to scan a QR code instead.'));

    for (;;) {
      const input = (await ask('Login code')).replace(/[\s-]/g, '');
      if (/^qr$/i.test(input)) throw new UseQr('');
      if (!input) {
        if (!sent.nextType) {
          warn('Telegram offers no other way to send this code. Type qr to log in with a QR code.');
          continue;
        }
        try {
          sent = (await client.invoke(new Api.auth.ResendCode({ phoneNumber: phone, phoneCodeHash: sent.phoneCodeHash }))) as SentCode;
        } catch (err) {
          fail(`Couldn't re-send the code: ${errorCode(err)}`);
          continue;
        }
        break;
      }
      try {
        const isEmail = sent.type instanceof Api.auth.SentCodeTypeEmailCode;
        const r = await client.invoke(new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash: sent.phoneCodeHash,
          ...(isEmail ? { emailVerification: new Api.EmailVerificationCode({ code: input }) } : { phoneCode: input }),
        }));
        if (r instanceof Api.auth.AuthorizationSignUpRequired) throw new Error(`${phone} has no Telegram account.`);
        return r.user as User;
      } catch (err) {
        const code = errorCode(err);
        if (code === 'SESSION_PASSWORD_NEEDED') return withPassword(client, apiId, apiHash);
        if (/PHONE_CODE_INVALID|EMAIL_CODE_INVALID|CODE_INVALID/.test(code)) {
          fail('That code is wrong; try again.');
          continue;
        }
        if (/EXPIRED/.test(code)) {
          warn('That code expired; sending a new one.');
          sent = await send();
          break;
        }
        throw err;
      }
    }
  }
}
