import type { Db } from '../security/login-guard';
import { FJC_WORDING, tenantWordingSchema } from './wording';

// Taken from tests/fixtures/fjc.ts (the approved FJC brand).
const FJC_COLOURS = {
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
  if (existing.rows.length > 0) return { tenantId: existing.rows[0].id, created: false };

  const t = await db.query(
    `insert into public.tenants (name, trade_type, company_number, vat_registered, vat_number, address_lines, phone, email, website, tagline, owner_name, owner_title)
     values ('FJC Roofing Ltd', 'roofing', '13855379', true, 'GB 408094403', $1, '07596115834', 'Ben@fjcroofingltd.com', 'www.fjcroofingltd.co.uk',
             'Covering Your Home, Protecting Your Family', 'Ben Cunningham', 'Director')
     returning id`,
    [['Rochester', 'United Kingdom', 'ME3 9UD']],
  );
  const tenantId = t.rows[0].id as string;
  await db.query(
    `insert into public.tenant_defaults (tenant_id, deposit_pct_bp, quote_validity_days, vat_default, vat_rate_bp, terms)
     values ($1, 3000, 30, true, 2000, $2)`,
    [tenantId, JSON.stringify(wording)],
  );
  for (const [key, label, years] of JOB_TYPES) {
    await db.query(`insert into public.job_types (tenant_id, key, label, guarantee_years) values ($1, $2, $3, $4)`, [tenantId, key, label, years]);
  }
  await db.query(`insert into public.brand_kits (tenant_id, theme_key, colours, fonts) values ($1, 'fjc', $2, $3)`, [
    tenantId,
    JSON.stringify(FJC_COLOURS),
    JSON.stringify({ heading: 'Playfair Display', body: 'Inter', mono: 'JetBrains Mono' }),
  ]);
  return { tenantId, created: true };
}
