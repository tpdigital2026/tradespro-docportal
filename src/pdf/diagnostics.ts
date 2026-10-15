/**
 * Safe render diagnostics. A failure is tagged with the STAGE it happened in, and logged as one JSON line with the
 * stage, the error's class name and its code. Never the document: no HTML, no customer facts, no error message from
 * a stage that has seen document content (a page error can quote the page). The one exception is the launch stages
 * (extract, launch), which run before any document exists; their message is what explains a broken deployment
 * ("libnss3.so: cannot open shared object file", 'The input directory ... does not exist'), so it is kept, cut short.
 *
 * Look for these lines in the Vercel runtime logs (README "Rendering on Vercel"):
 *   [render] {"event":"render_failed","where":"preview","stage":"extract",...}
 *   [render] {"event":"render_ok","where":"preview","cold":true,"ms":{...}}   (serverless only)
 */
import { renderEngine, renderRuntime } from './engine';

export type RenderStage =
  | 'extract' // @sparticuz/chromium inflating its binary into /tmp
  | 'launch' // starting the browser process
  | 'page' // opening a page, setting the viewport and the network lock
  | 'layout' // measuring and paginating (setContent, print media, fonts)
  | 'check' // the overflow guard
  | 'pdf'
  | 'screenshot'
  | 'decode' // signature picture decode and redraw
  | 'upload' // storage put/get
  | 'prepare'; // facts, settings, secrets: anything before the renderer

const STAGE = Symbol.for('docportal.renderStage');

/** Records the stage on the error itself (first stage wins) and returns it, so instanceof checks still work. */
export function tagStage<E>(err: E, stage: RenderStage): E {
  if (err && typeof err === 'object' && !(STAGE in err)) {
    Object.defineProperty(err, STAGE, { value: stage, enumerable: false });
  }
  return err;
}

export function stageOf(err: unknown): RenderStage | null {
  return err && typeof err === 'object' && STAGE in err ? ((err as Record<symbol, RenderStage>)[STAGE] ?? null) : null;
}

/** Runs fn and tags anything it throws with the stage. */
export async function inStage<T>(stage: RenderStage, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw tagStage(e, stage);
  }
}

const SAFE_MESSAGE_STAGES: ReadonlySet<RenderStage> = new Set(['extract', 'launch']);

/** The fields that are safe to log for an error. Exported for tests. */
export function describeFailure(where: string, err: unknown): Record<string, string | number | boolean> {
  const stage = stageOf(err) ?? 'prepare';
  const e = (err && typeof err === 'object' ? err : {}) as { name?: unknown; code?: unknown; errno?: unknown; message?: unknown };
  const out: Record<string, string | number | boolean> = {
    event: 'render_failed',
    where,
    stage,
    engine: renderEngine(),
    runtime: renderRuntime(),
    error: typeof e.name === 'string' ? e.name.slice(0, 60) : typeof err,
  };
  if (typeof e.code === 'string' || typeof e.code === 'number') out.code = String(e.code).slice(0, 60);
  if (SAFE_MESSAGE_STAGES.has(stage) && typeof e.message === 'string') {
    out.detail = e.message.replace(/\s+/g, ' ').slice(0, 400);
  }
  return out;
}

/** One log line for a failed render. The user-facing message is the caller's and stays unchanged. */
export function logRenderFailure(where: string, err: unknown): void {
  console.error(`[render] ${JSON.stringify(describeFailure(where, err))}`);
}

/** Timings for a successful render, logged on serverless (or with RENDER_DEBUG=1) so a slow cold start is visible. */
export function logRenderOk(where: string, info: { cold: boolean; ms: Record<string, number>; pages: number }): void {
  if (renderRuntime() !== 'serverless' && process.env.RENDER_DEBUG !== '1') return;
  console.log(`[render] ${JSON.stringify({ event: 'render_ok', where, engine: renderEngine(), ...info })}`);
}

/** Wraps an object (a storage client) so anything its methods throw or reject with is tagged with the stage. */
export function tagFailures<T extends object>(target: T, stage: RenderStage): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        try {
          const out = value.apply(obj, args);
          return out instanceof Promise ? out.catch((e: unknown) => Promise.reject(tagStage(e, stage))) : out;
        } catch (e) {
          throw tagStage(e, stage);
        }
      };
    },
  });
}
