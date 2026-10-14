import { describe, expect, it } from 'vitest';
import {
  MAX_AMOUNT_PENCE,
  MAX_TOTAL_GROSS_PENCE,
  MAX_TOTAL_NET_PENCE,
  MAX_VAT_RATE_BP,
  TOO_LARGE_MESSAGE,
  mulDivRound,
  type PaymentPlan,
} from '../../src/lib/money';
import { computeQuoteTotals, type QuoteMoneyInput } from '../../src/lib/quote-totals';
import { getQuoteDefaultsWith } from '../../src/lib/data/quotes';
import type { DataClient } from '../../src/lib/data/customers';
import { emptyQuoteForm, normaliseQuote, quoteDraftSchema, quoteInputSchema, type QuoteFormValues } from '../../src/lib/validation/quote';

const CUSTOMER = '3f2c1b7e-5c1a-4a8e-9a55-0d6c3e9d1a11';
const base = (over: Partial<QuoteFormValues> = {}): QuoteFormValues => ({
  ...emptyQuoteForm({ date: '2026-10-14', vatApplies: true }),
  quoteNumber: 'QT-1',
  customerId: CUSTOMER,
  scopeNotes: 'Work',
  price: '1000',
  ...over,
});
const stagedAmounts = (...v: string[]) => ({ kind: 'staged' as const, depositPct: '30', stages: v.map((value, i) => ({ label: `S${i}`, mode: 'amount' as const, value })) });

describe('the reviewer case: very large quotes never crash', () => {
  const big = base({ price: '1000000', extras: [{ description: 'A', amount: '1000000' }, { description: 'B', amount: '1000000' }], plan: stagedAmounts('1000000', '2000000') });
  it('normaliseQuote returns a message, never throws', () => {
    for (const mode of ['draft', 'final'] as const) {
      expect(() => normaliseQuote(big, mode)).not.toThrow();
    }
    expect(normaliseQuote(big, 'final').errors.price).toBe(TOO_LARGE_MESSAGE);
  });
  it('the schemas fail cleanly instead of throwing', () => {
    expect(quoteInputSchema.safeParse(big).success).toBe(false);
    expect(quoteDraftSchema.safeParse(big).success).toBe(true); // a draft may be half-finished; it is judged when issued
  });
  it('computeQuoteTotals reports the error and zero figures', () => {
    const t = computeQuoteTotals({ priceNetPence: 100_000_000, vatApplies: true, extras: [{ description: 'a', netPence: 100_000_000 }, { description: 'b', netPence: 100_000_000 }], discountPence: 0, plan: { kind: 'staged', stages: [{ label: 'a', mode: 'amount', grossPence: 300_000_000 }, { label: 'b', mode: 'amount', grossPence: 1 }] } });
    expect(t.error).toBe(TOO_LARGE_MESSAGE);
    expect(t.grossPence).toBe(0);
    expect(t.schedule).toBeNull();
    expect(t.planCheck?.ok).toBe(false);
  });
});

