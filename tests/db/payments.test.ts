import { describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { assertNoPersonalData } from '../../src/security/audit';
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
        ['guarantee', 'GUA-anything-1'],
        ['survey_report', 'SUR-anything-1'],
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
