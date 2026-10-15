import { describe, expect, it } from 'vitest';
import { emptyScope } from '../../src/lib/scope/model';
import {
  MAX_PENCE,
  bpToInput,
  emptyQuoteForm,
  normaliseQuote,
  parsePercentToBp,
  parsePoundsToPence,
  penceToInput,
  quoteBlockers,
  quoteDraftSchema,
  quoteInputSchema,
  type QuoteFormValues,
} from '../../src/lib/validation/quote';
import { planFromJson, planToJson } from '../../src/lib/payment-plan';
import { buildSchedule, computeTotals } from '../../src/lib/money';
import { approvedScope } from '../fixtures/scope';

const CUSTOMER = '3f2c1b7e-5c1a-4a8e-9a55-0d6c3e9d1a11';
const JOBTYPE = '4f2c1b7e-5c1a-4a8e-9a55-0d6c3e9d1a22';
const BANK = '5f2c1b7e-5c1a-4a8e-9a55-0d6c3e9d1a33';

function ready(over: Partial<QuoteFormValues> = {}): QuoteFormValues {
  return {
    ...emptyQuoteForm({ date: '2026-10-14', vatApplies: true }),
    quoteNumber: 'QT-0042',
    customerId: CUSTOMER,
    jobTypeId: JOBTYPE,
    scope: approvedScope(),
    price: '10000',
    bankAccountId: BANK,
    ...over,
  };
}

describe('parsePoundsToPence', () => {
  const ok = (s: string) => {
    const r = parsePoundsToPence(s);
    if (!r.ok) throw new Error(`${s}: ${r.message}`);
    return r.pence;
  };
  it('parses ordinary amounts to whole pence', () => {
    expect(ok('1,250.50')).toBe(125_050);
    expect(ok('0.1')).toBe(10);
    expect(ok('0.10')).toBe(10);
    expect(ok('0')).toBe(0);
    expect(ok('0.00')).toBe(0);
    expect(ok('1250')).toBe(125_000);
    expect(ok('1250.5')).toBe(125_050);
    expect(ok('£1,000,000')).toBe(MAX_PENCE);
    expect(ok('  £ 12.34  ')).toBe(1234);
    expect(ok('.5')).toBe(50);
    expect(ok('999')).toBe(99_900);
    expect(ok('1,000')).toBe(100_000);
    expect(ok('0.07')).toBe(7);
  });
  it('is exact where floats are not', () => {
    // 19.99 * 100 and 0.29 * 100 are not whole in floating point
    expect(ok('19.99')).toBe(1999);
    expect(ok('0.29')).toBe(29);
    expect(ok('1.15')).toBe(115);
    expect(ok('8.2')).toBe(820);
  });
  it('rejects exponents, signs and other number formats', () => {
    for (const s of ['1e3', '1E3', '1e-2', '0x10', '+5', '1_000', 'Infinity', 'NaN', '0b1']) {
      const r = parsePoundsToPence(s);
      expect(r.ok, s).toBe(false);
    }
  });
  it('rejects negatives', () => {
    for (const s of ['-5', '-0.01', '-0', '(5)', '−5', '–5']) {
      const r = parsePoundsToPence(s);
      expect(r.ok, s).toBe(false);
      if (!r.ok) expect(r.reason).toBe('negative');
    }
  });
  it('rejects over-long text, however it is made', () => {
    const r = parsePoundsToPence('1'.repeat(15));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too_long');
    expect(parsePoundsToPence('0.' + '0'.repeat(20)).ok).toBe(false);
    expect(parsePoundsToPence('1,000,000,000,00').ok).toBe(false);
  });
  it('rejects amounts above one million pounds', () => {
    const r = parsePoundsToPence('1000000.01');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('too_large');
    expect(parsePoundsToPence('99999999999').ok).toBe(false);
  });
  it('rejects empty, badly grouped commas, three decimals and stray characters', () => {
    for (const s of ['', '   ', '.', '£', '1,25', '12,34,56', ',500', '1,2500', '1.234', '1.', '1..2', '12 34', '£$5', 'five', '1,000.', '٣']) {
      expect(parsePoundsToPence(s).ok, JSON.stringify(s)).toBe(false);
    }
    expect(parsePoundsToPence(undefined).ok).toBe(false);
    expect(parsePoundsToPence(12 as unknown).ok).toBe(false);
  });
  it('round trips through penceToInput', () => {
    for (const p of [0, 1, 10, 99, 100, 125_050, MAX_PENCE]) {
      expect(ok(penceToInput(p))).toBe(p);
    }
  });
});

