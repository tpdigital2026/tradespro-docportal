import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const guard = vi.hoisted(() => ({
  request: vi.fn(),
  verify: vi.fn(),
}));
vi.mock('../../src/security/login-guard', async (orig) => ({
  ...(await orig<typeof import('../../src/security/login-guard')>()),
  requestCodeWithGuard: guard.request,
  verifyWithGuard: guard.verify,
}));

import { handleLogout, handleRequestCode, handleVerify, type AuthApi, type AuthDeps } from '../../src/lib/auth-handlers';
import { readSessionStart } from '../../src/lib/auth-cookies';
import { getClientIp } from '../../src/lib/client-ip';

const PEPPER = 'test-pepper-0123456789-0123456789';
const ORIGIN = 'https://app.example.test';
const SECRET = 'session-secret-0123456789-0123456789';
const deferred: Array<Promise<void>> = [];

function makeDb(activeEmails: string[], activeIds: string[] = []) {
  return {
    end: vi.fn(async () => undefined),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('where email =')) return { rows: activeEmails.includes(params[0] as string) ? [{ one: 1 }] : [] };
      if (sql.includes('where id =')) return { rows: activeIds.includes(params[0] as string) ? [{ one: 1 }] : [] };
      return { rows: [] };
    }),
  };
}

function makeAuth(over: Record<string, unknown> = {}) {
  return {
    signInWithOtp: vi.fn(async () => ({ error: null })),
    verifyOtp: vi.fn(async () => ({ data: { session: null, user: null }, error: { message: 'bad' } })),
    ...over,
  } as unknown as AuthApi & { signInWithOtp: ReturnType<typeof vi.fn>; verifyOtp: ReturnType<typeof vi.fn> };
}

function deps(db: ReturnType<typeof makeDb>, auth: AuthApi, over: Partial<AuthDeps> = {}): AuthDeps {
  return { openDb: async () => db as never, auth: () => auth, pepper: () => PEPPER, minDurationMs: 0,
    revoke: vi.fn(async () => undefined),
    revokeByRefreshToken: vi.fn(async () => undefined),
    sessionSecret: () => SECRET,
    defer: (task) => {
      deferred.push(task());
    },
    ...over,
  };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-vercel-forwarded-for': '203.0.113.9', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function snap(res: Response) {
  return { status: res.status, body: await res.json(), setCookie: res.headers.get('set-cookie') };
}

