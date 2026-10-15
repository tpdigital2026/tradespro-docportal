import { after, NextResponse } from 'next/server';
import { z } from 'zod';
import { hashEmail, requestCodeWithGuard, verifyWithGuard } from '../security/login-guard';
import { accessCookieName, cookieOptions, readSessionStart, refreshCookieName, sessionSecret, SESSION_MAX_AGE_SECONDS, signSessionStart, startCookieName, tokenExpiresAt, tokenSessionId } from './auth-cookies';
import { activityCookieName, checkSessionPolicy, DEFAULT_LIMITS, isActivityCookieName, limitsFrom, readActivity, signActivity, type SessionLimits } from './session-policy';
import { OTP_PATTERN } from './otp';
import { getClientIp } from './client-ip';
import { isSameOrigin } from './same-origin';
import { anonClient, loginPepper, openGuardConnection, revokeByRefreshToken, revokeSession, type GuardDb } from './supabase-server';

/** The slice of Supabase Auth the login routes use, so tests can stub it. */
export interface AuthApi {
  signInWithOtp(args: { email: string; options: { shouldCreateUser: false } }): Promise<{ error: unknown }>;
  verifyOtp(args: { email: string; token: string; type: 'email' }): Promise<{
    data: { session: { access_token: string; refresh_token: string } | null; user: { id: string } | null };
    error: unknown;
  }>;
}

export interface AuthDeps {
  openDb(): Promise<GuardDb>;
  auth(): AuthApi;
  pepper(): string;
  /** Every guarded response takes at least this long, so unknown and known emails look alike. */
  minDurationMs: number;
  revoke(accessToken: string): Promise<void>;
  revokeByRefreshToken(refreshToken: string): Promise<void>;
  /** Secret that signs the login-time cookie; throws when missing. */
  sessionSecret(): string;
  /** Runs work after the response has been sent (Next's after()). */
  defer(task: () => Promise<void>): void;
}

export const realDeps: AuthDeps = {
  openDb: openGuardConnection,
  auth: () => anonClient().auth as unknown as AuthApi,
  pepper: loginPepper,
  minDurationMs: 700,
  revoke: revokeSession,
  revokeByRefreshToken,
  sessionSecret,
  defer: (task) => after(task),
};

// One fixed text per outcome. Nothing here varies with the email, its status or the lock state.
const MSG_SENT = 'If that email is registered, a code is on its way.';
const MSG_BAD_CODE = 'That code did not work. Check it and try again, or ask for a new one.';
const MSG_BUSY = 'Please try again shortly.';
const MSG_RATE = 'Too many requests. Please wait a few minutes and try again.';
const MSG_INVALID = 'Please check what you entered and try again.';
const MSG_FORBIDDEN = 'Request not allowed.';

