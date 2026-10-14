import { describe, expect, it } from 'vitest';
import { createTenantWithUser, dbAvailable, withRollback } from './helpers';

const EXPECTED = [
  'tenants', 'profiles', 'brand_kits', 'brand_assets', 'job_types', 'bank_accounts', 'tenant_defaults',
  'customers', 'jobs', 'used_numbers', 'documents', 'document_versions', 'job_photos', 'share_links',
  'document_emails', 'ai_runs', 'audit_log', 'login_attempts', 'purge_log',
];

describe.skipIf(!dbAvailable)('schema', () => {
  it('has every table from the spec', async () => {
    await withRollback(async (c) => {
      const r = await c.query(`select tablename from pg_tables where schemaname = 'public'`);
      const have = r.rows.map((x) => x.tablename);
      for (const t of EXPECTED) expect(have).toContain(t);
    });
  });

  it('stores money as bigint pence', async () => {
    await withRollback(async (c) => {
      const r = await c.query(
        `select column_name, data_type from information_schema.columns
         where table_schema = 'public' and table_name = 'documents' and column_name in ('total_pence', 'balance_pence')`,
      );
      expect(r.rows).toHaveLength(2);
      r.rows.forEach((x) => expect(x.data_type).toBe('bigint'));
    });
  });

  it('rejects a job that points at another tenant\'s customer (composite foreign key)', async () => {
    await withRollback(async (c) => {
      const a = await createTenantWithUser(c, 'Tenant A');
      const b = await createTenantWithUser(c, 'Tenant B');
      const cust = await c.query(`insert into public.customers (tenant_id, name) values ($1, 'B Customer') returning id`, [b.tenantId]);
      await expect(
        c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-X-001')`, [a.tenantId, cust.rows[0].id]),
      ).rejects.toThrow(/foreign key/i);
    });
  });

  it('allows only one default bank account per tenant', async () => {
    await withRollback(async (c) => {
      const a = await createTenantWithUser(c, 'Tenant A');
      const ins = `insert into public.bank_accounts (tenant_id, account_name, bank_name, sort_code_enc, account_number_enc, last4, is_default)
                   values ($1, 'x', 'y', 'enc', 'enc', '0000', true)`;
      await c.query(ins, [a.tenantId]);
      await expect(c.query(ins, [a.tenantId])).rejects.toThrow(/duplicate key|unique/i);
    });
  });

  it('keeps quote references unique per tenant', async () => {
    await withRollback(async (c) => {
      const a = await createTenantWithUser(c, 'Tenant A');
      const cust = await c.query(`insert into public.customers (tenant_id, name) values ($1, 'C') returning id`, [a.tenantId]);
      const ins = `insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-JS-001')`;
      await c.query(ins, [a.tenantId, cust.rows[0].id]);
      await expect(c.query(ins, [a.tenantId, cust.rows[0].id])).rejects.toThrow(/duplicate key|unique/i);
    });
  });
});
