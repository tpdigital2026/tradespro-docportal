import { existsSync } from 'node:fs';
import path from 'node:path';
import { cache } from 'react';
import { DEMO_BRAND, TRADESPRO_BRAND, planAccent, type Logo, type TenantBrand } from './brand-core';
import { withServiceConnection, type ServiceDb } from './data/customer-admin';
import { isDemo } from './demo';
import { isValidSlug } from './slug';

export * from './brand-core';

/* ---------- assets ---------- */

const FILE_RE = /^[A-Za-z0-9_-]{1,60}\.(png|webp|svg)$/;
const DIM_MAX = 4000;

/**
 * Logo URLs come only from our own asset store: a stored path must be `<tenant id>/<file>` and maps to
 * /brands/<slug>/<file> in the app's public folder (until storage buckets exist). Anything else is dropped.
 */
export function logoFromPath(slug: string, tenantId: string, storagePath: unknown, w: unknown, h: unknown, exists: (publicPath: string) => boolean = publicFileExists): Logo | null {
  if (typeof storagePath !== 'string' || !isValidSlug(slug)) return null;
  const prefix = `${tenantId}/`;
  if (!storagePath.startsWith(prefix)) return null;
  const file = storagePath.slice(prefix.length);
  if (!FILE_RE.test(file)) return null;
  const width = Number(w);
  const height = Number(h);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > DIM_MAX || height > DIM_MAX) return null;
  const url = `/brands/${slug}/${file}`;
  return exists(url) ? { url, width, height } : null;
}

function publicFileExists(urlPath: string): boolean {
  try {
    return existsSync(path.join(process.cwd(), 'public', urlPath));
  } catch {
    return false;
  }
}

/* ---------- loading ---------- */

interface BrandRow {
  tenant_id: string;
  slug: string | null;
  name: string;
  accent: string | null;
  logo_colour_path: string | null;
  logo_colour_w: number | null;
  logo_colour_h: number | null;
  logo_white_path: string | null;
  logo_white_w: number | null;
  logo_white_h: number | null;
}

/** Name text is shown through React (escaped); here it only needs to be a sane, short string. */
function cleanName(n: unknown): string | null {
  if (typeof n !== 'string') return null;
  const t = n.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return t.length > 0 && t.length <= 80 ? t : null;
}

export function brandFromRow(row: BrandRow | undefined, exists?: (p: string) => boolean): TenantBrand {
  if (!row) return TRADESPRO_BRAND;
  const name = cleanName(row.name);
  if (!name) return TRADESPRO_BRAND;
  const slug = isValidSlug(row.slug) ? row.slug : null;
  const light = slug ? logoFromPath(slug, row.tenant_id, row.logo_colour_path, row.logo_colour_w, row.logo_colour_h, exists) : null;
  const dark = slug ? logoFromPath(slug, row.tenant_id, row.logo_white_path, row.logo_white_w, row.logo_white_h, exists) : null;
  return {
    name,
    slug,
    logoLight: light,
    logoDark: dark ?? TRADESPRO_BRAND.logoDark,
    // A business without its own white logo keeps the TradesPro mark on the navy, never a missing image.
    accent: planAccent(row.accent) ? (row.accent as string).toLowerCase() : null,
    isOwnBrand: false,
  };
}

async function lookup(slug: string | null, tenantId: string | null, open?: () => Promise<ServiceDb>): Promise<TenantBrand> {
  try {
    return await withServiceConnection(async (db) => {
      const r = await db.query(`select * from private.public_brand($1::text, $2::uuid)`, [slug, tenantId]);
      return brandFromRow(r.rows[0] as BrandRow | undefined);
    }, open);
  } catch {
    // No database, bad keys or any other trouble: the plain TradesPro brand, never an error page.
    return TRADESPRO_BRAND;
  }
}

/** Brand for a signed-in business. Falls back to TradesPro Digital's own. */
export const getTenantBrand: (tenantId: string) => Promise<TenantBrand> = cache(async (tenantId: string) => {
  if (isDemo()) return DEMO_BRAND;
  return lookup(null, tenantId);
});

/** Brand for the public sign-in page. Unknown and malformed slugs give the same plain TradesPro brand. */
export const getBrandBySlug: (slug: string) => Promise<TenantBrand> = cache(async (slug: string) => {
  if (!isValidSlug(slug)) return TRADESPRO_BRAND;
  if (isDemo()) return slug === 'fjc' ? DEMO_BRAND : TRADESPRO_BRAND;
  return lookup(slug, null);
});

export { lookup as lookupBrandForTest };
