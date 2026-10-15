/**
 * Preview, finalise and revise, on a service connection (no app JWT; README "Server code rules").
 *
 * Finalise, in ONE transaction:
 *   1. select the document row FOR UPDATE, then its versions;
 *   2. validate: still a draft, the version the owner read is still the newest, nothing changed since;
 *   3. recompute everything from stored facts: money through money.ts (buildSchedule over the version totals and the
 *      plan inputs, never stored instalments), the quote's approved wording and its audit row;
 *   4. render, check a read token for every page of exactly this content;
 *   5. write the immutable version (money, content without bank numbers, pdf path, finalised time) and the document
 *      row (status, current version, total, pdf path); numbers were claimed when the document was created and are
 *      never claimed again;
 *   6. audit the confirmation and the finalise (ids, counts and the wording version only);
 *   7. store the PDF and page images, then commit. A storage failure rolls everything back.
 * A second submit waits on the row lock and then finds the work done: it returns the same result (idempotent).
 * The caller retries once on deadlock (40P01).
 */
import { auditedApprovalWith } from '../data/scope';
import { writeAudit } from '../../security/audit';
import type { Db } from '../../security/login-guard';
import type { Brand, Tenant } from '../../themes/types';
import { compactId } from '../data/customer-admin';
import { isApproved } from '../scope/model';
import type { DocumentStorage } from '../storage';
import { mapDocument, redactMapped, type DocumentMoney, type Mapped } from './map';
import { loadHeadWith, loadWith, type DocumentHead, type Loaded } from './facts-sql';
import { allPagesRead, contentKey } from './read-proof';
import { confirmationFor } from './confirmation';
import { mapSurvey } from '../survey/map';
import { surveyApprovalProblemsWith } from '../survey/approval-sql';
import { parseSurveyInput } from '../survey/facts-sql';
import { withoutApprovals } from '../survey/model';

/** The issued survey's input with every approval taken off, for its correction. */
function surveyCorrectionInput(input: unknown): unknown {
  const v = parseSurveyInput(input);
  return v ? { schema: 1, survey: withoutApprovals(v) } : (input ?? {});
}

/** Bumped whenever the templates change what a document looks like, so old preview images are never reused. */
export const TEMPLATE_VERSION = 't1';

export interface RenderOut {
  pdf: Buffer;
  pngPages: Buffer[];
}
export type RenderFn = (mapped: Mapped, tenant: Tenant, brand: Brand) => Promise<RenderOut>;

export class DocumentError extends Error {
  constructor(
    readonly code: 'not_found' | 'locked' | 'changed' | 'missing' | 'unread' | 'unconfirmed' | 'not_allowed' | 'failed',
    message: string,
    readonly missing: string[] = [],
  ) {
    super(message);
    this.name = 'DocumentError';
  }
}

export interface Actor {
  tenantId: string;
  userId: string;
}

export type Prepared = { ok: true; mapped: Mapped; money: DocumentMoney; tenant: Tenant; brand: Brand; key: string; mappedJson: string } | { ok: false; missing: string[] };

/** Facts to template input, plus the content key. Adds the checks that need the business (VAT number on a VAT invoice). */
export function prepareLoaded(l: Loaded, secret: string): Prepared {
  const missing = [...l.problems];
  if (l.head.type === 'survey') {
    if (!l.survey || !l.business || !l.brand) return { ok: false, missing: missing.length ? missing : ['This document could not be put together.'] };
    const s = mapSurvey(l.survey, l.business.tenant, l.business.wording?.survey);
    if (!s.ok || missing.length > 0) return { ok: false, missing: [...new Set([...missing, ...(s.ok ? [] : s.missing)])] };
    const mapped: Mapped = { kind: 'survey', input: s.input };
    const json = JSON.stringify(mapped);
    return { ok: true, mapped, money: { netPence: 0, vatPence: 0, grossPence: 0 }, tenant: l.business.tenant, brand: l.brand, key: contentKey(secret, json, TEMPLATE_VERSION), mappedJson: json };
  }
  if (!l.facts || !l.business || !l.brand) return { ok: false, missing: missing.length ? missing : ['This document could not be put together.'] };
  const r = mapDocument(l.facts, l.business);
  if (!r.ok) return { ok: false, missing: [...missing, ...r.missing] };
  if (r.mapped.kind !== 'quotation' && r.mapped.kind !== 'receipt' && r.money.vatPence > 0 && !l.business.tenant.vatNo) {
    missing.push('Your VAT number is not on record, and an invoice that charges VAT must show it. Contact TradesPro Digital to add it.');
  }
  if (missing.length > 0) return { ok: false, missing: [...new Set(missing)] };
  const mappedJson = JSON.stringify(r.mapped);
  return { ok: true, mapped: r.mapped, money: r.money, tenant: l.business.tenant, brand: l.brand, key: contentKey(secret, mappedJson, TEMPLATE_VERSION), mappedJson };
}

