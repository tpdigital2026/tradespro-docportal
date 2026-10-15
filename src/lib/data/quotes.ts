import {
  demoBankAccounts,
  demoCustomers,
  demoJobTypes,
  demoQuoteDefaults,
  demoQuoteDrafts,
  demoUsedNumbers,
} from '../demo-data';
import { isDemo } from '../demo';
import { MAX_VAT_RATE_BP } from '../money';
import { planToJson } from '../payment-plan';
import { computeQuoteTotals, DEFAULT_VAT_RATE_BP } from '../quote-totals';
import { suggestNextNumber } from '../quote-number';
import { requireSession } from '../session';
import { sanitiseIncomingScope } from '../scope/approval';
import { itemsFromLegacyNotes } from '../scope/items';
import { emptyScope, scopeFormSchema, type ScopeFormValues } from '../scope/model';
import { verifyGenerated } from '../scope/proof';
import { parseScopeExamples, type ScopeExamples } from '../scope/examples';
import { normaliseQuote, NUMBER_RE, NUMBER_SUFFIX_MESSAGE, quoteNumberReserved, quoteFormSchema, type QuoteErrors, type QuoteFormValues } from '../validation/quote';
import { ownerClient, type DataClient } from './customers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEMO_ID = /^demo-[a-z]+-[\w-]{1,40}$/;
export const isRealId = (id: unknown): id is string => typeof id === 'string' && UUID.test(id);
export const isKnownId = (id: unknown): id is string => typeof id === 'string' && (UUID.test(id) || (isDemo() && DEMO_ID.test(id)));

export type QuoteErrorCode = 'invalid' | 'number_used' | 'locked' | 'customer_locked' | 'not_found' | 'failed';

export class QuoteError extends Error {
  constructor(
    readonly code: QuoteErrorCode,
    message: string,
    readonly errors?: QuoteErrors,
  ) {
    super(message);
    this.name = 'QuoteError';
  }
}

export interface JobTypeOption {
  id: string;
  label: string;
  guaranteeYears: number | null;
  /** The business's own scope wording for this kind of job (labels, headings, starters, example sequences). */
  scopeExamples: ScopeExamples | null;
}
export interface BankAccountOption {
  id: string;
  label: string;
  last4: string;
  isDefault: boolean;
}
export interface QuoteDefaults {
  vatDefault: boolean;
  vatRateBp: number;
  depositPctBp: number;
}
export interface CustomerOption {
  id: string;
  name: string;
  postcode: string;
  addressLine: string;
}
export interface QuoteContext {
  customers: CustomerOption[];
  jobTypes: JobTypeOption[];
  bankAccounts: BankAccountOption[];
  defaults: QuoteDefaults;
  suggestedNumber: string;
  today: string;
}
export interface QuoteDraft {
  jobId: string;
  documentId: string | null;
  values: QuoteFormValues;
  customerName: string;
}
export interface DraftListItem {
  jobId: string;
  quoteNumber: string;
  customerName: string;
  date: string;
}
export interface SavedDraft {
  jobId: string;
  documentId: string;
  savedAt: string;
  /** The job's own reference and customer, as stored. The browser must show these, whatever it sent. */
  quoteNumber: string;
  customerId: string;
}

const FALLBACK_DEFAULTS: QuoteDefaults = { vatDefault: true, vatRateBp: DEFAULT_VAT_RATE_BP, depositPctBp: 3000 };

// ---------------------------------------------------------------- reads (the owner's session; row level security scopes them)

export async function listJobTypesWith(client: DataClient): Promise<JobTypeOption[]> {
  const { data, error } = await client.from('job_types').select('id, label, guarantee_years, scope_examples').order('label', { ascending: true }).limit(100);
  if (error) throw new QuoteError('failed', 'Could not load job types');
  return ((data ?? []) as { id: string; label: string; guarantee_years: number | null; scope_examples?: unknown }[]).map((r) => ({
    id: r.id,
    label: r.label,
    guaranteeYears: typeof r.guarantee_years === 'number' ? r.guarantee_years : null,
    scopeExamples: parseScopeExamples(r.scope_examples),
  }));
}

