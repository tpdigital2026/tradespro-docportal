import { describe, expect, it } from 'vitest';
import { balanceStatement, computeTotals, depositOf } from '../../src/lib/money';
import { computeQuoteTotals, quoteLines, type QuoteMoneyInput } from '../../src/lib/quote-totals';

const base: QuoteMoneyInput = { priceNetPence: 1_000_000, vatApplies: true, extras: [], discountPence: 0, plan: { kind: 'deposit', pctBp: 3000 } };

describe('computeQuoteTotals', () => {
  it('matches money.ts for the same lines', () => {
    const t = computeQuoteTotals(base);
    const ref = computeTotals(quoteLines(base), 2000);
    expect([t.netPence, t.vatPence, t.grossPence]).toEqual([ref.netPence, ref.vatPence, ref.grossPence]);
    expect(t.grossPence).toBe(1_200_000);
  });
  it('the deposit is depositOf on the whole quote and the balance is the rest', () => {
    const t = computeQuoteTotals(base);
    const d = depositOf(computeTotals(quoteLines(base), 2000), 3000);
    expect(t.depositPence).toBe(d.grossPence);
    expect(t.balancePence).toBe(t.grossPence - d.grossPence);
    expect(t.depositPence).toBe(360_000);
  });
  it('agrees with balanceStatement for a plain deposit plan', () => {
    const lines = quoteLines(base);
    const s = balanceStatement(lines, [], 2000, 3000);
    const t = computeQuoteTotals(base);
    expect(t.depositPence).toBe(s.deposit.grossPence);
    expect(t.balancePence).toBe(s.balance.grossPence);
  });
  it('adds extras and takes the discount off before VAT', () => {
    const t = computeQuoteTotals({ ...base, extras: [{ description: 'Gutter', netPence: 30_000 }], discountPence: 100_000 });
    expect(t.subtotalNetPence).toBe(1_030_000);
    expect(t.netPence).toBe(930_000);
    expect(t.vatPence).toBe(186_000);
    expect(t.grossPence).toBe(1_116_000);
  });
  it('no VAT means no VAT anywhere', () => {
    const t = computeQuoteTotals({ ...base, vatApplies: false, extras: [{ description: 'x', netPence: 5 }] });
    expect(t.vatPence).toBe(0);
    expect(t.grossPence).toBe(1_000_005);
  });
  it('uses the business VAT rate it is given', () => {
    expect(computeQuoteTotals(base, 500).vatPence).toBe(50_000);
  });
  it('an empty form is zero, with no schedule', () => {
    const t = computeQuoteTotals({ ...base, priceNetPence: null, plan: null });
    expect([t.netPence, t.vatPence, t.grossPence]).toEqual([0, 0, 0]);
    expect(t.schedule).toBeNull();
    expect(t.planCheck).toBeNull();
    expect(t.depositPence).toBeNull();
  });
  it('full plan has one instalment for the whole job and no deposit', () => {
    const t = computeQuoteTotals({ ...base, plan: { kind: 'full' } });
    expect(t.schedule).toHaveLength(1);
    expect(t.depositPence).toBeNull();
  });
  it('a staged plan that does not total gives a running total, no schedule', () => {
    const t = computeQuoteTotals({
      ...base,
      plan: { kind: 'staged', stages: [{ label: 'A', mode: 'pct', pctBp: 3000 }, { label: 'B', mode: 'pct', pctBp: 3000 }] },
    });
    expect(t.schedule).toBeNull();
    expect(t.planCheck?.ok).toBe(false);
    expect(t.planCheck?.declaredPence).toBe(720_000);
    expect(t.planCheck?.remainingPence).toBe(480_000);
  });
  it('a staged plan that totals gives its schedule', () => {
    const t = computeQuoteTotals({
      ...base,
      plan: { kind: 'staged', stages: [{ label: 'A', mode: 'pct', pctBp: 6000 }, { label: 'B', mode: 'amount', grossPence: 480_000 }] },
    });
    expect(t.schedule?.map((i) => i.grossPence)).toEqual([720_000, 480_000]);
  });
});
