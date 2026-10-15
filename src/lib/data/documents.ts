/**
 * The Documents library and one document's pages: what the screens and routes call.
 *
 * Every function starts from the session (tenant and person come from it, never from the browser). The library reads
 * through the owner's session (row level security). Preview, finalise, download and revise run on a service
 * connection with every query filtered by the session's tenant (src/lib/documents/*). Demo mode keeps it all in memory.
 */
import 'server-only';
import { demoBusiness, demoCustomers, demoQuoteDefaults } from '../demo-data';
import { demoSlot, isDemo } from '../demo';
import type { CoveringEmailFacts, EmailDocKind } from '../covering-email';
import { confirmationFor, type Confirmation } from '../documents/confirmation';
import { loadHeadWith, loadWith, type DocumentHead, type Loaded } from '../documents/facts-sql';
import { DocumentError, finaliseWith, pageFile, prepareLoaded, previewWith, retryOnDeadlock, reviseWith, versionFolder, previewFolder, type FinaliseArgs, type Finalised, type RenderFn } from '../documents/finalise';
import { mapDocument, type BusinessFacts, type DocumentFacts, type Mapped } from '../documents/map';
import { allPagesRead, proofSecret, readToken } from '../documents/read-proof';
import { demoRenderBrand } from '../documents/render-brand';
import { summarise, type SummarySection } from '../documents/summary';
import { buildJobBilling, followOnFor, instalmentHeading, type RawDocument } from '../job-billing';
import { docTypeFromDb, isInvoiceType, type DocStatus, type DocType } from '../job-stage';
import { normaliseQuote, type QuoteFormValues } from '../validation/quote';
import { requireSession, type Session } from '../session';
import { getStorage, type DocumentStorage } from '../storage';
import { isApproved } from '../scope/model';
import { demoBillingState, demoIssueQuote, demoMarkFinal, demoUnissueQuote } from './billing';
import { demoSurveyAudited, demoSurveyJob, demoSurveyMarkFinal, demoSurveyPhotos, demoSurveyRevise, demoSurveyRows } from './surveys';
import { surveyEditHref, surveyEditStep, surveyNotes, surveySummary } from '../survey/page';
import { isFindingApproved, isOpinionApproved } from '../survey/model';
import { withServiceConnection } from './customer-admin';
import { ownerClient, type DataClient } from './customers';
import { demoDraftRows, demoRemoveDraft, demoRestoreDraft, isKnownId, isRealId } from './quotes';

export { DocumentError } from '../documents/finalise';

// ---------------------------------------------------------------- library

export type LibraryKind = 'quotation' | 'invoice' | 'receipt' | 'guarantee' | 'survey';
export const LIBRARY_KINDS: { key: LibraryKind; label: string }[] = [
  { key: 'quotation', label: 'Quotes' },
  { key: 'invoice', label: 'Invoices' },
  { key: 'receipt', label: 'Receipts' },
  { key: 'guarantee', label: 'Guarantees' },
  { key: 'survey', label: 'Surveys' },
];
export const kindOf = (t: DocType): LibraryKind => (t === 'quotation' ? 'quotation' : isInvoiceType(t) ? 'invoice' : t === 'receipt' ? 'receipt' : t === 'guarantee' ? 'guarantee' : 'survey');

export interface LibraryItem {
  id: string;
  type: DocType;
  number: string;
  status: 'draft' | 'final';
  /** yyyy-mm-dd */
  date: string;
  customerName: string;
  jobId: string;
  quoteNumber: string;
  totalPence: number | null;
  createdAt: string;
}

export interface LibraryGroup {
  quoteNumber: string;
  customerName: string;
  jobId: string;
  items: LibraryItem[];
}

export interface LibraryFilter {
  kind?: LibraryKind | null;
  status?: 'draft' | 'final' | null;
  q?: string | null;
}

const statusOf = (s: string): 'draft' | 'final' => (s === 'draft' ? 'draft' : 'final');

/** Filters, then groups by job (quote number), newest activity first. Pure. */
export function groupLibrary(items: LibraryItem[], f: LibraryFilter = {}): LibraryGroup[] {
  const q = (f.q ?? '').trim().toLowerCase();
  const hit = items.filter(
    (i) =>
      (!f.kind || kindOf(i.type) === f.kind) &&
      (!f.status || i.status === f.status) &&
      (q === '' || i.quoteNumber.toLowerCase().includes(q) || i.number.toLowerCase().includes(q) || i.customerName.toLowerCase().includes(q)),
  );
  const groups = new Map<string, LibraryGroup>();
  for (const i of [...hit].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.date.localeCompare(a.date))) {
    const g = groups.get(i.jobId) ?? { quoteNumber: i.quoteNumber, customerName: i.customerName, jobId: i.jobId, items: [] };
    g.items.push(i);
    groups.set(i.jobId, g);
  }
  // Inside a job: the quote first, then by number, so invoices and receipts read in order.
  const rank = (t: DocType) => ['survey', 'quotation', 'deposit-invoice', 'invoice-full', 'invoice-stage', 'balance-invoice', 'receipt', 'guarantee'].indexOf(t);
  for (const g of groups.values()) g.items.sort((a, b) => rank(a.type) - rank(b.type) || a.number.localeCompare(b.number, 'en', { numeric: true }));
  return [...groups.values()];
}

