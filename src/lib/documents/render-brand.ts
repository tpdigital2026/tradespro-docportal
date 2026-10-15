/**
 * The business's brand as the document templates need it: colours, and images as data: URIs (the rendering page
 * cannot reach the network). Server only (reads files).
 *
 * Logos come from the brand kit's asset rows. Until brand files move into storage, a stored path
 * `<tenant id>/<file>` maps to /public/brands/<slug>/<file> (the same rule the app shell uses).
 * The stored signature is added by the loader (facts-sql signatureWith) only when the owner has switched printing on
 * in Settings; otherwise the sign line is left for a hand signature. Cover photos and build-up diagrams appear only
 * when the business has them on record.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { FJC_COLOURS } from '../../db/seed-fjc';
import { dataUri } from '../../pdf/assets';
import type { Brand } from '../../themes/types';
import { isValidSlug } from '../slug';

/** The colour names the document stylesheet uses (base.css). A brand kit must give every one. */
export const DOCUMENT_COLOUR_KEYS = Object.keys(FJC_COLOURS);
const HEX = /^#[0-9a-fA-F]{6}$/;
const FILE_RE = /^[A-Za-z0-9_-]{1,60}\.(png|jpe?g|webp)$/;

export interface AssetRow {
  kind: string;
  storage_path: string | null;
}

/** Absolute path of a public brand file for a stored asset path, or null when it is not one of ours or is missing. */
export function publicBrandFile(slug: string | null, tenantId: string, storagePath: unknown, exists: (p: string) => boolean = existsSync): string | null {
  if (!slug || !isValidSlug(slug) || typeof storagePath !== 'string') return null;
  const prefix = `${tenantId}/`;
  if (!storagePath.startsWith(prefix)) return null;
  const file = storagePath.slice(prefix.length);
  if (!FILE_RE.test(file)) return null;
  const full = path.join(process.cwd(), 'public', 'brands', slug, file);
  return exists(full) ? full : null;
}

export type BrandResult = { ok: true; brand: Brand } | { ok: false; missing: string[] };

export function renderBrandFrom(args: { slug: string | null; tenantId: string; colours: unknown; assets: AssetRow[] }, read: (file: string) => string = dataUri, exists?: (p: string) => boolean): BrandResult {
  const missing: string[] = [];
  const c = (args.colours && typeof args.colours === 'object' ? args.colours : {}) as Record<string, unknown>;
  const colours: Record<string, string> = {};
  for (const k of DOCUMENT_COLOUR_KEYS) {
    const v = c[k];
    if (typeof v === 'string' && HEX.test(v)) colours[k] = v.toLowerCase();
  }
  if (Object.keys(colours).length !== DOCUMENT_COLOUR_KEYS.length) missing.push('Your document colours are not set up yet. Contact TradesPro Digital to set them up.');
  const first = (kind: string) => args.assets.find((a) => a.kind === kind && publicBrandFile(args.slug, args.tenantId, a.storage_path, exists));
  const logoC = first('logo_colour');
  const logoW = first('logo_white');
  if (!logoC || !logoW) missing.push('Your logo is not set up yet. Contact TradesPro Digital to add it.');
  const cover = first('cover_photo');
  const diagram = first('diagram');
  if (missing.length > 0 || !logoC || !logoW) return { ok: false, missing };
  const file = (a: AssetRow) => read(publicBrandFile(args.slug, args.tenantId, a.storage_path, exists) as string);
  return {
    ok: true,
    brand: {
      colours,
      assets: {
        logoColour: file(logoC),
        logoWhite: file(logoW),
        signature: null,
        coverPhoto: cover ? file(cover) : null,
        diagram: diagram ? file(diagram) : null,
      },
    },
  };
}

/** Demo mode: the real FJC logo files with the approved FJC colours, and the demo signature when switched on. */
export function demoRenderBrand(read: (file: string) => string = dataUri, signature: string | null = null): Brand {
  const dir = path.join(process.cwd(), 'public', 'brands', 'fjc');
  return {
    colours: { ...FJC_COLOURS },
    assets: { logoColour: read(path.join(dir, 'logo.png')), logoWhite: read(path.join(dir, 'logo_white.png')), signature, coverPhoto: null, diagram: null },
  };
}
