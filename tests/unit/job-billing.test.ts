import { describe, expect, it } from 'vitest';
import { demoIssuedJobs, demoQuoteDefaults } from '../../src/lib/demo-data';
import { buildJobBilling, followOnFor, instalmentHeading, payableInvoice, type RawDocument, type RawPayment } from '../../src/lib/job-billing';
import type { Instalment, PaymentPlan } from '../../src/lib/money';
import { planFromJson, planToJson } from '../../src/lib/payment-plan';
import { emptyQuoteForm, normaliseQuote, type QuoteFormValues } from '../../src/lib/validation/quote';

const RATE = demoQuoteDefaults.vatRateBp;
const planOf = (f: QuoteFormValues) => normaliseQuote(f, 'draft', RATE).input.plan;

function demoBilling(i: number) {
  const j = demoIssuedJobs[i];
  const r = buildJobBilling({ quoteNumber: j.form.quoteNumber, plan: planOf(j.form), form: j.form, vatRateBp: RATE, documents: j.documents, payments: j.payments });
  if (!r.ok) throw new Error(r.message);
  return r.billing;
}

describe('the three demo jobs', () => {
  it('deposit job: 30% of 8,400 plus VAT, deposit paid, balance next', () => {
    const b = demoBilling(0);
    expect(b.kind).toBe('deposit');
    expect(b.instalments.map((i) => i.grossPence)).toEqual([302400, 705600]);
    expect(b.totals.grossPence).toBe(1008000);
    expect(b.progress.steps).toHaveLength(6);
    expect(b.progress.steps[b.progress.currentIndex].label).toBe('Deposit paid');
    expect(b.progress.next).toMatchObject({ label: 'Raise balance invoice', type: 'balance-invoice', instalment: 2 });
    expect(b.progress.receiptsDue).toEqual([1]);
  });

  it('full invoice job: invoiced and waiting for payment', () => {
    const b = demoBilling(1);
    expect(b.kind).toBe('full');
    expect(b.instalments).toHaveLength(1);
    expect(b.instalments[0].grossPence).toBe(222000);
    expect(b.progress.steps).toHaveLength(4);
    expect(b.progress.steps[b.progress.currentIndex].label).toBe('Invoiced');
    expect(b.progress.next).toMatchObject({ label: 'Mark invoice as paid', action: 'mark-paid' });
  });

  it('five stage job: two stages paid, stage 3 part paid', () => {
    const b = demoBilling(2);
    expect(b.kind).toBe('staged');
    expect(b.instalments.map((i) => i.grossPence)).toEqual([600000, 600000, 750000, 600000, 450000]);
    expect(b.progress.steps).toHaveLength(12);
    expect(b.progress.steps[b.progress.currentIndex].label).toBe('Stage 3 of 5 invoiced');
    expect(b.progress.next).toMatchObject({ label: 'Record the rest of stage 3', action: 'mark-paid', instalment: 3, remainingPence: 450000 });
    expect(b.progress.receiptsDue).toEqual([2, 3]);
  });

  it('every schedule adds up to the job totals exactly', () => {
    for (let i = 0; i < 3; i += 1) {
      const b = demoBilling(i);
      expect(b.instalments.reduce((s, x) => s + x.grossPence, 0)).toBe(b.totals.grossPence);
      expect(b.instalments.reduce((s, x) => s + x.netPence, 0)).toBe(b.totals.netPence);
      expect(b.instalments.reduce((s, x) => s + x.vatPence, 0)).toBe(b.totals.vatPence);
    }
  });
});