export async function listLibraryWith(client: DataClient): Promise<LibraryItem[]> {
  const d = await client.from('documents').select('id, job_id, type, number, status, doc_date, total_pence, created_at').order('created_at', { ascending: false }).limit(500);
  if (d.error) throw new DocumentError('failed', 'Could not load your documents');
  const rows = (d.data ?? []) as { id: string; job_id: string; type: string; number: string; status: string; doc_date: string; total_pence: number | null; created_at: string }[];
  if (rows.length === 0) return [];
  const jobIds = [...new Set(rows.map((r) => r.job_id))];
  const j = await client.from('jobs').select('id, reference, customer_id').in('id', jobIds);
  if (j.error) throw new DocumentError('failed', 'Could not load your documents');
  const jobs = new Map(((j.data ?? []) as { id: string; reference: string; customer_id: string }[]).map((x) => [x.id, x]));
  const c = await client.from('customers').select('id, name').in('id', [...new Set([...jobs.values()].map((x) => x.customer_id))]);
  if (c.error) throw new DocumentError('failed', 'Could not load your documents');
  const names = new Map(((c.data ?? []) as { id: string; name: string }[]).map((x) => [x.id, x.name]));
  return rows.flatMap((r) => {
    const type = docTypeFromDb(r.type);
    const job = jobs.get(r.job_id);
    if (!type || !job) return [];
    return [{ id: r.id, type, number: r.number, status: statusOf(r.status), date: String(r.doc_date).slice(0, 10), customerName: names.get(job.customer_id) ?? 'Customer', jobId: r.job_id, quoteNumber: job.reference, totalPence: r.total_pence === null ? null : Number(r.total_pence), createdAt: String(r.created_at) }];
  });
}

export async function listLibrary(): Promise<LibraryItem[]> {
  await requireSession();
  if (isDemo()) return demoLibrary();
  return listLibraryWith(await ownerClient());
}

// ---------------------------------------------------------------- one document

export interface EarlierVersion {
  versionId: string;
  version: number;
  finalisedAt: string;
}

export interface DocumentPage {
  id: string;
  type: DocType;
  number: string;
  status: 'draft' | 'final';
  date: string;
  quoteNumber: string;
  jobId: string;
  customerId: string;
  customerName: string;
  /** The version shown: the newest draft, or the issued one. */
  versionId: string | null;
  version: number;
  finalisedAt: string | null;
  /** Pages of the issued PDF (final only). */
  pages: number;
  summary: SummarySection[];
  /** Earlier issued versions (a quote changed after it was issued). Newest first, the current one excluded. */
  earlier: EarlierVersion[];
  /** Where Edit goes for a draft quote, or null. */
  editHref: string | null;
  /** For a final quote: whether "Change this quote" is allowed, and why not. */
  revise: { allowed: boolean; reason: string | null } | null;
  /** For the covering email (final only). */
  email: CoveringEmailFacts | null;
  /** The quote's wording notes from the scope step (quotation only). */
  corrections: string[];
  uncertain: string[];
  /** This quote is a new version of one already issued. */
  isRevision: boolean;
  /** Survey reports: the job's quote, if there is one (for "Create quote from this survey"). */
  survey?: { quote: { id: string; status: 'draft' | 'final' } | null };
}

function emailKind(t: DocType): EmailDocKind | null {
  return t === 'guarantee' || t === 'survey' ? null : t;
}

/** The step the stepper should open at: the first one with something missing, else the review. */
export function editStepFor(form: QuoteFormValues, vatRateBp: number): string {
  const { errors } = normaliseQuote(form, 'final', vatRateBp);
  const order = ['customer', 'job', 'scope', 'price', 'plan', 'review'];
  const keys = Object.keys(errors);
  const step = (k: string) => (k === 'customerId' ? 'customer' : ['quoteNumber', 'date', 'jobTypeId', 'propertyAddress'].includes(k) ? 'job' : k.startsWith('scope') ? 'scope' : k === 'price' || k === 'discount' || k.startsWith('extras') ? 'price' : k.startsWith('plan') ? 'plan' : 'review');
  if (!isApproved(form.scope)) keys.push('scope');
  const first = keys.map(step).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0];
  return first ?? 'review';
}

function surveyPageFrom(l: Loaded, quote: { id: string; status: 'draft' | 'final' } | null): DocumentPage {
  const h = l.head;
  const status = statusOf(h.status);
  const newest = h.versions[0];
  const shown = status === 'final' ? (h.versions.find((v) => v.id === h.currentVersionId) ?? newest) : newest;
  const form = l.survey?.form ?? null;
  const notes = surveyNotes(form);
  return {
    id: h.id,
    type: h.type,
    number: h.number,
    status,
    date: h.docDate,
    quoteNumber: h.quoteNumber,
    jobId: h.jobId,
    customerId: h.customerId,
    customerName: l.survey?.customerName || 'Customer',
    versionId: shown?.id ?? null,
    version: shown?.version ?? 1,
    finalisedAt: shown?.finalisedAt ?? null,
    pages: Number((shown?.finalContent as { pages?: unknown } | null)?.pages) || 0,
    summary: surveySummary(form, l.survey?.customerName || 'Customer', h.number),
    earlier: h.versions.filter((v) => v.finalisedAt && v.id !== shown?.id).map((v) => ({ versionId: v.id, version: v.version, finalisedAt: v.finalisedAt as string })),
    editHref: status === 'draft' ? surveyEditHref(h.id, surveyEditStep(form)) : null,
    revise: status === 'final' ? { allowed: true, reason: null } : null,
    email: null,
    corrections: notes.corrections,
    uncertain: notes.uncertain,
    isRevision: status === 'draft' && h.versions.some((v) => v.finalisedAt !== null),
    survey: { quote },
  };
}

