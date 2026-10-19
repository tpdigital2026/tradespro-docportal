import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingError, getJobSummary, listJobSummaries, loadJobSummariesWith, markAsPaid, recordPaymentWith, resetDemoBilling, saveFollowOnDraft, saveFollowOnWith } from '../../src/lib/data/billing';
import type { DataClient } from '../../src/lib/data/customers';
import { planToJson } from '../../src/lib/payment-plan';
import { emptyQuoteForm } from '../../src/lib/validation/quote';
import { approvedScope } from '../fixtures/scope';

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

const form = { ...emptyQuoteForm({ date: '2026-10-14', vatApplies: true }), quoteNumber: 'QT-9', customerId: C1, price: '10000', scope: approvedScope() };

function seed(over: Record<string, Row[]> = {}) {
  return fakeClient({
    tenant_defaults: [{ vat_default: true, vat_rate_bp: 2000, deposit_pct_bp: 3000 }],
    jobs: [
      { id: J1, reference: 'QT-9', customer_id: C1, property_address: '1 Test Road', payment_plan: planToJson({ kind: 'deposit', pctBp: 3000 }) },
      { id: J2, reference: 'QT-10', customer_id: C1, property_address: null, payment_plan: null },
    ],
    customers: [{ id: C1, name: 'Mr Test' }],
    documents: [
      { id: Q1, job_id: J1, type: 'quotation', number: 'QT-9', status: 'final', current_version_id: V1 },
      { id: D1, job_id: J1, type: 'deposit_invoice', number: 'INV-QT-9-D', status: 'final' },
      { id: Q2, job_id: J2, type: 'quotation', number: 'QT-10', status: 'draft' },
    ],
    document_versions: [{ id: V1, document_id: Q1, version: 1, input: { form } }],
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

  it('works at the VAT rate stored with the issued version (current_version_id), not today\'s setting or another row', async () => {
    const V2 = '50000000-0000-4000-8000-000000000002';
    const { client } = seed({
      tenant_defaults: [{ vat_default: true, vat_rate_bp: 0, deposit_pct_bp: 3000 }],
      documents: [
        { id: Q1, job_id: J1, type: 'quotation', number: 'QT-9', status: 'final', current_version_id: V1 },
        { id: D1, job_id: J1, type: 'deposit_invoice', number: 'INV-QT-9-D', status: 'final' },
      ],
      document_versions: [
        // A newer row (listed first) carrying a different rate must not be the one used.
        { id: V2, document_id: Q1, version: 2, input: { form }, final_content: { content: { input: { vatRateBp: 500 } } } },
        { id: V1, document_id: Q1, version: 1, input: { form }, final_content: { content: { input: { vatRateBp: 2000 } } } },
      ],
    });
    const [j] = await loadJobSummariesWith(client);
    expect(j.billing?.totals.grossPence).toBe(1200000);
  });

  it('a single job can be asked for by reference, whatever its quote status', async () => {
    const { client } = seed();
    const [j] = await loadJobSummariesWith(client, { reference: 'QT-10' });
    expect(j.quoteNumber).toBe('QT-10');
    expect(j.billing).toBeNull();
    expect(j.problem).toMatch(/cannot work out/);
  });

  it('uses the version current_version_id names (always the newest)', async () => {
    const V2 = '50000000-0000-4000-8000-000000000002';
    const { client } = seed({
      documents: [
        { id: Q1, job_id: J1, type: 'quotation', number: 'QT-9', status: 'final', current_version_id: V2 },
        { id: D1, job_id: J1, type: 'deposit_invoice', number: 'INV-QT-9-D', status: 'final' },
      ],
      document_versions: [
        { id: V1, document_id: Q1, version: 1, input: { form } },
        { id: V2, document_id: Q1, version: 2, input: { form: { ...form, price: '20000' } } },
      ],
    });
    const [j] = await loadJobSummariesWith(client);
    expect(j.billing?.totals.grossPence).toBe(2400000);
  });

  it('finds the issued version however many versions other quotes have (no shared limit can push it out)', async () => {
    const Q3 = '30000000-0000-4000-8000-000000000003';
    const many = Array.from({ length: 700 }, (_, i) => ({ id: `6${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`, document_id: Q3, version: 700 - i, input: { form } }));
    const { client } = seed({
      documents: [
        { id: Q1, job_id: J1, type: 'quotation', number: 'QT-9', status: 'final', current_version_id: V1 },
        { id: D1, job_id: J1, type: 'deposit_invoice', number: 'INV-QT-9-D', status: 'final' },
        { id: Q3, job_id: J2, type: 'quotation', number: 'QT-10', status: 'final', current_version_id: many[0].id },
      ],
      document_versions: [...many, { id: V1, document_id: Q1, version: 1, input: { form }, final_content: { content: { input: { vatRateBp: 2000 } } } }],
    });
    const list = await loadJobSummariesWith(client);
    expect(list.find((j) => j.quoteNumber === 'QT-9')?.billing?.totals.grossPence).toBe(1200000);
  });
});

/** A scripted stand-in for the service connection. */
function fakeDb(opts: { invoice?: { status: string } | null; paid?: number; dup?: boolean; job?: boolean; deadlocks?: number } = {}) {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const invoice = opts.invoice === undefined ? { status: 'final', type: 'invoice_full' } : opts.invoice;
  let deadlocks = opts.deadlocks ?? 0;
  return {
    sql,
    params,
    async query(text: string, p: unknown[] = []) {
      sql.push(text.replace(/\s+/g, ' ').trim());
      params.push(p);
      if (/from public\.jobs where id = \$1 and tenant_id = \$2 for update/.test(text)) return { rows: opts.job === false ? [] : [{ id: 'J' }] };
      if (/from public\.documents d/.test(text)) {
        if (deadlocks > 0) {
          deadlocks -= 1;
          throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
        }
        return { rows: invoice ? [invoice] : [] };
      }
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
    expect(r).toEqual({ paymentId: 'new-payment', paidPence: 5000, repeat: false });
    expect(db.sql[0]).toBe('begin');
    expect(db.sql.at(-1)).toBe('commit');
    const ins = db.sql.findIndex((s) => s.startsWith('insert into public.payments'));
    expect(db.params[ins]).toEqual(['T', 'J', 'I', 5000, '2026-10-15', 'cash', null, 'U']);
    // The job row is locked first (inside the tenant), then the invoice row inside the tenant and job.
    const locks = db.sql.map((s, i) => [s, i] as const).filter(([s]) => /for update/.test(s));
    expect(locks[0][0]).toMatch(/from public\.jobs/);
    expect(db.params[locks[0][1]]).toEqual(['J', 'T']);
    expect(locks[1][0]).toMatch(/from public\.documents d/);
    expect(db.params[locks[1][1]]).toEqual(['I', 'T', 'J']);
  });

  it('locks the job before the invoice, the same order as finalise, so the two cannot deadlock', async () => {
    const db = fakeDb();
    await recordPaymentWith(db, actor, { jobId: 'J', invoiceId: 'I', grossPence: 10000, payment: pay });
    const job = db.sql.findIndex((s) => /from public\.jobs .*for update/.test(s));
    const inv = db.sql.findIndex((s) => /from public\.documents d .*for update/.test(s));
    const ins = db.sql.findIndex((s) => s.startsWith('insert into public.payments'));
    expect(job).toBeGreaterThan(0);
    expect(job).toBeLessThan(inv);
    expect(inv).toBeLessThan(ins);
  });

  it('a job from another business is refused before anything else is read', async () => {
    const db = fakeDb({ job: false });
    await expect(recordPaymentWith(db, actor, { jobId: 'J', invoiceId: 'I', grossPence: 10000, payment: pay })).rejects.toMatchObject({ code: 'not_found' });
    expect(db.sql.some((s) => /from public\.documents d/.test(s))).toBe(false);
  });

  it('retries once on a deadlock (40P01), from a fresh transaction, and gives up after a second one', async () => {
    const once = fakeDb({ deadlocks: 1 });
    const r = await recordPaymentWith(once, actor, { jobId: 'J', invoiceId: 'I', grossPence: 10000, payment: pay });
    expect(r.paymentId).toBe('new-payment');
    expect(once.sql.filter((s) => s === 'begin')).toHaveLength(2);
    expect(once.sql.filter((s) => s === 'rollback')).toHaveLength(1);
    const twice = fakeDb({ deadlocks: 2 });
    await expect(recordPaymentWith(twice, actor, { jobId: 'J', invoiceId: 'I', grossPence: 10000, payment: pay })).rejects.toMatchObject({ code: '40P01' });
    expect(twice.sql.filter((s) => s.startsWith('insert into public.payments'))).toHaveLength(0);
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
    expect(r.repeat).toBe(true);
    expect(db.sql.some((s) => s.startsWith('insert into public.payments'))).toBe(false);
    expect(db.sql.at(-1)).toBe('commit');
  });
});

