import { describe, expect, it } from 'vitest';
import {
  balanceDue,
  balanceStatement,
  computeTotals,
  depositOf,
  formatGBP,
  mulDivRound,
  priceLine,
  vatOnNet,
  type MoneyLine,
} from '../../src/lib/money';

const line = (unitNetPence: number, over: Partial<MoneyLine> = {}): MoneyLine => ({
  description: 'Work',
  kind: 'Work',
  qty: 1,
  unitNetPence,
  vatApplies: true,
  ...over,
});

describe('mulDivRound', () => {
  it('rounds half up for positive values', () => {
    expect(mulDivRound(10, 500, 10000)).toBe(1); // 0.5 -> 1
    expect(mulDivRound(9, 500, 10000)).toBe(0); // 0.45 -> 0
    expect(mulDivRound(11, 500, 10000)).toBe(1); // 0.55 -> 1
  });
  it('rounds half away from zero for negative values', () => {
    expect(mulDivRound(-10, 500, 10000)).toBe(-1);
    expect(mulDivRound(-9, 500, 10000)).toBe(0);
  });
  it('rejects non-integers', () => {
    expect(() => mulDivRound(10.5, 500, 10000)).toThrow(RangeError);
  });
  it('rejects a zero or negative divisor', () => {
    expect(() => mulDivRound(10, 500, 0)).toThrow(RangeError);
  });
});

describe('vatOnNet', () => {
  it('is 20% of net at 2000bp', () => {
    expect(vatOnNet(735500, 2000)).toBe(147100);
  });
});

describe('priceLine', () => {
  it('multiplies quantity and adds VAT', () => {
    const p = priceLine(line(30000, { qty: 3 }), 2000);
    expect(p.netPence).toBe(90000);
    expect(p.vatPence).toBe(18000);
    expect(p.grossPence).toBe(108000);
  });
  it('charges no VAT when vatApplies is false', () => {
    const p = priceLine(line(10000, { vatApplies: false }), 2000);
    expect(p.vatPence).toBe(0);
    expect(p.grossPence).toBe(10000);
  });
  it('rejects fractional pence', () => {
    expect(() => priceLine(line(10.5), 2000)).toThrow(RangeError);
  });
  it('rejects a non-integer or zero quantity', () => {
    expect(() => priceLine(line(100, { qty: 0 }), 2000)).toThrow(RangeError);
    expect(() => priceLine(line(100, { qty: 1.5 }), 2000)).toThrow(RangeError);
  });
});

describe('computeTotals', () => {
  it('reproduces the residential flat roof quote: net 7,505.00, VAT 1,501.00, total 9,006.00', () => {
    const t = computeTotals([line(735500), line(15000)], 2000);
    expect(t.lines.map((l) => l.grossPence)).toEqual([882600, 18000]);
    expect(t.netPence).toBe(750500);
    expect(t.vatPence).toBe(150100);
    expect(t.grossPence).toBe(900600);
  });
  it('supports a negative discount line', () => {
    const t = computeTotals([line(100000), line(-10000)], 2000);
    expect(t.netPence).toBe(90000);
    expect(t.vatPence).toBe(18000);
    expect(t.grossPence).toBe(108000);
  });
  it('line gross values always sum to the total', () => {
    const t = computeTotals([line(3333), line(1), line(4999), line(2)], 2000);
    expect(t.lines.reduce((s, l) => s + l.grossPence, 0)).toBe(t.grossPence);
  });
});

describe('depositOf and balanceDue', () => {
  it('30% deposit on a 3,294.00 quote is 988.20 and the balance is 2,305.80', () => {
    const t = computeTotals([line(274500)], 2000);
    expect(t.grossPence).toBe(329400);
    const d = depositOf(t, 3000);
    expect(d.netPence).toBe(82350);
    expect(d.vatPence).toBe(16470);
    expect(d.grossPence).toBe(98820);
    expect(balanceDue(t.grossPence, [d.grossPence])).toBe(230580);
  });
  it('deposit plus balance equals the quote total', () => {
    const t = computeTotals([line(123457)], 2000);
    const d = depositOf(t, 2500);
    expect(d.grossPence + balanceDue(t.grossPence, [d.grossPence])).toBe(t.grossPence);
  });
  it('rejects payments that exceed the quote total', () => {
    expect(() => balanceDue(1000, [600, 600])).toThrow(RangeError);
  });
  it('is zero when paid in full', () => {
    expect(balanceDue(1000, [400, 600])).toBe(0);
  });
});

describe('formatGBP', () => {
  it('formats pounds and pence with grouping', () => {
    expect(formatGBP(900600)).toBe('£9,006.00');
    expect(formatGBP(5)).toBe('£0.05');
    expect(formatGBP(100000000)).toBe('£1,000,000.00');
  });
  it('formats negatives with a leading minus', () => {
    expect(formatGBP(-153600)).toBe('-£1,536.00');
  });
  it('rejects non-integers', () => {
    expect(() => formatGBP(1.5)).toThrow(RangeError);
  });
});

describe('balanceStatement', () => {
  const quote: MoneyLine[] = [line(274500)];

  it('splits the balance into net and VAT by subtraction: 1,921.50 + 384.30 = 2,305.80', () => {
    const s = balanceStatement(quote, [], 2000, 3000);
    expect(s.quote.grossPence).toBe(329400);
    expect(s.adjustments).toBeNull();
    expect(s.deposit.grossPence).toBe(98820);
    expect(s.balance.netPence).toBe(192150);
    expect(s.balance.vatPence).toBe(38430);
    expect(s.balance.grossPence).toBe(230580);
    expect(s.totalGrossPence).toBe(329400);
  });

  it('adds extra works to the balance without changing the deposit', () => {
    const s = balanceStatement(quote, [line(50000, { description: 'Extra ply boards' })], 2000, 3000);
    expect(s.adjustments?.grossPence).toBe(60000);
    expect(s.deposit.grossPence).toBe(98820);
    expect(s.totalGrossPence).toBe(389400);
    expect(s.balance.grossPence).toBe(290580);
  });

  it('subtracts a credit (negative line)', () => {
    const s = balanceStatement(quote, [line(-10000, { description: 'Goodwill credit' })], 2000, 3000);
    expect(s.adjustments?.grossPence).toBe(-12000);
    expect(s.balance.grossPence).toBe(218580);
  });

  it('balance plus deposit always equals the total', () => {
    const s = balanceStatement([line(123457)], [line(3333)], 2000, 2500);
    expect(s.balance.grossPence + s.deposit.grossPence).toBe(s.totalGrossPence);
  });

  it('rejects a deposit larger than the total', () => {
    expect(() => balanceStatement([line(100000)], [line(-100000)], 2000, 3000)).toThrow(RangeError);
  });
});