const json = (status: number, ok: boolean, message: string, headers?: Record<string, string>) =>
  NextResponse.json({ ok, message }, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const requestSchema = z.object({ email: emailSchema });
// stepUp: sent only by the fresh-code step inside the app (components/StepUp.tsx), never by the sign-in pages.
const verifySchema = z.object({ email: emailSchema, code: z.string().trim(), stepUp: z.boolean().optional() });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function atLeast<T>(startedAt: number, minMs: number, value: T): Promise<T> {
  const wait = minMs - (Date.now() - startedAt);
  if (wait > 0) await sleep(wait);
  return value;
}

function isBusy(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'LOGIN_GUARD_BUSY' || code === '55P03';
}

function logFailure(where: string, e: unknown): void {
  // Name and code only. Never the message: it can carry an email address or connection details.
  const name = e instanceof Error ? e.name : 'Error';
  const code = (e as { code?: unknown } | null)?.code;
  console.error(`auth ${where} failed: ${name}${typeof code === 'string' && /^[\w-]{1,32}$/.test(code) ? ` ${code}` : ''}`);
}

async function readJson(req: Request): Promise<unknown> {
  if (!(req.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return undefined;
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function preflight(req: Request) {
  return isSameOrigin(req) ? null : json(403, false, MSG_FORBIDDEN);
}

export async function handleRequestCode(req: Request, deps: AuthDeps = realDeps): Promise<Response> {
  const forbidden = preflight(req);
  if (forbidden) return forbidden;
  const parsed = requestSchema.safeParse(await readJson(req));
  if (!parsed.success) return json(400, false, MSG_INVALID);
  const { email } = parsed.data;

  const started = Date.now();
  const respond = (res: Response) => atLeast(started, deps.minDurationMs, res);
  // Configuration problems are checked up front, for every email alike, so a missing key
  // can never make known and unknown emails answer differently.
  let auth: AuthApi;
  let emailHash: string;
  try {
    auth = deps.auth();
    emailHash = hashEmail(email, deps.pepper());
    deps.sessionSecret(); // no code is emailed when verify could not complete the login
  } catch (e) {
    logFailure('request-code config', e);
    return respond(json(503, false, MSG_BUSY));
  }

  let active = false;
  let db: GuardDb | null = null;
  try {
    db = await deps.openDb();
    const guard = await requestCodeWithGuard(db, { emailHash, ip: getClientIp(req.headers) });
    if (guard.outcome === 'blocked') return respond(json(429, false, MSG_RATE));
    const r = await db.query(`select 1 from public.profiles where email = $1 and disabled_at is null`, [email]);
    active = r.rows.length > 0;
  } catch (e) {
    if (!isBusy(e)) logFailure('request-code', e);
    return respond(json(503, false, MSG_BUSY));
  } finally {
    await db?.end().catch(() => undefined);
  }

  // The send is the one step that only happens for registered emails and takes network time, so it
  // runs after the response. The awaited work (guard, profile lookup, floor) is the same either way.
  if (active) {
    try {
      deps.defer(async () => {
        try {
          const { error } = await auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
          if (error) logFailure('request-code send', error);
        } catch (e) {
          logFailure('request-code send', e);
        }
      });
    } catch (e) {
      logFailure('request-code defer', e); // never changes the response for known emails
    }
  }
  return respond(json(200, true, MSG_SENT));
}

export async function handleVerify(req: Request, deps: AuthDeps = realDeps): Promise<Response> {
  const forbidden = preflight(req);
  if (forbidden) return forbidden;
  const parsed = verifySchema.safeParse(await readJson(req));
  if (!parsed.success) return json(400, false, MSG_INVALID);
  const { email, code } = parsed.data;
  const stepUp = parsed.data.stepUp === true;

  const started = Date.now();
  const respond = (res: Response) => atLeast(started, deps.minDurationMs, res);
  // A malformed code gets the same answer as a wrong one and never reaches the guard or Supabase.
  if (!OTP_PATTERN.test(code)) return respond(json(401, false, MSG_BAD_CODE));

  let auth: AuthApi;
  let emailHash: string;
  let secret: string;
  try {
    auth = deps.auth();
    emailHash = hashEmail(email, deps.pepper());
    secret = deps.sessionSecret();
  } catch (e) {
    logFailure('verify config', e);
    return respond(json(503, false, MSG_BUSY));
  }

  let session: { access_token: string; refresh_token: string } | null = null;
  let userId = '';
  let sessionId = '';
  let limits: SessionLimits = DEFAULT_LIMITS;
  let db: GuardDb | null = null;
  try {
    db = await deps.openDb();
    const conn = db;
    const result = await verifyWithGuard(conn, {
      emailHash,
      ip: getClientIp(req.headers),
      checkCode: async () => {
        const { data, error } = await auth.verifyOtp({ email, token: code, type: 'email' });
        if (error || !data?.session || !data.user) return false;
        // A valid code for a disabled or removed person is a failed login like any other.
        const p = await conn.query(`select 1 from public.profiles where id = $1 and disabled_at is null`, [data.user.id]);
        const sid = tokenSessionId(data.session.access_token);
        if (p.rows.length === 0 || !sid) {
          // The code was valid, so Supabase made a session. End it; the caller only sees a failed login.
          await deps.revoke(data.session.access_token).catch(() => undefined);
          return false;
        }
        session = data.session;
        userId = data.user.id;
        sessionId = sid;
        return true;
      },
    });
    if (result.outcome !== 'verified' || !session) return respond(json(401, false, MSG_BAD_CODE));
    // The business's session policy goes into the activity cookie, so the proxy can enforce it without a lookup.
    try {
      const lim = await conn.query(
        `select idle_logout_minutes, max_session_days from public.tenant_defaults where tenant_id = (select p.tenant_id from public.profiles p where p.id = $1)`,
        [userId],
      );
      limits = limitsFrom(lim.rows[0]);
    } catch (e) {
      logFailure('verify limits', e); // the defaults apply; never a reason to refuse a good code
    }
  } catch (e) {
    if (!isBusy(e)) logFailure('verify', e);
    return respond(json(503, false, MSG_BUSY));
  } finally {
    await db?.end().catch(() => undefined);
  }

  const s = session as { access_token: string; refresh_token: string };
  const now = Math.floor(Date.now() / 1000);
  const res = json(200, true, 'Signed in.');
  res.cookies.set(accessCookieName(), s.access_token, cookieOptions(SESSION_MAX_AGE_SECONDS));
  res.cookies.set(refreshCookieName(), s.refresh_token, cookieOptions(SESSION_MAX_AGE_SECONDS));
  res.cookies.set(startCookieName(), signSessionStart(secret, userId, sessionId, loginTimeFor(req, secret, userId, now, limits, stepUp)), cookieOptions(SESSION_MAX_AGE_SECONDS));
  // Earlier sessions' activity cookies go; the new session gets its own.
  for (const name of cookieNames(req)) if (isActivityCookieName(name)) res.cookies.set(name, '', { ...cookieOptions(0), maxAge: 0, expires: new Date(0) });
  res.cookies.set(activityCookieName(sessionId), signActivity(secret, { userId, sessionId, lastAt: now, ...limits }), cookieOptions(SESSION_MAX_AGE_SECONDS));
  return respond(res);
}

/** One cookie's value from a request's Cookie header, or undefined. */
export function cookieFrom(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** Every cookie name in a request's Cookie header. */
export function cookieNames(req: Request): string[] {
  return (req.headers.get('cookie') ?? '').split(';').map((p) => p.slice(0, Math.max(0, p.indexOf('='))).trim()).filter(Boolean);
}

/**
 * The login time to sign into the new dp-st. A step-up (the fresh-code step inside the app, while the person is STILL
 * signed in) keeps the original login time, so a fresh code can never stretch the session past the business's maximum.
 * "Still signed in" means all of: the request says it is a step-up; a genuine login-time cookie for this person; that
 * session's genuine activity cookie; and the session policy (the stricter of the cookie's limits and the business's
 * limits now) says the session has not ended. Anything else (a sign-in from /login or /{slug}, a session that went idle
 * or passed its maximum, a forged or someone else's cookie) is a new sign-in that starts now.
 */
export function loginTimeFor(req: Request, secret: string, userId: string, now: number, limits: SessionLimits, stepUp = false): number {
  if (!stepUp) return now;
  const prior = readSessionStart(secret, cookieFrom(req, startCookieName()), now, limits.maxDays * 86400);
  if (!prior || prior.userId !== userId) return now;
  const activity = readActivity(secret, cookieFrom(req, activityCookieName(prior.sessionId)));
  if (!activity) return now;
  const strictest = { idleMinutes: Math.min(activity.idleMinutes, limits.idleMinutes), maxDays: Math.min(activity.maxDays, limits.maxDays) };
  return checkSessionPolicy({ start: prior, activity, nowSeconds: now, limits: strictest }) === 'ok' ? prior.at : now;
}

export async function handleLogout(
  req: Request,
  tokens: { access?: string; refresh?: string },
  deps: AuthDeps = realDeps,
): Promise<Response> {
  const forbidden = preflight(req);
  if (forbidden) return forbidden;
  try {
    const exp = tokenExpiresAt(tokens.access);
    const accessLive = Boolean(tokens.access) && exp !== null && exp > Date.now() / 1000;
    if (tokens.access && accessLive) await deps.revoke(tokens.access);
    else if (tokens.refresh) await deps.revokeByRefreshToken(tokens.refresh);
  } catch {
    /* best effort; the cookies are cleared either way */
  }
  return clearAll(req, NextResponse.redirect(new URL('/login', req.url), 303));
}

function clearAll(req: Request, res: NextResponse): NextResponse {
  for (const name of [accessCookieName(), refreshCookieName(), startCookieName(), ...cookieNames(req).filter(isActivityCookieName)]) {
    res.cookies.set(name, '', { ...cookieOptions(0), maxAge: 0, expires: new Date(0) });
  }
  res.headers.set('Cache-Control', 'no-store');
  return res;
}

/**
 * Where getSession sends a session the policy has ended (idle too long, or past the maximum days): the cookies are
 * cleared and the sign-in page says why. A GET, because it is reached by a redirect; all it can do is sign the visitor
 * out, which is also all a forged link to it could do.
 */
export function handleExpired(req: Request): Response {
  return clearAll(req, NextResponse.redirect(new URL('/login?notice=signed-out', req.url), 303));
}
