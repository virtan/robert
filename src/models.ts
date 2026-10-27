import fs from 'node:fs';
import { writeFileAtomic } from './config.ts';
import { log } from './log.ts';
import type { CatalogModel, OpenRouter } from './openrouter.ts';

export type Capability = 'image' | 'audio' | 'file' | 'video' | 'tools';

const REFRESH_MS = 6 * 3600_000;

/** Well-known model lines. featured() shows the newest usable model of each, so the list stays current. */
const FAMILIES: RegExp[] = [
  /^anthropic\/claude-opus-[\d.]+$/,
  /^anthropic\/claude-sonnet-[\d.]+$/,
  /^anthropic\/claude-haiku-[\d.]+$/,
  /^openai\/gpt-[\d.]+(-[a-z]+)?$/,
  /^google\/gemini-[\d.]+-(?!flash)[a-z]+$/,
  /^google\/gemini-[\d.]+-flash$/,
  /^x-ai\/grok-[\d.]+$/,
  /^meta\/muse-wonder(-[\d.]+)?$/,
  /^meta\/muse-spark(-[\d.]+)?(-open)?$/,
  /^deepseek\/deepseek-v[\d.]+(-pro|-flash)?$/,
  /^moonshotai\/kimi-k[\d.]+(-pro)?$/,
  /^qwen\/qwen[\d.]+-max/,
  /^mistralai\/mistral-large/,
  /^z-ai\/glm-[\d.]+$/,
];

/** Words that say nothing about which model is meant ("what models are available?"). */
const GENERIC = new Set(['model', 'models', 'available', 'list', 'best', 'popular', 'top', 'show', 'which', 'llm', 'llms', 'модель', 'модели', 'доступные', 'список']);

/** Words asking for more than the short list. */
const MORE = new Set(['all', 'more', 'other', 'others', 'every', 'все', 'всё', 'еще', 'ещё', 'больше', 'другие', 'остальные']);

/**
 * Routers, variants and moving aliases ("openrouter/free", "…:batch", "~…-latest") are rarely what
 * someone means by a model name. Returns the part that makes the id special, so a query that names
 * it ("free", "latest") still finds it.
 */
function variantMarker(id: string): string | null {
  if (id.startsWith('openrouter/')) return id;
  if (id.startsWith('~')) return 'latest';
  if (id.includes(':')) return id.slice(id.indexOf(':') + 1);
  return null;
}

/** Previews and experiments. */
const unstable = (id: string) => /preview|-exp\b|experimental|beta|contributor/.test(id);

/** OpenRouter's model list, cached on disk, used for capability checks and model switching. */
export class Catalog {
  private byId = new Map<string, CatalogModel>();
  private fetchedAt = 0;
  private refreshing: Promise<void> | null = null;
  private readonly or: Pick<OpenRouter, 'models'>;
  private readonly cacheFile: string | null;

  constructor(or: Pick<OpenRouter, 'models'>, cacheFile: string | null) {
    this.or = or;
    this.cacheFile = cacheFile;
    if (cacheFile) {
      try {
        const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { at: number; models: CatalogModel[] };
        this.load(c.models, c.at);
      } catch {}
    }
  }

  load(models: CatalogModel[], at = Date.now()): void {
    this.byId = new Map(models.map((m) => [m.id, m]));
    this.fetchedAt = at;
  }

  get size(): number {
    return this.byId.size;
  }

  /** Refreshes in the background when stale; awaits only when the catalog is empty. */
  async ensure(): Promise<void> {
    if (Date.now() - this.fetchedAt < REFRESH_MS && this.byId.size) return;
    this.refreshing ??= this.or
      .models()
      .then((models) => {
        this.load(models);
        if (this.cacheFile) writeFileAtomic(this.cacheFile, JSON.stringify({ at: this.fetchedAt, models }), 0o644);
      })
      .catch((err) => log.warn('model catalog refresh failed:', err.message))
      .finally(() => (this.refreshing = null));
    if (!this.byId.size) await this.refreshing;
  }

  get(id: string): CatalogModel | undefined {
    return this.byId.get(id);
  }

  /** Unknown models are assumed to be text+image chat models with tool support. */
  supports(id: string, cap: Capability): boolean {
    const m = this.byId.get(id);
    if (!m) return cap === 'image' || cap === 'tools';
    if (cap === 'tools') return !!m.supported_parameters?.includes('tools');
    return m.architecture.input_modalities.includes(cap);
  }

