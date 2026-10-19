/**
 * The storage orphan sweep (README "Storage orphan sweep"). Files can be left in the private bucket with nothing
 * pointing at them: a finalise whose commit outcome was unknown, a process that died between upload and commit, a
 * preview drawn for a draft that has since been finalised, a photo whose row was never written, an old signature.
 *
 * For each business, on a service connection: list every file under `{tenant}/`, work out which are referenced by the
 * database, and delete the rest, but only when ALL of these hold:
 *   - the file is older than 24 hours (so nothing still being written is touched), and its age is known;
 *   - its path has one of the shapes this app writes (below). Anything else is left alone and only counted, so a file
 *     written by code this sweep does not know about is never deleted;
 *   - nothing references it: no documents/document_versions pdf_path (or the folder the PDF and its page images share,
 *     or final_content.files), no job_photos path, no brand_assets path; a preview folder counts as referenced while
 *     its version is still a draft.
 * Dry-run mode reports what would go and deletes nothing. Logs and results hold counts only, never paths.
 */
import type { Db } from '../../security/login-guard';
import type { StorageDeleter, StorageLister } from '../storage';

const U = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PAGE = '(?:document\\.pdf|page-\\d{2,3}\\.png)';
/** {tenant}/{customer}/{job}/{version}/{request}/document.pdf|page-NN.png: a finalise request's own folder. */
const REQUEST_FILE = new RegExp(`^(${U})/(${U})/(${U})/(${U})/(${U})/${PAGE}$`);
/** {tenant}/{customer}/{job}/{version}/document.pdf|page-NN.png: the older fixed per-version paths. */
const VERSION_FILE = new RegExp(`^(${U})/(${U})/(${U})/(${U})/${PAGE}$`);
/** {tenant}/{customer}/{job}/{version}/preview-{key}/page-NN.png|pages.json: a draft's preview for reading. */
const PREVIEW_FILE = new RegExp(`^(${U})/(${U})/(${U})/(${U})/preview-[A-Za-z0-9_-]{1,128}/(?:page-\\d{2,3}\\.png|pages\\.json)$`);
/** {tenant}/{customer}/{job}/{photo}.jpg: a re-encoded job photo. */
const PHOTO_FILE = new RegExp(`^(${U})/(${U})/(${U})/(${U})\\.jpg$`);
/** {tenant}/brand/signature-{id}.png: the owner's signature picture. */
const SIGNATURE_FILE = new RegExp(`^(${U})/brand/signature-(${U})\\.png$`);

export const ORPHAN_MIN_AGE_HOURS = 24;

/**
 * MERGE HAZARD: every database column that can hold a storage path must be read by referencesWith, and every file
 * shape the app writes must be in the shape list above, or the sweep would treat those files as unknown (kept) or, if
 * the shape matches but the column is not read, as orphans (deleted). tests/db/maintenance.test.ts fails when a
 * path-like column or a new table appears that is not listed here.
 */
export const SWEEP_REFERENCE_COLUMNS: readonly string[] = ['brand_assets.storage_path', 'document_versions.pdf_path', 'documents.pdf_path', 'job_photos.storage_path'];
/**
 * Every public table, reviewed for whether it stores files. A new table must be added here after checking it.
 * Reviewed at integration: `appointments` (business tabs) holds no file paths (title, notes, times, links only); the
 * survey report added no table: its photos are job_photos rows at {tenant}/{customer}/{job}/{photo}.jpg (PHOTO_FILE).
 */
export const SWEEP_REVIEWED_TABLES: readonly string[] = [
  '_migrations', 'ai_runs', 'appointments', 'audit_log', 'bank_accounts', 'brand_assets', 'brand_kits', 'customers', 'document_emails',
  'document_versions', 'documents', 'job_photos', 'job_types', 'jobs', 'login_attempts', 'payments', 'profiles', 'purge_log', 'share_links',
  'tenant_defaults', 'tenants', 'used_numbers',
];

/**
 * The file shapes the sweep may delete when nothing references them, by name. Brand images (logos, banner, sign-in
 * photo, share card at {tenant}/{file}) are deliberately NOT here: they are only ever 'referenced' (brand_assets) or
 * 'unknown' (kept), never deleted. tests/unit/sweep-coverage.test.ts builds a path with every real path builder and
 * fails if one of them is not represented.
 */
export const SWEEP_SHAPES: Readonly<Record<string, RegExp>> = {
  finaliseRequestFile: REQUEST_FILE,
  versionFile: VERSION_FILE,
  previewFile: PREVIEW_FILE,
  jobPhoto: PHOTO_FILE,
  signature: SIGNATURE_FILE,
};

