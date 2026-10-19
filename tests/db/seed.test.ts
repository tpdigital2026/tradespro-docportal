import { describe, expect, it } from 'vitest';
import { FJC_OLD_DEPOSIT_TERMS, seedFjc, seedPaymentWording } from '../../src/db/seed-fjc';
import { seedSignature } from '../../src/db/seed-signature';
import { InMemoryStorage } from '../../src/lib/storage';
import { FJC_WORDING, tenantWordingSchema } from '../../src/db/wording';
import { dbAvailable, withRollback } from './helpers';

describe.skipIf(!dbAvailable)('seedFjc', () => {
  it('creates the FJC tenant, defaults, job types and brand kit, and is idempotent', async () => {
    await withRollback(async (c) => {
      // Rolled back at the end. A live FJC row may have issued documents, which only the purge flag lets go.
      await c.query(`select set_config('app.allow_final_delete', 'on', true)`);
      await c.query(`delete from public.tenants where name = 'FJC Roofing Ltd'`);
      await c.query(`select set_config('app.allow_final_delete', '', true)`);
      const first = await seedFjc(c);
      expect(first.created).toBe(true);
      const second = await seedFjc(c);
      expect(second).toEqual({ tenantId: first.tenantId, created: false, filled: [] });
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

  it('fills the wording keys added later (Due line, payment reference, {balance}) only where missing, never over the owner\'s edits', async () => {
    await withRollback(async (c) => {
      await c.query(`select set_config('app.allow_final_delete', 'on', true)`);
      await c.query(`delete from public.tenants where name = 'FJC Roofing Ltd'`);
      await c.query(`select set_config('app.allow_final_delete', '', true)`);
      const { tenantId } = await seedFjc(c);
      const old = structuredClone(FJC_WORDING) as Record<string, unknown> & typeof FJC_WORDING;
      delete (old.balance_invoice as { dueLabel?: string }).dueLabel;
      delete (old as { paymentReference?: string }).paymentReference;
      old.deposit_invoice.terms = FJC_OLD_DEPOSIT_TERMS;
      await c.query(`update public.tenant_defaults set terms = $2 where tenant_id = $1`, [tenantId, JSON.stringify(old)]);
      expect((await seedFjc(c)).filled).toEqual(['balance_invoice.dueLabel', 'paymentReference', 'deposit_invoice.terms']);
      const after = (await c.query(`select terms from public.tenant_defaults where tenant_id = $1`, [tenantId])).rows[0].terms;
      expect(after).toEqual(FJC_WORDING);
      expect(await seedPaymentWording(c, tenantId)).toEqual([]);
      // The owner's own deposit terms and Due line stay as they are.
      const mine = { ...structuredClone(FJC_WORDING), deposit_invoice: { ...FJC_WORDING.deposit_invoice, terms: 'My own deposit terms.' }, balance_invoice: { ...FJC_WORDING.balance_invoice, dueLabel: 'Within 7 days' } };
      await c.query(`update public.tenant_defaults set terms = $2 where tenant_id = $1`, [tenantId, JSON.stringify(mine)]);
      expect(await seedPaymentWording(c, tenantId)).toEqual([]);
      expect((await c.query(`select terms from public.tenant_defaults where tenant_id = $1`, [tenantId])).rows[0].terms).toEqual(mine);
    });
  });

  it('stores the signature as an upload in Settings would, switches printing on, and never replaces one already there', async () => {
    await withRollback(async (c) => {
      await c.query(`select set_config('app.allow_final_delete', 'on', true)`);
      await c.query(`delete from public.tenants where name = 'FJC Roofing Ltd'`);
      await c.query(`select set_config('app.allow_final_delete', '', true)`);
      const { tenantId } = await seedFjc(c);
      const storage = new InMemoryStorage();
      const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000064000000320806000000', 'hex');
      const reencoded = { png: Buffer.from('re-encoded'), width: 1200, height: 400 };
      const calls: number[] = [];
      const reencode = async () => (calls.push(1), reencoded);
      expect(await seedSignature(c, storage, tenantId, png, reencode)).toBe('stored');
      const rows = await c.query(`select storage_path, width, height from public.brand_assets where tenant_id = $1 and kind = 'signature'`, [tenantId]);
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].storage_path).toMatch(new RegExp(`^${tenantId}/brand/signature-[0-9a-f-]{36}\\.png$`));
      expect(storage.blobs.get(rows.rows[0].storage_path)?.bytes.toString()).toBe('re-encoded');
      expect((await c.query(`select signature_consent from public.tenant_defaults where tenant_id = $1`, [tenantId])).rows[0].signature_consent).toBe(true);
      // Run again: kept, nothing re-encoded, nothing replaced. The owner switching printing off is respected too.
      await c.query(`update public.tenant_defaults set signature_consent = false where tenant_id = $1`, [tenantId]);
      expect(await seedSignature(c, storage, tenantId, png, reencode)).toBe('kept');
      expect(calls).toHaveLength(1);
      expect((await c.query(`select signature_consent from public.tenant_defaults where tenant_id = $1`, [tenantId])).rows[0].signature_consent).toBe(false);
    });
  });
});
