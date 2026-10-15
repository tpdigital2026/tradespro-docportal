import { afterEach, describe, expect, it, vi } from 'vitest';

const jar = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: jar.get }) }));
const redirectMock = vi.hoisted(() => vi.fn((to: string) => {
  throw new Error(`NEXT_REDIRECT ${to}`);
}));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));

const sb = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../../src/lib/supabase-server', () => ({
  anonClient: () => {
    if (!sb.client) throw new Error('Sign-in is not configured');
    return sb.client;
  },
}));

import { signSessionStart, startCookieName } from '../../src/lib/auth-cookies';
import { demoSession } from '../../src/lib/demo-data';
import { getSession, requireSession, resolveSession, resolveSessionAndLimits, type SessionClient } from '../../src/lib/session';
import { signActivity } from '../../src/lib/session-policy';

afterEach(() => {
  vi.unstubAllEnvs();
  jar.get.mockReset();
  redirectMock.mockClear();
});

const USER = '11111111-1111-1111-1111-111111111111';
const row = { id: USER, tenant_id: 'tenant-1', role: 'owner', full_name: 'Ben C', email: 'ben@example.com', tenants: { name: 'FJC Roofing' } };

function client(over: { user?: { id: string } | null; getUserError?: unknown; row?: unknown; rowError?: unknown; limits?: unknown; limitsError?: unknown } = {}) {
  const eq = vi.fn(() => ({ maybeSingle: async () => ({ data: 'row' in over ? over.row : row, error: over.rowError ?? null }) }));
  const select = vi.fn(() => ({ eq }));
  const limitsSelect = vi.fn(() => ({ maybeSingle: async () => ({ data: over.limits ?? null, error: over.limitsError ?? null }) }));
  const c: SessionClient = {
    auth: { getUser: async () => ({ data: { user: 'user' in over ? over.user! : { id: USER } }, error: over.getUserError ?? null }) },
    from: ((t: string) => (t === 'tenant_defaults' ? { select: limitsSelect } : { select })) as never,
  };
  return { c, select, eq, limitsSelect };
}

describe('resolveSession', () => {
  it('resolves tenant and role from the profile row for the verified user', async () => {
    const { c, eq } = client();
    expect(await resolveSession('tok', () => c)).toEqual({
      userId: USER, tenantId: 'tenant-1', role: 'owner', email: 'ben@example.com', fullName: 'Ben C', businessName: 'FJC Roofing',
    });
    expect(eq).toHaveBeenCalledWith('id', USER);
  });
  it('accepts the tenant embed as an array', async () => {
    const { c } = client({ row: { ...row, tenants: [{ name: 'FJC Roofing' }] } });
    expect((await resolveSession('tok', () => c))?.businessName).toBe('FJC Roofing');
  });
  it('is null with no token, without building a client', async () => {
    const make = vi.fn();
    expect(await resolveSession(undefined, make)).toBeNull();
    expect(make).not.toHaveBeenCalled();
  });
  it('is null when the token does not verify', async () => {
    expect(await resolveSession('tok', () => client({ user: null }).c)).toBeNull();
    expect(await resolveSession('tok', () => client({ getUserError: new Error('jwt expired') }).c)).toBeNull();
  });
  it('is null for a disabled person (no profile row visible) or a lookup error', async () => {
    expect(await resolveSession('tok', () => client({ row: null }).c)).toBeNull();
    expect(await resolveSession('tok', () => client({ row: null, rowError: new Error('x') }).c)).toBeNull();
  });
  it('is null for a row for someone else, an unknown role or a malformed row', async () => {
    expect(await resolveSession('tok', () => client({ row: { ...row, id: 'other' } }).c)).toBeNull();
    expect(await resolveSession('tok', () => client({ row: { ...row, role: 'superuser' } }).c)).toBeNull();
    expect(await resolveSession('tok', () => client({ row: { ...row, tenants: null } }).c)).toBeNull();
  });
  it('is null, not a crash, when the client cannot be built or throws', async () => {
    expect(await resolveSession('tok', () => { throw new Error('Sign-in is not configured'); })).toBeNull();
  });
});

