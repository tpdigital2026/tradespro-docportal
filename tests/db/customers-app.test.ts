import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { compactId, eraseCustomerWith, extendRetentionWith } from '../../src/lib/data/customer-admin';
import { InMemoryStorage } from '../../src/lib/storage';
import { actAs, actAsServer, createTenantWithUser, dbAvailable, withRollback } from './helpers';
import { seedTenant } from './seed';

async function expectFail(c: Client, sql: string, params: unknown[], pattern: RegExp): Promise<void> {
  await c.query('savepoint x');
  try {
    await expect(c.query(sql, params), sql).rejects.toThrow(pattern);
  } finally {
    await c.query('rollback to savepoint x');
  }
}

const daysFromNow = async (c: Client, id: string) =>
  Number((await c.query(`select extract(epoch from (purge_at - now())) / 86400 as d from public.customers where id = $1`, [id])).rows[0].d);

describe.skipIf(!dbAvailable)('customers through the app path', () => {
  it("a second business's customer is invisible and unwritable to the owner of the first", async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo');
      await actAs(c, a.userId);
      const list = await c.query(`select id from public.customers order by last_activity_at desc`);
      expect(list.rows.map((r) => r.id)).toEqual([a.customerId]);
      const one = await c.query(`select id from public.customers where id = $1`, [b.customerId]);
      expect(one.rowCount).toBe(0);
      const upd = await c.query(`update public.customers set name = 'Hacked' where id = $1 returning id`, [b.customerId]);
      expect(upd.rowCount).toBe(0);
      await expectFail(c, `insert into public.customers (tenant_id, name) values ($1, 'Intruder')`, [b.tenantId], /row-level security/i);
      // moving one of our own customers into the other business is refused too
      await expectFail(c, `update public.customers set tenant_id = $1 where id = $2`, [b.tenantId, a.customerId], /permission denied|row-level security/i);
      await actAsServer(c);
      const still = await c.query(`select name from public.customers where id = $1`, [b.customerId]);
      expect(still.rows[0].name).toBe('Bravo Customer');
    });
  });

  it('the owner can add and edit their own customers but never write the purge columns', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      const ins = await c.query(
        `insert into public.customers (tenant_id, name, address_lines, postcode) values ($1, 'New One', array['1 High St'], 'AB1 2CD') returning id`,
        [a.tenantId],
      );
      const upd = await c.query(`update public.customers set name = 'Renamed' where id = $1 returning name`, [ins.rows[0].id]);
      expect(upd.rows[0].name).toBe('Renamed');
      await expectFail(c, `update public.customers set purge_at = 'infinity' where id = $1`, [ins.rows[0].id], /permission denied/i);
      await expectFail(c, `update public.customers set last_activity_at = now() where id = $1`, [ins.rows[0].id], /permission denied/i);
    });
  });

  it('a new customer is kept for the business retention setting, 90 days when unset', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'NoDefaults');
      const plain = await c.query(`insert into public.customers (tenant_id, name) values ($1, 'A') returning id`, [t.tenantId]);
      expect(await daysFromNow(c, plain.rows[0].id)).toBeGreaterThan(89);
      expect(await daysFromNow(c, plain.rows[0].id)).toBeLessThan(91);
      await c.query(`insert into public.tenant_defaults (tenant_id, retention_days) values ($1, 120)`, [t.tenantId]);
      const longer = await c.query(`insert into public.customers (tenant_id, name) values ($1, 'B') returning id`, [t.tenantId]);
      expect(await daysFromNow(c, longer.rows[0].id)).toBeGreaterThan(119);
      expect(await daysFromNow(c, longer.rows[0].id)).toBeLessThan(121);
      const explicit = await c.query(`insert into public.customers (tenant_id, name, purge_at) values ($1, 'C', now() + interval '5 days') returning id`, [t.tenantId]);
      expect(await daysFromNow(c, explicit.rows[0].id)).toBeLessThan(6);
      await expectFail(c, `update public.tenant_defaults set retention_days = 29 where tenant_id = $1`, [t.tenantId], /check constraint/i);
      await expectFail(c, `update public.tenant_defaults set retention_days = 731 where tenant_id = $1`, [t.tenantId], /check constraint/i);
    });
  });

  it('activity extends the purge date but never shortens it', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Touch');
      await c.query(`insert into public.tenant_defaults (tenant_id, retention_days) values ($1, 60)`, [t.tenantId]);
      const cust = await c.query(`insert into public.customers (tenant_id, name, purge_at) values ($1, 'A', now() + interval '3 days') returning id`, [t.tenantId]);
      await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-T-1')`, [t.tenantId, cust.rows[0].id]);
      expect(await daysFromNow(c, cust.rows[0].id)).toBeGreaterThan(59);
      // already further out than the setting: a touch must leave it alone
      await c.query(`update public.customers set purge_at = now() + interval '300 days' where id = $1`, [cust.rows[0].id]);
      await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-T-2')`, [t.tenantId, cust.rows[0].id]);
      expect(await daysFromNow(c, cust.rows[0].id)).toBeGreaterThan(299);
    });
  });

  it('keep-for-longer works only for the right business, writes through the service path, and is closed to the app role', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo');
      await c.query(`update public.customers set purge_at = now() + interval '5 days' where id = $1`, [a.customerId]);
      const wrong = await c.query(`select private.extend_customer_retention($1, $2) as at`, [b.tenantId, a.customerId]);
      expect(wrong.rows[0].at).toBeNull();
      expect(await daysFromNow(c, a.customerId)).toBeLessThan(6);
      const ok = await c.query(`select private.extend_customer_retention($1, $2) as at`, [a.tenantId, a.customerId]);
      expect(ok.rows[0].at).not.toBeNull();
      expect(await daysFromNow(c, a.customerId)).toBeGreaterThan(89);
      await actAs(c, a.userId);
      await expectFail(c, `select private.extend_customer_retention($1, $2)`, [a.tenantId, a.customerId], /permission denied/i);
    });
  });
});

