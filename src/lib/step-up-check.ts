import { cookies } from 'next/headers';
import { accessCookieName } from './auth-cookies';
import { isDemo } from './demo';
import { anonClient } from './supabase-server';
import { assertRecentStepUp, StepUpRequiredError, type AuthClaims } from '../security/step-up';

/** The slice of Supabase Auth used here. getClaims verifies the token's signature before returning claims. */
export interface ClaimsApi {
  getClaims(token: string): Promise<{ data: { claims?: AuthClaims } | null; error: unknown }>;
}

/**
 * Throws StepUpRequiredError unless the VERIFIED token proves an emailed code was entered in the last
 * 10 minutes. A missing token, a failed verification or an error all count as "not fresh".
 */
export async function requireFreshStepUp(token: string | undefined, api: ClaimsApi, nowSeconds: number): Promise<void> {
  if (!token) throw new StepUpRequiredError();
  let claims: AuthClaims | undefined;
  try {
    const { data, error } = await api.getClaims(token);
    if (error || !data) throw new StepUpRequiredError();
    claims = data.claims;
  } catch {
    throw new StepUpRequiredError();
  }
  assertRecentStepUp(claims, nowSeconds);
}

/** For the request being served. Demo mode has no real login, so it counts as fresh there. */
export async function requireFreshStepUpForRequest(): Promise<void> {
  if (isDemo()) return;
  const jar = await cookies();
  await requireFreshStepUp(jar.get(accessCookieName())?.value, anonClient().auth as unknown as ClaimsApi, Math.floor(Date.now() / 1000));
}

export { StepUpRequiredError };
