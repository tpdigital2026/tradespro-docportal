/**
 * Loads everything a document is made from, on a service connection. Row level security does not apply on that
 * connection, so EVERY query here is filtered by the tenant taken from the session, and ids from the browser are only
 * ever used together with it.
 *
 * Bank numbers are decrypted only when asked (at render time), and never leave this process except inside the PDF.
 */
import { tenantWordingSchema } from '../../db/wording';
import { decryptBankDetails, parseKey } from '../../security/bank-crypto';
import type { Db } from '../../security/login-guard';
import type { BankDetails } from '../../templates/finance-parts';
import type { Brand, Tenant } from '../../themes/types';
import type { RawDocument, RawPayment } from '../job-billing';
import { docTypeFromDb, type DocStatus, type DocType } from '../job-stage';
import { MAX_VAT_RATE_BP, type PaymentPlan } from '../money';
import { planFromJson } from '../payment-plan';
import { quoteFormSchema, type QuoteFormValues } from '../validation/quote';
import type { BusinessFacts, DocumentFacts } from './map';
import { renderBrandFrom, type AssetRow } from './render-brand';

export interface VersionRow {
  id: string;
  version: number;
  finalisedAt: string | null;
  pdfPath: string | null;
  input: unknown;
  finalContent: unknown;
  /** The money written when the version was finalised (null for a draft). */
  money: unknown;
  bankAccountId: string | null;
}

export interface DocumentHead {
  id: string;
  type: DocType;
  number: string;
  status: DocStatus;
  docDate: string;
  jobId: string;
  customerId: string;
  quoteNumber: string;
  currentVersionId: string | null;
  pdfPath: string | null;
  finalisedAt: string | null;
  /** Newest first. */
  versions: VersionRow[];
}

export interface Loaded {
  head: DocumentHead;
  /** null with a reason when the document's own facts cannot be put together. */
  facts: DocumentFacts | null;
  problems: string[];
  business: BusinessFacts | null;
  brand: Brand | null;
  bankLabel: string | null;
  bankAccountId: string | null;
}

const iso = (d: unknown): string => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));
const ts = (d: unknown): string | null => (d === null || d === undefined ? null : d instanceof Date ? d.toISOString() : String(d));

/** The document row and its versions. With lock, the document row is taken FOR UPDATE (finalise and revise). */
export async function loadHeadWith(db: Db, tenantId: string, documentId: string, lock = false): Promise<DocumentHead | null> {
  const d = await db.query(
    `select d.id, d.type::text as type, d.number, d.status::text as status, d.doc_date, d.job_id, d.current_version_id, d.pdf_path, d.finalised_at,
            j.customer_id, j.reference
       from public.documents d join public.jobs j on j.id = d.job_id and j.tenant_id = d.tenant_id
      where d.id = $1 and d.tenant_id = $2${lock ? ' for update of d' : ''}`,
    [documentId, tenantId],
  );
  const r = d.rows[0];
  if (!r) return null;
  const type = docTypeFromDb(r.type);
  if (!type) return null;
  const v = await db.query(
    `select id, version, finalised_at, pdf_path, input, final_content, money, bank_account_id from public.document_versions
      where document_id = $1 and tenant_id = $2 order by version desc limit 50${lock ? ' for update' : ''}`,
    [documentId, tenantId],
  );
  return {
    id: String(r.id),
    type,
    number: String(r.number),
    status: r.status as DocStatus,
    docDate: iso(r.doc_date),
    jobId: String(r.job_id),
    customerId: String(r.customer_id),
    quoteNumber: String(r.reference),
    currentVersionId: r.current_version_id ? String(r.current_version_id) : null,
    pdfPath: r.pdf_path ?? null,
    finalisedAt: ts(r.finalised_at),
    versions: v.rows.map((x) => ({
      id: String(x.id),
      version: Number(x.version),
      finalisedAt: ts(x.finalised_at),
      pdfPath: x.pdf_path ?? null,
      input: x.input,
      finalContent: x.final_content,
      money: x.money ?? null,
      bankAccountId: x.bank_account_id ? String(x.bank_account_id) : null,
    })),
  };
}

