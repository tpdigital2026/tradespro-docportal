import { describe, expect, it } from 'vitest';
import type { FactDocument, FactPayment, JobFacts } from '../../src/lib/business/facts';
import { storedSchedule } from '../../src/lib/business/facts';
import { buildBalances, dueDateFor, dueRuleFrom, jobBalance, overdueJobIds, paymentRows, paymentTotals, summariseInvoices } from '../../src/lib/business/money-board';
import { buildPipeline, byPipelineUrgency, pipelineCard } from '../../src/lib/business/pipeline';
import { guaranteeRows, filterGuarantees } from '../../src/lib/business/guarantees';
import { moneyCsv, moneyView, parseMoneyParams } from '../../src/lib/business/money-view';
import { buildSchedule, type PaymentPlan } from '../../src/lib/money';
import { nextStepHref, type DocType } from '../../src/lib/job-stage';

const TODAY = '2026-10-15';
const opts = { today: TODAY, hrefFor: nextStepHref, quoteHref: () => '/documents/new?type=quotation' };

const doc = (id: string, type: DocType, number: string, docDate: string, total: number | null, extra: Partial<FactDocument> = {}): FactDocument => ({
  id, type, number, status: 'final', docDate, finalisedAt: `${docDate}T10:00:00.000Z`, totalPence: total, dueWording: null, guaranteeYears: null, certificateNo: null, ...extra,
});
const pay = (id: string, documentId: string, amount: number, paidOn: string, method = 'bank transfer'): FactPayment => ({ id, documentId, amountPence: amount, paidOn, method, recordedAt: `${paidOn}T12:00:00.000Z`, receiptDocumentId: null });

function depositJob(over: Partial<JobFacts> = {}): JobFacts {
  return {
    jobId: 'j1', quoteNumber: 'Q100', customerId: 'c1', customerName: 'Mr Test', addressLine: '1 Road', planKind: 'deposit',
    quote: { documentId: 'q', issuedAt: '2026-10-01T09:00:00.000Z', grossPence: 100000, schedule: [{ index: 1, label: 'Deposit', grossPence: 30000 }, { index: 2, label: 'Balance', grossPence: 70000 }] },
    draftQuoteId: null, documents: [doc('q', 'quotation', 'Q100', '2026-10-01', 100000)], payments: [], ...over,
  };
}