function pageFrom(l: Loaded, opts: { otherDocuments: number }): DocumentPage {
  const h = l.head;
  const status = statusOf(h.status);
  const newest = h.versions[0];
  const shown = status === 'final' ? (h.versions.find((v) => v.id === h.currentVersionId) ?? newest) : newest;
  const earlier = h.versions.filter((v) => v.finalisedAt && v.id !== shown?.id).map((v) => ({ versionId: v.id, version: v.version, finalisedAt: v.finalisedAt as string }));
  const f = l.facts;
  const b = l.business;
  const summary = f && b ? summarise(f, b, l.bankLabel) : [];
  const vat = b?.vatRateBp ?? 2000;
  const copy = h.type === 'quotation' ? f?.quoteForm.scope.copy : null;
  const money = shown?.finalisedAt ? (l.head.versions.find((v) => v.id === shown.id) as { finalContent?: unknown } | undefined) : undefined;
  const pages = Number((money?.finalContent as { pages?: unknown } | null)?.pages) || 0;
  let email: CoveringEmailFacts | null = null;
  const kind = emailKind(h.type);
  if (status === 'final' && kind && f && b) {
    const mapped = mapDocument(f, b);
    let amount: number | null = null;
    let partLabel: string | undefined;
    if (mapped.ok) amount = mapped.money.grossPence;
    if (h.type !== 'quotation' && f.plan && f.followOn) {
      const bl = buildJobBilling({ quoteNumber: f.quoteNumber, plan: f.plan, form: f.quoteForm, vatRateBp: vat, documents: f.documents, payments: f.payments });
      if (bl.ok && bl.billing.kind === 'deposit') partLabel = f.followOn.instalment === 1 ? 'the deposit' : 'the balance';
      else if (bl.ok && bl.billing.kind === 'staged') partLabel = instalmentHeading(bl.billing, f.followOn.instalment);
      if (bl.ok && amount === null) {
        const r = followOnFor(bl.billing, h.type, f.followOn.instalment, f.followOn.paymentId);
        if (r.ok) amount = r.followOn.grossPence;
      }
    }
    email = {
      kind,
      number: h.number,
      customerName: f.customer.name,
      businessName: b.tenant.name,
      ownerName: b.tenant.ownerName,
      property: h.type === 'quotation' ? (f.propertyAddress || undefined) : undefined,
      amountPence: amount,
      validityDays: h.type === 'quotation' ? b.validityDays : null,
      quoteRef: h.type === 'quotation' ? undefined : f.quoteNumber,
      partLabel,
    };
  }
  return {
    id: h.id,
    type: h.type,
    number: h.number,
    status,
    date: h.docDate,
    quoteNumber: h.quoteNumber,
    jobId: h.jobId,
    customerId: h.customerId,
    customerName: f?.customer.name ?? 'Customer',
    versionId: shown?.id ?? null,
    version: shown?.version ?? 1,
    finalisedAt: shown?.finalisedAt ?? null,
    pages,
    summary,
    earlier,
    editHref: h.type === 'quotation' && status === 'draft' ? `/documents/new?type=quotation&draft=${encodeURIComponent(h.jobId)}${f ? `&step=${editStepFor(f.quoteForm, vat)}` : ''}` : null,
    revise: h.type === 'quotation' && status === 'final' ? (opts.otherDocuments > 0 ? { allowed: false, reason: 'This quote already has invoices or receipts made from it, so it cannot be changed now.' } : { allowed: true, reason: null }) : null,
    email,
    corrections: copy?.corrections ?? [],
    uncertain: copy?.uncertain ?? [],
    isRevision: status === 'draft' && h.versions.some((v) => v.finalisedAt !== null),
  };
}

export async function getDocumentPage(id: string): Promise<DocumentPage | null> {
  const s = await requireSession();
  if (!isKnownId(id)) return null;
  if (isDemo()) {
    const l = demoLoad(id);
    if (l?.head.type === 'survey') return surveyPageFrom(l, demoQuoteOfJob(l.head.jobId));
    return l ? pageFrom(l, { otherDocuments: demoOtherDocs(l.head) }) : null;
  }
  if (!isRealId(id)) return null;
  return withServiceConnection(async (db) => {
    const l = await loadWith(db, s.tenantId, id);
    if (!l) return null;
    if (l.head.type === 'survey') {
      const q = await db.query(`select id, status::text as status from public.documents where job_id = $1 and tenant_id = $2 and type = 'quotation'`, [l.head.jobId, s.tenantId]);
      return surveyPageFrom(l, q.rows[0] ? { id: String(q.rows[0].id), status: statusOf(String(q.rows[0].status)) } : null);
    }
    const others = await db.query(`select count(*)::int as n from public.documents where job_id = $1 and tenant_id = $2 and id <> $3`, [l.head.jobId, s.tenantId, id]);
    return pageFrom(l, { otherDocuments: Number(others.rows[0]?.n ?? 0) });
  });
}

