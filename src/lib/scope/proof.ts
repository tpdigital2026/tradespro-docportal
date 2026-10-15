import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isDemo } from '../demo';
import type { ScopeCopy } from './model';

/**
 * The proof that a piece of generated wording came from the server. It covers the engine, the steps it was made
 * from, the wording as generated and the time, for one business, and lasts a day. The browser holds it and sends it back; it cannot make one, so it cannot
 * claim a different engine or pass off its own text as generated.
 */
function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (isDemo() || process.env.NODE_ENV === 'test') return 'demo-and-test-only-proof-secret-0000000';
  throw new Error('Not configured');
}

type Proved = Pick<ScopeCopy, 'engine' | 'sourceKey' | 'generatedAt'> & { genKey?: string };
const payload = (tenantId: string, c: Proved) => `dp-scope-proof:v2:${JSON.stringify([tenantId, c.engine, c.sourceKey, c.generatedAt, c.genKey ?? ''])}`;

/** A proof is good for a day: an earlier generation cannot be picked up and passed off as a new one. */
export const PROOF_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export function signGenerated(tenantId: string, c: Proved): string {
  return createHmac('sha256', secret()).update(payload(tenantId, c)).digest('hex');
}

export interface VerifyOptions {
  now?: Date;
  /** Skip the age check. Only for wording that is already stored with this very proof (an autosave of an old draft). */
  allowExpired?: boolean;
}

export function verifyGenerated(tenantId: string, c: Proved & { proof: string }, opts: VerifyOptions = {}): boolean {
  if (typeof c.proof !== 'string' || !/^[0-9a-f]{64}$/.test(c.proof)) return false;
  try {
    const want = createHmac('sha256', secret()).update(payload(tenantId, c)).digest();
    if (!timingSafeEqual(want, Buffer.from(c.proof, 'hex'))) return false;
  } catch {
    return false;
  }
  const at = Date.parse(c.generatedAt);
  if (Number.isNaN(at)) return false;
  const age = (opts.now ?? new Date()).getTime() - at;
  if (age < -CLOCK_SKEW_MS) return false;
  return opts.allowExpired === true || age <= PROOF_MAX_AGE_MS;
}

/** The same generation as one already stored (same proof, same time): old enough to be past its day, but not new. */
export function sameGeneration(c: Pick<ScopeCopy, 'proof' | 'generatedAt'>, stored: Pick<ScopeCopy, 'proof' | 'generatedAt'> | null): boolean {
  return !!stored && stored.proof === c.proof && stored.generatedAt === c.generatedAt;
}
