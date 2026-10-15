/**
 * Dev-only demo mode. True only when DEMO_MODE=1, NODE_ENV is not
 * production and VERCEL is unset. Reads the environment on every call so
 * tests can vary it.
 */
export function isDemo(): boolean {
  return (
    process.env.DEMO_MODE === '1' &&
    process.env.NODE_ENV !== 'production' &&
    !process.env.VERCEL
  );
}

const BOX = Symbol.for('docportal.demo-state');

/**
 * Demo-only in-memory state, kept on globalThis so every server bundle (pages, server actions and route handlers are
 * compiled separately) sees the same dummy data. Never used outside demo mode.
 */
export function demoSlot<T>(key: string, init: () => T): { get(): T; set(v: T | null): void } {
  const g = globalThis as unknown as Record<symbol, Map<string, unknown>>;
  g[BOX] ??= new Map();
  const box = g[BOX];
  return {
    get: () => {
      if (!box.has(key)) box.set(key, init());
      return box.get(key) as T;
    },
    set: (v) => {
      if (v === null) box.delete(key);
      else box.set(key, v);
    },
  };
}