// ---------------------------------------------------------------- preview (read the pages)

export type PreviewState =
  | { state: 'missing'; missing: string[] }
  | { state: 'final' }
  | { state: 'ready'; versionId: string; key: string; pageCount: number; confirmation: Confirmation };

async function render(): Promise<RenderFn> {
  const { renderMapped } = await import('../render-service');
  return (m, t, b) => renderMapped(m, t, b);
}

export async function getPreview(id: string): Promise<PreviewState | null> {
  const s = await requireSession();
  if (!isKnownId(id)) return null;
  const secret = proofSecret(isDemo());
  if (isDemo()) return demoPreview(id, secret);
  if (!isRealId(id)) return null;
  const r = await render();
  return withServiceConnection(async (db) => {
    const head = await loadHeadWith(db, s.tenantId, id);
    if (!head) return null;
    if (head.status !== 'draft') return { state: 'final' } as const;
    const res = await previewWith(db, getStorage(), { tenantId: s.tenantId, userId: s.userId }, id, { render: r, secret });
    if (!res.ok) return { state: 'missing', missing: res.missing } as const;
    return { state: 'ready', versionId: res.preview.versionId, key: res.preview.key, pageCount: res.preview.pageCount, confirmation: confirmationFor(res.loaded.business?.wording) } as const;
  });
}

export type PageImage = { bytes: Buffer; token: string | null } | null;

/**
 * One page image. For a draft: a page of the preview made for content key `key`, with the read token for this person.
 * For a final document: a page of the issued version (no token; nothing to confirm).
 */
export async function getPageImage(id: string, page: number, key: string | null): Promise<PageImage> {
  const s = await requireSession();
  if (!isKnownId(id) || !Number.isInteger(page) || page < 1 || page > 200) return null;
  if (key !== null && !/^[0-9a-f]{32}$/.test(key)) return null;
  const storage = getStorage();
  const secret = proofSecret(isDemo());
  let head: DocumentHead | null;
  if (isDemo()) head = demoLoad(id)?.head ?? null;
  else if (!isRealId(id)) return null;
  else head = await withServiceConnection((db) => loadHeadWith(db, s.tenantId, id));
  if (!head) return null;
  const tenantId = isDemo() ? 'demo-tenant' : s.tenantId;
  if (key !== null) {
    const newest = head.versions[0];
    if (head.status !== 'draft' || !newest || newest.finalisedAt) return null;
    const bytes = await storage.get(`${previewFolder(versionFolder(tenantId, head, newest.id), key)}/${pageFile(page)}`);
    if (!bytes) return null;
    return { bytes, token: readToken(secret, { tenantId, userId: s.userId, documentId: head.id, versionId: newest.id, key }, page) };
  }
  if (head.status === 'draft') return null;
  if (isDemo()) await demoEnsureFinalFiles(head);
  const v = head.versions.find((x) => x.id === head.currentVersionId) ?? head.versions[0];
  if (!v?.finalisedAt) return null;
  const bytes = await storage.get(`${versionFolder(tenantId, head, v.id)}/${pageFile(page)}`);
  return bytes ? { bytes, token: null } : null;
}

// ---------------------------------------------------------------- finalise

export interface FinaliseBody {
  versionId: string;
  key: string;
  tokens: string[];
  confirmed: boolean;
  confirmationVersion: string;
}

export async function finaliseDocument(id: string, body: FinaliseBody): Promise<Finalised> {
  const s = await requireSession();
  if (!isKnownId(id) || !isKnownId(body.versionId)) throw new DocumentError('not_found', 'That document could not be found.');
  const secret = proofSecret(isDemo());
  const args: FinaliseArgs = { documentId: id, versionId: body.versionId, key: body.key, tokens: body.tokens, confirmed: body.confirmed, confirmationVersion: body.confirmationVersion };
  if (isDemo()) return demoFinalise(s, args, secret);
  if (!isRealId(id)) throw new DocumentError('not_found', 'That document could not be found.');
  const r = await render();
  return retryOnDeadlock(() => withServiceConnection((db) => finaliseWith(db, getStorage(), { tenantId: s.tenantId, userId: s.userId }, args, { render: r, secret })));
}

// ---------------------------------------------------------------- download

export interface PdfFile {
  bytes: Buffer;
  filename: string;
}

