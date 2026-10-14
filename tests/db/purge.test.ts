import { describe, expect, it } from 'vitest';
import { actAsServer, createTenantWithUser, dbAvailable, withRollback } from './helpers';

async function customerWithJob(c: import('pg').Client, tenantId: string, ref: string, purgeAtSql: string) {
  const cust = await c.query(`insert into public.customers (tenant_id, name, purge_at) values ($1, 'Cust', ${purgeAtSql}) returning id`, [tenantId]);
  const job = await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, $3) returning id`, [tenantId, cust.rows[0].id, ref]);
  // jobs trigger pushed purge_at out; set it back for the test
  await c.query(`update public.customers set purge_at = ${purgeAtSql} where id = $1`, [cust.rows[0].id]);
  const doc = await c.query(`insert into public.documents (tenant_id, job_id, type, number, pdf_path) values ($1, $2, 'quotation', $3, $4) returning id`, [tenantId, job.rows[0].id, ref, `${tenantId}/pdfs/${ref}.pdf`]);
  await c.query(`update public.customers set purge_at = ${purgeAtSql} where id = $1`, [cust.rows[0].id]);
  const v = await c.query(`insert into public.document_versions (tenant_id, document_id, version, pdf_path, finalised_at) values ($1, $2, 1, $3, now()) returning id`, [tenantId, doc.rows[0].id, `${tenantId}/pdfs/${ref}-v1.pdf`]);
  await c.query(`insert into public.job_photos (tenant_id, job_id, storage_path) values ($1, $2, $3)`, [tenantId, job.rows[0].id, `${tenantId}/photos/${ref}.jpg`]);
  await c.query(`update public.customers set purge_at = ${purgeAtSql} where id = $1`, [cust.rows[0].id]);
  return { customerId: cust.rows[0].id as string, jobId: job.rows[0].id as string, versionId: v.rows[0].id as string };
}

describe.skipIf(!dbAvailable)('purge and erase', () => {
  it('lists expired customers and their stored files', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const old = await customerWithJob(c, t.tenantId, 'QT-OLD-001', `now() - interval '1 day'`);
      await customerWithJob(c, t.tenantId, 'QT-NEW-001', `now() + interval '10 days'`);
      const expired = await c.query(`select id from private.expired_customers(now())`);
      expect(expired.rows.map((r) => r.id)).toEqual([old.customerId]);
      const paths = await c.query(`select * from private.customer_storage_paths($1::uuid[])`, [[old.customerId]]);
      expect(paths.rows.map((r) => r.customer_storage_paths).sort()).toEqual([`${t.tenantId}/pdfs/QT-OLD-001-v1.pdf`, `${t.tenantId}/pdfs/QT-OLD-001.pdf`, `${t.tenantId}/photos/QT-OLD-001.jpg`]);
    });
  });

  it('purges only expired customers, cascades, logs a count, and keeps used numbers and the audit trail', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      await customerWithJob(c, t.tenantId, 'QT-OLD-001', `now() - interval '1 day'`);
      const keep = await customerWithJob(c, t.tenantId, 'QT-NEW-001', `now() + interval '10 days'`);
      await c.query(`insert into public.audit_log (tenant_id, action) values ($1, 'kept')`, [t.tenantId]);
      const before = await c.query(`select count(*)::int n from public.purge_log`);
      const r = await c.query(`select private.purge_expired_customers(now()) as n`);
      expect(r.rows[0].n).toBe(1);
      const left = await c.query(`select id from public.customers where tenant_id = $1`, [t.tenantId]);
      expect(left.rows.map((x) => x.id)).toEqual([keep.customerId]);
      for (const table of ['jobs', 'documents', 'document_versions', 'job_photos']) {
        const n = await c.query(`select count(*)::int n from public.${table} where tenant_id = $1`, [t.tenantId]);
        expect(n.rows[0].n, table).toBe(1);
      }
      const used = await c.query(`select number from public.used_numbers where tenant_id = $1 order by number`, [t.tenantId]);
      expect(used.rows.map((x) => x.number)).toEqual(['QT-NEW-001', 'QT-OLD-001']);
      const audit = await c.query(`select count(*)::int n from public.audit_log where tenant_id = $1`, [t.tenantId]);
      expect(audit.rows[0].n).toBe(1);
      const log = await c.query(`select customers_purged from public.purge_log order by id desc limit 1`);
      expect(log.rows[0].customers_purged).toBe(1);
      const after = await c.query(`select count(*)::int n from public.purge_log`);
      expect(after.rows[0].n).toBe(before.rows[0].n + 1);
    });
  });

  it('erase_customer deletes one customer in the named tenant only', async () => {
    await withRollback(async (c) => {
      const a = await createTenantWithUser(c, 'Alpha');
      const b = await createTenantWithUser(c, 'Bravo');
      const ca = await customerWithJob(c, a.tenantId, 'QT-A-001', `now() + interval '10 days'`);
      const cb = await customerWithJob(c, b.tenantId, 'QT-B-001', `now() + interval '10 days'`);
      const wrong = await c.query(`select private.erase_customer($1, $2) as n`, [a.tenantId, cb.customerId]);
      expect(wrong.rows[0].n).toBe(0);
      const ok = await c.query(`select private.erase_customer($1, $2) as n`, [a.tenantId, ca.customerId]);
      expect(ok.rows[0].n).toBe(1);
      const left = await c.query(`select id from public.customers where id = any($1::uuid[])`, [[ca.customerId, cb.customerId]]);
      expect(left.rows.map((x) => x.id)).toEqual([cb.customerId]);
    });
  });

  it('the purge functions are not callable by the app role', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      await c.query('set local role authenticated');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: t.userId, role: 'authenticated' })]);
      await c.query('savepoint s');
      await expect(c.query(`select private.purge_expired_customers(now())`)).rejects.toThrow(/permission denied/i);
      await c.query('rollback to savepoint s');
      await expect(c.query(`select private.erase_customer($1, gen_random_uuid())`, [t.tenantId])).rejects.toThrow(/permission denied/i);
    });
  });

  it('purge_old_login_attempts removes only old rows and returns the count', async () => {
    await withRollback(async (c) => {
      await actAsServer(c);
      await c.query(`delete from public.login_attempts`);
      await c.query(
        `insert into public.login_attempts (email_hash, kind, success, at) values
          ('h1', 'request', true, now() - interval '31 days'),
          ('h2', 'verify', false, now() - interval '45 days'),
          ('h3', 'verify', true, now() - interval '1 day'),
          ('h4', 'request', true, now())`,
      );
      const r = await c.query(`select private.purge_old_login_attempts() as n`);
      expect(r.rows[0].n).toBe(2);
      const left = await c.query(`select email_hash from public.login_attempts order by email_hash`);
      expect(left.rows.map((x) => x.email_hash)).toEqual(['h3', 'h4']);
      const custom = await c.query(`select private.purge_old_login_attempts(interval '12 hours') as n`);
      expect(custom.rows[0].n).toBe(1);
    });
  });

  it('purge_old_login_attempts is not callable by the app role', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      await c.query('set local role authenticated');
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: t.userId, role: 'authenticated' })]);
      await expect(c.query(`select private.purge_old_login_attempts()`)).rejects.toThrow(/permission denied/i);
    });
  });
});