describe('getSession and requireSession', () => {
  it('returns the demo session only when isDemo()', async () => {
    vi.stubEnv('DEMO_MODE', '1');
    vi.stubEnv('NODE_ENV', 'development');
    expect(await getSession()).toEqual(demoSession);
  });
  it.each([
    ['production', { DEMO_MODE: '1', NODE_ENV: 'production' }],
    ['VERCEL set', { DEMO_MODE: '1', NODE_ENV: 'development', VERCEL: '1' }],
    ['flag off', { DEMO_MODE: '', NODE_ENV: 'development' }],
  ])('never returns the demo session (%s)', async (_n, env) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    jar.get.mockReturnValue(undefined);
    expect(await getSession()).toBeNull();
  });
  it('is null with keys missing even when a cookie is present', async () => {
    vi.stubEnv('DEMO_MODE', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
    jar.get.mockReturnValue({ value: 'a.b.c' });
    expect(await getSession()).toBeNull();
  });
  it('requireSession redirects to /login when there is no session', async () => {
    vi.stubEnv('DEMO_MODE', '');
    jar.get.mockReturnValue(undefined);
    await expect(requireSession()).rejects.toThrow('NEXT_REDIRECT /login');
  });
  it('requireSession returns the demo session in demo mode', async () => {
    vi.stubEnv('DEMO_MODE', '1');
    vi.stubEnv('NODE_ENV', 'development');
    expect(await requireSession()).toEqual(demoSession);
  });
});

describe('getSession login-time cap', () => {
  const SECRET = 'session-secret-0123456789-0123456789';
  const SID = 'sess-1';
  const tok = (sid: string, exp: number) => `h.${Buffer.from(JSON.stringify({ session_id: sid, exp })).toString('base64url')}.s`;
  const nowS = () => Math.floor(Date.now() / 1000);
  /** The activity cookie as the proxy leaves it: active a minute ago, the widest limits, so only dp-st is under test. */
  const act = (o: { agoMin?: number; userId?: string; sid?: string; idle?: number; maxDays?: number } = {}) =>
    signActivity(SECRET, { userId: o.userId ?? USER, sessionId: o.sid ?? SID, lastAt: nowS() - (o.agoMin ?? 1) * 60, idleMinutes: o.idle ?? 480, maxDays: o.maxDays ?? 30 });
  function setup(startValue: string | undefined, activity: string | undefined = act(), limits: unknown = { idle_logout_minutes: 480, max_session_days: 30 }) {
    vi.stubEnv('DEMO_MODE', '');
    vi.stubEnv('SESSION_SECRET', SECRET);
    sb.client = client({ limits }).c;
    jar.get.mockImplementation((name: string) => {
      if (name.endsWith('dp-at')) return { value: tok(SID, nowS() + 600) };
      if (name.endsWith('dp-st') && startValue) return { value: startValue };
      if (name.includes('dp-la-') && activity) return { value: activity };
      return undefined;
    });
  }
  afterEach(() => { sb.client = null; });
  it('accepts a recent login for the same person', async () => {
    setup(signSessionStart(SECRET, USER, SID, nowS() - 29 * 86400));
    expect((await getSession())?.userId).toBe(USER);
  });
  it('denies a login older than 30 days, a missing cookie, another person\'s cookie and a forged one', async () => {
    for (const v of [signSessionStart(SECRET, USER, SID, nowS() - 31 * 86400), undefined, signSessionStart(SECRET, 'someone-else', SID, nowS()), signSessionStart('x'.repeat(40), USER, SID, nowS()), signSessionStart(SECRET, USER, 'other-session', nowS())]) {
      setup(v);
      expect(await getSession()).toBeNull();
    }
  });
  it('keeps working after a token refresh (new token, same session_id) but not for a different session', async () => {
    setup(signSessionStart(SECRET, USER, SID, nowS() - 20 * 86400));
    jar.get.mockImplementation((name: string) => {
      if (name.endsWith('dp-at')) return { value: tok(SID, nowS() + 3600) }; // refreshed access token
      if (name.endsWith('dp-st')) return { value: signSessionStart(SECRET, USER, SID, nowS() - 20 * 86400) };
      if (name.includes('dp-la-')) return { value: act() };
      return undefined;
    });
    expect((await getSession())?.userId).toBe(USER);
    jar.get.mockImplementation((name: string) => {
      if (name.endsWith('dp-at')) return { value: tok('attacker-session', nowS() + 3600) };
      if (name.endsWith('dp-st')) return { value: signSessionStart(SECRET, USER, SID, nowS()) };
      if (name.includes('dp-la-')) return { value: act({ sid: 'attacker-session' }) };
      return undefined;
    });
    expect(await getSession()).toBeNull();
  });
  it('denies when the secret is missing', async () => {
    setup(signSessionStart(SECRET, USER, SID, nowS()));
    vi.stubEnv('SESSION_SECRET', '');
    expect(await getSession()).toBeNull();
  });
});

