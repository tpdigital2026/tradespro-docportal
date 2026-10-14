import { describe, expect, it } from 'vitest';
import {
  byUrgency,
  deriveJobStage,
  documentNumberFor,
  instalmentFromNumber,
  invoiceTypeFor,
  jobHref,
  newDocumentHref,
  nextStepHref,
  type DocType,
  type PlanKind,
  type StageDocument,
  type StageInstalment,
  type StagePayment,
} from '../../src/lib/job-stage';

const inst = (n: number, gross = 1000): StageInstalment[] => Array.from({ length: n }, (_, i) => ({ index: i + 1, label: `Part ${i + 1}`, grossPence: gross }));
const doc = (type: DocType, instalment: number | null, status: StageDocument['status'] = 'final'): StageDocument => ({ type, instalment, status });
const pay = (instalment: number, amountPence: number): StagePayment => ({ instalment, amountPence });

describe('step counts', () => {
  it('pay in full has 4 steps, a deposit job 6, five stages 12, ten stages 22', () => {
    expect(deriveJobStage({ kind: 'full' }, inst(1), [], []).steps).toHaveLength(4);
    expect(deriveJobStage({ kind: 'deposit' }, inst(2), [], []).steps).toHaveLength(6);
    expect(deriveJobStage({ kind: 'staged' }, inst(5), [], []).steps).toHaveLength(12);
    expect(deriveJobStage({ kind: 'staged' }, inst(10), [], []).steps).toHaveLength(22);
  });

  it('labels are words for every shape', () => {
    const labels = (kind: PlanKind, n: number) => deriveJobStage({ kind }, inst(n), [], []).steps.map((s) => s.label);
    expect(labels('full', 1)).toEqual(['Quoted', 'Invoiced', 'Paid in full', 'Guarantee issued']);
    expect(labels('deposit', 2)).toEqual(['Quoted', 'Deposit invoiced', 'Deposit paid', 'Balance invoiced', 'Paid in full', 'Guarantee issued']);
    expect(labels('staged', 3)).toEqual([
      'Quoted',
      'Stage 1 of 3 invoiced',
      'Stage 1 of 3 paid',
      'Stage 2 of 3 invoiced',
      'Stage 2 of 3 paid',
      'Stage 3 of 3 invoiced',
      'Paid in full',
      'Guarantee issued',
    ]);
  });

  it('step keys are unique', () => {
    const keys = deriveJobStage({ kind: 'staged' }, inst(10), [], []).steps.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('deposit job', () => {
  const plan = { kind: 'deposit' as const };
  const i2 = [{ index: 1, label: 'Deposit', grossPence: 3000 }, { index: 2, label: 'Balance', grossPence: 7000 }];

  it('starts at Quoted and asks for the deposit invoice', () => {
    const p = deriveJobStage(plan, i2, [], []);
    expect(p.currentIndex).toBe(0);
    expect(p.next).toEqual({ label: 'Raise deposit invoice', type: 'deposit-invoice', action: 'create', instalment: 1 });
  });

  it('a final deposit invoice moves to Deposit invoiced and asks to mark it paid', () => {
    const p = deriveJobStage(plan, i2, [], [doc('deposit-invoice', 1)]);
    expect(p.steps[p.currentIndex].label).toBe('Deposit invoiced');
    expect(p.next).toEqual({ label: 'Mark deposit as paid', type: 'deposit-invoice', action: 'mark-paid', instalment: 1, remainingPence: 3000 });
  });

  it('a draft or void invoice does not count as invoiced', () => {
    expect(deriveJobStage(plan, i2, [], [doc('deposit-invoice', 1, 'draft')]).currentIndex).toBe(0);
    expect(deriveJobStage(plan, i2, [], [doc('deposit-invoice', 1, 'void')]).currentIndex).toBe(0);
  });

  it('a part payment is not paid and says what is left', () => {
    const p = deriveJobStage(plan, i2, [pay(1, 1000)], [doc('deposit-invoice', 1)]);
    expect(p.steps[p.currentIndex].label).toBe('Deposit invoiced');
    expect(p.next).toMatchObject({ label: 'Record the rest of deposit', action: 'mark-paid', remainingPence: 2000 });
  });

  it('two part payments that add up make it paid', () => {
    const p = deriveJobStage(plan, i2, [pay(1, 1000), pay(1, 2000)], [doc('deposit-invoice', 1)]);
    expect(p.steps[p.currentIndex].label).toBe('Deposit paid');
    expect(p.next).toMatchObject({ label: 'Raise balance invoice', type: 'balance-invoice', action: 'create', instalment: 2 });
  });

  it('runs to the guarantee and then has no next step', () => {
    const docs = [doc('deposit-invoice', 1), doc('balance-invoice', 2), doc('receipt', 1), doc('receipt', 2)];
    const paid = deriveJobStage(plan, i2, [pay(1, 3000), pay(2, 7000)], docs);
    expect(paid.steps[paid.currentIndex].label).toBe('Paid in full');
    expect(paid.next).toEqual({ label: 'Issue guarantee certificate', type: 'guarantee', action: 'create', instalment: null });
    const done = deriveJobStage(plan, i2, [pay(1, 3000), pay(2, 7000)], [...docs, doc('guarantee', null)]);
    expect(done.currentIndex).toBe(done.steps.length - 1);
    expect(done.next).toBeNull();
  });

  it('overpaying still counts as paid', () => {
    expect(deriveJobStage(plan, i2, [pay(1, 3500)], [doc('deposit-invoice', 1)]).steps[2].label).toBe('Deposit paid');
  });
});

describe('pay in full job', () => {
  const plan = { kind: 'full' as const };
  it('raises the full invoice, then marks it paid, then the guarantee', () => {
    const i1 = inst(1, 9000);
    expect(deriveJobStage(plan, i1, [], []).next).toMatchObject({ label: 'Raise full invoice', type: 'invoice-full', instalment: 1 });
    expect(deriveJobStage(plan, i1, [], [doc('invoice-full', 1)]).next).toMatchObject({ label: 'Mark invoice as paid', action: 'mark-paid' });
    const paid = deriveJobStage(plan, i1, [pay(1, 9000)], [doc('invoice-full', 1)]);
    expect(paid.steps[paid.currentIndex].label).toBe('Paid in full');
    expect(paid.next?.type).toBe('guarantee');
  });
});

describe('five stage job', () => {
  const plan = { kind: 'staged' as const };
  const five = inst(5, 5000);
  const docs = [doc('invoice-stage', 1), doc('invoice-stage', 2), doc('invoice-stage', 3, 'draft')];

  it('part paid: stages 1 and 2 paid, stage 3 not yet raised', () => {
    const p = deriveJobStage(plan, five, [pay(1, 5000), pay(2, 5000)], docs);
    expect(p.steps).toHaveLength(12);
    expect(p.steps[p.currentIndex].label).toBe('Stage 2 of 5 paid');
    expect(p.next).toEqual({ label: 'Raise stage 3 invoice', type: 'invoice-stage', action: 'create', instalment: 3 });
  });

  it('a gap does not count: stage 3 invoiced while stage 2 is unpaid stays at stage 2 invoiced', () => {
    const p = deriveJobStage(plan, five, [pay(1, 5000)], [doc('invoice-stage', 1), doc('invoice-stage', 2), doc('invoice-stage', 3)]);
    expect(p.steps[p.currentIndex].label).toBe('Stage 2 of 5 invoiced');
    expect(p.next).toMatchObject({ action: 'mark-paid', instalment: 2, label: 'Mark stage 2 as paid' });
  });

  it('the last stage paid reads Paid in full', () => {
    const all = [1, 2, 3, 4, 5].map((n) => doc('invoice-stage', n));
    const p = deriveJobStage(plan, five, [1, 2, 3, 4, 5].map((n) => pay(n, 5000)), all);
    expect(p.steps[p.currentIndex].label).toBe('Paid in full');
  });

  it('progress never goes backwards as facts are added', () => {
    let last = 0;
    const facts: StageDocument[] = [];
    const payments: StagePayment[] = [];
    for (let n = 1; n <= 5; n += 1) {
      facts.push(doc('invoice-stage', n));
      const a = deriveJobStage(plan, five, payments, facts).currentIndex;
      expect(a).toBeGreaterThanOrEqual(last);
      payments.push(pay(n, 5000));
      const b = deriveJobStage(plan, five, payments, facts).currentIndex;
      expect(b).toBeGreaterThan(a);
      last = b;
    }
  });
});

describe('receipts due', () => {
  const plan = { kind: 'deposit' as const };
  const i2 = [{ index: 1, label: 'Deposit', grossPence: 3000 }, { index: 2, label: 'Balance', grossPence: 7000 }];
  it('lists instalments with a payment and no receipt', () => {
    expect(deriveJobStage(plan, i2, [pay(1, 3000)], [doc('deposit-invoice', 1)]).receiptsDue).toEqual([1]);
    expect(deriveJobStage(plan, i2, [pay(1, 3000)], [doc('deposit-invoice', 1), doc('receipt', 1, 'draft')]).receiptsDue).toEqual([]);
    expect(deriveJobStage(plan, i2, [pay(1, 3000)], [doc('deposit-invoice', 1), doc('receipt', 1, 'void')]).receiptsDue).toEqual([1]);
    expect(deriveJobStage(plan, i2, [], [doc('deposit-invoice', 1)]).receiptsDue).toEqual([]);
  });
});

describe('document numbers', () => {
  it('follow the quote number', () => {
    expect(documentNumberFor('deposit-invoice', 'Q1', 'deposit', 1)).toBe('INV-Q1-D');
    expect(documentNumberFor('balance-invoice', 'Q1', 'deposit', 2)).toBe('INV-Q1-B');
    expect(documentNumberFor('invoice-full', 'Q1', 'full', 1)).toBe('INV-Q1');
    expect(documentNumberFor('invoice-stage', 'Q1', 'staged', 4)).toBe('INV-Q1-S4');
    expect(documentNumberFor('receipt', 'Q1', 'deposit', 1)).toBe('RCP-Q1-D');
    expect(documentNumberFor('receipt', 'Q1', 'deposit', 2)).toBe('RCP-Q1-B');
    expect(documentNumberFor('receipt', 'Q1', 'full', 1)).toBe('RCP-Q1');
    expect(documentNumberFor('receipt', 'Q1', 'staged', 10)).toBe('RCP-Q1-S10');
  });

  it('refuses a type that does not fit the plan', () => {
    expect(documentNumberFor('invoice-full', 'Q1', 'staged', 1)).toBeNull();
    expect(documentNumberFor('invoice-stage', 'Q1', 'deposit', 1)).toBeNull();
    expect(documentNumberFor('balance-invoice', 'Q1', 'deposit', 1)).toBeNull();
    expect(documentNumberFor('invoice-stage', 'Q1', 'staged', 11)).toBeNull();
    expect(documentNumberFor('receipt', 'Q1', 'full', 2)).toBeNull();
    expect(documentNumberFor('guarantee', 'Q1', 'full', 1)).toBeNull();
  });

  it('maps a number back to its instalment', () => {
    expect(instalmentFromNumber('invoice-stage', 'INV-Q1-S3', 'Q1', 'staged', 5)).toBe(3);
    expect(instalmentFromNumber('balance-invoice', 'INV-Q1-B', 'Q1', 'deposit', 2)).toBe(2);
    expect(instalmentFromNumber('invoice-stage', 'INV-OTHER-S3', 'Q1', 'staged', 5)).toBeNull();
  });

  it('picks the invoice type from the plan', () => {
    expect(invoiceTypeFor('deposit', 1)).toBe('deposit-invoice');
    expect(invoiceTypeFor('deposit', 2)).toBe('balance-invoice');
    expect(invoiceTypeFor('full', 1)).toBe('invoice-full');
    expect(invoiceTypeFor('staged', 7)).toBe('invoice-stage');
  });
});

describe('routes', () => {
  it('builds real route strings', () => {
    expect(newDocumentHref('receipt', 'DEMO-1001')).toBe('/documents/new?type=receipt&job=DEMO-1001');
    expect(newDocumentHref('quotation')).toBe('/documents/new?type=quotation');
    expect(newDocumentHref('invoice-stage', 'Q 1', { n: 3 })).toBe('/documents/new?type=invoice-stage&job=Q+1&n=3');
    expect(newDocumentHref('receipt', 'Q1', { n: 2, payment: 'abc' })).toBe('/documents/new?type=receipt&job=Q1&n=2&payment=abc');
    expect(newDocumentHref('invoice-stage', undefined, { n: 3 })).toBe('/documents/new?type=invoice-stage');
  });

  it('sends a mark-paid step to the job page and a create step to the form', () => {
    const create = { label: 'x', type: 'invoice-stage' as const, action: 'create' as const, instalment: 2 };
    const paid = { label: 'x', type: 'invoice-stage' as const, action: 'mark-paid' as const, instalment: 2 };
    expect(nextStepHref(create, 'Q1')).toBe('/documents/new?type=invoice-stage&job=Q1&n=2');
    expect(nextStepHref(paid, 'Q1')).toBe('/documents/jobs/Q1#instalment-2');
    expect(jobHref('A/B')).toBe('/documents/jobs/A%2FB');
  });
});

describe('byUrgency', () => {
  it('drops finished jobs and puts the least advanced first', () => {
    const early = { quoteNumber: 'B', progress: deriveJobStage({ kind: 'full' }, inst(1), [], []) };
    const later = { quoteNumber: 'A', progress: deriveJobStage({ kind: 'full' }, inst(1), [], [doc('invoice-full', 1)]) };
    const done = { quoteNumber: 'C', progress: deriveJobStage({ kind: 'full' }, inst(1), [pay(1, 1000)], [doc('invoice-full', 1), doc('guarantee', null)]) };
    expect(byUrgency([later, done, early]).map((j) => j.quoteNumber)).toEqual(['B', 'A']);
  });
});
