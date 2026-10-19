import { describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { connect } from '../../src/db/connect';
import { actAsServer, createTenantWithUser, dbAvailable, withRollback } from './helpers';

async function customerWithJob(c: import('pg').Client, tenantId: string, ref: string, purgeAtSql: string) {
  const cust = await c.query(`insert into public.customers (tenant_id, name, purge_at) values ($1, 'Cust', ${purgeAtSql}) returning id`, [tenantId]);
  const job = await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, $3) returning id`, [tenantId, cust.rows[0].id, ref]);
  // jobs trigger pushed purge_at out; set it back for the test
  await c.query(`update public.customers set purge_at = ${purgeAtSql} where id = $1`, [cust.rows[0].id]);
  const doc = await c.query(`insert into public.documents (tenant_id, job_id, type, number, pdf_path) values ($1, $2, 'quotation', $3, $4) returning id`, [tenantId, job.rows[0].id, ref, `${tenantId}/pdfs/${ref}.pdf`]);
  await c.query(`update public.customers set purge_at = ${purgeAtSql} where id = $1`, [cust.rows[0].id]);
  const v = await c.query(`insert into public.document_versions (tenant_id, document_id, version, pdf_path, finalised_at) values ($1, $2, 1, $3, now()) returning id`, [tenantId, doc.rows[0].id, `${tenantId}/pdfs/${ref}-v1.pdf`]);
  await c.query(`insert into public.job_photos (id, tenant_id, job_id, storage_path) select g, $1, $2, $1::uuid::text || '/' || $3::uuid::text || '/' || $2::uuid::text || '/' || g::text || '.jpg' from gen_random_uuid() g`, [tenantId, job.rows[0].id, cust.rows[0].id]);
  await c.query(`update public.customers set purge_at = ${purgeAtSql} where id = $1`, [cust.rows[0].id]);
  return { customerId: cust.rows[0].id as string, jobId: job.rows[0].id as string, documentId: doc.rows[0].id as string, versionId: v.rows[0].id as string };
}


const FUNCTIONS: { sql: string; args: string }[] = [
  { sql: 'private.claim_expired_customers(now())', args: '' },
  { sql: 'private.expired_storage_paths(array[]::uuid[])', args: '' },
  { sql: 'private.purge_customers(array[]::uuid[], now())', args: '' },
  { sql: 'private.erase_customer(gen_random_uuid(), gen_random_uuid())', args: '' },
  { sql: 'private.customer_storage_paths(gen_random_uuid(), gen_random_uuid())', args: '' },
  { sql: 'private.purge_old_login_attempts()', args: '' },
];

async function count(c: import('pg').Client, table: string, tenantId: string) {
  const n = await c.query(`select count(*)::int n from public.${table} where tenant_id = $1`, [tenantId]);
  return n.rows[0].n as number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A committed expired customer with a full set of children that other connections can see. */
async function committedFixture() {
  const setup = await connect();
  const open: Client[] = [setup];
  let tenantId: string | undefined;
  let userId: string | undefined;
  async function cleanup() {
    const errors: unknown[] = [];
    for (const c of open.slice(1)) await c.query('rollback').catch(() => undefined);
    try {
      if (tenantId) {
        await setup.query(`delete from public.tenants where id = $1`, [tenantId]);
        await setup.query(`delete from auth.users where id = $1`, [userId]);
        const left = await setup.query(
          `select (select count(*) from public.tenants where id = $1)::int tenants, (select count(*) from auth.users where id = $2)::int users`,
          [tenantId, userId],
        );
        if (left.rows[0].tenants !== 0 || left.rows[0].users !== 0) errors.push(new Error(`LockTest fixture left behind: ${JSON.stringify(left.rows[0])}`));
      }
    } catch (e) {
      errors.push(e);
    }
    for (const c of open) await c.end().catch((e) => errors.push(e));
    if (errors.length) throw new AggregateError(errors, 'fixture cleanup failed');
  }
  try {
    const t = await createTenantWithUser(setup, 'LockTest');
    tenantId = t.tenantId;
    userId = t.userId;
    const cust = await setup.query(`insert into public.customers (tenant_id, name, purge_at) values ($1, 'Cust', now() + interval '1 day') returning id`, [tenantId]);
    const customerId = cust.rows[0].id as string;
    const job = await setup.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-LOCK-001') returning id`, [tenantId, customerId]);
    const jobId = job.rows[0].id as string;
    const doc = await setup.query(`insert into public.documents (tenant_id, job_id, type, number, pdf_path) values ($1, $2, 'quotation', 'QT-LOCK-001', $3) returning id`, [tenantId, jobId, `${tenantId}/pdfs/QT-LOCK-001.pdf`]);
    const documentId = doc.rows[0].id as string;
    const ver = await setup.query(`insert into public.document_versions (tenant_id, document_id, version) values ($1, $2, 1) returning id`, [tenantId, documentId]);
    const versionId = ver.rows[0].id as string;
    await setup.query(`insert into public.job_photos (id, tenant_id, job_id, storage_path) select g, $1, $2, $1::uuid::text || '/' || $3::uuid::text || '/' || $2::uuid::text || '/' || g::text || '.jpg' from gen_random_uuid() g`, [tenantId, jobId, customerId]);
    await setup.query(`insert into public.share_links (tenant_id, document_id, token_hash, expires_at) values ($1, $2, 'lock-hash', now() + interval '1 day')`, [tenantId, documentId]);
    await setup.query(`insert into public.document_emails (tenant_id, document_id) values ($1, $2)`, [tenantId, documentId]);
    await setup.query(`insert into public.ai_runs (tenant_id, document_id, model) values ($1, $2, 'm')`, [tenantId, documentId]);
    const inv = await setup.query(`insert into public.documents (tenant_id, job_id, type, number, status) values ($1, $2, 'invoice_full', 'INV-QT-LOCK-001', 'final') returning id`, [tenantId, jobId]);
    await setup.query(`insert into public.payments (tenant_id, job_id, document_id, amount_pence, paid_on, method) values ($1, $2, $3, 100, current_date, 'cash')`, [tenantId, jobId, inv.rows[0].id]);
    await setup.query(`insert into public.appointments (tenant_id, kind, title, starts_at, job_id) values ($1, 'site_visit', 'Visit', now() + interval '2 days', $2)`, [tenantId, jobId]);
    await setup.query(`update public.customers set purge_at = now() - interval '1 day' where id = $1`, [customerId]);
    return {
      tenantId: t.tenantId,
      userId: t.userId,
      customerId,
      jobId,
      documentId,
      versionId,
      setup,
      async client() {
        const c = await connect();
        open.push(c);
        return c;
      },
      cleanup,
    };
  } catch (e) {
    await cleanup().catch(() => undefined);
    throw e;
  }
}

