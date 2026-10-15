import { describe, expect, it } from 'vitest';
import { listLibrarySql } from '../../src/lib/data/documents';
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
      const capped = await listLibrarySql(c, a.tenantId, { limit: 1 });
      expect(capped.items).toHaveLength(1);
      expect(capped.truncated).toBe(true);
    });
  });
});
