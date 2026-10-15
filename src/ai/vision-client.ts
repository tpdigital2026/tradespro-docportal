import 'server-only';
import { ModelError, type AiConfig } from './client';

/**
 * A model call that may carry photos. Server side only, and only ever made when ANTHROPIC_API_KEY is set (the caller
 * gets null from aiConfig() otherwise and never builds this). It never logs what it sends or what comes back, and
 * the photos are never stored by this module.
 */
export interface VisionRequest {
  system: string;
  text: string;
  /** JPEG bytes. */
  images: Buffer[];
  maxTokens: number;
  signal: AbortSignal;
}
export interface VisionReply {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}
export interface VisionClient {
  complete(req: VisionRequest): Promise<VisionReply>;
}

export function anthropicVisionClient(cfg: AiConfig, fetchImpl: typeof fetch = fetch): VisionClient {
  return {
    async complete(req) {
      const content = [
        ...req.images.map((b) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b.toString('base64') } })),
        { type: 'text', text: req.text },
      ];
      let res: Response;
      try {
        res = await fetchImpl('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: cfg.model, max_tokens: req.maxTokens, system: req.system, messages: [{ role: 'user', content }] }),
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
