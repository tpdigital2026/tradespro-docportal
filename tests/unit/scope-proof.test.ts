import { describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('../../src/lib/session', () => ({ requireSession: async () => ({ userId: 'u1', tenantId: 't1', role: 'owner', email: 'o@example.test', fullName: 'O', businessName: 'B' }) }));

import { PROOF_MAX_AGE_MS, sameGeneration, signGenerated, verifyGenerated } from '../../src/lib/scope/proof';
import { sectionsKey } from '../../src/lib/scope/model';
import { sanitiseIncomingScope } from '../../src/lib/scope/approval';
import { generatedScope } from '../fixtures/scope';

const T0 = '2026-10-15T09:00:00.000Z';
const at = (ms: number) => new Date(Date.parse(T0) + ms);

describe('the generation proof', () => {
  const c = { engine: 'ai' as const, sourceKey: 'k1.1.a', generatedAt: T0, genKey: sectionsKey([{ heading: 'H', steps: ['Strip off.'] }]) };
  const proof = signGenerated('t1', c);

  it('verifies for the same business, source, engine, time and generated wording', () => {
    expect(verifyGenerated('t1', { ...c, proof }, { now: at(1000) })).toBe(true);
  });
  it('binds the tenant, the engine, the source, the time and the generated wording', () => {
    expect(verifyGenerated('t2', { ...c, proof }, { now: at(1000) })).toBe(false);
    expect(verifyGenerated('t1', { ...c, engine: 'fallback', proof }, { now: at(1000) })).toBe(false);
    expect(verifyGenerated('t1', { ...c, sourceKey: 'k1.2.b', proof }, { now: at(1000) })).toBe(false);
    expect(verifyGenerated('t1', { ...c, generatedAt: '2026-10-15T09:00:01.000Z', proof }, { now: at(2000) })).toBe(false);
    expect(verifyGenerated('t1', { ...c, genKey: sectionsKey([{ heading: 'H', steps: ['Strip off and fit a 20 year roof.'] }]), proof }, { now: at(1000) })).toBe(false);
    expect(verifyGenerated('t1', { ...c, genKey: undefined, proof }, { now: at(1000) })).toBe(false);
  });
  it('lasts a day, and not a moment longer; a time in the future is refused', () => {
    expect(verifyGenerated('t1', { ...c, proof }, { now: at(PROOF_MAX_AGE_MS) })).toBe(true);
    expect(verifyGenerated('t1', { ...c, proof }, { now: at(PROOF_MAX_AGE_MS + 1) })).toBe(false);
    expect(verifyGenerated('t1', { ...c, proof }, { now: at(-60 * 60_000) })).toBe(false);
    expect(verifyGenerated('t1', { ...c, proof }, { now: at(PROOF_MAX_AGE_MS + 1), allowExpired: true })).toBe(true);
  });
  it('an old generation, already stored, is not dropped by a later autosave; a new copy from an old proof is', () => {
    const old = new Date(Date.now() - 3 * PROOF_MAX_AGE_MS).toISOString();
    const g = generatedScope('t1', {}, old);
    const ok = (copy: Parameters<typeof verifyGenerated>[1], prev: typeof g.copy) => verifyGenerated('t1', copy, { allowExpired: sameGeneration(copy, prev) });
    // stored with this very proof: kept
    expect(sanitiseIncomingScope(g, g, ok).copy).not.toBeNull();
    // nothing stored: an old proof is not accepted as new
    expect(sanitiseIncomingScope(g, null, ok).copy).toBeNull();
  });
  it('edited wording keeps its proof (the proof covers the wording as generated, not as edited)', () => {
    const g = generatedScope('t1');
    const edited = { ...g, copy: { ...g.copy!, sections: [{ heading: 'Preparation', steps: ['Strip off the roof by hand.'] }] } };
    expect(verifyGenerated('t1', edited.copy)).toBe(true);
  });
});
