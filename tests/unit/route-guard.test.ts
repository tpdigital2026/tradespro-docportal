import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accessCookieName, refreshCookieName, signSessionStart, startCookieName } from '../../src/lib/auth-cookies';
import { activityCookieName, readActivity, signActivity } from '../../src/lib/session-policy';
import { config } from '../../src/proxy';
import { guardRequest, refreshTokenRejected, type GuardDeps } from '../../src/lib/route-guard';

afterEach(() => vi.unstubAllEnvs());

const NOW = 1_800_000_000;
const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
const SECRET = 'session-secret-0123456789-0123456789';
const DAY = 86400;
const deps = (refresh: GuardDeps['refresh'] = async () => null): GuardDeps => ({ nowSeconds: () => NOW, refresh, sessionSecret: () => SECRET });
interface Pol { idleAgoMin?: number; idle?: number; maxDays?: number; userId?: string; sessionId?: string; activitySecret?: string }
/** The login-time cookie and the activity cookie, as a signed-in browser holds them (by default: 30 day cap, active 5 minutes ago). */
const start = (ageDays = 1, secret = SECRET, o: Pol = {}) => ({
  [startCookieName()]: signSessionStart(secret, 'user-1', 'sess-1', NOW - ageDays * DAY),
  [activityCookieName()]: signActivity(o.activitySecret ?? secret, { userId: o.userId ?? 'user-1', sessionId: o.sessionId ?? 'sess-1', lastAt: NOW - (o.idleAgoMin ?? 5) * 60, idleMinutes: o.idle ?? 30, maxDays: o.maxDays ?? 30 }),
});

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
    expect((await guardRequest(req('/login/x'), deps())).status).toBe(307);
    expect((await guardRequest(req('/fjc/extra'), deps())).status).toBe(307);
    expect((await guardRequest(req('/api/authx'), deps())).status).toBe(401);
  });
  it.each(['/fjc', '/some-business', '/loginx'])('lets the business sign-in address %s through, signed out', async (p) => {
    expect(isNext(await guardRequest(req(p), deps()))).toBe(true);
  });
  it.each(['/customers', '/documents', '/dev', '/admin', '/s', '/_next', '/FJC', '/a'])('keeps the reserved or malformed %s behind sign-in', async (p) => {
    expect((await guardRequest(req(p), deps())).status).toBe(307);
  });
  it('lets a request with a live access token through without calling Supabase', async () => {
    const refresh = vi.fn();
    const r = await guardRequest(req('/', { cookies: { [accessCookieName()]: jwt(NOW + 3600), ...start() } }), deps(refresh));
    expect(isNext(r)).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });
  it('refreshes an expired access token and sets fresh cookies', async () => {
    const refresh = vi.fn(async () => ({ access_token: jwt(NOW + 3600), refresh_token: 'rt2' }));
    const r = await guardRequest(req('/', { cookies: { [accessCookieName()]: jwt(NOW - 10), [refreshCookieName()]: 'rt1', ...start() } }), deps(refresh));
    expect(isNext(r)).toBe(true);
    expect(refresh).toHaveBeenCalledWith('rt1');
    const set = r.headers.getSetCookie().join(';');
    expect(set).toContain('rt2');
    expect(set).toMatch(/HttpOnly/i);
  });
  it('clears cookies when Supabase rejects the refresh token', async () => {
    const r = await guardRequest(req('/', { cookies: { [accessCookieName()]: 'junk', [refreshCookieName()]: 'rt1', ...start() } }), deps(async () => null));
    expect(loc(r)).toBe('/login');
    expect(r.headers.getSetCookie().length).toBe(4);
    expect(r.headers.getSetCookie().every((c) => /Max-Age=0/i.test(c))).toBe(true);
  });
  it('keeps cookies when the refresh fails for network or configuration reasons', async () => {
    const r = await guardRequest(req('/', { cookies: { [accessCookieName()]: 'junk', [refreshCookieName()]: 'rt1', ...start() } }), deps(async () => { throw new Error('fetch failed'); }));
    expect(loc(r)).toBe('/login');
    expect(r.headers.getSetCookie()).toHaveLength(0);
  });
  it('enforces the 30 day cap from the original login, however fresh the tokens are', async () => {
    const live = { [accessCookieName()]: jwt(NOW + 3600), [refreshCookieName()]: 'rt1' };
    const refresh = vi.fn(async () => ({ access_token: jwt(NOW + 3600), refresh_token: 'rt2' }));
    expect(isNext(await guardRequest(req('/', { cookies: { ...live, ...start(29) } }), deps(refresh)))).toBe(true);
    const old = await guardRequest(req('/', { cookies: { ...live, ...start(31) } }), deps(refresh));
    expect(loc(old)).toBe('/login');
    expect(old.headers.getSetCookie().length).toBe(4);
    expect(refresh).not.toHaveBeenCalled();
  });
  it('rejects a missing, forged or wrongly signed login-time cookie', async () => {
    const live = { [accessCookieName()]: jwt(NOW + 3600) };
    for (const cookies of [live, { ...live, ...start(1, 'another-secret-0123456789-0123456789') }, { ...live, [startCookieName()]: `user-1.sess-1.${NOW}.AAAA` }, { ...live, [startCookieName()]: `user-1.sess-1.${NOW + 999999}.x` }]) {
      expect(loc(await guardRequest(req('/', { cookies }), deps()))).toBe('/login');
    }
  });
  it('denies without clearing when the signing secret is missing', async () => {
    const d = { ...deps(), sessionSecret: () => { throw new Error('nope'); } };
    const r = await guardRequest(req('/', { cookies: { [accessCookieName()]: jwt(NOW + 3600), ...start() } }), d);
    expect(loc(r)).toBe('/login');
    expect(r.headers.getSetCookie()).toHaveLength(0);
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

describe('session policy in the proxy', () => {
  const live = { [accessCookieName()]: jwt(NOW + 3600) };
  const at = (r: Response) => r.headers.get('location') ?? '';
  const cleared = (r: Response) => r.headers.getSetCookie().filter((c) => /Max-Age=0/i.test(c)).length;
  it('idle 29 minutes is fine; idle 31 minutes signs out with the friendly notice and clears every cookie', async () => {
    expect(isNext(await guardRequest(req('/', { cookies: { ...live, ...start(1, SECRET, { idleAgoMin: 29 }) } }), deps()))).toBe(true);
    const r = await guardRequest(req('/customers', { cookies: { ...live, ...start(1, SECRET, { idleAgoMin: 31 }) } }), deps());
    expect(at(r)).toBe('https://app.example.test/login?notice=signed-out');
    expect(cleared(r)).toBe(4);
  });
  it('uses the idle limit the cookie carries (10 to 480 minutes)', async () => {
    expect(loc(await guardRequest(req('/', { cookies: { ...live, ...start(1, SECRET, { idle: 10, idleAgoMin: 11 }) } }), deps()))).toBe('/login');
    expect(isNext(await guardRequest(req('/', { cookies: { ...live, ...start(1, SECRET, { idle: 480, idleAgoMin: 479 }) } }), deps()))).toBe(true);
  });
  it('an API call after the idle limit gets a 401 that says why', async () => {
    const r = await guardRequest(req('/api/documents/x/pdf', { cookies: { ...live, ...start(1, SECRET, { idleAgoMin: 45 }) } }), deps());
    expect(r.status).toBe(401);
    expect((await r.json()).message).toBe('You were signed out for your security. Please sign in again.');
  });
  it('enforces the business maximum (max_session_days) from the original login', async () => {
    expect(isNext(await guardRequest(req('/', { cookies: { ...live, ...start(6.9, SECRET, { maxDays: 7 }) } }), deps()))).toBe(true);
    const r = await guardRequest(req('/', { cookies: { ...live, ...start(7.1, SECRET, { maxDays: 7 }) } }), deps());
    expect(at(r)).toMatch(/notice=signed-out$/);
    expect(cleared(r)).toBe(4);
  });
  it('refuses a missing, forged, other person\'s or other session\'s activity cookie (plain sign-in, cookies cleared)', async () => {
    const st = { [startCookieName()]: start()[startCookieName()] };
    const bad = [
      {},
      { [activityCookieName()]: start(1, SECRET, { activitySecret: 'another-secret-0123456789-0123456789' })[activityCookieName()] },
      { [activityCookieName()]: start(1, SECRET, { userId: 'user-2' })[activityCookieName()] },
      { [activityCookieName()]: start(1, SECRET, { sessionId: 'sess-2' })[activityCookieName()] },
      { [activityCookieName()]: start()[activityCookieName()].replace(/\.30\.30\./, '.480.30.') },
      { [activityCookieName()]: start(1, SECRET, { idleAgoMin: -10 })[activityCookieName()] },
    ];
    for (const a of bad) {
      const r = await guardRequest(req('/', { cookies: { ...live, ...st, ...a } }), deps());
      expect(loc(r), JSON.stringify(a)).toBe('/login');
      expect(at(r)).not.toMatch(/notice/);
      expect(cleared(r)).toBe(4);
    }
  });
  it('records activity on the response (not the request) once the stored time is a minute old', async () => {
    const r = await guardRequest(req('/', { cookies: { ...live, ...start(1, SECRET, { idleAgoMin: 5 }) } }), deps());
    const set = r.headers.getSetCookie().find((c) => c.startsWith(`${activityCookieName()}=`))!;
    const value = decodeURIComponent(set.split(';')[0].split('=').slice(1).join('='));
    expect(readActivity(SECRET, value)).toMatchObject({ userId: 'user-1', sessionId: 'sess-1', lastAt: NOW, idleMinutes: 30, maxDays: 30 });
    expect(r.headers.get('x-middleware-request-cookie') ?? '').not.toContain(value);
    const quiet = await guardRequest(req('/', { cookies: { ...live, ...start(1, SECRET, { idleAgoMin: 0.5 }) } }), deps());
    expect(quiet.headers.getSetCookie()).toHaveLength(0);
  });
  it('the cron route is reachable without a session (it checks its own bearer secret)', async () => {
    expect(isNext(await guardRequest(req('/api/cron/maintenance'), deps()))).toBe(true);
    expect((await guardRequest(req('/api/cron/maintenancex'), deps())).status).toBe(401);
    expect((await guardRequest(req('/api/cron/other'), deps())).status).toBe(401);
  });
});

describe('proxy matcher', () => {
  const [apiPattern, pagesPattern] = config.matcher as string[];
  const pages = new RegExp(`^${pagesPattern}$`);
  it('matches every /api path, whatever its extension', () => {
    expect(apiPattern).toBe('/api/:path*');
    for (const p of ['/api/x.png', '/api/customers.js', '/api/a/b.css']) expect(pages.test(p)).toBe(false); // covered by the api pattern instead
  });
  it('skips only framework assets and static files for pages', () => {
    for (const p of ['/', '/customers', '/customers/abc', '/login', '/documents/new']) expect(pages.test(p)).toBe(true);
    for (const p of ['/_next/static/x.js', '/favicon.ico', '/logo.svg', '/fonts/a.woff2', '/robots.txt', '/site.webmanifest']) expect(pages.test(p)).toBe(false);
  });
  it('the static allowances are whole names: nothing can hide behind them', () => {
    for (const p of ['/robots.txt/x', '/robots.txtfoo', '/favicon.icox', '/favicon.ico/customers', '/site.webmanifest/x', '/site.webmanifestx', '/_next/staticx']) expect(pages.test(p), p).toBe(true);
  });
});

describe('refreshTokenRejected', () => {
  it('is true only for 4xx other than 429', () => {
    for (const status of [400, 401, 403, 422]) expect(refreshTokenRejected({ status })).toBe(true);
    for (const status of [429, 500, 502, 503, 0]) expect(refreshTokenRejected({ status })).toBe(false);
    expect(refreshTokenRejected(new Error('fetch failed'))).toBe(false);
    expect(refreshTokenRejected(null)).toBe(false);
  });
});
