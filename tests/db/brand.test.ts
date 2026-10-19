import { describe, expect, it } from 'vitest';
import type { Client } from 'pg';
import { brandFromRow } from '../../src/lib/brand';
import { RESERVED_SLUGS } from '../../src/lib/slug';
import { createTenantWithUser, dbAvailable, withRollback } from './helpers';

async function expectFail(c: Client, sql: string, params: unknown[], pattern: RegExp) {
  await c.query('savepoint x');
  try {
    await expect(c.query(sql, params)).rejects.toThrow(pattern);
  } finally {
    await c.query('rollback to savepoint x');
  }
}

describe.skipIf(!dbAvailable)('tenant slug and public brand', () => {
  it('slug is unique, lower-case and not reserved', async () => {
    await withRollback(async (c) => {
      const a = await createTenantWithUser(c, 'Slug A');
      const b = await createTenantWithUser(c, 'Slug B');
      await c.query(`update public.tenants set slug = 'slug-test-a' where id = $1`, [a.tenantId]);
      await expectFail(c, `update public.tenants set slug = 'slug-test-a' where id = $1`, [b.tenantId], /duplicate key|unique/i);
      for (const bad of ['Slug-Test', 'login', 'api', 'dev', 's', 'a', 'a--b', '-abc', 'has space', '../x']) {
        await expectFail(c, `update public.tenants set slug = $2 where id = $1`, [b.tenantId, bad], /check constraint/i);
      }
    });
  });

  it('public_brand returns the public face by slug or id, and nothing for an unknown slug', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Brand Co');
      await c.query(`update public.tenants set slug = 'brand-co-test' where id = $1`, [t.tenantId]);
      const kit = await c.query(
        `insert into public.brand_kits (tenant_id, colours) values ($1, '{"blue":"#2f6fbf"}') returning id`,
        [t.tenantId],
      );
      await c.query(
        `insert into public.brand_assets (tenant_id, brand_kit_id, kind, storage_path, width, height) values ($1, $2, 'logo_colour', $3, 10, 5)`,
        [t.tenantId, kit.rows[0].id, `${t.tenantId}/logo.png`],
      );
      const bySlug = await c.query(`select * from private.public_brand('brand-co-test', null)`);
      expect(bySlug.rows).toHaveLength(1);
      expect(bySlug.rows[0]).toMatchObject({ name: 'Brand Co', accent: '#2f6fbf', logo_colour_path: `${t.tenantId}/logo.png`, logo_white_path: null });
      const byId = await c.query(`select * from private.public_brand(null, $1)`, [t.tenantId]);
      expect(byId.rows[0].slug).toBe('brand-co-test');
      expect((await c.query(`select * from private.public_brand('no-such-business', null)`)).rowCount).toBe(0);
      // nothing about people leaves this function
      expect(Object.keys(bySlug.rows[0]).sort()).toEqual(
        ['accent', 'logo_colour_h', 'logo_colour_path', 'logo_colour_w', 'logo_white_h', 'logo_white_path', 'logo_white_w', 'name', 'slug', 'tenant_id'],
      );
      const brand = brandFromRow(bySlug.rows[0], () => true);
      expect(brand.accent).toBe('#2f6fbf');
      expect(brand.logoLight?.url).toBe('/brands/brand-co-test/logo.png');
    });
  });

  it('the live reserved-word check equals RESERVED_SLUGS, so code and database cannot drift', async () => {
    await withRollback(async (c) => {
      // tenants_slug_not_reserved plus any tenants_slug_not_reserved_* added later (040 adds 'settings' separately).
      const r = await c.query(`select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.tenants'::regclass and conname like 'tenants\\_slug\\_not\\_reserved%'`);
      expect(r.rows.map((x) => x.conname)).toContain('tenants_slug_not_reserved');
      const words = [...new Set(r.rows.flatMap((row) => [.../ARRAY\[([^\]]+)\]/.exec(row.def as string)![1].matchAll(/'([^']+)'/g)].map((m) => m[1])))].sort();
      expect(words).toEqual([...RESERVED_SLUGS].sort());
      // Every merged task's words are live: the business tabs (030) and Owner Settings (040).
      expect(words).toEqual(expect.arrayContaining(['pipeline', 'money', 'calendar', 'guarantees', 'settings']));
      for (const w of ['pipeline', 'money', 'calendar', 'guarantees', 'settings']) {
        await expectFail(c, `update public.tenants set slug = $1 where id = (select id from public.tenants order by id limit 1)`, [w], /tenants_slug_not_reserved/);
      }
    });
  });

  it('is not callable by the app or anonymous roles', async () => {
    await withRollback(async (c) => {
      for (const role of ['anon', 'authenticated']) {
        await c.query(`set local role ${role}`);
        await expectFail(c, `select * from private.public_brand('x', null)`, [], /permission denied/i);
        await c.query('reset role');
      }
    });
  });
});

describe.skipIf(!dbAvailable)('brand images come from the brand kit (migration 014)', () => {
  it('public_brand_images returns only that business\'s banner, photo and card; a business without rows gets none', async () => {
    await withRollback(async (c) => {
      const t = await createTenantWithUser(c, 'Images Co');
      const other = await createTenantWithUser(c, 'Plain Co');
      await c.query(`update public.tenants set slug = 'images-co-test' where id = $1`, [t.tenantId]);
      await c.query(`update public.tenants set slug = 'plain-co-test' where id = $1`, [other.tenantId]);
      const kit = await c.query(`insert into public.brand_kits (tenant_id) values ($1) returning id`, [t.tenantId]);
      await c.query(`insert into public.brand_kits (tenant_id) values ($1)`, [other.tenantId]);
      await c.query(`insert into public.brand_assets (tenant_id, brand_kit_id, kind, storage_path, width, height, alt) values ($1, $2, 'hero_image', $3, 1400, 864, '')`, [t.tenantId, kit.rows[0].id, `${t.tenantId}/hero-1400.jpg`]);
      await c.query(`insert into public.brand_assets (tenant_id, brand_kit_id, kind, storage_path, width, height, alt) values ($1, $2, 'logo_colour', $3, 10, 5, '')`, [t.tenantId, kit.rows[0].id, `${t.tenantId}/logo.png`]);
      const mine = await c.query(`select kind, storage_path from private.public_brand_images('images-co-test', null)`);
      expect(mine.rows).toEqual([{ kind: 'hero_image', storage_path: `${t.tenantId}/hero-1400.jpg` }]);
      expect((await c.query(`select * from private.public_brand_images(null, $1)`, [other.tenantId])).rows).toEqual([]);
      const anon = await c.query(`select has_function_privilege('authenticated', 'private.public_brand_images(text, uuid)', 'execute') as a`);
      expect(anon.rows[0].a).toBe(false);
    });
  });
});
