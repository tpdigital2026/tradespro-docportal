import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingError, getJobSummary, linkReceiptWith, listJobSummaries, loadJobSummariesWith, markAsPaid, recordPaymentWith, resetDemoBilling, saveFollowOnDraft, saveFollowOnDraftWith } from '../../src/lib/data/billing';
import type { DataClient } from '../../src/lib/data/customers';
import { planToJson } from '../../src/lib/payment-plan';
import { emptyQuoteForm } from '../../src/lib/validation/quote';

type Row = Record<string, unknown>;

function fakeClient(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = { ...seed };
  let n = 0;
  const client: DataClient = {
    from(table: string) {
      const t = (tables[table] ??= []);
      const filters: ((r: Row) => boolean)[] = [];
      let op: 'select' | 'insert' | 'update' = 'select';
      let payload: Row = {};
      let limit = Infinity;
      const run = () => {
        if (op === 'insert') {
          const row = { id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, ...payload };
          t.push(row);
          return { data: [row], error: null };
        }
        const hit = t.filter((r) => filters.every((f) => f(r)));
        if (op === 'update') {
          hit.forEach((r) => Object.assign(r, payload));
          return { data: hit.map((r) => ({ id: r.id })), error: null };
        }
        return { data: hit.slice(0, limit), error: null };
      };
      const b: Record<string, unknown> = {
        select: () => b,
        insert: (p: Row) => ((op = 'insert'), (payload = p), b),
        update: (p: Row) => ((op = 'update'), (payload = p), b),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
        in: (c: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[c])), b),
        order: () => b,
        limit: (x: number) => ((limit = x), b),
        single: () => Promise.resolve({ data: (run().data as Row[])[0] ?? null, error: null }),
        maybeSingle: () => Promise.resolve({ data: (run().data as Row[])[0] ?? null, error: null }),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
      };
      return b;
    },
  };
  return { client, tables };
}

const J1 = '10000000-0000-4000-8000-000000000001';
const J2 = '10000000-0000-4000-8000-000000000002';
const C1 = '20000000-0000-4000-8000-000000000001';
const Q1 = '30000000-0000-4000-8000-000000000001';
const D1 = '40000000-0000-4000-8000-000000000001';
const Q2 = '30000000-0000-4000-8000-000000000002';
const V1 = '50000000-0000-4000-8000-000000000001';

const form = { ...emptyQuoteForm({ date: '2026-10-14', vatApplies: true }), quoteNumber: 'QT-9', customerId: C1, price: '10000', scopeNotes: 'x' };

function seed(over: Record<string, Row[]> = {}) {
  return fakeClient({
    tenant_defaults: [{ vat_default: true, vat_rate_bp: 2000, deposit_pct_bp: 3000 }],
    jobs: [
      { id: J1, reference: 'QT-9', customer_id: C1, property_address: '1 Test Road', payment_plan: planToJson({ kind: 'deposit', pctBp: 3000 }) },
      { id: J2, reference: 'QT-10', customer_id: C1, property_address: null, payment_plan: null },
    ],
    customers: [{ id: C1, name: 'Mr Test' }],
    documents: [
      { id: Q1, job_id: J1, type: 'quotation', number: 'QT-9', status: 'final' },
      { id: D1, job_id: J1, type: 'deposit_invoice', number: 'INV-QT-9-D', status: 'final' },
      { id: Q2, job_id: J2, type: 'quotation', number: 'QT-10', status: 'draft' },
    ],
    document_versions: [{ document_id: Q1, version: 1, input: { form } }],
    payments: [{ id: 'p1', job_id: J1, document_id: D1, amount_pence: 100000, paid_on: '2026-10-10', method: 'cash', note: null, receipt_document_id: null }],
    ...over,
  });
}

