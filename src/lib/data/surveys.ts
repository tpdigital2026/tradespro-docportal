/**
 * Survey reports: the draft, its photos, the AI drafts and the approvals. What the screens, actions and routes call.
 *
 * Every write runs on a service connection in ONE transaction, with the tenant and the person taken from the session
 * and every id from the browser re-checked against that tenant (as for invoices and receipts, README "Server code
 * rules"). Demo mode keeps everything in memory with dummy data.
 *
 * A survey creates its customer if the customer is new, so they appear in the customer list, and its job (the job
 * number is the quote number to be). The survey report's number is SR-{job number}.
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import { draftFinding, draftOpinion, type AiUsage } from '../../ai/survey-finding';
import { createRateLimiter } from '../../ai/rate-limit';
import { writeAudit } from '../../security/audit';
import type { Db } from '../../security/login-guard';
import { demoCustomers, demoSession } from '../demo-data';
import { demoSlot, isDemo } from '../demo';
import { quoteLinkLine } from '../survey/map';
import { cleanPhoto, PhotoError, printCopy } from '../survey/images';
import { auditedSurveyHashesWith, SURVEY_APPROVE_ACTION } from '../survey/approval-sql';
import { parseSurveyInput } from '../survey/facts-sql';
import {
  emptySurvey,
  findingHash,
  isFindingApproved,
  opinionHash,
  sanitiseIncomingSurvey,
  surveyErrors,
  SURVEY_LIMITS,
  tidyLine,
  tidyPara,
  withoutApprovals,
  type Finding,
  type SurveyFormValues,
} from '../survey/model';
import { todayLondon } from '../payment';
import { suggestNextNumber } from '../quote-number';
import { requireSession, type Session } from '../session';
import { getStorage, type DocumentStorage } from '../storage';
import { customerSchema } from '../validation/customer';
import { NUMBER_RE, NUMBER_SUFFIX_MESSAGE, quoteNumberReserved, emptyQuoteForm, type QuoteFormValues } from '../validation/quote';
import { FJC_WORDING, tenantWordingSchema } from '../../db/wording';
import { compactId, withServiceConnection, type Actor } from './customer-admin';
import { isKnownId, isRealId, saveQuoteDraft, getQuoteDefaultsWith, demoRestoreDraft } from './quotes';
import { getCustomer, listCustomers, ownerClient } from './customers';

export type SurveyErrorCode = 'invalid' | 'number_used' | 'locked' | 'not_found' | 'limit' | 'failed';

export class SurveyError extends Error {
  constructor(
    readonly code: SurveyErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'SurveyError';
  }
}

// ---------------------------------------------------------------- context for the form

export interface SurveyCustomerOption {
  id: string;
  name: string;
  addressLine: string;
  postcode: string;
}
export interface SurveyJobOption {
  id: string;
  reference: string;
  customerId: string;
  propertyAddress: string;
}
export interface SurveyContext {
  customers: SurveyCustomerOption[];
  /** Jobs that have no survey report yet, for "a job you already have". */
  jobs: SurveyJobOption[];
  suggestedNumber: string;
  today: string;
  preparedBy: string;
  /** The AI assistant is set up on this server. */
  aiOn: boolean;
}

export interface SurveyDraft {
  documentId: string;
  jobId: string;
  number: string;
  jobReference: string;
  customerId: string;
  customerName: string;
  status: 'draft' | 'final';
  values: SurveyFormValues;
  photos: SurveyPhotoInfo[];
}

export interface SurveyPhotoInfo {
  id: string;
  width: number;
  height: number;
}

// ---------------------------------------------------------------- the save

/** A new customer as typed (the customer form's rules apply on the server: customerSchema). */
export interface NewCustomerFields {
  name: string;
  addressLines: string[];
  postcode: string;
  email: string;
  phone: string;
}
export type CustomerChoice = { kind: 'existing'; id: string } | { kind: 'new'; customer: NewCustomerFields };
export type JobChoice = { kind: 'existing'; id: string } | { kind: 'new'; reference: string };

export interface SaveSurveyRequest {
  /** null for the first save, which creates the customer (if new), the job (if new) and the document. */
  documentId: string | null;
  customer: CustomerChoice | null;
  job: JobChoice | null;
  values: SurveyFormValues;
}