describe('parsePercentToBp', () => {
  it('parses whole, half and two decimal percentages', () => {
    expect(parsePercentToBp('30')).toEqual({ ok: true, bp: 3000 });
    expect(parsePercentToBp('32.5')).toEqual({ ok: true, bp: 3250 });
    expect(parsePercentToBp('33.33%')).toEqual({ ok: true, bp: 3333 });
    expect(parsePercentToBp('0.01')).toEqual({ ok: true, bp: 1 });
    expect(parsePercentToBp('100')).toEqual({ ok: true, bp: 10_000 });
  });
  it('rejects anything else', () => {
    for (const s of ['', 'abc', '-5', '1e1', '30.123', '101', '1000', '.', '30,5', '5 5']) {
      expect(parsePercentToBp(s).ok, s).toBe(false);
    }
  });
  it('bpToInput round trips', () => {
    for (const bp of [1, 50, 3000, 3250, 3333, 9999]) expect(parsePercentToBp(bpToInput(bp))).toEqual({ ok: true, bp });
  });
});

describe('quoteInputSchema (strict)', () => {
  it('accepts a complete quote and returns whole pence and a parsed plan', () => {
    const r = quoteInputSchema.safeParse(ready({ price: '10,000.50', discount: '500', extras: [{ description: 'Extra lead flashing', amount: '250.25' }] }));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.priceNetPence).toBe(1_000_050);
      expect(r.data.discountPence).toBe(50_000);
      expect(r.data.extras).toEqual([{ description: 'Extra lead flashing', netPence: 25_025 }]);
      expect(r.data.plan).toEqual({ kind: 'deposit', pctBp: 3000 });
      expect(r.data.quoteNumber).toBe('QT-0042');
    }
  });
  it('rejects a missing quote number, customer, scope, price and date with messages on those fields', () => {
    const r = quoteInputSchema.safeParse(ready({ quoteNumber: '', customerId: '', scope: emptyScope(), price: '', date: '' }));
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join('.'));
      expect(paths).toEqual(expect.arrayContaining(['quoteNumber', 'customerId', 'scope.coverTitle', 'scope.items', 'price', 'date']));
    }
  });
  it('quote numbers: 2 to 40 safe characters', () => {
    for (const n of ['QT-0042', 'FJC/2026/17', 'A1', 'abc.def_1'.replace('_', '-')]) {
      expect(normaliseQuote(ready({ quoteNumber: n }), 'final').errors.quoteNumber, n).toBeUndefined();
    }
    for (const n of ['', 'A', '-QT1', 'QT 1', "QT';--", 'x'.repeat(41), 'QT\n1', '<b>1</b>']) {
      expect(normaliseQuote(ready({ quoteNumber: n }), 'final').errors.quoteNumber, JSON.stringify(n)).toBeDefined();
    }
  });
  it('quote numbers cannot end like a document number (-D, -B, -S or -P and digits) or start like one (INV-, RCP-, GC-, SR-), in draft or final', () => {
    for (const n of ['Q1-D', 'Q1-B', 'Q1-S2', 'Q1-P2', 'Q-5-P99', 'FJC/2026/17-S10', 'INV-100', 'RCP-100', 'GC-100', 'SR-100']) {
      for (const mode of ['draft', 'final'] as const) {
        expect(normaliseQuote(ready({ quoteNumber: n }), mode).errors.quoteNumber, `${mode} ${n}`).toMatch(/cannot start with INV-/);
      }
    }
    for (const n of ['Q1-DX', 'Q1-BS', 'Q1-S', 'Q1-P', 'Q1-s2', 'Q1-p2', 'QT-0042', 'AB-5', 'Q-5-2', 'INVOICE-1', 'GCSE-1', 'xINV-1']) {
      expect(normaliseQuote(ready({ quoteNumber: n }), 'final').errors.quoteNumber, n).toBeUndefined();
    }
  });
  it('rejects a price of zero, a malformed price and an over-large total', () => {
    expect(normaliseQuote(ready({ price: '0' }), 'final').errors.price).toMatch(/more than/);
    expect(normaliseQuote(ready({ price: '1e3' }), 'final').errors.price).toBeDefined();
    expect(normaliseQuote(ready({ price: '-5' }), 'final').errors.price).toMatch(/not negative/);
    expect(normaliseQuote(ready({ price: '1000000', extras: [{ description: 'More', amount: '1' }] }), 'final').errors.price).toMatch(/too large/);
  });
  it('a discount must leave something to pay', () => {
    expect(normaliseQuote(ready({ price: '100', discount: '100' }), 'final').errors.discount).toMatch(/less than the price/);
    expect(normaliseQuote(ready({ price: '100', discount: '150' }), 'final').errors.discount).toMatch(/less than the price/);
    expect(normaliseQuote(ready({ price: '100', discount: '99.99' }), 'final').errors.discount).toBeUndefined();
  });
  it('ignores blank extras and flags half-filled ones', () => {
    const e = normaliseQuote(ready({ extras: [{ description: '', amount: '' }, { description: 'Gutter', amount: '' }, { description: '', amount: '5' }] }), 'final').errors;
    expect(e['extras.0.description']).toBeUndefined();
    expect(e['extras.1.amount']).toBeDefined();
    expect(e['extras.2.description']).toBeDefined();
  });
  it('limits the number of extras and the size of text', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ description: `E${i}`, amount: '1' }));
    expect(quoteInputSchema.safeParse(ready({ extras: many })).success).toBe(false);
    expect(quoteInputSchema.safeParse(ready({ scope: approvedScope({ intro: 'x'.repeat(1201) }) })).success).toBe(false);
    expect(quoteInputSchema.safeParse(ready({ propertyAddress: 'x'.repeat(201) })).success).toBe(false);
    expect(quoteInputSchema.safeParse(ready({ scope: approvedScope({ note: 'a\u0000b' }) })).success).toBe(false);
    expect(quoteInputSchema.safeParse(ready({ scope: approvedScope({ note: 'line one\nline two' }) })).success).toBe(true);
  });
  it('rejects a real-looking but impossible date, and a non-id customer', () => {
    expect(normaliseQuote(ready({ date: '2026-02-30' }), 'final').errors.date).toBeDefined();
    expect(normaliseQuote(ready({ date: '14/10/2026' }), 'final').errors.date).toBeDefined();
    expect(normaliseQuote(ready({ customerId: "1; drop table customers" }), 'final').errors.customerId).toBeDefined();
  });
  it('no VAT is a valid choice', () => {
    const r = quoteInputSchema.safeParse(ready({ vatApplies: false }));
    expect(r.success).toBe(true);
  });
  it('unknown shapes are refused', () => {
    expect(quoteInputSchema.safeParse({}).success).toBe(false);
    expect(quoteInputSchema.safeParse({ ...ready(), plan: { kind: 'weekly', depositPct: '', stages: [] } }).success).toBe(false);
  });
});