describe('the schedule is recomputed, never read from storage', () => {
  it('a stale stored instalments copy has no effect', () => {
    const j = demoIssuedJobs[0];
    const plan = planOf(j.form) as PaymentPlan;
    const stale: Instalment[] = [
      { index: 1, label: 'Deposit', netPence: 1, vatPence: 1, grossPence: 2 },
      { index: 2, label: 'Balance', netPence: 1, vatPence: 1, grossPence: 2 },
    ];
    const stored = planFromJson(planToJson(plan, stale));
    expect(stored?.instalments?.[0].grossPence).toBe(2);
    const r = buildJobBilling({ quoteNumber: j.form.quoteNumber, plan: stored!.plan, form: j.form, vatRateBp: RATE, documents: j.documents, payments: j.payments });
    expect(r.ok && r.billing.instalments.map((i) => i.grossPence)).toEqual([302400, 705600]);
  });

  it('a later price changes the schedule', () => {
    const j = demoIssuedJobs[0];
    const form = { ...j.form, price: '10000' };
    const r = buildJobBilling({ quoteNumber: form.quoteNumber, plan: planOf(form), form, vatRateBp: RATE, documents: [], payments: [] });
    expect(r.ok && r.billing.instalments.map((i) => i.grossPence)).toEqual([360000, 840000]);
  });

  it('no plan or no price gives a message, never a throw', () => {
    const j = demoIssuedJobs[0];
    expect(buildJobBilling({ quoteNumber: 'X', plan: null, form: j.form, vatRateBp: RATE, documents: [], payments: [] }).ok).toBe(false);
    const blank = emptyQuoteForm({ date: '2026-10-15', vatApplies: true });
    expect(buildJobBilling({ quoteNumber: 'X', plan: { kind: 'full' }, form: blank, vatRateBp: RATE, documents: [], payments: [] }).ok).toBe(false);
  });

  it('property: odd penny prices and random stage splits always add up', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let t = 0; t < 300; t += 1) {
      const pennies = Math.floor(rnd() * 99990000) + 10000;
      const form: QuoteFormValues = {
        ...emptyQuoteForm({ date: '2026-10-15', vatApplies: rnd() > 0.2 }),
        quoteNumber: 'P1',
        customerId: 'c',
        price: (pennies / 100).toFixed(2),
        scopeNotes: 'x',
      };
      const kind = ['full', 'deposit', 'staged'][Math.floor(rnd() * 3)] as 'full' | 'deposit' | 'staged';
      const n = 2 + Math.floor(rnd() * 9);
      const plan: PaymentPlan =
        kind === 'full'
          ? { kind: 'full' }
          : kind === 'deposit'
            ? { kind: 'deposit', pctBp: (2 + Math.floor(rnd() * 197)) * 50 }
            : { kind: 'staged', stages: Array.from({ length: n }, (_, i) => ({ label: `S${i + 1}`, mode: 'pct' as const, pctBp: Math.floor(10000 / n) + (i === n - 1 ? 10000 - Math.floor(10000 / n) * n : 0) })) };
      const r = buildJobBilling({ quoteNumber: 'P1', plan, form, vatRateBp: 2000, documents: [], payments: [] });
      expect(r.ok, JSON.stringify(plan)).toBe(true);
      if (r.ok) {
        const b = r.billing;
        expect(b.instalments.reduce((s, x) => s + x.grossPence, 0)).toBe(b.totals.grossPence);
        expect(b.instalments.reduce((s, x) => s + x.netPence, 0)).toBe(b.totals.netPence);
        expect(b.progress.steps).toHaveLength(2 + 2 * b.instalments.length);
      }
    }
  });
});

