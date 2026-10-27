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
const GENERIC = new Set(['model', 'models', 'available', 'list', 'all', 'best', 'popular', 'top', 'show', 'which', 'llm', 'llms', 'модель', 'модели', 'доступные', 'список']);

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

/** True for queries like "available models" that name no model at all. */
export function isGeneric(query: string): boolean {
  return tokenize(query.toLowerCase()).every((w) => GENERIC.has(w));
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

/** One compact line for model lists: short name, id, price and what it can take in. */
export function modelLine(m: CatalogModel): string {
  const price = (p?: string) => {
    const n = Number(p) * 1e6;
    return p ? `$${Number.isInteger(n) ? n : n.toFixed(2)}` : '?';
  };
  const inputs = m.architecture.input_modalities.filter((x) => x !== 'text');
  return `${shortName(m)} — ${m.id} (${price(m.pricing.prompt)}/${price(m.pricing.completion)} per M` +
    (inputs.length ? `; ${inputs.join(', ')}` : '') + ')';
}