export interface References {
  /** Exact stored paths. */
  paths: Set<string>;
  /** Folders (ending in '/') whose files belong to a stored version: the PDF's folder holds its page images too. */
  folders: Set<string>;
  /** Versions that are still drafts: their preview folders are in use. */
  draftVersions: Set<string>;
}

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/') + 1);

/** Everything in one business that points at a stored file. Every query is filtered by the tenant. */
export async function referencesWith(db: Db, tenantId: string): Promise<References> {
  const paths = new Set<string>();
  const folders = new Set<string>();
  const draftVersions = new Set<string>();
  const docs = await db.query(`select pdf_path from public.documents where tenant_id = $1 and pdf_path is not null`, [tenantId]);
  const vers = await db.query(`select id, pdf_path, final_content ->> 'files' as files, finalised_at from public.document_versions where tenant_id = $1`, [tenantId]);
  const photos = await db.query(`select storage_path from public.job_photos where tenant_id = $1`, [tenantId]);
  const assets = await db.query(`select storage_path from public.brand_assets where tenant_id = $1`, [tenantId]);
  for (const r of docs.rows) {
    paths.add(String(r.pdf_path));
    folders.add(dirOf(String(r.pdf_path)));
  }
  for (const r of vers.rows) {
    if (typeof r.pdf_path === 'string') {
      paths.add(r.pdf_path);
      folders.add(dirOf(r.pdf_path));
    }
    if (typeof r.files === 'string' && r.files) folders.add(r.files.endsWith('/') ? r.files : `${r.files}/`);
    if (!r.finalised_at) draftVersions.add(String(r.id));
  }
  for (const r of [...photos.rows, ...assets.rows]) paths.add(String(r.storage_path));
  return { paths, folders, draftVersions };
}

export type Verdict = 'referenced' | 'orphan' | 'unknown';

/** Pure: is this file, in this business, referenced, an orphan, or of a shape the sweep must leave alone? */
export function classify(path: string, tenantId: string, refs: References): Verdict {
  if (!path.startsWith(`${tenantId}/`) || path.includes('..') || path.includes('//')) return 'unknown';
  if (refs.paths.has(path)) return 'referenced';
  let m = REQUEST_FILE.exec(path) ?? VERSION_FILE.exec(path);
  if (m) return refs.folders.has(dirOf(path)) ? 'referenced' : 'orphan';
  m = PREVIEW_FILE.exec(path);
  if (m) return refs.draftVersions.has(m[4]) ? 'referenced' : 'orphan';
  if (PHOTO_FILE.test(path) || SIGNATURE_FILE.test(path)) return 'orphan'; // exact paths were checked above
  return 'unknown';
}

export interface SweepResult {
  dryRun: boolean;
  tenants: number;
  scanned: number;
  referenced: number;
  /** Younger than the minimum age, or of unknown age: kept this time. */
  young: number;
  /** Shapes this sweep does not know: always kept. */
  unknown: number;
  orphans: number;
  deleted: number;
}

export async function sweepOrphansWith(
  db: Db,
  storage: StorageLister & StorageDeleter,
  opts: { dryRun: boolean; now?: Date; minAgeHours?: number; tenantIds?: string[] },
): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - (opts.minAgeHours ?? ORPHAN_MIN_AGE_HOURS) * 3600_000;
  const tenants = opts.tenantIds ?? (await db.query(`select id from public.tenants order by id`)).rows.map((r) => String(r.id));
  const out: SweepResult = { dryRun: opts.dryRun, tenants: tenants.length, scanned: 0, referenced: 0, young: 0, unknown: 0, orphans: 0, deleted: 0 };
  for (const tenantId of tenants) {
    if (!new RegExp(`^${U}$`).test(tenantId)) continue;
    const files = await storage.listFiles(`${tenantId}/`);
    // References are read after the listing, so a file uploaded and recorded in between is seen as referenced.
    const refs = await referencesWith(db, tenantId);
    const doomed: string[] = [];
    for (const f of files) {
      out.scanned += 1;
      const v = classify(f.path, tenantId, refs);
      if (v === 'referenced') out.referenced += 1;
      else if (v === 'unknown') out.unknown += 1;
      else if (!f.createdAt || f.createdAt.getTime() > cutoff) out.young += 1;
      else doomed.push(f.path);
    }
    out.orphans += doomed.length;
    if (!opts.dryRun && doomed.length) {
      await storage.deleteStorageObjects(doomed);
      out.deleted += doomed.length;
    }
  }
  return out;
}