/** Which document a version belongs to (in this business), or null. */
export async function documentOfVersionWith(db: Db, tenantId: string, versionId: string): Promise<string | null> {
  const r = await db.query(`select document_id from public.document_versions where id = $1 and tenant_id = $2`, [versionId, tenantId]);
  return r.rows[0] ? String(r.rows[0].document_id) : null;
}

export async function businessWith(db: Db, tenantId: string): Promise<{ business: BusinessFacts | null; slug: string | null; problems: string[] }> {
  const r = await db.query(
    `select t.name, t.address_lines, t.postcode, t.phone, t.email, t.website, t.company_number, t.vat_registered, t.vat_number, t.tagline,
            t.owner_name, t.owner_title, t.slug, d.terms, d.disclaimer_text, d.quote_validity_days, d.vat_rate_bp
       from public.tenants t left join public.tenant_defaults d on d.tenant_id = t.id where t.id = $1`,
    [tenantId],
  );
  const t = r.rows[0];
  if (!t) return { business: null, slug: null, problems: ['Your business could not be found.'] };
  const problems: string[] = [];
  const rate = t.vat_rate_bp === null || t.vat_rate_bp === undefined ? 2000 : Number(t.vat_rate_bp);
  if (!Number.isSafeInteger(rate) || rate < 0 || rate > MAX_VAT_RATE_BP) problems.push('Your VAT rate setting is not valid. Contact TradesPro Digital.');
  const wording = tenantWordingSchema.safeParse(t.terms);
  const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '');
  const tenant: Tenant = {
    name: str(t.name),
    addressLine: [...((t.address_lines as string[] | null) ?? []), str(t.postcode)].map(str).filter(Boolean).join(' · '),
    phone: str(t.phone),
    email: str(t.email),
    web: str(t.website),
    companyNo: str(t.company_number),
    vatNo: t.vat_registered && str(t.vat_number) ? str(t.vat_number) : null,
    tagline: str(t.tagline),
    ownerName: str(t.owner_name),
    ownerTitle: str(t.owner_title),
  };
  return {
    slug: typeof t.slug === 'string' ? t.slug : null,
    problems,
    business: {
      tenant,
      wording: wording.success ? wording.data : null,
      disclaimer: str(t.disclaimer_text),
      validityDays: Number.isSafeInteger(t.quote_validity_days) && t.quote_validity_days > 0 ? Number(t.quote_validity_days) : 30,
      vatRateBp: rate,
    },
  };
}

export async function brandWith(db: Db, tenantId: string, slug: string | null): Promise<{ brand: Brand | null; problems: string[] }> {
  const r = await db.query(
    `select k.colours, a.kind::text as kind, a.storage_path
       from public.brand_kits k left join public.brand_assets a on a.brand_kit_id = k.id and a.tenant_id = k.tenant_id
      where k.tenant_id = $1 order by a.created_at desc nulls last`,
    [tenantId],
  );
  if (!r.rows[0]) return { brand: null, problems: ['Your document colours and logo are not set up yet. Contact TradesPro Digital to set them up.'] };
  const res = renderBrandFrom({ slug, tenantId, colours: r.rows[0].colours, assets: r.rows.filter((x) => x.kind).map((x) => ({ kind: x.kind, storage_path: x.storage_path }) as AssetRow) });
  return res.ok ? { brand: res.brand, problems: [] } : { brand: null, problems: res.missing };
}

/**
 * The bank account a document asks to be paid into: the one chosen on the quote, else the business's default.
 * Decrypts only when asked. A label (name, bank, last four digits) is always safe to show.
 */
