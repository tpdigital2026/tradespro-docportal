import { describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { actAs, dbAvailable, withRollback } from './helpers';
import { seedTenant } from './seed';

async function expectFail(c: Client, sql: string, pattern: RegExp): Promise<void> {
  await c.query('savepoint x');
  try {
    await expect(c.query(sql), sql).rejects.toThrow(pattern);
  } finally {
    await c.query('rollback to savepoint x');
  }
}

describe.skipIf(!dbAvailable)('privileges on functions, schemas and sequences', () => {
  it('the private helpers exist and are executable by authenticated and service_role only', async () => {
    await withRollback(async (c) => {
      for (const fn of ['private.current_tenant_id()', 'private.is_owner()']) {
        const r = await c.query(
          `select has_function_privilege('anon', $1, 'execute') anon,
                  has_function_privilege('authenticated', $1, 'execute') authed,
                  has_function_privilege('service_role', $1, 'execute') service`,
          [fn],
        );
        expect(r.rows[0], fn).toEqual({ anon: false, authed: true, service: true });
      }
    });
  });

  it('anon cannot use the private schema or call its functions', async () => {
    await withRollback(async (c) => {
      const s = await c.query(`select has_schema_privilege('anon', 'private', 'usage') u`);
      expect(s.rows[0].u).toBe(false);
      await c.query('set local role anon');
      await c.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true)`);
      await expectFail(c, `select private.current_tenant_id()`, /permission denied/i);
      await expectFail(c, `select private.is_owner()`, /permission denied/i);
    });
  });

  it('no function in the private schema is executable by PUBLIC or anon, and only the two helpers by authenticated', async () => {
    await withRollback(async (c) => {
      const r = await c.query(
        `select p.oid::regprocedure::text fn,
                has_function_privilege('anon', p.oid, 'execute') anon,
                has_function_privilege('authenticated', p.oid, 'execute') authed,
                coalesce(p.proacl::text, 'DEFAULT') acl
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private'`,
      );
      expect(r.rowCount).toBeGreaterThanOrEqual(2);
      for (const row of r.rows) {
        expect(row.anon, `${row.fn} anon`).toBe(false);
        // A null ACL means the default, which grants EXECUTE to PUBLIC.
        expect(row.acl, `${row.fn} acl`).not.toBe('DEFAULT');
        expect(row.acl, `${row.fn} acl has no PUBLIC entry`).not.toMatch(/[{,]=X/);
        const helper = ['private.current_tenant_id()', 'private.is_owner()'].includes(row.fn);
        expect(row.authed, `${row.fn} authenticated`).toBe(helper);
      }
    });
  });

  it('every security definer function pins its search_path', async () => {
    await withRollback(async (c) => {
      const r = await c.query(
        `select p.oid::regprocedure::text fn, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('public', 'private') and p.prosecdef`,
      );
      expect(r.rowCount).toBeGreaterThanOrEqual(2);
      for (const row of r.rows) {
        expect((row.proconfig ?? []).some((s: string) => s.startsWith('search_path=')), row.fn).toBe(true);
      }
    });
  });

  it('the public schema exposes no functions to anon or authenticated', async () => {
    await withRollback(async (c) => {
      const r = await c.query(
        `select p.oid::regprocedure::text fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))`,
      );
      expect(r.rows).toEqual([]);
      const g = await c.query(
        `select routine_name, grantee from information_schema.routine_privileges
         where routine_schema = 'public' and grantee in ('anon', 'authenticated', 'PUBLIC')`,
      );
      expect(g.rows).toEqual([]);
    });
  });

  it('new objects in public do not inherit grants for anon or authenticated (default privileges, our role)', async () => {
    await withRollback(async (c) => {
      const r = await c.query(
        `select defaclobjtype, defaclacl::text acl from pg_default_acl
         where defaclrole = current_user::regrole and defaclnamespace = 'public'::regnamespace`,
      );
      for (const row of r.rows) {
        expect(row.acl, `default ${row.defaclobjtype}`).not.toMatch(/\banon=/);
        expect(row.acl, `default ${row.defaclobjtype}`).not.toMatch(/\bauthenticated=/);
      }
      // Proved by doing it: a table created now is invisible to anon and authenticated.
      await c.query(`create table public.zz_default_priv_probe (id int)`);
      const g = await c.query(
        `select grantee from information_schema.role_table_grants where table_schema = 'public' and table_name = 'zz_default_priv_probe' and grantee in ('anon', 'authenticated')`,
      );
      expect(g.rows).toEqual([]);
      await c.query(`create function public.zz_probe_fn() returns int language sql as 'select 1'`);
      const f = await c.query(
        `select has_function_privilege('anon', 'public.zz_probe_fn()', 'execute') a, has_function_privilege('authenticated', 'public.zz_probe_fn()', 'execute') b`,
      );
      expect(f.rows[0]).toEqual({ a: false, b: false });
    });
  });

  it('new functions in private are not executable by PUBLIC by default', async () => {
    await withRollback(async (c) => {
      await c.query(`create function private.zz_probe_fn() returns int language sql as 'select 1'`);
      const f = await c.query(`select has_function_privilege('authenticated', 'private.zz_probe_fn()', 'execute') b`);
      expect(f.rows[0].b).toBe(false);
    });
  });

  it('anon and authenticated cannot use any public sequence (including the audit log identity)', async () => {
    await withRollback(async (c) => {
      const r = await c.query(
        `select c.oid::regclass::text seq,
                has_sequence_privilege('anon', c.oid, 'usage,select,update') anon,
                has_sequence_privilege('authenticated', c.oid, 'usage,select,update') authed
         from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'S'`,
      );
      expect(r.rows.map((x) => x.seq)).toContain('audit_log_id_seq');
      for (const row of r.rows) {
        expect(row.anon, `${row.seq} anon`).toBe(false);
        expect(row.authed, `${row.seq} authenticated`).toBe(false);
      }
      const a = await seedTenant(c, 'Alpha');
      await actAs(c, a.userId);
      await expectFail(c, `select nextval('public.audit_log_id_seq')`, /permission denied/i);
      await expectFail(c, `select setval('public.audit_log_id_seq', 1)`, /permission denied/i);
    });
  });
});