beforeEach(() => {
  deferred.length = 0;
  guard.request.mockReset().mockResolvedValue({ outcome: 'allowed' });
  guard.verify.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('request-code', () => {
  it('answers a registered and an unregistered email identically', async () => {
    const db = makeDb(['ben@example.com']);
    const auth = makeAuth();
    const known = await snap(await handleRequestCode(post('/api/auth/request-code', { email: 'ben@example.com' }), deps(db, auth)));
    const unknown = await snap(await handleRequestCode(post('/api/auth/request-code', { email: 'nobody@example.com' }), deps(db, auth)));
    expect(known).toEqual(unknown);
    expect(known.status).toBe(200);
    expect(known.body.message).toBe('If that email is registered, a code is on its way.');
  });

  it('only asks Supabase to send a code for an active profile, and never creates users', async () => {
    const db = makeDb(['ben@example.com']);
    const auth = makeAuth();
    await handleRequestCode(post('/api/auth/request-code', { email: 'nobody@example.com' }), deps(db, auth));
    expect(auth.signInWithOtp).not.toHaveBeenCalled();
    await handleRequestCode(post('/api/auth/request-code', { email: '  Ben@Example.com ' }), deps(db, auth));
    await Promise.all(deferred);
    expect(auth.signInWithOtp).toHaveBeenCalledWith({ email: 'ben@example.com', options: { shouldCreateUser: false } });
  });

  it('uses the trusted IP header, never X-Forwarded-For, and closes the connection', async () => {
    const db = makeDb([]);
    await handleRequestCode(post('/api/auth/request-code', { email: 'a@example.com' }, { 'x-forwarded-for': '6.6.6.6' }), deps(db, makeAuth()));
    expect(guard.request.mock.calls[0][1].ip).toBe('203.0.113.9');
    expect(guard.request.mock.calls[0][0]).toBe(db);
    expect(db.end).toHaveBeenCalled();
  });

  it('still answers 200 when Supabase fails to send', async () => {
    const db = makeDb(['ben@example.com']);
    const auth = makeAuth({ signInWithOtp: vi.fn(async () => ({ error: new Error('rate limited') })) });
    const res = await handleRequestCode(post('/api/auth/request-code', { email: 'ben@example.com' }), deps(db, auth));
    expect(res.status).toBe(200);
    await Promise.all(deferred);
    expect(console.error).toHaveBeenCalled();
  });

  it('response time does not depend on registration: the slow send runs after the response', async () => {
    const db = makeDb(['ben@example.com']);
    const slow = makeAuth({ signInWithOtp: vi.fn(() => new Promise((r) => setTimeout(() => r({ error: null }), 300))) });
    const time = async (email: string) => {
      const t = Date.now();
      const res = await handleRequestCode(post('/api/auth/request-code', { email }), deps(db, slow, { minDurationMs: 30 }));
      expect(res.status).toBe(200);
      return Date.now() - t;
    };
    const known = await time('ben@example.com');
    const unknown = await time('nobody@example.com');
    expect(known).toBeLessThan(200);
    expect(Math.abs(known - unknown)).toBeLessThan(100);
    expect(slow.signInWithOtp).toHaveBeenCalledTimes(1);
    await Promise.all(deferred);
    expect(deferred).toHaveLength(1);
  });

  it('logs a failed deferred send by name only', async () => {
    const db = makeDb(['ben@example.com']);
    const slow = makeAuth({ signInWithOtp: vi.fn(async () => { throw new Error('boom secret@example.com'); }) });
    await handleRequestCode(post('/api/auth/request-code', { email: 'ben@example.com' }), deps(db, slow));
    await Promise.all(deferred);
    const logged = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).join();
    expect(logged).toContain('request-code send');
  });

  it('maps a blocked decision to one rate limit answer for every email', async () => {
    guard.request.mockResolvedValue({ outcome: 'blocked', decision: { allowed: false, reason: 'too_many_codes', retryAt: new Date() } });
    const db = makeDb(['ben@example.com']);
    const a = await snap(await handleRequestCode(post('/api/auth/request-code', { email: 'ben@example.com' }), deps(db, makeAuth())));
    const b = await snap(await handleRequestCode(post('/api/auth/request-code', { email: 'x@example.com' }), deps(db, makeAuth())));
    expect(a).toEqual(b);
    expect(a.status).toBe(429);
  });

  it.each([
    ['LOGIN_GUARD_BUSY', { code: 'LOGIN_GUARD_BUSY' }],
    ['55P03', { code: '55P03' }],
  ])('maps %s to a generic try again response', async (_n, err) => {
    guard.request.mockRejectedValue(Object.assign(new Error('internal detail postgres://u:p@h/db'), err));
    const db = makeDb([]);
    const res = await handleRequestCode(post('/api/auth/request-code', { email: 'a@example.com' }), deps(db, makeAuth()));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, message: 'Please try again shortly.' });
    expect(db.end).toHaveBeenCalled();
  });

  it('fails the same generic way for every email when keys or the database are missing', async () => {
    const missing = () => {
      throw new Error('Sign-in is not configured');
    };
    const db = makeDb(['ben@example.com']);
    const a = await snap(await handleRequestCode(post('/api/auth/request-code', { email: 'ben@example.com' }), deps(db, makeAuth(), { auth: missing })));
    const b = await snap(await handleRequestCode(post('/api/auth/request-code', { email: 'x@example.com' }), deps(db, makeAuth(), { auth: missing })));
    expect(a).toEqual(b);
    expect(a.status).toBe(503);
    const down = await handleRequestCode(
      post('/api/auth/request-code', { email: 'a@example.com' }),
      deps(db, makeAuth(), {
        openDb: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      }),
    );
    expect(down.status).toBe(503);
  });

  it('rejects cross-origin, origin-less, non-JSON and invalid requests', async () => {
    const d = deps(makeDb([]), makeAuth());
    expect((await handleRequestCode(post('/api/auth/request-code', { email: 'a@example.com' }, { origin: 'https://evil.test' }), d)).status).toBe(403);
    const noOrigin = new Request(`${ORIGIN}/api/auth/request-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"a@example.com"}' });
    expect((await handleRequestCode(noOrigin, d)).status).toBe(403);
    expect((await handleRequestCode(post('/api/auth/request-code', { email: 'a@example.com' }, { 'content-type': 'text/plain' }), d)).status).toBe(400);
    expect((await handleRequestCode(post('/api/auth/request-code', { email: 'not-an-email' }), d)).status).toBe(400);
    expect((await handleRequestCode(post('/api/auth/request-code', '{bad json'), d)).status).toBe(400);
    expect(guard.request).not.toHaveBeenCalled();
  });

  it('holds every guarded answer to the minimum duration', async () => {
    const d = deps(makeDb([]), makeAuth(), { minDurationMs: 80 });
    const t = Date.now();
    await handleRequestCode(post('/api/auth/request-code', { email: 'a@example.com' }), d);
    expect(Date.now() - t).toBeGreaterThanOrEqual(75);
  });
});

describe('verify', () => {
  const session = { access_token: 'at.value.x', refresh_token: 'rt-value' };

  /** For 'real', runs the checkCode closure the route hands to the guard, as the guard would. */
  function runGuard(outcome: 'real' | 'blocked' | 'wrong_code') {
    guard.verify.mockImplementation(async (_db: unknown, input: { checkCode: () => Promise<boolean> }) => {
      if (outcome === 'blocked') return { outcome: 'blocked', decision: { allowed: false, reason: 'locked', retryAt: new Date() } };
      if (outcome === 'wrong_code') return { outcome: 'wrong_code' };
      return (await input.checkCode()) ? { outcome: 'verified' } : { outcome: 'wrong_code' };
    });
  }

  it('gives wrong code, lock, unknown email and malformed code the same status, body and cookies', async () => {
    const db = makeDb([], []);
    const auth = makeAuth();
    runGuard('wrong_code');
    const wrong = await snap(await handleVerify(post('/api/auth/verify', { email: 'ben@example.com', code: '123456' }), deps(db, auth)));
    runGuard('blocked');
    const locked = await snap(await handleVerify(post('/api/auth/verify', { email: 'ben@example.com', code: '123456' }), deps(db, auth)));
    runGuard('real');
    const unknown = await snap(await handleVerify(post('/api/auth/verify', { email: 'nobody@example.com', code: '123456' }), deps(db, auth)));
    const malformed = await snap(await handleVerify(post('/api/auth/verify', { email: 'ben@example.com', code: 'abc' }), deps(db, auth)));
    expect(locked).toEqual(wrong);
    expect(unknown).toEqual(wrong);
    expect(malformed).toEqual(wrong);
    expect(wrong.status).toBe(401);
    expect(wrong.setCookie).toBeNull();
  });

  it('passes the guard the dedicated connection and the trusted IP, and skips the guard for a malformed code', async () => {
    const db = makeDb([]);
    const auth = makeAuth();
    runGuard('wrong_code');
    await handleVerify(post('/api/auth/verify', { email: 'a@example.com', code: '12345' }), deps(db, auth));
    expect(guard.verify).not.toHaveBeenCalled();
    expect(auth.verifyOtp).not.toHaveBeenCalled();
    await handleVerify(post('/api/auth/verify', { email: 'a@example.com', code: '123456' }, { 'x-forwarded-for': '6.6.6.6' }), deps(db, auth));
    expect(guard.verify.mock.calls[0][0]).toBe(db);
    expect(guard.verify.mock.calls[0][1].ip).toBe('203.0.113.9');
    expect(db.end).toHaveBeenCalled();
  });

  it('sets httpOnly, SameSite=Lax, Secure cookies on success', async () => {
    const db = makeDb([], ['user-1']);
    const auth = makeAuth({ verifyOtp: vi.fn(async () => ({ data: { session, user: { id: 'user-1' } }, error: null })) });
    runGuard('real');
    const res = await handleVerify(post('/api/auth/verify', { email: 'ben@example.com', code: '123456' }), deps(db, auth));
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(3);
    for (const c of cookies) {
      expect(c).toMatch(/HttpOnly/i);
      expect(c).toMatch(/SameSite=lax/i);
      expect(c).toMatch(/Secure/i);
      expect(c).toMatch(/Path=\//);
    }
    expect(cookies.join(';')).toContain('at.value.x');
    expect(auth.verifyOtp).toHaveBeenCalledWith({ email: 'ben@example.com', token: '123456', type: 'email' });
    const start = cookies.find((c) => c.includes('dp-st='))!;
    const value = decodeURIComponent(start.split(';')[0].split('=').slice(1).join('='));
    expect(readSessionStart(SECRET, value, Math.floor(Date.now() / 1000))).toBe('user-1');
  });

  it('fails generically when the session secret is missing', async () => {
    const res = await handleVerify(
      post('/api/auth/verify', { email: 'a@example.com', code: '123456' }),
      deps(makeDb([]), makeAuth(), { sessionSecret: () => { throw new Error('Sign-in is not configured'); } }),
    );
    expect(res.status).toBe(503);
  });

  it('treats a valid code for a disabled or removed person as a failed login with no cookies', async () => {
    const db = makeDb([], []);
    const auth = makeAuth({ verifyOtp: vi.fn(async () => ({ data: { session, user: { id: 'gone' } }, error: null })) });
    runGuard('real');
    const d = deps(db, auth);
    const res = await handleVerify(post('/api/auth/verify', { email: 'ben@example.com', code: '123456' }), d);
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(d.revoke).toHaveBeenCalledWith('at.value.x');
  });

  it.each([['LOGIN_GUARD_BUSY'], ['55P03']])('maps %s to a generic try again response', async (code) => {
    guard.verify.mockRejectedValue(Object.assign(new Error('x'), { code }));
    const res = await handleVerify(post('/api/auth/verify', { email: 'a@example.com', code: '123456' }), deps(makeDb([]), makeAuth()));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, message: 'Please try again shortly.' });
  });

  it('fails generically, without leaking, when the keys are missing', async () => {
    const res = await handleVerify(
      post('/api/auth/verify', { email: 'a@example.com', code: '123456' }),
      deps(makeDb([]), makeAuth(), {
        auth: () => {
          throw new Error('Sign-in is not configured');
        },
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, message: 'Please try again shortly.' });
  });

  it('rejects cross-origin requests before doing any work', async () => {
    const res = await handleVerify(post('/api/auth/verify', { email: 'a@example.com', code: '123456' }, { origin: 'https://evil.test' }), deps(makeDb([]), makeAuth()));
    expect(res.status).toBe(403);
    expect(guard.verify).not.toHaveBeenCalled();
  });
});

describe('logout', () => {
  const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
  const logoutReq = (origin = ORIGIN) => new Request(`${ORIGIN}/api/auth/logout`, { method: 'POST', headers: { origin } });

  it('clears all session cookies, revokes a live access token and redirects to /login', async () => {
    const d = deps(makeDb([]), makeAuth());
    const live = jwt(Math.floor(Date.now() / 1000) + 600);
    const res = await handleLogout(logoutReq(), { access: live, refresh: 'rt' }, d);
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
    const cookies = res.headers.getSetCookie();
    expect(cookies).toHaveLength(3);
    for (const c of cookies) expect(c).toMatch(/Max-Age=0/i);
    expect(d.revoke).toHaveBeenCalledWith(live);
    expect(d.revokeByRefreshToken).not.toHaveBeenCalled();
  });

  it('revokes through the refresh token when the access token has expired or is gone', async () => {
    const d = deps(makeDb([]), makeAuth());
    await handleLogout(logoutReq(), { access: jwt(1), refresh: 'rt' }, d);
    await handleLogout(logoutReq(), { refresh: 'rt2' }, d);
    expect(d.revokeByRefreshToken).toHaveBeenCalledWith('rt');
    expect(d.revokeByRefreshToken).toHaveBeenCalledWith('rt2');
    expect(d.revoke).not.toHaveBeenCalled();
  });

  it('clears cookies even when revoking throws', async () => {
    const d = deps(makeDb([]), makeAuth(), { revokeByRefreshToken: async () => { throw new Error('down'); } });
    const res = await handleLogout(logoutReq(), { refresh: 'rt' }, d);
    expect(res.status).toBe(303);
    expect(res.headers.getSetCookie()).toHaveLength(3);
  });

  it('refuses cross-origin logout', async () => {
    expect((await handleLogout(logoutReq('https://evil.test'), { access: 'tok' }, deps(makeDb([]), makeAuth()))).status).toBe(403);
  });
});

describe('getClientIp', () => {
  it('prefers the platform header and ignores X-Forwarded-For', () => {
    expect(getClientIp(new Headers({ 'x-forwarded-for': '6.6.6.6', 'x-vercel-forwarded-for': '203.0.113.1' }))).toBe('203.0.113.1');
    expect(getClientIp(new Headers({ 'x-real-ip': '203.0.113.2' }))).toBe('203.0.113.2');
  });
  it('falls back to the shared sentinel and logs the shape only', () => {
    expect(getClientIp(new Headers({ 'x-forwarded-for': '6.6.6.6' }))).toBe('0.0.0.0');
    const warn = vi.mocked(console.warn);
    expect(getClientIp(new Headers({ 'x-real-ip': 'secret-looking' }))).toBe('0.0.0.0');
    expect(warn.mock.calls.map((c) => String(c[0])).join()).not.toContain('secret-looking');
  });
});