describe('payments map to instalments through their invoice', () => {
  it('ignores a payment whose invoice is not one of the job\'s', () => {
    const j = demoIssuedJobs[1];
    const stray: RawPayment = { id: 'p', documentId: 'unknown', amountPence: 100, paidOn: '2026-10-01', method: 'cash', note: null, receiptDocumentId: null };
    const r = buildJobBilling({ quoteNumber: j.form.quoteNumber, plan: planOf(j.form), form: j.form, vatRateBp: RATE, documents: j.documents, payments: [stray] });
    expect(r.ok && r.billing.payments).toEqual([]);
  });

  it('an invoice with a number that does not fit the plan is not tied to an instalment', () => {
    const j = demoIssuedJobs[1];
    const odd: RawDocument = { id: 'd', type: 'invoice-full', number: 'INV-SOMETHING-ELSE', status: 'final' };
    const r = buildJobBilling({ quoteNumber: j.form.quoteNumber, plan: planOf(j.form), form: j.form, vatRateBp: RATE, documents: [odd], payments: [] });
    expect(r.ok && r.billing.documents[0].instalment).toBeNull();
    expect(r.ok && r.billing.progress.currentIndex).toBe(0);
  });

  it('payableInvoice needs a final or sent invoice', () => {
    const j = demoIssuedJobs[1];
    const mk = (status: RawDocument['status']) => {
      const r = buildJobBilling({ quoteNumber: j.form.quoteNumber, plan: planOf(j.form), form: j.form, vatRateBp: RATE, documents: [{ id: 'd', type: 'invoice-full', number: 'INV-DEMO-3002', status }], payments: [] });
      return r.ok ? payableInvoice(r.billing, 1) : null;
    };
    expect(mk('final')?.id).toBe('d');
    expect(mk('sent')?.id).toBe('d');
    expect(mk('draft')).toBeNull();
    expect(mk('void')).toBeNull();
  });
});

describe('headings and follow-on prefill', () => {
  it('names each part of the job', () => {
    expect(instalmentHeading(demoBilling(0), 1)).toBe('Deposit (30%)');
    expect(instalmentHeading(demoBilling(0), 2)).toBe('Balance');
    expect(instalmentHeading(demoBilling(1), 1)).toBe('Invoice');
    expect(instalmentHeading(demoBilling(2), 2)).toBe('Stage 2 of 5: Scaffold up and strip complete');
  });

  it('a balance invoice is prefilled from the recomputed schedule, with the deposit listed as received', () => {
    const r = followOnFor(demoBilling(0), 'balance-invoice', null, null);
    expect(r.ok && r.followOn).toMatchObject({ number: 'INV-DEMO-3001-B', grossPence: 705600, heading: 'Balance', exists: false });
    expect(r.ok && r.followOn.receivedEarlier.map((p) => p.amountPence)).toEqual([302400]);
  });

  it('a stage invoice needs its stage and carries the owner\'s label', () => {
    expect(followOnFor(demoBilling(2), 'invoice-stage', null, null).ok).toBe(false);
    const r = followOnFor(demoBilling(2), 'invoice-stage', 4, null);
    expect(r.ok && r.followOn).toMatchObject({ number: 'INV-DEMO-3003-S4', grossPence: 600000, heading: 'Stage 4 of 5: Roof covering complete' });
    expect(r.ok && r.followOn.receivedEarlier).toHaveLength(3);
  });

  it('refuses a document that does not fit the plan', () => {
    expect(followOnFor(demoBilling(1), 'deposit-invoice', null, null).ok).toBe(false);
    expect(followOnFor(demoBilling(0), 'invoice-full', null, null).ok).toBe(false);
    expect(followOnFor(demoBilling(2), 'invoice-stage', 6, null).ok).toBe(false);
    expect(followOnFor(demoBilling(0), 'guarantee', null, null).ok).toBe(false);
  });

  it('a receipt is for a recorded payment and flags an existing number', () => {
    const b = demoBilling(2);
    expect(followOnFor(b, 'receipt', 1, null).ok).toBe(false); // its only payment already has a receipt
    const r = followOnFor(b, 'receipt', 1, 'demo-payment-3003-1');
    expect(r.ok && r.followOn).toMatchObject({ number: 'RCP-DEMO-3003-S1', grossPence: 600000, netPence: 500000, vatPence: 100000, exists: true });
    expect(r.ok && r.followOn.payment?.amountPence).toBe(600000);
    const byPayment = followOnFor(b, 'receipt', null, 'demo-payment-3003-3');
    expect(byPayment.ok && byPayment.followOn).toMatchObject({ instalment: 3, number: 'RCP-DEMO-3003-S3' });
    expect(byPayment.ok && byPayment.followOn).toMatchObject({ grossPence: 300000, netPence: 250000, vatPence: 50000 });
    expect(followOnFor(b, 'receipt', 4, null).ok).toBe(false); // nothing paid on stage 4
    expect(followOnFor(b, 'receipt', null, 'someone-elses').ok).toBe(false);
  });
});

