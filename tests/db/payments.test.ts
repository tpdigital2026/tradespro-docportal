import { describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { assertNoPersonalData } from '../../src/security/audit';
import { saveFollowOnWith } from '../../src/lib/data/billing';
import { actAs, actAsServer, dbAvailable, withRollback } from './helpers';
import { seedTenant, type SeededTenant } from './seed';

async function expectFail(c: Client, sql: string, params: unknown[], pattern: RegExp): Promise<void> {
  await c.query('savepoint x');
  try {
    await expect(c.query(sql, params), sql).rejects.toThrow(pattern);
  } finally {
    await c.query('rollback to savepoint x');
  }
}

/** The seeded job's reference is QT-{name}-001. */
const ref = (name: string) => `QT-${name}-001`;

async function doc(c: Client, a: SeededTenant, type: string, number: string, status = 'draft'): Promise<string> {
  const r = await c.query(`insert into public.documents (tenant_id, job_id, type, number, status) values ($1, $2, $3, $4, $5) returning id`, [a.tenantId, a.jobId, type, number, status]);
  return r.rows[0].id as string;
}

async function pay(c: Client, a: SeededTenant, invoiceId: string, over: Record<string, unknown> = {}): Promise<string> {
  const r = await c.query(
    `insert into public.payments (tenant_id, job_id, document_id, amount_pence, paid_on, method, note, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [a.tenantId, a.jobId, invoiceId, over.amount ?? 5000, over.paidOn ?? '2026-10-10', over.method ?? 'bank transfer', over.note ?? null, a.userId],
  );
  return r.rows[0].id as string;
}

describe.skipIf(!dbAvailable)('invoice and receipt numbers', () => {
  it('accept exactly the patterns for each type, and claim them in the registry', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const q = ref('Alpha');
      const good: [string, string][] = [
        ['deposit_invoice', `INV-${q}-D`],
        ['balance_invoice', `INV-${q}-B`],
        ['invoice_full', `INV-${q}`],
        ['invoice_stage', `INV-${q}-S1`],
        ['invoice_stage', `INV-${q}-S10`],
        ['receipt', `RCP-${q}-D`],
        ['receipt', `RCP-${q}-B`],
        ['receipt', `RCP-${q}`],
        ['receipt', `RCP-${q}-S7`],
        ['receipt', `RCP-${q}-S7-P2`],
        ['receipt', `RCP-${q}-D-P3`],
        ['receipt', `RCP-${q}-P99`],
        ['receipt', `RCP-${q}-S10-P99`],
        ['guarantee', `GC-${q}`],
        ['guarantee', `GC-${q}-G2`],
        ['guarantee', `GC-${q}-G20`],
        ['survey_report', `SR-${q}`], // migration 020: a survey report is numbered after its job
      ];
      for (const [type, number] of good) {
        await doc(c, a, type, number);
        const used = await c.query(`select 1 from public.used_numbers where tenant_id = $1 and number = $2`, [a.tenantId, number]);
        expect(used.rowCount, number).toBe(1);
      }
    });
  });

  it('refuse numbers that do not match the job and type', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const q = ref('Alpha');
      const bad: [string, string][] = [
        ['deposit_invoice', `INV-${q}`],
        ['deposit_invoice', `INV-${q}-B`],
        ['balance_invoice', `INV-${q}-D`],
        ['invoice_full', `INV-${q}-D`],
        ['invoice_stage', `INV-${q}-S0`],
        ['invoice_stage', `INV-${q}-S11`],
        ['invoice_stage', `INV-${q}-S01`],
        ['invoice_stage', `INV-${q}-S`],
        ['invoice_stage', `INV-${q}`],
        ['invoice_full', 'INV-QT-Other-001'],
        ['invoice_full', `INV-${q}x`],
        ['receipt', `RCP-${q}-X`],
        ['receipt', `INV-${q}-D`],
        ['receipt', `RCP-${q}-S11`],
        ['receipt', `RCP-${q}-S7-2`],
        ['receipt', `RCP-${q}-S7-P1`],
        ['receipt', `RCP-${q}-S7-P100`],
        ['receipt', `RCP-${q}-S7-P02`],
        ['receipt', `RCP-${q}-D-P0`],
        ['receipt', `RCP-${q}-X-P2`],
        ['receipt', `RCP-${q}-99`],
        ['receipt', 'RCP-QT-Other-001'],
        ['invoice_full', `inv-${q}`],
      ];
      for (const [type, number] of bad) await expectFail(c, `insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, $3, $4)`, [a.tenantId, a.jobId, type, number], /does not match its job and document type/);
    });
  });

  it('a forty character quote number still fits with the longest suffix', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const q = 'Q'.repeat(40);
      const job = await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, $3) returning id`, [a.tenantId, a.customerId, q]);
      const number = `INV-${q}-S10`;
      expect(number.length).toBe(48);
      await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'invoice_stage', $3)`, [a.tenantId, job.rows[0].id, number]);
    });
  });

  it('a number is claimed forever: it cannot be reused, even after the document is gone, and cannot be changed', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const q = ref('Alpha');
      const id = await doc(c, a, 'invoice_full', `INV-${q}`);
      await expectFail(c, `update public.documents set number = $2 where id = $1`, [id, `INV-${q}-D`], /cannot be changed/);
      await c.query(`delete from public.documents where id = $1`, [id]);
      await expectFail(c, `insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'invoice_full', $3)`, [a.tenantId, a.jobId, `INV-${q}`], /already been used/);
    });
  });

  it('the same pattern is fine in another business, and one business cannot claim in another', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo');
      await doc(c, a, 'invoice_full', `INV-${ref('Alpha')}`);
      await doc(c, b, 'invoice_full', `INV-${ref('Bravo')}`);
      await actAs(c, a.userId);
      await expectFail(c, `insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'invoice_full', $3)`, [b.tenantId, b.jobId, `INV-${ref('Bravo')}-x`], /row-level security|violates|does not match/i);
      await expectFail(c, `insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'receipt', 'RCP-nothing')`, [a.tenantId, b.jobId], /violates foreign key|row-level security/i);
    });
  });

  it('the owner can start invoice drafts through the app role, with the right number', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      const q = ref('Alpha');
      await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'invoice_stage', $3)`, [a.tenantId, a.jobId, `INV-${q}-S2`]);
      await expectFail(c, `insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'invoice_stage', $3)`, [a.tenantId, a.jobId, `INV-${q}-S2`], /already been used|duplicate/i);
      await expectFail(c, `insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'invoice_stage', 'INV-WRONG-S2')`, [a.tenantId, a.jobId], /does not match/);
    });
  });
});