/** A finalised version's PDF. Drafts are never downloadable. versionId picks an earlier issued version. */
export async function getPdf(id: string, versionId: string | null): Promise<PdfFile | null> {
  const s = await requireSession();
  if (!isKnownId(id) || (versionId !== null && !isKnownId(versionId))) return null;
  let head: DocumentHead | null;
  if (isDemo()) head = demoLoad(id)?.head ?? null;
  else if (!isRealId(id)) return null;
  else head = await withServiceConnection((db) => loadHeadWith(db, s.tenantId, id));
  if (!head) return null;
  if (isDemo() && head.status !== 'draft') await demoEnsureFinalFiles(head);
  const wanted = versionId ?? (head.status === 'draft' ? null : head.currentVersionId);
  const v = head.versions.find((x) => x.id === wanted);
  if (!v || !v.finalisedAt || !v.pdfPath) return null;
  if (versionId === null && head.status === 'draft') return null;
  const bytes = await getStorage().get(v.pdfPath);
  if (!bytes) return null;
  const isCurrent = v.id === head.currentVersionId && head.status !== 'draft';
  return { bytes, filename: pdfFilename(head.number, isCurrent ? null : v.version) };
}

/** "INV-FJC1001-D.pdf"; characters a file name cannot carry become hyphens. */
export function pdfFilename(number: string, version: number | null): string {
  const base = number.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80) || 'document';
  return `${base}${version ? `-v${version}` : ''}.pdf`;
}

// ---------------------------------------------------------------- the render seam's loader

/** For renderDocument(versionId): the facts of the document that version belongs to, in this business only. */
export async function prepareVersion(tenantId: string, versionId: string): Promise<{ ok: true; mapped: Mapped; tenant: BusinessFacts['tenant']; brand: NonNullable<Loaded['brand']> } | { ok: false; missing: string[] }> {
  const secret = proofSecret(isDemo());
  if (isDemo()) {
    const ref = demoRefs().find((r) => demoLoad(r.id)?.head.versions.some((v) => v.id === versionId));
    const l = ref ? demoLoad(ref.id) : null;
    if (!l) return { ok: false, missing: ['That document could not be found.'] };
    const p = prepareLoaded(l, secret);
    return p.ok ? { ok: true, mapped: p.mapped, tenant: p.tenant, brand: p.brand } : p;
  }
  if (!isRealId(versionId)) return { ok: false, missing: ['That document could not be found.'] };
  return withServiceConnection(async (db) => {
    const { documentOfVersionWith } = await import('../documents/facts-sql');
    const docId = await documentOfVersionWith(db, tenantId, versionId);
    const l = docId ? await loadWith(db, tenantId, docId, { decryptBank: true }) : null;
    if (!l || !l.head.versions.some((v) => v.id === versionId)) return { ok: false, missing: ['That document could not be found.'] };
    const p = prepareLoaded(l, secret);
    return p.ok ? { ok: true, mapped: p.mapped, tenant: p.tenant, brand: p.brand } : p;
  });
}

// ---------------------------------------------------------------- change an issued quote

export async function reviseDocument(id: string): Promise<{ jobId: string }> {
  const s = await requireSession();
  if (!isKnownId(id)) throw new DocumentError('not_found', 'That document could not be found.');
  if (isDemo()) return demoRevise(id);
  if (!isRealId(id)) throw new DocumentError('not_found', 'That document could not be found.');
  const r = await retryOnDeadlock(() => withServiceConnection((db) => reviseWith(db, { tenantId: s.tenantId, userId: s.userId }, id)));
  return { jobId: r.jobId };
}

/** Which document is the quote of a job, for links from the Home "saved" notice. */
export async function quoteDocumentIdFor(reference: string): Promise<string | null> {
  await requireSession();
  if (isDemo()) {
    const d = demoDraftRows().find((r) => r.values.quoteNumber === reference);
    if (d) return `demo-doc-${d.jobId}`;
    for (const [, docs] of demoBillingState().documents) {
      const q = docs.find((x) => x.type === 'quotation' && x.number === reference);
      if (q) return q.id;
    }
    return null;
  }
  const client = await ownerClient();
  const r = await client.from('documents').select('id').eq('type', 'quotation').eq('number', reference).maybeSingle();
  return (r.data as { id?: string } | null)?.id ?? null;
}

// ================================================================ demo mode (in memory, dummy data)

interface DemoFinal {
  versionId: string;
  version: number;
  finalisedAt: string;
  pdfPath: string;
  pages: number;
}
interface DemoDocState {
  /** Issued versions, oldest first. */
  finals: DemoFinal[];
  /** The version number of the draft being worked on (after a change to an issued quote). */
  draftVersion: number;
}
const demoDocs = demoSlot<Map<string, DemoDocState>>('documents', () => new Map()).get();
const docState = (id: string): DemoDocState => {
  let st = demoDocs.get(id);
  if (!st) {
    st = { finals: [], draftVersion: 1 };
    demoDocs.set(id, st);
  }
  return st;
};

/** Test hook. */
export function resetDemoDocuments(): void {
  demoDocs.clear();
}

const demoCustomerFacts = (id: string) => {
  const c = demoCustomers.find((x) => x.id === id);
  return { name: c?.name ?? 'Customer', addressLines: c?.addressLines ?? [], postcode: c?.postcode ?? '', email: c?.email ?? '', phone: c?.phone ?? '' };
};

const demoBusinessFacts = (): BusinessFacts => ({ ...demoBusiness, vatRateBp: demoQuoteDefaults.vatRateBp });

function demoPlanOf(form: QuoteFormValues) {
  return normaliseQuote(form, 'draft', demoQuoteDefaults.vatRateBp).input.plan;
}

