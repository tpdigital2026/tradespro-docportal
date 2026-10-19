import { describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { actAs, actAsServer, dbAvailable, withRollback } from './helpers';
import { seedTenant } from './seed';

// Every table a signed-in user can read. audit_log is owner-only; the seeded user is an owner.
const TENANT_TABLES = [
  'customers', 'jobs', 'documents', 'document_versions', 'brand_kits', 'job_types', 'tenant_defaults', 'used_numbers',
  'job_photos', 'share_links', 'document_emails', 'ai_runs', 'brand_assets', 'bank_accounts', 'audit_log',
];

/** Runs sql expecting it to fail with pattern, inside a savepoint so the transaction carries on. */
async function expectFail(c: Client, sql: string, params: unknown[], pattern: RegExp): Promise<void> {
  await c.query('savepoint x');
  try {
    await expect(c.query(sql, params), sql).rejects.toThrow(pattern);
  } finally {
    await c.query('rollback to savepoint x');
  }
}

describe.skipIf(!dbAvailable)('tenant isolation', () => {
  it('user A sees only tenant A rows in every tenant table', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo');
      await actAs(c, a.userId);
      for (const t of TENANT_TABLES) {
        const own = await c.query(`select count(*)::int n from public.${t} where tenant_id = $1`, [a.tenantId]);
        const other = await c.query(`select count(*)::int n from public.${t} where tenant_id = $1`, [b.tenantId]);
        const all = await c.query(`select count(*)::int n from public.${t} where tenant_id is distinct from $1`, [a.tenantId]);
        expect(own.rows[0].n, `${t} own`).toBeGreaterThan(0);
        expect(other.rows[0].n, `${t} other`).toBe(0);
        expect(all.rows[0].n, `${t} anything not mine`).toBe(0);
      }
      const profiles = await c.query(`select tenant_id from public.profiles`);
      expect(profiles.rowCount).toBeGreaterThan(0);
      expect(profiles.rows.every((r) => r.tenant_id === a.tenantId)).toBe(true);
      const tenants = await c.query(`select id from public.tenants`);
      expect(tenants.rows.map((r) => r.id)).toEqual([a.tenantId]);
    });
  });

  it('user A cannot insert into or update tenant B', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo');
      await actAs(c, a.userId);
      await c.query('savepoint s1');
      await expect(c.query(`insert into public.customers (tenant_id, name) values ($1, 'Intruder')`, [b.tenantId])).rejects.toThrow(/row-level security/i);
      await c.query('rollback to savepoint s1');
      const upd = await c.query(`update public.customers set name = 'Hacked' where id = $1`, [b.customerId]);
      expect(upd.rowCount).toBe(0);
      await actAsServer(c);
      const still = await c.query(`select name from public.customers where id = $1`, [b.customerId]);
      expect(still.rows[0].name).toBe('Bravo Customer');
    });
  });

  it('user A cannot insert into tenant B through any writable table', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo');
      await actAs(c, a.userId);
      const rls = /row-level security/i;
      // Each row is internally consistent for tenant B (B's parents), so only row level security can stop it.
      await expectFail(c, `insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-NEW-999')`, [b.tenantId, b.customerId], rls);
      await expectFail(c, `insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'receipt', 'RC-999')`, [b.tenantId, b.jobId], rls);
      await expectFail(c, `insert into public.document_versions (tenant_id, document_id, version) values ($1, $2, 2)`, [b.tenantId, b.docId], rls);
      // Since 002b the app role cannot insert photos at all (the server does it), so this is a privilege error.
      await expectFail(c, `insert into public.job_photos (tenant_id, job_id, storage_path) values ($1, $2, $1::uuid::text || '/x.jpg')`, [b.tenantId, b.jobId], /permission denied/i);
      await expectFail(c, `insert into public.share_links (tenant_id, document_id, token_hash, expires_at) values ($1, $2, 'evil', now())`, [b.tenantId, b.docId], rls);
      await expectFail(c, `insert into public.document_emails (tenant_id, document_id) values ($1, $2)`, [b.tenantId, b.docId], rls);
      await expectFail(c, `insert into public.brand_assets (tenant_id, brand_kit_id, kind, storage_path) values ($1, $2, 'badge', $1::uuid::text || '/x.png')`, [b.tenantId, b.kitId], rls);
      await expectFail(c, `insert into public.job_types (tenant_id, key, label) values ($1, 'evil', 'Evil')`, [b.tenantId], rls);
      await expectFail(c, `insert into public.used_numbers (tenant_id, number) values ($1, 'QT-EVIL-1')`, [b.tenantId], rls);
    });
  });

  it('user A cannot update or delete any of tenant B\'s rows', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo');
      await actAs(c, a.userId);
      const updates: [string, string][] = [
        [`update public.jobs set status = 'paid' where tenant_id = $1`, b.tenantId],
        [`update public.documents set doc_date = current_date where tenant_id = $1`, b.tenantId],
        [`update public.document_versions set input = '{"x":1}' where tenant_id = $1`, b.tenantId],
        [`update public.job_photos set finding_ref = 'x' where tenant_id = $1`, b.tenantId],
        [`update public.share_links set revoked_at = now() where tenant_id = $1`, b.tenantId],
        [`update public.document_emails set subject = 'x' where tenant_id = $1`, b.tenantId],
        [`update public.brand_kits set theme_key = 'x' where tenant_id = $1`, b.tenantId],
        [`update public.brand_assets set alt = 'x' where tenant_id = $1`, b.tenantId],
        [`update public.job_types set label = 'x' where tenant_id = $1`, b.tenantId],
        [`update public.tenant_defaults set vat_rate_bp = 0 where tenant_id = $1`, b.tenantId],
        [`update public.tenants set name = 'Hacked' where id = $1`, b.tenantId],
        [`delete from public.brand_kits where tenant_id = $1`, b.tenantId],
        [`delete from public.brand_assets where tenant_id = $1`, b.tenantId],
        [`delete from public.job_types where tenant_id = $1`, b.tenantId],
        [`delete from public.tenant_defaults where tenant_id = $1`, b.tenantId],
      ];
      for (const [sql, id] of updates) {
        const r = await c.query(sql, [id]);
        expect(r.rowCount, sql).toBe(0);
      }
    });
  });

  it('user A cannot move their own row into tenant B', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo');
      await actAs(c, a.userId);
      await c.query('savepoint s1');
      await expect(c.query(`update public.customers set tenant_id = $1 where id = $2`, [b.tenantId, a.customerId])).rejects.toThrow(/row-level security|violates|permission denied/i); // 002b: tenant_id is not an updatable column
    });
  });

  it('with check stops tenant_id being changed on every writable table', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo');
      await actAs(c, a.userId);
      // Tables with table-level update: row level security is checked before the (after-row) foreign key
      // checks, so the error must be the policy.
      for (const t of ['brand_kits', 'brand_assets', 'job_types', 'tenant_defaults']) {
        await expectFail(c, `update public.${t} set tenant_id = $1 where tenant_id = $2`, [b.tenantId, a.tenantId], /row-level security/i);
      }
      // Tables with column-level update grants (002b): tenant_id is not updatable at all.
      for (const t of ['customers', 'jobs', 'documents', 'document_versions', 'job_photos', 'share_links', 'document_emails']) {
        await expectFail(c, `update public.${t} set tenant_id = $1 where tenant_id = $2`, [b.tenantId, a.tenantId], /permission denied/i);
      }
    });
  });

  it('a child row cannot point at another tenant\'s parent, even inside your own tenant (composite foreign keys)', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo');
      await actAs(c, a.userId);
      const fk = /foreign key/i;
      await expectFail(c, `insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-X-777')`, [a.tenantId, b.customerId], fk);
      await expectFail(c, `insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'receipt', 'RC-777')`, [a.tenantId, b.jobId], fk);
      await expectFail(c, `insert into public.document_versions (tenant_id, document_id, version) values ($1, $2, 7)`, [a.tenantId, b.docId], fk);
      await expectFail(c, `insert into public.document_versions (tenant_id, document_id, version, bank_account_id) values ($1, $2, 7, $3)`, [a.tenantId, a.docId, b.bankAccountId], fk);
      // 002b: the app role cannot insert photos; the composite key is proved below on the server connection.
      await expectFail(c, `insert into public.job_photos (tenant_id, job_id, storage_path) values ($1, $2, $1::uuid::text || '/x.jpg')`, [a.tenantId, b.jobId], /permission denied/i);
      await expectFail(c, `insert into public.share_links (tenant_id, document_id, token_hash, expires_at) values ($1, $2, 'h777', now())`, [a.tenantId, b.docId], fk);
      await expectFail(c, `insert into public.document_emails (tenant_id, document_id) values ($1, $2)`, [a.tenantId, b.docId], fk);
      await expectFail(c, `insert into public.brand_assets (tenant_id, brand_kit_id, kind, storage_path) values ($1, $2, 'badge', $1::uuid::text || '/x.png')`, [a.tenantId, b.kitId], fk);
      await expectFail(c, `insert into public.job_types (tenant_id, key, label, cover_asset_id) values ($1, 'stolen', 'Stolen', $2)`, [a.tenantId, b.assetId], fk);
      // 002b: customer_id is not updatable by the app role; the composite key is proved below on the server connection.
      await expectFail(c, `update public.jobs set customer_id = $1 where id = $2`, [b.customerId, a.jobId], /permission denied/i);
      await expectFail(c, `update public.document_versions set bank_account_id = $1 where id = $2`, [b.bankAccountId, a.versionId], fk);
      // current_version_id is deferrable initially deferred: make it check now.
      await c.query('set constraints all immediate');
      await expectFail(c, `update public.documents set current_version_id = $1 where id = $2`, [b.versionId, a.docId], fk);
      // The same composite keys hold for the server, which bypasses row level security.
      await actAsServer(c);
      // A path of the right shape, so the foreign key (not the path check) is what refuses it.
      await expectFail(c, `insert into public.job_photos (id, tenant_id, job_id, storage_path) select g, $1, $2, $1::uuid::text || '/' || $3::uuid::text || '/' || $2::uuid::text || '/' || g::text || '.jpg' from gen_random_uuid() g`, [a.tenantId, b.jobId, a.customerId], fk);
      await expectFail(c, `update public.jobs set customer_id = $1 where id = $2`, [b.customerId, a.jobId], fk);
    });
  });

  it('a quote number already used by tenant B is not revealed to user A', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo');
      await actAs(c, a.userId);
      // B has used QT-Bravo-001. A forged insert into B must fail on row level security, not on "already used".
      await expectFail(c, `insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-Bravo-001')`, [b.tenantId, b.customerId], /row-level security/i);
    });
  });

  it('a disabled user sees nothing', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await c.query(`update public.profiles set disabled_at = now() where id = $1`, [a.userId]);
      await actAs(c, a.userId);
      for (const t of ['customers', 'jobs', 'documents', 'tenants', 'profiles']) {
        const r = await c.query(`select count(*)::int n from public.${t}`);
        expect(r.rows[0].n, t).toBe(0);
      }
    });
  });

  it('disabling a user cuts off reads and writes immediately, in the same session', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      const before = await c.query(`select count(*)::int n from public.customers`);
      expect(before.rows[0].n).toBeGreaterThan(0);
      await actAsServer(c);
      await c.query(`update public.profiles set disabled_at = now() where id = $1`, [a.userId]);
      await actAs(c, a.userId);
      for (const t of TENANT_TABLES.concat(['tenants', 'profiles'])) {
        const r = await c.query(`select count(*)::int n from public.${t}`);
        expect(r.rows[0].n, t).toBe(0);
      }
      await expectFail(c, `insert into public.customers (tenant_id, name) values ($1, 'Late')`, [a.tenantId], /row-level security/i);
      const upd = await c.query(`update public.customers set name = 'Late' where id = $1`, [a.customerId]);
      expect(upd.rowCount).toBe(0);
      const del = await c.query(`delete from public.job_types where tenant_id = $1`, [a.tenantId]);
      expect(del.rowCount).toBe(0);
    });
  });

  it('a signed-in user with no profile sees nothing', async () => {
    await withRollback(async (c) => {
      await seedTenant(c, 'Alpha');
      await actAs(c, '00000000-0000-4000-8000-000000000001');
      for (const t of TENANT_TABLES.concat(['tenants', 'profiles'])) {
        const r = await c.query(`select count(*)::int n from public.${t}`);
        expect(r.rows[0].n, t).toBe(0);
      }
    });
  });

  it('a signed-out visitor (anon) has no access to any table', async () => {
    await withRollback(async (c) => {
      await seedTenant(c, 'Alpha');
      await c.query('set local role anon');
      const tables = await c.query(`select tablename from pg_tables where schemaname = 'public'`);
      expect(tables.rowCount).toBeGreaterThan(15);
      for (const { tablename } of tables.rows) {
        await expectFail(c, `select * from public.${tablename}`, [], /permission denied/i);
      }
      for (const t of ['tenants', 'customers', 'bank_accounts', 'audit_log', 'profiles']) {
        await c.query('savepoint s');
        await expect(c.query(`select * from public.${t}`)).rejects.toThrow(/permission denied/i);
        await c.query('rollback to savepoint s');
      }
    });
  });

  it('the encrypted bank columns are not readable or writable by the app role', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      const safe = await c.query(`select id, account_name, bank_name, last4, is_default from public.bank_accounts`);
      expect(safe.rowCount).toBe(1);
      await c.query('savepoint s');
      await expect(c.query(`select sort_code_enc from public.bank_accounts`)).rejects.toThrow(/permission denied/i);
      await c.query('rollback to savepoint s');
      await expect(c.query(`select * from public.bank_accounts`)).rejects.toThrow(/permission denied/i);
      await c.query('rollback to savepoint s').catch(() => undefined);
    });
  });

  it('the app role cannot write bank accounts at all', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      const denied = /permission denied/i;
      await expectFail(c, `select account_number_enc from public.bank_accounts`, [], denied);
      await expectFail(c, `insert into public.bank_accounts (tenant_id, account_name, bank_name, sort_code_enc, account_number_enc, last4) values ($1, 'a', 'b', 'c', 'd', '0000')`, [a.tenantId], denied);
      await expectFail(c, `update public.bank_accounts set last4 = '9999' where id = $1`, [a.bankAccountId], denied);
      await expectFail(c, `update public.bank_accounts set is_default = true where id = $1`, [a.bankAccountId], denied);
      await expectFail(c, `delete from public.bank_accounts where id = $1`, [a.bankAccountId], denied);
    });
  });

  it('staff cannot change brand or defaults, owners can', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await c.query(`update public.profiles set role = 'staff' where id = $1`, [a.userId]);
      await actAs(c, a.userId);
      const staff = await c.query(`update public.tenant_defaults set vat_rate_bp = 0 where tenant_id = $1`, [a.tenantId]);
      expect(staff.rowCount).toBe(0);
      await actAsServer(c);
      await c.query(`update public.profiles set role = 'owner' where id = $1`, [a.userId]);
      await actAs(c, a.userId);
      const owner = await c.query(`update public.tenant_defaults set vat_rate_bp = 500 where tenant_id = $1`, [a.tenantId]);
      expect(owner.rowCount).toBe(1);
    });
  });

  it('staff cannot insert, update or delete brand kits, brand assets, job types, defaults or business details', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await c.query(`delete from public.tenant_defaults where tenant_id = $1`, [a.tenantId]);
      await c.query(`delete from public.brand_kits where tenant_id = $1`, [a.tenantId]);
      const kit = await c.query(`insert into public.brand_kits (tenant_id) values ($1) returning id`, [a.tenantId]);
      await c.query(`insert into public.brand_assets (tenant_id, brand_kit_id, kind, storage_path) values ($1, $2, 'badge', $1::uuid::text || '/b.png')`, [a.tenantId, kit.rows[0].id]);
      await c.query(`update public.profiles set role = 'staff' where id = $1`, [a.userId]);
      await actAs(c, a.userId);
      const rls = /row-level security/i;
      // Staff can still read them.
      for (const t of ['brand_kits', 'brand_assets', 'job_types']) {
        const r = await c.query(`select count(*)::int n from public.${t}`);
        expect(r.rows[0].n, `${t} readable by staff`).toBeGreaterThan(0);
      }
      await expectFail(c, `insert into public.tenant_defaults (tenant_id) values ($1)`, [a.tenantId], rls);
      await expectFail(c, `insert into public.job_types (tenant_id, key, label) values ($1, 'pitched', 'Pitched')`, [a.tenantId], rls);
      await expectFail(c, `insert into public.brand_assets (tenant_id, brand_kit_id, kind, storage_path) values ($1, $2, 'badge', $1::uuid::text || '/x.png')`, [a.tenantId, kit.rows[0].id], rls);
      for (const sql of [
        `update public.brand_kits set theme_key = 'x' where tenant_id = $1`,
        `update public.brand_assets set alt = 'x' where tenant_id = $1`,
        `update public.job_types set label = 'x' where tenant_id = $1`,
        `update public.tenants set name = 'x' where id = $1`,
        `delete from public.brand_assets where tenant_id = $1`,
        `delete from public.job_types where tenant_id = $1`,
        `delete from public.brand_kits where tenant_id = $1`,
      ]) {
        const r = await c.query(sql, [a.tenantId]);
        expect(r.rowCount, sql).toBe(0);
      }
      await actAsServer(c);
      await c.query(`delete from public.brand_kits where tenant_id = $1`, [a.tenantId]);
      await actAs(c, a.userId);
      await expectFail(c, `insert into public.brand_kits (tenant_id) values ($1)`, [a.tenantId], rls);
    });
  });

  it('nobody can promote themselves or edit profiles, and owners cannot change a business id', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo');
      await c.query(`update public.profiles set role = 'staff' where id = $1`, [a.userId]);
      await actAs(c, a.userId);
      const denied = /permission denied/i;
      await expectFail(c, `update public.profiles set role = 'owner' where id = $1`, [a.userId], denied);
      await expectFail(c, `update public.profiles set tenant_id = $1 where id = $2`, [b.tenantId, a.userId], denied);
      await expectFail(c, `update public.profiles set disabled_at = null where id = $1`, [a.userId], denied);
      await expectFail(c, `select disabled_at from public.profiles`, [], denied);
      await expectFail(c, `insert into public.profiles (id, tenant_id, role, full_name, email) values ($1, $2, 'owner', 'x', 'x@example.test')`, [a.userId, b.tenantId], denied);
      await expectFail(c, `delete from public.profiles where id = $1`, [a.userId], denied);
      await expectFail(c, `insert into public.tenants (name, trade_type, owner_name, owner_title) values ('New', 'roofing', 'x', 'y')`, [], denied);
      await expectFail(c, `delete from public.tenants where id = $1`, [a.tenantId], denied);
      await actAsServer(c);
      await c.query(`update public.profiles set role = 'owner' where id = $1`, [a.userId]);
      await actAs(c, a.userId);
      await expectFail(c, `update public.tenants set id = gen_random_uuid() where id = $1`, [a.tenantId], denied);
      await expectFail(c, `update public.tenants set created_at = now() where id = $1`, [a.tenantId], denied);
      const ok = await c.query(`update public.tenants set tagline = 'Roofing done right' where id = $1`, [a.tenantId]);
      expect(ok.rowCount).toBe(1);
    });
  });

  it('only owners can read the audit log, and nobody can write it from the app', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      const r = await c.query(`select count(*)::int n from public.audit_log`);
      expect(r.rows[0].n).toBe(1);
      await c.query('savepoint s');
      await expect(c.query(`insert into public.audit_log (tenant_id, action) values ($1, 'forged')`, [a.tenantId])).rejects.toThrow(/permission denied/i);
    });
  });

  it('staff cannot read the audit log; nobody can update or delete it from the app', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      const denied = /permission denied/i;
      await expectFail(c, `update public.audit_log set action = 'x'`, [], denied);
      await expectFail(c, `delete from public.audit_log`, [], denied);
      await actAsServer(c);
      await c.query(`update public.profiles set role = 'staff' where id = $1`, [a.userId]);
      await actAs(c, a.userId);
      const r = await c.query(`select count(*)::int n from public.audit_log`);
      expect(r.rows[0].n).toBe(0);
    });
  });

  it('the app role cannot touch login attempts or purge logs, and cannot delete customers', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      for (const sql of [`select * from public.login_attempts`, `select * from public.purge_log`, `delete from public.customers`]) {
        await c.query('savepoint s');
        await expect(c.query(sql)).rejects.toThrow(/permission denied/i);
        await c.query('rollback to savepoint s');
      }
    });
  });

  it('the app role cannot write login attempts, purge logs, migrations, or delete core records', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      const denied = /permission denied/i;
      for (const sql of [
        `insert into public.login_attempts (email_hash, kind, success) values ('h', 'request', true)`,
        `delete from public.login_attempts`,
        `insert into public.purge_log (customers_purged) values (0)`,
        `select * from public._migrations`,
        `insert into public._migrations (name) values ('999_evil.sql')`,
        `delete from public.jobs`,
        `delete from public.documents`,
        `delete from public.document_versions`,
        `delete from public.used_numbers`,
        `update public.used_numbers set number = 'x'`,
        `insert into public.ai_runs (tenant_id, model) values ('${a.tenantId}', 'x')`,
        `truncate public.customers`,
      ]) {
        await expectFail(c, sql, [], denied);
      }
    });
  });

  it('every public table has row level security enabled and forced', async () => {
    await withRollback(async (c) => {
      const r = await c.query(
        `select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'`,
      );
      expect(r.rowCount).toBeGreaterThan(15);
      for (const row of r.rows) {
        expect(row.relrowsecurity, `${row.relname} rls`).toBe(true);
        expect(row.relforcerowsecurity, `${row.relname} forced`).toBe(true);
      }
    });
  });

  it('anon has no table privileges at all', async () => {
    await withRollback(async (c) => {
      const r = await c.query(
        `select table_name, privilege_type from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon'`,
      );
      expect(r.rows).toEqual([]);
    });
  });
});