describe('pipeline', () => {
  it('a freshly issued quote is Quoted, valued at the stored gross, with the raise-deposit step', () => {
    const c = pipelineCard(depositJob(), opts)!;
    expect(c).toMatchObject({ stage: 'quoted', stageLabel: 'Quoted', valuePence: 100000, since: '2026-10-01', ageDays: 14, next: { label: 'Raise deposit invoice' } });
  });

  it('moves through Invoiced, Part paid, Paid in full and Guarantee issued from recorded facts only', () => {
    const inv = doc('d', 'deposit-invoice', 'INV-Q100-D', '2026-10-02', 30000);
    let j = depositJob({ documents: [doc('q', 'quotation', 'Q100', '2026-10-01', 100000), inv] });
    expect(pipelineCard(j, opts)).toMatchObject({ stage: 'invoiced', stageLabel: 'Deposit invoiced', since: '2026-10-02' });
    j = { ...j, payments: [pay('p1', 'd', 10000, '2026-10-03')] };
    expect(pipelineCard(j, opts)).toMatchObject({ stage: 'invoiced', next: { label: 'Record the rest of deposit' } });
    j = { ...j, payments: [...j.payments, pay('p2', 'd', 20000, '2026-10-05')] };
    expect(pipelineCard(j, opts)).toMatchObject({ stage: 'part-paid', stageLabel: 'Deposit paid', since: '2026-10-05', next: { label: 'Raise balance invoice' } });
    const bal = doc('b', 'balance-invoice', 'INV-Q100-B', '2026-10-08', 70000);
    j = { ...j, documents: [...j.documents, bal], payments: [...j.payments, pay('p3', 'b', 70000, '2026-10-09')] };
    expect(pipelineCard(j, opts)).toMatchObject({ stage: 'paid', stageLabel: 'Paid in full', since: '2026-10-09', next: { label: 'Issue guarantee certificate' } });
    j = { ...j, documents: [...j.documents, doc('g', 'guarantee', 'GUA-1', '2026-10-10', null, { guaranteeYears: 20 })] };
    expect(pipelineCard(j, opts)).toMatchObject({ stage: 'guarantee', next: null });
  });

  it('a draft invoice does not count, and a draft-only job is left off the board', () => {
    const draft = { ...doc('d', 'deposit-invoice', 'INV-Q100-D', '2026-10-02', null), status: 'draft' as const, finalisedAt: null };
    expect(pipelineCard(depositJob({ documents: [doc('q', 'quotation', 'Q100', '2026-10-01', 100000), draft] }), opts)?.stage).toBe('quoted');
    expect(pipelineCard(depositJob({ quote: null, draftQuoteId: 'x' }), opts)).toBeNull();
  });

  it('an issued survey before the quote puts the job in Surveyed with no value', () => {
    const c = pipelineCard(depositJob({ quote: null, draftQuoteId: 'x', documents: [doc('s', 'survey', 'SR-1', '2026-10-13', null)] }), opts)!;
    expect(c).toMatchObject({ stage: 'surveyed', valuePence: null, ageDays: 2, next: { label: 'Finish the quote' } });
  });

  it('never recomputes: a quote with no stored schedule says so instead of guessing', () => {
    const c = pipelineCard(depositJob({ quote: { documentId: 'q', issuedAt: '2026-10-01T09:00:00Z', grossPence: 5000, schedule: null } }), opts)!;
    expect(c.problem).toMatch(/not stored/);
    expect(c.valuePence).toBe(5000);
  });

  it('column totals are sums of stored quote values only, and overdue jobs lead', () => {
    const a = depositJob();
    const b = depositJob({ jobId: 'j2', quoteNumber: 'Q200', quote: { ...depositJob().quote!, grossPence: 250 } });
    const s = depositJob({ jobId: 'j3', quoteNumber: 'Q300', quote: null, documents: [doc('s', 'survey', 'SR-1', '2026-10-13', null)] });
    const board = buildPipeline([a, b, s], { ...opts, overdueJobs: new Set(['j2']) });
    const quoted = board.columns.find((c) => c.key === 'quoted')!;
    expect(quoted.totalPence).toBe(100250);
    expect(quoted.valued).toBe(2);
    expect(board.columns.find((c) => c.key === 'surveyed')).toMatchObject({ totalPence: 0, valued: 0 });
    expect(board.cards[0].jobId).toBe('j2');
    expect([...board.cards].sort(byPipelineUrgency).map((c) => c.jobId)).toEqual(board.cards.map((c) => c.jobId));
  });

  it('reads the stored schedule strictly', () => {
    expect(storedSchedule({ schedule: [{ index: 1, label: 'x', grossPence: 1 }, { index: 2, label: 'y', grossPence: 2 }] })).toHaveLength(2);
    expect(storedSchedule({ schedule: [{ index: 2, label: 'x', grossPence: 1 }] })).toBeNull();
    expect(storedSchedule({ schedule: [{ index: 1, grossPence: -1 }] })).toBeNull();
    expect(storedSchedule(null)).toBeNull();
  });
});

describe('due dates from the printed wording', () => {
  it('reads only plain rules and never guesses', () => {
    expect(dueRuleFrom('Payment is due upon receipt of this invoice')).toEqual({ kind: 'on-receipt' });
    expect(dueRuleFrom('Payment due within 14 days of the invoice date.')).toEqual({ kind: 'days', days: 14 });
    expect(dueRuleFrom('Due within fourteen days')).toEqual({ kind: 'days', days: 14 });
    expect(dueRuleFrom('30 days from the invoice date')).toEqual({ kind: 'days', days: 30 });
    expect(dueRuleFrom('14 days of the invoice date')).toEqual({ kind: 'days', days: 14 });
    expect(dueRuleFrom('within 10 days of the date of invoice')).toEqual({ kind: 'days', days: 10 });
    expect(dueRuleFrom('Within 7 days.')).toEqual({ kind: 'days', days: 7 });
    expect(dueRuleFrom('Before works start')).toBeNull();
    expect(dueRuleFrom('Balance due on completion')).toBeNull();
    expect(dueRuleFrom(null)).toBeNull();
    // Another anchor: no due date, the owner is asked to check it.
    expect(dueRuleFrom('Payment within 14 days of completion')).toEqual({ kind: 'check' });
    expect(dueRuleFrom('Interest charged 30 days after the due date')).toEqual({ kind: 'check' });
    expect(dueRuleFrom('Net 30')).toBeNull();
    expect(dueDateFor({ docDate: '2026-10-10', dueWording: 'within 14 days of completion' })).toBeNull();
    // Upon receipt wins over interest wording.
    expect(dueRuleFrom('Payment is due upon receipt. Interest at 8% is charged 30 days after the due date.')).toEqual({ kind: 'on-receipt' });
    expect(dueDateFor({ docDate: '2026-10-10', dueWording: 'within 7 days' })).toBe('2026-10-17');
    expect(dueDateFor({ docDate: '2026-10-10', dueWording: 'due upon receipt' })).toBe('2026-10-10');
  });
});

