import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDemo } from '../../src/lib/demo';

afterEach(() => vi.unstubAllEnvs());

function env(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) vi.stubEnv(k, undefined as unknown as string);
    else vi.stubEnv(k, v);
  }
}

describe('isDemo', () => {
  it('is true only with DEMO_MODE=1, non-production and no VERCEL', () => {
    env({ DEMO_MODE: '1', NODE_ENV: 'development', VERCEL: undefined });
    expect(isDemo()).toBe(true);
    env({ DEMO_MODE: '1', NODE_ENV: 'test', VERCEL: undefined });
    expect(isDemo()).toBe(true);
  });
  it('is false in production', () => {
    env({ DEMO_MODE: '1', NODE_ENV: 'production', VERCEL: undefined });
    expect(isDemo()).toBe(false);
  });
  it('is false when VERCEL is set', () => {
    env({ DEMO_MODE: '1', NODE_ENV: 'development', VERCEL: '1' });
    expect(isDemo()).toBe(false);
  });
  it('is false when DEMO_MODE is unset or not exactly 1', () => {
    env({ DEMO_MODE: undefined, NODE_ENV: 'development', VERCEL: undefined });
    expect(isDemo()).toBe(false);
    for (const v of ['0', 'true', '', '2']) {
      env({ DEMO_MODE: v, NODE_ENV: 'development', VERCEL: undefined });
      expect(isDemo()).toBe(false);
    }
  });
});