interface DemoDocRef {
  id: string;
  jobId: string;
  type: DocType;
  number: string;
  status: DocStatus;
  form: QuoteFormValues;
  customerId: string;
  date: string;
  documents: RawDocument[];
}

function demoRefs(): DemoDocRef[] {
  const out: DemoDocRef[] = [];
  for (const d of demoDraftRows()) {
    out.push({ id: `demo-doc-${d.jobId}`, jobId: d.jobId, type: 'quotation', number: d.values.quoteNumber, status: 'draft', form: d.values, customerId: d.values.customerId, date: d.values.date, documents: [] });
  }
  const st = demoBillingState();
  for (const j of st.jobs) {
    const docs = st.documents.get(j.jobId) ?? [];
    for (const doc of docs) {
      if (out.some((o) => o.id === doc.id)) continue;
      out.push({ id: doc.id, jobId: j.jobId, type: doc.type, number: doc.number, status: doc.status, form: j.form, customerId: j.form.customerId, date: j.form.date, documents: docs });
    }
  }
  return out;
}

function demoLibrary(): LibraryItem[] {
  const surveys: LibraryItem[] = demoSurveyRows().map((r) => ({ id: r.id, type: 'survey', number: r.number, status: r.status, date: r.values.surveyDate || r.createdAt.slice(0, 10), customerName: r.customerName, jobId: r.jobId, quoteNumber: demoSurveyJob(r.jobId)?.reference ?? '', totalPence: null, createdAt: r.createdAt }));
  return [...surveys, ...demoQuoteLibrary()];
}

function demoQuoteOfJob(jobId: string): { id: string; status: 'draft' | 'final' } | null {
  const d = demoDraftRows().find((r) => r.jobId === jobId);
  if (d) return { id: `demo-doc-${jobId}`, status: 'draft' };
  const q = (demoBillingState().documents.get(jobId) ?? []).find((x) => x.type === 'quotation');
  return q ? { id: q.id, status: statusOf(q.status) } : null;
}

function demoSurveyLoad(id: string): Loaded | null {
  const r = demoSurveyRows().find((x) => x.id === id);
  if (!r) return null;
  const st = docState(id);
  const versions = [
    ...(r.status === 'draft' ? [{ id: `demo-ver-${id}-v${st.draftVersion}`, version: st.draftVersion, finalisedAt: null, pdfPath: null, input: { schema: 1, survey: r.values }, finalContent: null, bankAccountId: null }] : []),
    ...[...st.finals].reverse().map((f) => ({ id: f.versionId, version: f.version, finalisedAt: f.finalisedAt, pdfPath: f.pdfPath, input: { schema: 1, survey: r.issued ?? r.values }, finalContent: { pages: f.pages }, bankAccountId: null })),
  ];
  const last = st.finals[st.finals.length - 1];
  const head: DocumentHead = {
    id,
    type: 'survey',
    number: r.number,
    status: r.status,
    docDate: r.values.surveyDate || r.createdAt.slice(0, 10),
    jobId: r.jobId,
    customerId: r.customerId,
    quoteNumber: demoSurveyJob(r.jobId)?.reference ?? '',
    currentVersionId: r.status === 'draft' ? (versions[0]?.id ?? null) : (last?.versionId ?? null),
    pdfPath: r.status === 'draft' ? null : (last?.pdfPath ?? null),
    finalisedAt: r.status === 'draft' ? null : (last?.finalisedAt ?? null),
    versions,
  };
  const photos = Object.fromEntries(demoSurveyPhotos(r.jobId).map((p) => [p.id, { id: p.id, path: p.path, sha256: p.sha256, width: p.width, height: p.height }]));
  return { head, facts: null, problems: [], business: demoBusinessFacts(), brand: demoRenderBrand(), bankLabel: null, bankAccountId: null, survey: { number: r.number, jobReference: head.quoteNumber, customerName: r.customerName, form: structuredClone(r.values), photos } };
}

function demoQuoteLibrary(): LibraryItem[] {
  return demoRefs().map((r, i) => {
    const l = demoLoad(r.id);
    let total: number | null = null;
    if (l?.facts && r.status !== 'draft') {
      const m = mapDocument(l.facts, demoBusinessFacts());
      total = m.ok ? m.money.grossPence : null;
    }
    return { id: r.id, type: r.type, number: r.number, status: statusOf(r.status), date: r.date, customerName: demoCustomerFacts(r.customerId).name, jobId: r.jobId, quoteNumber: r.form.quoteNumber, totalPence: total, createdAt: new Date(Date.UTC(2026, 9, 15) - i * 3600_000).toISOString() };
  });
}

function demoOtherDocs(h: DocumentHead): number {
  return (demoBillingState().documents.get(h.jobId) ?? []).filter((d) => d.id !== h.id).length;
}