describe('loadJobSummariesWith', () => {
  it('recomputes the schedule from the quote version and the plan inputs, and derives progress', async () => {
    const { client } = seed();
    const list = await loadJobSummariesWith(client);
    expect(list).toHaveLength(1); // the draft-quote job is not listed
    const j = list[0];
    expect(j).toMatchObject({ quoteNumber: 'QT-9', customerName: 'Mr Test', addressLine: '1 Test Road', problem: null });
    expect(j.billing?.instalments.map((i) => i.grossPence)).toEqual([360000, 840000]);
    expect(j.billing?.progress.steps[j.billing.progress.currentIndex].label).toBe('Deposit invoiced');
    expect(j.billing?.payments[0]).toMatchObject({ instalment: 1, amountPence: 100000 });
  });

  it('ignores stored instalments, even wrong ones', async () => {
    const stale = planToJson({ kind: 'deposit', pctBp: 3000 }, [
      { index: 1, label: 'Deposit', netPence: 1, vatPence: 1, grossPence: 2 },
      { index: 2, label: 'Balance', netPence: 1, vatPence: 1, grossPence: 2 },
    ]);
    const { client } = seed({ jobs: [{ id: J1, reference: 'QT-9', customer_id: C1, property_address: null, payment_plan: stale }] });
    const [j] = await loadJobSummariesWith(client);
    expect(j.billing?.instalments.map((i) => i.grossPence)).toEqual([360000, 840000]);
  });

  it('a single job can be asked for by reference, whatever its quote status', async () => {
    const { client } = seed();
    const [j] = await loadJobSummariesWith(client, { reference: 'QT-10' });
    expect(j.quoteNumber).toBe('QT-10');
    expect(j.billing).toBeNull();
    expect(j.problem).toMatch(/cannot work out/);
  });

  it('uses the latest version of the quote', async () => {
    // The real query asks for the newest first; the stand-in returns rows in the order given.
    const { client } = seed({
      document_versions: [
        { document_id: Q1, version: 2, input: { form: { ...form, price: '20000' } } },
        { document_id: Q1, version: 1, input: { form } },
      ],
    });
    const [j] = await loadJobSummariesWith(client);
    expect(j.billing?.totals.grossPence).toBe(2400000);
  });
});

describe('saveFollowOnDraftWith', () => {
  const content = { heading: 'Balance', netPence: 700000, vatPence: 140000, grossPence: 840000, date: '2026-10-15', paymentId: null };
  const args = { reference: 'QT-9', type: 'balance-invoice' as const, instalment: 2, number: 'INV-QT-9-B', paymentId: null };

  it('creates a draft document and version once, and is idempotent', async () => {
    const { client, tables } = seed();
    const a = await saveFollowOnDraftWith(client, 'tenant', { id: J1, quoteNumber: 'QT-9' }, args, content);
    expect(a.created).toBe(true);
    const doc = tables.documents.find((d) => d.number === 'INV-QT-9-B');
    expect(doc).toMatchObject({ type: 'balance_invoice', job_id: J1, tenant_id: 'tenant', doc_date: '2026-10-15' });
    expect(tables.document_versions.some((v) => v.document_id === doc?.id && v.version === 1)).toBe(true);
    const b = await saveFollowOnDraftWith(client, 'tenant', { id: J1, quoteNumber: 'QT-9' }, args, content);
    expect(b).toMatchObject({ created: false, documentId: a.documentId });
    expect(tables.documents.filter((d) => d.number === 'INV-QT-9-B')).toHaveLength(1);
  });
});

