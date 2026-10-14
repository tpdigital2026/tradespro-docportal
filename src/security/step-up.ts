export const STEP_UP_MAX_AGE_SECONDS = 600;
const CLOCK_SKEW_SECONDS = 60;
const MAX_ENTRIES_SCANNED = 20;
// GoTrue authentication method names: 'otp' is an emailed code, 'magiclink' is an emailed link.
const CODE_METHODS = new Set(['otp', 'magiclink']);

export class StepUpRequiredError extends Error {
  constructor() {
    super('Please confirm with a fresh email code to continue');
    this.name = 'StepUpRequiredError';
  }
}

export interface AuthClaims {
  amr?: { method: string; timestamp: number }[];
}

/**
 * Sensitive actions need an emailed code entered in the last 10 minutes.
 *
 * Callers MUST pass claims taken from a verified JWT (getUser(), or a checked signature), never from
 * a decoded-only cookie or getSession(). The amr timestamps are the original sign-in time of each
 * method, so refreshing a token cannot renew a step-up.
 *
 * Whatever the input looks like, this either returns or throws StepUpRequiredError, never a TypeError.
 */
export function assertRecentStepUp(claims: AuthClaims | null | undefined, nowSeconds: number, maxAgeSeconds = STEP_UP_MAX_AGE_SECONDS): void {
  const amr: unknown = claims?.amr;
  let recent = false;
  if (Array.isArray(amr)) {
    for (const entry of amr.slice(0, MAX_ENTRIES_SCANNED) as unknown[]) {
      if (!entry || typeof entry !== 'object') continue;
      const { method, timestamp } = entry as { method?: unknown; timestamp?: unknown };
      if (typeof method !== 'string' || typeof timestamp !== 'number') continue;
      if (
        CODE_METHODS.has(method) &&
        Number.isFinite(timestamp) &&
        timestamp <= nowSeconds + CLOCK_SKEW_SECONDS &&
        nowSeconds - timestamp <= maxAgeSeconds
      ) {
        recent = true;
        break;
      }
    }
  }
  if (!recent) throw new StepUpRequiredError();
}
