import { describe, expect, it } from 'vitest';
import { signSessionStart } from '../../src/lib/auth-cookies';
import {
  checkSessionPolicy,
  DEFAULT_LIMITS,
  IDLE_MINUTES,
  limitsFrom,
  MAX_SESSION_DAYS,
  readActivity,
  signActivity,
  type Activity,
} from '../../src/lib/session-policy';

const SECRET = 'session-secret-0123456789-0123456789';
const NOW = 1_800_000_000;

/** A small deterministic generator, so a failing case can be replayed. */
function prng(seed: number) {
  let s = seed;
  const next = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const id = () => Array.from({ length: int(1, 40) }, () => 'abcdefABCDEF0123456789-'[int(0, 22)]).join('');
  return { next, int, id };
}

function randomActivity(r: ReturnType<typeof prng>): Activity {
  return {
    userId: r.id(),
    sessionId: r.id(),
    lastAt: r.int(0, 4_000_000_000),
    idleMinutes: r.int(IDLE_MINUTES.min, IDLE_MINUTES.max),
    maxDays: r.int(MAX_SESSION_DAYS.min, MAX_SESSION_DAYS.max),
  };
}

describe('activity cookie MAC (property tests)', () => {
  it('round-trips every valid activity exactly', () => {
    const r = prng(11);
    for (let i = 0; i < 500; i += 1) {
      const a = randomActivity(r);
      expect(readActivity(SECRET, signActivity(SECRET, a))).toEqual(a);
    }
  });

  it('any single-character change to a signed value is refused', () => {
    const r = prng(23);
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.';
    for (let i = 0; i < 400; i += 1) {
      const a = randomActivity(r);
      const signed = signActivity(SECRET, a);
      const at = r.int(0, signed.length - 1);
      const ch = alphabet[r.int(0, alphabet.length - 1)];
      if (signed[at] === ch) continue;
      const tampered = signed.slice(0, at) + ch + signed.slice(at + 1);
      expect(readActivity(SECRET, tampered), tampered).toBeNull();
    }
  });

  it('a value signed with another secret, or with the login-time cookie\'s scheme, is refused', () => {
    const r = prng(37);
    for (let i = 0; i < 200; i += 1) {
      const a = randomActivity(r);
      expect(readActivity('another-secret-0123456789-0123456789', signActivity(SECRET, a))).toBeNull();
    }
    // Domain separation: a dp-st value never reads as activity, whatever its shape.
    expect(readActivity(SECRET, signSessionStart(SECRET, 'u', 's', NOW))).toBeNull();
  });

  it('moving fields between positions breaks the MAC (no ambiguity between user and session)', () => {
    const a: Activity = { userId: 'aaa', sessionId: 'bbb', lastAt: NOW, idleMinutes: 30, maxDays: 7 };
    const [u, s, ...rest] = signActivity(SECRET, a).split('.');
    expect(readActivity(SECRET, [s, u, ...rest].join('.'))).toBeNull();
  });

  it('refuses out-of-range limits, junk and oversized values, and will not sign them', () => {
    const ok: Activity = { userId: 'u', sessionId: 's', lastAt: NOW, idleMinutes: 30, maxDays: 7 };
    for (const bad of [{ idleMinutes: 9 }, { idleMinutes: 481 }, { maxDays: 0 }, { maxDays: 31 }, { userId: 'a.b' }, { lastAt: -1 }]) {
      expect(() => signActivity(SECRET, { ...ok, ...bad })).toThrow();
    }
    for (const junk of [undefined, null, '', 'x', 'a.b.c.d.e.f', `u.s.${NOW}.30.7.${'A'.repeat(43)}`, 'u.s.1.30.7.' + 'A'.repeat(500)]) {
      expect(readActivity(SECRET, junk)).toBeNull();
    }
  });
});

describe('checkSessionPolicy', () => {
  const start = { userId: 'u', sessionId: 's', at: NOW - 3600 };
  const act = (minAgo: number, o: Partial<Activity> = {}): Activity => ({ userId: 'u', sessionId: 's', lastAt: NOW - minAgo * 60, idleMinutes: 30, maxDays: 7, ...o });
  const run = (activity: Activity | null, limits = DEFAULT_LIMITS, s: typeof start | null = start) => checkSessionPolicy({ start: s, activity, nowSeconds: NOW, limits });

  it('idle: 29 minutes is fine, 30 is the edge, 31 signs out', () => {
    expect(run(act(29))).toBe('ok');
    expect(run(act(30))).toBe('ok');
    expect(run(act(31))).toBe('idle');
  });
  it('the absolute cap counts from the login time, not the last activity', () => {
    expect(run(act(0), DEFAULT_LIMITS, { ...start, at: NOW - 7 * 86400 })).toBe('ok');
    expect(run(act(0), DEFAULT_LIMITS, { ...start, at: NOW - 7 * 86400 - 1 })).toBe('expired');
    expect(run(act(0), { idleMinutes: 30, maxDays: 1 }, { ...start, at: NOW - 86400 - 60 })).toBe('expired');
  });
  it('another person, another session, no cookie or a future time is invalid', () => {
    expect(run(act(1, { userId: 'v' }))).toBe('invalid');
    expect(run(act(1, { sessionId: 't' }))).toBe('invalid');
    expect(run(null)).toBe('invalid');
    expect(run(act(1), DEFAULT_LIMITS, null)).toBe('invalid');
    expect(run(act(-5))).toBe('invalid');
  });
  it('limits come from a row with each value checked, defaults otherwise', () => {
    expect(limitsFrom({ idle_logout_minutes: 10, max_session_days: 30 })).toEqual({ idleMinutes: 10, maxDays: 30 });
    expect(limitsFrom({ idle_logout_minutes: 480, max_session_days: 1 })).toEqual({ idleMinutes: 480, maxDays: 1 });
    expect(limitsFrom({ idle_logout_minutes: 9, max_session_days: 31 })).toEqual(DEFAULT_LIMITS);
    expect(limitsFrom({ idle_logout_minutes: '60', max_session_days: 2.5 })).toEqual(DEFAULT_LIMITS);
    expect(limitsFrom(null)).toEqual(DEFAULT_LIMITS);
  });
});