describe('bounds are exact', () => {
  const at = (rate: number, plan: PaymentPlan, over: Partial<QuoteMoneyInput> = {}) =>
    computeQuoteTotals({ priceNetPence: MAX_AMOUNT_PENCE, vatApplies: true, extras: [], discountPence: 0, plan, ...over }, rate);
  it('the biggest total at the highest VAT rate calculates every kind of plan', () => {
    const t0 = at(MAX_VAT_RATE_BP, { kind: 'full' });
    expect(t0.error).toBeNull();
    expect(t0.netPence).toBe(MAX_TOTAL_NET_PENCE);
    expect(t0.grossPence).toBe(MAX_TOTAL_GROSS_PENCE);
    const g = t0.grossPence;
    const plans: PaymentPlan[] = [
      { kind: 'full' },
      { kind: 'deposit', pctBp: 9900 },
      { kind: 'deposit', pctBp: 100 },
      { kind: 'staged', stages: [{ label: 'a', mode: 'amount', grossPence: g - 1 }, { label: 'b', mode: 'amount', grossPence: 1 }] },
      { kind: 'staged', stages: [{ label: 'a', mode: 'amount', grossPence: g - 1 }, { label: 'b', mode: 'amount', grossPence: 1 }, { label: 'c', mode: 'amount', grossPence: 1 }] },
      { kind: 'staged', stages: [{ label: 'a', mode: 'pct', pctBp: 9999 }, { label: 'b', mode: 'pct', pctBp: 1 }] },
    ];
    for (const plan of plans) {
      const t = at(MAX_VAT_RATE_BP, plan);
      expect(t.error).toBeNull();
      expect(t.planCheck?.problems.every((p) => p.message !== TOO_LARGE_MESSAGE)).toBe(true); // refused for its own reasons at most, never for overflow
      if (t.schedule) expect(t.schedule.reduce((s, i) => s + i.grossPence, 0)).toBe(g);
    }
  });
  it('the largest product mulDivRound can be asked for stays under the exact-integer limit', () => {
    const worst = MAX_TOTAL_GROSS_PENCE * (MAX_TOTAL_GROSS_PENCE - MAX_TOTAL_NET_PENCE) * 2 + MAX_TOTAL_GROSS_PENCE;
    expect(Number.isSafeInteger(worst)).toBe(true);
    expect(() => mulDivRound(MAX_TOTAL_GROSS_PENCE - 1, MAX_TOTAL_GROSS_PENCE - MAX_TOTAL_NET_PENCE, MAX_TOTAL_GROSS_PENCE)).not.toThrow();
  });
  it('one penny over the net cap is refused before any plan maths', () => {
    const t = at(2000, { kind: 'deposit', pctBp: 3000 }, { extras: [{ description: 'x', netPence: 1 }] });
    expect(t.error).toBe(TOO_LARGE_MESSAGE);
    const ok = at(2000, { kind: 'deposit', pctBp: 3000 }, { extras: [{ description: 'x', netPence: 1 }], discountPence: 1 });
    expect(ok.error).toBeNull();
    const form = base({ price: '1000000', extras: [{ description: 'x', amount: '0.01' }] });
    expect(normaliseQuote(form, 'final').errors.price).toBe(TOO_LARGE_MESSAGE);
    expect(normaliseQuote({ ...form, extras: [] }, 'final').errors.price).toBeUndefined();
  });
  it('VAT rates above the cap, negative or fractional are refused', () => {
    for (const r of [MAX_VAT_RATE_BP + 1, 4500, 10_000, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(computeQuoteTotals({ priceNetPence: 1000, vatApplies: true, extras: [], discountPence: 0, plan: null }, r).error, String(r)).toBe(TOO_LARGE_MESSAGE);
    }
    expect(computeQuoteTotals({ priceNetPence: 1000, vatApplies: true, extras: [], discountPence: 0, plan: null }, MAX_VAT_RATE_BP).error).toBeNull();
    expect(computeQuoteTotals({ priceNetPence: 1000, vatApplies: true, extras: [], discountPence: 0, plan: null }, 0).error).toBeNull();
  });
  it('a business VAT rate above the cap in the database is not used', async () => {
    const client = (rate: number): DataClient => ({ from: () => ({ select: () => ({ maybeSingle: async () => ({ data: { vat_default: true, vat_rate_bp: rate, deposit_pct_bp: 3000 }, error: null }) }) }) });
    expect((await getQuoteDefaultsWith(client(4500))).vatRateBp).toBe(2000);
    expect((await getQuoteDefaultsWith(client(10_000))).vatRateBp).toBe(2000);
    expect((await getQuoteDefaultsWith(client(2500))).vatRateBp).toBe(2500);
    expect((await getQuoteDefaultsWith(client(0))).vatRateBp).toBe(0);
  });
});

describe('fuzz: nothing ever throws', () => {
  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const r = rng(424242);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const AMOUNTS = ['', '0', '0.01', '1', '999999.99', '1000000', '1000000.01', '1,000,000', '12x', '-5', '1e3', '99999999999999', '£5', ' 7 ', '.5', '1,25', '0.1', '1000000'.repeat(3), 'Infinity', '٣'];
  const PCTS = ['', '0', '1', '0.01', '30', '32.5', '99.99', '100', '101', 'x', '-1', '1e1', '33.333'];
  const randPlan = (): QuoteFormValues['plan'] => ({
    kind: pick(['deposit', 'full', 'staged'] as const),
    depositPct: pick(PCTS),
    stages: Array.from({ length: Math.floor(r() * 15) }, () => {
      const mode = pick(['pct', 'amount'] as const);
      return { label: pick(['', 'A', ' ', 'x'.repeat(100), 'Roof on']), mode, value: mode === 'pct' ? pick(PCTS) : pick(AMOUNTS) };
    }),
  });
  it('normaliseQuote for 4000 random forms, and the schemas', () => {
    for (let i = 0; i < 4000; i++) {
      const f: QuoteFormValues = {
        quoteNumber: pick(['QT-1', '', 'x', 'A'.repeat(50), "a'b"]),
        customerId: pick([CUSTOMER, '', 'nope', 'demo-customer-1']),
        date: pick(['2026-10-14', '', '2026-02-30', 'x']),
        jobTypeId: pick(['', CUSTOMER, 'zz']),
        propertyAddress: pick(['', 'Here']),
        scopeNotes: pick(['', 'Work']),
        price: pick(AMOUNTS),
        vatApplies: r() < 0.7,
        extras: Array.from({ length: Math.floor(r() * 15) }, () => ({ description: pick(['', 'E']), amount: pick(AMOUNTS) })),
        discount: pick(AMOUNTS),
        plan: randPlan(),
        bankAccountId: pick(['', CUSTOMER, 'q']),
      };
      const rate = pick([2000, 0, 2500, 2501, 10_000, -5, 0.5, Number.NaN, 1e12]);
      for (const mode of ['draft', 'final'] as const) {
        const out = normaliseQuote(f, mode, rate);
        expect(out.errors).toBeTypeOf('object');
      }
      expect(() => quoteInputSchema.safeParse(f)).not.toThrow();
      expect(() => quoteDraftSchema.safeParse(f)).not.toThrow();
    }
  });
  it('computeQuoteTotals for random numbers including huge, negative and not-numbers', () => {
    const NUMS = [0, 1, 99, 100_000_000, 100_000_001, 2 ** 53, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER, 1e15];
    for (let i = 0; i < 4000; i++) {
      const stages = Array.from({ length: Math.floor(r() * 12) }, () =>
        r() < 0.5 ? { label: 'a', mode: 'pct' as const, pctBp: pick(NUMS) } : { label: 'a', mode: 'amount' as const, grossPence: pick(NUMS) },
      );
      const plan: PaymentPlan | null = pick<PaymentPlan | null>([null, { kind: 'full' }, { kind: 'deposit', pctBp: pick(NUMS) }, { kind: 'staged', stages }]);
      const input: QuoteMoneyInput = {
        priceNetPence: pick([null, ...NUMS]),
        vatApplies: r() < 0.5,
        extras: Array.from({ length: Math.floor(r() * 14) }, () => ({ description: 'e', netPence: pick(NUMS) })),
        discountPence: pick(NUMS),
        plan,
      };
      const t = computeQuoteTotals(input, pick([2000, 2500, 2501, -1, Number.NaN, 1e12]));
      expect(t.planCheck === null || typeof t.planCheck.ok === 'boolean').toBe(true);
    }
  });
});
