import { describe, expect, it } from 'vitest';
import { documentNumberFor, type DocType, type PlanKind } from '../../src/lib/job-stage';
import { NUMBER_RE, quoteNumberReserved } from '../../src/lib/validation/quote';

/** Every document number a job with this reference can ever have, over every plan and every payment. */
function numbersOf(ref: string): string[] {
  const out: string[] = [];
  const kinds: [PlanKind, number][] = [['full', 1], ['deposit', 2], ['staged', 10]];
  const types: DocType[] = ['deposit-invoice', 'balance-invoice', 'invoice-full', 'invoice-stage', 'receipt'];
  for (const [kind, count] of kinds) {
    for (let i = 1; i <= count; i += 1) {
      for (const t of types) {
        for (let k = 1; k <= (t === 'receipt' ? 99 : 1); k += 1) {
          const n = documentNumberFor(t, ref, kind, i, k);
          if (n) out.push(n);
        }
      }
    }
  }
  return out;
}

const usable = (ref: string) => NUMBER_RE.test(ref) && quoteNumberReserved(ref) === null;

describe('document numbers never collide between jobs', () => {
  it('the cases that used to collide cannot happen: Q-5 and Q-5-P2, Q-5-D, Q-S3 and friends are not both usable', () => {
    // Q-5's second receipt is RCP-Q-5-P2; the other job would have to be called Q-5-P... which is refused.
    expect(usable('Q-5')).toBe(true);
    for (const other of ['Q-5-2'.replace('-2', '-P2'), 'Q-5-D', 'Q-5-D-P2', 'Q-S3', 'Q-S3-P2', 'Q-5-S3', 'Q-5-B']) expect(usable(other), other).toBe(false);
    // Q-5-2 is allowed now, and its numbers are disjoint from Q-5's.
    expect(usable('Q-5-2')).toBe(true);
    const a = new Set(numbersOf('Q-5'));
    expect(numbersOf('Q-5-2').filter((n) => a.has(n))).toEqual([]);
  });

  it('property: for a generated set of valid references (including related pairs) no number belongs to two jobs', () => {
    let seed = 5;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const alphabet = ['Q', 'Q', '5', '2', '1', '-', '-', 'D', 'B', 'S', 'P', '.', '/', 'x'];
    const endings = ['-D', '-B', '-S3', '-S10', '-P2', '-P99', '-2', '-5', '-D-2', '-D-P2', '-S3-P2', '-S3-2', '-99', '.2', '/D'];
    const refs = new Set<string>();
    for (let i = 0; i < 120; i += 1) {
      const len = 2 + Math.floor(rnd() * 7);
      let r = '';
      for (let j = 0; j < len; j += 1) r += alphabet[Math.floor(rnd() * alphabet.length)];
      if (usable(r)) refs.add(r);
      for (const e of endings) if (usable(r + e)) refs.add(r + e);
    }
    for (const base of ['Q-5', 'Q', 'Q-1', 'QT-100', 'A.B', 'Q-S3', 'Q-5-D']) {
      if (usable(base)) refs.add(base);
      for (const e of endings) if (usable(base + e)) refs.add(base + e);
    }
    expect(refs.size).toBeGreaterThan(300);
    const owner = new Map<string, string>();
    const clashes: string[] = [];
    for (const ref of refs) {
      for (const n of numbersOf(ref)) {
        const prior = owner.get(n);
        // The same reference may produce the same number from two plan kinds (RCP-{q}-D never repeats across kinds, but full and staged share nothing either); a different reference never may.
        if (prior !== undefined && prior !== ref) clashes.push(`${n} belongs to both ${prior} and ${ref}`);
        owner.set(n, ref);
      }
    }
    expect(clashes).toEqual([]);
  }, 60_000);

  it('within one job, distinct (type, instalment, payment) give distinct numbers', () => {
    for (const ref of ['Q-5', 'Q1']) {
      for (const [kind, count] of [['full', 1], ['deposit', 2], ['staged', 10]] as [PlanKind, number][]) {
        const seen = new Set<string>();
        let total = 0;
        for (let i = 1; i <= count; i += 1) {
          for (const t of ['deposit-invoice', 'balance-invoice', 'invoice-full', 'invoice-stage', 'receipt'] as DocType[]) {
            for (let k = 1; k <= (t === 'receipt' ? 99 : 1); k += 1) {
              const n = documentNumberFor(t, ref, kind, i, k);
              if (n) {
                seen.add(n);
                total += 1;
              }
            }
          }
        }
        expect(seen.size).toBe(total);
      }
    }
  });
});
