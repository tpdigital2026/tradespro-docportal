import { NextResponse, type NextRequest } from 'next/server';
import { accessCookieName, cookieOptions, refreshCookieName, SESSION_MAX_AGE_SECONDS, tokenExpiresAt } from './auth-cookies';
import { isDemo } from './demo';
import { isSameOrigin, SAFE_METHODS } from './same-origin';

export interface Refreshed {
  access_token: string;
  refresh_token: string;
}
export interface GuardDeps {
  refresh(refreshToken: string): Promise<Refreshed | null>;
  nowSeconds(): number;
}

const PUBLIC = (path: string) => path === '/login' || path === '/api/auth' || path.startsWith('/api/auth/');
const REFRESH_SKEW_SECONDS = 30;

function clearCookies(res: NextResponse) {
  for (const name of [accessCookieName(), refreshCookieName()]) {
    res.cookies.set(name, '', { ...cookieOptions(0), maxAge: 0, expires: new Date(0) });
  }
  return res;
}

function deny(req: NextRequest, clear: boolean) {
  const path = req.nextUrl.pathname;
  const res =
    path.startsWith('/api/')
      ? NextResponse.json({ ok: false, message: 'Please sign in.' }, { status: 401 })
      : NextResponse.redirect(new URL('/login', req.url));
  return clear ? clearCookies(res) : res;
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
  if (PUBLIC(path) || isDemo()) return NextResponse.next();

  const access = req.cookies.get(accessCookieName())?.value;
  const refresh = req.cookies.get(refreshCookieName())?.value;
  const exp = tokenExpiresAt(access);
  if (access && exp !== null && exp > deps.nowSeconds() + REFRESH_SKEW_SECONDS) return NextResponse.next();
  if (!refresh) return deny(req, Boolean(access));

  let fresh: Refreshed | null = null;
  try {
    fresh = await deps.refresh(refresh);
  } catch {
    fresh = null;
  }
  if (!fresh) return deny(req, true);

  // Make the new token visible to this request's server code as well as the browser.
  req.cookies.set(accessCookieName(), fresh.access_token);
  req.cookies.set(refreshCookieName(), fresh.refresh_token);
  const res = NextResponse.next({ request: { headers: new Headers(req.headers) } });
  res.cookies.set(accessCookieName(), fresh.access_token, cookieOptions(SESSION_MAX_AGE_SECONDS));
  res.cookies.set(refreshCookieName(), fresh.refresh_token, cookieOptions(SESSION_MAX_AGE_SECONDS));
  return res;
}
