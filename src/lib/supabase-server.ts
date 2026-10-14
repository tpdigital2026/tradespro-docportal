import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { connect } from '../db/connect';
import type { Db } from '../security/login-guard';

/** Thrown when Supabase keys are missing. The message is generic and safe to log. */
export class AuthNotConfiguredError extends Error {
  constructor() {
    super('Sign-in is not configured');
    this.name = 'AuthNotConfiguredError';
  }
}

export function supabaseConfig(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) throw new AuthNotConfiguredError();
  return { url, anonKey };
}

const STATELESS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } } as const;

/** Anon-key client that keeps no state between calls. With a token, requests run as that user (RLS applies). */
export function anonClient(accessToken?: string): SupabaseClient {
  const { url, anonKey } = supabaseConfig();
  return createClient(url, anonKey, {
    ...STATELESS,
    ...(accessToken ? { global: { headers: { Authorization: `Bearer ${accessToken}` } } } : {}),
  });
}

export function loginPepper(): string {
  const p = process.env.LOGIN_PEPPER;
  if (!p) throw new AuthNotConfiguredError();
  return p;
}

export type GuardDb = Db & { end(): Promise<void> };

/**
 * A dedicated single connection for the login guards (never a pool: the advisory lock only holds on
 * one connection). Idle-in-transaction is capped so a stuck request cannot hold the per-email lock.
 */
export async function openGuardConnection(): Promise<GuardDb> {
  const c = await connect();
  try {
    await c.query(`set idle_in_transaction_session_timeout = '20s'`);
    await c.query(`set statement_timeout = '10s'`);
  } catch (e) {
    await c.end().catch(() => undefined);
    throw e;
  }
  return c;
}

/** Best-effort revoke of one session at Supabase on logout. Never throws. */
export async function revokeSession(accessToken: string): Promise<void> {
  try {
    const { url, anonKey } = supabaseConfig();
    await fetch(`${url}/auth/v1/logout?scope=local`, {
      method: 'POST',
      headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* cookies are cleared regardless */
  }
}

/** Best-effort sign-out when only a refresh token is left (the access token has expired). Never throws. */
export async function revokeByRefreshToken(refreshToken: string): Promise<void> {
  try {
    const { data } = await anonClient().auth.refreshSession({ refresh_token: refreshToken });
    if (data.session) await revokeSession(data.session.access_token);
  } catch {
    /* cookies are cleared regardless */
  }
}