type Fx = Awaited<ReturnType<typeof committedFixture>>;

/** Runs fn with a committed fixture; cleanup failures never hide the test's own failure. */
async function withFixture(fn: (fx: Fx) => Promise<void>) {
  const fx = await committedFixture();
  let primary: unknown;
  try {
    await fn(fx);
  } catch (e) {
    primary = e;
  }
  try {
    await fx.cleanup();
  } catch (e) {
    if (primary) throw new AggregateError([primary, e], 'test failed and cleanup failed too');
    throw e;
  }
  if (primary) throw primary;
}

async function waitUntilBlocked(setup: Client, pid: number) {
  for (let i = 0; i < 50; i++) {
    const r = await setup.query(`select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'`, [pid]);
    if (r.rows.length) return;
    await sleep(100);
  }
  throw new Error('the write never blocked on a lock');
}

const WRITES: Record<string, (fx: Fx) => { sql: string; params: unknown[] }> = {
  'photo insert': (fx) => ({ sql: `insert into public.job_photos (id, tenant_id, job_id, storage_path) select g, $1, $2, $1::uuid::text || '/' || $3::uuid::text || '/' || $2::uuid::text || '/' || g::text || '.jpg' from gen_random_uuid() g`, params: [fx.tenantId, fx.jobId, fx.customerId] }),
  'photo path update': (fx) => ({ sql: `update public.job_photos set storage_path = tenant_id::text || '/' || $2::uuid::text || '/' || job_id::text || '/' || id::text || '.jpg' where tenant_id = $1`, params: [fx.tenantId, fx.customerId] }),
  'document insert': (fx) => ({ sql: `insert into public.documents (tenant_id, job_id, type, number, pdf_path) values ($1, $2, 'guarantee', 'IN-LOCK-002', $3)`, params: [fx.tenantId, fx.jobId, `${fx.tenantId}/pdfs/IN-LOCK-002.pdf`] }),
  'job insert': (fx) => ({ sql: `insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, 'QT-LOCK-003')`, params: [fx.tenantId, fx.customerId] }),
  'draft version update': (fx) => ({ sql: `update public.document_versions set input = '{"x":1}' where id = $1`, params: [fx.versionId] }),
  'appointment insert': (fx) => ({ sql: `insert into public.appointments (tenant_id, kind, title, starts_at, customer_id) values ($1, 'survey', 'Late', now() + interval '1 day', $2)`, params: [fx.tenantId, fx.customerId] }),
};