export interface SavedSurvey {
  documentId: string;
  jobId: string;
  customerId: string;
  number: string;
  jobReference: string;
  savedAt: string;
  /** The approvals as kept by the server (an edit clears them). The browser shows these. */
  values: SurveyFormValues;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TxOpts {
  nested?: boolean;
}

async function tx<T>(db: Db, name: string, o: TxOpts, fn: () => Promise<T>): Promise<T> {
  const nested = o.nested === true;
  await db.query(nested ? `savepoint ${name}` : 'begin');
  try {
    if (!nested) {
      await db.query('reset role');
      await db.query(`select set_config('request.jwt.claims', '', true)`);
    }
    const out = await fn();
    await db.query(nested ? `release savepoint ${name}` : 'commit');
    return out;
  } catch (e) {
    await db.query(nested ? `rollback to savepoint ${name}` : 'rollback').catch(() => undefined);
    throw e;
  }
}

interface LockedSurvey {
  id: string;
  jobId: string;
  customerId: string;
  number: string;
  reference: string;
  status: string;
  versionId: string;
  version: number;
  stored: SurveyFormValues | null;
}

/** The survey document row FOR UPDATE, then its newest version FOR UPDATE (README: lock the document first). */
async function lockSurveyWith(db: Db, tenantId: string, documentId: string): Promise<LockedSurvey> {
  if (!UUID.test(documentId)) throw new SurveyError('not_found', 'That survey could not be found.');
  const d = await db.query(
    `select d.id, d.job_id, d.number, d.status::text as status, j.customer_id, j.reference
       from public.documents d join public.jobs j on j.id = d.job_id and j.tenant_id = d.tenant_id
      where d.id = $1 and d.tenant_id = $2 and d.type = 'survey_report' for update of d`,
    [documentId, tenantId],
  );
  const r = d.rows[0];
  if (!r) throw new SurveyError('not_found', 'That survey could not be found.');
  const v = await db.query(`select id, version, finalised_at, input from public.document_versions where document_id = $1 and tenant_id = $2 order by version desc limit 1 for update`, [documentId, tenantId]);
  const ver = v.rows[0];
  if (r.status !== 'draft' || !ver || ver.finalised_at) throw new SurveyError('locked', 'This survey report has been finalised and can no longer be changed.');
  return { id: String(r.id), jobId: String(r.job_id), customerId: String(r.customer_id), number: String(r.number), reference: String(r.reference), status: String(r.status), versionId: String(ver.id), version: Number(ver.version), stored: parseSurveyInput(ver.input) };
}

/** Photos that belong to this job, by id. A finding may only use these. */
async function jobPhotoIdsWith(db: Db, tenantId: string, jobId: string): Promise<Set<string>> {
  const r = await db.query(`select id from public.job_photos where job_id = $1 and tenant_id = $2`, [jobId, tenantId]);
  return new Set(r.rows.map((x) => String(x.id)));
}

/** Drops photo ids the job does not own (a crafted request), and settles the cover. */
function keepOwnPhotos(v: SurveyFormValues, own: Set<string>): SurveyFormValues {
  const findings = v.findings.map((f) => ({ ...f, photoIds: f.photoIds.filter((id) => own.has(id)) }));
  const used = new Set(findings.flatMap((f) => f.photoIds));
  return { ...v, findings, coverPhotoId: v.coverPhotoId && used.has(v.coverPhotoId) ? v.coverPhotoId : '' };
}

function checkValues(v: SurveyFormValues): void {
  const e = surveyErrors(v);
  const first = Object.entries(e)[0];
  if (first) throw new SurveyError('invalid', first[1], first[0]);
}

const stored = (v: SurveyFormValues) => JSON.stringify({ schema: 1, survey: v });

export interface Signer {
  fullName: string;
  role: string;
}

/** The signed-in person's own profile (active, in this business). The report is prepared and signed in this name only. */
export async function signerWith(db: Db, actor: Actor): Promise<Signer> {
  const r = await db.query(`select full_name, role::text as role from public.profiles where id = $1 and tenant_id = $2 and disabled_at is null`, [actor.userId, actor.tenantId]);
  const p = r.rows[0];
  const fullName = typeof p?.full_name === 'string' ? tidyLine(p.full_name) : '';
  if (!fullName) throw new SurveyError('failed', 'Your profile has no name, so the report cannot be signed. Contact TradesPro Digital.');
  return { fullName, role: String(p.role) };
}

/** "Prepared by" and the signature are never free text: they are the signed-in person's profile name. */
const asSigner = (v: SurveyFormValues, signer: Signer): SurveyFormValues => ({ ...v, preparedBy: signer.fullName, signName: signer.fullName });

export async function saveSurveyWith(db: Db, actor: Actor, req: SaveSurveyRequest, today: string, o: TxOpts & { trustApproval?: boolean } = {}): Promise<SavedSurvey> {
  checkValues(req.values);
  return tx(db, 'survey_save', o, async () => {
    const signer = await signerWith(db, actor);
    if (req.documentId) {
      const s = await lockSurveyWith(db, actor.tenantId, req.documentId);
      const own = await jobPhotoIdsWith(db, actor.tenantId, s.jobId);
      let values = keepOwnPhotos(asSigner(req.values, signer), own);
      if (!o.trustApproval) values = sanitiseIncomingSurvey(values, s.stored);
      await db.query(`update public.document_versions set input = $1::jsonb where id = $2 and tenant_id = $3`, [stored(values), s.versionId, actor.tenantId]);
      await db.query(`update public.documents set doc_date = $1 where id = $2 and tenant_id = $3`, [values.surveyDate || today, s.id, actor.tenantId]);
      // The address belongs to the job until a quote exists; after that the quote owns it.
      await db.query(
        `update public.jobs set property_address = $1 where id = $2 and tenant_id = $3
            and not exists (select 1 from public.documents q where q.job_id = $2 and q.tenant_id = $3 and q.type = 'quotation')`,
        [tidyPara(values.propertyAddress).replace(/\n+/g, ', ') || null, s.jobId, actor.tenantId],
      );
      return { documentId: s.id, jobId: s.jobId, customerId: s.customerId, number: s.number, jobReference: s.reference, savedAt: new Date().toISOString(), values };
    }

    // First save: the customer, the job, the document and its first version, together or not at all.
    if (!req.customer) throw new SurveyError('invalid', 'Choose who the survey is for, or add them.', 'customer');
    if (!req.job) throw new SurveyError('invalid', 'Choose the job, or give the new job a number.', 'job');
    let customerId: string;
    if (req.customer.kind === 'existing') {
      if (!UUID.test(req.customer.id)) throw new SurveyError('invalid', 'Choose who the survey is for.', 'customer');
      const c = await db.query(`select id from public.customers where id = $1 and tenant_id = $2`, [req.customer.id, actor.tenantId]);
      if (!c.rows[0]) throw new SurveyError('invalid', 'That customer could not be found.', 'customer');
      customerId = req.customer.id;
    } else {
      const parsed = customerSchema.safeParse(req.customer.customer);
      if (!parsed.success) throw new SurveyError('invalid', parsed.error.issues[0]?.message ?? 'Check the customer details.', 'customer');
      const c = parsed.data;
      const ins = await db.query(
        `insert into public.customers (tenant_id, name, address_lines, postcode, email, phone) values ($1, $2, $3, $4, $5, $6) returning id`,
        [actor.tenantId, c.name, c.addressLines, c.postcode, c.email, c.phone],
      );
      customerId = String(ins.rows[0].id);
    }
    let jobId: string;
    let reference: string;
    if (req.job.kind === 'existing') {
      if (!UUID.test(req.job.id)) throw new SurveyError('invalid', 'Choose the job.', 'job');
      const j = await db.query(`select id, reference, customer_id from public.jobs where id = $1 and tenant_id = $2 for update`, [req.job.id, actor.tenantId]);
      const row = j.rows[0];
      if (!row) throw new SurveyError('invalid', 'That job could not be found.', 'job');
      if (String(row.customer_id) !== customerId) throw new SurveyError('invalid', 'That job belongs to a different customer.', 'job');
      const has = await db.query(`select 1 from public.documents where job_id = $1 and tenant_id = $2 and type = 'survey_report' limit 1`, [req.job.id, actor.tenantId]);
      if (has.rows[0]) throw new SurveyError('invalid', 'That job already has a survey report. Open it from Documents.', 'job');
      jobId = String(row.id);
      reference = String(row.reference);
    } else {
      reference = req.job.reference.trim();
      if (!NUMBER_RE.test(reference)) throw new SurveyError('invalid', 'Use 2 to 40 letters, numbers, dots, dashes or slashes, starting with a letter or number', 'jobReference');
      if (quoteNumberReserved(reference) !== null) throw new SurveyError('invalid', NUMBER_SUFFIX_MESSAGE, 'jobReference');
      await db.query('savepoint survey_job');
      try {
        const j = await db.query(
          `insert into public.jobs (tenant_id, customer_id, reference, property_address, created_by) values ($1, $2, $3, $4, $5) returning id`,
          [actor.tenantId, customerId, reference, tidyPara(req.values.propertyAddress).replace(/\n+/g, ', ') || null, actor.userId],
        );
        jobId = String(j.rows[0].id);
        await db.query('release savepoint survey_job');
      } catch (e) {
        await db.query('rollback to savepoint survey_job');
        if ((e as { code?: string }).code === '23505') throw new SurveyError('number_used', 'That job number has already been used. Choose another.', 'jobReference');
        if ((e as { code?: string }).code === '23514') throw new SurveyError('invalid', NUMBER_SUFFIX_MESSAGE, 'jobReference');
        throw e;
      }
    }
    const values = keepOwnPhotos(sanitiseIncomingSurvey(asSigner(req.values, signer), null), new Set());
    const number = `SR-${reference}`;
    const d = await db.query(
      `insert into public.documents (tenant_id, job_id, type, number, doc_date, created_by) values ($1, $2, 'survey_report', $3, $4, $5) returning id`,
      [actor.tenantId, jobId, number, values.surveyDate || today, actor.userId],
    );
    const documentId = String(d.rows[0].id);
    const v = await db.query(`insert into public.document_versions (tenant_id, document_id, version, input, created_by) values ($1, $2, 1, $3::jsonb, $4) returning id`, [actor.tenantId, documentId, stored(values), actor.userId]);
    await db.query(`update public.documents set current_version_id = $1 where id = $2 and tenant_id = $3`, [v.rows[0].id, documentId, actor.tenantId]);
    return { documentId, jobId, customerId, number, jobReference: reference, savedAt: new Date().toISOString(), values };
  });
}

// ---------------------------------------------------------------- approval (the only place one is made)

export type ApprovePart = { kind: 'finding'; findingId: string } | { kind: 'opinion' };

/**
 * Approves one finding, or the professional opinion, in ONE transaction: the document is locked, the incoming words
 * are saved (an edit since the last save is part of what is approved), the server stamps the time and the
 * fingerprint, and the audit row (document id, part, fingerprint; never words) is written. If the audit cannot be
 * written, nothing is saved.
 */
export async function approveSurveyPartWith(db: Db, actor: Actor, documentId: string, incoming: SurveyFormValues, part: ApprovePart, o: TxOpts & { now?: () => Date } = {}): Promise<SavedSurvey> {
  checkValues(incoming);
  return tx(db, 'survey_approve', o, async () => {
    const s = await lockSurveyWith(db, actor.tenantId, documentId);
    const signer = await signerWith(db, actor);
    // Nobody approves under another person's name: what was sent must already be in the approver's own name.
    if (tidyLine(incoming.signName) !== signer.fullName || tidyLine(incoming.preparedBy) !== signer.fullName) {
      throw new SurveyError('invalid', `This report is prepared and signed in your own name, ${signer.fullName}. Open it again and approve it as yourself.`);
    }
    const own = await jobPhotoIdsWith(db, actor.tenantId, s.jobId);
    let values = sanitiseIncomingSurvey(keepOwnPhotos(asSigner(incoming, signer), own), s.stored);
    const at = (o.now ?? (() => new Date()))().toISOString();
    let hash: string;
    let meta: Record<string, unknown>;
    if (part.kind === 'finding') {
      const i = values.findings.findIndex((f) => f.id === part.findingId);
      const f = values.findings[i];
      if (!f) throw new SurveyError('not_found', 'That finding could not be found. Save and try again.');
      if (f.photoIds.length === 0) throw new SurveyError('invalid', 'Add at least one photo before you approve this finding.');
      if (!tidyLine(f.title) || !tidyPara(f.observation) || !tidyPara(f.assessment)) throw new SurveyError('invalid', 'Fill in the title, the observation and your assessment before you approve this finding.');
      hash = findingHash(f);
      values = { ...values, findings: values.findings.map((x, k) => (k === i ? { ...x, approvedAt: at, approvalHash: hash } : x)) };
      meta = { part: 'finding', n: i + 1, photos: f.photoIds.length, engine: f.engine ?? 'none', role: signer.role, hash };
    } else {
      if (!tidyPara(values.opinion)) throw new SurveyError('invalid', 'Write your professional opinion before you approve it.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(values.signDate)) throw new SurveyError('invalid', 'Add the date you sign the report before you approve the opinion.');
      hash = opinionHash(values);
      values = { ...values, opinionApprovedAt: at, opinionHash: hash, opinionSignerId: actor.userId };
      meta = { part: 'opinion', engine: values.opinionEngine ?? 'none', role: signer.role, hash };
    }
    await db.query(`update public.document_versions set input = $1::jsonb where id = $2 and tenant_id = $3`, [stored(values), s.versionId, actor.tenantId]);
    await writeAudit(db, { tenantId: actor.tenantId, userId: actor.userId, action: SURVEY_APPROVE_ACTION, entity: 'document', entityId: compactId(s.id), meta });
    return { documentId: s.id, jobId: s.jobId, customerId: s.customerId, number: s.number, jobReference: s.reference, savedAt: at, values };
  });
}

// ---------------------------------------------------------------- photos

export interface UploadedPhoto {
  id: string;
  width: number;
  height: number;
}

/** `{tenant}/{customer}/{job}/{photo}.jpg`: ids only, inside the tenant's prefix (the database checks the shape). */
export const photoPath = (tenantId: string, customerId: string, jobId: string, photoId: string) => `${tenantId}/${customerId}/${jobId}/${photoId}.jpg`;

/** Photos a draft may still take: the finding must exist in the stored draft, with room on it and in the report. */
async function photoRoomWith(db: Db, tenantId: string, documentId: string, findingId: string, lock: boolean): Promise<LockedSurvey> {
  const s = lock ? await lockSurveyWith(db, tenantId, documentId) : await readSurveyWith(db, tenantId, documentId);
  const f = s.stored?.findings.find((x) => x.id === findingId);
  if (!f) throw new SurveyError('not_found', 'That finding is not saved yet. Wait a moment and try again.');
  if (f.photoIds.length >= SURVEY_LIMITS.photosPerFinding) throw new SurveyError('limit', `Finding photos are limited to ${SURVEY_LIMITS.photosPerFinding}. Remove one to add another.`);
  const shown = new Set((s.stored?.findings ?? []).flatMap((x) => x.photoIds));
  if (shown.size >= SURVEY_LIMITS.photosPerSurvey) throw new SurveyError('limit', `This report already shows ${SURVEY_LIMITS.photosPerSurvey} photos, the most it can hold.`);
  // A hard cap on stored photos, whatever the draft says: at most twice the report limit in all, and never more than
  // a finding's worth that no finding shows (uploads still being added, or left behind). Under the lock in the
  // transaction, so two uploads at once cannot both slip under it.
  const rows = await db.query(`select id from public.job_photos where job_id = $1 and tenant_id = $2`, [s.jobId, tenantId]);
  const ids = rows.rows.map((r) => String(r.id));
  const unused = ids.filter((id) => !shown.has(id)).length;
  if (ids.length >= PHOTO_ROW_CAP || unused >= SURVEY_LIMITS.photosPerFinding) throw new SurveyError('limit', UNUSED_PHOTOS);
  return s;
}

/** Stored photos a job may hold in all (twice what one report can show). */
export const PHOTO_ROW_CAP = 2 * SURVEY_LIMITS.photosPerSurvey;
export const UNUSED_PHOTOS = 'There are photos waiting that are not in any finding. Remove them under "Photos not in a finding", then add this one.';

/** As lockSurveyWith, without the locks: for the cheap checks made before any work. */
async function readSurveyWith(db: Db, tenantId: string, documentId: string): Promise<LockedSurvey> {
  if (!UUID.test(documentId)) throw new SurveyError('not_found', 'That survey could not be found.');
  const d = await db.query(
    `select d.id, d.job_id, d.number, d.status::text as status, j.customer_id, j.reference
       from public.documents d join public.jobs j on j.id = d.job_id and j.tenant_id = d.tenant_id
      where d.id = $1 and d.tenant_id = $2 and d.type = 'survey_report'`,
    [documentId, tenantId],
  );
  const r = d.rows[0];
  if (!r) throw new SurveyError('not_found', 'That survey could not be found.');
  const v = await db.query(`select id, version, finalised_at, input from public.document_versions where document_id = $1 and tenant_id = $2 order by version desc limit 1`, [documentId, tenantId]);
  const ver = v.rows[0];
  if (r.status !== 'draft' || !ver || ver.finalised_at) throw new SurveyError('locked', 'This survey report has been finalised and can no longer be changed.');
  return { id: String(r.id), jobId: String(r.job_id), customerId: String(r.customer_id), number: String(r.number), reference: String(r.reference), status: String(r.status), versionId: String(ver.id), version: Number(ver.version), stored: parseSurveyInput(ver.input) };
}

/**
 * Stores one photo for a finding of a draft survey. Before any image work: the document, its job and the finding
 * must exist in this business, with room for a photo. Then the image is cleaned (src/lib/survey/images.ts: a real
 * image, metadata gone). Then, in a transaction, the same checks again under the document lock and the row is
 * written; after commit the file is uploaded, and if the upload fails the row is deleted again (README "More server
 * rules").
 */
export async function uploadSurveyPhotoWith(db: Db, storage: DocumentStorage, actor: Actor, documentId: string, findingId: string, raw: Uint8Array, o: TxOpts = {}): Promise<UploadedPhoto> {
  await photoRoomWith(db, actor.tenantId, documentId, findingId, false);
  const clean = await cleanPhoto(raw);
  const id = randomUUID();
  const row = await tx(db, 'survey_photo', o, async () => {
    const s = await photoRoomWith(db, actor.tenantId, documentId, findingId, true);
    const path = photoPath(actor.tenantId, s.customerId, s.jobId, id);
    await db.query(
      `insert into public.job_photos (id, tenant_id, job_id, finding_ref, storage_path, width, height, sha256, bytes) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, actor.tenantId, s.jobId, findingId, path, clean.width, clean.height, clean.sha256, clean.bytes.length],
    );
    return { path };
  });
  try {
    await storage.put(row.path, clean.bytes, 'image/jpeg');
  } catch {
    await db.query(`delete from public.job_photos where id = $1 and tenant_id = $2`, [id, actor.tenantId]).catch(() => undefined);
    await storage.deleteStorageObjects([row.path]).catch(() => undefined);
    throw new SurveyError('failed', 'The photo could not be stored. Please try again.');
  }
  return { id, width: clean.width, height: clean.height };
}

/** One stored photo of this business, for the owner's own screens. */
export async function readSurveyPhotoWith(db: Db, storage: DocumentStorage, tenantId: string, photoId: string): Promise<Buffer | null> {
  if (!UUID.test(photoId)) return null;
  const r = await db.query(`select storage_path from public.job_photos where id = $1 and tenant_id = $2`, [photoId, tenantId]);
  const path = r.rows[0]?.storage_path;
  return typeof path === 'string' ? storage.get(path) : null;
}

/**
 * Removes a photo the owner no longer wants. The row goes first, in a transaction; the file is deleted only after the
 * commit, so a failed commit never leaves a row without its file. If the file delete fails, the file is left for the
 * storage orphan sweep (no row points at it). Refused while the stored draft still shows the photo, and once a
 * finalised document of the job shows it: issued documents never change.
 */
export async function deleteSurveyPhotoWith(db: Db, storage: DocumentStorage, actor: Actor, documentId: string, photoId: string, o: TxOpts = {}): Promise<void> {
  if (!UUID.test(photoId)) throw new SurveyError('not_found', 'That photo could not be found.');
  const path = await tx(db, 'survey_photo_delete', o, async () => {
    const s = await lockSurveyWith(db, actor.tenantId, documentId);
    const p = await db.query(`select storage_path from public.job_photos where id = $1 and tenant_id = $2 and job_id = $3 for update`, [photoId, actor.tenantId, s.jobId]);
    const found = p.rows[0]?.storage_path;
    if (typeof found !== 'string') throw new SurveyError('not_found', 'That photo could not be found.');
    if (s.stored?.findings.some((f) => f.photoIds.includes(photoId)) || s.stored?.coverPhotoId === photoId) throw new SurveyError('invalid', 'That photo is still in a finding. Remove it from the finding first.');
    const used = await db.query(
      `select 1 from public.document_versions v join public.documents d on d.id = v.document_id and d.tenant_id = v.tenant_id
        where d.job_id = $1 and v.tenant_id = $2 and v.finalised_at is not null and v.final_content::text like '%' || $3 || '%' limit 1`,
      [s.jobId, actor.tenantId, photoId],
    );
    if (used.rows[0]) throw new SurveyError('locked', 'That photo is in a finalised document, so it is kept.');
    await db.query(`delete from public.job_photos where id = $1 and tenant_id = $2`, [photoId, actor.tenantId]);
    return found;
  });
  await storage.deleteStorageObjects([path]).catch(() => undefined);
}

// ---------------------------------------------------------------- AI drafts

/** Thirty AI drafts per person in ten minutes (findings and opinions together). Per process. */
const surveyAiLimiter = createRateLimiter(30, 10 * 60_000);

async function recordRun(tenantId: string, documentId: string | null, u: AiUsage | null): Promise<void> {
  if (!u || isDemo()) return;
  await withServiceConnection((db) =>
    db.query('insert into public.ai_runs (tenant_id, document_id, model, input_tokens, output_tokens, valid) values ($1, $2, $3, $4, $5, $6)', [tenantId, documentId, u.model, u.inputTokens, u.outputTokens, u.valid]),
  ).catch(() => undefined);
}

export interface FindingDraftOutcome {
  title: string;
  observation: string;
  assessment: string;
  corrections: string[];
  uncertain: string[];
  engine: 'ai' | 'basic';
  notice: string | null;
}

/** The photos sent to the model: smaller copies (1024 pixels), made from the cleaned stored photos. Never logged. */
async function photosForAi(storage: DocumentStorage, paths: string[]): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const p of paths) {
    const bytes = await storage.get(p);
    if (!bytes) continue;
    const copy = await printCopy(bytes, 1024);
    out.push(Buffer.from(copy.src.slice(copy.src.indexOf(',') + 1), 'base64'));
  }
  return out;
}

// ---------------------------------------------------------------- the functions the screens call

const SESSION_ACTOR = (s: Session): Actor => ({ tenantId: s.tenantId, userId: s.userId });

function aiOn(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export async function getSurveyContext(): Promise<SurveyContext> {
  const s = await requireSession();
  const today = todayLondon();
  if (isDemo()) {
    const st = demo();
    const used = [...st.jobs.map((j) => j.reference), 'DEMO-3003', 'DEMO-3002', 'DEMO-3001'];
    return {
      customers: (await listCustomers()).map((c) => ({ id: c.id, name: c.name, addressLine: c.addressLines[0] ?? '', postcode: c.postcode })),
      jobs: st.jobs.filter((j) => !st.surveys.some((x) => x.jobId === j.jobId)).map((j) => ({ id: j.jobId, reference: j.reference, customerId: j.customerId, propertyAddress: j.propertyAddress })),
      suggestedNumber: suggestNextNumber(['DEMO-4000', ...used]),
      today,
      preparedBy: s.fullName,
      aiOn: false,
    };
  }
  const client = await ownerClient();
  const [custs, jobs, docs, numbers] = await Promise.all([
    client.from('customers').select('id, name, postcode, address_lines').order('last_activity_at', { ascending: false }).limit(500),
    client.from('jobs').select('id, reference, customer_id, property_address').order('created_at', { ascending: false }).limit(300),
    client.from('documents').select('job_id').eq('type', 'survey_report').limit(1000),
    client.from('used_numbers').select('number').order('created_at', { ascending: false }).limit(200),
  ]);
  if (custs.error || jobs.error || docs.error || numbers.error) throw new SurveyError('failed', 'Could not load your customers and jobs.');
  const surveyed = new Set(((docs.data ?? []) as { job_id: string }[]).map((d) => d.job_id));
  return {
    customers: ((custs.data ?? []) as { id: string; name: string; postcode: string | null; address_lines: string[] | null }[]).map((c) => ({ id: c.id, name: c.name, postcode: c.postcode ?? '', addressLine: c.address_lines?.[0] ?? '' })),
    jobs: ((jobs.data ?? []) as { id: string; reference: string; customer_id: string; property_address: string | null }[])
      .filter((j) => !surveyed.has(j.id))
      .map((j) => ({ id: j.id, reference: j.reference, customerId: j.customer_id, propertyAddress: j.property_address ?? '' })),
    suggestedNumber: suggestNextNumber(((numbers.data ?? []) as { number: string }[]).map((r) => r.number)),
    today,
    preparedBy: s.fullName,
    aiOn: aiOn(),
  };
}

export async function getSurveyDraft(documentId: string): Promise<SurveyDraft | null> {
  const s = await requireSession();
  if (!isKnownId(documentId)) return null;
  if (isDemo()) {
    const row = demo().surveys.find((x) => x.id === documentId);
    if (!row) return null;
    const job = demo().jobs.find((j) => j.jobId === row.jobId);
    return {
      documentId: row.id,
      jobId: row.jobId,
      number: row.number,
      jobReference: job?.reference ?? '',
      customerId: row.customerId,
      customerName: await demoCustomerName(row.customerId),
      status: row.status,
      values: structuredClone(row.values),
      photos: [...demo().photos.values()].filter((p) => p.jobId === row.jobId).map((p) => ({ id: p.id, width: p.width, height: p.height })),
    };
  }
  if (!isRealId(documentId)) return null;
  return withServiceConnection(async (db) => {
    const d = await db.query(
      `select d.id, d.job_id, d.number, d.status::text as status, j.customer_id, j.reference, c.name
         from public.documents d join public.jobs j on j.id = d.job_id and j.tenant_id = d.tenant_id
         join public.customers c on c.id = j.customer_id and c.tenant_id = j.tenant_id
        where d.id = $1 and d.tenant_id = $2 and d.type = 'survey_report'`,
      [documentId, s.tenantId],
    );
    const r = d.rows[0];
    if (!r) return null;
    const v = await db.query(`select input from public.document_versions where document_id = $1 and tenant_id = $2 order by version desc limit 1`, [documentId, s.tenantId]);
    const values = parseSurveyInput(v.rows[0]?.input) ?? emptySurvey({ surveyDate: todayLondon(), preparedBy: s.fullName });
    const p = await db.query(`select id, width, height from public.job_photos where job_id = $1 and tenant_id = $2 order by created_at, id`, [r.job_id, s.tenantId]);
    return {
      documentId: String(r.id),
      jobId: String(r.job_id),
      number: String(r.number),
      jobReference: String(r.reference),
      customerId: String(r.customer_id),
      customerName: String(r.name),
      status: r.status === 'draft' ? 'draft' : 'final',
      values,
      photos: p.rows.map((x) => ({ id: String(x.id), width: Number(x.width) || 0, height: Number(x.height) || 0 })),
    };
  });
}

export async function saveSurvey(req: SaveSurveyRequest): Promise<SavedSurvey> {
  const s = await requireSession();
  if (isDemo()) return demoSave(req);
  return withServiceConnection((db) => retryDeadlock(() => saveSurveyWith(db, SESSION_ACTOR(s), req, todayLondon())));
}

export async function approveSurveyPart(documentId: string, values: SurveyFormValues, part: ApprovePart): Promise<SavedSurvey> {
  const s = await requireSession();
  if (isDemo()) return demoApprove(documentId, values, part);
  if (!isRealId(documentId)) throw new SurveyError('not_found', 'That survey could not be found.');
  return withServiceConnection((db) => retryDeadlock(() => approveSurveyPartWith(db, SESSION_ACTOR(s), documentId, values, part)));
}

/** Sixty photo uploads per person in ten minutes. Per process. */
const uploadLimiter = createRateLimiter(60, 10 * 60_000);

/** One upload counted against the person's limit. The upload route asks this before it reads the body. */
export function takeUploadPermit(userId: string): boolean {
  return uploadLimiter.take(userId);
}
export const UPLOAD_LIMITED = 'You have added a lot of photos in the last few minutes. Wait a little, then try again.';

export async function uploadSurveyPhoto(documentId: string, findingId: string, raw: Uint8Array): Promise<UploadedPhoto> {
  const s = await requireSession();
  if (isDemo()) return demoUpload(documentId, findingId, raw);
  if (!isRealId(documentId)) throw new SurveyError('not_found', 'That survey could not be found.');
  return withServiceConnection((db) => uploadSurveyPhotoWith(db, getStorage(), SESSION_ACTOR(s), documentId, findingId, raw));
}

/** The cheap checks for an upload, made before its body is read: the survey, the finding and room for a photo. */
export async function checkSurveyPhotoRoom(documentId: string, findingId: string): Promise<void> {
  const s = await requireSession();
  if (isDemo()) {
    demoRoom(documentId, findingId);
    return;
  }
  if (!isRealId(documentId)) throw new SurveyError('not_found', 'That survey could not be found.');
  await withServiceConnection((db) => photoRoomWith(db, s.tenantId, documentId, findingId, false));
}

export async function readSurveyPhoto(photoId: string): Promise<Buffer | null> {
  const s = await requireSession();
  if (isDemo()) {
    const p = demo().photos.get(photoId);
    return p ? getStorage().get(p.path) : null;
  }
  return withServiceConnection((db) => readSurveyPhotoWith(db, getStorage(), s.tenantId, photoId));
}

export async function deleteSurveyPhoto(documentId: string, photoId: string): Promise<void> {
  const s = await requireSession();
  if (isDemo()) return demoDeletePhoto(documentId, photoId);
  if (!isRealId(documentId)) throw new SurveyError('not_found', 'That survey could not be found.');
  await withServiceConnection((db) => deleteSurveyPhotoWith(db, getStorage(), SESSION_ACTOR(s), documentId, photoId));
}

/** The AI (or the deterministic) draft of one finding. Only the job's own photos are ever read; nothing is saved here. */
export async function draftSurveyFinding(documentId: string, ownerLine: string, photoIds: string[]): Promise<FindingDraftOutcome> {
  const s = await requireSession();
  const line = tidyLine(ownerLine).slice(0, SURVEY_LIMITS.ownerLine);
  const ids = photoIds.slice(0, SURVEY_LIMITS.photosPerFinding);
  let paths: string[] = [];
  if (aiOn() && !isDemo() && isRealId(documentId)) {
    paths = await withServiceConnection(async (db) => {
      const r = await db.query(
        `select p.id, p.storage_path from public.job_photos p join public.documents d on d.job_id = p.job_id and d.tenant_id = p.tenant_id
          where d.id = $1 and d.tenant_id = $2 and d.type = 'survey_report' and p.id = any($3::uuid[])`,
        [documentId, s.tenantId, ids.filter((x) => UUID.test(x))],
      );
      const byId = new Map(r.rows.map((x) => [String(x.id), String(x.storage_path)]));
      return ids.map((id) => byId.get(id)).filter((p): p is string => Boolean(p));
    });
  }
  const photos = paths.length ? await photosForAi(getStorage(), paths) : [];
  const d = await draftFinding({ photos, ownerLine: line }, { permit: () => surveyAiLimiter.take(s.userId) });
  await recordRun(s.tenantId, isRealId(documentId) ? documentId : null, d.usage);
  return { title: d.title, observation: d.observation, assessment: d.assessment, corrections: d.corrections, uncertain: d.uncertain, engine: d.engine, notice: d.notice };
}

export async function draftSurveyOpinion(documentId: string, values: SurveyFormValues): Promise<{ opinion: string; uncertain: string[]; engine: 'ai' | 'basic'; notice: string | null }> {
  const s = await requireSession();
  // Only findings whose approval is on record are given to the AI: the opinion rests on what was signed off.
  const hashes = values.findings.filter(isFindingApproved).map((f) => f.approvalHash as string);
  let audited: Set<string>;
  if (isDemo()) audited = demoSurveyAudited(documentId);
  else if (isRealId(documentId)) audited = await withServiceConnection((db) => auditedSurveyHashesWith(db, s.tenantId, documentId, hashes));
  else audited = new Set();
  const findings = values.findings
    .filter((f) => isFindingApproved(f) && audited.has(f.approvalHash as string))
    .map((f: Finding) => ({ title: tidyLine(f.title), observation: tidyPara(f.observation), assessment: tidyPara(f.assessment) }));
  if (findings.length === 0 && values.findings.length > 0) throw new SurveyError('invalid', 'Approve your findings first. The opinion is drafted from approved findings only.');
  const d = await draftOpinion({ findings, ownerLine: values.conclusionLine }, isDemo() ? { client: null } : { permit: () => surveyAiLimiter.take(s.userId) });
  await recordRun(s.tenantId, isRealId(documentId) ? documentId : null, d.usage);
  return { opinion: d.opinion, uncertain: d.uncertain, engine: d.engine, notice: d.notice };
}

export interface QuoteFromSurveyDeps {
  /** Saves the new draft quote on the job (the owner's own save in the app). */
  save: (form: QuoteFormValues, jobId: string) => Promise<unknown>;
  defaults: () => Promise<{ vatDefault: boolean; depositPctBp: number }>;
  today: string;
}

/**
 * "Create quote from this survey": a draft quote on the same job, for the same customer, with the address from the
 * newest FINALISED version (never a correction still in draft) and the business's "read alongside" wording in the
 * note. If the job already has a quote, that quote is returned instead. Reads on a service connection, filtered by
 * the session's tenant.
 */
export async function startQuoteFromSurveyWith(db: Db, tenantId: string, documentId: string, deps: QuoteFromSurveyDeps): Promise<{ href: string }> {
  if (!UUID.test(documentId)) throw new SurveyError('not_found', 'That survey could not be found.');
  const d = await db.query(
    `select d.id, d.job_id, d.number, j.customer_id, j.reference, td.terms
       from public.documents d join public.jobs j on j.id = d.job_id and j.tenant_id = d.tenant_id
       left join public.tenant_defaults td on td.tenant_id = d.tenant_id
      where d.id = $1 and d.tenant_id = $2 and d.type = 'survey_report'`,
    [documentId, tenantId],
  );
  const r = d.rows[0];
  if (!r) throw new SurveyError('not_found', 'That survey could not be found.');
  const jobId = String(r.job_id);
  const q = await db.query(`select id, status::text as status from public.documents where job_id = $1 and tenant_id = $2 and type = 'quotation'`, [jobId, tenantId]);
  if (q.rows[0]) return { href: q.rows[0].status === 'draft' ? `/documents/new?type=quotation&draft=${jobId}` : `/documents/${q.rows[0].id}` };
  const v = await db.query(
    `select v.input from public.document_versions v where v.document_id = $1 and v.tenant_id = $2 and v.finalised_at is not null order by v.version desc limit 1`,
    [documentId, tenantId],
  );
  const issued = v.rows[0] ? parseSurveyInput(v.rows[0].input) : null;
  if (!issued) throw new SurveyError('invalid', 'Finalise the survey report first, then make the quote from it.');
  const wording = tenantWordingSchema.safeParse(r.terms);
  const link = quoteLinkLine(wording.success ? wording.data.survey : null, String(r.number));
  const defaults = await deps.defaults();
  const form = emptyQuoteForm({ date: deps.today, vatApplies: defaults.vatDefault, depositPctBp: defaults.depositPctBp, quoteNumber: String(r.reference) });
  form.customerId = String(r.customer_id);
  form.propertyAddress = tidyPara(issued.propertyAddress).replace(/\n+/g, ', ');
  if (link) form.scope = { ...form.scope, note: link };
  await deps.save(form, jobId);
  return { href: `/documents/new?type=quotation&draft=${jobId}&from=survey` };
}

export async function startQuoteFromSurvey(documentId: string): Promise<{ href: string }> {
  const s = await requireSession();
  if (isDemo()) return demoStartQuote(documentId);
  if (!isRealId(documentId)) throw new SurveyError('not_found', 'That survey could not be found.');
  return withServiceConnection((db) =>
    startQuoteFromSurveyWith(db, s.tenantId, documentId, {
      save: (form, jobId) => saveQuoteDraft(form, jobId),
      defaults: async () => getQuoteDefaultsWith(await ownerClient()),
      today: todayLondon(),
    }),
  );
}

async function retryDeadlock<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { code?: string }).code === '40P01') return fn();
    throw e;
  }
}

export { PhotoError };

// ================================================================ demo mode (in memory, dummy data)

interface DemoSurvey {
  id: string;
  jobId: string;
  customerId: string;
  number: string;
  status: 'draft' | 'final';
  values: SurveyFormValues;
  createdAt: string;
  customerName: string;
  /** The values as last finalised. */
  issued: SurveyFormValues | null;
}
interface DemoJob {
  jobId: string;
  reference: string;
  customerId: string;
  propertyAddress: string;
}
interface DemoPhoto {
  id: string;
  jobId: string;
  path: string;
  sha256: string;
  width: number;
  height: number;
}
interface DemoSurveyState {
  surveys: DemoSurvey[];
  jobs: DemoJob[];
  photos: Map<string, DemoPhoto>;
  /** Fingerprints approved per document: the demo stand-in for the audit rows. */
  audited: Map<string, Set<string>>;
}
const DEMO_SIGNER: Signer = { fullName: demoSession.fullName, role: demoSession.role };
const demoBox = demoSlot<DemoSurveyState>('surveys', () => ({ surveys: [], jobs: [], photos: new Map(), audited: new Map() }));
const demo = () => demoBox.get();

export function resetDemoSurveys(): void {
  demoBox.set(null);
}

async function demoCustomerName(id: string): Promise<string> {
  return (await getCustomer(id))?.name ?? demoCustomers.find((c) => c.id === id)?.name ?? 'Customer';
}

/** For the documents library and the document pages in demo mode. */
export function demoSurveyRows(): readonly DemoSurvey[] {
  return demo().surveys;
}
export function demoSurveyJob(jobId: string): DemoJob | undefined {
  return demo().jobs.find((j) => j.jobId === jobId);
}
export function demoSurveyPhotos(jobId: string): DemoPhoto[] {
  return [...demo().photos.values()].filter((p) => p.jobId === jobId);
}
export function demoSurveyAudited(documentId: string): Set<string> {
  return demo().audited.get(documentId) ?? new Set();
}
export function demoSurveyMarkFinal(documentId: string): void {
  const s = demo().surveys.find((x) => x.id === documentId);
  if (s) {
    s.status = 'final';
    s.issued = structuredClone(s.values);
  }
}

/** Demo: a correction to an issued report, back to draft with every approval taken off. */
export function demoSurveyRevise(documentId: string): boolean {
  const s = demo().surveys.find((x) => x.id === documentId);
  if (!s || s.status !== 'final' || !s.issued) return false;
  s.values = withoutApprovals(structuredClone(s.issued));
  s.status = 'draft';
  return true;
}
export function demoSurveyCustomerName(id: string): Promise<string> {
  return demoCustomerName(id);
}

function demoLock(documentId: string): DemoSurvey {
  const s = demo().surveys.find((x) => x.id === documentId);
  if (!s) throw new SurveyError('not_found', 'That survey could not be found.');
  if (s.status !== 'draft') throw new SurveyError('locked', 'This survey report has been finalised and can no longer be changed.');
  return s;
}

const demoOwn = (jobId: string) => new Set(demoSurveyPhotos(jobId).map((p) => p.id));

async function demoSave(req: SaveSurveyRequest): Promise<SavedSurvey> {
  checkValues(req.values);
  const st = demo();
  if (req.documentId) {
    const s = demoLock(req.documentId);
    s.values = sanitiseIncomingSurvey(keepOwnPhotos(asSigner(req.values, DEMO_SIGNER), demoOwn(s.jobId)), s.values);
    const job = st.jobs.find((j) => j.jobId === s.jobId);
    if (job) job.propertyAddress = tidyPara(s.values.propertyAddress).replace(/\n+/g, ', ');
    return { documentId: s.id, jobId: s.jobId, customerId: s.customerId, number: s.number, jobReference: job?.reference ?? '', savedAt: new Date().toISOString(), values: structuredClone(s.values) };
  }
  if (!req.customer || !req.job) throw new SurveyError('invalid', 'Choose who the survey is for, and the job.', 'customer');
  let customerId: string;
  if (req.customer.kind === 'existing') {
    if (!(await getCustomer(req.customer.id))) throw new SurveyError('invalid', 'That customer could not be found.', 'customer');
    customerId = req.customer.id;
  } else {
    const parsed = customerSchema.safeParse(req.customer.customer);
    if (!parsed.success) throw new SurveyError('invalid', parsed.error.issues[0]?.message ?? 'Check the customer details.', 'customer');
    const { createCustomer } = await import('./customers');
    customerId = (await createCustomer(parsed.data)).id;
  }
  let job: DemoJob;
  if (req.job.kind === 'existing') {
    const j = st.jobs.find((x) => x.jobId === (req.job as { id: string }).id);
    if (!j || j.customerId !== customerId) throw new SurveyError('invalid', 'That job could not be found.', 'job');
    job = j;
  } else {
    const ref = req.job.reference.trim();
    if (!NUMBER_RE.test(ref)) throw new SurveyError('invalid', 'Use 2 to 40 letters, numbers, dots, dashes or slashes, starting with a letter or number', 'jobReference');
    if (quoteNumberReserved(ref) !== null) throw new SurveyError('invalid', NUMBER_SUFFIX_MESSAGE, 'jobReference');
    if (st.jobs.some((j) => j.reference === ref) || ['DEMO-3003', 'DEMO-3002', 'DEMO-3001'].includes(ref)) throw new SurveyError('number_used', 'That job number has already been used. Choose another.', 'jobReference');
    job = { jobId: `demo-sjob-${randomUUID().slice(0, 8)}`, reference: ref, customerId, propertyAddress: tidyPara(req.values.propertyAddress).replace(/\n+/g, ', ') };
    st.jobs.push(job);
  }
  const values = keepOwnPhotos(sanitiseIncomingSurvey(asSigner(req.values, DEMO_SIGNER), null), new Set());
  const s: DemoSurvey = { id: `demo-survey-${randomUUID().slice(0, 8)}`, jobId: job.jobId, customerId, number: `SR-${job.reference}`, status: 'draft', values, createdAt: new Date().toISOString(), customerName: await demoCustomerName(customerId), issued: null };
  st.surveys.unshift(s);
  return { documentId: s.id, jobId: s.jobId, customerId, number: s.number, jobReference: job.reference, savedAt: s.createdAt, values: structuredClone(values) };
}

async function demoApprove(documentId: string, incoming: SurveyFormValues, part: ApprovePart): Promise<SavedSurvey> {
  checkValues(incoming);
  const s = demoLock(documentId);
  if (tidyLine(incoming.signName) !== DEMO_SIGNER.fullName || tidyLine(incoming.preparedBy) !== DEMO_SIGNER.fullName) {
    throw new SurveyError('invalid', `This report is prepared and signed in your own name, ${DEMO_SIGNER.fullName}. Open it again and approve it as yourself.`);
  }
  let values = sanitiseIncomingSurvey(keepOwnPhotos(asSigner(incoming, DEMO_SIGNER), demoOwn(s.jobId)), s.values);
  const at = new Date().toISOString();
  let hash: string;
  if (part.kind === 'finding') {
    const i = values.findings.findIndex((f) => f.id === part.findingId);
    const f = values.findings[i];
    if (!f) throw new SurveyError('not_found', 'That finding could not be found. Save and try again.');
    if (f.photoIds.length === 0) throw new SurveyError('invalid', 'Add at least one photo before you approve this finding.');
    if (!tidyLine(f.title) || !tidyPara(f.observation) || !tidyPara(f.assessment)) throw new SurveyError('invalid', 'Fill in the title, the observation and your assessment before you approve this finding.');
    hash = findingHash(f);
    values = { ...values, findings: values.findings.map((x, k) => (k === i ? { ...x, approvedAt: at, approvalHash: hash } : x)) };
  } else {
    if (!tidyPara(values.opinion)) throw new SurveyError('invalid', 'Write your professional opinion before you approve it.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values.signDate)) throw new SurveyError('invalid', 'Add the date you sign the report before you approve the opinion.');
    hash = opinionHash(values);
    values = { ...values, opinionApprovedAt: at, opinionHash: hash, opinionSignerId: demoSession.userId };
  }
  s.values = values;
  const set = demo().audited.get(documentId) ?? new Set<string>();
  set.add(hash);
  demo().audited.set(documentId, set);
  const job = demoSurveyJob(s.jobId);
  return { documentId: s.id, jobId: s.jobId, customerId: s.customerId, number: s.number, jobReference: job?.reference ?? '', savedAt: at, values: structuredClone(values) };
}

function demoRoom(documentId: string, findingId: string): DemoSurvey {
  const s = demoLock(documentId);
  const f = s.values.findings.find((x) => x.id === findingId);
  if (!f) throw new SurveyError('not_found', 'That finding is not saved yet. Wait a moment and try again.');
  if (f.photoIds.length >= SURVEY_LIMITS.photosPerFinding) throw new SurveyError('limit', `Finding photos are limited to ${SURVEY_LIMITS.photosPerFinding}. Remove one to add another.`);
  const shown = new Set(s.values.findings.flatMap((x) => x.photoIds));
  if (shown.size >= SURVEY_LIMITS.photosPerSurvey) throw new SurveyError('limit', `This report already shows ${SURVEY_LIMITS.photosPerSurvey} photos, the most it can hold.`);
  const ids = demoSurveyPhotos(s.jobId).map((p) => p.id);
  if (ids.length >= PHOTO_ROW_CAP || ids.filter((id) => !shown.has(id)).length >= SURVEY_LIMITS.photosPerFinding) throw new SurveyError('limit', UNUSED_PHOTOS);
  return s;
}

async function demoUpload(documentId: string, findingId: string, raw: Uint8Array): Promise<UploadedPhoto> {
  demoRoom(documentId, findingId);
  const clean = await cleanPhoto(raw);
  const s = demoRoom(documentId, findingId);
  const id = `demo-photo-${randomUUID()}`;
  const path = `demo-tenant/${s.customerId}/${s.jobId}/${id}.jpg`;
  demo().photos.set(id, { id, jobId: s.jobId, path, sha256: clean.sha256, width: clean.width, height: clean.height });
  await getStorage().put(path, clean.bytes, 'image/jpeg');
  return { id, width: clean.width, height: clean.height };
}

async function demoDeletePhoto(documentId: string, photoId: string): Promise<void> {
  const s = demoLock(documentId);
  const p = demo().photos.get(photoId);
  if (!p || p.jobId !== s.jobId) throw new SurveyError('not_found', 'That photo could not be found.');
  if (s.values.findings.some((f) => f.photoIds.includes(photoId))) throw new SurveyError('invalid', 'That photo is still in a finding. Remove it from the finding first.');
  demo().photos.delete(photoId);
  await getStorage().deleteStorageObjects([p.path]).catch(() => undefined);
}

function demoStartQuote(documentId: string): { href: string } {
  const s = demo().surveys.find((x) => x.id === documentId);
  if (!s) throw new SurveyError('not_found', 'That survey could not be found.');
  if (!s.issued) throw new SurveyError('invalid', 'Finalise the survey report first, then make the quote from it.');
  const job = demoSurveyJob(s.jobId);
  if (!job) throw new SurveyError('not_found', 'That survey could not be found.');
  const form = emptyQuoteForm({ date: todayLondon(), vatApplies: true, depositPctBp: 3000, quoteNumber: job.reference });
  form.customerId = s.customerId;
  form.propertyAddress = tidyPara(s.issued.propertyAddress).replace(/\n+/g, ', ');
  const link = quoteLinkLine(FJC_WORDING.survey, s.number);
  if (link) form.scope = { ...form.scope, note: link };
  demoRestoreDraft(s.jobId, form);
  return { href: `/documents/new?type=quotation&draft=${s.jobId}&from=survey` };
}
