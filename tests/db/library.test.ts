import { afterEach, describe, expect, it } from 'vitest';
import { types, type Client } from 'pg';
import { listLibrarySql } from '../../src/lib/data/documents';
import { loadHeadWith } from '../../src/lib/documents/facts-sql';
import type { Db } from '../../src/security/login-guard';
import { dbAvailable, withRollback } from './helpers';
import { seedTenant } from './seed';

describe.skipIf(!dbAvailable)('Documents library in the database', () => {
  it('filters by type and status, searches number and customer without wildcards, caps and says so, and stays in its business', async () => {
    await withRollback(async (c) => {
      const a = await seedTenant(c, 'Alpha');
      const b = await seedTenant(c, 'Beta');
      await c.query(`insert into public.documents (tenant_id, job_id, type, number, status) values ($1, $2, 'invoice_full', $3, 'final')`, [a.tenantId, a.jobId, 'INV-QT-Alpha-001']);
      const all = await listLibrarySql(c, a.tenantId);
      expect(all.items.map((i) => i.number).sort()).toEqual(['INV-QT-Alpha-001', 'QT-Alpha-001']);
      expect(all.truncated).toBe(false);
      expect((await listLibrarySql(c, a.tenantId, { kind: 'invoice' })).items.map((i) => i.type)).toEqual(['invoice-full']);
      expect((await listLibrarySql(c, a.tenantId, { status: 'draft' })).items.map((i) => i.number)).toEqual(['QT-Alpha-001']);
      expect((await listLibrarySql(c, a.tenantId, { q: 'alpha cust' })).items).toHaveLength(2);
      expect((await listLibrarySql(c, a.tenantId, { q: 'inv-qt' })).items).toHaveLength(1);
      // What the owner types is never a pattern.
      expect((await listLibrarySql(c, a.tenantId, { q: '%' })).items).toHaveLength(0);
      expect((await listLibrarySql(c, a.tenantId, { q: '_' })).items).toHaveLength(0);
      // Another business's documents never appear, even when searched for.
      expect((await listLibrarySql(c, a.tenantId, { q: 'beta' })).items).toHaveLength(0);
      expect((await listLibrarySql(c, b.tenantId)).items.map((i) => i.number)).toEqual(['QT-Beta-001']);
      // A NUL in the search is an empty result, never a database error.
      expect(await listLibrarySql(c, a.tenantId, { q: 'QT\u0000' })).toEqual({ items: [], truncated: false });
      const capped = await listLibrarySql(c, a.tenantId, { limit: 1 });
      expect(capped.items).toHaveLength(1);
      expect(capped.truncated).toBe(true);
    });
  });
});

describe.skipIf(!dbAvailable)('document dates are the stored calendar day in any server time zone (BST bug)', () => {
  const before = process.env.TZ;
  afterEach(() => {
    process.env.TZ = before;
  });
  // node-postgres's own default parsing (local midnight Date), as any client without the app's PG_TYPES would get.
  const defaultTypes = (c: Client): Db => ({ query: (text: string, values?: unknown[]) => c.query({ text, values, types }) }) as unknown as Db;

  for (const tz of ['Europe/London', 'UTC']) {
    it(`TZ=${tz}: the library and the document head show the doc_date that was stored`, async () => {
      process.env.TZ = tz;
      await withRollback(async (c) => {
        const a = await seedTenant(c, `Tz${tz.replace(/\W/g, '')}`);
        const d = await c.query(`insert into public.documents (tenant_id, job_id, type, number, status, doc_date) select $1, $2, 'invoice_full', 'INV-' || j.reference, 'final', '2026-07-01' from public.jobs j where j.id = $2 returning id`, [a.tenantId, a.jobId]);
        for (const db of [c as unknown as Db, defaultTypes(c)]) {
          const lib = await listLibrarySql(db, a.tenantId, { kind: 'invoice' });
          expect(lib.items.map((i) => i.date)).toEqual(['2026-07-01']);
          const head = await loadHeadWith(db, a.tenantId, String(d.rows[0].id));
          expect(head?.docDate).toBe('2026-07-01');
        }
        // The app connection hands back the raw text, so nothing can turn it into a UTC instant by accident.
        const raw = await c.query(`select '2026-07-01'::date as d`);
        expect(raw.rows[0].d).toBe('2026-07-01');
      });
    });
  }
});
