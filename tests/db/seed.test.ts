import { describe, expect, it } from 'vitest';
import { seedFjc } from '../../src/db/seed-fjc';
import { tenantWordingSchema } from '../../src/db/wording';
import { dbAvailable, withRollback } from './helpers';

describe.skipIf(!dbAvailable)('seedFjc', () => {
  it('creates the FJC tenant, defaults, job types and brand kit, and is idempotent', async () => {
    await withRollback(async (c) => {
      await c.query(`delete from public.tenants where name = 'FJC Roofing Ltd'`);
      const first = await seedFjc(c);
      expect(first.created).toBe(true);
      const second = await seedFjc(c);
      expect(second).toEqual({ tenantId: first.tenantId, created: false });
      const t = await c.query(`select * from public.tenants where id = $1`, [first.tenantId]);
      expect(t.rows[0]).toMatchObject({ name: 'FJC Roofing Ltd', company_number: '13855379', vat_registered: true, owner_name: 'Ben Cunningham', owner_title: 'Director' });
      const d = await c.query(`select * from public.tenant_defaults where tenant_id = $1`, [first.tenantId]);
      expect(d.rows[0]).toMatchObject({ deposit_pct_bp: 3000, quote_validity_days: 30, vat_rate_bp: 2000, retention_days: 90 });
      expect(() => tenantWordingSchema.parse(d.rows[0].terms)).not.toThrow();
      const jt = await c.query(`select key, guarantee_years from public.job_types where tenant_id = $1 order by key`, [first.tenantId]);
      expect(jt.rows).toEqual([
        { key: 'fascia', guarantee_years: null },
        { key: 'flat_roof', guarantee_years: 20 },
        { key: 'other', guarantee_years: null },
        { key: 'tiled_roof', guarantee_years: 25 },
      ]);
      const kit = await c.query(`select colours from public.brand_kits where tenant_id = $1`, [first.tenantId]);
      expect(kit.rows[0].colours.navy).toBe('#0f2b4a');
      const imgs = await c.query(`select kind::text as kind, storage_path from public.brand_assets where tenant_id = $1 and kind::text in ('hero_image', 'sign_in_photo', 'share_card') order by kind`, [first.tenantId]);
      expect(imgs.rows).toEqual([
        { kind: 'hero_image', storage_path: `${first.tenantId}/hero-wide-1400.jpg` },
        { kind: 'share_card', storage_path: `${first.tenantId}/og.jpg` },
        { kind: 'sign_in_photo', storage_path: `${first.tenantId}/van-1600.jpg` },
      ]);
      // A changed list (a swapped banner) brings the stored row up to date on the next seed; nothing is duplicated.
      await c.query(`update public.brand_assets set storage_path = $2, width = 10, height = 10 where tenant_id = $1 and kind::text = 'hero_image'`, [first.tenantId, `${first.tenantId}/old-hero-10.jpg`]);
      await seedFjc(c);
      const hero = await c.query(`select storage_path, width, height from public.brand_assets where tenant_id = $1 and kind::text = 'hero_image'`, [first.tenantId]);
      expect(hero.rows).toEqual([{ storage_path: `${first.tenantId}/hero-wide-1400.jpg`, width: 1400, height: 304 }]);
      const bank = await c.query(`select count(*)::int n from public.bank_accounts where tenant_id = $1`, [first.tenantId]);
      expect(bank.rows[0].n).toBe(0);
      const users = await c.query(`select count(*)::int n from public.profiles where tenant_id = $1`, [first.tenantId]);
      expect(users.rows[0].n).toBe(0);
      const customers = await c.query(`select count(*)::int n from public.customers where tenant_id = $1`, [first.tenantId]);
      expect(customers.rows[0].n).toBe(0);
    });
  });
});
