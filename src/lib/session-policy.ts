import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookiesAreSecure } from './auth-cookies';
import { IDLE_MINUTES, MAX_SESSION_DAYS, inRange, type SessionLimits } from './session-policy-limits';

/**
 * Per-business session policy: sign out after a spell of no activity, and a hard cap on how long a sign-in lasts.
 *
 * - `idleMinutes` (10 to 480, default 30): no authenticated request for that long and the session is cleared.
 * - `maxDays` (1 to 30, default 7): days since the email code was entered (the dp-st login time). A step-up code never
 *   moves the login time on (auth-handlers keeps the original), so this cap always counts from the first sign-in.
 *
 * The proxy cannot read the database on every request, so the activity cookie (dp-la) carries the limits that applied
 * when it was issued, signed with the session secret under its own derived key and bound to the person and the
 * Supabase session. The proxy enforces those and refreshes the time. getSession enforces the limits stored in the
 * database now, against the activity time the browser sent (the proxy never rewrites the request's copy), so a
 * stricter setting applies to everyone at once; a looser one applies to others from their next sign-in.
 */
export { IDLE_MINUTES, MAX_SESSION_DAYS, DEFAULT_LIMITS, limitsFrom, type SessionLimits } from './session-policy-limits';
export { SESSION_EXPIRED_MESSAGE } from './signed-out';
/** The proxy rewrites the activity cookie only when the stored time is at least this old, to keep headers quiet. */
export const ACTIVITY_REFRESH_SECONDS = 60;

const ACTIVITY = 'dp-la';
export function activityCookieName(): string {
  return cookiesAreSecure() ? `__Host-${ACTIVITY}` : ACTIVITY;
}

export interface Activity extends SessionLimits {
  userId: string;
  sessionId: string;
  /** Seconds since the epoch of the last authenticated request. */
  lastAt: number;
}

const ID = /^[A-Za-z0-9-]{1,64}$/;
const CLOCK_SKEW_SECONDS = 60;

// Domain separation from the login-time cookie: its own key derived from the secret, and its own label.
const activityKey = (secret: string) => createHmac('sha256', secret).update('dp-activity-key:v1').digest();
function mac(secret: string, a: Activity): Buffer {
  return createHmac('sha256', activityKey(secret))
    .update(`dp-activity:v1:${JSON.stringify([a.userId, a.sessionId, a.lastAt, a.idleMinutes, a.maxDays])}`)
    .digest();
}

/** `userId.sessionId.lastAt.idleMinutes.maxDays.mac` */
export function signActivity(secret: string, a: Activity): string {
  if (!ID.test(a.userId) || !ID.test(a.sessionId) || !Number.isSafeInteger(a.lastAt) || a.lastAt < 0) throw new Error('Invalid activity');
  if (!inRange(a.idleMinutes, IDLE_MINUTES) || !inRange(a.maxDays, MAX_SESSION_DAYS)) throw new Error('Invalid limits');
  return `${a.userId}.${a.sessionId}.${a.lastAt}.${a.idleMinutes}.${a.maxDays}.${mac(secret, a).toString('base64url')}`;
}

/** The signed activity, or null when it is missing, malformed, out of range or not signed with this secret. */
export function readActivity(secret: string, value: string | undefined | null): Activity | null {
  if (!value || value.length > 400) return null;
  const parts = value.split('.');
  if (parts.length !== 6) return null;
  const [userId, sessionId, lastRaw, idleRaw, maxRaw, macRaw] = parts;
  if (!ID.test(userId) || !ID.test(sessionId) || !/^\d{1,12}$/.test(lastRaw) || !/^\d{1,3}$/.test(idleRaw) || !/^\d{1,2}$/.test(maxRaw)) return null;
  const a: Activity = { userId, sessionId, lastAt: Number(lastRaw), idleMinutes: Number(idleRaw), maxDays: Number(maxRaw) };
  if (!inRange(a.idleMinutes, IDLE_MINUTES) || !inRange(a.maxDays, MAX_SESSION_DAYS)) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(macRaw)) return null;
  const given = Buffer.from(macRaw, 'base64url');
  if (given.toString('base64url') !== macRaw) return null; // canonical only: no spare bits in the last character
  const want = mac(secret, a);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  return a;
}

export type PolicyVerdict = 'ok' | 'idle' | 'expired' | 'invalid';

/**
 * The decision, given the verified login-time cookie and activity cookie. Both must name the same person and Supabase
 * session. `limits` are the ones to enforce: the cookie's own in the proxy, the database's in getSession.
 * 'idle' and 'expired' end the session with the friendly notice; 'invalid' (missing, forged, someone else's) too.
 */
export function checkSessionPolicy(args: {
  start: { userId: string; sessionId: string; at: number } | null;
  activity: Activity | null;
  nowSeconds: number;
  limits: SessionLimits;
}): PolicyVerdict {
  const { start, activity, nowSeconds, limits } = args;
  if (!start || !activity) return 'invalid';
  if (activity.userId !== start.userId || activity.sessionId !== start.sessionId) return 'invalid';
  if (activity.lastAt > nowSeconds + CLOCK_SKEW_SECONDS) return 'invalid';
  if (nowSeconds - start.at > limits.maxDays * 86400) return 'expired';
  if (nowSeconds - activity.lastAt > limits.idleMinutes * 60) return 'idle';
  return 'ok';
}