/** A scripted stand-in for the service connection. */
function fakeDb(opts: { invoice?: { status: string } | null; paid?: number; dup?: boolean } = {}) {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const invoice = opts.invoice === undefined ? { status: 'final', type: 'invoice_full' } : opts.invoice;
  return {
    sql,
    params,
    async query(text: string, p: unknown[] = []) {
      sql.push(text.replace(/\s+/g, ' ').trim());
      params.push(p);
      if (/from public\.documents d/.test(text)) return { rows: invoice ? [invoice] : [] };
      if (/created_at > now\(\)/.test(text)) return { rows: opts.dup ? [{ id: 'existing' }] : [] };
      if (/sum\(amount_pence\)/.test(text)) return { rows: [{ paid: String(opts.paid ?? 0) }] };
      if (/insert into public\.payments/.test(text)) return { rows: [{ id: 'new-payment' }] };
      return { rows: [] };
    },
  };
}
const actor = { tenantId: 'T', userId: 'U' };
const pay = { amountPence: 5000, paidOn: '2026-10-15', method: 'cash' as const, note: null };

describe('recordPaymentWith', () => {
  it('inserts inside a transaction with the tenant and user from the actor, and commits', async () => {
    const db = fakeDb();
    const r = await recordPaymentWith(db, actor, { jobId: 'J', invoiceId: 'I', grossPence: 10000, payment: pay });
    expect(r).toEqual({ paymentId: 'new-payment', paidPence: 5000 });
    expect(db.sql[0]).toBe('begin');
    expect(db.sql.at(-1)).toBe('commit');
    const ins = db.sql.findIndex((s) => s.startsWith('insert into public.payments'));
    expect(db.params[ins]).toEqual(['T', 'J', 'I', 5000, '2026-10-15', 'cash', null, 'U']);
    // The invoice row is locked and looked up inside the tenant and job.
    const lock = db.sql.findIndex((s) => /for update/.test(s));
    expect(db.params[lock]).toEqual(['I', 'T', 'J']);
  });

  it('never updates the invoice', async () => {
    const db = fakeDb();
    await recordPaymentWith(db, actor, { jobId: 'J', invoiceId: 'I', grossPence: 10000, payment: pay });
    expect(db.sql.some((s) => /update public\.documents/.test(s))).toBe(false);
  });

  it('refuses an invoice from another business or job (no row) and one that is not final', async () => {
    await expect(recordPaymentWith(fakeDb({ invoice: null }), actor, { jobId: 'J', invoiceId: 'I', grossPence: 10000, payment: pay })).rejects.toMatchObject({ code: 'not_found' });
    const draft = fakeDb({ invoice: { status: 'draft' } });
    await expect(recordPaymentWith(draft, actor, { jobId: 'J', invoiceId: 'I', grossPence: 10000, payment: pay })).rejects.toMatchObject({ code: 'not_payable' });
    expect(draft.sql.at(-1)).toBe('rollback');
    expect(draft.sql.some((s) => s.startsWith('insert into public.payments'))).toBe(false);
  });

  it('refuses a payment that would take the total past the invoice, using the payments already recorded', async () => {
    const db = fakeDb({ paid: 8000 });
    await expect(recordPaymentWith(db, actor, { jobId: 'J', invoiceId: 'I', grossPence: 10000, payment: pay })).rejects.toBeInstanceOf(BillingError);
    expect(db.sql.at(-1)).toBe('rollback');
    const ok = await recordPaymentWith(fakeDb({ paid: 5000 }), actor, { jobId: 'J', invoiceId: 'I', grossPence: 10000, payment: pay });
    expect(ok.paidPence).toBe(10000);
  });

  it('a double tap within 30 seconds returns the first payment instead of recording twice', async () => {
    const db = fakeDb({ dup: true, paid: 5000 });
    const r = await recordPaymentWith(db, actor, { jobId: 'J', invoiceId: 'I', grossPence: 10000, payment: pay });
    expect(r.paymentId).toBe('existing');
    expect(db.sql.some((s) => s.startsWith('insert into public.payments'))).toBe(false);
    expect(db.sql.at(-1)).toBe('commit');
  });
});

