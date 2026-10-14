export const STEP_UP_MAX_AGE_SECONDS = 600;
const CLOCK_SKEW_SECONDS = 60;
const CODE_METHODS = new Set(['otp', 'email', 'magiclink']);

export class StepUpRequiredError extends Error {
  constructor() {
    super('Please confirm with a fresh email code to continue');
    this.name = 'StepUpRequiredError';
  }
}

export interface AuthClaims {
  amr?: { method: string; timestamp: number }[];
}

/** Sensitive actions need an emailed code entered in the last 10 minutes. */
export function assertRecentStepUp(claims: AuthClaims, nowSeconds: number, maxAgeSeconds = STEP_UP_MAX_AGE_SECONDS): void {
  const recent = (claims.amr ?? []).some(
    (a) =>
      CODE_METHODS.has(a.method) &&
      Number.isFinite(a.timestamp) &&
      a.timestamp <= nowSeconds + CLOCK_SKEW_SECONDS &&
      nowSeconds - a.timestamp <= maxAgeSeconds,
  );
  if (!recent) throw new StepUpRequiredError();
}
