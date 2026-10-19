import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { purgeExpiredWith } from '../../src/lib/data/customer-admin';
import { purgeUnlinkedAppointmentsWith } from '../../src/lib/maintenance/cron';
import { SWEEP_REFERENCE_COLUMNS, SWEEP_REVIEWED_TABLES, sweepOrphansWith } from '../../src/lib/maintenance/orphan-sweep';
import { InMemoryStorage } from '../../src/lib/storage';
import { createTenantWithUser, dbAvailable, withRollback } from './helpers';

const OLD = new Date('2026-01-01T00:00:00Z');

async function setup(c: Client, purgeAt = `now() + interval '90 days'`) {
  const t = await createTenantWithUser(c, `Mnt ${randomUUID().slice(0, 8)}`);
  const kit = await c.query(`insert into public.brand_kits (tenant_id) values ($1) returning id`, [t.tenantId]);
  const cust = await c.query(`insert into public.customers (tenant_id, name) values ($1, 'Cust') returning id`, [t.tenantId]);
  const C = cust.rows[0].id as string;
  const job = await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, $3) returning id`, [t.tenantId, C, `M-${randomUUID().slice(0, 6)}`]);
  const J = job.rows[0].id as string;
  const doc = await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'quotation', $3) returning id`, [t.tenantId, J, `M-${randomUUID().slice(0, 6)}`]);
  const D = doc.rows[0].id as string;
  const v1 = randomUUID();
  const v2 = randomUUID();
  const req = randomUUID();
  const folder = `${t.tenantId}/${C}/${J}/${v1}/${req}`;
  await c.query(`insert into public.document_versions (id, tenant_id, document_id, version, pdf_path, final_content, finalised_at) values ($1, $2, $3, 1, $4, $5, now())`, [v1, t.tenantId, D, `${folder}/document.pdf`, JSON.stringify({ files: folder })]);
  await c.query(`insert into public.document_versions (id, tenant_id, document_id, version) values ($1, $2, $3, 2)`, [v2, t.tenantId, D]);
  await c.query(`update public.documents set pdf_path = $1 where id = $2`, [`${folder}/document.pdf`, D]);
  // The photo file is named after its row id (the survey task's path rule).
  const photoId = randomUUID();
  const photo = `${t.tenantId}/${C}/${J}/${photoId}.jpg`;
  await c.query(`insert into public.job_photos (id, tenant_id, job_id, storage_path) values ($1, $2, $3, $4)`, [photoId, t.tenantId, J, photo]);
  const sig = `${t.tenantId}/brand/signature-${randomUUID()}.png`;
  await c.query(`insert into public.brand_assets (tenant_id, brand_kit_id, kind, storage_path) values ($1, $2, 'signature', $3)`, [t.tenantId, kit.rows[0].id, sig]);
  await c.query(`update public.customers set purge_at = ${purgeAt} where id = $1`, [C]);
  return { ...t, C, J, D, v1, v2, folder, photo, sig };
}

async function put(st: InMemoryStorage, path: string, at = OLD) {
  await st.put(path, Buffer.from(path), 'application/octet-stream');
  st.createdAt.set(path, at);
}

describe.skipIf(!dbAvailable)('storage orphan sweep against the database', () => {
  it('keeps everything the database points at (PDF folder, pages, photos, signature, draft previews) and deletes old orphans', async () => {
    await withRollback(async (c) => {
      const f = await setup(c);
      const st = new InMemoryStorage();
      const keep = [
        `${f.folder}/document.pdf`,
        `${f.folder}/page-01.png`,
        `${f.folder}/page-02.png`,
        f.photo,
        f.sig,
        `${f.tenantId}/${f.C}/${f.J}/${f.v2}/preview-abc123/page-01.png`,
        `${f.tenantId}/${f.C}/${f.J}/${f.v2}/preview-abc123/pages.json`,
        `${f.tenantId}/notes/unknown-shape.txt`,
      ];
      const gone = [
        `${f.tenantId}/${f.C}/${f.J}/${f.v1}/${randomUUID()}/document.pdf`, // a losing request's folder
        `${f.tenantId}/${f.C}/${f.J}/${f.v1}/preview-old/page-01.png`, // preview of a version now finalised
        `${f.tenantId}/${f.C}/${f.J}/${randomUUID()}.jpg`, // a photo whose row was never written
        `${f.tenantId}/brand/signature-${randomUUID()}.png`, // a replaced signature
      ];
      const fresh = `${f.tenantId}/${f.C}/${f.J}/${f.v1}/${randomUUID()}/document.pdf`;
      for (const p of [...keep, ...gone]) await put(st, p);
      await put(st, fresh, new Date());
      const dry = await sweepOrphansWith(c, st, { dryRun: true, tenantIds: [f.tenantId] });
      expect(dry).toMatchObject({ scanned: 13, orphans: 4, deleted: 0, young: 1, unknown: 1, referenced: 7 });
      expect(st.blobs.size).toBe(13);
      const live = await sweepOrphansWith(c, st, { dryRun: false, tenantIds: [f.tenantId] });
      expect(live.deleted).toBe(4);
      expect([...st.blobs.keys()].sort()).toEqual([...keep, fresh].sort());
    });
  });

  it('never looks across businesses: another business\'s references do not protect this one\'s files, and its files are not listed', async () => {
    await withRollback(async (c) => {
      const a = await setup(c);
      const b = await setup(c);
      const st = new InMemoryStorage();
      // A file in A's folder named like B's referenced PDF folder is still A's orphan.
      const lookalike = `${a.tenantId}/${b.C}/${b.J}/${b.v1}/${b.folder.split('/').pop()}/document.pdf`;
      await put(st, lookalike);
      await put(st, `${b.folder}/document.pdf`);
      await sweepOrphansWith(c, st, { dryRun: false, tenantIds: [a.tenantId] });
      expect([...st.blobs.keys()]).toEqual([`${b.folder}/document.pdf`]);
    });
  });
});