describe.skipIf(!dbAvailable)('payments', () => {
  it('the app role can read its own payments and nobody else\'s, and cannot write at all', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo');
      const ia = await doc(c, a, 'invoice_full', `INV-${ref('Alpha')}`, 'final');
      const ib = await doc(c, b, 'invoice_full', `INV-${ref('Bravo')}`, 'final');
      const pa = await pay(c, a, ia);
      await pay(c, b, ib);
      await actAs(c, a.userId);
      const seen = await c.query(`select id, tenant_id from public.payments`);
      expect(seen.rows).toEqual([{ id: pa, tenant_id: a.tenantId }]);
      await expectFail(c, `insert into public.payments (tenant_id, job_id, document_id, amount_pence, paid_on, method) values ($1, $2, $3, 100, '2026-10-10', 'cash')`, [a.tenantId, a.jobId, ia], /permission denied/);
      await expectFail(c, `update public.payments set amount_pence = 1 where id = $1`, [pa], /permission denied/);
      await expectFail(c, `delete from public.payments where id = $1`, [pa], /permission denied/);
      await actAsServer(c);
      await c.query('set local role anon');
      await expectFail(c, `select 1 from public.payments`, [], /permission denied/);
    });
  });

  it('rls is enabled and forced, and a disabled person sees nothing', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const rls = await c.query(`select relrowsecurity, relforcerowsecurity from pg_class where oid = 'public.payments'::regclass`);
      expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const inv = await doc(c, a, 'invoice_full', `INV-${ref('Alpha')}`, 'final');
      await pay(c, a, inv);
      await c.query(`update public.profiles set disabled_at = now() where id = $1`, [a.userId]);
      await actAs(c, a.userId);
      expect((await c.query(`select 1 from public.payments`)).rowCount).toBe(0);
    });
  });

  it('records a payment against a final invoice, and writes an audit entry with ids and the amount only', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const inv = await doc(c, a, 'invoice_full', `INV-${ref('Alpha')}`, 'final');
      const id = await pay(c, a, inv, { amount: 123456, method: 'cheque', note: 'cheque 1042' });
      const row = await c.query(`select amount_pence, method, note, created_by from public.payments where id = $1`, [id]);
      expect(row.rows[0]).toMatchObject({ method: 'cheque', note: 'cheque 1042', created_by: a.userId });
      expect(Number(row.rows[0].amount_pence)).toBe(123456);
      const audit = await c.query(`select user_id, action, entity, entity_id, meta from public.audit_log where action = 'payment.record' and tenant_id = $1`, [a.tenantId]);
      expect(audit.rowCount).toBe(1);
      const e = audit.rows[0];
      expect(e).toMatchObject({ user_id: a.userId, entity: 'payment', entity_id: id.replace(/-/g, '') });
      expect(e.meta).toEqual({ job: a.jobId.replace(/-/g, ''), invoice: inv.replace(/-/g, ''), amountPence: 123456, method: 'cheque' });
      expect(JSON.stringify(e.meta)).not.toContain('cheque 1042'); // the free-text note stays out of the audit trail
      expect(() => assertNoPersonalData(e.meta)).not.toThrow();
    });
  });

  it('the owner reads the entry through the app role (owners can see the audit trail)', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const inv = await doc(c, a, 'invoice_full', `INV-${ref('Alpha')}`, 'final');
      await pay(c, a, inv);
      await actAs(c, a.userId);
      const r = await c.query(`select count(*)::int n from public.audit_log where action = 'payment.record'`);
      expect(r.rows[0].n).toBe(1);
    });
  });

  it('refuses a draft invoice, a non-invoice, another job\'s invoice and another business\'s ids', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo');
      const draft = await doc(c, a, 'invoice_full', `INV-${ref('Alpha')}`, 'draft');
      await expectFail(c, `insert into public.payments (tenant_id, job_id, document_id, amount_pence, paid_on, method) values ($1, $2, $3, 100, '2026-10-10', 'cash')`, [a.tenantId, a.jobId, draft], /final invoice/);
      await expectFail(c, `insert into public.payments (tenant_id, job_id, document_id, amount_pence, paid_on, method) values ($1, $2, $3, 100, '2026-10-10', 'cash')`, [a.tenantId, a.jobId, a.docId], /only be recorded against an invoice/);
      const j2 = await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-SECOND-1') returning id`, [a.tenantId, a.customerId]);
      const ok = await doc(c, a, 'deposit_invoice', `INV-${ref('Alpha')}-D`, 'final');
      await expectFail(c, `insert into public.payments (tenant_id, job_id, document_id, amount_pence, paid_on, method) values ($1, $2, $3, 100, '2026-10-10', 'cash')`, [a.tenantId, j2.rows[0].id, ok], /different job/);
      const ib = await doc(c, b, 'invoice_full', `INV-${ref('Bravo')}`, 'final');
      await expectFail(c, `insert into public.payments (tenant_id, job_id, document_id, amount_pence, paid_on, method) values ($1, $2, $3, 100, '2026-10-10', 'cash')`, [a.tenantId, a.jobId, ib], /violates foreign key/);
      await expectFail(c, `insert into public.payments (tenant_id, job_id, document_id, amount_pence, paid_on, method) values ($1, $2, $3, 100, '2026-10-10', 'cash')`, [a.tenantId, b.jobId, ok], /different job|violates foreign key/);
    });
  });

  it('checks the amount, date, method and note', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const inv = await doc(c, a, 'invoice_full', `INV-${ref('Alpha')}`, 'final');
      const ins = `insert into public.payments (tenant_id, job_id, document_id, amount_pence, paid_on, method, note) values ($1, $2, $3, $4, $5, $6, $7)`;
      const base = [a.tenantId, a.jobId, inv];
      await expectFail(c, ins, [...base, 0, '2026-10-10', 'cash', null], /payments_amount_pence_check/);
      await expectFail(c, ins, [...base, -5, '2026-10-10', 'cash', null], /payments_amount_pence_check/);
      await expectFail(c, ins, [...base, 125000001, '2026-10-10', 'cash', null], /payments_amount_pence_check/);
      await expectFail(c, ins, [...base, 100, '1999-12-31', 'cash', null], /payments_paid_on_check/);
      await expectFail(c, ins, [...base, 100, '2026-10-10', 'bitcoin', null], /payments_method_check/);
      await expectFail(c, ins, [...base, 100, '2026-10-10', 'cash', 'x'.repeat(201)], /payments_note_check/);
      for (const m of ['bank transfer', 'cash', 'cheque', 'card', 'other']) await c.query(ins, [...base, 100, '2026-10-10', m, null]);
    });
  });

  it('part payments add up on the same invoice', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const inv = await doc(c, a, 'invoice_full', `INV-${ref('Alpha')}`, 'final');
      await pay(c, a, inv, { amount: 3000 });
      await pay(c, a, inv, { amount: 2000 });
      const r = await c.query(`select sum(amount_pence)::int s from public.payments where document_id = $1`, [inv]);
      expect(r.rows[0].s).toBe(5000);
    });
  });
});

