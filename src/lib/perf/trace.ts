import { cache } from 'react';

/**
 * Debug-only round-trip tracing. Off unless DP_TRACE=1 (never set in production). Each database connection, query and
 * Supabase HTTP call logs one line with a short per-request tag and the time since that request's first call, e.g.
 *
 *   [dp-trace] r7k2 query #4 +212ms
 *
 * so the number of round trips per page and the shape of any waterfall can be read off the server log. Nothing about
 * the query, its values, the URL or the person is logged.
 */
export const traceOn = (): boolean => process.env.DP_TRACE === '1';

interface Req {
  tag: string;
  start: number;
  n: number;
}

// One record per request (React's cache is scoped to a single server request); outside a request each call gets a fresh one.
const current = cache((): Req => ({ tag: Math.random().toString(36).slice(2, 6), start: Date.now(), n: 0 }));

function log(kind: string): void {
  if (!traceOn()) return;
  let r: Req;
  try {
    r = current();
  } catch {
    r = { tag: '----', start: Date.now(), n: 0 };
  }
  r.n += 1;
  console.log(`[dp-trace] ${r.tag} ${kind} #${r.n} +${Date.now() - r.start}ms`);
}

export const traceConnect = (): void => log('connect');
export const traceQuery = (): void => log('query');

/** A fetch for the Supabase client that logs each HTTP round trip when tracing is on, and is plain fetch otherwise. */
export const tracedFetch: typeof fetch = (input, init) => {
  if (traceOn()) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    log(url.includes('/auth/v1/') ? 'auth' : 'rest');
  }
  return fetch(input, init);
};