/** A scripted stand-in for the service connection that records statements and can fail on one. */
function txDb(failOn?: RegExp) {
  const sql: string[] = [];
  return {
    sql,
    async query(text: string) {
      const t = text.replace(/\s+/g, ' ').trim();
      sql.push(t);
      if (failOn?.test(t)) throw Object.assign(new Error('boom'), { code: '23505' });
      if (/^select id from public\.jobs/.test(t)) return { rows: [{ id: 'J' }] };
      if (/from public\.documents where job_id/.test(t)) return { rows: [] };
      if (/insert into public\.documents/.test(t)) return { rows: [{ id: 'D', type: 'receipt' }] };
      if (/from public\.document_versions/.test(t)) return { rows: [] };
      if (/insert into public\.document_versions/.test(t)) return { rows: [{ id: 'V' }] };
      if (/from public\.payments/.test(t)) return { rows: [{ receipt_document_id: null }] };
      return { rows: [] };
    },
  };
}
const write = { jobId: 'J', type: 'receipt' as const, number: 'RCP-Q-D', instalment: 1, heading: 'Deposit', netPence: 100, vatPence: 20, grossPence: 120, date: '2026-10-15', paymentId: 'P' };

describe('saveFollowOnWith', () => {
  it('retries once on a deadlock (40P01) when it owns the transaction, never inside a caller\'s', async () => {
    let left = 1;
    const base = txDb();
    const db = {
      sql: base.sql,
      async query(text: string) {
        if (/^select id from public\.jobs/.test(text.trim()) && left > 0) {
          left -= 1;
          base.sql.push('deadlock');
          throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
        }
        return base.query(text);
      },
    };
    expect((await saveFollowOnWith(db, actor, write)).documentId).toBe('D');
    expect(db.sql.filter((s) => s === 'begin')).toHaveLength(2);
    left = 1;
    db.sql.length = 0;
    await expect(saveFollowOnWith(db, actor, write, { nested: true })).rejects.toMatchObject({ code: '40P01' });
    expect(db.sql.filter((s) => s.startsWith('savepoint'))).toHaveLength(1);
  });

  it('writes document, version, pointer and receipt link between one begin and one commit', async () => {
    const db = txDb();
    const r = await saveFollowOnWith(db, actor, write);
    expect(r).toEqual({ documentId: 'D', number: 'RCP-Q-D', created: true });
    expect(db.sql[0]).toBe('begin');
    expect(db.sql.at(-1)).toBe('commit');
    expect(db.sql.some((s) => s.startsWith('insert into public.documents'))).toBe(true);
    expect(db.sql.some((s) => s.startsWith('insert into public.document_versions'))).toBe(true);
    expect(db.sql.some((s) => s.startsWith('update public.documents set current_version_id'))).toBe(true);
    expect(db.sql.some((s) => s.startsWith('update public.payments set receipt_document_id'))).toBe(true);
  });

  it('a failure part way rolls everything back and never commits', async () => {
    const db = txDb(/insert into public\.document_versions/);
    await expect(saveFollowOnWith(db, actor, write)).rejects.toBeInstanceOf(BillingError);
    expect(db.sql.at(-1)).toBe('rollback');
    expect(db.sql).not.toContain('commit');
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
    const r = await markAsPaid('QT-BR-002', 1, { amount: '2220', paidOn: today, method: 'bank transfer', note: '' });
    expect(r.remainingPence).toBe(0);
    const j = await getJobSummary('QT-BR-002');
    expect(j?.billing?.progress.steps[j.billing.progress.currentIndex].label).toBe('Paid in full');
    expect(j?.billing?.progress.receiptsDue).toEqual([1]);
    expect(j?.billing?.documents.find((d) => d.type === 'invoice-full')?.status).toBe('final'); // the invoice itself is untouched
  });

  it('a part payment leaves the rest owing; over-paying and a missing invoice are refused', async () => {
    const part = await markAsPaid('QT-BR-002', 1, { amount: '1000', paidOn: today, method: 'cash', note: '' });
    expect(part.remainingPence).toBe(122000);
    await expect(markAsPaid('QT-BR-002', 1, { amount: '1220.01', paidOn: today, method: 'cash', note: '' })).rejects.toMatchObject({ code: 'invalid', errors: { amount: expect.any(String) } });
    await expect(markAsPaid('QT-BR-001', 2, { amount: '10', paidOn: today, method: 'cash', note: '' })).rejects.toMatchObject({ code: 'not_payable' }); // balance not raised
    await expect(markAsPaid('DEMO-9999', 1, { amount: '10', paidOn: today, method: 'cash', note: '' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(markAsPaid('QT-BR-002', 1, { amount: '10', paidOn: '2999-01-01', method: 'cash', note: '' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('a repeated identical payment within 30 seconds is recorded once and flagged as a repeat', async () => {
    const f = { amount: '100', paidOn: today, method: 'cash', note: '' };
    const a = await markAsPaid('QT-BR-002', 1, f);
    const b = await markAsPaid('QT-BR-002', 1, f);
    expect(a.repeat).toBe(false);
    expect(b.repeat).toBe(true);
    expect(b.paymentId).toBe(a.paymentId);
    expect((await getJobSummary('QT-BR-002'))?.billing?.payments).toHaveLength(1);
  });

  it('saving a receipt draft links it to its payment and clears the receipt due', async () => {
    expect((await getJobSummary('QT-BR-003'))?.billing?.progress.receiptsDue).toEqual([2, 3]);
    const saved = await saveFollowOnDraft('QT-BR-003', 'receipt', 2, null);
    expect(saved).toMatchObject({ number: 'RCP-BR-003-S2', created: true });
    expect((await getJobSummary('QT-BR-003'))?.billing?.progress.receiptsDue).toEqual([3]);
    // Its payment is linked now, so there is no second receipt for it.
    await expect(saveFollowOnDraft('QT-BR-003', 'receipt', 2, null)).rejects.toMatchObject({ code: 'invalid' });
    expect((await saveFollowOnDraft('QT-BR-003', 'receipt', 2, 'demo-payment-3003-2')).created).toBe(false);
  });

  it('the same payment is a new one after the 30 second window', async () => {
    const f = { amount: '100', paidOn: today, method: 'cash', note: '' };
    const a = await markAsPaid('QT-BR-002', 1, f);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 31_000 });
    try {
      const b = await markAsPaid('QT-BR-002', 1, f);
      expect(b.repeat).toBe(false);
      expect(b.paymentId).not.toBe(a.paymentId);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stage invoice draft takes the number from the schedule', async () => {
    const saved = await saveFollowOnDraft('QT-BR-003', 'invoice-stage', 4, null);
    expect(saved.number).toBe('INV-BR-003-S4');
    await expect(saveFollowOnDraft('QT-BR-001', 'invoice-stage', 1, null)).rejects.toMatchObject({ code: 'invalid' });
  });
});
