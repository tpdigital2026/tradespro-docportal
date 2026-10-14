import { after, NextResponse } from 'next/server';
import { z } from 'zod';
import { hashEmail, requestCodeWithGuard, verifyWithGuard } from '../security/login-guard';
import { accessCookieName, cookieOptions, refreshCookieName, sessionSecret, SESSION_MAX_AGE_SECONDS, signSessionStart, startCookieName, tokenExpiresAt, tokenSessionId } from './auth-cookies';
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
const verifySchema = z.object({ email: emailSchema, code: z.string().trim() });

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

  const started = Date.now();
  const respond = (res: Response) => atLeast(started, deps.minDurationMs, res);
  // A malformed code gets the same answer as a wrong one and never reaches the guard or Supabase.
  if (!/^\d{6}$/.test(code)) return respond(json(401, false, MSG_BAD_CODE));

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
  } catch (e) {
    if (!isBusy(e)) logFailure('verify', e);
    return respond(json(503, false, MSG_BUSY));
  } finally {
    await db?.end().catch(() => undefined);
  }

  const s = session as { access_token: string; refresh_token: string };
  const res = json(200, true, 'Signed in.');
  res.cookies.set(accessCookieName(), s.access_token, cookieOptions(SESSION_MAX_AGE_SECONDS));
  res.cookies.set(refreshCookieName(), s.refresh_token, cookieOptions(SESSION_MAX_AGE_SECONDS));
  res.cookies.set(startCookieName(), signSessionStart(secret, userId, sessionId, Math.floor(Date.now() / 1000)), cookieOptions(SESSION_MAX_AGE_SECONDS));
  return respond(res);
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
  const res = NextResponse.redirect(new URL('/login', req.url), 303);
  for (const name of [accessCookieName(), refreshCookieName(), startCookieName()]) {
    res.cookies.set(name, '', { ...cookieOptions(0), maxAge: 0, expires: new Date(0) });
  }
  res.headers.set('Cache-Control', 'no-store');
  return res;
}