describe('payment plan through the form', () => {
  it('deposit: default 30, half-percent steps from 1 to 99', () => {
    for (const ok of ['1', '1.5', '30', '32.5', '99']) expect(normaliseQuote(ready({ plan: { ...ready().plan, depositPct: ok } }), 'final').errors['plan.depositPct'], ok).toBeUndefined();
    for (const bad of ['0', '0.5', '99.5', '100', '30.25', '', 'x', '-5', '1e1']) {
      expect(normaliseQuote(ready({ plan: { ...ready().plan, depositPct: bad } }), 'final').errors['plan.depositPct'], bad).toBeDefined();
    }
    expect(emptyQuoteForm({ date: '2026-10-14', vatApplies: true }).plan.depositPct).toBe('30');
    expect(emptyQuoteForm({ date: '2026-10-14', vatApplies: true, depositPctBp: 2500 }).plan.depositPct).toBe('25');
  });
  it('full: needs nothing else', () => {
    const r = quoteInputSchema.safeParse(ready({ plan: { kind: 'full', depositPct: '', stages: [] } }));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.plan).toEqual({ kind: 'full' });
  });
  const staged = (stages: { label: string; mode: 'pct' | 'amount'; value: string }[]) =>
    ready({ price: '25000', plan: { kind: 'staged', depositPct: '30', stages } });
  it('staged by percentage that totals 100% is accepted', () => {
    const r = quoteInputSchema.safeParse(
      staged([
        { label: 'Deposit', mode: 'pct', value: '20' },
        { label: 'Scaffold up and strip complete', mode: 'pct', value: '20' },
        { label: 'Roof structure complete', mode: 'pct', value: '25' },
        { label: 'Roof covering complete', mode: 'pct', value: '20' },
        { label: 'Handover', mode: 'pct', value: '15' },
      ]),
    );
    expect(r.success).toBe(true);
    if (r.success && r.data.plan?.kind === 'staged') expect(r.data.plan.stages).toHaveLength(5);
  });
  it('staged that does not total is blocked, with the gap said in words and pointed at the plan', () => {
    const e = normaliseQuote(staged([{ label: 'A', mode: 'pct', value: '30' }, { label: 'B', mode: 'pct', value: '30' }, { label: 'C', mode: 'pct', value: '30' }]), 'final').errors;
    expect(e.plan).toMatch(/90%/);
    const over = normaliseQuote(staged([{ label: 'A', mode: 'amount', value: '20000' }, { label: 'B', mode: 'amount', value: '20000' }]), 'final').errors;
    expect(over.plan).toMatch(/over/);
    const under = normaliseQuote(staged([{ label: 'A', mode: 'amount', value: '10000' }, { label: 'B', mode: 'amount', value: '10000' }]), 'final').errors;
    expect(under.plan).toMatch(/unplaced/);
    // exactly the gross (25,000 + VAT 5,000 = 30,000)
    const exact = normaliseQuote(staged([{ label: 'A', mode: 'amount', value: '12000' }, { label: 'B', mode: 'amount', value: '18000' }]), 'final').errors;
    expect(Object.keys(exact).filter((k) => k.startsWith('plan'))).toEqual([]);
  });
  it('staged: names, 0% and 100% and malformed values are flagged on their own stage', () => {
    const e = normaliseQuote(staged([{ label: '', mode: 'pct', value: '0' }, { label: 'B', mode: 'pct', value: '100' }, { label: 'C', mode: 'amount', value: 'abc' }]), 'final').errors;
    expect(e['plan.stages.0.label']).toBeDefined();
    expect(e['plan.stages.0.value']).toBeDefined();
    expect(e['plan.stages.1.value']).toBeDefined();
    expect(e['plan.stages.2.value']).toBeDefined();
  });
  it('staged needs 2 to 10 stages', () => {
    expect(normaliseQuote(staged([{ label: 'A', mode: 'pct', value: '99' }]), 'final').errors.plan).toMatch(/between 2 and 10/);
    const eleven = Array.from({ length: 11 }, (_, i) => ({ label: `S${i}`, mode: 'pct' as const, value: '9' }));
    expect(quoteInputSchema.safeParse(staged(eleven)).success).toBe(false);
  });
  it('deposit is checked against the real total (a deposit that rounds to nothing is refused)', () => {
    const e = normaliseQuote(ready({ price: '0.40', vatApplies: false, plan: { ...ready().plan, depositPct: '1' } }), 'final').errors;
    expect(e['plan.depositPct']).toBeDefined();
  });
  it('the schedule from a valid form equals buildSchedule on the same totals', () => {
    const f = ready({ price: '10000', discount: '1000', extras: [{ description: 'Gutter', amount: '300' }] });
    const { input, errors } = normaliseQuote(f, 'final');
    expect(errors).toEqual({});
    const totals = computeTotals(
      [
        { description: 'a', kind: 'Works', qty: 1, unitNetPence: 1_000_000, vatApplies: true },
        { description: 'b', kind: 'Extra', qty: 1, unitNetPence: 30_000, vatApplies: true },
        { description: 'c', kind: 'Discount', qty: 1, unitNetPence: -100_000, vatApplies: true },
      ],
      2000,
    );
    expect(buildSchedule(totals, input.plan!)[0].grossPence).toBe(Math.round(totals.netPence * 0.3) + Math.round(totals.vatPence * 0.3));
  });
});

