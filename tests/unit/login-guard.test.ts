import { describe, expect, it } from 'vitest';
import {
  type Attempt,
  MAX_CODE_REQUESTS,
  MAX_FAILURES,
  WINDOW_MS,
  decideIp,
  decideRequest,
  decideVerify,
  hashEmail,
} from '../../src/security/login-guard';

const now = new Date('2026-10-14T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const fail = (ms: number): Attempt => ({ kind: 'verify', success: false, at: ago(ms) });
const ok = (ms: number): Attempt => ({ kind: 'verify', success: true, at: ago(ms) });
const req = (ms: number): Attempt => ({ kind: 'request', success: true, at: ago(ms) });

describe('hashEmail', () => {
  it('is stable, case and whitespace insensitive, and peppered', () => {
    expect(hashEmail(' Ben@Example.com ', 'p')).toBe(hashEmail('ben@example.com', 'p'));
    expect(hashEmail('ben@example.com', 'p')).not.toBe(hashEmail('ben@example.com', 'q'));
    expect(hashEmail('ben@example.com', 'p')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('never contains the email', () => {
    expect(hashEmail('ben@example.com', 'p')).not.toContain('ben');
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