describe.skipIf(!dbAvailable)('scheduled customer purge (protocol, fake storage)', () => {
  it('a storage delete failure rolls the database step back: the expired customer and their rows stay', async () => {
    await withRollback(async (c) => {
      const f = await setup(c, `now() - interval '1 day'`);
      const st = new InMemoryStorage();
      await put(st, `${f.folder}/document.pdf`);
      st.failNext = true;
      await expect(purgeExpiredWith(c, st, { nested: true, statementTimeoutSeconds: 300 })).rejects.toThrow(/Storage deletion failed/);
      expect((await c.query(`select count(*)::int n from public.customers where id = $1`, [f.C])).rows[0].n).toBe(1);
      expect((await c.query(`select count(*)::int n from public.document_versions where document_id = $1`, [f.D])).rows[0].n).toBe(2);
      // Next run (storage working): the customer, their rows and their folder go.
      const n = await purgeExpiredWith(c, st, { nested: true, statementTimeoutSeconds: 300 });
      expect(n).toBeGreaterThanOrEqual(1);
      expect((await c.query(`select count(*)::int n from public.customers where id = $1`, [f.C])).rows[0].n).toBe(0);
      expect([...st.blobs.keys()].filter((k) => k.startsWith(`${f.tenantId}/${f.C}/`))).toEqual([]);
    });
  });

  it('the purge runs with the generous statement timeout it was given and no app claims', async () => {
    await withRollback(async (c) => {
      const seen: string[] = [];
      const db = { query: (sql: string, p?: unknown[]) => (seen.push(sql), c.query(sql, p)) };
      await purgeExpiredWith(db, new InMemoryStorage(), { nested: true, statementTimeoutSeconds: 300 });
      expect(seen).toContain(`set local statement_timeout = '300s'`);
      expect(seen).toContain('reset role');
      expect(seen.some((s) => /set_config\('request\.jwt\.claims', ''/.test(s))).toBe(true);
    });
  });
});

describe.skipIf(!dbAvailable)('scheduled unlinked appointment purge (cron step 2)', () => {
  it('the cron step removes only unlinked appointments past retention, as the service role, even from an app-role connection', async () => {
    await withRollback(async (c) => {
      const t = await setup(c);
      await c.query(`insert into public.tenant_defaults (tenant_id, retention_days) values ($1, 30) on conflict (tenant_id) do update set retention_days = 30`, [t.tenantId]);
      const ins = `insert into public.appointments (tenant_id, kind, title, starts_at, customer_id, created_at, updated_at) values ($1, 'other', $2, $3::timestamptz, $4, $3::timestamptz, $3::timestamptz)`;
      const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
      await c.query(ins, [t.tenantId, 'old unlinked', ago(40), null]);
      await c.query(ins, [t.tenantId, 'recent unlinked', ago(5), null]);
      await c.query(ins, [t.tenantId, 'old linked', ago(40), t.C]);
      // The connection may arrive carrying an app role and claims: the step clears both before calling the function.
      await c.query(`set local role authenticated`);
      await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: t.userId, role: 'authenticated' })]);
      const n = await purgeUnlinkedAppointmentsWith(c);
      expect(n).toBeGreaterThanOrEqual(1);
      const left = await c.query(`select title from public.appointments where tenant_id = $1 order by title`, [t.tenantId]);
      expect(left.rows.map((r) => r.title)).toEqual(['old linked', 'recent unlinked']);
    });
  });
});

describe.skipIf(!dbAvailable)('orphan sweep coverage (merge hazard)', () => {
  it('every column that can hold a storage path is one the sweep reads', async () => {
    await withRollback(async (c) => {
      const r = await c.query(`select table_name || '.' || column_name as col from information_schema.columns where table_schema = 'public' and column_name ~ '(path|file|storage|url|blob|object)' order by 1`);
      expect(r.rows.map((x) => x.col)).toEqual([...SWEEP_REFERENCE_COLUMNS].sort());
    });
  });
  // Fails loudly when a new table appears that nobody has checked for stored files (SWEEP_REVIEWED_TABLES).
  it('every public table has been reviewed for stored files', async () => {
    await withRollback(async (c) => {
      const r = await c.query(`select tablename from pg_tables where schemaname = 'public' order by 1`);
      const unreviewed = r.rows.map((x) => String(x.tablename)).filter((t) => !SWEEP_REVIEWED_TABLES.includes(t));
      expect(unreviewed, 'review these tables for stored files, then add them to SWEEP_REVIEWED_TABLES').toEqual([]);
    });
  });
});