describe('quoteDraftSchema (lenient)', () => {
  it('needs only a quote number and a customer', () => {
    const r = quoteDraftSchema.safeParse(emptyQuoteForm({ date: '', vatApplies: true, quoteNumber: 'QT-9' }));
    expect(r.success).toBe(false); // no customer yet
    const r2 = quoteDraftSchema.safeParse({ ...emptyQuoteForm({ date: '', vatApplies: true, quoteNumber: 'QT-9' }), customerId: CUSTOMER });
    expect(r2.success).toBe(true);
  });
  it('keeps half-typed prices and plans without failing', () => {
    const f = ready({ price: '12x', plan: { kind: 'staged', depositPct: '', stages: [{ label: '', mode: 'pct', value: '' }, { label: 'B', mode: 'amount', value: '' }] } });
    const r = quoteDraftSchema.safeParse(f);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.priceNetPence).toBeNull();
      expect(r.data.plan).toBeNull();
    }
  });
  it('still refuses a bad quote number or id', () => {
    expect(quoteDraftSchema.safeParse(ready({ quoteNumber: "x';" })).success).toBe(false);
    expect(quoteDraftSchema.safeParse(ready({ jobTypeId: 'nope' })).success).toBe(false);
  });
});

describe('quoteBlockers', () => {
  it('lists blockers by step, earliest step first', () => {
    const b = quoteBlockers(ready({ scope: emptyScope(), price: '', bankAccountId: 'zzz' }));
    expect(b.map((x) => x.step)).toEqual(['scope', 'scope', 'price', 'review']);
  });
  it('is empty for a ready quote', () => {
    expect(quoteBlockers(ready())).toEqual([]);
  });
});