describe('linkReceiptWith', () => {
  it('links once, inside the tenant', async () => {
    const calls: unknown[][] = [];
    const db = { query: async (_t: string, p: unknown[] = []) => (calls.push(p), { rows: [{ id: 'x' }] }) };
    expect(await linkReceiptWith(db, actor, 'P', 'R')).toBe(true);
    expect(calls[0]).toEqual(['R', 'P', 'T']);
    expect(await linkReceiptWith({ query: async () => ({ rows: [] }) }, actor, 'P', 'R')).toBe(false);
  });
});

describe('demo mode', () => {
  beforeEach(() => {
    vi.stubEnv('DEMO_MODE', '1');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VERCEL', undefined as unknown as string);
    resetDemoBilling();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetDemoBilling();
  });
  const today = new Date().toISOString().slice(0, 10);

  it('lists the three shapes', async () => {
    const list = await listJobSummaries();
    expect(list.map((j) => j.billing?.kind)).toEqual(['deposit', 'full', 'staged']);
  });

  it('marking the full invoice paid moves the job on and offers a receipt', async () => {
    const r = await markAsPaid('DEMO-3002', 1, { amount: '2220', paidOn: today, method: 'bank transfer', note: '' });
    expect(r.remainingPence).toBe(0);
    const j = await getJobSummary('DEMO-3002');
    expect(j?.billing?.progress.steps[j.billing.progress.currentIndex].label).toBe('Paid in full');
    expect(j?.billing?.progress.receiptsDue).toEqual([1]);
    expect(j?.billing?.documents.find((d) => d.type === 'invoice-full')?.status).toBe('final'); // the invoice itself is untouched
  });

  it('a part payment leaves the rest owing; over-paying and a missing invoice are refused', async () => {
    const part = await markAsPaid('DEMO-3002', 1, { amount: '1000', paidOn: today, method: 'cash', note: '' });
    expect(part.remainingPence).toBe(122000);
    await expect(markAsPaid('DEMO-3002', 1, { amount: '1220.01', paidOn: today, method: 'cash', note: '' })).rejects.toMatchObject({ code: 'invalid', errors: { amount: expect.any(String) } });
    await expect(markAsPaid('DEMO-3001', 2, { amount: '10', paidOn: today, method: 'cash', note: '' })).rejects.toMatchObject({ code: 'not_payable' }); // balance not raised
    await expect(markAsPaid('DEMO-9999', 1, { amount: '10', paidOn: today, method: 'cash', note: '' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(markAsPaid('DEMO-3002', 1, { amount: '10', paidOn: '2999-01-01', method: 'cash', note: '' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('a repeated identical payment is recorded once', async () => {
    const f = { amount: '100', paidOn: today, method: 'cash', note: '' };
    const a = await markAsPaid('DEMO-3002', 1, f);
    const b = await markAsPaid('DEMO-3002', 1, f);
    expect(b.paymentId).toBe(a.paymentId);
    expect((await getJobSummary('DEMO-3002'))?.billing?.payments).toHaveLength(1);
  });

  it('saving a receipt draft links it to its payment and clears the receipt due', async () => {
    expect((await getJobSummary('DEMO-3003'))?.billing?.progress.receiptsDue).toEqual([2, 3]);
    const saved = await saveFollowOnDraft('DEMO-3003', 'receipt', 2, null);
    expect(saved).toMatchObject({ number: 'RCP-DEMO-3003-S2', created: true });
    expect((await getJobSummary('DEMO-3003'))?.billing?.progress.receiptsDue).toEqual([3]);
    expect((await saveFollowOnDraft('DEMO-3003', 'receipt', 2, null)).created).toBe(false);
  });

  it('a stage invoice draft takes the number from the schedule', async () => {
    const saved = await saveFollowOnDraft('DEMO-3003', 'invoice-stage', 4, null);
    expect(saved.number).toBe('INV-DEMO-3003-S4');
    await expect(saveFollowOnDraft('DEMO-3001', 'invoice-stage', 1, null)).rejects.toMatchObject({ code: 'invalid' });
  });
});
