import fs from 'node:fs';
import { writeFileAtomic } from './config.ts';
import { log } from './log.ts';
import type { CatalogModel, OpenRouter } from './openrouter.ts';

export type Capability = 'image' | 'audio' | 'file' | 'video' | 'tools';

const REFRESH_MS = 6 * 3600_000;

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
    if (!q) return { candidates: [] };
    const exact = this.byId.get(q) ?? this.byId.get(query.trim());
    if (exact) return { match: exact, candidates: [exact] };

    const words = tokenize(q);
    const chatModels = [...this.byId.values()].filter((m) => m.architecture.output_modalities.includes('text'));
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
        if (/preview|beta|experimental/.test(m.id)) score -= 0.25;
        return { m, score };
      })
      .filter((x): x is { m: CatalogModel; score: number } => x !== null)
      .sort((a, b) => b.score - a.score || b.m.created - a.m.created);
    const candidates = scored.slice(0, 8).map((x) => x.m);
    return { match: candidates[0], candidates };
  }
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
