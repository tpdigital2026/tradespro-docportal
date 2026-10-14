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

function mac(secret: string, userId: string, at: number): Buffer {
  return createHmac('sha256', secret).update(`dp-session-start:${userId}:${at}`).digest();
}

/** `userId.loginAtSeconds.mac`: the original login time, bound to the person, signed by the server. */
export function signSessionStart(secret: string, userId: string, atSeconds: number): string {
  return `${userId}.${atSeconds}.${mac(secret, userId, atSeconds).toString('base64url')}`;
}

/**
 * Returns the person the cookie was issued to if the signature is genuine and the login is no more
 * than 30 days old, else null. Refreshing tokens never renews this: only a fresh email code does.
 */
export function readSessionStart(secret: string, value: string | undefined | null, nowSeconds: number): string | null {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [userId, atRaw, macRaw] = parts;
  if (!userId || !/^\d{1,12}$/.test(atRaw)) return null;
  const at = Number(atRaw);
  const given = Buffer.from(macRaw, 'base64url');
  const want = mac(secret, userId, at);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  if (at > nowSeconds + CLOCK_SKEW_SECONDS || nowSeconds - at > SESSION_MAX_AGE_SECONDS) return null;
  return userId;
}