// Tables the claim locks, in lock order. The schema-derived set below must equal this list minus customers.
const LOCKED_TABLES = ['customers', 'jobs', 'documents', 'document_versions', 'job_photos', 'share_links', 'document_emails', 'ai_runs', 'payments', 'appointments'];

describe.skipIf(!dbAvailable)('purge claim locks (two connections)', () => {
  it('the claim locks every table the customer cascade reaches', async () => {
    await withRollback(async (c) => {
      const r = await c.query(`
        with recursive reach(rel, via_cascade) as (
          select 'public.customers'::regclass::oid, true
          union
          select con.conrelid, con.confdeltype = 'c'
          from pg_constraint con join reach on con.confrelid = reach.rel
          where con.contype = 'f' and con.confdeltype in ('c', 'n') and reach.via_cascade
        )
        select distinct rel::regclass::text as t from reach`);
      const reached = r.rows.map((x) => String(x.t).replace(/^public\./, '')).sort();
      expect(reached, 'a new cascade child exists: lock it in claim_expired_customers and add it to LOCKED_TABLES').toEqual([...LOCKED_TABLES].sort());
    });
  });

  it('after a claim, a rival cannot lock a row in any of those tables', async () => {
    await withFixture(async (fx) => {
      const claimer = await fx.client();
      const rival = await fx.client();
      await claimer.query('begin');
      await claimer.query(`select id from private.claim_expired_customers(now())`);
      for (const table of LOCKED_TABLES) {
        await rival.query('begin');
        await expect(rival.query(`select 1 from public.${table} where tenant_id = $1 for update nowait`, [fx.tenantId]), table).rejects.toThrow(/could not obtain lock/i);
        await rival.query('rollback');
      }
      await claimer.query('rollback');
    });
  });

  for (const [label, write] of Object.entries(WRITES)) {
    it(`${label} waits on the claim; if the purge is aborted the write goes through and keeps the customer`, async () => {
      await withFixture(async (fx) => {
        const claimer = await fx.client();
        const rival = await fx.client();
        const pid = (await rival.query('select pg_backend_pid() as pid')).rows[0].pid as number;
        await claimer.query('begin');
        const claimed = await claimer.query(`select id from private.claim_expired_customers(now())`);
        expect(claimed.rows.map((r) => r.id)).toContain(fx.customerId);
        const w = write(fx);
        let settled = false;
        const pending = rival.query(w.sql, w.params).finally(() => { settled = true; });
        await waitUntilBlocked(fx.setup, pid);
        expect(settled).toBe(false);
        await claimer.query('rollback');
        await pending;
        const c = await fx.setup.query(`select purge_at > now() + interval '89 days' as kept from public.customers where id = $1`, [fx.customerId]);
        expect(c.rows[0].kept).toBe(true);
      });
    });

    it(`${label} waits on the claim; if the purge commits the write is stopped and nothing is orphaned`, async () => {
      await withFixture(async (fx) => {
        const claimer = await fx.client();
        const rival = await fx.client();
        const pid = (await rival.query('select pg_backend_pid() as pid')).rows[0].pid as number;
        await claimer.query('begin');
        const claimed = await claimer.query(`select id from private.claim_expired_customers(now())`);
        expect(claimed.rows.map((r) => r.id)).toContain(fx.customerId);
        const listed = await claimer.query(`select private.expired_storage_paths($1::uuid[]) as p`, [[fx.customerId]]);
        expect(listed.rows.map((r) => r.p).sort()).toEqual([expect.stringMatching(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/), `${fx.tenantId}/pdfs/QT-LOCK-001.pdf`]);
        const w = write(fx);
        const pending = rival.query(w.sql, w.params).then((r) => ({ rowCount: r.rowCount, code: undefined as string | undefined }), (e) => ({ rowCount: -1, code: (e as { code?: string }).code }));
        await waitUntilBlocked(fx.setup, pid);
        const purged = await claimer.query(`select private.purge_customers($1::uuid[], now()) as ids`, [[fx.customerId]]);
        expect(purged.rows[0].ids).toEqual([fx.customerId]);
        await claimer.query('commit');
        const outcome = await pending;
        // Inserts fail their foreign key; an update finds the row gone and changes nothing.
        expect(outcome.code === '23503' || outcome.rowCount === 0, JSON.stringify(outcome)).toBe(true);
        const photos = await fx.setup.query(`select count(*)::int n from public.job_photos where tenant_id = $1`, [fx.tenantId]);
        expect(photos.rows[0].n).toBe(0);
      });
    });
  }

  it('a draft version update that holds its lock first wins: the claim skips the touched customer, no deadlock', async () => {
    await withFixture(async (fx) => {
      const writer = await fx.client();
      const claimer = await fx.client();
      const pid = (await claimer.query('select pg_backend_pid() as pid')).rows[0].pid as number;
      await writer.query('begin');
      await writer.query(`update public.document_versions set input = '{"x":1}' where id = $1`, [fx.versionId]); // holds the version lock, touch trigger takes the customer lock
      await claimer.query('begin');
      const claiming = claimer.query(`select id from private.claim_expired_customers(now())`);
      await waitUntilBlocked(fx.setup, pid);
      await writer.query('commit');
      const claimed = await claiming;
      expect(claimed.rows.map((r) => r.id)).not.toContain(fx.customerId);
      await claimer.query('commit');
      const c = await fx.setup.query(`select count(*)::int n from public.customers where id = $1`, [fx.customerId]);
      expect(c.rows[0].n).toBe(1);
    });
  });

  it('purge_customers skips a customer another transaction holds locked', async () => {
    await withFixture(async (fx) => {
      const holder = await fx.client();
      const purger = await fx.client();
      await holder.query('begin');
      await holder.query(`select id from public.customers where id = $1 for update`, [fx.customerId]);
      await purger.query('begin');
      const r = await purger.query(`select private.purge_customers($1::uuid[], now()) as ids`, [[fx.customerId]]);
      expect(r.rows[0].ids).toEqual([]);
      await purger.query('rollback');
    });
  });
});

