import { createHmac, timingSafeEqual } from 'node:crypto';

/** Session cookie names and attributes, shared by the auth routes, the proxy and getSession. */
const ACCESS = 'dp-at';
const REFRESH = 'dp-rt';
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Secure everywhere except local development, where plain http is expected. */
export function cookiesAreSecure(): boolean {
  return process.env.NODE_ENV !== 'development';
}

export function accessCookieName(): string {
  return cookiesAreSecure() ? `__Host-${ACCESS}` : ACCESS;
}

export function refreshCookieName(): string {
  return cookiesAreSecure() ? `__Host-${REFRESH}` : REFRESH;
}

export function cookieOptions(maxAge: number) {
  return { httpOnly: true, sameSite: 'lax' as const, secure: cookiesAreSecure(), path: '/', maxAge };
}

/** Reads the unverified exp claim. Only for deciding whether to refresh; never for trust. */
export function tokenExpiresAt(token: string | undefined | null): number | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const exp = (JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

const START = 'dp-st';
const MIN_SECRET_LENGTH = 32;
const CLOCK_SKEW_SECONDS = 60;

export function startCookieName(): string {
  return cookiesAreSecure() ? `__Host-${START}` : START;
}

/** Server secret that signs the login-time cookie. Throws a generic error when unset or short. */
export function sessionSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < MIN_SECRET_LENGTH) throw new Error('Sign-in is not configured');
  return s;
}

function mac(secret: string, userId: string, sessionId: string, at: number): Buffer {
  // JSON array encoding: no field can bleed into its neighbour.
  return createHmac('sha256', secret).update(`dp-session-start:v2:${JSON.stringify([userId, sessionId, at])}`).digest();
}

/** The Supabase session_id claim of a token. Trust it only for a token Supabase has just issued or verified. */
export function tokenSessionId(token: string | undefined | null): string | null {
  if (!token) return null;
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const id = (JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { session_id?: unknown }).session_id;
    return typeof id === 'string' && ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

const ID = /^[A-Za-z0-9-]{1,64}$/;

/** `userId.sessionId.loginAtSeconds.mac`: the original login, bound to the person and the Supabase session, signed by the server. */
export function signSessionStart(secret: string, userId: string, sessionId: string, atSeconds: number): string {
  return `${userId}.${sessionId}.${atSeconds}.${mac(secret, userId, sessionId, atSeconds).toString('base64url')}`;
}

/**
 * Returns who, which Supabase session and when, if the signature is genuine and the login is no more than 30 days
 * old (or maxAgeSeconds, if shorter), else null. Refreshing tokens keeps session_id and never renews this, and a
 * step-up code keeps the original login time (auth-handlers): only a new sign-in starts the clock again. Callers with a
 * verified token must compare sessionId with it.
 */
export function readSessionStart(
  secret: string,
  value: string | undefined | null,
  nowSeconds: number,
  maxAgeSeconds: number = SESSION_MAX_AGE_SECONDS,
): { userId: string; sessionId: string; at: number } | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const [userId, sessionId, atRaw, macRaw] = parts;
  if (!ID.test(userId) || !ID.test(sessionId) || !/^\d{1,12}$/.test(atRaw)) return null;
  const at = Number(atRaw);
  const given = Buffer.from(macRaw, 'base64url');
  const want = mac(secret, userId, sessionId, at);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  // 30 days is the ceiling whatever is asked; the business's own (shorter) cap is checked by the session policy.
  if (at > nowSeconds + CLOCK_SKEW_SECONDS || nowSeconds - at > Math.min(maxAgeSeconds, SESSION_MAX_AGE_SECONDS)) return null;
  return { userId, sessionId, at };
}
