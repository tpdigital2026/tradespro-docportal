import { describe, expect, it } from 'vitest';
import { setBusinessDetailsWith } from '../../src/lib/data/settings';
import { businessWith } from '../../src/lib/documents/facts-sql';
import { FJC_CONTACT, FJC_PREVIOUS_CONTACT, seedContact, seedFjc } from '../../src/db/seed-fjc';
import { parseBusinessDetails } from '../../src/lib/validation/business';
import { createTenantWithUser, dbAvailable, withRollback } from './helpers';

const nested = { nested: true } as const;

describe.skipIf(!dbAvailable)('Settings > Business details', () => {
  it('saves only what changed, audits field names only, feeds the documents, and leaves other businesses alone', async () => {
    await withRollback(async (c) => {
      const a = await createTenantWithUser(c, 'Biz Alpha');
      const b = await createTenantWithUser(c, 'Biz Beta');
      const parsed = parseBusinessDetails({ email: 'office@alpha.example', phone: '01234 567890', website: 'https://alpha.example.co.uk/', tagline: 'Dummy tagline', addressLines: ['1 Dummy Road', 'Anytown'], postcode: 'AB1 2CD', companyNumber: '12345678', vatNumber: '', ownerName: 'Dummy Owner', ownerTitle: 'Director' });
      if (!parsed.ok) throw new Error('bad input');
      const r = await setBusinessDetailsWith(c, { tenantId: a.tenantId, userId: a.userId }, parsed.value, nested);
      expect(r.changed).toEqual(['email', 'phone', 'website', 'tagline', 'addressLines', 'postcode', 'companyNumber', 'ownerName']);
      const biz = await businessWith(c, a.tenantId);
      expect(biz.business?.tenant).toMatchObject({ email: 'office@alpha.example', web: 'alpha.example.co.uk', phone: '01234 567890', tagline: 'Dummy tagline', companyNo: '12345678', ownerName: 'Dummy Owner' });
      expect(biz.business?.tenant.addressLine).toBe('1 Dummy Road · Anytown · AB1 2CD');
      const audit = await c.query(`select meta from public.audit_log where tenant_id = $1 and action = 'settings.business'`, [a.tenantId]);
      expect(audit.rows).toHaveLength(1);
      expect(JSON.stringify(audit.rows[0].meta)).not.toMatch(/alpha|Dummy|0123/);
      expect((await c.query(`select email from public.tenants where id = $1`, [b.tenantId])).rows[0].email).toBeNull();
      // The same again changes nothing and writes no audit row.
      expect((await setBusinessDetailsWith(c, { tenantId: a.tenantId, userId: a.userId }, parsed.value, nested)).changed).toEqual([]);
      expect((await c.query(`select count(*)::int n from public.audit_log where tenant_id = $1 and action = 'settings.business'`, [a.tenantId])).rows[0].n).toBe(1);
    });
  });

  it('the FJC seed moves the website to the confirmed one only while it is still the old seeded value, and keeps the email', async () => {
    await withRollback(async (c) => {
      await c.query(`select set_config('app.allow_final_delete', 'on', true)`);
      await c.query(`delete from public.tenants where name = 'FJC Roofing Ltd'`);
      await c.query(`select set_config('app.allow_final_delete', '', true)`);
      const { tenantId } = await seedFjc(c);
      expect((await c.query(`select website, email from public.tenants where id = $1`, [tenantId])).rows[0]).toEqual({ website: FJC_CONTACT.website, email: FJC_CONTACT.email });
      await c.query(`update public.tenants set website = $2 where id = $1`, [tenantId, FJC_PREVIOUS_CONTACT.website]);
      expect(await seedContact(c, tenantId)).toEqual(['website']);
      expect((await c.query(`select website from public.tenants where id = $1`, [tenantId])).rows[0].website).toBe('fjcroofing.co.uk');
      await c.query(`update public.tenants set website = 'owner-edit.example' where id = $1`, [tenantId]);
      expect(await seedContact(c, tenantId)).toEqual([]);
      expect((await c.query(`select website, email from public.tenants where id = $1`, [tenantId])).rows[0]).toEqual({ website: 'owner-edit.example', email: 'Ben@fjcroofingltd.com' });
    });
  });
});