/** Safe columns only: the app role cannot read the encrypted numbers. The label shows the last four digits and nothing else. */
export async function listBankAccountsWith(client: DataClient): Promise<BankAccountOption[]> {
  const { data, error } = await client
    .from('bank_accounts')
    .select('id, account_name, bank_name, last4, is_default, archived_at')
    .is('archived_at', null)
    .order('is_default', { ascending: false })
    .limit(20);
  if (error) throw new QuoteError('failed', 'Could not load bank accounts');
  return ((data ?? []) as { id: string; account_name: string; bank_name: string; last4: string; is_default: boolean }[]).map((r) => ({
    id: r.id,
    label: `${r.account_name}, ${r.bank_name}, ending ${r.last4}`,
    last4: r.last4,
    isDefault: r.is_default,
  }));
}

export const VAT_SETTING_INVALID = 'Your VAT rate setting is not valid. Contact TradesPro Digital.';

/** A stored VAT rate outside 0 to 25% is refused loudly. Money is never quietly worked out with a different rate. */
export async function getQuoteDefaultsWith(client: DataClient): Promise<QuoteDefaults> {
  const { data, error } = await client.from('tenant_defaults').select('vat_default, vat_rate_bp, deposit_pct_bp').maybeSingle();
  if (error) throw new QuoteError('failed', 'Could not load defaults');
  const d = data as { vat_default?: unknown; vat_rate_bp?: unknown; deposit_pct_bp?: unknown } | null;
  if (!d) return FALLBACK_DEFAULTS;
  const rate = d.vat_rate_bp;
  if (typeof rate !== 'number' || !Number.isSafeInteger(rate) || rate < 0 || rate > MAX_VAT_RATE_BP) throw new QuoteError('failed', VAT_SETTING_INVALID);
  return {
    vatDefault: typeof d.vat_default === 'boolean' ? d.vat_default : FALLBACK_DEFAULTS.vatDefault,
    vatRateBp: rate,
    depositPctBp: Number.isSafeInteger(d.deposit_pct_bp) && (d.deposit_pct_bp as number) >= 100 && (d.deposit_pct_bp as number) <= 9900 ? (d.deposit_pct_bp as number) : FALLBACK_DEFAULTS.depositPctBp,
  };
}

/** Newest first. */
export async function recentNumbersWith(client: DataClient): Promise<string[]> {
  const { data, error } = await client.from('used_numbers').select('number').order('created_at', { ascending: false }).limit(200);
  if (error) throw new QuoteError('failed', 'Could not load quote numbers');
  return ((data ?? []) as { number: string }[]).map((r) => r.number);
}

export async function numberIsFreeWith(client: DataClient, quoteNumber: string): Promise<boolean> {
  if (!NUMBER_RE.test(quoteNumber) || quoteNumberReserved(quoteNumber) !== null) return false;
  const { data, error } = await client.from('used_numbers').select('number').eq('number', quoteNumber).maybeSingle();
  if (error) throw new QuoteError('failed', 'Could not check that number');
  return !data;
}

