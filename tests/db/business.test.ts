import { describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { actAs, actAsServer, createTenantWithUser, dbAvailable, withRollback } from './helpers';
import { loadBusinessFactsSql, loadInvoiceTotalsSql } from '../../src/lib/data/business';
import { listAppointmentsSql, linkOptionsSql, getAppointmentSql } from '../../src/lib/data/appointments';
import { buildBalances, summariseInvoices } from '../../src/lib/business/money-board';
import { buildPipeline } from '../../src/lib/business/pipeline';
import { guaranteeRows } from '../../src/lib/business/guarantees';
import { nextStepHref } from '../../src/lib/job-stage';

async function expectFail(c: Client, sql: string, params: unknown[], pattern: RegExp): Promise<void> {
  await c.query('savepoint x');
  try {
    await expect(c.query(sql, params), sql).rejects.toThrow(pattern);
  } finally {
    await c.query('rollback to savepoint x');
  }
}

/** A business with one customer and a deposit job whose quote was issued with a stored schedule, an issued deposit invoice and a payment. */
async function business(c: Client, name: string, ref: string) {
  const t = await createTenantWithUser(c, name);
  const cust = await c.query(`insert into public.customers (tenant_id, name) values ($1, $2) returning id`, [t.tenantId, `${name} Customer`]);
  const job = await c.query(
    `insert into public.jobs (tenant_id, customer_id, reference, property_address, payment_plan) values ($1, $2, $3, '1 Test Road', '{"kind":"deposit","pct_bp":3000}') returning id`,
    [t.tenantId, cust.rows[0].id, ref],
  );
  const jobId = job.rows[0].id as string;
  const q = await c.query(`insert into public.documents (tenant_id, job_id, type, number, doc_date, status, total_pence, finalised_at) values ($1, $2, 'quotation', $3, '2026-10-01', 'final', 120000, '2026-10-01T09:00:00Z') returning id`, [t.tenantId, jobId, ref]);
  const money = { netPence: 100000, vatPence: 20000, grossPence: 120000, schedule: [{ index: 1, label: 'Deposit', netPence: 30000, vatPence: 6000, grossPence: 36000 }, { index: 2, label: 'Balance', netPence: 70000, vatPence: 14000, grossPence: 84000 }] };
  const qv = await c.query(`insert into public.document_versions (tenant_id, document_id, version, money, final_content, finalised_at) values ($1, $2, 1, $3, '{}', '2026-10-01T09:00:00Z') returning id`, [t.tenantId, q.rows[0].id, JSON.stringify(money)]);
  await c.query(`update public.documents set current_version_id = $1 where id = $2`, [qv.rows[0].id, q.rows[0].id]);
  const d = await c.query(`insert into public.documents (tenant_id, job_id, type, number, doc_date, status, total_pence, finalised_at) values ($1, $2, 'deposit_invoice', $3, '2026-10-02', 'final', 36000, '2026-10-02T09:00:00Z') returning id`, [t.tenantId, jobId, `INV-${ref}-D`]);
  const dv = await c.query(
    `insert into public.document_versions (tenant_id, document_id, version, money, final_content, finalised_at) values ($1, $2, 1, '{"grossPence":36000}', $3, '2026-10-02T09:00:00Z') returning id`,
    [t.tenantId, d.rows[0].id, JSON.stringify({ content: { kind: 'deposit-invoice', input: { dueLabel: 'Before works start', customer: { name: 'Should not be read' } } } })],
  );
  await c.query(`update public.documents set current_version_id = $1 where id = $2`, [dv.rows[0].id, d.rows[0].id]);
  await c.query(`insert into public.payments (tenant_id, job_id, document_id, amount_pence, paid_on, method) values ($1, $2, $3, 36000, '2026-10-03', 'bank transfer')`, [t.tenantId, jobId, d.rows[0].id]);
  return { ...t, customerId: cust.rows[0].id as string, jobId, depositId: d.rows[0].id as string };
}

describe.skipIf(!dbAvailable)('business facts (Pipeline, Money, Guarantees)', () => {
  it('reads stored money and recorded payments for one business only', async () => {
    await withRollback(async (c) => {
      const a = await business(c, 'BizAlpha', 'BA-100');
      await business(c, 'BizBravo', 'BB-100');
      const facts = await loadBusinessFactsSql(c, a.tenantId);
      expect(facts.jobs).toHaveLength(1);
      const j = facts.jobs[0];
      expect(j).toMatchObject({ quoteNumber: 'BA-100', customerName: 'BizAlpha Customer', planKind: 'deposit', addressLine: '1 Test Road' });
      expect(j.quote).toMatchObject({ grossPence: 120000, schedule: [{ index: 1, grossPence: 36000 }, { index: 2, grossPence: 84000 }] });
      expect(j.documents.find((d) => d.type === 'deposit-invoice')).toMatchObject({ totalPence: 36000, dueWording: 'Before works start', docDate: '2026-10-02' });
      expect(j.payments).toEqual([expect.objectContaining({ amountPence: 36000, paidOn: '2026-10-03', method: 'bank transfer' })]);
      expect(JSON.stringify(facts)).not.toContain('Should not be read');

      const board = buildPipeline(facts.jobs, { today: '2026-10-15', hrefFor: nextStepHref, quoteHref: () => '' });
      expect(board.cards[0]).toMatchObject({ stage: 'part-paid', stageLabel: 'Deposit paid', valuePence: 120000, since: '2026-10-03', next: { label: 'Raise balance invoice' } });
      const money = buildBalances(facts.jobs, '2026-10-15');
      expect(money.rows[0]).toMatchObject({ quotedPence: 120000, invoicedPence: 36000, receivedPence: 36000, outstandingPence: 0, toInvoicePence: 84000 });
      expect(guaranteeRows(facts.jobs)).toEqual([]);
    });
  });

  it('a draft quote has no value and no stage; a revised quote back in draft is not issued', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'BizDraft');
      const cust = await c.query(`insert into public.customers (tenant_id, name) values ($1, 'X') returning id`, [t.tenantId]);
      const job = await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'BD-1') returning id`, [t.tenantId, cust.rows[0].id]);
      await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'quotation', 'BD-1')`, [t.tenantId, job.rows[0].id]);
      const facts = await loadBusinessFactsSql(c, t.tenantId);
      expect(facts.jobs[0]).toMatchObject({ quote: null });
      expect(facts.jobs[0].draftQuoteId).toBeTruthy();
      expect(buildPipeline(facts.jobs, { today: '2026-10-15', hrefFor: nextStepHref, quoteHref: () => '' }).cards).toEqual([]);
    });
  });

  it('reads a finalised guarantee certificate when one exists', async () => {
    await withRollback(async (c) => {
      const a = await business(c, 'BizGua', 'BG-100');
      const g = await c.query(`insert into public.documents (tenant_id, job_id, type, number, status, finalised_at) values ($1, $2, 'guarantee', 'GUA-BG-100', 'final', '2016-03-24T12:00:00Z') returning id`, [a.tenantId, a.jobId]);
      const gv = await c.query(`insert into public.document_versions (tenant_id, document_id, version, final_content, finalised_at) values ($1, $2, 1, $3, '2016-03-24T12:00:00Z') returning id`, [a.tenantId, g.rows[0].id, JSON.stringify({ content: { kind: 'guarantee', input: { years: 10, certificateNo: 'GUA-BG-100' } } })]);
      await c.query(`update public.documents set current_version_id = $1 where id = $2`, [gv.rows[0].id, g.rows[0].id]);
      const rows = guaranteeRows((await loadBusinessFactsSql(c, a.tenantId)).jobs);
      expect(rows).toEqual([expect.objectContaining({ certificateNo: 'GUA-BG-100', years: 10, issuedOn: '2016-03-24', expiryYear: 2026 })]);
    });
  });
});