/** Where a version's files live: {tenant}/{customer}/{job}/{version}/... (ids only; numbers can hold any character). */
export function versionFolder(tenantId: string, head: Pick<DocumentHead, 'customerId' | 'jobId'>, versionId: string): string {
  return `${tenantId}/${head.customerId}/${head.jobId}/${versionId}`;
}
export const pageFile = (n: number) => `page-${String(n).padStart(2, '0')}.png`;
export const previewFolder = (folder: string, key: string) => `${folder}/preview-${key}`;

export interface PreviewReady {
  versionId: string;
  key: string;
  pageCount: number;
  /** Where the page images are. */
  folder: string;
}

/**
 * Makes (or reuses) the page images of the newest draft version for reading. Images are stored per content key, so
 * a change to the document gives new images and a new key, and the owner must read again.
 */
export async function previewWith(db: Db, storage: DocumentStorage, actor: Actor, documentId: string, deps: { render: RenderFn; secret: string }): Promise<{ ok: true; preview: PreviewReady; loaded: Loaded } | { ok: false; missing: string[]; loaded: Loaded | null }> {
  const loaded = await loadWith(db, actor.tenantId, documentId, { decryptBank: true });
  if (!loaded) throw new DocumentError('not_found', 'That document could not be found.');
  const newest = loaded.head.versions[0];
  if (!newest || newest.finalisedAt) throw new DocumentError('locked', 'This document has already been finalised.');
  const p = prepareLoaded(loaded, deps.secret);
  if (!p.ok) return { ok: false, missing: p.missing, loaded };
  const folder = previewFolder(versionFolder(actor.tenantId, loaded.head, newest.id), p.key);
  const manifest = await storage.get(`${folder}/pages.json`);
  let pageCount = 0;
  if (manifest) {
    const n = Number((JSON.parse(manifest.toString('utf8')) as { pages?: unknown }).pages);
    if (Number.isInteger(n) && n > 0) pageCount = n;
  }
  if (!pageCount) {
    const out = await deps.render(p.mapped, p.tenant, p.brand);
    for (let i = 0; i < out.pngPages.length; i += 1) await storage.put(`${folder}/${pageFile(i + 1)}`, out.pngPages[i], 'image/png', { overwrite: true });
    await storage.put(`${folder}/pages.json`, Buffer.from(JSON.stringify({ pages: out.pngPages.length })), 'application/json', { overwrite: true });
    pageCount = out.pngPages.length;
  }
  return { ok: true, preview: { versionId: newest.id, key: p.key, pageCount, folder }, loaded };
}

export interface FinaliseArgs {
  documentId: string;
  versionId: string;
  key: string;
  tokens: readonly unknown[];
  confirmed: boolean;
  confirmationVersion: string;
}

export interface Finalised {
  documentId: string;
  versionId: string;
  pdfPath: string;
  pages: number;
  /** True when this request found the work already done (a double submit). */
  already: boolean;
}

