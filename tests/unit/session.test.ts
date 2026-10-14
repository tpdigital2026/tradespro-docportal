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
import { getSession, requireSession, resolveSession, type SessionClient } from '../../src/lib/session';

afterEach(() => {
  vi.unstubAllEnvs();
  jar.get.mockReset();
  redirectMock.mockClear();
});

const USER = '11111111-1111-1111-1111-111111111111';
const row = { id: USER, tenant_id: 'tenant-1', role: 'owner', full_name: 'Ben C', email: 'ben@example.com', tenants: { name: 'FJC Roofing' } };

function client(over: { user?: { id: string } | null; getUserError?: unknown; row?: unknown; rowError?: unknown } = {}) {
  const eq = vi.fn(() => ({ maybeSingle: async () => ({ data: 'row' in over ? over.row : row, error: over.rowError ?? null }) }));
  const select = vi.fn(() => ({ eq }));
  const c: SessionClient = {
    auth: { getUser: async () => ({ data: { user: 'user' in over ? over.user! : { id: USER } }, error: over.getUserError ?? null }) },
    from: () => ({ select }) as never,
  };
  return { c, select, eq };
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
  const nowS = () => Math.floor(Date.now() / 1000);
  function setup(startValue: string | undefined) {
    vi.stubEnv('DEMO_MODE', '');
    vi.stubEnv('SESSION_SECRET', SECRET);
    sb.client = client().c;
    jar.get.mockImplementation((name: string) => {
      if (name.endsWith('dp-at')) return { value: 'tok' };
      if (name.endsWith('dp-st') && startValue) return { value: startValue };
      return undefined;
    });
  }
  afterEach(() => { sb.client = null; });
  it('accepts a recent login for the same person', async () => {
    setup(signSessionStart(SECRET, USER, nowS() - 29 * 86400));
    expect((await getSession())?.userId).toBe(USER);
  });
  it('denies a login older than 30 days, a missing cookie, another person\'s cookie and a forged one', async () => {
    for (const v of [signSessionStart(SECRET, USER, nowS() - 31 * 86400), undefined, signSessionStart(SECRET, 'someone-else', nowS()), signSessionStart('x'.repeat(40), USER, nowS())]) {
      setup(v);
      expect(await getSession()).toBeNull();
    }
  });
  it('denies when the secret is missing', async () => {
    setup(signSessionStart(SECRET, USER, nowS()));
    vi.stubEnv('SESSION_SECRET', '');
    expect(await getSession()).toBeNull();
  });
});