describe.skipIf(!dbAvailable)('purge protocol and erase', () => {
  it('claim returns only expired customers', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const old = await customerWithJob(c, t.tenantId, 'QT-OLD-001', `now() - interval '1 day'`);
      await customerWithJob(c, t.tenantId, 'QT-NEW-001', `now() + interval '10 days'`);
      const claimed = await c.query(`select id from private.claim_expired_customers(now())`);
      expect(claimed.rows.map((r) => r.id)).toEqual([old.customerId]);
    });
  });

  it('claim never looks into the future', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      await customerWithJob(c, t.tenantId, 'QT-NEW-001', `now() + interval '10 days'`);
      const claimed = await c.query(`select id from private.claim_expired_customers(now() + interval '100 years')`);
      expect(claimed.rows).toHaveLength(0);
    });
  });

  it('lists the stored files of expired customers only', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const old = await customerWithJob(c, t.tenantId, 'QT-OLD-001', `now() - interval '1 day'`);
      const live = await customerWithJob(c, t.tenantId, 'QT-NEW-001', `now() + interval '10 days'`);
      const paths = await c.query(`select private.expired_storage_paths($1::uuid[]) as p`, [[old.customerId, live.customerId]]);
      expect(paths.rows.map((r) => r.p).sort()).toEqual([expect.stringMatching(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/), `${t.tenantId}/pdfs/QT-OLD-001-v1.pdf`, `${t.tenantId}/pdfs/QT-OLD-001.pdf`]);
      const none = await c.query(`select private.expired_storage_paths($1::uuid[]) as p`, [[live.customerId]]);
      expect(none.rows).toHaveLength(0);
    });
  });

  it('purges only the claimed expired customers, cascades, logs a count, and keeps used numbers and the audit trail', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const old = await customerWithJob(c, t.tenantId, 'QT-OLD-001', `now() - interval '1 day'`);
      const keep = await customerWithJob(c, t.tenantId, 'QT-NEW-001', `now() + interval '10 days'`);
      await c.query(`insert into public.audit_log (tenant_id, action) values ($1, 'kept')`, [t.tenantId]);
      const before = await c.query(`select count(*)::int n from public.purge_log`);
      const claimed = await c.query(`select id from private.claim_expired_customers(now())`);
      const r = await c.query(`select private.purge_customers($1::uuid[], now()) as ids`, [claimed.rows.map((x) => x.id)]);
      expect(r.rows[0].ids).toEqual([old.customerId]);
      const left = await c.query(`select id from public.customers where tenant_id = $1`, [t.tenantId]);
      expect(left.rows.map((x) => x.id)).toEqual([keep.customerId]);
      for (const table of ['jobs', 'documents', 'document_versions', 'job_photos']) expect(await count(c, table, t.tenantId), table).toBe(1);
      const used = await c.query(`select number from public.used_numbers where tenant_id = $1 order by number`, [t.tenantId]);
      expect(used.rows.map((x) => x.number)).toEqual(['QT-NEW-001', 'QT-OLD-001']);
      expect(await count(c, 'audit_log', t.tenantId)).toBe(1);
      const log = await c.query(`select customers_purged from public.purge_log order by id desc limit 1`);
      expect(log.rows[0].customers_purged).toBe(1);
      const after = await c.query(`select count(*)::int n from public.purge_log`);
      expect(after.rows[0].n).toBe(before.rows[0].n + 1);
    });
  });

  it('a customer touched after the claim is not deleted', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const old = await customerWithJob(c, t.tenantId, 'QT-OLD-001', `now() - interval '1 day'`);
      const claimed = await c.query(`select id from private.claim_expired_customers(now())`);
      expect(claimed.rows).toHaveLength(1);
      await c.query(`update public.customers set purge_at = now() + interval '90 days' where id = $1`, [old.customerId]);
      const r = await c.query(`select private.purge_customers($1::uuid[], now()) as ids`, [claimed.rows.map((x) => x.id)]);
      expect(r.rows[0].ids).toEqual([]);
      for (const table of ['customers', 'jobs', 'documents', 'document_versions', 'job_photos']) expect(await count(c, table, t.tenantId), table).toBe(1);
      const log = await c.query(`select customers_purged from public.purge_log order by id desc limit 1`);
      expect(log.rows[0].customers_purged).toBe(0);
    });
  });

  it('purge_customers with a far-future p_now does not delete unexpired customers', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const live = await customerWithJob(c, t.tenantId, 'QT-NEW-001', `now() + interval '10 days'`);
      const r = await c.query(`select private.purge_customers($1::uuid[], now() + interval '100 years') as ids`, [[live.customerId]]);
      expect(r.rows[0].ids).toEqual([]);
      expect(await count(c, 'customers', t.tenantId)).toBe(1);
    });
  });

  it('customer_storage_paths is tenant scoped', async () => {
    await withRollback(async (c) => {
      const a = await createTenantWithUser(c, 'Alpha');
      const b = await createTenantWithUser(c, 'Bravo');
      const ca = await customerWithJob(c, a.tenantId, 'QT-A-001', `now() + interval '10 days'`);
      const wrong = await c.query(`select private.customer_storage_paths($1, $2) as p`, [b.tenantId, ca.customerId]);
      expect(wrong.rows).toHaveLength(0);
      const right = await c.query(`select private.customer_storage_paths($1, $2) as p`, [a.tenantId, ca.customerId]);
      expect(right.rows.map((r) => r.p).sort()).toEqual([expect.stringMatching(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/), `${a.tenantId}/pdfs/QT-A-001-v1.pdf`, `${a.tenantId}/pdfs/QT-A-001.pdf`]);
    });
  });

  it('erase_customer deletes one customer in the named tenant only, with the full cascade', async () => {
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
      for (const table of ['jobs', 'documents', 'document_versions', 'job_photos']) {
        expect(await count(c, table, a.tenantId), `${table} A`).toBe(0);
        expect(await count(c, table, b.tenantId), `${table} B`).toBe(1);
      }
    });
  });

  it('the cascade covers share links and emails, nulls ai_runs and clears current_version_id', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const old = await customerWithJob(c, t.tenantId, 'QT-OLD-001', `now() - interval '1 day'`);
      await c.query(`update public.documents set current_version_id = $1 where id = $2`, [old.versionId, old.documentId]);
      await c.query(`insert into public.share_links (tenant_id, document_id, token_hash, expires_at) values ($1, $2, 'hash-1', now() + interval '1 day')`, [t.tenantId, old.documentId]);
      await c.query(`insert into public.document_emails (tenant_id, document_id) values ($1, $2)`, [t.tenantId, old.documentId]);
      await c.query(`insert into public.ai_runs (tenant_id, document_id, model) values ($1, $2, 'm')`, [t.tenantId, old.documentId]);
      await c.query(`update public.customers set purge_at = now() - interval '1 day' where id = $1`, [old.customerId]);
      await c.query('set constraints all immediate');
      const claimed = await c.query(`select id from private.claim_expired_customers(now())`);
      await c.query(`select private.purge_customers($1::uuid[], now())`, [claimed.rows.map((x) => x.id)]);
      expect(await count(c, 'share_links', t.tenantId)).toBe(0);
      expect(await count(c, 'document_emails', t.tenantId)).toBe(0);
      const runs = await c.query(`select document_id from public.ai_runs where tenant_id = $1`, [t.tenantId]);
      expect(runs.rows).toEqual([{ document_id: null }]);
    });
  });

  it('current_version_id is cleared when the version goes but the document stays', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      const x = await customerWithJob(c, t.tenantId, 'QT-X-001', `now() + interval '10 days'`);
      await c.query(`update public.documents set current_version_id = $1 where id = $2`, [x.versionId, x.documentId]);
      await c.query('set constraints all immediate');
      await c.query(`select set_config('app.allow_final_delete', 'on', true)`);
      await c.query(`delete from public.document_versions where id = $1`, [x.versionId]);
      const d = await c.query(`select current_version_id from public.documents where id = $1`, [x.documentId]);
      expect(d.rows[0].current_version_id).toBeNull();
    });
  });

  for (const role of ['authenticated', 'anon']) {
    it(`no purge function is callable by ${role}`, async () => {
      await withRollback(async (c) => {
        const t = await createTenantWithUser(c, 'Alpha');
        await c.query(`set local role ${role}`);
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: t.userId, role })]);
        for (const f of FUNCTIONS) {
          await c.query('savepoint s');
          await expect(c.query(`select ${f.sql}`), f.sql).rejects.toThrow(/permission denied/i);
          await c.query('rollback to savepoint s');
        }
      });
    });
  }

  it('the old unsafe functions are gone', async () => {
    await withRollback(async (c) => {
      const r = await c.query(`select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and (proname in ('purge_expired_customers', 'expired_customers') or (proname = 'customer_storage_paths' and pronargs = 1))`);
      expect(r.rows).toEqual([]);
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
          ('h3', 'verify', true, now() - interval '1 hour'),
          ('h4', 'request', true, now())`,
      );
      const r = await c.query(`select private.purge_old_login_attempts() as n`);
      expect(r.rows[0].n).toBe(2);
      const left = await c.query(`select email_hash from public.login_attempts order by email_hash`);
      expect(left.rows.map((x) => x.email_hash)).toEqual(['h3', 'h4']);
    });
  });

  it('purge_old_login_attempts never deletes anything newer than one day', async () => {
    await withRollback(async (c) => {
      await actAsServer(c);
      await c.query(`delete from public.login_attempts`);
      await c.query(
        `insert into public.login_attempts (email_hash, kind, success, at) values
          ('old', 'request', true, now() - interval '2 days'),
          ('recent', 'verify', true, now() - interval '1 hour')`,
      );
      for (const interval of ['-1 day', '0 seconds', '1 minute']) {
        await c.query(`select private.purge_old_login_attempts($1::interval)`, [interval]);
      }
      const left = await c.query(`select email_hash from public.login_attempts`);
      expect(left.rows.map((x) => x.email_hash)).toEqual(['recent']);
    });
  });
});

describe.skipIf(!dbAvailable)('owner erase locks (two connections)', () => {
  it('claim_customer locks the tree: a photo insert waits, and the erase then stops it', async () => {
    await withFixture(async (fx) => {
      const claimer = await fx.client();
      const rival = await fx.client();
      const pid = (await rival.query('select pg_backend_pid() as pid')).rows[0].pid as number;
      const before = (await fx.setup.query(`select storage_path from public.job_photos where tenant_id = $1`, [fx.tenantId])).rows.map((r) => String(r.storage_path));
      expect(before).toHaveLength(1);
      expect(before[0]).toBe(`${fx.tenantId}/${fx.customerId}/${fx.jobId}/${before[0].split('/')[3]}`);
      await claimer.query('begin');
      const wrong = await claimer.query(`select private.claim_customer($1, $2) as ok`, [fx.tenantId, '00000000-0000-0000-0000-000000000000']);
      expect(wrong.rows[0].ok).toBe(false);
      const claimed = await claimer.query(`select private.claim_customer($1, $2) as ok`, [fx.tenantId, fx.customerId]);
      expect(claimed.rows[0].ok).toBe(true);
      for (const table of LOCKED_TABLES) {
        const other = await fx.client();
        await other.query('begin');
        await expect(other.query(`select 1 from public.${table} where tenant_id = $1 for update nowait`, [fx.tenantId]), table).rejects.toThrow(/could not obtain lock/i);
        await other.query('rollback');
      }
      const pending = rival
        .query(`insert into public.job_photos (id, tenant_id, job_id, storage_path) select g, $1, $2, $1::uuid::text || '/' || $3::uuid::text || '/' || $2::uuid::text || '/' || g::text || '.jpg' from gen_random_uuid() g`, [fx.tenantId, fx.jobId, fx.customerId])
        .then(() => null, (e) => e as { code?: string });
      await waitUntilBlocked(fx.setup, pid);
      const paths = await claimer.query(`select private.customer_storage_paths($1, $2) as p`, [fx.tenantId, fx.customerId]);
      // The waiting insert added no photo: the only photo listed is the fixture's own, in the real path scheme.
      expect(paths.rows.map((r) => String(r.p)).filter((p) => p.endsWith('.jpg'))).toEqual(before);
      const erased = await claimer.query(`select private.erase_customer($1, $2) as n`, [fx.tenantId, fx.customerId]);
      expect(erased.rows[0].n).toBe(1);
      await claimer.query('commit');
      expect((await pending)?.code).toBe('23503');
    });
  });

  it('claim_customer is not callable by the app role or anon', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Alpha');
      for (const role of ['authenticated', 'anon']) {
        await c.query(`set local role ${role}`);
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: t.userId, role })]);
        for (const sql of [`select private.claim_customer(gen_random_uuid(), gen_random_uuid())`, `select private.lock_customer_tree(array[]::uuid[])`]) {
          await c.query('savepoint s');
          await expect(c.query(sql), `${role} ${sql}`).rejects.toThrow(/permission denied/i);
          await c.query('rollback to savepoint s');
        }
        await c.query('reset role');
      }
    });
  });
});
