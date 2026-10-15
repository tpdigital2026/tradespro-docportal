import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { accessCookieName, readSessionStart, sessionSecret, startCookieName, tokenSessionId } from './auth-cookies';
import { isDemo } from './demo';
import { demoSession } from './demo-data';
import { anonClient } from './supabase-server';
import { activityCookieName, checkSessionPolicy, DEFAULT_LIMITS, limitsFrom, readActivity, type SessionLimits } from './session-policy';

export type Role = 'owner' | 'staff' | 'tradespro_admin';
export interface Session {
  userId: string;
  tenantId: string;
  role: Role;
  email: string;
  fullName: string;
  businessName: string;
}

const ROLES: ReadonlySet<string> = new Set<Role>(['owner', 'staff', 'tradespro_admin']);

/** The slice of a Supabase client resolveSession needs, so tests can stub it. */
export interface SessionClient {
  auth: { getUser(token: string): Promise<{ data: { user: { id: string } | null }; error: unknown }> };
  from(table: 'profiles' | 'tenant_defaults'): {
    select(cols: string): {
      eq(col: 'id', v: string): { maybeSingle(): Promise<{ data: unknown; error: unknown }> };
      maybeSingle?(): Promise<{ data: unknown; error: unknown }>;
    };
  };
}

/**
 * Verified identity first (getUser asks Supabase to validate the token; the cookie is never trusted
 * on its own), then tenant and role from the person's own active profile row. Row level security
 * only returns a profile for an active person, so a disabled person resolves to null. Nothing here
 * comes from client input other than the token itself.
 */
export async function resolveSession(token: string | undefined, makeClient: (token: string) => SessionClient): Promise<Session | null> {
  return (await resolveSessionAndLimits(token, makeClient))?.session ?? null;
}

/**
 * resolveSession plus the business's session policy (idle minutes, maximum days), read through row level security in
 * parallel with the profile. A failed policy read falls back to the defaults (30 minutes, 7 days) rather than locking
 * everyone out.
 */
export async function resolveSessionAndLimits(token: string | undefined, makeClient: (token: string) => SessionClient): Promise<{ session: Session; limits: SessionLimits } | null> {
  if (!token) return null;
  try {
    const client = makeClient(token);
    const { data, error } = await client.auth.getUser(token);
    if (error || !data?.user?.id) return null;
    const userId = data.user.id;
    const limitsQuery = (async (): Promise<SessionLimits> => {
      try {
        const q = client.from('tenant_defaults').select('idle_logout_minutes, max_session_days');
        const r = q.maybeSingle ? await q.maybeSingle() : { data: null, error: true };
        return r.error ? DEFAULT_LIMITS : limitsFrom(r.data);
      } catch {
        return DEFAULT_LIMITS;
      }
    })();
    const [{ data: row, error: pErr }, limits] = await Promise.all([
      client.from('profiles').select('id, tenant_id, role, full_name, email, tenants(name)').eq('id', userId).maybeSingle(),
      limitsQuery,
    ]);
    if (pErr || !row) return null;
    const p = row as { id?: unknown; tenant_id?: unknown; role?: unknown; full_name?: unknown; email?: unknown; tenants?: unknown };
    const tenant = Array.isArray(p.tenants) ? p.tenants[0] : p.tenants;
    const businessName = (tenant as { name?: unknown } | null | undefined)?.name;
    if (
      p.id !== userId ||
      typeof p.tenant_id !== 'string' ||
      typeof p.role !== 'string' ||
      !ROLES.has(p.role) ||
      typeof p.full_name !== 'string' ||
      typeof p.email !== 'string' ||
      typeof businessName !== 'string'
    ) {
      return null;
    }
    return { session: { userId, tenantId: p.tenant_id, role: p.role as Role, email: p.email, fullName: p.full_name, businessName }, limits };
  } catch {
    // Missing keys, network trouble or a malformed answer all mean "not signed in", never a crash.
    return null;
  }
}

/** `expired`: the person was signed in but the session policy (idle time or the maximum days) has ended it. */
export interface SessionState {
  session: Session | null;
  expired: boolean;
}

async function loadState(): Promise<SessionState> {
  if (isDemo()) return { session: demoSession, expired: false };
  let token: string | undefined;
  let start: string | undefined;
  let activity: string | undefined;
  try {
    const jar = await cookies();
    token = jar.get(accessCookieName())?.value;
    start = jar.get(startCookieName())?.value;
    activity = jar.get(activityCookieName())?.value;
  } catch {
    return { session: null, expired: false };
  }
  const resolved = await resolveSessionAndLimits(token, (t) => anonClient(t) as unknown as SessionClient);
  if (!resolved) return { session: null, expired: false };
  const { session, limits } = resolved;
  // Same caps as the proxy, bound to this person AND this Supabase session (a cookie from another login cannot be
  // replayed), with the business's limits as stored now. Defence in depth: the proxy clears the cookies itself.
  try {
    const secret = sessionSecret();
    const now = Math.floor(Date.now() / 1000);
    const bound = readSessionStart(secret, start, now);
    if (!bound || bound.userId !== session.userId || bound.sessionId !== tokenSessionId(token)) return { session: null, expired: false };
    const verdict = checkSessionPolicy({ start: bound, activity: readActivity(secret, activity), nowSeconds: now, limits });
    if (verdict === 'idle' || verdict === 'expired') return { session: null, expired: true };
    if (verdict !== 'ok') return { session: null, expired: false };
  } catch {
    return { session: null, expired: false };
  }
  return { session, expired: false };
}

/** One lookup per request, however many layouts and pages ask. */
export const getSessionState: () => Promise<SessionState> = cache(loadState);
export const getSession: () => Promise<Session | null> = cache(async () => (await getSessionState()).session);

/** Every (app) page and layout calls this itself: layouts are not a security boundary. */
export async function requireSession(): Promise<Session> {
  const { session, expired } = await getSessionState();
  // An ended session still has its cookies (the proxy may even have refreshed the activity one), so it goes through
  // the route that clears them before the sign-in page says why.
  if (!session) redirect(expired ? '/api/auth/expired' : '/login');
  return session;
}