function demoLoad(id: string): Loaded | null {
  if (id.startsWith('demo-survey-')) return demoSurveyLoad(id);
  const r = demoRefs().find((x) => x.id === id);
  if (!r) return null;
  const st = docState(id);
  const status: DocStatus = r.status;
  // Demo documents that start out final have one issued version, made when first opened.
  const finals = st.finals.length === 0 && status !== 'draft' ? [{ versionId: `demo-ver-${id}-v1`, version: 1, finalisedAt: `${r.date}T09:00:00.000Z`, pdfPath: `demo-tenant/${r.customerId}/${r.jobId}/demo-ver-${id}-v1/document.pdf`, pages: 0 }] : st.finals;
  if (st.finals.length === 0 && status !== 'draft') st.finals = finals;
  const versions = [
    ...(status === 'draft' ? [{ id: `demo-ver-${id}-v${st.draftVersion}`, version: st.draftVersion, finalisedAt: null, pdfPath: null, input: {}, finalContent: null, bankAccountId: null }] : []),
    ...[...finals].reverse().map((f) => ({ id: f.versionId, version: f.version, finalisedAt: f.finalisedAt, pdfPath: f.pdfPath, input: {}, finalContent: { pages: f.pages }, bankAccountId: null })),
  ];
  const head: DocumentHead = {
    id,
    type: r.type,
    number: r.number,
    status,
    docDate: r.date,
    jobId: r.jobId,
    customerId: r.customerId,
    quoteNumber: r.form.quoteNumber,
    currentVersionId: status === 'draft' ? versions[0].id : (finals[finals.length - 1]?.versionId ?? null),
    pdfPath: status === 'draft' ? null : (finals[finals.length - 1]?.pdfPath ?? null),
    finalisedAt: status === 'draft' ? null : (finals[finals.length - 1]?.finalisedAt ?? null),
    versions,
  };
  const billingSt = demoBillingState();
  const payments = r.type === 'quotation' ? [] : (billingSt.payments.get(r.jobId) ?? []);
  const plan = demoPlanOf(r.form);
  let followOn: DocumentFacts['followOn'] = null;
  if (r.type !== 'quotation' && plan) {
    const bl = buildJobBilling({ quoteNumber: r.form.quoteNumber, plan, form: r.form, vatRateBp: demoQuoteDefaults.vatRateBp, documents: r.documents, payments });
    const doc = bl.ok ? bl.billing.documents.find((d) => d.id === id) : undefined;
    if (doc?.instalment) followOn = { instalment: doc.instalment, paymentId: r.type === 'receipt' ? (payments.find((p) => p.receiptDocumentId === id)?.id ?? null) : null };
  }
  const facts: DocumentFacts = {
    type: r.type,
    number: r.number,
    docDate: r.date,
    quoteNumber: r.form.quoteNumber,
    propertyAddress: r.form.propertyAddress,
    jobTypeLabel: r.form.jobTypeId === 'demo-jobtype-tiled' ? 'Tiled roof (demo)' : r.form.jobTypeId === 'demo-jobtype-fascia' ? 'Fascias and gutters (demo)' : 'Flat roof (demo)',
    guaranteeYears: r.form.jobTypeId === 'demo-jobtype-tiled' ? 25 : r.form.jobTypeId === 'demo-jobtype-fascia' ? null : 20,
    customer: demoCustomerFacts(r.customerId),
    quoteForm: r.form,
    plan,
    documents: r.documents,
    payments,
    followOn,
    bank: { accountName: 'Demo Business Account', bankName: 'Demo Bank', sortCode: '00-00-00', accountNumber: '00000000' },
  };
  return { head, facts, problems: [], business: demoBusinessFacts(), brand: demoRenderBrand(), bankLabel: 'Demo Business Account, Demo Bank, ending 0000', bankAccountId: null };
}

async function demoPreview(id: string, secret: string): Promise<PreviewState | null> {
  const l = demoLoad(id);
  if (!l) return null;
  if (l.head.status !== 'draft') return { state: 'final' };
  const p = prepareLoaded(l, secret);
  if (!p.ok) return { state: 'missing', missing: p.missing };
  const newest = l.head.versions[0];
  const storage = getStorage();
  const folder = previewFolder(versionFolder('demo-tenant', l.head, newest.id), p.key);
  let pages = 0;
  const manifest = await storage.get(`${folder}/pages.json`);
  if (manifest) pages = Number(JSON.parse(manifest.toString('utf8')).pages) || 0;
  if (!pages) {
    const out = await (await render())(p.mapped, p.tenant, p.brand);
    for (let i = 0; i < out.pngPages.length; i += 1) await storage.put(`${folder}/${pageFile(i + 1)}`, out.pngPages[i], 'image/png', { overwrite: true });
    await storage.put(`${folder}/pages.json`, Buffer.from(JSON.stringify({ pages: out.pngPages.length })), 'application/json', { overwrite: true });
    pages = out.pngPages.length;
  }
  return { state: 'ready', versionId: newest.id, key: p.key, pageCount: pages, confirmation: confirmationFor(l.business?.wording) };
}

/** Renders and stores the files of a demo document that started out final, the first time they are wanted. */
async function demoEnsureFinalFiles(head: DocumentHead): Promise<void> {
  const st = docState(head.id);
  const last = st.finals[st.finals.length - 1];
  if (!last) return;
  const storage = getStorage();
  if (await storage.get(last.pdfPath)) return;
  const l = demoLoad(head.id);
  if (!l?.facts) return;
  const m = mapDocument(l.facts, demoBusinessFacts());
  if (!m.ok) return;
  const out = await (await render())(m.mapped, demoBusinessFacts().tenant, demoRenderBrand());
  const folder = versionFolder('demo-tenant', head, last.versionId);
  await storage.put(last.pdfPath, out.pdf, 'application/pdf', { overwrite: true });
  for (let i = 0; i < out.pngPages.length; i += 1) await storage.put(`${folder}/${pageFile(i + 1)}`, out.pngPages[i], 'image/png', { overwrite: true });
  last.pages = out.pngPages.length;
}