/** The erase and keep functions own their transaction in production; here a savepoint inside a rolled-back transaction stands in, so nothing is left behind (the audit log cannot be deleted from). */
describe.skipIf(!dbAvailable)('customer erasure and keep', () => {
  async function fixture(c: Client) {
    const t = await createTenantWithUser(c, `Erase ${randomUUID().slice(0, 8)}`);
    const cust = await c.query(`insert into public.customers (tenant_id, name) values ($1, 'Erase Me') returning id`, [t.tenantId]);
    const job = await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-E-1') returning id`, [t.tenantId, cust.rows[0].id]);
    const doc = await c.query(
      `insert into public.documents (tenant_id, job_id, type, number, pdf_path) values ($1, $2, 'quotation', 'QT-E-1', $3) returning id`,
      [t.tenantId, job.rows[0].id, `${t.tenantId}/q.pdf`],
    );
    await c.query(`insert into public.document_versions (tenant_id, document_id, version, pdf_path) values ($1, $2, 1, $3)`, [t.tenantId, doc.rows[0].id, `${t.tenantId}/v1.pdf`]);
    await c.query(`insert into public.job_photos (tenant_id, job_id, storage_path) values ($1, $2, $3)`, [t.tenantId, job.rows[0].id, `${t.tenantId}/photo.jpg`]);
    return { ...t, customerId: cust.rows[0].id as string };
  }
  const nested = { nested: true } as const;

  it('erases the customer, tells storage to delete every file, and writes an audit entry with ids only', async () => {
    await withRollback(async (c) => {
      const t = await fixture(c);
      const storage = new InMemoryStorage();
      const r = await eraseCustomerWith(c, storage, { tenantId: t.tenantId, userId: t.userId }, t.customerId, nested);
      expect(r).toBe('erased');
      expect([...storage.deleted].sort()).toEqual([`${t.tenantId}/photo.jpg`, `${t.tenantId}/q.pdf`, `${t.tenantId}/v1.pdf`]);
      expect(storage.deletedPrefixes).toEqual([`${t.tenantId}/${t.customerId}/`]);
      const left = await c.query(`select (select count(*) from public.customers where tenant_id = $1)::int c, (select count(*) from public.jobs where tenant_id = $1)::int j, (select count(*) from public.documents where tenant_id = $1)::int d`, [t.tenantId]);
      expect(left.rows[0]).toEqual({ c: 0, j: 0, d: 0 });
      const audit = await c.query(`select action, entity, entity_id, meta from public.audit_log where tenant_id = $1`, [t.tenantId]);
      expect(audit.rows).toEqual([{ action: 'customer.erase', entity: 'customer', entity_id: compactId(t.customerId), meta: { files: 3 } }]);
    });
  });

  it('a storage failure rolls everything back: the customer and its rows stay', async () => {
    await withRollback(async (c) => {
      const t = await fixture(c);
      const storage = new InMemoryStorage();
      storage.failNext = true;
      await expect(eraseCustomerWith(c, storage, { tenantId: t.tenantId, userId: t.userId }, t.customerId, nested)).rejects.toThrow(/Storage deletion failed/);
      const n = await c.query(`select (select count(*) from public.customers where tenant_id = $1)::int c, (select count(*) from public.documents where tenant_id = $1)::int d`, [t.tenantId]);
      expect(n.rows[0]).toEqual({ c: 1, d: 1 });
      expect((await c.query(`select count(*)::int n from public.audit_log where tenant_id = $1`, [t.tenantId])).rows[0].n).toBe(0);
    });
  });

  it('another business cannot erase the customer: not_found, and storage is never asked to delete anything', async () => {
    await withRollback(async (c) => {
      const a = await fixture(c);
      const b = await createTenantWithUser(c, `Other ${randomUUID().slice(0, 8)}`);
      const storage = new InMemoryStorage();
      const r = await eraseCustomerWith(c, storage, { tenantId: b.tenantId, userId: b.userId }, a.customerId, nested);
      expect(r).toBe('not_found');
      expect(storage.deleted).toEqual([]);
      expect((await c.query(`select count(*)::int n from public.customers where id = $1`, [a.customerId])).rows[0].n).toBe(1);
    });
  });

  it('keep-for-longer resets the clock and writes an audit entry; the wrong business gets null', async () => {
    await withRollback(async (c) => {
      const t = await fixture(c);
      const other = await createTenantWithUser(c, `Other ${randomUUID().slice(0, 8)}`);
      await c.query(`update public.customers set purge_at = now() + interval '3 days' where id = $1`, [t.customerId]);
      expect(await extendRetentionWith(c, { tenantId: other.tenantId, userId: other.userId }, t.customerId, nested)).toBeNull();
      expect(await daysFromNow(c, t.customerId)).toBeLessThan(4);
      const at = await extendRetentionWith(c, { tenantId: t.tenantId, userId: t.userId }, t.customerId, nested);
      expect(at).not.toBeNull();
      expect(await daysFromNow(c, t.customerId)).toBeGreaterThan(89);
      const audit = await c.query(`select action, entity_id from public.audit_log where tenant_id = $1`, [t.tenantId]);
      expect(audit.rows).toEqual([{ action: 'customer.keep', entity_id: compactId(t.customerId) }]);
    });
  });
});
