import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { demoSlot, isDemo } from './demo';
import { OTP_LENGTH } from './otp';
import { STEP_UP_MAX_AGE_SECONDS } from '../security/step-up';

/**
 * DEMO MODE ONLY: a stand-in for the emailed step-up code, so the owner-only screens can be tried without Supabase.
 *
 * Real mode never touches this file's cookie: requireFreshStepUpForRequest reads the verified token's amr claim there.
 * Here the code is a fixed, published dummy (shown on screen), and a correct entry sets a cookie signed with a key that
 * exists only in this server process, valid for the same 10 minutes as a real step-up. The route that issues it
 * answers 404 unless isDemo() (DEMO_MODE=1, not production, not on Vercel).
 */
export const DEMO_STEP_UP_CODE = '1'.repeat(OTP_LENGTH);
const COOKIE = 'dp-demo-stepup';
export const demoStepUpCookieName = () => COOKIE;

const keyBox = demoSlot<Buffer>('step-up-key', () => randomBytes(32));
const sign = (at: number) => createHmac('sha256', keyBox.get()).update(`demo-step-up:v1:${at}`).digest('base64url');

export function issueDemoStepUp(nowSeconds: number): string {
  if (!isDemo()) throw new Error('Demo step-up is only available in demo mode');
  return `${nowSeconds}.${sign(nowSeconds)}`;
}

/** True only in demo mode, for a cookie this process signed in the last 10 minutes. */
export function demoStepUpFresh(value: string | undefined, nowSeconds: number): boolean {
  if (!isDemo() || !value) return false;
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!m) return false;
  const at = Number(m[1]);
  const given = Buffer.from(m[2]);
  const want = Buffer.from(sign(at));
  if (given.length !== want.length || !timingSafeEqual(given, want)) return false;
  return at <= nowSeconds + 60 && nowSeconds - at <= STEP_UP_MAX_AGE_SECONDS;
}
