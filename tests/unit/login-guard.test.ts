import { describe, expect, it, vi } from 'vitest';
import {
  type Attempt,
  MAX_CODE_REQUESTS,
  MAX_FAILURES,
  WINDOW_MS,
  decideIp,
  decideIpRequests,
  decideRequest,
  decideVerify,
  hashEmail,
  normaliseIp,
  requestCodeWithGuard,
  verifyWithGuard,
} from '../../src/security/login-guard';

const P = 'test-pepper-0123456789-0123456789';
const Q = 'other-pepper-0123456789-012345678';
const now = new Date('2026-10-14T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const fail = (ms: number): Attempt => ({ kind: 'verify', success: false, at: ago(ms) });
const ok = (ms: number): Attempt => ({ kind: 'verify', success: true, at: ago(ms) });
const req = (ms: number): Attempt => ({ kind: 'request', success: true, at: ago(ms) });

describe('hashEmail', () => {
  it('is stable, case and whitespace insensitive, and peppered', () => {
    expect(hashEmail(' Ben@Example.com ', P)).toBe(hashEmail('ben@example.com', P));
    expect(hashEmail('ben@example.com', P)).not.toBe(hashEmail('ben@example.com', Q));
    expect(hashEmail('ben@example.com', P)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('is a 64 character hex digest that differs from the input', () => {
    const h = hashEmail('ben@example.com', P);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe('ben@example.com');
  });
  it('rejects a missing or short pepper and an empty email', () => {
    expect(() => hashEmail('ben@example.com', '')).toThrow();
    expect(() => hashEmail('ben@example.com', 'x'.repeat(31))).toThrow();
    expect(() => hashEmail('ben@example.com', 'x'.repeat(32))).not.toThrow();
    expect(() => hashEmail('   ', P)).toThrow();
  });
});

describe('decideVerify', () => {
  it('allows with no failures', () => {
    expect(decideVerify([], now)).toEqual({ allowed: true, reason: 'ok', retryAt: null });
  });
  it('allows four failures', () => {
    expect(decideVerify([1, 2, 3, 4].map((m) => fail(m * 1000)), now).allowed).toBe(true);
  });
  it('locks after five failures for 15 minutes from the latest failure', () => {
    const attempts = [1, 2, 3, 4, 5].map((m) => fail(m * 60_000));
    const d = decideVerify(attempts, now);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('locked');
    expect(d.retryAt).toEqual(new Date(now.getTime() - 60_000 + WINDOW_MS));
  });
  it('unlocks once the window has passed', () => {
    const attempts = Array.from({ length: MAX_FAILURES }, (_, i) => fail(WINDOW_MS + 1000 + i));
    expect(decideVerify(attempts, now).allowed).toBe(true);
  });
  it('a successful verify clears earlier failures', () => {
    const attempts = [fail(5 * 60_000), fail(4 * 60_000), fail(3 * 60_000), ok(2 * 60_000), fail(60_000), fail(30_000)];
    expect(decideVerify(attempts, now).allowed).toBe(true);
  });
  it('more failures while locked extend the lock', () => {
    const attempts = [fail(600_000), fail(500_000), fail(400_000), fail(300_000), fail(200_000), fail(10_000)];
    const d = decideVerify(attempts, now);
    expect(d.retryAt).toEqual(new Date(now.getTime() - 10_000 + WINDOW_MS));
  });
});

describe('decideVerify lock lifetime and boundaries', () => {
  const min = 60_000;
  it('a lock lasts 15 minutes from the latest failure, not the sliding window', () => {
    // failures at t0, +3, +6, +9, +12 minutes; now = t0 + 13 or 16 minutes
    const t0 = new Date('2026-10-14T10:00:00Z').getTime();
    const attempts = [0, 3, 6, 9, 12].map((m): Attempt => ({ kind: 'verify', success: false, at: new Date(t0 + m * min) }));
    const at13 = decideVerify(attempts, new Date(t0 + 13 * min));
    expect(at13.allowed).toBe(false);
    expect(at13.retryAt).toEqual(new Date(t0 + 27 * min));
    expect(decideVerify(attempts, new Date(t0 + 16 * min)).allowed).toBe(false);
    expect(decideVerify(attempts, new Date(t0 + 27 * min)).allowed).toBe(true);
  });
  it('a failure exactly WINDOW_MS before the fifth is outside its window; one millisecond closer is inside', () => {
    const base = now.getTime() - 20 * min;
    const spread = (last: number) =>
      [0, 1, 2, 3].map((i): Attempt => ({ kind: 'verify', success: false, at: new Date(base + i * 1000) })).concat([
        { kind: 'verify', success: false, at: new Date(base + last) },
      ]);
    expect(decideVerify(spread(WINDOW_MS + 0), new Date(base + WINDOW_MS + 1)).allowed).toBe(true);
    expect(decideVerify(spread(WINDOW_MS - 1), new Date(base + WINDOW_MS)).allowed).toBe(false);
  });
  it('retryAt equal to now is allowed', () => {
    const last = new Date(now.getTime() - WINDOW_MS);
    const attempts = [4, 3, 2, 1, 0].map((i): Attempt => ({ kind: 'verify', success: false, at: new Date(last.getTime() - i * 1000) }));
    expect(decideVerify(attempts, now).allowed).toBe(true);
    expect(decideVerify(attempts, new Date(now.getTime() - 1)).allowed).toBe(false);
  });
  it('input order does not matter', () => {
    const attempts = [1, 2, 3, 4, 5].map((m) => fail(m * 60_000));
    expect(decideVerify([...attempts].reverse(), now)).toEqual(decideVerify(attempts, now));
  });
  it('request attempts never count toward the lock', () => {
    const attempts = Array.from({ length: 10 }, (_, i) => req((i + 1) * 1000));
    expect(decideVerify(attempts, now).allowed).toBe(true);
  });
  it('a success older than the window still clears earlier failures only', () => {
    const attempts = [fail(40 * min), fail(39 * min), ok(35 * min), fail(2 * min)];
    expect(decideVerify(attempts, now).allowed).toBe(true);
  });
  it('a success recorded while locked does not unlock', () => {
    const attempts = [5, 4, 3, 2, 1].map((m) => fail(m * min)).concat([ok(30_000)]);
    expect(decideVerify(attempts, now).allowed).toBe(false);
  });
});

describe('decideRequest', () => {
  it('allows a few code requests', () => {
    expect(decideRequest([req(1000), req(2000)], now).allowed).toBe(true);
  });
  it('blocks after five requests in the window until the oldest ages out', () => {
    const attempts = Array.from({ length: MAX_CODE_REQUESTS }, (_, i) => req((i + 1) * 60_000));
    const d = decideRequest(attempts, now);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('too_many_codes');
    expect(d.retryAt).toEqual(new Date(now.getTime() - 5 * 60_000 + WINDOW_MS));
  });
  it('retryAt is when enough requests age out to drop below the limit (8 requests)', () => {
    const attempts = Array.from({ length: 8 }, (_, i) => req((i + 1) * 60_000));
    const d = decideRequest(attempts, now);
    // oldest first: 8,7,6,5,4,3,2,1 minutes ago; the 4th oldest (5 minutes ago) must age out
    expect(d.retryAt).toEqual(new Date(now.getTime() - 5 * 60_000 + WINDOW_MS));
  });
  it('ignores verify attempts and old requests', () => {
    const attempts = [fail(1000), ...Array.from({ length: 10 }, (_, i) => req(WINDOW_MS + 1000 + i))];
    expect(decideRequest(attempts, now).allowed).toBe(true);
  });
});

describe('decideIp', () => {
  it('blocks an address with too many failures across emails', () => {
    expect(decideIp(19).allowed).toBe(true);
    const d = decideIp(20);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('ip_blocked');
  });
});

describe('decideIpRequests', () => {
  it('blocks an address with too many code requests', () => {
    expect(decideIpRequests(29).allowed).toBe(true);
    const d = decideIpRequests(30);
    expect(d).toEqual({ allowed: false, reason: 'ip_blocked', retryAt: null });
  });
});

describe('normaliseIp', () => {
  it.each([
    ['203.0.113.5', '203.0.113.5'],
    ['203.0.113.5:4433', '203.0.113.5'],
    ['2001:db8::1', '2001:db8::1'],
    ['[2001:db8::1]:4433', '2001:db8::1'],
    ['[::1]:5678', '::1'],
    ['203.0.113.5, 10.0.0.1', '203.0.113.5'],
    ['fe80::1%eth0', 'fe80::1'],
    ['::ffff:1.2.3.4', '1.2.3.4'],
    ['::FFFF:1.2.3.4', '1.2.3.4'],
    ['2001:DB8::ABCD', '2001:db8::abcd'],
    ['[::1]', '::1'],
    ['  203.0.113.5  ,  10.0.0.1 ', '203.0.113.5'],
    ['::1', '::1'],
    ['not-an-ip', '0.0.0.0'],
    ['', '0.0.0.0'],
    [null, '0.0.0.0'],
    [undefined, '0.0.0.0'],
  ])('%s -> %s', (raw, expected) => {
    expect(normaliseIp(raw as any)).toBe(expected);
  });
});

describe('connection guard', () => {
  it('refuses a pool-like connection that changes backend and never runs checkCode', async () => {
    let pids = 0;
    const fake = {
      query: async (sql: string) => {
        if (sql.includes('pg_backend_pid')) return { rows: [{ pid: ++pids }] };
        return { rows: [] };
      },
    };
    const checkCode = vi.fn(async () => true);
    await expect(verifyWithGuard(fake, { emailHash: 'a'.repeat(64), ip: '203.0.113.5', checkCode })).rejects.toThrow(/dedicated database connection/);
    expect(checkCode).not.toHaveBeenCalled();
    await expect(requestCodeWithGuard(fake, { emailHash: 'a'.repeat(64), ip: '203.0.113.5' })).rejects.toThrow(/dedicated database connection/);
  });
});

describe('lock wait bound', () => {
  it('sets lock_timeout before the lock and reports LOGIN_GUARD_BUSY on 55P03 without running checkCode', async () => {
    const statements: string[] = [];
    const fake = {
      query: async (sql: string) => {
        statements.push(sql);
        if (sql.includes('pg_advisory_xact_lock')) throw Object.assign(new Error('lock timeout'), { code: '55P03' });
        if (sql.includes('pg_backend_pid')) return { rows: [{ pid: 1 }] };
        return { rows: [] };
      },
    };
    const checkCode = vi.fn(async () => true);
    await expect(verifyWithGuard(fake, { emailHash: 'a'.repeat(64), ip: '203.0.113.5', checkCode })).rejects.toMatchObject({
      code: 'LOGIN_GUARD_BUSY',
      message: 'Too many simultaneous attempts, please try again',
    });
    expect(checkCode).not.toHaveBeenCalled();
    const timeout = statements.findIndex((q) => q.includes('lock_timeout'));
    const lock = statements.findIndex((q) => q.includes('pg_advisory_xact_lock'));
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThan(lock);
    expect(statements.at(-1)).toBe('rollback');
  });
});
