import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { deleteDraftWith } from '../../src/lib/documents/delete-draft';
import { sweepOrphansWith } from '../../src/lib/maintenance/orphan-sweep';
import { InMemoryStorage } from '../../src/lib/storage';
import { actAs, actAsServer, dbAvailable, withRollback } from './helpers';
import { seedTenant, type SeededTenant } from './seed';

const owner = (t: SeededTenant) => ({ tenantId: t.tenantId, userId: t.userId, role: 'owner' });

async function expectFail(c: Client, sql: string, params: unknown[], pattern: RegExp) {
  await c.query('savepoint x');
  try {
    await expect(c.query(sql, params)).rejects.toThrow(pattern);
  } finally {
    await c.query('rollback to savepoint x');
  }
}

/** A preview page for every version of the document, and the job's photo files, as the app writes them. */
async function files(c: Client, s: InMemoryStorage, t: SeededTenant, documentId: string) {
  const v = await c.query(`select id from public.document_versions where document_id = $1`, [documentId]);
  for (const r of v.rows) await s.put(`${t.tenantId}/${t.customerId}/${t.jobId}/${r.id}/preview-abc/page-01.png`, Buffer.from('x'), 'image/png');
  const p = await c.query(`select storage_path from public.job_photos where job_id = $1`, [t.jobId]);
  for (const r of p.rows) await s.put(String(r.storage_path), Buffer.from('x'), 'image/jpeg', { overwrite: true });
}

