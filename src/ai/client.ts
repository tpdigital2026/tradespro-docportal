/**
 * The only place that talks to a model. Server side only. It never logs what it is sent or what comes back.
 */
export interface ModelRequest {
  system: string;
  user: string;
  maxTokens: number;
  signal: AbortSignal;
}
export interface ModelReply {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}
export interface ModelClient {
  complete(req: ModelRequest): Promise<ModelReply>;
}

/** A failure with a code and nothing else: no request text, no response body. */
export class ModelError extends Error {
  constructor(readonly code: 'unreachable' | 'refused' | 'bad_reply') {
    super(`model ${code}`);
    this.name = 'ModelError';
  }
}

export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export interface AiConfig {
  apiKey: string;
  model: string;
}

/** The AI engine is on exactly when ANTHROPIC_API_KEY is set. The model name comes from ANTHROPIC_MODEL. */
export function aiConfig(env: Record<string, string | undefined> = process.env): AiConfig | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  const model = env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
  return { apiKey, model };
}

export function anthropicClient(cfg: AiConfig, fetchImpl: typeof fetch = fetch): ModelClient {
  return {
    async complete(req) {
      let res: Response;
      try {
        res = await fetchImpl('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: cfg.model, max_tokens: req.maxTokens, system: req.system, messages: [{ role: 'user', content: req.user }] }),
          signal: req.signal,
        });
      } catch {
        throw new ModelError('unreachable');
      }
      if (!res.ok) throw new ModelError('refused');
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new ModelError('bad_reply');
      }
      const b = body as { content?: { type?: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
      const text = (b.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
      if (!text) throw new ModelError('bad_reply');
      return { text, inputTokens: b.usage?.input_tokens, outputTokens: b.usage?.output_tokens };
    },
  };
}
