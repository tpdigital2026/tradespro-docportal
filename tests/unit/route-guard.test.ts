import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accessCookieName, refreshCookieName } from '../../src/lib/auth-cookies';
import { guardRequest, type GuardDeps } from '../../src/lib/route-guard';

afterEach(() => vi.unstubAllEnvs());

const NOW = 1_800_000_000;
const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
const deps = (refresh: GuardDeps['refresh'] = async () => null): GuardDeps => ({ nowSeconds: () => NOW, refresh });

function req(path: string, opts: { method?: string; cookies?: Record<string, string>; headers?: Record<string, string> } = {}) {
  const cookie = Object.entries(opts.cookies ?? {}).map(([k, v]) => `${k}=${v}`).join('; ');
  return new NextRequest(`https://app.example.test${path}`, {
    method: opts.method ?? 'GET',
    headers: { ...(cookie ? { cookie } : {}), ...opts.headers },
  });
}
const loc = (r: Response) => (r.headers.get('location') ? new URL(r.headers.get('location')!).pathname : null);
const isNext = (r: Response) => r.headers.get('x-middleware-next') === '1';

describe('guardRequest', () => {
  it.each(['/', '/customers', '/customers/abc', '/documents/new', '/anything/else'])('redirects an unauthenticated %s to /login', async (p) => {
    const r = await guardRequest(req(p), deps());
    expect(r.status).toBe(307);
    expect(loc(r)).toBe('/login');
  });
  it('answers 401 JSON, not a redirect, for unauthenticated API calls', async () => {
    const r = await guardRequest(req('/api/customers'), deps());
    expect(r.status).toBe(401);
  });
  it.each(['/login', '/api/auth/verify', '/api/auth/request-code', '/api/auth/logout'])('lets %s through', async (p) => {
    expect(isNext(await guardRequest(req(p), deps()))).toBe(true);
  });
  it('does not treat lookalike paths as public', async () => {
    expect((await guardRequest(req('/loginx'), deps())).status).toBe(307);
    expect((await guardRequest(req('/api/authx'), deps())).status).toBe(401);
  });
  it('lets a request with a live access token through without calling Supabase', async () => {
    const refresh = vi.fn();
    const r = await guardRequest(req('/', { cookies: { [accessCookieName()]: jwt(NOW + 3600) } }), deps(refresh));
    expect(isNext(r)).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });
  it('refreshes an expired access token and sets fresh cookies', async () => {
    const refresh = vi.fn(async () => ({ access_token: jwt(NOW + 3600), refresh_token: 'rt2' }));
    const r = await guardRequest(req('/', { cookies: { [accessCookieName()]: jwt(NOW - 10), [refreshCookieName()]: 'rt1' } }), deps(refresh));
    expect(isNext(r)).toBe(true);
    expect(refresh).toHaveBeenCalledWith('rt1');
    const set = r.headers.getSetCookie().join(';');
    expect(set).toContain('rt2');
    expect(set).toMatch(/HttpOnly/i);
  });
  it('redirects and clears cookies when the refresh fails or throws', async () => {
    for (const refresh of [async () => null, async () => { throw new Error('keys missing'); }]) {
      const r = await guardRequest(req('/', { cookies: { [accessCookieName()]: 'junk', [refreshCookieName()]: 'rt1' } }), deps(refresh));
      expect(loc(r)).toBe('/login');
      expect(r.headers.getSetCookie().every((c) => /Max-Age=0/i.test(c))).toBe(true);
    }
  });
  it('treats a garbage access token with no refresh token as signed out', async () => {
    const r = await guardRequest(req('/', { cookies: { [accessCookieName()]: 'not-a-jwt' } }), deps());
    expect(loc(r)).toBe('/login');
  });
  it('requires a same-origin Origin on state-changing requests everywhere', async () => {
    expect((await guardRequest(req('/customers', { method: 'POST' }), deps())).status).toBe(403);
    expect((await guardRequest(req('/customers', { method: 'POST', headers: { origin: 'https://evil.test' } }), deps())).status).toBe(403);
    const ok = await guardRequest(req('/customers', { method: 'POST', headers: { origin: 'https://app.example.test' } }), deps());
    expect(ok.status).toBe(307);
  });
  it('lets everything through in demo mode only when isDemo()', async () => {
    vi.stubEnv('DEMO_MODE', '1');
    vi.stubEnv('NODE_ENV', 'development');
    expect(isNext(await guardRequest(req('/customers'), deps()))).toBe(true);
    vi.stubEnv('VERCEL', '1');
    expect((await guardRequest(req('/customers'), deps())).status).toBe(307);
  });
});