describe('stored plan json', () => {
  it('round trips every kind, with and without instalments', () => {
    const totals = computeTotals([{ description: 'w', kind: 'Works', qty: 1, unitNetPence: 100_000, vatApplies: true }], 2000);
    const plans = [
      { kind: 'full' as const },
      { kind: 'deposit' as const, pctBp: 3250 },
      { kind: 'staged' as const, stages: [{ label: 'One', mode: 'pct' as const, pctBp: 4000 }, { label: 'Two', mode: 'amount' as const, grossPence: 72_000 }] },
    ];
    for (const plan of plans) {
      const bare = planFromJson(planToJson(plan));
      expect(bare).toEqual({ plan, instalments: null });
      const sched = buildSchedule(totals, plan);
      expect(planFromJson(planToJson(plan, sched))).toEqual({ plan, instalments: sched });
    }
  });
  it('anything malformed reads as null', () => {
    for (const bad of [null, 5, {}, { kind: 'deposit' }, { kind: 'deposit', pct_bp: 3001.5 }, { kind: 'staged', stages: [] }, { kind: 'x' }, { kind: 'staged', stages: [{ label: '', mode: 'pct', pct_bp: 5 }, { label: 'b', mode: 'pct', pct_bp: 5 }] }]) {
      expect(planFromJson(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