describe.skipIf(!dbAvailable)('appointments', () => {
  it('owner can add, change and delete their own; the job fills in its customer', async () => {
    await withRollback(async (c) => {
      const a = await business(c, 'ApAlpha', 'AA-100');
      await actAs(c, a.userId);
      const ins = await c.query(
        `insert into public.appointments (tenant_id, kind, title, starts_at, ends_at, job_id, notes) values ($1, 'survey', 'Roof survey', '2026-07-01T08:00:00Z', '2026-07-01T09:00:00Z', $2, 'gate code') returning id, customer_id, created_by`,
        [a.tenantId, a.jobId],
      );
      expect(ins.rows[0].customer_id).toBe(a.customerId);
      expect(ins.rows[0].created_by).toBe(a.userId);
      const id = ins.rows[0].id as string;
      const upd = await c.query(`update public.appointments set title = 'Roof survey 2' where id = $1 returning updated_at > created_at as changed`, [id]);
      expect(upd.rowCount).toBe(1);
      await actAsServer(c);
      const got = await getAppointmentSql(c, a.tenantId, id);
      expect(got).toMatchObject({ title: 'Roof survey 2', customerName: 'ApAlpha Customer', quoteNumber: 'AA-100', kind: 'survey' });
      expect(await listAppointmentsSql(c, a.tenantId, new Date('2026-07-01T00:00:00Z'), new Date('2026-07-02T00:00:00Z'))).toHaveLength(1);
      expect(await listAppointmentsSql(c, a.tenantId, new Date('2026-07-02T00:00:00Z'), new Date('2026-07-03T00:00:00Z'))).toHaveLength(0);
      const links = await linkOptionsSql(c, a.tenantId);
      expect(links.jobs.map((j) => j.quoteNumber)).toEqual(['AA-100']);
      await actAs(c, a.userId);
      const del = await c.query(`delete from public.appointments where id = $1`, [id]);
      expect(del.rowCount).toBe(1);
    });
  });

  it('rules: a job of another customer, an end before the start, control characters, server columns', async () => {
    await withRollback(async (c) => {
      const a = await business(c, 'ApRules', 'AR-100');
      const other = await c.query(`insert into public.customers (tenant_id, name) values ($1, 'Other') returning id`, [a.tenantId]);
      await actAs(c, a.userId);
      const ins = `insert into public.appointments (tenant_id, kind, title, starts_at, ends_at, customer_id, job_id) values ($1, $2, $3, $4, $5, $6, $7)`;
      await expectFail(c, ins, [a.tenantId, 'site_visit', 'x', '2026-07-01T08:00:00Z', null, other.rows[0].id, a.jobId], /different customer/);
      await expectFail(c, ins, [a.tenantId, 'site_visit', 'x', '2026-07-01T08:00:00Z', '2026-07-01T07:00:00Z', null, null], /appointments_end_after_start/);
      await expectFail(c, ins, [a.tenantId, 'site_visit', 'x', '2026-07-01T08:00:00Z', '2026-07-20T08:00:00Z', null, null], /appointments_end_after_start/);
      await expectFail(c, ins, [a.tenantId, 'party', 'x', '2026-07-01T08:00:00Z', null, null, null], /check constraint/);
      await expectFail(c, ins, [a.tenantId, 'other', 'bad\nline', '2026-07-01T08:00:00Z', null, null, null], /check constraint/);
      await expectFail(c, `insert into public.appointments (tenant_id, kind, title, starts_at, created_at) values ($1, 'other', 'x', now(), now())`, [a.tenantId], /permission denied/);
      await expectFail(c, `insert into public.appointments (tenant_id, kind, title, starts_at, created_by) values ($1, 'other', 'x', now(), $2)`, [a.tenantId, a.userId], /permission denied/);
      const ok = await c.query(`insert into public.appointments (tenant_id, kind, title, starts_at) values ($1, 'other', 'x', now()) returning id`, [a.tenantId]);
      await expectFail(c, `update public.appointments set tenant_id = gen_random_uuid() where id = $1`, [ok.rows[0].id], /permission denied/);
      await expectFail(c, `update public.appointments set updated_at = now() where id = $1`, [ok.rows[0].id], /permission denied/);
    });
  });

  it('another business can neither see nor touch them, nor link to its own customers', async () => {
    await withRollback(async (c) => {
      const a = await business(c, 'ApIsoA', 'IA-100');
      const b = await business(c, 'ApIsoB', 'IB-100');
      const own = await c.query(`insert into public.appointments (tenant_id, kind, title, starts_at, customer_id) values ($1, 'other', 'A only', now(), $2) returning id`, [a.tenantId, a.customerId]);
      await actAs(c, b.userId);
      expect((await c.query(`select id from public.appointments`)).rows).toEqual([]);
      expect((await c.query(`update public.appointments set title = 'hacked' where id = $1`, [own.rows[0].id])).rowCount).toBe(0);
      expect((await c.query(`delete from public.appointments where id = $1`, [own.rows[0].id])).rowCount).toBe(0);
      await expectFail(c, `insert into public.appointments (tenant_id, kind, title, starts_at) values ($1, 'other', 'x', now())`, [a.tenantId], /row-level security/);
      // B's own row pointing at A's customer: the composite foreign key refuses it.
      await expectFail(c, `insert into public.appointments (tenant_id, kind, title, starts_at, customer_id) values ($1, 'other', 'x', now(), $2)`, [b.tenantId, a.customerId], /foreign key|violates/);
      await actAsServer(c);
      expect(await listAppointmentsSql(c, b.tenantId, new Date('2000-01-01'), new Date('2100-01-01'))).toEqual([]);
      expect((await c.query(`select title from public.appointments where id = $1`, [own.rows[0].id])).rows[0].title).toBe('A only');
    });
  });

  it('booking extends the customer retention, and erasing the customer erases their appointments', async () => {
    await withRollback(async (c) => {
      const a = await business(c, 'ApErase', 'AE-100');
      await c.query(`update public.customers set purge_at = now() + interval '2 days' where id = $1`, [a.customerId]);
      await c.query(`insert into public.appointments (tenant_id, kind, title, starts_at, customer_id) values ($1, 'other', 'x', now(), $2)`, [a.tenantId, a.customerId]);
      await c.query(`insert into public.appointments (tenant_id, kind, title, starts_at, job_id) values ($1, 'other', 'y', now(), $2)`, [a.tenantId, a.jobId]);
      const kept = await c.query(`select purge_at > now() + interval '80 days' as ok from public.customers where id = $1`, [a.customerId]);
      expect(kept.rows[0].ok).toBe(true);
      expect((await c.query(`select private.claim_customer($1, $2) as ok`, [a.tenantId, a.customerId])).rows[0].ok).toBe(true);
      await c.query(`select private.erase_customer($1, $2)`, [a.tenantId, a.customerId]);
      expect((await c.query(`select count(*)::int n from public.appointments where tenant_id = $1`, [a.tenantId])).rows[0].n).toBe(0);
    });
  });

  it('unlinked appointments: the clock is the latest of created, updated and the appointment itself, plus retention', async () => {
    await withRollback(async (c) => {
      const a = await business(c, 'ApPurge', 'AP-100');
      await c.query(`insert into public.tenant_defaults (tenant_id, retention_days) values ($1, 30)`, [a.tenantId]);
      const ins = `insert into public.appointments (tenant_id, kind, title, starts_at, ends_at, customer_id, created_at, updated_at) values ($1, 'other', $2, $3::timestamptz, $4::timestamptz, $5, $6::timestamptz, $7::timestamptz)`;
      const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
      await c.query(ins, [a.tenantId, 'old', ago(40), null, null, ago(45), ago(45)]); // everything 40+ days ago: goes
      await c.query(ins, [a.tenantId, 'edited lately', ago(40), null, null, ago(45), ago(5)]); // changed 5 days ago: stays
      await c.query(ins, [a.tenantId, 'made lately', ago(40), null, null, ago(10), ago(10)]); // typed in 10 days ago about an old visit: stays
      await c.query(ins, [a.tenantId, 'long job', ago(33), ago(20), null, ago(60), ago(60)]); // ended 20 days ago: stays
      await c.query(ins, [a.tenantId, 'future', ago(-400), null, null, ago(60), ago(60)]); // not happened yet: stays
      await c.query(ins, [a.tenantId, 'linked old', ago(40), null, a.customerId, ago(45), ago(45)]); // linked: the customer's purge decides
      const n = await c.query(`select private.purge_unlinked_appointments(now()) as n`);
      expect(n.rows[0].n).toBe(1);
      const left = await c.query(`select title from public.appointments where tenant_id = $1 order by title`, [a.tenantId]);
      expect(left.rows.map((r) => r.title)).toEqual(['edited lately', 'future', 'linked old', 'long job', 'made lately']);
      // A date in the future passed by the caller can never bring the purge forward.
      await c.query(`select private.purge_unlinked_appointments(now() + interval '10 years')`);
      expect((await c.query(`select count(*)::int n from public.appointments where tenant_id = $1`, [a.tenantId])).rows[0].n).toBe(5);
      await actAs(c, a.userId);
      await expectFail(c, `select private.purge_unlinked_appointments(now())`, [], /permission denied/);
    });
  });

  it('a customer with an appointment further out than the retention period is kept until after it', async () => {
    await withRollback(async (c) => {
      const a = await business(c, 'ApFuture', 'AF-100');
      await c.query(`insert into public.tenant_defaults (tenant_id, retention_days) values ($1, 90)`, [a.tenantId]);
      await c.query(`update public.customers set purge_at = now() + interval '1 day' where id = $1`, [a.customerId]);
      await actAs(c, a.userId);
      const appt = await c.query(`insert into public.appointments (tenant_id, kind, title, starts_at, ends_at, customer_id) values ($1, 'job_start', 'Booked far ahead', now() + interval '400 days', now() + interval '402 days', $2) returning id`, [a.tenantId, a.customerId]);
      await actAsServer(c);
      const after = await c.query(`select purge_at >= now() + interval '492 days' as ok, purge_at > (select ends_at from public.appointments where id = $2) as after_visit from public.customers where id = $1`, [a.customerId, appt.rows[0].id]);
      expect(after.rows[0]).toEqual({ ok: true, after_visit: true });
      // Not claimable by the purge at a time before the visit.
      const claimed = await c.query(`select id from private.claim_expired_customers(now())`);
      expect(claimed.rows.map((r) => r.id)).not.toContain(a.customerId);
      // Moving it later pushes the date out again; moving it earlier never shortens it.
      await actAs(c, a.userId);
      await c.query(`update public.appointments set starts_at = now() + interval '600 days', ends_at = null where id = $1`, [appt.rows[0].id]);
      await actAsServer(c);
      expect((await c.query(`select purge_at >= now() + interval '689 days' as ok from public.customers where id = $1`, [a.customerId])).rows[0].ok).toBe(true);
      await c.query(`update public.appointments set starts_at = now() + interval '1 day' where id = $1`, [appt.rows[0].id]);
      expect((await c.query(`select purge_at >= now() + interval '689 days' as ok from public.customers where id = $1`, [a.customerId])).rows[0].ok).toBe(true);
    });
  });

  it('the Home strip totals come from issued invoices alone and agree with the Money screen', async () => {
    await withRollback(async (c) => {
      const a = await business(c, 'ApStrip', 'AS-100');
      const lines = await loadInvoiceTotalsSql(c, a.tenantId);
      expect(lines).toEqual([{ docDate: '2026-10-02', grossPence: 36000, paidPence: 36000, dueWording: 'Before works start' }]);
      const facts = await loadBusinessFactsSql(c, a.tenantId);
      const money = buildBalances(facts.jobs, '2026-10-15');
      expect(summariseInvoices(lines, '2026-10-15')).toEqual({ anyInvoices: true, outstandingPence: money.outstandingPence, overdueInvoices: money.overdueInvoices });
      const other = await business(c, 'ApStrip2', 'AS2-100');
      expect(await loadInvoiceTotalsSql(c, other.tenantId)).toHaveLength(1);
    });
  });
});
