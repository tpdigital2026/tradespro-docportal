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
