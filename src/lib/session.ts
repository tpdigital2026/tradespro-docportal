import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { accessCookieName, readSessionStart, sessionSecret, startCookieName } from './auth-cookies';
import { isDemo } from './demo';
import { demoSession } from './demo-data';
import { anonClient } from './supabase-server';

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
  from(table: 'profiles'): {
    select(cols: string): {
      eq(col: 'id', v: string): { maybeSingle(): Promise<{ data: unknown; error: unknown }> };
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
  if (!token) return null;
  try {
    const client = makeClient(token);
    const { data, error } = await client.auth.getUser(token);
    if (error || !data?.user?.id) return null;
    const userId = data.user.id;
    const { data: row, error: pErr } = await client.from('profiles').select('id, tenant_id, role, full_name, email, tenants(name)').eq('id', userId).maybeSingle();
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
    return { userId, tenantId: p.tenant_id, role: p.role as Role, email: p.email, fullName: p.full_name, businessName };
  } catch {
    // Missing keys, network trouble or a malformed answer all mean "not signed in", never a crash.
    return null;
  }
}

async function loadSession(): Promise<Session | null> {
  if (isDemo()) return demoSession;
  let token: string | undefined;
  let start: string | undefined;
  try {
    const jar = await cookies();
    token = jar.get(accessCookieName())?.value;
    start = jar.get(startCookieName())?.value;
  } catch {
    return null;
  }
  const session = await resolveSession(token, (t) => anonClient(t) as unknown as SessionClient);
  if (!session) return null;
  // Same 30 day cap as the proxy, bound to this person. Defence in depth: the proxy clears the cookies.
  try {
    if (readSessionStart(sessionSecret(), start, Math.floor(Date.now() / 1000)) !== session.userId) return null;
  } catch {
    return null;
  }
  return session;
}

/** One lookup per request, however many layouts and pages ask. */
export const getSession: () => Promise<Session | null> = cache(loadSession);

/** Every (app) page and layout calls this itself: layouts are not a security boundary. */
export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect('/login');
  return s;
}