describe('money', () => {
  const inv = doc('d', 'deposit-invoice', 'INV-Q100-D', '2026-10-02', 30000, { dueWording: 'Before works start' });
  const bal = doc('b', 'balance-invoice', 'INV-Q100-B', '2026-10-08', 70000, { dueWording: 'Payment is due upon receipt of this invoice' });

  it('works out a job balance from stored totals and recorded payments', () => {
    const b = jobBalance(depositJob({ documents: [doc('q', 'quotation', 'Q100', '2026-10-01', 100000), inv, bal], payments: [pay('p1', 'd', 30000, '2026-10-03'), pay('p2', 'b', 1000, '2026-10-09')] }), TODAY)!;
    expect(b).toMatchObject({ quotedPence: 100000, invoicedPence: 100000, receivedPence: 31000, outstandingPence: 69000, toInvoicePence: 0, awaitingDeposit: false, awaitingBalance: true, overdue: true, settled: false });
    expect(b.invoices[0]).toMatchObject({ part: 'Deposit', settled: true, dueOn: null, overdue: false });
    expect(b.invoices[1]).toMatchObject({ part: 'Balance', dueOn: '2026-10-08', overdue: true, daysOverdue: 7 });
  });

  it('overdue compares London dates: due today is not overdue', () => {
    const due = doc('b', 'balance-invoice', 'INV-Q100-B', TODAY, 70000, { dueWording: 'due upon receipt' });
    const b = jobBalance(depositJob({ documents: [doc('q', 'quotation', 'Q100', '2026-10-01', 100000), due] }), TODAY)!;
    expect(b.overdue).toBe(false);
    expect(jobBalance(depositJob({ documents: [doc('q', 'quotation', 'Q100', '2026-10-01', 100000), due] }), '2026-10-16')!.overdue).toBe(true);
  });

  it('an invoice counted from completion is not overdue and asks to be checked', () => {
    const odd = doc('b', 'balance-invoice', 'INV-Q100-B', '2026-09-01', 70000, { dueWording: 'Payment within 14 days of completion' });
    const b = jobBalance(depositJob({ documents: [doc('q', 'quotation', 'Q100', '2026-10-01', 100000), odd] }), TODAY)!;
    expect(b.invoices[0]).toMatchObject({ dueOn: null, dueCheck: true, overdue: false });
    expect(b.overdue).toBe(false);
  });

  it('job outstanding is the sum of each invoice, so an overpaid invoice never hides an unpaid one', () => {
    const j = depositJob({ documents: [doc('q', 'quotation', 'Q100', '2026-10-01', 100000), inv, bal], payments: [pay('p1', 'd', 40000, '2026-10-03')] });
    const b = jobBalance(j, TODAY)!;
    expect(b.receivedPence).toBe(40000);
    expect(b.outstandingPence).toBe(70000); // not 100000 - 40000
    expect(b.invoices[0].settled).toBe(true);
    const totals = summariseInvoices([{ docDate: '2026-10-02', grossPence: 30000, paidPence: 40000, dueWording: null }, { docDate: '2026-10-08', grossPence: 70000, paidPence: 0, dueWording: 'due upon receipt' }], TODAY);
    expect(totals).toEqual({ anyInvoices: true, outstandingPence: 70000, overdueInvoices: 1 });
    const all = buildBalances([j], TODAY);
    expect(all.outstandingPence).toBe(totals.outstandingPence);
    expect(all.overdueInvoices).toBe(totals.overdueInvoices);
  });

  it('settled only when every part is invoiced and paid', () => {
    const j = depositJob({ documents: [doc('q', 'quotation', 'Q100', '2026-10-01', 100000), inv], payments: [pay('p1', 'd', 30000, '2026-10-03')] });
    expect(jobBalance(j, TODAY)!.settled).toBe(false);
    const full = { ...j, documents: [...j.documents, bal], payments: [...j.payments, pay('p2', 'b', 70000, '2026-10-09')] };
    expect(jobBalance(full, TODAY)!.settled).toBe(true);
    const all = buildBalances([j, { ...full, jobId: 'j9' }], TODAY, 'settled');
    expect(all.rows.map((r) => r.jobId)).toEqual(['j9']);
    expect(all.counts).toMatchObject({ all: 2, settled: 1, deposit: 0, balance: 0 });
    expect(overdueJobIds([j], TODAY).size).toBe(0);
  });

  it('jobs with no issued quote and no invoices make no rows and no claim of data', () => {
    const b = buildBalances([depositJob({ quote: null })], TODAY);
    expect(b.rows).toEqual([]);
    expect(b.anyInvoices).toBe(false);
  });

  it('payments log and running totals for the month and year', () => {
    const j = depositJob({ documents: [doc('q', 'quotation', 'Q100', '2026-10-01', 100000), inv, bal], payments: [pay('p1', 'd', 30000, '2026-09-30'), pay('p2', 'b', 5000, '2026-10-09', 'cash'), pay('p3', 'b', 100, '2025-12-31')] });
    const rows = paymentRows([j]);
    expect(rows.map((r) => r.id)).toEqual(['p2', 'p1', 'p3']);
    expect(rows[0]).toMatchObject({ part: 'Balance', invoiceNumber: 'INV-Q100-B', instalment: 2 });
    expect(paymentTotals(rows, '2026-10')).toEqual({ monthPence: 5000, yearPence: 35000, monthCount: 1, yearCount: 2 });
  });

  it('property: totals always equal the sum of what was recorded, outstanding never negative', () => {
    let s = 99;
    const r = () => ((s = (s * 48271) % 2147483647) / 2147483647);
    for (let n = 0; n < 400; n += 1) {
      const net = 1000 + Math.floor(r() * 5_000_000);
      const gross = net + Math.round((net * 2000) / 10000);
      const plan: PaymentPlan = r() < 0.5 ? { kind: 'deposit', pctBp: 1000 + 50 * Math.floor(r() * 160) } : { kind: 'staged', stages: [{ label: 'A', mode: 'pct', pctBp: 2500 }, { label: 'B', mode: 'pct', pctBp: 2500 }, { label: 'C', mode: 'pct', pctBp: 5000 }] };
      const sched = buildSchedule({ netPence: net, vatPence: gross - net, grossPence: gross } as never, plan);
      const kind = plan.kind;
      const docs: FactDocument[] = [doc('q', 'quotation', 'Q1', '2026-09-01', gross)];
      const pays: FactPayment[] = [];
      let paid = 0;
      for (const i of sched) {
        if (r() < 0.3) break;
        const type: DocType = kind === 'deposit' ? (i.index === 1 ? 'deposit-invoice' : 'balance-invoice') : 'invoice-stage';
        const number = kind === 'deposit' ? (i.index === 1 ? 'INV-Q1-D' : 'INV-Q1-B') : `INV-Q1-S${i.index}`;
        docs.push(doc(`i${i.index}`, type, number, '2026-09-02', i.grossPence, { dueWording: r() < 0.5 ? 'due upon receipt' : null }));
        let left = i.grossPence;
        while (left > 0 && r() < 0.7) {
          // Now and then an overpayment (a payment recorded by hand can be more than the invoice).
          const amt = r() < 0.1 ? left + 1 + Math.floor(r() * 5000) : Math.max(1, Math.min(left, Math.floor(r() * i.grossPence)));
          pays.push(pay(`p${pays.length}`, `i${i.index}`, amt, `2026-${r() < 0.5 ? '09' : '10'}-0${1 + Math.floor(r() * 9)}`));
          left -= amt;
          paid += amt;
        }
      }
      const job: JobFacts = { ...depositJob(), quoteNumber: 'Q1', planKind: kind, quote: { documentId: 'q', issuedAt: '2026-09-01T00:00:00Z', grossPence: gross, schedule: sched.map((x) => ({ index: x.index, label: x.label, grossPence: x.grossPence })) }, documents: docs, payments: pays };
      const b = jobBalance(job, TODAY)!;
      const invoiced = docs.filter((d) => d.type !== 'quotation').reduce((t, d) => t + (d.totalPence ?? 0), 0);
      expect(b.invoicedPence).toBe(invoiced);
      expect(b.receivedPence).toBe(paid);
      const perInvoice = docs.filter((d) => d.type !== 'quotation').reduce((t, d) => t + Math.max(0, (d.totalPence ?? 0) - pays.filter((p) => p.documentId === d.id).reduce((x, p) => x + p.amountPence, 0)), 0);
      expect(b.outstandingPence).toBe(perInvoice);
      expect(b.outstandingPence).toBeGreaterThanOrEqual(Math.max(0, invoiced - paid));
      const strip = summariseInvoices(b.invoices.map((i) => ({ docDate: i.issuedOn, grossPence: i.grossPence, paidPence: i.receivedPence, dueWording: i.dueWording })), TODAY);
      expect(strip.outstandingPence).toBe(b.outstandingPence);
      expect(strip.overdueInvoices).toBe(b.invoices.filter((i) => i.overdue).length);
      expect(b.toInvoicePence).toBe(gross - invoiced);
      expect(b.invoices.every((i) => i.outstandingPence >= 0 && i.settled === (i.receivedPence >= i.grossPence))).toBe(true);
      const rows = paymentRows([job]);
      const t = paymentTotals(rows, '2026-10');
      expect(t.yearPence).toBe(paid);
      expect(t.monthPence).toBe(pays.filter((p) => p.paidOn.startsWith('2026-10')).reduce((x, p) => x + p.amountPence, 0));
      const pc = pipelineCard(job, opts)!;
      expect(pc.valuePence).toBe(gross);
    }
  });

  it('the CSV export is exactly the visible rows, and the month never runs into the future', () => {
    const j = depositJob({ customerName: '=cmd|calc', documents: [doc('q', 'quotation', 'Q100', '2026-10-01', 100000), inv], payments: [pay('p1', 'd', 30000, '2026-10-03')] });
    const p = parseMoneyParams({ view: 'payments', m: '2099-01' }, TODAY);
    expect(p.month).toBe('2026-10');
    const csv = moneyCsv(moneyView([j], p, TODAY));
    expect(csv.filename).toBe('payments-received-2026-10.csv');
    expect(csv.body).toContain(`"'=cmd|calc"`);
    expect(csv.body.split('\r\n').filter(Boolean)).toHaveLength(2);
    const bal = moneyCsv(moneyView([j], parseMoneyParams({ f: 'overdue' }, TODAY), TODAY));
    expect(bal.body.split('\r\n').filter(Boolean)).toHaveLength(1); // header only: nothing overdue
  });
});

describe('guarantees', () => {
  it('lists issued certificates with years and expiry year, never a guess', () => {
    const j = depositJob({ documents: [doc('g1', 'guarantee', 'GUA-1', '2016-03-24', null, { guaranteeYears: 10, certificateNo: 'GUA-1' }), doc('g2', 'guarantee', 'GUA-2', '2026-07-10', null), { ...doc('g3', 'guarantee', 'GUA-3', '2026-07-10', null), status: 'draft' }] });
    const rows = guaranteeRows([j]);
    expect(rows.map((r) => [r.certificateNo, r.years, r.expiryYear])).toEqual([['GUA-2', null, null], ['GUA-1', 10, 2026]]);
    expect(filterGuarantees(rows, { filter: 'this-year', q: '', year: 2026 }).map((r) => r.certificateNo)).toEqual(['GUA-1']);
    expect(filterGuarantees(rows, { filter: 'all', q: 'road', year: 2026 })).toHaveLength(2);
    expect(filterGuarantees(rows, { filter: 'all', q: '.*', year: 2026 })).toHaveLength(0);
  });
});