async function demoFinalise(s: Session, a: FinaliseArgs, secret: string): Promise<Finalised> {
  if (a.confirmed !== true) throw new DocumentError('unconfirmed', 'Tick the box to confirm you have checked the document.');
  const l = demoLoad(a.documentId);
  if (!l) throw new DocumentError('not_found', 'That document could not be found.');
  const st = docState(a.documentId);
  const newest = l.head.versions[0];
  if (l.head.status !== 'draft') {
    const last = st.finals[st.finals.length - 1];
    if (last && last.versionId === a.versionId) return { documentId: a.documentId, versionId: last.versionId, pdfPath: last.pdfPath, pages: last.pages, already: true };
    throw new DocumentError('locked', 'This document has already been finalised.');
  }
  if (newest.id !== a.versionId) throw new DocumentError('changed', 'This document changed after you opened it. Read it again before you confirm.');
  if (confirmationFor(l.business?.wording).version !== a.confirmationVersion) throw new DocumentError('changed', 'The confirmation wording has changed. Read it again and tick the box.');
  const p = prepareLoaded(l, secret);
  if (!p.ok) throw new DocumentError('missing', 'Some details this document needs are missing.', p.missing);
  if (p.key !== a.key) throw new DocumentError('changed', 'This document changed after you read it. Read it again before you confirm.');
  if (l.head.type === 'survey') {
    const v = l.survey?.form;
    const audited = demoSurveyAudited(a.documentId);
    const ok = v && v.findings.every((f) => isFindingApproved(f) && audited.has(f.approvalHash ?? '')) && isOpinionApproved(v) && audited.has(v.opinionHash ?? '');
    if (!ok) throw new DocumentError('missing', 'Some parts of the report have not been approved.', ['Approve every finding and your professional opinion.']);
  }
  const out = await (await render())(p.mapped, p.tenant, p.brand);
  if (!allPagesRead(secret, { tenantId: 'demo-tenant', userId: s.userId, documentId: a.documentId, versionId: newest.id, key: p.key }, out.pngPages.length, a.tokens)) {
    throw new DocumentError('unread', `Open all ${out.pngPages.length} pages before you confirm.`);
  }
  const folder = versionFolder('demo-tenant', l.head, newest.id);
  const pdfPath = `${folder}/document.pdf`;
  const storage: DocumentStorage = getStorage();
  await storage.put(pdfPath, out.pdf, 'application/pdf', { overwrite: true });
  for (let i = 0; i < out.pngPages.length; i += 1) await storage.put(`${folder}/${pageFile(i + 1)}`, out.pngPages[i], 'image/png', { overwrite: true });
  st.finals.push({ versionId: newest.id, version: newest.version, finalisedAt: new Date().toISOString(), pdfPath, pages: out.pngPages.length });
  if (l.head.type === 'quotation') {
    demoIssueQuote({ jobId: l.head.jobId, form: l.facts!.quoteForm, documentId: a.documentId });
    demoRemoveDraft(l.head.jobId);
  } else if (l.head.type === 'survey') demoSurveyMarkFinal(a.documentId);
  else demoMarkFinal(l.head.jobId, a.documentId);
  return { documentId: a.documentId, versionId: newest.id, pdfPath, pages: out.pngPages.length, already: false };
}

function demoRevise(id: string): { jobId: string } {
  const l = demoLoad(id);
  if (!l) throw new DocumentError('not_found', 'That document could not be found.');
  if (l.head.type === 'survey') {
    if (l.head.status === 'draft') return { jobId: l.head.jobId };
    const st = docState(id);
    if (!demoSurveyRevise(id)) throw new DocumentError('locked', 'This document cannot be changed.');
    st.draftVersion = (st.finals[st.finals.length - 1]?.version ?? 1) + 1;
    return { jobId: l.head.jobId };
  }
  if (l.head.type !== 'quotation') throw new DocumentError('not_allowed', 'Only a quotation can be changed after it is finalised. Invoices and receipts follow the quote and the payments.');
  if (l.head.status === 'draft') return { jobId: l.head.jobId };
  if (!demoUnissueQuote(l.head.jobId)) throw new DocumentError('not_allowed', 'This quote already has invoices or receipts made from it, so it cannot be changed now.');
  const st = docState(id);
  const lastVersion = st.finals[st.finals.length - 1]?.version ?? 1;
  st.draftVersion = lastVersion + 1;
  demoRestoreDraft(l.head.jobId, l.facts!.quoteForm);
  // The restored draft gets the demo-doc-{jobId} id; carry the issued history across to it.
  const nid = `demo-doc-${l.head.jobId}`;
  if (nid !== id) demoDocs.set(nid, { ...st });
  return { jobId: l.head.jobId };
}
