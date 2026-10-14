import { randomUUID } from 'node:crypto';
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

/** Runs sql expecting failure and returns the error, inside a savepoint. */
async function errorOf(c: Client, sql: string, params: unknown[]): Promise<{ code?: string; constraint?: string; message: string }> {
  await c.query('savepoint x');
  try {
    await c.query(sql, params);
  } catch (e) {
    return e as { code?: string; constraint?: string; message: string };
  } finally {
    await c.query('rollback to savepoint x');
  }
  throw new Error(`expected failure: ${sql}`);
}

const POLICY_TABLES = [
  'tenants', 'profiles', 'brand_kits', 'brand_assets', 'job_types', 'bank_accounts', 'tenant_defaults', 'customers', 'jobs',
  'used_numbers', 'documents', 'document_versions', 'job_photos', 'share_links', 'document_emails', 'ai_runs', 'audit_log', 'payments',
];

describe.skipIf(!dbAvailable)('002b hardening', () => {
  it('the app role cannot write server-owned columns', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      const denied = /permission denied/i;
      const cases: [string, unknown[]][] = [
        [`update public.customers set purge_at = 'infinity' where id = $1`, [a.customerId]],
        [`update public.customers set last_activity_at = now() where id = $1`, [a.customerId]],
        [`insert into public.customers (tenant_id, name, purge_at) values ($1, 'x', 'infinity')`, [a.tenantId]],
        [`update public.jobs set reference = 'QT-NEW-1' where id = $1`, [a.jobId]],
        [`update public.jobs set created_by = null where id = $1`, [a.jobId]],
        [`insert into public.jobs (tenant_id, customer_id, reference, created_by) values ($1, $2, 'QT-CB-1', $3)`, [a.tenantId, a.customerId, randomUUID()]],
        [`insert into public.documents (tenant_id, job_id, type, number, status) values ($1, $2, 'receipt', 'RCP-QT-Alpha-001', 'final')`, [a.tenantId, a.jobId]],
        [`insert into public.documents (tenant_id, job_id, type, number, total_pence) values ($1, $2, 'receipt', 'RCP-QT-Alpha-001', 1)`, [a.tenantId, a.jobId]],
        [`update public.documents set total_pence = 1 where id = $1`, [a.docId]],
        [`update public.documents set status = 'final' where id = $1`, [a.docId]],
        [`update public.documents set finalised_at = now() where id = $1`, [a.docId]],
        [`update public.documents set pdf_path = $2 || '/x.pdf' where id = $1`, [a.docId, a.tenantId]],
        [`update public.documents set number = 'QT-OTHER' where id = $1`, [a.docId]],
        [`insert into public.document_versions (tenant_id, document_id, version, finalised_at) values ($1, $2, 2, now())`, [a.tenantId, a.docId]],
        [`insert into public.document_versions (tenant_id, document_id, version, ai_output) values ($1, $2, 2, '{}')`, [a.tenantId, a.docId]],
        [`insert into public.document_versions (tenant_id, document_id, version, money) values ($1, $2, 2, '{}')`, [a.tenantId, a.docId]],
        [`update public.document_versions set finalised_at = now() where id = $1`, [a.versionId]],
        [`update public.document_versions set money = '{}' where id = $1`, [a.versionId]],
        [`update public.document_versions set ai_output = '{}' where id = $1`, [a.versionId]],
        [`update public.document_versions set pdf_path = null where id = $1`, [a.versionId]],
        [`update public.document_versions set version = 9 where id = $1`, [a.versionId]],
        [`insert into public.job_photos (tenant_id, job_id, storage_path) values ($1, $2, $1::uuid::text || '/p.jpg')`, [a.tenantId, a.jobId]],
        [`update public.job_photos set storage_path = $1::uuid::text || '/other.jpg' where tenant_id = $1`, [a.tenantId]],
        [`update public.share_links set expires_at = now() + interval '1 day' where tenant_id = $1`, [a.tenantId]],
        [`update public.share_links set token_hash = 'x' where tenant_id = $1`, [a.tenantId]],
        [`insert into public.share_links (tenant_id, document_id, token_hash, expires_at, revoked_at) values ($1, $2, 'h1', now(), now())`, [a.tenantId, a.docId]],
        [`insert into public.share_links (tenant_id, document_id, token_hash, expires_at, created_at) values ($1, $2, 'h2', now() + interval '60 days', now() + interval '59 days')`, [a.tenantId, a.docId]],
        [`update public.document_emails set status = 'sent' where tenant_id = $1`, [a.tenantId]],
        [`update public.document_emails set sent_at = now() where tenant_id = $1`, [a.tenantId]],
        [`insert into public.document_emails (tenant_id, document_id, status) values ($1, $2, 'sent')`, [a.tenantId, a.docId]],
      ];
      for (const [sql, params] of cases) await expectFail(c, sql, params, denied);
    });
  });

  it('the app role can still do its normal work, and created_by is stamped from the JWT', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      const cust = await c.query(`insert into public.customers (tenant_id, name, postcode) values ($1, 'New', 'BR1 1AA') returning id`, [a.tenantId]);
      await c.query(`update public.customers set name = 'Renamed', phone = '0' where id = $1`, [cust.rows[0].id]);
      const job = await c.query(
        `insert into public.jobs (tenant_id, customer_id, reference, property_address, status) values ($1, $2, 'QT-OK-1', '1 Road', 'quoted') returning id, created_by`,
        [a.tenantId, cust.rows[0].id],
      );
      expect(job.rows[0].created_by).toBe(a.userId);
      await c.query(`update public.jobs set status = 'accepted', property_address = '2 Road' where id = $1`, [job.rows[0].id]);
      const doc = await c.query(
        `insert into public.documents (tenant_id, job_id, type, number, doc_date) values ($1, $2, 'quotation', 'QT-OK-1', current_date) returning id, created_by`,
        [a.tenantId, job.rows[0].id],
      );
      expect(doc.rows[0].created_by).toBe(a.userId);
      const ver = await c.query(
        `insert into public.document_versions (tenant_id, document_id, version, input, final_content, bank_account_id) values ($1, $2, 1, '{}', '{}', $3) returning id, created_by`,
        [a.tenantId, doc.rows[0].id, a.bankAccountId],
      );
      expect(ver.rows[0].created_by).toBe(a.userId);
      await c.query(`update public.document_versions set input = '{"a":1}' where id = $1`, [ver.rows[0].id]);
      await c.query(`update public.documents set current_version_id = $1, doc_date = current_date where id = $2`, [ver.rows[0].id, doc.rows[0].id]);
      await c.query(`update public.job_photos set finding_ref = 'F1' where tenant_id = $1`, [a.tenantId]);
      await c.query(`insert into public.share_links (tenant_id, document_id, token_hash, expires_at) values ($1, $2, 'ok-hash', now() + interval '7 days')`, [a.tenantId, doc.rows[0].id]);
      await c.query(`update public.share_links set revoked_at = now() where token_hash = 'ok-hash'`);
      await c.query(`insert into public.document_emails (tenant_id, document_id, to_email, subject, body) values ($1, $2, 'a@example.test', 's', 'b')`, [a.tenantId, doc.rows[0].id]);
      await c.query(`update public.document_emails set subject = 's2' where tenant_id = $1`, [a.tenantId]);
    });
  });

  it('a document is locked for the app role once it leaves draft; the server can still change it', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      const draft = await c.query(`update public.documents set doc_date = current_date where id = $1`, [a.docId]);
      expect(draft.rowCount).toBe(1);
      await actAsServer(c);
      await c.query(`update public.documents set status = 'final' where id = $1`, [a.docId]);
      await actAs(c, a.userId);
      await expectFail(c, `update public.documents set doc_date = current_date where id = $1`, [a.docId], /only a draft/i);
      await expectFail(c, `update public.documents set current_version_id = $2 where id = $1`, [a.docId, a.versionId], /only a draft/i);
      await actAsServer(c);
      const server = await c.query(`update public.documents set status = 'sent', sent_at = now() where id = $1`, [a.docId]);
      expect(server.rowCount).toBe(1);
    });
  });

  it('a revoked share link cannot be reinstated, and links last at most 30 days', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      await c.query(`update public.share_links set revoked_at = now() where tenant_id = $1`, [a.tenantId]);
      await expectFail(c, `update public.share_links set revoked_at = null where tenant_id = $1`, [a.tenantId], /cannot be reinstated/i);
      await expectFail(c, `update public.share_links set revoked_at = now() + interval '1 day' where tenant_id = $1`, [a.tenantId], /cannot be reinstated/i);
      await expectFail(
        c,
        `insert into public.share_links (tenant_id, document_id, token_hash, expires_at) values ($1, $2, 'long', now() + interval '31 days')`,
        [a.tenantId, a.docId],
        /share_links_max_30_days/,
      );
      await actAsServer(c);
      await expectFail(c, `update public.share_links set revoked_at = null where tenant_id = $1`, [a.tenantId], /cannot be reinstated/i);
    });
  });

  it('storage paths must sit inside the tenant prefix and never contain ..', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo');
      const bad = [`${b.tenantId}/stolen.png`, `${a.tenantId}/../${b.tenantId}/x.png`, 'no-prefix.png', `x${a.tenantId}/y.png`];
      for (const p of bad) {
        await expectFail(c, `insert into public.job_photos (tenant_id, job_id, storage_path) values ($1, $2, $3)`, [a.tenantId, a.jobId, p], /job_photos_path_in_tenant/);
        await expectFail(c, `insert into public.brand_assets (tenant_id, brand_kit_id, kind, storage_path) values ($1, $2, 'badge', $3)`, [a.tenantId, a.kitId, p], /brand_assets_path_in_tenant/);
        await expectFail(c, `update public.documents set pdf_path = $2 where id = $1`, [a.docId, p], /documents_pdf_path_in_tenant/);
        await expectFail(c, `update public.document_versions set pdf_path = $2 where id = $1`, [a.versionId, p], /document_versions_pdf_path_in_tenant/);
      }
      const good = `${a.tenantId}/docs/QT-1.pdf`;
      await c.query(`update public.documents set pdf_path = $2 where id = $1`, [a.docId, good]);
      await c.query(`update public.document_versions set pdf_path = $2 where id = $1`, [a.versionId, good]);
      await c.query(`update public.documents set pdf_path = null where id = $1`, [a.docId]);
    });
  });

  it('a version pointing at another tenant\'s real document fails exactly like one pointing at a random id', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Bravo'); // B's document has version 1
      await actAs(c, a.userId);
      const sql = `insert into public.document_versions (tenant_id, document_id, version) values ($1, $2, 1)`;
      const real = await errorOf(c, sql, [a.tenantId, b.docId]);
      const fake = await errorOf(c, sql, [a.tenantId, randomUUID()]);
      expect(real.code).toBe('23503');
      expect(real.code).toBe(fake.code);
      expect(real.constraint).toBe(fake.constraint);
      const norm = (m: string) => m.replace(/[0-9a-f-]{36}/g, '<id>');
      expect(norm(real.message)).toBe(norm(fake.message));
    });
  });

  it('as the app role, creating a job, a document, a version and editing a version each push the purge date out', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const soon = async () => {
        await actAsServer(c);
        await c.query(`update public.customers set purge_at = now() + interval '1 day' where id = $1`, [a.customerId]);
        await actAs(c, a.userId);
      };
      const extended = async (step: string) => {
        await actAsServer(c);
        const r = await c.query(
          `select purge_at between now() + interval '89 days' and now() + interval '91 days' ok from public.customers where id = $1`,
          [a.customerId],
        );
        expect(r.rows[0].ok, step).toBe(true);
        await actAs(c, a.userId);
      };
      await soon();
      const job = await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-P-1') returning id`, [a.tenantId, a.customerId]);
      await extended('job');
      await soon();
      const doc = await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'quotation', 'QT-P-1') returning id`, [a.tenantId, job.rows[0].id]);
      await extended('document');
      await soon();
      const ver = await c.query(`insert into public.document_versions (tenant_id, document_id, version) values ($1, $2, 1) returning id`, [a.tenantId, doc.rows[0].id]);
      await extended('version insert');
      await soon();
      await c.query(`update public.document_versions set input = '{"edited":true}' where id = $1`, [ver.rows[0].id]);
      await extended('version edit');
    });
  });

  it('registry numbers are 1 to 64 characters in used_numbers', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await expectFail(c, `insert into public.used_numbers (tenant_id, number) values ($1, '')`, [a.tenantId], /used_numbers_number_length/);
      await expectFail(c, `insert into public.used_numbers (tenant_id, number) values ($1, $2)`, [a.tenantId, 'Q'.repeat(65)], /used_numbers_number_length/);
      await c.query(`insert into public.used_numbers (tenant_id, number) values ($1, $2)`, [a.tenantId, 'Q'.repeat(64)]);
    });
  });

  it('the purge override does not count when the caller carries an app-role JWT', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      await c.query(`update public.document_versions set finalised_at = now() where id = $1`, [a.versionId]);
      // The app role itself: no delete privilege at all, flag or not.
      await actAs(c, a.userId);
      await c.query(`select set_config('app.allow_final_delete', 'on', true)`);
      await expectFail(c, `delete from public.document_versions where id = $1`, [a.versionId], /permission denied/i);
      // A privileged connection that is carrying an app-role JWT (as a security definer path or a
      // misconfigured server route would): the trigger still refuses, even with the flag on.
      await actAsServer(c);
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: a.userId, role: 'authenticated' })]);
      expect((await c.query(`select current_user u`)).rows[0].u).not.toBe('authenticated');
      expect((await c.query(`select current_setting('app.allow_final_delete', true) v`)).rows[0].v).toBe('on');
      expect((await c.query(`select current_setting('request.jwt.claims', true)::jsonb ->> 'role' r`)).rows[0].r).toBe('authenticated');
      await expectFail(c, `delete from public.document_versions where id = $1`, [a.versionId], /cannot be deleted/i);
      // Control: the same connection as the server (no app claims) may purge with the flag.
      await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
      const del = await c.query(`delete from public.document_versions where id = $1`, [a.versionId]);
      expect(del.rowCount).toBe(1);
    });
  });

  it('every policy-bearing public table has a restrictive ALL policy named active_profile_only', async () => {
    await withRollback(async (c) => {
      const r = await c.query(
        `select tablename from pg_policies where schemaname = 'public' and policyname = 'active_profile_only'
         and permissive = 'RESTRICTIVE' and cmd = 'ALL' and roles @> array['authenticated']::name[]`,
      );
      expect(r.rows.map((x) => x.tablename).sort()).toEqual([...POLICY_TABLES].sort());
      // And no table carries a policy without the guard.
      const g = await c.query(
        `select distinct tablename from pg_policies where schemaname = 'public'
         except select tablename from pg_policies where schemaname = 'public' and policyname = 'active_profile_only'`,
      );
      expect(g.rows).toEqual([]);
    });
  });

  it('there are no views or materialized views in public without security_invoker', async () => {
    await withRollback(async (c) => {
      const r = await c.query(
        `select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('v', 'm')
           and (c.relkind = 'm' or not coalesce(c.reloptions @> array['security_invoker=true'], false))`,
      );
      expect(r.rows).toEqual([]);
    });
  });
});