describe('getSession session policy (the limits stored for the business now)', () => {
  const SECRET = 'session-secret-0123456789-0123456789';
  const SID = 'sess-1';
  const tok = (sid: string, exp: number) => `h.${Buffer.from(JSON.stringify({ session_id: sid, exp })).toString('base64url')}.s`;
  const nowS = () => Math.floor(Date.now() / 1000);
  function setup(o: { loginDaysAgo?: number; activeMinAgo?: number; limits?: unknown; activity?: string | null }) {
    vi.stubEnv('DEMO_MODE', '');
    vi.stubEnv('SESSION_SECRET', SECRET);
    sb.client = client({ limits: o.limits ?? null }).c;
    const activity = o.activity === undefined
      ? signActivity(SECRET, { userId: USER, sessionId: SID, lastAt: nowS() - (o.activeMinAgo ?? 1) * 60, idleMinutes: 480, maxDays: 30 })
      : o.activity;
    jar.get.mockImplementation((name: string) => {
      if (name.endsWith('dp-at')) return { value: tok(SID, nowS() + 600) };
      if (name.endsWith('dp-st')) return { value: signSessionStart(SECRET, USER, SID, nowS() - (o.loginDaysAgo ?? 0) * 86400) };
      if (name.includes('dp-la-') && activity) return { value: activity };
      return undefined;
    });
  }
  afterEach(() => { sb.client = null; });
  it('defaults (30 minutes, 7 days) apply with no settings row: 29 minutes idle is fine, 31 is not', async () => {
    setup({ activeMinAgo: 29 });
    expect((await getSession())?.userId).toBe(USER);
    setup({ activeMinAgo: 31 });
    expect(await getSession()).toBeNull();
    await expect(requireSession()).rejects.toThrow('NEXT_REDIRECT /api/auth/expired');
  });
  it('a stricter setting applies at once, whatever limits the cookie carries', async () => {
    setup({ activeMinAgo: 12, limits: { idle_logout_minutes: 10, max_session_days: 30 } });
    await expect(requireSession()).rejects.toThrow('NEXT_REDIRECT /api/auth/expired');
    setup({ loginDaysAgo: 2, limits: { idle_logout_minutes: 480, max_session_days: 1 } });
    await expect(requireSession()).rejects.toThrow('NEXT_REDIRECT /api/auth/expired');
    setup({ loginDaysAgo: 0.5, activeMinAgo: 9, limits: { idle_logout_minutes: 10, max_session_days: 1 } });
    expect((await requireSession()).userId).toBe(USER);
  });
  it('a missing or forged activity cookie is simply signed out (no notice)', async () => {
    setup({ activity: null });
    await expect(requireSession()).rejects.toThrow('NEXT_REDIRECT /login');
    setup({ activity: signActivity('y'.repeat(40), { userId: USER, sessionId: SID, lastAt: nowS(), idleMinutes: 30, maxDays: 7 }) });
    await expect(requireSession()).rejects.toThrow(/NEXT_REDIRECT \/login$/);
  });
  it('limits read through RLS; out-of-range or failed reads fall back to the defaults', async () => {
    const ok = await resolveSessionAndLimits('tok', () => client({ limits: { idle_logout_minutes: 60, max_session_days: 14 } }).c);
    expect(ok?.limits).toEqual({ idleMinutes: 60, maxDays: 14 });
    const junk = await resolveSessionAndLimits('tok', () => client({ limits: { idle_logout_minutes: 5, max_session_days: 99 } }).c);
    expect(junk?.limits).toEqual({ idleMinutes: 30, maxDays: 7 });
    const failed = await resolveSessionAndLimits('tok', () => client({ limitsError: new Error('x') }).c);
    expect(failed?.limits).toEqual({ idleMinutes: 30, maxDays: 7 });
  });
});
