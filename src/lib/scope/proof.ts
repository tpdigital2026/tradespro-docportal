import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isDemo } from '../demo';
import type { ScopeCopy } from './model';

/**
 * The proof that a piece of generated wording came from the server. It covers the engine, the steps it was made
 * from and the time, for one business. The browser holds it and sends it back; it cannot make one, so it cannot
 * claim a different engine or pass off its own text as generated.
 */
function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  if (isDemo() || process.env.NODE_ENV === 'test') return 'demo-and-test-only-proof-secret-0000000';
  throw new Error('Not configured');
}

type Proved = Pick<ScopeCopy, 'engine' | 'sourceKey' | 'generatedAt'>;
const payload = (tenantId: string, c: Proved) => `dp-scope-proof:v1:${JSON.stringify([tenantId, c.engine, c.sourceKey, c.generatedAt])}`;

export function signGenerated(tenantId: string, c: Proved): string {
  return createHmac('sha256', secret()).update(payload(tenantId, c)).digest('hex');
}

export function verifyGenerated(tenantId: string, c: Proved & { proof: string }): boolean {
  if (typeof c.proof !== 'string' || !/^[0-9a-f]{64}$/.test(c.proof)) return false;
  try {
    const want = createHmac('sha256', secret()).update(payload(tenantId, c)).digest();
    return timingSafeEqual(want, Buffer.from(c.proof, 'hex'));
  } catch {
    return false;
  }
}