export async function bankWith(db: Db, tenantId: string, preferredId: string | null, decrypt: boolean): Promise<{ id: string | null; label: string | null; details: BankDetails | null; problem: string | null }> {
  const r = await db.query(
    `select id, account_name, bank_name, sort_code_enc, account_number_enc, last4 from public.bank_accounts
      where tenant_id = $1 and archived_at is null and (id = $2 or is_default) order by (id = $2) desc, is_default desc limit 1`,
    [tenantId, preferredId],
  );
  const b = r.rows[0];
  if (!b) return { id: null, label: null, details: null, problem: null };
  const label = `${b.account_name}, ${b.bank_name}, ending ${b.last4}`;
  if (!decrypt) return { id: String(b.id), label, details: null, problem: null };
  const raw = process.env.BANK_ENCRYPTION_KEY;
  if (!raw) return { id: String(b.id), label, details: null, problem: 'Your bank details cannot be read on this server. Contact TradesPro Digital.' };
  try {
    const plain = decryptBankDetails({ sort_code_enc: b.sort_code_enc, account_number_enc: b.account_number_enc }, parseKey(raw), tenantId);
    return { id: String(b.id), label, details: { accountName: b.account_name, bankName: b.bank_name, sortCode: plain.sortCode, accountNumber: plain.accountNumber }, problem: null };
  } catch {
    return { id: String(b.id), label, details: null, problem: 'Your bank details cannot be read on this server. Contact TradesPro Digital.' };
  }
}

/** The VAT rate and total an issued quote version stored when it was finalised, or null for an older version without them. */
export function issuedQuoteMoney(finalContent: unknown, money: unknown): { vatRateBp: number; grossPence: number } | null {
  const rate = (finalContent as { content?: { input?: { vatRateBp?: unknown } } } | null)?.content?.input?.vatRateBp;
  const gross = (money as { grossPence?: unknown } | null)?.grossPence;
  return typeof rate === 'number' && Number.isSafeInteger(rate) && typeof gross === 'number' && Number.isSafeInteger(gross) ? { vatRateBp: rate, grossPence: gross } : null;
}

function parseForm(input: unknown): QuoteFormValues | null {
  const r = quoteFormSchema.safeParse((input as { form?: unknown } | null)?.form);
  return r.success ? (r.data as QuoteFormValues) : null;
}

function parseFollowOn(input: unknown): { instalment: number; paymentId: string | null } | null {
  const f = (input as { followOn?: { instalment?: unknown; paymentId?: unknown } } | null)?.followOn;
  if (!f || !Number.isInteger(f.instalment)) return null;
  return { instalment: f.instalment as number, paymentId: typeof f.paymentId === 'string' ? f.paymentId : null };
}

/**
 * Everything for one document: its newest version, the job, the customer, the quote it comes from, the job's other
 * documents and payments, the business, its brand and (when decryptBank) the bank details.
 */
