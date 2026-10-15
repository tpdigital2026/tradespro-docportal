import { NextResponse, type NextRequest } from 'next/server';
import { accessCookieName, cookieOptions, readSessionStart, refreshCookieName, SESSION_MAX_AGE_SECONDS, startCookieName, tokenExpiresAt } from './auth-cookies';
import { isDemo } from './demo';
import { isValidSlug } from './slug';
import { isSameOrigin, SAFE_METHODS } from './same-origin';
import { ACTIVITY_REFRESH_SECONDS, activityCookieName, checkSessionPolicy, isActivityCookieName, readActivity, SESSION_EXPIRED_MESSAGE, signActivity, type Activity, type PolicyVerdict } from './session-policy';

export interface Refreshed {
  access_token: string;
  refresh_token: string;
}
export interface GuardDeps {
  /** Returns null only when Supabase rejected the refresh token. Network or config trouble must throw. */
  refresh(refreshToken: string): Promise<Refreshed | null>;
  nowSeconds(): number;
  /** Throws when the signing secret is missing. */
  sessionSecret(): string;
}

// NEW TOP-LEVEL ROUTES MUST BE ADDED TO RESERVED_SLUGS (src/lib/slug.ts) and to the tenants_slug_not_reserved
// check in a new migration; tests/unit/slug-reserved.test.ts fails if a routable src/app segment is missing.
// A single lower-case segment that is not a reserved word is a business's public sign-in address (/fjc).
// The page itself shows the plain sign-in for an unknown one, and sends a signed-in person home.
const isSigninSlug = (path: string) => /^\/[^/]+$/.test(path) && isValidSlug(path.slice(1));
// The maintenance cron is called by the scheduler with its own bearer secret, never a session; the route checks it.
const CRON = (path: string) => path === '/api/cron/maintenance';
const PUBLIC = (path: string) => path === '/login' || path === '/api/auth' || path.startsWith('/api/auth/') || isSigninSlug(path) || CRON(path);
const REFRESH_SKEW_SECONDS = 30;

const expire = (res: NextResponse, name: string) => res.cookies.set(name, '', { ...cookieOptions(0), maxAge: 0, expires: new Date(0) });

/** Clears the session cookies, and every activity cookie the browser sent (they are named per Supabase session). */
function clearCookies(res: NextResponse, req: NextRequest) {
  for (const name of [accessCookieName(), refreshCookieName(), startCookieName()]) expire(res, name);
  for (const c of req.cookies.getAll()) if (isActivityCookieName(c.name)) expire(res, c.name);
  return res;
}

/** The session-policy verdict for the cookies this request carries, with the activity cookie's own limits. */
function policyOf(req: NextRequest, secret: string, now: number): { verdict: PolicyVerdict; activity: Activity | null; sessionId: string | null } {
  const start = readSessionStart(secret, req.cookies.get(startCookieName())?.value, now);
  if (!start) return { verdict: 'invalid', activity: null, sessionId: null };
  const activity = readActivity(secret, req.cookies.get(activityCookieName(start.sessionId))?.value);
  return { verdict: checkSessionPolicy({ start, activity, nowSeconds: now, limits: activity ?? { idleMinutes: 0, maxDays: 0 } }), activity, sessionId: start.sessionId };
}

const SESSION_COOKIES = (req: NextRequest) => Boolean(req.cookies.get(accessCookieName()) || req.cookies.get(refreshCookieName()) || req.cookies.get(startCookieName()));

function deny(req: NextRequest, clear: boolean, signedOut = false) {
  const path = req.nextUrl.pathname;
  const res =
    path.startsWith('/api/')
      ? NextResponse.json({ ok: false, message: signedOut ? `${SESSION_EXPIRED_MESSAGE} Please sign in again.` : 'Please sign in.' }, { status: 401 })
      : NextResponse.redirect(new URL(signedOut ? '/login?notice=signed-out' : '/login', req.url));
  return clear ? clearCookies(res, req) : res;
}

