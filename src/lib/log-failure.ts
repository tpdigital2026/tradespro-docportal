/**
 * One safe log line for an error that is handled quietly (Home loads, guarantee, survey and calendar actions). It
 * carries the stage and the error's class and short code only. The message, the stack and anything else the error
 * holds are never written: they can contain names, addresses, wording or money. Same idea as logFinish and
 * logRenderFailure.
 */
const SAFE_TOKEN = /[^A-Za-z0-9_.-]/g;

const token = (v: unknown, max: number): string => String(v).replace(SAFE_TOKEN, '').slice(0, max) || '-';

export function describeError(err: unknown): { cls: string; code: string } {
  if (err === null || err === undefined) return { cls: '-', code: '-' };
  if (typeof err !== 'object') return { cls: typeof err, code: '-' };
  const e = err as { name?: unknown; code?: unknown; constructor?: { name?: unknown } };
  const cls = typeof e.name === 'string' && e.name ? e.name : typeof e.constructor?.name === 'string' ? e.constructor.name : 'Error';
  // A short code (a Postgres SQLSTATE such as 23505, or a Node code such as ECONNRESET) is kept. Anything long or odd is dropped.
  const code = typeof e.code === 'string' || typeof e.code === 'number' ? String(e.code) : '';
  return { cls: token(cls, 40), code: /^[A-Za-z0-9_-]{1,24}$/.test(code) ? code : '-' };
}

export function logFailure(stage: string, err: unknown): void {
  const { cls, code } = describeError(err);
  console.error(`[failure] stage=${token(stage, 60)} class=${cls} code=${code}`);
}

/** Runs a load. If it throws, one safe line is logged and the fallback is returned with failed: true. */
export async function attempt<T>(stage: string, load: () => Promise<T>, fallback: T): Promise<{ value: T; failed: boolean }> {
  try {
    return { value: await load(), failed: false };
  } catch (e) {
    logFailure(stage, e);
    return { value: fallback, failed: true };
  }
}