describe.skipIf(!dbAvailable)('payments are immutable once a receipt is finalised', () => {
  async function withReceipt(fn: (c: Client, a: SeededTenant, paymentId: string, receiptId: string, invoiceId: string) => Promise<void>) {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const inv = await doc(c, a, 'invoice_full', `INV-${ref('Alpha')}`, 'final');
      const p = await pay(c, a, inv);
      const rec = await doc(c, a, 'receipt', `RCP-${ref('Alpha')}`, 'draft');
      await fn(c, a, p, rec, inv);
    });
  }

  it('while the receipt is a draft the server may still correct the payment; it links once', async () => {
    await withReceipt(async (c, _a, p, rec) => {
      await c.query(`update public.payments set receipt_document_id = $1 where id = $2`, [rec, p]);
      await c.query(`update public.payments set amount_pence = 4000, note = 'fixed' where id = $1`, [p]);
      expect((await c.query(`select amount_pence from public.payments where id = $1`, [p])).rows[0].amount_pence).toBe('4000');
    });
  });

  it('once the receipt is final, the payment cannot be changed or deleted', async () => {
    await withReceipt(async (c, _a, p, rec) => {
      await c.query(`update public.payments set receipt_document_id = $1 where id = $2`, [rec, p]);
      await c.query(`update public.documents set status = 'final' where id = $1`, [rec]);
      await expectFail(c, `update public.payments set amount_pence = 1 where id = $1`, [p], /cannot be changed/);
      await expectFail(c, `update public.payments set note = 'x' where id = $1`, [p], /cannot be changed/);
      await expectFail(c, `update public.payments set receipt_document_id = null where id = $1`, [p], /cannot be changed/);
      await expectFail(c, `delete from public.payments where id = $1`, [p], /cannot be deleted/);
      // The app-role cannot get round it with the purge flag either (it has no write access in the first place).
      await actAs(c, (await c.query(`select id from auth.users order by created_at desc limit 1`)).rows[0].id);
      await c.query(`select set_config('app.allow_final_delete', 'on', true)`);
      await expectFail(c, `delete from public.payments where id = $1`, [p], /permission denied/);
    });
  });

  it('a payment cannot be moved to another invoice or job', async () => {
    await withReceipt(async (c, a, p) => {
      const other = await doc(c, a, 'deposit_invoice', `INV-${ref('Alpha')}-D`, 'final');
      await expectFail(c, `update public.payments set document_id = $1 where id = $2`, [other, p], /cannot be moved/);
      await expectFail(c, `update public.payments set tenant_id = gen_random_uuid() where id = $1`, [p], /cannot be moved|violates foreign key/);
    });
  });

  it('the receipt must be a receipt of the same job, and each receipt belongs to one payment', async () => {
    await withReceipt(async (c, a, p, rec, inv) => {
      await expectFail(c, `update public.payments set receipt_document_id = $1 where id = $2`, [inv, p], /must be a receipt/);
      const j2 = await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-SECOND-1') returning id`, [a.tenantId, a.customerId]);
      const foreign = await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'receipt', 'RCP-QT-SECOND-1') returning id`, [a.tenantId, j2.rows[0].id]);
      await expectFail(c, `update public.payments set receipt_document_id = $1 where id = $2`, [foreign.rows[0].id, p], /same job/);
      await c.query(`update public.payments set receipt_document_id = $1 where id = $2`, [rec, p]);
      const p2 = await pay(c, a, inv, { amount: 100 });
      await expectFail(c, `update public.payments set receipt_document_id = $1 where id = $2`, [rec, p2], /duplicate key|payments_one_receipt/);
    });
  });

  it('erasing the customer removes the payments with it, even with a final receipt', async () => {
    await withReceipt(async (c, a, p, rec) => {
      await c.query(`update public.payments set receipt_document_id = $1 where id = $2`, [rec, p]);
      await c.query(`update public.documents set status = 'final' where id = $1`, [rec]);
      await c.query(`select private.claim_customer($1, $2)`, [a.tenantId, a.customerId]);
      const r = await c.query(`select private.erase_customer($1, $2) as n`, [a.tenantId, a.customerId]);
      expect(r.rows[0].n).toBe(1);
      expect((await c.query(`select 1 from public.payments where tenant_id = $1`, [a.tenantId])).rowCount).toBe(0);
    });
  });

  it('the new document types exist in the enum', async () => {
    await withRollback(async (c) => {
      const r = await c.query(`select enum_range(null::public.doc_type)::text as t`);
      expect(r.rows[0].t).toContain('invoice_full');
      expect(r.rows[0].t).toContain('invoice_stage');
    });
  });
});

describe.skipIf(!dbAvailable)('receipt numbers when the quote number ends in digits', () => {
  it('RCP-{q} for a job called Q-5 is a base number, and RCP-Q-5-P2 is its second receipt', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const job = await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'Q-5') returning id`, [a.tenantId, a.customerId]);
      for (const n of ['RCP-Q-5', 'RCP-Q-5-P2']) {
        await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'receipt', $3)`, [a.tenantId, job.rows[0].id, n]);
      }
      await expectFail(c, `insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'receipt', 'RCP-Q')`, [a.tenantId, job.rows[0].id], /does not match/);
    });
  });
});

describe.skipIf(!dbAvailable)('payments_immutable and the deleted user', () => {
  it('created_by may become null (the person was deleted) and nothing else may change with it, even with a final receipt', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const inv = await doc(c, a, 'invoice_full', `INV-${ref('Alpha')}`, 'final');
      const p = await pay(c, a, inv);
      const rec = await doc(c, a, 'receipt', `RCP-${ref('Alpha')}`, 'final');
      await c.query(`update public.payments set receipt_document_id = $1 where id = $2`, [rec, p]);
      await expectFail(c, `update public.payments set created_by = null, amount_pence = 1 where id = $1`, [p], /cannot be changed/);
      await c.query(`update public.payments set created_by = null where id = $1`, [p]);
      expect((await c.query(`select created_by from public.payments where id = $1`, [p])).rows[0].created_by).toBeNull();
      await expectFail(c, `update public.payments set amount_pence = 2 where id = $1`, [p], /cannot be changed/);
    });
  });

  it('deleting the user nulls created_by on their payments', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const inv = await doc(c, a, 'invoice_full', `INV-${ref('Alpha')}`, 'final');
      const p = await pay(c, a, inv);
      await c.query(`update public.profiles set disabled_at = now() where id = $1`, [a.userId]);
      await c.query(`delete from public.profiles where id = $1`, [a.userId]);
      await c.query(`delete from auth.users where id = $1`, [a.userId]);
      expect((await c.query(`select created_by from public.payments where id = $1`, [p])).rows[0].created_by).toBeNull();
    });
  });
});

describe.skipIf(!dbAvailable)('saveFollowOnWith (atomic, repairable)', () => {
  const write = (a: SeededTenant, over: Record<string, unknown> = {}) => ({
    jobId: a.jobId,
    type: 'receipt' as const,
    number: `RCP-${ref('Alpha')}`,
    instalment: 1,
    heading: 'Invoice',
    netPence: 4167,
    vatPence: 833,
    grossPence: 5000,
    date: '2026-10-15',
    paymentId: null as string | null,
    ...over,
  });
  const actor = (a: SeededTenant) => ({ tenantId: a.tenantId, userId: a.userId });

  async function counts(c: Client, a: SeededTenant, number: string) {
    const d = await c.query(`select count(*)::int n from public.documents where tenant_id = $1 and number = $2`, [a.tenantId, number]);
    const u = await c.query(`select count(*)::int n from public.used_numbers where tenant_id = $1 and number = $2`, [a.tenantId, number]);
    return { docs: d.rows[0].n as number, used: u.rows[0].n as number };
  }

  it('creates the document, version, pointer and link together, once', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const inv = await doc(c, a, 'invoice_full', `INV-${ref('Alpha')}`, 'final');
      const p = await pay(c, a, inv);
      const w = write(a, { paymentId: p });
      const r = await saveFollowOnWith(c, actor(a), w, { nested: true });
      expect(r.created).toBe(true);
      const d = await c.query(`select d.current_version_id, v.input, d.created_by from public.documents d join public.document_versions v on v.id = d.current_version_id where d.id = $1`, [r.documentId]);
      expect(d.rows[0].input.followOn).toMatchObject({ grossPence: 5000, netPence: 4167, vatPence: 833, paymentId: p });
      expect(d.rows[0].created_by).toBe(a.userId);
      expect((await c.query(`select receipt_document_id from public.payments where id = $1`, [p])).rows[0].receipt_document_id).toBe(r.documentId);
      const again = await saveFollowOnWith(c, actor(a), w, { nested: true });
      expect(again).toMatchObject({ created: false, documentId: r.documentId });
      expect((await c.query(`select count(*)::int n from public.document_versions where document_id = $1`, [r.documentId])).rows[0].n).toBe(1);
    });
  });

  it('a failure burns no number and leaves no half-written draft', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const inv = await doc(c, a, 'invoice_full', `INV-${ref('Alpha')}`, 'final');
      const pa = await pay(c, a, inv);
      // The payment already points at another receipt, so the link step fails after the document and version were written.
      const other = await doc(c, a, 'receipt', `RCP-${ref('Alpha')}-7`.replace('-7', ''), 'draft');
      await c.query(`update public.payments set receipt_document_id = $1 where id = $2`, [other, pa]);
      const number = `RCP-${ref('Alpha')}-P2`;
      await expect(saveFollowOnWith(c, actor(a), write(a, { number, paymentId: pa }), { nested: true })).rejects.toMatchObject({ code: 'invalid' });
      expect(await counts(c, a, number)).toEqual({ docs: 0, used: 0 });
      // A number that does not fit the job fails cleanly too.
      await expect(saveFollowOnWith(c, actor(a), write(a, { number: 'RCP-NOT-THIS-JOB' }), { nested: true })).rejects.toMatchObject({ code: 'invalid' });
      expect(await counts(c, a, 'RCP-NOT-THIS-JOB')).toEqual({ docs: 0, used: 0 });
    });
  });

  it('repairs a document that has no version, and a receipt draft whose payment was never linked', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const inv = await doc(c, a, 'invoice_full', `INV-${ref('Alpha')}`, 'final');
      const p = await pay(c, a, inv);
      const bare = await doc(c, a, 'receipt', `RCP-${ref('Alpha')}`, 'draft'); // an earlier save died here
      const r = await saveFollowOnWith(c, actor(a), write(a, { paymentId: p }), { nested: true });
      expect(r).toMatchObject({ created: false, documentId: bare });
      expect((await c.query(`select count(*)::int n from public.document_versions where document_id = $1`, [bare])).rows[0].n).toBe(1);
      expect((await c.query(`select current_version_id from public.documents where id = $1`, [bare])).rows[0].current_version_id).not.toBeNull();
      expect((await c.query(`select receipt_document_id from public.payments where id = $1`, [p])).rows[0].receipt_document_id).toBe(bare);
    });
  });

  it('two part payments get two receipts, each linked to its own payment', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const inv = await doc(c, a, 'invoice_full', `INV-${ref('Alpha')}`, 'final');
      const p1 = await pay(c, a, inv, { amount: 3000 });
      const p2 = await pay(c, a, inv, { amount: 2000 });
      const r1 = await saveFollowOnWith(c, actor(a), write(a, { paymentId: p1, grossPence: 3000 }), { nested: true });
      const r2 = await saveFollowOnWith(c, actor(a), write(a, { number: `RCP-${ref('Alpha')}-P2`, paymentId: p2, grossPence: 2000 }), { nested: true });
      expect(r1.documentId).not.toBe(r2.documentId);
      const links = await c.query(`select id, receipt_document_id from public.payments order by amount_pence desc`);
      expect(links.rows.map((x) => x.receipt_document_id)).toEqual([r1.documentId, r2.documentId]);
    });
  });

  it('refuses another business\'s job and another job\'s payment', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo');
      await expect(saveFollowOnWith(c, actor(a), write(b), { nested: true })).rejects.toMatchObject({ code: 'not_found' });
      const ib = await doc(c, b, 'invoice_full', `INV-${ref('Bravo')}`, 'final');
      const pb = await pay(c, b, ib);
      await expect(saveFollowOnWith(c, actor(a), write(a, { paymentId: pb }), { nested: true })).rejects.toMatchObject({ code: 'not_found' });
      expect(await counts(c, a, `RCP-${ref('Alpha')}`)).toEqual({ docs: 0, used: 0 });
    });
  });
});

describe.skipIf(!dbAvailable)('job references cannot look like document numbers (migration 011)', () => {
  it('the constraint exists and is validated', async () => {
    await withRollback(async (c) => {
      const r = await c.query(`select convalidated from pg_constraint where conname = 'jobs_reference_not_document_like'`);
      expect(r.rows).toEqual([{ convalidated: true }]);
    });
  });

  it('refuses endings -D, -B, -S{n}, -P{n} and prefixes INV-, RCP-, GC-, SR-, for the server and the app role', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const bad = ['Q1-D', 'Q1-B', 'Q1-S2', 'Q1-S10', 'Q1-P2', 'Q-5-P99', 'INV-100', 'RCP-100', 'GC-100', 'Q-5-G2', 'Q-5-G20', 'SR-100', 'GUA-100', 'SUR-100', 'A/B-D'];
      const ins = `insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, $3)`;
      for (const ref of bad) await expectFail(c, ins, [a.tenantId, a.customerId, ref], /jobs_reference_not_document_like/);
      await actAs(c, a.userId);
      for (const ref of bad) await expectFail(c, ins, [a.tenantId, a.customerId, ref], /jobs_reference_not_document_like/);
      await actAsServer(c);
      for (const ref of ['Q1-DX', 'Q1-S', 'Q1-P', 'Q1-d', 'Q-5-2', 'INVOICE-1', 'GCSE-1', 'xRCP-1', 'QT-0042']) await c.query(ins, [a.tenantId, a.customerId, ref]);
    });
  });

  it('a trailing newline or any space cannot slip a reserved ending past the check (migration 013)', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const r = await c.query(`select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'jobs_reference_not_document_like'`);
      expect(r.rows[0].d).toMatch(/space/);
      for (const ref of ['Q1-D\n', 'Q1-B ', 'Q 1']) {
        await c.query('savepoint y');
        await expect(c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, $3)`, [a.tenantId, a.customerId, ref])).rejects.toThrow();
        await c.query('rollback to savepoint y');
      }
      expect((await c.query(`select ($1::text !~ '[[:space:][:cntrl:]]' and $1::text !~ '-(D|B|S[0-9]+|P[0-9]+)$') as ok`, ['Q1-D\n'])).rows[0].ok).toBe(false);
    });
  });

  it('the old cross-job collision cannot be built: Q-5-P2 is not a job, so RCP-Q-5-P2 belongs to Q-5 alone', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const mk = (ref: string) => c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, $3) returning id`, [a.tenantId, a.customerId, ref]);
      const j5 = await mk('Q-5');
      const j52 = await mk('Q-5-2');
      await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'receipt', 'RCP-Q-5-P2')`, [a.tenantId, j5.rows[0].id]);
      // The second job's first receipt is RCP-Q-5-2 and its own second is RCP-Q-5-2-P2: neither touches Q-5's numbers.
      await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'receipt', 'RCP-Q-5-2')`, [a.tenantId, j52.rows[0].id]);
      await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'receipt', 'RCP-Q-5-2-P2')`, [a.tenantId, j52.rows[0].id]);
      await expectFail(c, `insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'receipt', 'RCP-Q-5-P2')`, [a.tenantId, j52.rows[0].id], /does not match its job/);
      await expectFail(c, `insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'receipt', 'RCP-Q-5-2')`, [a.tenantId, j5.rows[0].id], /does not match its job/);
    });
  });
});