export async function finaliseWith(
  db: Db,
  storage: DocumentStorage,
  actor: Actor,
  a: FinaliseArgs,
  deps: { render: RenderFn; secret: string },
  o: { nested?: boolean } = {},
): Promise<Finalised> {
  if (a.confirmed !== true) throw new DocumentError('unconfirmed', 'Tick the box to confirm you have checked the document.');
  const nested = o.nested === true;
  await db.query(nested ? 'savepoint finalise_tx' : 'begin');
  try {
    if (!nested) {
      await db.query('reset role');
      await db.query(`select set_config('request.jwt.claims', '', true)`);
    }
    await db.query(`set local statement_timeout = '120s'`);
    const head = await loadHeadWith(db, actor.tenantId, a.documentId, true);
    if (!head) throw new DocumentError('not_found', 'That document could not be found.');
    const newest = head.versions[0];
    if (head.status === 'final' || head.status === 'sent') {
      if (head.currentVersionId === a.versionId && newest?.id === a.versionId && newest.finalisedAt && newest.pdfPath) {
        await db.query(nested ? 'release savepoint finalise_tx' : 'commit');
        const pages = Number((newest.finalContent as { pages?: unknown } | null)?.pages) || 0;
        return { documentId: head.id, versionId: newest.id, pdfPath: newest.pdfPath, pages, already: true };
      }
      throw new DocumentError('locked', 'This document has already been finalised.');
    }
    if (head.status !== 'draft') throw new DocumentError('locked', 'This document cannot be finalised.');
    if (!newest || newest.id !== a.versionId || newest.finalisedAt) throw new DocumentError('changed', 'This document changed after you opened it. Read it again before you confirm.');

    const loaded = await loadWith(db, actor.tenantId, a.documentId, { decryptBank: true, head });
    if (!loaded) throw new DocumentError('not_found', 'That document could not be found.');
    if (confirmationFor(loaded.business?.wording).version !== a.confirmationVersion) throw new DocumentError('changed', 'The confirmation wording has changed. Read it again and tick the box.');
    const p = prepareLoaded(loaded, deps.secret);
    if (!p.ok) throw new DocumentError('missing', 'Some details this document needs are missing.', p.missing);
    if (p.key !== a.key) throw new DocumentError('changed', 'This document changed after you read it. Read it again before you confirm.');

    // A quotation is issued only with wording that was approved on the server, with its audit row (Task 4c).
    if (head.type === 'quotation') {
      const scope = loaded.facts?.quoteForm.scope;
      const hash = scope?.copy?.approvalHash;
      if (!scope || !isApproved(scope) || !hash || !(await auditedApprovalWith(db, actor.tenantId, head.jobId, hash))) {
        throw new DocumentError('missing', 'The wording has not been approved.', ['The scope wording has not been approved. Open the quote, check the wording and approve it.']);
      }
    }

    // A survey report is issued only when every finding and the opinion were approved on the server, with audit rows.
    if (head.type === 'survey') {
      const problems = await surveyApprovalProblemsWith(db, actor.tenantId, head.id, loaded.survey?.form ?? null);
      if (problems.length > 0) throw new DocumentError('missing', 'Some parts of the report have not been approved.', problems);
    }

    const out = await deps.render(p.mapped, p.tenant, p.brand);
    if (!allPagesRead(deps.secret, { tenantId: actor.tenantId, userId: actor.userId, documentId: head.id, versionId: newest.id, key: p.key }, out.pngPages.length, a.tokens)) {
      throw new DocumentError('unread', `Open all ${out.pngPages.length} pages before you confirm.`);
    }

    const folder = versionFolder(actor.tenantId, head, newest.id);
    const pdfPath = `${folder}/document.pdf`;
    const finalContent = { schema: 1, template: TEMPLATE_VERSION, key: p.key, pages: out.pngPages.length, content: redactMapped(p.mapped) };
    await db.query(
      `update public.document_versions set money = $1::jsonb, final_content = $2::jsonb, pdf_path = $3, bank_account_id = coalesce($4, bank_account_id), finalised_at = now()
        where id = $5 and tenant_id = $6`,
      [JSON.stringify(p.money), JSON.stringify(finalContent), pdfPath, p.mapped.kind === 'quotation' || p.mapped.kind === 'receipt' ? null : loaded.bankAccountId, newest.id, actor.tenantId],
    );
    await db.query(
      `update public.documents set status = 'final', current_version_id = $1, total_pence = $2, pdf_path = $3, finalised_at = now() where id = $4 and tenant_id = $5`,
      [newest.id, p.mapped.kind === 'survey' ? null : p.money.grossPence, pdfPath, head.id, actor.tenantId],
    );
    if (head.type === 'quotation') await db.query(`update public.jobs set status = 'quoted' where id = $1 and tenant_id = $2 and status = 'open'`, [head.jobId, actor.tenantId]);

    const ids = { document: compactId(head.id), version: compactId(newest.id) };
    await writeAudit(db, { tenantId: actor.tenantId, userId: actor.userId, action: 'document.confirm', entity: 'document', entityId: ids.document, meta: { version: ids.version, pages: out.pngPages.length, wording: a.confirmationVersion } });
    await writeAudit(db, { tenantId: actor.tenantId, userId: actor.userId, action: 'document.finalise', entity: 'document', entityId: ids.document, meta: { version: ids.version, type: head.type, n: newest.version } });

    // Rows first, then files; a failed upload rolls the rows back. Paths are per version, so a retry overwrites its own leftovers only.
    await storage.put(pdfPath, out.pdf, 'application/pdf', { overwrite: true });
    for (let i = 0; i < out.pngPages.length; i += 1) await storage.put(`${folder}/${pageFile(i + 1)}`, out.pngPages[i], 'image/png', { overwrite: true });

    await db.query(nested ? 'release savepoint finalise_tx' : 'commit');
    return { documentId: head.id, versionId: newest.id, pdfPath, pages: out.pngPages.length, already: false };
  } catch (e) {
    await db.query(nested ? 'rollback to savepoint finalise_tx' : 'rollback').catch(() => undefined);
    throw e;
  }
}