/**
 * Optimistic gate in front of every route: deny by default, with /login and /api/auth/* public.
 * It only checks that a session cookie exists and refreshes an expired access token. It is not
 * the security boundary; getSession (verified with Supabase) is, in every page and route.
 */
export async function guardRequest(req: NextRequest, deps: GuardDeps): Promise<NextResponse> {
  if (!SAFE_METHODS.has(req.method) && !isSameOrigin(req)) {
    return NextResponse.json({ ok: false, message: 'Request not allowed.' }, { status: 403 });
  }
  const path = req.nextUrl.pathname;
  if (isDemo()) return NextResponse.next();
  if (PUBLIC(path)) {
    // A sign-in page reached with the cookies of a session that has ended (idle, past the maximum, forged): clear
    // them, so the sign-in that follows starts a new session rather than looking like a step-up of the old one.
    if ((path === '/login' || isSigninSlug(path)) && SESSION_COOKIES(req)) {
      let secret: string | null = null;
      try {
        secret = deps.sessionSecret();
      } catch {
        secret = null;
      }
      if (secret && policyOf(req, secret, deps.nowSeconds()).verdict !== 'ok') return clearCookies(NextResponse.next(), req);
    }
    return NextResponse.next();
  }

  const access = req.cookies.get(accessCookieName())?.value;
  const refresh = req.cookies.get(refreshCookieName())?.value;

  // The 30 day ceiling: the signed login-time cookie must be genuine and recent. Token refreshes never
  // renew it. Then the business's session policy: idle time and its own (shorter) cap, from the signed
  // activity cookie, which must belong to the same person and Supabase session.
  let touched: { name: string; value: string } | null = null;
  if (access || refresh) {
    let secret: string;
    try {
      secret = deps.sessionSecret();
    } catch {
      return deny(req, false);
    }
    const now = deps.nowSeconds();
    const p = policyOf(req, secret, now);
    if (p.verdict !== 'ok') return deny(req, true, p.verdict === 'idle' || p.verdict === 'expired');
    // Activity is recorded on the response only. The request keeps the time the browser sent, so getSession can
    // check it against the limits in the database now. The cookie written is the one named for THIS request's
    // session, so a request that was in flight across a step-up can never overwrite the new session's cookie.
    const a = p.activity as Activity;
    if (now - a.lastAt >= ACTIVITY_REFRESH_SECONDS) touched = { name: activityCookieName(a.sessionId), value: signActivity(secret, { ...a, lastAt: now }) };
  }
  const touch = (res: NextResponse) => {
    if (touched) res.cookies.set(touched.name, touched.value, cookieOptions(SESSION_MAX_AGE_SECONDS));
    return res;
  };
  const exp = tokenExpiresAt(access);
  if (access && exp !== null && exp > deps.nowSeconds() + REFRESH_SKEW_SECONDS) return touch(NextResponse.next());
  if (!refresh) return deny(req, Boolean(access));

  let fresh: Refreshed | null = null;
  try {
    fresh = await deps.refresh(refresh);
  } catch {
    // Network or configuration trouble: keep the cookies so the person is not logged out by an outage.
    return deny(req, false);
  }
  if (!fresh) return deny(req, true);

  // Make the new token visible to this request's server code as well as the browser.
  req.cookies.set(accessCookieName(), fresh.access_token);
  req.cookies.set(refreshCookieName(), fresh.refresh_token);
  const res = NextResponse.next({ request: { headers: new Headers(req.headers) } });
  res.cookies.set(accessCookieName(), fresh.access_token, cookieOptions(SESSION_MAX_AGE_SECONDS));
  res.cookies.set(refreshCookieName(), fresh.refresh_token, cookieOptions(SESSION_MAX_AGE_SECONDS));
  return touch(res);
}

/**
 * True only when Supabase answered the refresh with a 4xx that means "this refresh token is no good".
 * 429 is rate limiting, and anything else (5xx, no status, network) is an outage: neither may log anyone out.
 */
export function refreshTokenRejected(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 429;
}
