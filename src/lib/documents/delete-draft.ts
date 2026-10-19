/**
 * Deleting a draft document that was never issued (owner or staff, their own business only).
 *
 * One transaction on a service connection: private.delete_draft_document locks the job and the document, re-checks the
 * rules (draft, no issued version, no payment pointing at it) and deletes the rows, then the audit row (ids only) is
 * written, then commit. Only after the commit are the draft's stored files removed (its preview pages, and a survey's
 * photos). If that removal fails, nothing in the database points at those files any more, so the storage orphan sweep
 * (src/lib/maintenance/orphan-sweep.ts: preview and photo shapes) deletes them a day later. A file is never removed
 * while a row still needs it.
 */
import type { Db } from '../../security/login-guard';
import { writeAudit } from '../../security/audit';
import type { StorageDeleter } from '../storage';
import { compactId } from '../data/customer-admin';
import { logFailure } from '../log-failure';

export type DeleteDraftStatus = 'deleted' | 'not_found' | 'issued' | 'in_use' | 'not_allowed';

export interface DeleteDraftResult {
  status: DeleteDraftStatus;
  /** The job went too (it was made for this draft and nothing else is on it). */
  jobDeleted?: boolean;
  /** Storage paths and folders the caller attempted to remove (for tests; never logged). */
  removed?: { prefixes: string[]; paths: string[] };
}

export interface DeleteActor {
  tenantId: string;
  userId: string;
  role: string;
}

export const DELETE_DRAFT_MESSAGES: Record<Exclude<DeleteDraftStatus, 'deleted'>, string> = {
  not_found: 'That draft could not be found. It may have been deleted already.',
  issued: 'This document has been issued, so it cannot be deleted. Only a draft that was never issued can be deleted.',
  in_use: 'This draft is linked to a recorded payment, so it cannot be deleted.',
  not_allowed: 'Only the owner or staff of this business can delete drafts.',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Owner and staff of the business. TradesPro admins and anyone else are refused before the database is touched. */
export const mayDeleteDrafts = (role: string) => role === 'owner' || role === 'staff';

export async function deleteDraftWith(db: Db, storage: StorageDeleter, actor: DeleteActor, documentId: string, o: { nested?: boolean } = {}): Promise<DeleteDraftResult> {
  if (!mayDeleteDrafts(actor.role)) return { status: 'not_allowed' };
  if (!UUID.test(documentId) || !UUID.test(actor.tenantId)) return { status: 'not_found' };
  const nested = o.nested === true;
  await db.query(nested ? 'savepoint delete_draft' : 'begin');
  let out: { status?: unknown; customerId?: unknown; jobId?: unknown; jobDeleted?: unknown; versionIds?: unknown; photoPaths?: unknown; type?: unknown };
  try {
    await db.query('reset role');
    await db.query(`select set_config('request.jwt.claims', '', true)`);
    await db.query(`set local statement_timeout = '30s'`);
    const r = await db.query('select private.delete_draft_document($1, $2) as r', [actor.tenantId, documentId]);
    out = (r.rows[0]?.r ?? {}) as typeof out;
    if (out.status !== 'deleted') {
      await db.query(nested ? 'rollback to savepoint delete_draft' : 'rollback');
      const s = out.status;
      return { status: s === 'issued' || s === 'in_use' ? s : 'not_found' };
    }
    const versions = Array.isArray(out.versionIds) ? out.versionIds.map(String) : [];
    const photos = Array.isArray(out.photoPaths) ? out.photoPaths.map(String) : [];
    await writeAudit(db, {
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: 'document.delete_draft',
      entity: 'document',
      entityId: compactId(documentId),
      meta: { job: compactId(String(out.jobId)), jobDeleted: out.jobDeleted === true, versions: versions.length, photos: photos.length },
    });
    await db.query(nested ? 'release savepoint delete_draft' : 'commit');
  } catch (e) {
    await db.query(nested ? 'rollback to savepoint delete_draft' : 'rollback').catch(() => undefined);
    throw e;
  }

  // After the commit: the draft's own files. Paths are built only from ids the database returned for this business.
  const customerId = String(out.customerId);
  const jobId = String(out.jobId);
  const jobFolder = `${actor.tenantId}/${customerId}/${jobId}/`;
  const prefixes = out.jobDeleted === true ? [jobFolder] : (Array.isArray(out.versionIds) ? out.versionIds.map(String) : []).map((v) => `${jobFolder}${v}/`);
  const paths = (Array.isArray(out.photoPaths) ? out.photoPaths.map(String) : []).filter((p) => p.startsWith(`${actor.tenantId}/`));
  try {
    if (paths.length) await storage.deleteStorageObjects(paths);
    for (const p of prefixes) if (UUID.test(customerId) && UUID.test(jobId)) await storage.deleteStoragePrefix(p);
  } catch (e) {
    // The rows are gone; the orphan sweep removes what is left after 24 hours.
    logFailure('documents.delete_draft.storage', e);
  }
  return { status: 'deleted', jobDeleted: out.jobDeleted === true, removed: { prefixes, paths } };
}
