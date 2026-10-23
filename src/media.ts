import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Telegram bots can download files up to 20 MB. */
export const MAX_DOWNLOAD = 20 * 1024 * 1024;

let ffmpegPath: string | null | undefined;

/** Path to ffmpeg, or null when it isn't installed (media still works, with fewer formats). */
export async function ffmpeg(): Promise<string | null> {
  if (ffmpegPath !== undefined) return ffmpegPath;
  const candidate = process.env.FFMPEG_PATH || 'ffmpeg';
  try {
    await run(candidate, ['-version'], { timeout: 10_000 });
    ffmpegPath = candidate;
  } catch {
    ffmpegPath = null;
  }
  return ffmpegPath;
}

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'robert-'));
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

async function convert(input: Buffer, inExt: string, outExt: string, args: string[]): Promise<Buffer | null> {
  const bin = await ffmpeg();
  if (!bin) return null;
  return withTemp(async (dir) => {
    const src = path.join(dir, `in.${inExt}`);
    const dst = path.join(dir, `out.${outExt}`);
    await fs.promises.writeFile(src, input);
    try {
      await run(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, ...args, dst], { timeout: 120_000 });
      return await fs.promises.readFile(dst);
    } catch {
      return null;
    }
  });
}

/** Extracts a compact mono MP3 audio track (for transcription of video, or exotic audio formats). */
export function toSpeechMp3(input: Buffer, inExt: string): Promise<Buffer | null> {
  return convert(input, inExt, 'mp3', ['-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k']);
}

/** One JPEG frame from a video, for models that can't watch video. */
export function videoFrame(input: Buffer, inExt: string, atSeconds = 1): Promise<Buffer | null> {
  return convert(input, inExt, 'jpg', ['-ss', String(atSeconds), '-frames:v', '1', '-vf', "scale='min(1280,iw)':-2", '-q:v', '4']);
}

/** Telegram voice messages are OGG/Opus; MP3 also works but shows no waveform. */
export function toVoiceOgg(mp3: Buffer): Promise<Buffer | null> {
  return convert(mp3, 'mp3', 'ogg', ['-c:a', 'libopus', '-b:a', '48k', '-ac', '1']);
}

/** Converts formats some models reject (e.g. animated-sticker WEBM, TGS is not supported) to PNG. */
export function toPng(input: Buffer, inExt: string): Promise<Buffer | null> {
  return convert(input, inExt, 'png', ['-frames:v', '1']);
}

export function saveMedia(mediaDir: string, chatId: number, data: Buffer, ext: string): string {
  const dir = path.join(mediaDir, String(chatId));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Never use a client-supplied file name on disk.
  const file = path.join(dir, `${randomUUID()}.${ext.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin'}`);
  fs.writeFileSync(file, data, { mode: 0o600 });
  return file;
}

export function removeMedia(files: string[]): void {
  for (const f of files) fs.rm(f, { force: true }, () => {});
}

export function dataUrl(mime: string, data: Buffer): string {
  return `data:${mime};base64,${data.toString('base64')}`;
}

export function extFromMime(mime: string | undefined, fallback = 'bin'): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/aac': 'aac', 'audio/webm': 'webm',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'application/pdf': 'pdf',
  };
  return (mime && map[mime.toLowerCase()]) || fallback;
}

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|log|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|sql|r|lua|pl|ex|exs|scala|dart|vue|svelte|tex|srt|vtt|env\.example)$/i;

export function isTextDocument(name: string | undefined, mime: string | undefined): boolean {
  if (mime?.startsWith('text/')) return true;
  if (mime && /json|xml|yaml|javascript|typescript|x-sh|sql|csv/.test(mime)) return true;
  return !!name && TEXT_EXT.test(name);
}

/** Decodes a text file, rejecting binary content. */
export function decodeText(data: Buffer): string | null {
  const sample = data.subarray(0, 8000);
  if (sample.includes(0)) return null;
  return new TextDecoder('utf-8', { fatal: false }).decode(data);
}

export function audioFormat(mime: string | undefined, name: string | undefined): string {
  const fromName = name?.split('.').pop()?.toLowerCase();
  const ext = extFromMime(mime, fromName || 'ogg');
  return ext === 'oga' || ext === 'opus' ? 'ogg' : ext;
}