  /**
   * Finds a chat model from loose text like "opus", "gpt 6", "gemini flash" or an exact id.
   * Every word must appear in the id or name; among matches, the newest model wins.
   */
  resolve(query: string): { match?: CatalogModel; candidates: CatalogModel[] } {
    const q = query.trim().toLowerCase();
    if (!q || isGeneric(q)) return { candidates: [] };
    const exact = this.byId.get(q) ?? this.byId.get(query.trim());
    if (exact) return { match: exact, candidates: [exact] };

    const words = tokenize(q);
    // Batch variants, routers and the like only show up when the query names them.
    const chatModels = [...this.byId.values()].filter((m) => {
      if (!m.architecture.output_modalities.includes('text')) return false;
      const marker = variantMarker(m.id);
      return !marker || words.some((w) => marker.includes(w));
    });
    const scored = chatModels
      .map((m) => {
        const hay = new Set([...tokenize(m.id), ...tokenize(m.name)]);
        const hayText = `${m.id} ${m.name}`.toLowerCase();
        let score = 0;
        for (const w of words) {
          if (hay.has(w)) score += 2;
          else if (hayText.includes(w)) score += 1;
          else return null;
        }
        if (m.id.endsWith(':free')) score -= 0.5;
        if (unstable(m.id) || this.isDatedTwin(m.id)) score -= 0.25;
        return { m, score };
      })
      .filter((x): x is { m: CatalogModel; score: number } => x !== null)
      .sort((a, b) => b.score - a.score || b.m.created - a.m.created);
    const candidates = scored.slice(0, 8).map((x) => x.m);
    return { match: candidates[0], candidates };
  }

  /** A dated snapshot ("…-flash-1017") of a model that also has an undated id. */
  private isDatedTwin(id: string): boolean {
    return /-\d{4}$/.test(id) && this.byId.has(id.replace(/-\d{4}$/, ''));
  }

  /**
   * A short list of well-known, current chat models: the presets first, then the newest usable
   * model of each family in FAMILIES.
   */
  featured(presets: string[] = []): CatalogModel[] {
    const usable = (m: CatalogModel) =>
      m.architecture.output_modalities.includes('text') && !variantMarker(m.id) && !unstable(m.id) && !this.isDatedTwin(m.id) && !!m.supported_parameters?.includes('tools');
    const out = new Map<string, CatalogModel>();
    for (const id of presets) {
      const m = this.byId.get(id);
      if (m) out.set(id, m);
    }
    const all = [...this.byId.values()].filter(usable).sort((a, b) => b.created - a.created);
    for (const family of FAMILIES) {
      const m = all.find((x) => family.test(x.id));
      if (m) out.set(m.id, m);
    }
    return [...out.values()];
  }
}

/** True for queries like "available models" or "all models" that name no model at all. */
export function isGeneric(query: string): boolean {
  return tokenize(query.toLowerCase()).every((w) => GENERIC.has(w) || MORE.has(w));
}

/** True for generic queries that ask for the longer list ("all models", "more"). */
export function wantsMore(query: string): boolean {
  return isGeneric(query) && tokenize(query.toLowerCase()).some((w) => MORE.has(w));
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[\s/_:()\-,]+/)
    .filter(Boolean);
}

export function describeModel(m: CatalogModel | undefined, id: string): string {
  if (!m) return id;
  const price = (p?: string) => (p ? `$${(Number(p) * 1e6).toFixed(2)}` : '?');
  const inputs = m.architecture.input_modalities.filter((x) => x !== 'text');
  return `${m.id} — ${m.name}; ${price(m.pricing.prompt)}/${price(m.pricing.completion)} per M tokens` +
    (inputs.length ? `; sees ${inputs.join(', ')}` : '; text only') +
    (m.supported_parameters?.includes('tools') ? '' : '; no tools');
}

/** "Anthropic: Claude Opus 5.5" → "Claude Opus 5.5". */
export function shortName(m: CatalogModel): string {
  return m.name.replace(/^[^:]+:\s*/, '');
}

/** Context budget for recent messages: the configured size, shrunk to fit small context windows. */
export function historyBudget(m: CatalogModel | undefined, historyTokens: number): number {
  return m?.context_length ? Math.max(2000, Math.min(historyTokens, Math.floor(m.context_length * 0.5) - 2000)) : historyTokens;
}