describe.skipIf(!dbAvailable)('saveFollowOnWith repair never crosses payments', () => {
  it('a save that names no payment never reuses a version made for a payment (the null-payment bypass)', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const inv = await doc(c, a, 'invoice_full', `INV-${ref('Alpha')}`, 'final');
      const p1 = await pay(c, a, inv, { amount: 3000 });
      const number = `RCP-${ref('Alpha')}`;
      const w = { jobId: a.jobId, type: 'receipt' as const, number, instalment: 1, heading: 'Invoice', netPence: 2500, vatPence: 500, grossPence: 3000, date: '2026-10-15', paymentId: p1 };
      const actor = { tenantId: a.tenantId, userId: a.userId };
      await saveFollowOnWith(c, actor, w, { nested: true });
      await expect(saveFollowOnWith(c, actor, { ...w, paymentId: null }, { nested: true })).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/belongs to a receipt for a payment/) });
    });
  });

  it('refuses to reuse a receipt number whose version belongs to another payment, and says why', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const inv = await doc(c, a, 'invoice_full', `INV-${ref('Alpha')}`, 'final');
      const p1 = await pay(c, a, inv, { amount: 3000 });
      const p2 = await pay(c, a, inv, { amount: 2000 });
      const number = `RCP-${ref('Alpha')}`;
      const w = { jobId: a.jobId, type: 'receipt' as const, number, instalment: 1, heading: 'Invoice', netPence: 2500, vatPence: 500, grossPence: 3000, date: '2026-10-15', paymentId: p1 };
      const actor = { tenantId: a.tenantId, userId: a.userId };
      const first = await saveFollowOnWith(c, actor, w, { nested: true });
      // Positions shift: someone now asks for this same number for the other payment.
      await expect(saveFollowOnWith(c, actor, { ...w, paymentId: p2 }, { nested: true })).rejects.toMatchObject({ code: 'invalid', message: expect.stringMatching(/different payment/) });
      const links = await c.query(`select id, receipt_document_id from public.payments where id = any($1)`, [[p1, p2]]);
      expect(links.rows.find((r) => r.id === p2).receipt_document_id).toBeNull();
      expect(links.rows.find((r) => r.id === p1).receipt_document_id).toBe(first.documentId);
      // The right payment still repairs and re-saves fine.
      expect((await saveFollowOnWith(c, actor, w, { nested: true })).created).toBe(false);
    });
  });

  it('gives a number that does not fit the job its own message', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const w = { jobId: a.jobId, type: 'receipt' as const, number: 'RCP-NOT-THIS-JOB', instalment: 1, heading: 'x', netPence: 1, vatPence: 0, grossPence: 1, date: '2026-10-15', paymentId: null };
      await expect(saveFollowOnWith(c, { tenantId: a.tenantId, userId: a.userId }, w, { nested: true })).rejects.toMatchObject({ message: 'That document number does not fit this job.' });
    });
  });
});
