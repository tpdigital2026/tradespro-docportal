import type { Db } from '../security/login-guard';
import { scopeExamplesSchema } from '../lib/scope/examples';
import { FJC_SCOPE_EXAMPLES } from '../lib/scope/fjc-examples';
import { FJC_WORDING, tenantWordingSchema } from './wording';

// Taken from tests/fixtures/fjc.ts (the approved FJC brand).
export const FJC_COLOURS: Record<string, string> = {
  navy: '#0f2b4a', navy2: '#16395f', navy3: '#1f4a78', blue: '#2f6fbf', sky: '#7fa6dc', ice: '#e9f0f9',
  gold: '#c9a24b', gold2: '#e4cf9a', goldbg: '#faf5e8', ink: '#152235', body: '#3a4657', muted: '#6b7686',
  rule: '#dde3eb', paper: '#f4f6fa',
};

const JOB_TYPES: [string, string, number | null][] = [
  ['flat_roof', 'Flat roof', 20],
  ['tiled_roof', 'Tiled roof', 25],
  ['fascia', 'Fascias and guttering', null],
  ['other', 'Other', null],
];

/**
 * Idempotent. Seeds business facts and wording only: no bank details, no users, no customers.
 * Not seeded (no confirmed source yet): disclaimer_text and number_formats on tenant_defaults.
 */
export async function seedFjc(db: Db): Promise<{ tenantId: string; created: boolean }> {
  const wording = tenantWordingSchema.parse(FJC_WORDING);
  const existing = await db.query(`select id from public.tenants where name = 'FJC Roofing Ltd'`);
  if (existing.rows.length > 0) {
    // Wording added after the first seed: fill it in where it is still empty, never overwrite the business's own edits.
    await seedScopeExamples(db, existing.rows[0].id);
    await seedBrandImages(db, existing.rows[0].id);
    return { tenantId: existing.rows[0].id, created: false };
  }

  const t = await db.query(
    `insert into public.tenants (slug, name, trade_type, company_number, vat_registered, vat_number, address_lines, phone, email, website, tagline, owner_name, owner_title)
     values ('fjc', 'FJC Roofing Ltd', 'roofing', '13855379', true, 'GB 408094403', $1, '07596115834', 'Ben@fjcroofingltd.com', 'www.fjcroofingltd.co.uk',
             'Covering Your Home, Protecting Your Family', 'Ben Cunningham', 'Director')
     returning id`,
    [['Rochester', 'United Kingdom', 'ME3 9UD']],
  );
  const tenantId = t.rows[0].id as string;
  await db.query(
    `insert into public.tenant_defaults (tenant_id, deposit_pct_bp, quote_validity_days, vat_default, vat_rate_bp, terms, retention_days)
     values ($1, 3000, 30, true, 2000, $2, 90)`,
    [tenantId, JSON.stringify(wording)],
  );
  for (const [key, label, years] of JOB_TYPES) {
    await db.query(`insert into public.job_types (tenant_id, key, label, guarantee_years) values ($1, $2, $3, $4)`, [tenantId, key, label, years]);
  }
  await seedScopeExamples(db, tenantId);
  const kit = await db.query(`insert into public.brand_kits (tenant_id, theme_key, colours, fonts) values ($1, 'fjc', $2, $3) returning id`, [
    tenantId,
    JSON.stringify(FJC_COLOURS),
    JSON.stringify({ heading: 'Playfair Display', body: 'Inter', mono: 'JetBrains Mono' }),
  ]);
  // The two real logo files live in public/brands/fjc until storage buckets exist.
  for (const [kind, file] of [['logo_colour', 'logo.png'], ['logo_white', 'logo_white.png']] as const) {
    await db.query(
      `insert into public.brand_assets (tenant_id, brand_kit_id, kind, storage_path, width, height, alt) values ($1, $2, $3, $4, 1036, 439, 'FJC Roofing logo')`,
      [tenantId, kit.rows[0].id, kind, `${tenantId}/${file}`],
    );
  }
  await seedBrandImages(db, tenantId);
  return { tenantId, created: true };
}

/**
 * FJC's banner, sign-in photo and share card (files in public/brands/fjc). Only adds a kind that is missing. The
 * banner's licence is still to be confirmed by the owner; until then it is FJC's alone, and removing this row
 * removes it from Home.
 */
const BRAND_IMAGES: [string, string, number, number, string][] = [
  ['hero_image', 'hero-1400.jpg', 1400, 864, ''],
  ['sign_in_photo', 'van-1600.jpg', 1600, 1200, 'FJC Roofing van'],
  ['share_card', 'og.jpg', 1200, 630, 'FJC Roofing Ltd DocPortal'],
];
async function seedBrandImages(db: Db, tenantId: string): Promise<void> {
  const kit = await db.query(`select id from public.brand_kits where tenant_id = $1`, [tenantId]);
  if (!kit.rows[0]) return;
  for (const [kind, file, w, h, alt] of BRAND_IMAGES) {
    await db.query(
      `insert into public.brand_assets (tenant_id, brand_kit_id, kind, storage_path, width, height, alt)
       select $1, $2, $3::text::public.asset_kind, $4, $5, $6, $7
       where not exists (select 1 from public.brand_assets where tenant_id = $1 and kind::text = $3::text)`,
      [tenantId, kit.rows[0].id, kind, `${tenantId}/${file}`, w, h, alt],
    );
  }
}

/** Scope wording for the FJC job types, from src/lib/scope/fjc-examples.ts. Only fills rows that have none. */
async function seedScopeExamples(db: Db, tenantId: string): Promise<void> {
  for (const [key, examples] of Object.entries(FJC_SCOPE_EXAMPLES)) {
    const valid = scopeExamplesSchema.parse(examples);
    await db.query(`update public.job_types set scope_examples = $3 where tenant_id = $1 and key = $2 and scope_examples is null`, [tenantId, key, JSON.stringify(valid)]);
  }
}