/** What changes for the conversation when switching to this model, for the people in the chat. */
export function switchNote(m: CatalogModel | undefined, historyTokens: number): string {
  const lines: string[] = [];
  const k = (t: number) => (t >= 1000 ? `${Math.round(t / 1000)}k` : String(t));
  const budget = historyBudget(m, historyTokens);
  if (m?.context_length) lines.push(`Context window: ${k(m.context_length)} tokens.`);
  lines.push(budget < historyTokens
    ? `Its context is small, so it sees only the last ~${k(budget)} tokens of chat (instead of ~${k(historyTokens)}) plus the summary of older messages; nothing is deleted.`
    : `Memory carries over: every model gets the last ~${k(historyTokens)} tokens of chat plus the summary of older messages, and can search the full history.`);
  if (m && !m.supported_parameters?.includes('tools')) lines.push('⚠️ This model can\'t use tools: no web search, reminders, images or voice.');
  if (m && (m.id.startsWith('openrouter/') || m.id.endsWith(':free') || Number(m.pricing.completion) === 0)) {
    lines.push('⚠️ Free models and routers are rate-limited and noticeably less accurate, especially with tools.');
  }
  return lines.join('\n');
}

/** Typical tokens of one answer: what Robert sends (system prompt and history) and what comes back. */
export interface AnswerSize {
  prompt: number;
  completion: number;
}

export const DEFAULT_ANSWER_SIZE: AnswerSize = { prompt: 6000, completion: 400 };

/** Estimated price of one answer, in words: "free", "~20 answers per cent", "~3¢ per answer". */
export function costLabel(m: CatalogModel, size: AnswerSize = DEFAULT_ANSWER_SIZE): string {
  const usd = size.prompt * Number(m.pricing.prompt || 0) + size.completion * Number(m.pricing.completion || 0);
  if (!(usd > 0)) return 'free';
  const cents = usd * 100;
  if (cents < 0.5) {
    const per = 1 / cents;
    return `~${per >= 10 ? Math.round(per / 5) * 5 : Math.round(per)} answers per cent`;
  }
  return `~${cents < 10 ? cents.toFixed(1).replace(/\.0$/, '') : Math.round(cents)}¢ per answer`;
}

/** Fallback strengths from what the catalog says about speed, price and inputs. */
function traits(m: CatalogModel): string | null {
  const out: string[] = [];
  if (/flash|mini|haiku|lite|nano|small|fast/i.test(m.id)) out.push('fast');
  const perAnswer = DEFAULT_ANSWER_SIZE.prompt * Number(m.pricing.prompt || 0) + DEFAULT_ANSWER_SIZE.completion * Number(m.pricing.completion || 0);
  if (perAnswer > 0 && perAnswer < 0.002) out.push('very cheap');
  const inputs = m.architecture.input_modalities;
  if (inputs.includes('audio') && inputs.includes('video')) out.push('understands voice and video natively');
  else if (inputs.includes('image')) out.push('sees images');
  return out.length ? out.join(', ') : null;
}

/**
 * What a model is good at, taken from its OpenRouter description ("particularly strong at …",
 * "suited for …"). Descriptions in the catalog are cut off, so a trailing partial item is dropped.
 */
export function strengthOf(m: CatalogModel): string | null {
  const d = (m.description ?? '').replace(/\s+/g, ' ');
  const re = /(?:particularly|especially) strong at ([^.]+)|(?:is |are )?(?:well[- ])?suited (?:for|to) ([^.]+)|(?:designed|built|optimized|optimised|trained) (?:specifically )?for ([^.]+)|flagship model for ([^.]+)/i;
  const hit = d.match(re);
  let s = hit?.slice(1).find(Boolean)?.trim();
  if (!s) return null;
  if (/(\.\.\.|…)$/.test(s) || d.endsWith(s + '...') || d.endsWith(s + '…')) {
    s = s.replace(/(\.\.\.|…)$/, '');
    const cut = Math.max(s.lastIndexOf(', '), s.lastIndexOf(' and '));
    if (cut > 10) s = s.slice(0, cut);
  }
  // Drop trailing asides: ", succeeding Grok 4.6", ", it delivers…".
  s = s.replace(/,\s*(succeeding|replacing|it|which|while|making|with|and is|as)\b.*$/i, '');
  s = s.replace(/,? (and|or)$/, '').replace(/,\s*$/, '');
  return s.length > 110 ? `${s.slice(0, s.lastIndexOf(' ', 107))}…` : s;
}

/** "Claude Opus 5.5 — the hardest questions… · ~3¢ per answer · anthropic/claude-opus-5.5" */
export function modelEntry(m: CatalogModel, opts: { note?: string; size?: AnswerSize; current?: boolean } = {}): string {
  const note = opts.note ?? strengthOf(m) ?? traits(m);
  return `${shortName(m)}${opts.current ? ' (current)' : ''}${note ? ` — ${note}` : ''} · ${costLabel(m, opts.size)} · ${m.id}`;
}
