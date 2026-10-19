import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { cache } from 'react';
import { DEMO_BRAND, TRADESPRO_BRAND, planAccent, type BrandImage, type Logo, type ShareCard, type TenantBrand } from './brand-core';
import { withServiceConnection, type ServiceDb } from './data/customer-admin';
import { isDemo } from './demo';
import { FJC_BRAND_IMAGES } from './brand-images-fjc';
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

/* ---------- photos and cards ---------- */

const PHOTO_RE = /^([A-Za-z0-9_]+(?:-[A-Za-z]+)*)-(\d{2,4})\.(jpg|webp)$|^([A-Za-z0-9_-]{1,60})\.(jpg|png)$/;

export interface ImageRow {
  kind: string;
  storage_path: string | null;
  width: number | null;
  height: number | null;
  alt: string | null;
}

function publicFiles(slug: string): string[] {
  try {
    return readdirSync(path.join(process.cwd(), 'public', 'brands', slug));
  } catch {
    return [];
  }
}

/**
 * A stored photo path `<tenant>/<name>-<width>.jpg` maps to /brands/<slug>/ like the logos; every width of the same
 * name found there (jpg and webp) goes into the srcset. Anything else is dropped.
 */
export function imageFromRow(slug: string, tenantId: string, row: ImageRow, list: (slug: string) => string[] = publicFiles): BrandImage | null {
  if (!isValidSlug(slug) || typeof row.storage_path !== 'string' || !row.storage_path.startsWith(`${tenantId}/`)) return null;
  const file = row.storage_path.slice(tenantId.length + 1);
  const m = PHOTO_RE.exec(file);
  const w = Number(row.width);
  const h = Number(row.height);
  if (!m || !m[1] || m[3] !== 'jpg' || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > DIM_MAX || h > DIM_MAX) return null;
  const files = list(slug);
  if (!files.includes(file)) return null;
  const widths = (ext: string) =>
    files
      .map((f) => new RegExp(`^${m[1]}-(\\d{2,4})\\.${ext}$`).exec(f))
      .filter((x): x is RegExpExecArray => x !== null)
      .map((x) => Number(x[1]))
      .sort((a, b) => a - b);
  const set = (ext: string) => widths(ext).map((n) => `/brands/${slug}/${m[1]}-${n}.${ext} ${n}w`).join(', ');
  return { src: `/brands/${slug}/${file}`, width: w, height: h, srcSetJpg: set('jpg'), srcSetWebp: widths('webp').length ? set('webp') : null, alt: (row.alt ?? '').slice(0, 120) };
}

export function shareCardFromRow(slug: string, tenantId: string, row: ImageRow, exists: (publicPath: string) => boolean = publicFileExists): ShareCard | null {
  if (!isValidSlug(slug) || typeof row.storage_path !== 'string' || !row.storage_path.startsWith(`${tenantId}/`)) return null;
  const file = row.storage_path.slice(tenantId.length + 1);
  if (!/^[A-Za-z0-9_-]{1,60}\.(jpg|png)$/.test(file) || Number(row.width) !== 1200 || Number(row.height) !== 630) return null;
  const url = `/brands/${slug}/${file}`;
  return exists(url) ? { url, width: 1200, height: 630, alt: (row.alt ?? '').slice(0, 120) } : null;
}

/** The brand images from the kit rows: only the kinds that are there, only files that exist. */
export function brandImagesFrom(slug: string | null, tenantId: string, rows: ImageRow[], list?: (slug: string) => string[], exists?: (p: string) => boolean): Pick<TenantBrand, 'heroImage' | 'signInPhoto' | 'shareCard'> {
  if (!slug) return { heroImage: null, signInPhoto: null, shareCard: null };
  const row = (k: string) => rows.find((r) => r.kind === k);
  const hero = row('hero_image');
  const photo = row('sign_in_photo');
  const card = row('share_card');
  return {
    heroImage: hero ? imageFromRow(slug, tenantId, hero, list) : null,
    signInPhoto: photo ? imageFromRow(slug, tenantId, photo, list) : null,
    shareCard: card ? shareCardFromRow(slug, tenantId, card, exists) : null,
  };
}

/** Demo mode: the FJC brand with its images read from the same list the seed uses (src/lib/brand-images-fjc.ts). */
export function demoBrand(list?: (slug: string) => string[]): TenantBrand {
  const rows = FJC_BRAND_IMAGES.map((i) => ({ kind: i.kind, storage_path: `demo/${i.file}`, width: i.width, height: i.height, alt: i.alt }));
  const imgs = brandImagesFrom('fjc', 'demo', rows, list);
  return { ...DEMO_BRAND, heroImage: imgs.heroImage ?? DEMO_BRAND.heroImage, signInPhoto: imgs.signInPhoto ?? DEMO_BRAND.signInPhoto };
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
      // Brand and its images in one round trip. If the images half fails, the two-step read below keeps the brand.
      const one = await db
        .query(`select b.*, (select coalesce(json_agg(i), '[]'::json) from private.public_brand_images($1::text, $2::uuid) i) as images from private.public_brand($1::text, $2::uuid) b`, [slug, tenantId])
        .catch(() => null);
      if (one) {
        const row = one.rows[0] as (BrandRow & { images?: unknown }) | undefined;
        const brand = brandFromRow(row);
        if (brand.isOwnBrand || !row) return brand;
        return { ...brand, ...brandImagesFrom(brand.slug, row.tenant_id, Array.isArray(row.images) ? (row.images as ImageRow[]) : []) };
      }
      const r = await db.query(`select * from private.public_brand($1::text, $2::uuid)`, [slug, tenantId]);
      const brand = brandFromRow(r.rows[0] as BrandRow | undefined);
      if (brand.isOwnBrand) return brand;
      const row = r.rows[0] as BrandRow;
      const imgs = await db.query(`select * from private.public_brand_images($1::text, $2::uuid)`, [slug, tenantId]).catch(() => ({ rows: [] }));
      return { ...brand, ...brandImagesFrom(brand.slug, row.tenant_id, imgs.rows as ImageRow[]) };
    }, open);
  } catch {
    // No database, bad keys or any other trouble: the plain TradesPro brand, never an error page.
    return TRADESPRO_BRAND;
  }
}

/** Brand for a signed-in business. Falls back to TradesPro Digital's own. */
export const getTenantBrand: (tenantId: string) => Promise<TenantBrand> = cache(async (tenantId: string) => {
  if (isDemo()) return demoBrand();
  return lookup(null, tenantId);
});

/** Brand for the public sign-in page. Unknown and malformed slugs give the same plain TradesPro brand. */
export const getBrandBySlug: (slug: string) => Promise<TenantBrand> = cache(async (slug: string) => {
  if (!isValidSlug(slug)) return TRADESPRO_BRAND;
  if (isDemo()) return slug === 'fjc' ? demoBrand() : TRADESPRO_BRAND;
  return lookup(slug, null);
});

export { lookup as lookupBrandForTest };
