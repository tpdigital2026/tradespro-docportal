import { describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { actAs, actAsServer, dbAvailable, withRollback } from './helpers';
import { seedTenant } from './seed';

async function expectFail(c: Client, sql: string, params: unknown[], pattern: RegExp): Promise<void> {
  await c.query('savepoint x');
  try {
    await expect(c.query(sql, params), sql).rejects.toThrow(pattern);
  } finally {
    await c.query('rollback to savepoint x');
  }
}

const inst = (n: number, g: number) => ({ index: n, label: `Part ${n}`, net_pence: g - Math.floor(g / 6), vat_pence: Math.floor(g / 6), gross_pence: g });

describe.skipIf(!dbAvailable)('jobs.payment_plan', () => {
  it('the owner can save every kind of plan on a draft job and read it back', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      const plans = [
        { kind: 'full' },
        { kind: 'deposit', pct_bp: 3250, instalments: [inst(1, 100), inst(2, 200)] },
        { kind: 'staged', stages: [{ label: 'One', mode: 'pct', pct_bp: 5000 }, { label: 'Two', mode: 'amount', gross_pence: 5000 }] },
      ];
      for (const p of plans) {
        const r = await c.query(`update public.jobs set payment_plan = $1 where id = $2 returning payment_plan`, [JSON.stringify(p), a.jobId]);
        expect(r.rows[0].payment_plan).toEqual(p);
      }
      const ins = await c.query(
        `insert into public.jobs (tenant_id, customer_id, reference, payment_plan) values ($1, $2, 'NEW-1', $3) returning id`,
        [a.tenantId, a.customerId, JSON.stringify({ kind: 'full' })],
      );
      expect(ins.rowCount).toBe(1);
      await c.query(`update public.jobs set payment_plan = null where id = $1`, [a.jobId]);
    });
  });

  it('refuses malformed plans', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      const bad: unknown[] = [
        { kind: 'weekly' },
        [],
        { kind: 'deposit' },
        { kind: 'deposit', pct_bp: 0 },
        { kind: 'deposit', pct_bp: 10000 },
        { kind: 'deposit', pct_bp: 3025 },
        { kind: 'deposit', pct_bp: 3000, extra: 1 },
        { kind: 'staged', stages: [{ label: 'One', mode: 'pct', pct_bp: 10000 }] },
        { kind: 'staged', stages: Array.from({ length: 11 }, (_, i) => ({ label: `S${i}`, mode: 'pct', pct_bp: 900 })) },
        { kind: 'staged', stages: [{ label: '', mode: 'pct', pct_bp: 5000 }, { label: 'b', mode: 'pct', pct_bp: 5000 }] },
        { kind: 'staged', stages: [{ label: 'a', mode: 'pct', pct_bp: 0 }, { label: 'b', mode: 'pct', pct_bp: 5000 }] },
        { kind: 'staged', stages: [{ label: 'a', mode: 'amount', gross_pence: 0 }, { label: 'b', mode: 'pct', pct_bp: 5000 }] },
        { kind: 'staged', stages: [{ label: 'a', mode: 'amount', gross_pence: 1.5 }, { label: 'b', mode: 'pct', pct_bp: 5000 }] },
        { kind: 'full', instalments: [{ index: 1, label: 'x', net_pence: 1, vat_pence: 1, gross_pence: 5 }] },
        { kind: 'deposit', pct_bp: 3000, instalments: [inst(1, 100)] },
      ];
      for (const p of bad) {
        await expectFail(c, `update public.jobs set payment_plan = $1 where id = $2`, [JSON.stringify(p), a.jobId], /payment plan is not valid|violates check constraint/i);
      }
    });
  });

  it("cannot be changed by the app role once the quotation has left draft, but the server can", async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      await c.query(`update public.jobs set payment_plan = $1 where id = $2`, [JSON.stringify({ kind: 'full' }), a.jobId]);
      await actAsServer(c);
      await c.query(`update public.documents set status = 'final' where id = $1`, [a.docId]);
      await actAs(c, a.userId);
      await expectFail(c, `update public.jobs set payment_plan = $1 where id = $2`, [JSON.stringify({ kind: 'deposit', pct_bp: 3000 }), a.jobId], /cannot be changed once the quote has been issued/);
      await actAsServer(c);
      const r = await c.query(`update public.jobs set payment_plan = $1 where id = $2 returning payment_plan`, [JSON.stringify({ kind: 'deposit', pct_bp: 3000 }), a.jobId]);
      expect(r.rows[0].payment_plan.kind).toBe('deposit');
    });
  });

  it("a second business's job plan is invisible and unwritable", async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo');
      await actAsServer(c);
      await c.query(`update public.jobs set payment_plan = $1 where id = $2`, [JSON.stringify({ kind: 'full' }), b.jobId]);
      await actAs(c, a.userId);
      expect((await c.query(`select payment_plan from public.jobs where id = $1`, [b.jobId])).rowCount).toBe(0);
      expect((await c.query(`update public.jobs set payment_plan = null where id = $1 returning id`, [b.jobId])).rowCount).toBe(0);
    });
  });

  it('draft autosave path: owner updates draft version and document date; bank accounts expose last four only', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      const v = await c.query(`update public.document_versions set input = $1, bank_account_id = $2 where id = $3 returning id`, [JSON.stringify({ schema: 1, form: {} }), a.bankAccountId, a.versionId]);
      expect(v.rowCount).toBe(1);
      expect((await c.query(`update public.documents set doc_date = '2026-10-14' where id = $1 returning id`, [a.docId])).rowCount).toBe(1);
      const banks = await c.query(`select id, account_name, bank_name, last4, is_default, archived_at from public.bank_accounts`);
      expect(banks.rows[0].last4).toBe('1234');
      await expectFail(c, `select sort_code_enc from public.bank_accounts`, [], /permission denied/i);
      const nums = await c.query(`select number from public.used_numbers where number = $1`, [`QT-Alpha-001`]);
      expect(nums.rowCount).toBe(1);
    });
  });

  it('a business VAT rate above 25% cannot be stored', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAsServer(c);
      await c.query(`update public.tenant_defaults set vat_rate_bp = 2500 where tenant_id = $1`, [a.tenantId]);
      await c.query(`update public.tenant_defaults set vat_rate_bp = 0 where tenant_id = $1`, [a.tenantId]);
      await expectFail(c, `update public.tenant_defaults set vat_rate_bp = 2501 where tenant_id = $1`, [a.tenantId], /tenant_defaults_vat_rate_max|check constraint/i);
    });
  });
});
