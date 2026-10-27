const BASE = 'https://openrouter.ai/api/v1';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } }
  | { type: 'file'; file: { filename: string; file_data: string } };

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Provider reasoning state; must be passed back unchanged during tool loops. */
  reasoning_details?: unknown;
  [extra: string]: unknown;
}

export type Tool =
  | { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
  | { type: `openrouter:${string}`; parameters?: Record<string, unknown> };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Tool[];
  max_tokens?: number;
  temperature?: number;
  plugins?: Record<string, unknown>[];
  response_format?: Record<string, unknown>;
  max_tool_calls?: number;
  tool_choice?: 'auto' | 'none' | 'required';
  reasoning?: Record<string, unknown>;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
}

export interface ChatResponse {
  id: string;
  model: string;
  choices: { message: ChatMessage; finish_reason: string | null }[];
  usage?: Usage;
}

export interface CatalogModel {
  id: string;
  name: string;
  description?: string;
  created: number;
  context_length: number;
  architecture: { input_modalities: string[]; output_modalities: string[] };
  pricing: Record<string, string>;
  supported_parameters?: string[];
  supported_voices?: string[] | null;
}

export class OpenRouterError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Called after every paid request so spending can be recorded and capped. */
export type UsageHook = (u: { kind: string; model: string; usage?: Usage; chatId?: number }) => void;

export interface Options {
  fetch?: typeof fetch;
  onUsage?: UsageHook;
}

/** Thin client for the parts of the OpenRouter API Robert uses. */
export class OpenRouter {
  private readonly key: string;
  private readonly fetch: typeof fetch;
  onUsage: UsageHook;

  constructor(key: string, opts: Options = {}) {
    this.key = key;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.onUsage = opts.onUsage ?? (() => {});
  }

  private async request(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<Response> {
    const res = await this.fetch(BASE + path, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: {
        Authorization: `Bearer ${this.key}`,
        'Content-Type': 'application/json',
        'X-Title': 'Robert',
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(init.timeoutMs ?? 180_000),
    });
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const j = (await res.json()) as { error?: { message?: string; metadata?: { raw?: string } } };
        if (j.error?.message) msg = `${j.error.message}${j.error.metadata?.raw ? ` (${String(j.error.metadata.raw).slice(0, 300)})` : ''}`;
      } catch {}
      throw new OpenRouterError(res.status, msg);
    }
    return res;
  }

  async chat(body: ChatRequest, meta: { kind: string; chatId?: number }): Promise<ChatResponse> {
    const res = await this.request('/chat/completions', { body, timeoutMs: 300_000 });
    const json = (await res.json()) as ChatResponse & { error?: { message?: string } };
    // Errors can also arrive with HTTP 200 once a provider stream has started.
    if (json.error) throw new OpenRouterError(502, json.error.message || 'provider error');
    if (!json.choices?.length) throw new OpenRouterError(502, 'empty response from model');
    this.onUsage({ kind: meta.kind, model: body.model, usage: json.usage, chatId: meta.chatId });
    return json;
  }

  async transcribe(
    audio: { data: Buffer; format: string },
    opts: { model: string; language?: string; chatId?: number },
  ): Promise<string> {
    const res = await this.request('/audio/transcriptions', {
      body: {
        model: opts.model,
        input_audio: { data: audio.data.toString('base64'), format: audio.format },
        ...(opts.language ? { language: opts.language } : {}),
      },
    });
    const json = (await res.json()) as { text?: string; usage?: Usage };
    this.onUsage({ kind: 'transcribe', model: opts.model, usage: json.usage, chatId: opts.chatId });
    return (json.text ?? '').trim();
  }

  /** Returns MP3 bytes. */
  async speech(opts: { model: string; input: string; voice?: string; instructions?: string; chatId?: number }): Promise<Buffer> {
    const res = await this.request('/audio/speech', {
      body: {
        model: opts.model,
        input: opts.input,
        response_format: 'mp3',
        ...(opts.voice ? { voice: opts.voice } : {}),
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
      },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    // The speech endpoint returns raw audio, so cost isn't in the body; record the call without it.
    this.onUsage({ kind: 'tts', model: opts.model, chatId: opts.chatId });
    return buf;
  }

  async image(opts: {
    model: string;
    prompt: string;
    aspect_ratio?: string;
    input_references?: string[];
    chatId?: number;
  }): Promise<{ data: Buffer; mime: string }[]> {
    const res = await this.request('/images', {
      body: {
        model: opts.model,
        prompt: opts.prompt,
        n: 1,
        ...(opts.aspect_ratio ? { aspect_ratio: opts.aspect_ratio } : {}),
        ...(opts.input_references?.length ? { input_references: opts.input_references } : {}),
      },
      timeoutMs: 300_000,
    });
    const json = (await res.json()) as { data?: { b64_json?: string; media_type?: string }[]; usage?: Usage };
    this.onUsage({ kind: 'image', model: opts.model, usage: json.usage, chatId: opts.chatId });
    return (json.data ?? [])
      .filter((d) => d.b64_json)
      .map((d) => ({ data: Buffer.from(d.b64_json!, 'base64'), mime: d.media_type || 'image/png' }));
  }

  async models(query: Record<string, string> = {}): Promise<CatalogModel[]> {
    const qs = new URLSearchParams(query).toString();
    const res = await this.request(`/models${qs ? `?${qs}` : ''}`, { timeoutMs: 60_000 });
    return ((await res.json()) as { data: CatalogModel[] }).data;
  }

  async imageModels(): Promise<{ id: string }[]> {
    const res = await this.request('/images/models', { timeoutMs: 60_000 });
    return ((await res.json()) as { data: { id: string }[] }).data;
  }

  /** Validates the key; returns its label and remaining credit (null = no limit). */
  async keyInfo(): Promise<{ label: string; limitRemaining: number | null; usage: number }> {
    const res = await this.request('/key', { timeoutMs: 30_000 });
    const d = ((await res.json()) as { data: { label?: string; limit_remaining?: number | null; usage?: number } }).data;
    return { label: d.label ?? '', limitRemaining: d.limit_remaining ?? null, usage: d.usage ?? 0 };
  }
}