export async function loadWith(db: Db, tenantId: string, documentId: string, opts: { lock?: boolean; decryptBank?: boolean; head?: DocumentHead } = {}): Promise<Loaded | null> {
  const head = opts.head ?? (await loadHeadWith(db, tenantId, documentId, opts.lock));
  if (!head) return null;
  const problems: string[] = [];
  const newest = head.versions[0] ?? null;

  const jr = await db.query(
    `select j.property_address, j.payment_plan, jt.label as job_type_label, jt.guarantee_years
       from public.jobs j left join public.job_types jt on jt.id = j.job_type_id and jt.tenant_id = j.tenant_id
      where j.id = $1 and j.tenant_id = $2`,
    [head.jobId, tenantId],
  );
  const cr = await db.query(`select name, address_lines, postcode, email, phone from public.customers where id = $1 and tenant_id = $2`, [head.customerId, tenantId]);
  const job = jr.rows[0];
  const cust = cr.rows[0];

  let quoteForm: QuoteFormValues | null = null;
  let quoteBankId: string | null = null;
  let quoteIssued: DocumentFacts['quoteIssued'] = null;
  if (head.type === 'quotation') {
    quoteForm = newest ? parseForm(newest.input) : null;
    quoteBankId = newest?.bankAccountId ?? null;
    if (!quoteForm) problems.push('This quote has nothing saved in it yet. Open it and fill it in.');
  } else {
    const q = await db.query(
      `select v.input, v.bank_account_id, v.final_content, v.money from public.documents d join public.document_versions v on v.id = d.current_version_id and v.tenant_id = d.tenant_id
        where d.job_id = $1 and d.tenant_id = $2 and d.type = 'quotation' and d.status in ('final', 'sent')`,
      [head.jobId, tenantId],
    );
    quoteForm = q.rows[0] ? parseForm(q.rows[0].input) : null;
    quoteBankId = q.rows[0]?.bank_account_id ? String(q.rows[0].bank_account_id) : null;
    quoteIssued = issuedQuoteMoney(q.rows[0]?.final_content, q.rows[0]?.money);
    if (!quoteForm) problems.push('The quote for this job has not been finalised yet, so this document cannot be made from it.');
  }

  let documents: RawDocument[] = [];
  let payments: RawPayment[] = [];
  if (head.type !== 'quotation') {
    const dr = await db.query(`select id, type::text as type, number, status::text as status from public.documents where job_id = $1 and tenant_id = $2 order by created_at, id`, [head.jobId, tenantId]);
    documents = dr.rows.flatMap((x) => {
      const t = docTypeFromDb(x.type);
      return t ? [{ id: String(x.id), type: t, number: String(x.number), status: x.status as DocStatus }] : [];
    });
    const pr = await db.query(
      `select id, document_id, amount_pence, paid_on, method, note, receipt_document_id from public.payments where job_id = $1 and tenant_id = $2 order by created_at, id`,
      [head.jobId, tenantId],
    );
    payments = pr.rows.map((p) => ({ id: String(p.id), documentId: String(p.document_id), amountPence: Number(p.amount_pence), paidOn: iso(p.paid_on), method: String(p.method), note: null, receiptDocumentId: p.receipt_document_id ? String(p.receipt_document_id) : null }));
  }

  const biz = await businessWith(db, tenantId);
  problems.push(...biz.problems);
  const brand = await brandWith(db, tenantId, biz.slug);
  problems.push(...brand.problems);
  const wantsBank = head.type !== 'receipt';
  const bank = wantsBank ? await bankWith(db, tenantId, quoteBankId ?? (quoteForm?.bankAccountId || null), opts.decryptBank === true) : { id: null, label: null, details: null, problem: null };
  if (bank.problem && head.type !== 'quotation') problems.push(bank.problem);

  const planParsed = job ? planFromJson(job.payment_plan) : null;
  const plan: PaymentPlan | null = planParsed?.plan ?? null;
  const facts: DocumentFacts | null =
    job && cust && quoteForm
      ? {
          type: head.type,
          number: head.number,
          docDate: head.docDate,
          quoteNumber: head.quoteNumber,
          propertyAddress: typeof job.property_address === 'string' ? job.property_address : '',
          jobTypeLabel: typeof job.job_type_label === 'string' ? job.job_type_label : '',
          guaranteeYears: Number.isInteger(job.guarantee_years) ? Number(job.guarantee_years) : null,
          customer: { name: String(cust.name ?? ''), addressLines: (cust.address_lines as string[] | null) ?? [], postcode: cust.postcode ?? '', email: cust.email ?? '', phone: cust.phone ?? '' },
          quoteForm,
          plan,
          documents,
          payments,
          followOn: head.type === 'quotation' ? null : newest ? parseFollowOn(newest.input) : null,
          bank: bank.details,
          quoteIssued,
        }
      : null;
  if (!job || !cust) problems.push('The job or customer for this document could not be found.');
  return { head, facts, problems, business: biz.business, brand: brand.brand, bankLabel: bank.label, bankAccountId: bank.id };
}
