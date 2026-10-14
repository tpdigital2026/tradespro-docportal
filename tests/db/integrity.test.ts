import { describe, expect, it } from 'vitest';
import { actAs, createTenantWithUser, dbAvailable, withRollback } from './helpers';

async function jobFor(c: import('pg').Client, tenantId: string, ref: string) {
  const cust = await c.query(`insert into public.customers (tenant_id, name) values ($1, 'C') returning id`, [tenantId]);
  const job = await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, $3) returning id, customer_id`, [tenantId, cust.rows[0].id, ref]);
  return { jobId: job.rows[0].id as string, customerId: cust.rows[0].id as string };
}

describe.skipIf(!dbAvailable)('integrity triggers', () => {
  it('a finalised document version cannot be updated or deleted', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const { jobId } = await jobFor(c, t.tenantId, 'QT-A-001');
      const doc = await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'quotation', 'QT-A-001') returning id`, [t.tenantId, jobId]);
      const v = await c.query(`insert into public.document_versions (tenant_id, document_id, version) values ($1, $2, 1) returning id`, [t.tenantId, doc.rows[0].id]);
      await c.query(`update public.document_versions set input = '{"a":1}' where id = $1`, [v.rows[0].id]);
      await c.query(`update public.document_versions set finalised_at = now() where id = $1`, [v.rows[0].id]);
      await c.query('savepoint s');
      await expect(c.query(`update public.document_versions set input = '{"a":2}' where id = $1`, [v.rows[0].id])).rejects.toThrow(/finalised/i);
      await c.query('rollback to savepoint s');
      await expect(c.query(`delete from public.document_versions where id = $1`, [v.rows[0].id])).rejects.toThrow(/finalised/i);
    });
  });

  it('a finalised version survives a cascading delete unless the purge flag is set', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const { jobId, customerId } = await jobFor(c, t.tenantId, 'QT-A-001');
      const doc = await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'quotation', 'QT-A-001') returning id`, [t.tenantId, jobId]);
      await c.query(`insert into public.document_versions (tenant_id, document_id, version, finalised_at) values ($1, $2, 1, now())`, [t.tenantId, doc.rows[0].id]);
      await c.query('savepoint s');
      await expect(c.query(`delete from public.customers where id = $1`, [customerId])).rejects.toThrow(/finalised/i);
      await c.query('rollback to savepoint s');
      await c.query(`select set_config('app.allow_final_delete', 'on', true)`);
      const del = await c.query(`delete from public.customers where id = $1`, [customerId]);
      expect(del.rowCount).toBe(1);
    });
  });

  it('the audit log is append only', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const row = await c.query(`insert into public.audit_log (tenant_id, action) values ($1, 'x') returning id`, [t.tenantId]);
      await c.query('savepoint s');
      await expect(c.query(`update public.audit_log set action = 'y' where id = $1`, [row.rows[0].id])).rejects.toThrow(/append/i);
      await c.query('rollback to savepoint s');
      await expect(c.query(`delete from public.audit_log where id = $1`, [row.rows[0].id])).rejects.toThrow(/append/i);
    });
  });

  it('a quote number cannot be reused, even after the job is deleted', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const { jobId, customerId } = await jobFor(c, t.tenantId, 'QT-A-001');
      await c.query(`delete from public.jobs where id = $1`, [jobId]);
      await c.query('savepoint s');
      await expect(
        c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-A-001')`, [t.tenantId, customerId]),
      ).rejects.toThrow(/already been used|duplicate/i);
    });
  });

  it('a quote number cannot be changed', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const { jobId } = await jobFor(c, t.tenantId, 'QT-A-001');
      await expect(c.query(`update public.jobs set reference = 'QT-A-002' where id = $1`, [jobId])).rejects.toThrow(/cannot be changed/i);
    });
  });

  it('the same quote number is fine in two different businesses', async () => {
    await withRollback(async (c) => {
      const a = await createTenantWithUser(c, 'Alpha');
      const b = await createTenantWithUser(c, 'Bravo');
      await jobFor(c, a.tenantId, 'QT-001');
      await jobFor(c, b.tenantId, 'QT-001');
      const r = await c.query(`select count(*)::int n from public.used_numbers where number = 'QT-001' and tenant_id in ($1, $2)`, [a.tenantId, b.tenantId]);
      expect(r.rows[0].n).toBe(2);
    });
  });

  it('creating documents pushes the customer purge date out by 30 days', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const { jobId, customerId } = await jobFor(c, t.tenantId, 'QT-A-001');
      await c.query(`update public.customers set purge_at = now() + interval '1 day', last_activity_at = now() - interval '29 days' where id = $1`, [customerId]);
      await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'quotation', 'QT-A-001')`, [t.tenantId, jobId]);
      const r = await c.query(`select purge_at > now() + interval '29 days' as extended from public.customers where id = $1`, [customerId]);
      expect(r.rows[0].extended).toBe(true);
    });
  });

  it('creating a job pushes the customer purge date out by 30 days', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const cust = await c.query(
        `insert into public.customers (tenant_id, name, purge_at) values ($1, 'C', now() + interval '1 day') returning id`,
        [t.tenantId],
      );
      await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-T-001')`, [t.tenantId, cust.rows[0].id]);
      const r = await c.query(`select purge_at > now() + interval '29 days' as extended from public.customers where id = $1`, [cust.rows[0].id]);
      expect(r.rows[0].extended).toBe(true);
    });
  });

  it('the app role can create a job and the number is claimed', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const cust = await c.query(`insert into public.customers (tenant_id, name) values ($1, 'C') returning id`, [t.tenantId]);
      await actAs(c, t.userId);
      await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-APP-001')`, [t.tenantId, cust.rows[0].id]);
      const used = await c.query(`select count(*)::int n from public.used_numbers where number = 'QT-APP-001'`);
      expect(used.rows[0].n).toBe(1);
    });
  });

  it('the app role cannot reuse a quote number either', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const { jobId, customerId } = await jobFor(c, t.tenantId, 'QT-A-001');
      await c.query(`delete from public.jobs where id = $1`, [jobId]);
      await actAs(c, t.userId);
      await expect(
        c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-A-001')`, [t.tenantId, customerId]),
      ).rejects.toThrow(/already been used/i);
    });
  });
});