export async function listDraftsWith(client: DataClient): Promise<DraftListItem[]> {
  const docs = await client
    .from('documents')
    .select('job_id, number, doc_date, created_at')
    .eq('type', 'quotation')
    .eq('status', 'draft')
    .order('created_at', { ascending: false })
    .limit(20);
  if (docs.error) throw new QuoteError('failed', 'Could not load drafts');
  const rows = (docs.data ?? []) as { job_id: string; number: string; doc_date: string }[];
  if (rows.length === 0) return [];
  const jobs = await client.from('jobs').select('id, customer_id').in('id', rows.map((r) => r.job_id));
  if (jobs.error) throw new QuoteError('failed', 'Could not load drafts');
  const jobRows = (jobs.data ?? []) as { id: string; customer_id: string }[];
  const custs = await client.from('customers').select('id, name').in('id', [...new Set(jobRows.map((j) => j.customer_id))]);
  if (custs.error) throw new QuoteError('failed', 'Could not load drafts');
  const names = new Map(((custs.data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  const customerOf = new Map(jobRows.map((j) => [j.id, j.customer_id]));
  return rows.map((r) => ({ jobId: r.job_id, quoteNumber: r.number, customerName: names.get(customerOf.get(r.job_id) ?? '') ?? 'Customer', date: r.doc_date }));
}

export async function getDraftWith(client: DataClient, jobId: string): Promise<QuoteDraft | null> {
  if (!isRealId(jobId)) return null;
  const job = await client.from('jobs').select('id, reference, customer_id, property_address, job_type_id').eq('id', jobId).maybeSingle();
  if (job.error) throw new QuoteError('failed', 'Could not load that quote');
  const j = job.data as { id: string; reference: string; customer_id: string; property_address: string | null; job_type_id: string | null } | null;
  if (!j) return null;
  const doc = await client.from('documents').select('id, status, doc_date').eq('job_id', jobId).eq('type', 'quotation').maybeSingle();
  if (doc.error) throw new QuoteError('failed', 'Could not load that quote');
  const d = doc.data as { id: string; status: string; doc_date: string } | null;
  if (d && d.status !== 'draft') return null; // an issued quote is no longer edited here
  let values: QuoteFormValues | null = null;
  if (d) {
    const ver = await client.from('document_versions').select('input, bank_account_id').eq('document_id', d.id).eq('version', 1).maybeSingle();
    if (ver.error) throw new QuoteError('failed', 'Could not load that quote');
    const stored = (ver.data as { input?: { form?: unknown } } | null)?.input?.form;
    const parsed = quoteFormSchema.safeParse(stored);
    if (parsed.success) {
      values = parsed.data as QuoteFormValues;
      // Drafts made before the scope builder kept their words in one box. Never lose them: each line becomes a step.
      const legacy = (stored as { scopeNotes?: unknown } | null)?.scopeNotes;
      if (typeof legacy === 'string' && legacy.trim() !== '' && values.scope.items.length === 0) values = { ...values, scope: { ...values.scope, items: itemsFromLegacyNotes(legacy) } };
    }
  }
  const cust = await client.from('customers').select('name').eq('id', j.customer_id).maybeSingle();
  const customerName = (cust.data as { name?: string } | null)?.name ?? 'Customer';
  // The columns are the truth for the key fields; the saved form restores whatever else was typed.
  const base = values ?? blankForm(j.reference, j.customer_id, d?.doc_date ?? '');
  return {
    jobId: j.id,
    documentId: d?.id ?? null,
    customerName,
    values: { ...base, quoteNumber: j.reference, customerId: j.customer_id, jobTypeId: j.job_type_id ?? '', propertyAddress: j.property_address ?? base.propertyAddress },
  };
}

function blankForm(quoteNumber: string, customerId: string, date: string): QuoteFormValues {
  return {
    quoteNumber,
    customerId,
    date,
    jobTypeId: '',
    propertyAddress: '',
    scope: emptyScope(),
    price: '',
    vatApplies: true,
    extras: [],
    discount: '',
    plan: { kind: 'deposit', depositPct: '30', stages: [{ label: '', mode: 'pct', value: '' }, { label: '', mode: 'pct', value: '' }] },
    bankAccountId: '',
  };
}

// ---------------------------------------------------------------- the autosave (idempotent, so a retry after a half-finished save heals it)

interface Found {
  id: string;
  reference: string;
  customer_id: string;
}

/** The scope as last saved for this job, or null. The approval on it is the only approval there is. */
export async function storedScopeWith(client: DataClient, jobId: string): Promise<ScopeFormValues | null> {
  const doc = await client.from('documents').select('id').eq('job_id', jobId).eq('type', 'quotation').maybeSingle();
  const id = (doc.data as { id?: string } | null)?.id;
  if (doc.error || !id) return null;
  const ver = await client.from('document_versions').select('input').eq('document_id', id).eq('version', 1).maybeSingle();
  const stored = (ver.data as { input?: { form?: { scope?: unknown } } } | null)?.input?.form?.scope;
  const parsed = scopeFormSchema.safeParse(stored);
  return parsed.success ? (parsed.data as ScopeFormValues) : null;
}

export interface SaveOptions {
  /** Only the server's approval step sets this: the approval fields in the form were written by the server just now. */
  trustApproval?: boolean;
}

async function ensureDocument(
  client: DataClient,
  tenantId: string,
  job: { id: string; reference: string; customerId: string },
  form: QuoteFormValues,
  input: ReturnType<typeof normaliseQuote>['input'],
  today: string,
): Promise<{ documentId: string }> {
  const jobId = job.id;
  const existing = await client.from('documents').select('id, status').eq('job_id', jobId).eq('type', 'quotation').maybeSingle();
  if (existing.error) throw new QuoteError('failed', 'Could not save');
  const row = existing.data as { id: string; status: string } | null;
  const bank = input.bankAccountId;
  // The job row is the truth for its number and customer. Whatever the browser sent for them is replaced.
  const stored = { schema: 1, form: { ...form, quoteNumber: job.reference, customerId: job.customerId } };
  if (row) {
    if (row.status !== 'draft') throw new QuoteError('locked', 'This quote has been issued and can no longer be edited here.');
    const upd = await client.from('documents').update({ doc_date: input.date ?? today }).eq('id', row.id).select('id');
    if (upd.error || !upd.data?.length) throw new QuoteError('failed', 'Could not save');
    const v = await client.from('document_versions').update({ input: stored, bank_account_id: bank }).eq('document_id', row.id).eq('version', 1).select('id');
    if (v.error) throw new QuoteError('failed', 'Could not save');
    if (!v.data?.length) {
      // Version missing (an earlier save stopped half way): create it.
      const ins = await client.from('document_versions').insert({ tenant_id: tenantId, document_id: row.id, version: 1, input: stored, bank_account_id: bank }).select('id').single();
      if (ins.error || !ins.data) throw new QuoteError('failed', 'Could not save');
      const cur = await client.from('documents').update({ current_version_id: ins.data.id }).eq('id', row.id).select('id');
      if (cur.error) throw new QuoteError('failed', 'Could not save');
    }
    return { documentId: row.id };
  }
  const doc = await client
    .from('documents')
    .insert({ tenant_id: tenantId, job_id: jobId, type: 'quotation', number: job.reference, doc_date: input.date ?? today })
    .select('id')
    .single();
  if (doc.error || !doc.data) throw new QuoteError('failed', 'Could not save');
  const ver = await client.from('document_versions').insert({ tenant_id: tenantId, document_id: doc.data.id, version: 1, input: stored, bank_account_id: bank }).select('id').single();
  if (ver.error || !ver.data) throw new QuoteError('failed', 'Could not save');
  const cur = await client.from('documents').update({ current_version_id: ver.data.id }).eq('id', doc.data.id).select('id');
  if (cur.error) throw new QuoteError('failed', 'Could not save');
  return { documentId: doc.data.id as string };
}

/**
 * Saves the form as a draft quote: a job (the quote number is the job key), its quotation document and version 1.
 * jobId is the draft the browser already holds, or null for the first save. Never trusts the browser's totals:
 * the plan is re-checked against the figures worked out here.
 */
export async function saveDraftWith(client: DataClient, tenantId: string, rawForm: QuoteFormValues, jobId: string | null, vatRateBp: number, today: string, opts: SaveOptions = {}): Promise<SavedDraft> {
  // Whatever the browser says about approval is ignored: approval is kept only if it is already stored and the content still matches.
  const form = opts.trustApproval
    ? rawForm
    : { ...rawForm, scope: sanitiseIncomingScope(rawForm.scope, jobId && isRealId(jobId) ? await storedScopeWith(client, jobId) : null, (c) => verifyGenerated(tenantId, c)) };
  const { input, errors } = normaliseQuote(form, 'draft', vatRateBp);
  if (Object.keys(errors).length > 0) throw new QuoteError('invalid', 'Check the highlighted fields', errors);
  if (!UUID.test(input.customerId)) throw new QuoteError('invalid', 'Choose who this quote is for', { customerId: 'Choose who this quote is for' });

  const totals = computeQuoteTotals(input, vatRateBp);
  const planJson = input.plan ? planToJson(input.plan, totals.schedule) : null;
  const columns = { property_address: input.propertyAddress, job_type_id: input.jobTypeId, payment_plan: planJson };

  const done = async (job: { id: string; reference: string; customerId: string }): Promise<SavedDraft> => {
    const { documentId } = await ensureDocument(client, tenantId, job, form, input, today);
    return { jobId: job.id, documentId, savedAt: new Date().toISOString(), quoteNumber: job.reference, customerId: job.customerId };
  };

  if (jobId) {
    if (!isRealId(jobId)) throw new QuoteError('not_found', 'That draft could not be found.');
    const found = await client.from('jobs').select('id, reference, customer_id').eq('id', jobId).maybeSingle();
    if (found.error) throw new QuoteError('failed', 'Could not save');
    const row = found.data as Found | null;
    if (!row) throw new QuoteError('not_found', 'That draft could not be found.');
    // The number and the customer belong to the job. What the browser sent for them is ignored.
    const upd = await client.from('jobs').update(columns).eq('id', jobId).eq('tenant_id', tenantId).select('id');
    if (upd.error) throw new QuoteError(/issued/i.test(String(upd.error.message)) ? 'locked' : 'failed', /issued/i.test(String(upd.error.message)) ? 'This quote has been issued and can no longer be edited here.' : 'Could not save');
    if (!upd.data?.length) throw new QuoteError('not_found', 'That draft could not be found.');
    return done({ id: jobId, reference: row.reference, customerId: row.customer_id });
  }

  const ins = await client.from('jobs').insert({ tenant_id: tenantId, customer_id: input.customerId, reference: input.quoteNumber, ...columns }).select('id, reference, customer_id').single();
  if (!ins.error && ins.data) {
    const r = ins.data as Found;
    return done({ id: r.id, reference: r.reference, customerId: r.customer_id });
  }
  if (ins.error?.code === '23505') {
    // Taken. Unless it is our own earlier attempt that stopped before its document existed, in which case carry on with it.
    const own = await client.from('jobs').select('id, reference, customer_id').eq('reference', input.quoteNumber).maybeSingle();
    const row = own.data as Found | null;
    if (row && row.customer_id === input.customerId) {
      const docs = await client.from('documents').select('id').eq('job_id', row.id).limit(1);
      if (!docs.error && (docs.data ?? []).length === 0) {
        const upd = await client.from('jobs').update(columns).eq('id', row.id).eq('tenant_id', tenantId).select('id');
        if (!upd.error && upd.data?.length) return done({ id: row.id, reference: row.reference, customerId: row.customer_id });
      }
    }
    throw new QuoteError('number_used', 'That quote number has already been used. Choose another.', { quoteNumber: 'That quote number has already been used. Choose another.' });
  }
  if (ins.error?.code === '23514') throw new QuoteError('invalid', NUMBER_SUFFIX_MESSAGE, { quoteNumber: NUMBER_SUFFIX_MESSAGE });
  throw new QuoteError('failed', 'Could not save');
}

// ---------------------------------------------------------------- demo mode (in memory, dummy data)

interface DemoDraft {
  jobId: string;
  values: QuoteFormValues;
}
let demoDrafts: DemoDraft[] | null = null;
const demoStore = () => (demoDrafts ??= demoQuoteDrafts.map((d) => ({ jobId: d.jobId, values: structuredClone(d.values) })));

/** Test hook: forget demo edits. */
export function resetDemoQuotes(): void {
  demoDrafts = null;
}

function demoCustomerName(id: string): string {
  return demoCustomers.find((c) => c.id === id)?.name ?? 'Customer';
}

function demoSave(rawForm: QuoteFormValues, jobId: string | null, vatRateBp: number, opts: SaveOptions = {}): SavedDraft {
  const prior = jobId ? demoStore().find((r) => r.jobId === jobId)?.values.scope ?? null : null;
  const form = opts.trustApproval ? rawForm : { ...rawForm, scope: sanitiseIncomingScope(rawForm.scope, prior, (c) => verifyGenerated('demo-tenant', c)) };
  const { input, errors } = normaliseQuote(form, 'draft', vatRateBp);
  if (Object.keys(errors).length > 0) throw new QuoteError('invalid', 'Check the highlighted fields', errors);
  const rows = demoStore();
  if (jobId) {
    const row = rows.find((r) => r.jobId === jobId);
    if (!row) throw new QuoteError('not_found', 'That draft could not be found.');
    row.values = structuredClone({ ...form, quoteNumber: row.values.quoteNumber, customerId: row.values.customerId });
    return { jobId, documentId: `demo-doc-${jobId}`, savedAt: new Date().toISOString(), quoteNumber: row.values.quoteNumber, customerId: row.values.customerId };
  }
  if (demoUsedNumbers.includes(input.quoteNumber) || rows.some((r) => r.values.quoteNumber === input.quoteNumber)) {
    throw new QuoteError('number_used', 'That quote number has already been used. Choose another.', { quoteNumber: 'That quote number has already been used. Choose another.' });
  }
  const id = `demo-job-${Date.now()}`;
  rows.unshift({ jobId: id, values: structuredClone(form) });
  return { jobId: id, documentId: `demo-doc-${id}`, savedAt: new Date().toISOString(), quoteNumber: input.quoteNumber, customerId: input.customerId };
}

// ---------------------------------------------------------------- the functions the screens call

const todayIso = () => new Date().toISOString().slice(0, 10);

export async function getQuoteContext(): Promise<QuoteContext> {
  await requireSession();
  if (isDemo()) {
    const used = [...demoStore().map((d) => d.values.quoteNumber), ...demoUsedNumbers];
    return {
      customers: demoCustomers.map((c) => ({ id: c.id, name: c.name, postcode: c.postcode, addressLine: c.addressLines[0] ?? '' })),
      jobTypes: demoJobTypes,
      bankAccounts: demoBankAccounts,
      defaults: demoQuoteDefaults,
      suggestedNumber: suggestNextNumber(used),
      today: todayIso(),
    };
  }
  const client = await ownerClient();
  const [custs, jobTypes, bankAccounts, defaults, numbers] = await Promise.all([
    client.from('customers').select('id, name, postcode, address_lines').order('last_activity_at', { ascending: false }).limit(500),
    listJobTypesWith(client),
    listBankAccountsWith(client),
    getQuoteDefaultsWith(client),
    recentNumbersWith(client),
  ]);
  if (custs.error) throw new QuoteError('failed', 'Could not load customers');
  return {
    customers: ((custs.data ?? []) as { id: string; name: string; postcode: string | null; address_lines: string[] | null }[]).map((c) => ({
      id: c.id,
      name: c.name,
      postcode: c.postcode ?? '',
      addressLine: c.address_lines?.[0] ?? '',
    })),
    jobTypes,
    bankAccounts,
    defaults,
    suggestedNumber: suggestNextNumber(numbers),
    today: todayIso(),
  };
}

/** The label of one job type, for context given to the wording tool. Empty when the type is not listed or not found. */
export async function getJobTypeLabel(id: string): Promise<string> {
  await requireSession();
  if (id === '') return '';
  if (isDemo()) return demoJobTypes.find((t) => t.id === id)?.label ?? '';
  if (!isRealId(id)) return '';
  const { data } = await (await ownerClient()).from('job_types').select('label').eq('id', id).maybeSingle();
  return (data as { label?: string } | null)?.label ?? '';
}

export async function getQuoteVatRateBp(): Promise<number> {
  await requireSession();
  if (isDemo()) return demoQuoteDefaults.vatRateBp;
  return (await getQuoteDefaultsWith(await ownerClient())).vatRateBp;
}

export async function checkQuoteNumber(quoteNumber: string): Promise<boolean> {
  await requireSession();
  if (typeof quoteNumber !== 'string' || !NUMBER_RE.test(quoteNumber.trim()) || quoteNumberReserved(quoteNumber.trim()) !== null) return false;
  const n = quoteNumber.trim();
  if (isDemo()) return !demoUsedNumbers.includes(n) && !demoStore().some((d) => d.values.quoteNumber === n);
  return numberIsFreeWith(await ownerClient(), n);
}

export async function saveQuoteDraft(form: QuoteFormValues, jobId: string | null, opts: SaveOptions = {}): Promise<SavedDraft> {
  const s = await requireSession();
  if (isDemo()) return demoSave(form, jobId, demoQuoteDefaults.vatRateBp, opts);
  const client = await ownerClient();
  const defaults = await getQuoteDefaultsWith(client);
  return saveDraftWith(client, s.tenantId, form, jobId, defaults.vatRateBp, todayIso(), opts);
}

export async function getQuoteDraft(jobId: string): Promise<QuoteDraft | null> {
  await requireSession();
  if (isDemo()) {
    const row = demoStore().find((r) => r.jobId === jobId);
    return row ? { jobId: row.jobId, documentId: `demo-doc-${row.jobId}`, values: structuredClone(row.values), customerName: demoCustomerName(row.values.customerId) } : null;
  }
  return getDraftWith(await ownerClient(), jobId);
}

export async function listDraftQuotes(): Promise<DraftListItem[]> {
  await requireSession();
  if (isDemo()) {
    return demoStore().map((r) => ({ jobId: r.jobId, quoteNumber: r.values.quoteNumber, customerName: demoCustomerName(r.values.customerId), date: r.values.date }));
  }
  return listDraftsWith(await ownerClient());
}