/** Runs fn again once if Postgres reports a deadlock (40P01). */
export async function retryOnDeadlock<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { code?: string }).code === '40P01') return fn();
    throw e;
  }
}

/**
 * Changing an issued quote: a new draft version, a copy of the issued one, which must be read and ticked again. The
 * issued versions never change. Refused once the job has any invoice or receipt: those were worked out from the
 * issued quote, and Phase 1 has no void.
 */
export async function reviseWith(db: Db, actor: Actor, documentId: string, o: { nested?: boolean } = {}): Promise<{ jobId: string; versionId: string }> {
  const nested = o.nested === true;
  await db.query(nested ? 'savepoint revise_tx' : 'begin');
  try {
    if (!nested) {
      await db.query('reset role');
      await db.query(`select set_config('request.jwt.claims', '', true)`);
    }
    const head = await loadHeadWith(db, actor.tenantId, documentId, true);
    if (!head) throw new DocumentError('not_found', 'That document could not be found.');
    if (head.type !== 'quotation' && head.type !== 'survey') throw new DocumentError('not_allowed', 'Only a quotation or a survey report can be changed after it is finalised. Invoices and receipts follow the quote and the payments.');
    if (head.status === 'draft') {
      await db.query(nested ? 'release savepoint revise_tx' : 'commit');
      return { jobId: head.jobId, versionId: head.versions[0]?.id ?? '' };
    }
    if (head.status !== 'final') throw new DocumentError('locked', 'This document cannot be changed.');
    if (head.type === 'quotation') {
      const others = await db.query(`select count(*)::int as n from public.documents where job_id = $1 and tenant_id = $2 and id <> $3 and type <> 'survey_report'`, [head.jobId, actor.tenantId, head.id]);
      if (Number(others.rows[0]?.n) > 0) throw new DocumentError('not_allowed', 'This quote already has invoices or receipts made from it, so it cannot be changed now.');
    }
    const issued = head.versions[0];
    if (!issued?.finalisedAt) throw new DocumentError('failed', 'This quote could not be changed.');
    const v = await db.query(
      `insert into public.document_versions (tenant_id, document_id, version, input, bank_account_id, created_by) values ($1, $2, $3, $4::jsonb, $5, $6) returning id`,
      // A survey correction starts with every approval taken off: each finding and the opinion are approved again.
      [actor.tenantId, head.id, issued.version + 1, JSON.stringify(head.type === 'survey' ? surveyCorrectionInput(issued.input) : (issued.input ?? {})), issued.bankAccountId, actor.userId],
    );
    const versionId = String(v.rows[0].id);
    await db.query(`update public.documents set status = 'draft', current_version_id = $1, pdf_path = null, finalised_at = null, total_pence = null where id = $2 and tenant_id = $3`, [versionId, head.id, actor.tenantId]);
    if (head.type === 'quotation') await db.query(`update public.jobs set status = 'open' where id = $1 and tenant_id = $2 and status = 'quoted'`, [head.jobId, actor.tenantId]);
    await writeAudit(db, { tenantId: actor.tenantId, userId: actor.userId, action: 'document.revise', entity: 'document', entityId: compactId(head.id), meta: { version: compactId(versionId), n: issued.version + 1 } });
    await db.query(nested ? 'release savepoint revise_tx' : 'commit');
    return { jobId: head.jobId, versionId };
  } catch (e) {
    await db.query(nested ? 'rollback to savepoint revise_tx' : 'rollback').catch(() => undefined);
    throw e;
  }
}