describe('a receipt for each payment', () => {
  /** Stage 3 of the demo job is 7,500.00 gross (6,250.00 net, 1,250.00 VAT). Pay it in three odd parts. */
  function withParts(parts: number[]) {
    const j = demoIssuedJobs[2];
    const base = j.payments.filter((p) => p.documentId !== 'demo-doc-3003-s3');
    const extra: RawPayment[] = parts.map((amountPence, i) => ({ id: `part-${i + 1}`, documentId: 'demo-doc-3003-s3', amountPence, paidOn: '2026-10-1' + (i + 1), method: 'cash', note: null, receiptDocumentId: null }));
    const r = buildJobBilling({ quoteNumber: j.form.quoteNumber, plan: planOf(j.form), form: j.form, vatRateBp: RATE, documents: j.documents, payments: [...base, ...extra] });
    if (!r.ok) throw new Error(r.message);
    return r.billing;
  }

  it('two part payments on one stage give two distinct receipts with the right amounts', () => {
    const b = withParts([333333, 416667]);
    const one = followOnFor(b, 'receipt', 3, 'part-1');
    const two = followOnFor(b, 'receipt', 3, 'part-2');
    expect(one.ok && one.followOn).toMatchObject({ number: 'RCP-DEMO-3003-S3', grossPence: 333333 });
    expect(two.ok && two.followOn).toMatchObject({ number: 'RCP-DEMO-3003-S3-2', grossPence: 416667 });
    if (!one.ok || !two.ok) throw new Error('unreachable');
    // Net and VAT of the parts add up to the stage's own net and VAT exactly.
    expect(one.followOn.netPence + two.followOn.netPence).toBe(625000);
    expect(one.followOn.vatPence + two.followOn.vatPence).toBe(125000);
    expect(one.followOn.netPence + one.followOn.vatPence).toBe(333333);
    expect(two.followOn.netPence + two.followOn.vatPence).toBe(416667);
  });

  it('with no payment named it takes the first one without a receipt, and its number stays put on a retry', () => {
    const b = withParts([100000, 200000]);
    const a = followOnFor(b, 'receipt', 3, null);
    expect(a.ok && a.followOn.number).toBe('RCP-DEMO-3003-S3');
    const again = followOnFor(b, 'receipt', 3, 'part-2');
    expect(again.ok && again.followOn.number).toBe('RCP-DEMO-3003-S3-2');
  });

  it('a linked payment shows its existing receipt, and cannot be given a second', () => {
    const b = withParts([100000]);
    b.payments.find((p) => p.id === 'part-1')!.receiptDocumentId = 'r';
    b.documents.push({ id: 'r', type: 'receipt', number: 'RCP-DEMO-3003-S3', status: 'draft', instalment: 3 });
    expect(followOnFor(b, 'receipt', 3, null).ok).toBe(false);
    const named = followOnFor(b, 'receipt', 3, 'part-1');
    expect(named.ok && named.followOn).toMatchObject({ number: 'RCP-DEMO-3003-S3', exists: true });
  });

  it('refuses a 100th receipt on one instalment, cleanly', () => {
    const j = demoIssuedJobs[1]; // full invoice, 2,220.00
    const pays: RawPayment[] = Array.from({ length: 100 }, (_, i) => ({ id: `p${i + 1}`, documentId: 'demo-doc-3002-f', amountPence: 100, paidOn: '2026-10-01', method: 'cash', note: null, receiptDocumentId: null }));
    const r = buildJobBilling({ quoteNumber: j.form.quoteNumber, plan: planOf(j.form), form: j.form, vatRateBp: RATE, documents: j.documents, payments: pays });
    if (!r.ok) throw new Error(r.message);
    const last99 = followOnFor(r.billing, 'receipt', 1, 'p99');
    expect(last99.ok && last99.followOn.number).toBe('RCP-DEMO-3002-99');
    const last = followOnFor(r.billing, 'receipt', 1, 'p100');
    expect(last.ok).toBe(false);
    expect(!last.ok && last.message).toMatch(/up to 99/);
  });
});