describe.skipIf(!dbAvailable)('deleting a draft', () => {
  it('a draft quote made with its job: deletes the document, the job, its files after commit, frees the number, audits ids only', async () => {
    await withRollback(async (c) => {
      const t = await seedTenant(c, 'Delq');
      const storage = new InMemoryStorage();
      await files(c, storage, t, t.docId);
      const ref = (await c.query(`select reference from public.jobs where id = $1`, [t.jobId])).rows[0].reference as string;
      const r = await deleteDraftWith(c, storage, owner(t), t.docId, { nested: true });
      expect(r.status).toBe('deleted');
      expect(r.jobDeleted).toBe(true);
      expect((await c.query(`select 1 from public.documents where id = $1`, [t.docId])).rowCount).toBe(0);
      expect((await c.query(`select 1 from public.document_versions where document_id = $1`, [t.docId])).rowCount).toBe(0);
      expect((await c.query(`select 1 from public.jobs where id = $1`, [t.jobId])).rowCount).toBe(0);
      expect((await c.query(`select 1 from public.used_numbers where tenant_id = $1 and number = $2`, [t.tenantId, ref])).rowCount).toBe(0);
      expect([...storage.blobs.keys()].filter((p) => p.startsWith(`${t.tenantId}/${t.customerId}/${t.jobId}/`))).toEqual([]);
      const audit = await c.query(`select action, entity, entity_id, meta from public.audit_log where tenant_id = $1 and action = 'document.delete_draft'`, [t.tenantId]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].entity_id).toBe(t.docId.replace(/-/g, ''));
      expect(JSON.stringify(audit.rows[0].meta)).not.toMatch(/Delq|Customer/);
      // The number is offered again: the same job number can be saved.
      await c.query(`insert into public.jobs (tenant_id, customer_id, reference) values ($1, $2, $3)`, [t.tenantId, t.customerId, ref]);
    });
  });

  it('keeps the job when something else is on it, and frees only the draft\'s own number', async () => {
    await withRollback(async (c) => {
      const t = await seedTenant(c, 'Delk');
      const ref = (await c.query(`select reference from public.jobs where id = $1`, [t.jobId])).rows[0].reference as string;
      const inv = await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'invoice_full', $3) returning id`, [t.tenantId, t.jobId, `INV-${ref.replace(/^QT-/, '')}`]);
      const storage = new InMemoryStorage();
      const r = await deleteDraftWith(c, storage, owner(t), String(inv.rows[0].id), { nested: true });
      expect(r).toMatchObject({ status: 'deleted', jobDeleted: false });
      expect((await c.query(`select 1 from public.jobs where id = $1`, [t.jobId])).rowCount).toBe(1);
      expect((await c.query(`select 1 from public.documents where id = $1`, [t.docId])).rowCount).toBe(1);
      expect((await c.query(`select number from public.used_numbers where tenant_id = $1 order by number`, [t.tenantId])).rows.map((x) => x.number)).toEqual([ref]);
      // Recreated with the same number.
      await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'invoice_full', $3)`, [t.tenantId, t.jobId, `INV-${ref.replace(/^QT-/, '')}`]);
    });
  });

  it('refuses a finalised document, and a draft with an issued version behind it (a changed quote), in the function and in the table', async () => {
    await withRollback(async (c) => {
      const t = await seedTenant(c, 'Delf');
      await c.query(`update public.document_versions set finalised_at = now() where id = $1`, [t.versionId]);
      // Back in draft after "Change this quote": the issued version must stay.
      expect((await deleteDraftWith(c, new InMemoryStorage(), owner(t), t.docId, { nested: true })).status).toBe('issued');
      await expectFail(c, `delete from public.documents where id = $1`, [t.docId], /never issued/);
      await c.query(`update public.documents set status = 'final' where id = $1`, [t.docId]);
      expect((await deleteDraftWith(c, new InMemoryStorage(), owner(t), t.docId, { nested: true })).status).toBe('issued');
      await expectFail(c, `delete from public.documents where id = $1`, [t.docId], /never issued/);
      expect((await c.query(`select 1 from public.documents where id = $1`, [t.docId])).rowCount).toBe(1);
    });
  });

  it('refuses another business\'s draft, unknown ids, a draft a payment points at, and anyone but owner or staff', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Dela');
      const b = await seedTenant(c, 'Delb');
      expect((await deleteDraftWith(c, new InMemoryStorage(), owner(a), b.docId, { nested: true })).status).toBe('not_found');
      expect((await c.query(`select 1 from public.documents where id = $1`, [b.docId])).rowCount).toBe(1);
      expect((await deleteDraftWith(c, new InMemoryStorage(), owner(a), randomUUID(), { nested: true })).status).toBe('not_found');
      expect((await deleteDraftWith(c, new InMemoryStorage(), owner(a), 'not-a-uuid', { nested: true })).status).toBe('not_found');
      expect((await deleteDraftWith(c, new InMemoryStorage(), { ...owner(a), role: 'tradespro_admin' }, a.docId, { nested: true })).status).toBe('not_allowed');
      expect((await deleteDraftWith(c, new InMemoryStorage(), { ...owner(a), role: 'staff' }, a.docId, { nested: true })).status).toBe('deleted');
    });
  });

  it('the app role cannot delete documents or call the function (row level security and grants)', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Delr');
      await actAs(c, a.userId);
      await expectFail(c, `delete from public.documents where id = $1`, [a.docId], /permission denied/i);
      await expectFail(c, `select private.delete_draft_document($1, $2)`, [a.tenantId, a.docId], /permission denied/i);
      await actAsServer(c);
      expect((await c.query(`select 1 from public.documents where id = $1`, [a.docId])).rowCount).toBe(1);
    });
  });

  it('a survey draft takes its photos with it; files left by a failed storage call are orphans the sweep removes', async () => {
    await withRollback(async (c) => {
      const t = await seedTenant(c, 'Dels');
      const ref = (await c.query(`select reference from public.jobs where id = $1`, [t.jobId])).rows[0].reference as string;
      const sr = await c.query(`insert into public.documents (tenant_id, job_id, type, number) values ($1, $2, 'survey_report', $3) returning id`, [t.tenantId, t.jobId, `SR-${ref}`]);
      const srId = String(sr.rows[0].id);
      await c.query(`insert into public.document_versions (tenant_id, document_id, version) values ($1, $2, 1)`, [t.tenantId, srId]);
      const storage = new InMemoryStorage();
      await files(c, storage, t, srId);
      await files(c, storage, t, t.docId);
      const photo = (await c.query(`select storage_path from public.job_photos where job_id = $1`, [t.jobId])).rows[0].storage_path as string;
      storage.failNext = true;
      const r = await deleteDraftWith(c, storage, owner(t), srId, { nested: true });
      expect(r).toMatchObject({ status: 'deleted', jobDeleted: false });
      expect((await c.query(`select 1 from public.job_photos where job_id = $1`, [t.jobId])).rowCount).toBe(0);
      // The quote on the same job is untouched.
      expect((await c.query(`select 1 from public.documents where id = $1`, [t.docId])).rowCount).toBe(1);
      // Storage failed, so the files are still there, but nothing points at them: a day later the sweep deletes them.
      expect(storage.blobs.has(photo)).toBe(true);
      for (const p of storage.blobs.keys()) storage.createdAt.set(p, new Date(Date.now() - 48 * 3600_000));
      const preview = [...storage.blobs.keys()].find((p) => p.includes('/preview-') && !p.includes(t.versionId));
      const swept = await sweepOrphansWith(c, storage, { dryRun: false, tenantIds: [t.tenantId] });
      expect(swept.dryRun).toBe(false);
      expect(storage.blobs.has(photo)).toBe(false);
      expect(preview && storage.blobs.has(preview)).toBe(false);
      // The quote's own draft preview is still in use, so it stays.
      expect([...storage.blobs.keys()].some((p) => p.includes(`/${t.versionId}/preview-`))).toBe(true);
    });
  });
});
