/**
 * Jobs, their invoices and the payments recorded against them.
 *
 * Reads go through the owner's session (row level security scopes them). Recording a payment is a server write
 * on a service connection, with the tenant taken from the session and every id re-checked against it.
 * Demo mode keeps everything in memory.
 */
import { demoCustomers, demoIssuedJobs, demoQuoteDefaults, type DemoIssuedJob } from '../demo-data';
import { demoSlot, isDemo } from '../demo';
import { buildJobBilling, followOnFor, payableInvoice, type JobBilling, type RawDocument, type RawPayment } from '../job-billing';
import { docTypeFromDb, DB_DOC_TYPES, type DocStatus, type DocType } from '../job-stage';
import { planFromJson } from '../payment-plan';
import { checkPayment, outstandingPence, todayLondon, type PaymentFormValues, type PaymentErrors, type RecordablePayment } from '../payment';
import { requireSession } from '../session';
import { normaliseQuote, quoteFormSchema, NUMBER_RE, type QuoteFormValues } from '../validation/quote';
import { withServiceConnection, type Actor, type ServiceDb } from './customer-admin';
import { ownerClient, type DataClient } from './customers';
import { getQuoteDefaultsWith, isRealId } from './quotes';
import { retryOnDeadlock } from './retry';

export interface JobSummary {
  jobId: string;
  quoteNumber: string;
  customerId: string;
  customerName: string;
  addressLine: string;
  /** False when the billing could not be worked out; the message says why. */
  billing: JobBilling | null;
  problem: string | null;
}

export class BillingError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid' | 'not_payable' | 'failed',
    message: string,
    readonly errors?: PaymentErrors,
  ) {
    super(message);
    this.name = 'BillingError';
  }
}

const STATUSES: readonly string[] = ['draft', 'final', 'sent', 'void'];

// ---------------------------------------------------------------- real reads (the owner's session)

interface JobRow {
  id: string;
  reference: string;
  customer_id: string;
  property_address: string | null;
  payment_plan: unknown;
}

/**
 * Loads jobs with their documents, payments and the latest quote version, in a handful of flat queries.
 * `reference` picks one job; otherwise the most recent jobs whose quote has been issued.
 */
export async function loadJobSummariesWith(client: DataClient, opts: { reference?: string; limit?: number } = {}): Promise<JobSummary[]> {
  // Three round trips, not six: defaults with the jobs, then documents, payments and customers together, then the
  // quote versions (which need the documents). Errors are still checked, and thrown, in the same order as before.
  const jobsQ = client.from('jobs').select('id, reference, customer_id, property_address, payment_plan');
  const [defaults, jobsRes] = await Promise.all([
    getQuoteDefaultsWith(client),
    opts.reference ? jobsQ.eq('reference', opts.reference).limit(1) : jobsQ.order('created_at', { ascending: false }).limit(opts.limit ?? 50),
  ]);
  if (jobsRes.error) throw new BillingError('failed', 'Could not load jobs');
  const jobs = (jobsRes.data ?? []) as JobRow[];
  if (jobs.length === 0) return [];
  const jobIds = jobs.map((j) => j.id);

  const [docsRes, payRes, custRes] = await Promise.all([
    client.from('documents').select('id, job_id, type, number, status, current_version_id').in('job_id', jobIds).limit(2000),
    client.from('payments').select('id, job_id, document_id, amount_pence, paid_on, method, note, receipt_document_id').in('job_id', jobIds).order('created_at', { ascending: true }).order('id', { ascending: true }).limit(2000),
    client.from('customers').select('id, name').in('id', [...new Set(jobs.map((j) => j.customer_id))]),
  ]);
  if (docsRes.error) throw new BillingError('failed', 'Could not load documents');
  const docRows = (docsRes.data ?? []) as { id: string; job_id: string; type: string; number: string; status: string; current_version_id?: string | null }[];

  const quoteDocs = docRows.filter((d) => d.type === DB_DOC_TYPES.quotation);
  // Each quote's current version, read by id: exactly one row per quote, so no limit can push the issued version out
  // of the result (a revise or a new draft version always moves current_version_id to the newest version).
  const currentIds = [...new Set(quoteDocs.map((d) => d.current_version_id).filter((x): x is string => typeof x === 'string'))];
  const verRes = currentIds.length
    ? await client.from('document_versions').select('id, document_id, version, input, final_content').in('id', currentIds)
    : { data: [], error: null };
  if (verRes.error) throw new BillingError('failed', 'Could not load the quotes');
  const latest = new Map<string, unknown>();
  // The VAT rate the issued quote was finalised at, read from the issued version (current_version_id), never from a
  // newer draft: the job's money stays at that rate whatever the setting is today.
  const issuedRate = new Map<string, number>();
  const currentOf = new Map(quoteDocs.filter((d) => d.current_version_id).map((d) => [d.current_version_id as string, d]));
  for (const v of (verRes.data ?? []) as { id: string; document_id: string; input: { form?: unknown } | null; final_content?: { content?: { input?: { vatRateBp?: unknown } } } | null }[]) {
    const doc = currentOf.get(v.id);
    if (!doc || doc.id !== v.document_id) continue;
    latest.set(v.document_id, v.input?.form);
    const r = v.final_content?.content?.input?.vatRateBp;
    if (doc.status !== 'draft' && typeof r === 'number' && Number.isSafeInteger(r)) issuedRate.set(doc.id, r);
  }
  if (payRes.error) throw new BillingError('failed', 'Could not load payments');
  const payRows = (payRes.data ?? []) as { id: string; job_id: string; document_id: string; amount_pence: number; paid_on: string; method: string; note: string | null; receipt_document_id: string | null }[];

  if (custRes.error) throw new BillingError('failed', 'Could not load customers');
  const names = new Map(((custRes.data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));

  const out: JobSummary[] = [];
  for (const j of jobs) {
    const mine = docRows.filter((d) => d.job_id === j.id);
    const quote = mine.find((d) => d.type === DB_DOC_TYPES.quotation);
    if (!opts.reference && (!quote || quote.status === 'draft')) continue; // Home lists issued jobs only
    const documents: RawDocument[] = [];
    for (const d of mine) {
      const type = docTypeFromDb(d.type);
      if (type && STATUSES.includes(d.status)) documents.push({ id: d.id, type, number: d.number, status: d.status as DocStatus });
    }
    const payments: RawPayment[] = payRows
      .filter((p) => p.job_id === j.id)
      .map((p) => ({ id: p.id, documentId: p.document_id, amountPence: Number(p.amount_pence), paidOn: p.paid_on, method: p.method, note: p.note, receiptDocumentId: p.receipt_document_id }));
    const base = { jobId: j.id, quoteNumber: j.reference, customerId: j.customer_id, customerName: names.get(j.customer_id) ?? 'Customer', addressLine: j.property_address ?? '' };
    const form = quoteFormSchema.safeParse(quote ? latest.get(quote.id) : undefined);
    const stored = planFromJson(j.payment_plan);
    if (!form.success || !stored) {
      out.push({ ...base, billing: null, problem: 'We cannot work out how this job is billed. Open the quote and check its price and payment plan.' });
      continue;
    }
    const r = buildJobBilling({ quoteNumber: j.reference, plan: stored.plan, form: form.data as QuoteFormValues, vatRateBp: (quote && issuedRate.get(quote.id)) ?? defaults.vatRateBp, documents, payments });
    out.push(r.ok ? { ...base, billing: r.billing, problem: null } : { ...base, billing: null, problem: r.message });
  }
  return out;
}

// ---------------------------------------------------------------- demo mode (in memory, dummy data)

interface DemoState {
  /** Issued jobs: the dummy ones, plus any quote finalised in this demo session. */
  jobs: DemoIssuedJob[];
  documents: Map<string, RawDocument[]>;
  payments: Map<string, RawPayment[]>;
  /** When each demo payment was recorded in this session, for the duplicate window. */
  recordedAt: Map<string, number>;
}

export const DUPLICATE_WINDOW_MS = 30_000;
const demoBox = demoSlot<DemoState>('billing', () => {
  const st: DemoState = { jobs: demoIssuedJobs.map((j) => structuredClone(j)), documents: new Map(), payments: new Map(), recordedAt: new Map() };
  for (const j of demoIssuedJobs) {
    st.documents.set(j.jobId, structuredClone(j.documents));
    st.payments.set(j.jobId, structuredClone(j.payments));
  }
  return st;
});
const demo = (): DemoState => demoBox.get();

/** Test hook: forget demo edits. */
export function resetDemoBilling(): void {
  demoBox.set(null);
}

/** Demo mode only: the in-memory issued jobs, their documents and payments (the Documents library reads these). */
export function demoBillingState(): Readonly<Pick<DemoState, 'jobs' | 'documents' | 'payments'>> {
  return demo();
}

/** Demo mode only: a draft invoice or receipt is deleted (an invoice with a payment against it is refused). */
export function demoDeleteFollowOn(jobId: string, documentId: string): 'deleted' | 'in_use' | 'not_found' | 'issued' {
  const st = demo();
  const docs = st.documents.get(jobId) ?? [];
  const d = docs.find((x) => x.id === documentId);
  if (!d) return 'not_found';
  if (d.status !== 'draft') return 'issued';
  const pays = st.payments.get(jobId) ?? [];
  if (pays.some((p) => p.documentId === documentId)) return 'in_use';
  // A receipt draft: its payment stays and simply has no receipt yet.
  for (const p of pays) if (p.receiptDocumentId === documentId) p.receiptDocumentId = null;
  st.documents.set(jobId, docs.filter((x) => x.id !== documentId));
  return 'deleted';
}

/** Demo mode only: a quote has been finalised, so its job is issued. */
export function demoIssueQuote(job: { jobId: string; form: QuoteFormValues; documentId: string }): void {
  const st = demo();
  const found = st.jobs.find((j) => j.jobId === job.jobId);
  if (found) found.form = structuredClone(job.form);
  else st.jobs.unshift({ jobId: job.jobId, form: structuredClone(job.form), documents: [], payments: [] });
  const docs = st.documents.get(job.jobId) ?? [];
  const q = docs.find((d) => d.type === 'quotation');
  if (q) q.status = 'final';
  else docs.unshift({ id: job.documentId, type: 'quotation', number: job.form.quoteNumber, status: 'final' });
  st.documents.set(job.jobId, docs);
  if (!st.payments.has(job.jobId)) st.payments.set(job.jobId, []);
}

/** Demo mode only: a quote goes back to draft for a new version. Refused when the job has any other document. */
export function demoUnissueQuote(jobId: string): boolean {
  const st = demo();
  const docs = st.documents.get(jobId) ?? [];
  if (docs.some((d) => d.type !== 'quotation')) return false;
  st.jobs = st.jobs.filter((j) => j.jobId !== jobId);
  st.documents.delete(jobId);
  st.payments.delete(jobId);
  return true;
}

/** Demo mode only: a follow-on document is finalised. */
export function demoMarkFinal(jobId: string, documentId: string): void {
  const d = (demo().documents.get(jobId) ?? []).find((x) => x.id === documentId);
  if (d) d.status = 'final';
}

function demoSummary(j: DemoIssuedJob): JobSummary {
  const st = demo();
  const customer = demoCustomers.find((c) => c.id === j.form.customerId);
  const base = {
    jobId: j.jobId,
    quoteNumber: j.form.quoteNumber,
    customerId: j.form.customerId,
    customerName: customer?.name ?? 'Customer',
    addressLine: j.form.propertyAddress,
  };
  // The demo plan inputs are the saved form's; a real job reads them from jobs.payment_plan.
  const r = buildJobBilling({
    quoteNumber: j.form.quoteNumber,
    plan: demoPlan(j.form),
    form: j.form,
    vatRateBp: demoQuoteDefaults.vatRateBp,
    documents: st.documents.get(j.jobId) ?? [],
    payments: st.payments.get(j.jobId) ?? [],
  });
  return r.ok ? { ...base, billing: r.billing, problem: null } : { ...base, billing: null, problem: r.message };
}

function demoPlan(form: QuoteFormValues) {
  return normaliseQuote(form, 'draft', demoQuoteDefaults.vatRateBp).input.plan;
}

// ---------------------------------------------------------------- what the screens call

export async function listJobSummaries(): Promise<JobSummary[]> {
  await requireSession();
  if (isDemo()) return demo().jobs.map(demoSummary);
  return loadJobSummariesWith(await ownerClient());
}

export async function getJobSummary(reference: string): Promise<JobSummary | null> {
  await requireSession();
  if (typeof reference !== 'string' || !NUMBER_RE.test(reference)) return null;
  if (isDemo()) {
    const j = demo().jobs.find((x) => x.form.quoteNumber === reference);
    return j ? demoSummary(j) : null;
  }
  return (await loadJobSummariesWith(await ownerClient(), { reference }))[0] ?? null;
}

// ---------------------------------------------------------------- recording a payment

export interface PaymentRecorded {
  paymentId: string;
  instalment: number;
  remainingPence: number;
  /** The "Create receipt" route is built from these. */
  quoteNumber: string;
  /** True when this was the same payment as one recorded moments ago, so nothing new was written. */
  repeat: boolean;
}

/**
 * The server write, on a service connection in one transaction. Everything that matters is checked again here:
 * the job and the invoice belong to the signed-in business, the invoice is final, and the amount fits what is
 * still owed according to the payments already recorded (read under a lock, so two at once cannot over-pay).
 * A repeat of the same payment within 30 seconds (a double tap) returns the first one instead of recording twice.
 */
export async function recordPaymentWith(
  db: ServiceDb | { query: ServiceDb['query'] },
  actor: Actor,
  args: { jobId: string; invoiceId: string; grossPence: number; payment: RecordablePayment },
): Promise<{ paymentId: string; paidPence: number; repeat: boolean }> {
  // A deadlock (40P01) rolls the whole attempt back, so trying once more is safe.
  return retryOnDeadlock(() => recordPaymentOnce(db, actor, args));
}

async function recordPaymentOnce(
  db: ServiceDb | { query: ServiceDb['query'] },
  actor: Actor,
  args: { jobId: string; invoiceId: string; grossPence: number; payment: RecordablePayment },
): Promise<{ paymentId: string; paidPence: number; repeat: boolean }> {
  await db.query('begin');
  try {
    await db.query('reset role');
    await db.query(`select set_config('request.jwt.claims', '', true)`);
    // The job row first, then the invoice: the same order as finalise, revise and follow-on saves (README "Server code
    // rules"). The payment insert takes a key share on the job row through its foreign key; holding the job row
    // already means that share can never wait behind a finalise that holds the job and wants this invoice.
    const job = await db.query(`select id from public.jobs where id = $1 and tenant_id = $2 for update`, [args.jobId, actor.tenantId]);
    if (!job.rows[0]) throw new BillingError('not_found', 'That invoice could not be found.');
    // Then the invoice row, so concurrent payments queue.
    const inv = await db.query(
      `select d.id, d.status::text as status, d.type::text as type from public.documents d
       where d.id = $1 and d.tenant_id = $2 and d.job_id = $3 for update`,
      [args.invoiceId, actor.tenantId, args.jobId],
    );
    const row = inv.rows[0] as { status: string; type: string } | undefined;
    if (!row) throw new BillingError('not_found', 'That invoice could not be found.');
    if (row.status !== 'final' && row.status !== 'sent') throw new BillingError('not_payable', 'Only an invoice that has been finalised can be marked as paid.');
    const dup = await db.query(
      `select id from public.payments where tenant_id = $1 and document_id = $2 and amount_pence = $3 and paid_on = $4 and method = $5
         and created_by is not distinct from $6 and created_at > now() - interval '30 seconds' limit 1`,
      [actor.tenantId, args.invoiceId, args.payment.amountPence, args.payment.paidOn, args.payment.method, actor.userId],
    );
    const paid = await db.query(`select coalesce(sum(amount_pence), 0)::bigint as paid from public.payments where document_id = $1 and tenant_id = $2`, [args.invoiceId, actor.tenantId]);
    const paidPence = Number(paid.rows[0]?.paid ?? 0);
    if (dup.rows[0]) {
      await db.query('commit');
      return { paymentId: String(dup.rows[0].id), paidPence, repeat: true };
    }
    if (paidPence + args.payment.amountPence > args.grossPence) {
      throw new BillingError('invalid', 'That is more than is still owed on this invoice.', { amount: 'That is more than is still owed on this invoice' });
    }
    const ins = await db.query(
      `insert into public.payments (tenant_id, job_id, document_id, amount_pence, paid_on, method, note, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [actor.tenantId, args.jobId, args.invoiceId, args.payment.amountPence, args.payment.paidOn, args.payment.method, args.payment.note, actor.userId],
    );
    await db.query('commit');
    return { paymentId: String(ins.rows[0].id), paidPence: paidPence + args.payment.amountPence, repeat: false };
  } catch (e) {
    await db.query('rollback').catch(() => undefined);
    throw e;
  }
}

const todayIso = () => todayLondon();

/**
 * "Mark as paid". The caller is a server action: session, then this. Validates what the owner typed, recomputes the
 * job's billing from the saved quote, and records the payment against the final invoice for that instalment.
 */
export async function markAsPaid(reference: string, instalment: number, raw: PaymentFormValues): Promise<PaymentRecorded> {
  const s = await requireSession();
  if (typeof reference !== 'string' || !NUMBER_RE.test(reference) || !Number.isInteger(instalment) || instalment < 1 || instalment > 10) {
    throw new BillingError('not_found', 'That invoice could not be found.');
  }
  const job = await getJobSummary(reference);
  if (!job || !job.billing) throw new BillingError('not_found', 'That job could not be found.');
  const b = job.billing;
  const inst = b.instalments.find((i) => i.index === instalment);
  const invoice = inst ? payableInvoice(b, instalment) : null;
  if (!inst) throw new BillingError('not_found', 'That part of the job could not be found.');
  if (!invoice) throw new BillingError('not_payable', 'Only an invoice that has been finalised can be marked as paid.');
  const outstanding = outstandingPence(inst.grossPence, b.payments.filter((p) => p.instalment === instalment).map((p) => p.amountPence));
  const checked = checkPayment(raw, outstanding, todayIso());
  if (!checked.ok) throw new BillingError('invalid', 'Check the highlighted fields', checked.errors);

  if (isDemo()) {
    const st = demo();
    const list = st.payments.get(job.jobId) ?? [];
    const now = Date.now();
    const dup = list.find((p) => p.documentId === invoice.id && p.amountPence === checked.value.amountPence && p.paidOn === checked.value.paidOn && p.method === checked.value.method && now - (st.recordedAt.get(p.id) ?? 0) < DUPLICATE_WINDOW_MS);
    const id = dup?.id ?? `demo-payment-${job.jobId.replace(/^demo-job-/, '')}-${list.length + 1}-${now % 100000}`;
    if (!dup) st.recordedAt.set(id, now);
    if (!dup) list.push({ id, documentId: invoice.id, amountPence: checked.value.amountPence, paidOn: checked.value.paidOn, method: checked.value.method, note: checked.value.note, receiptDocumentId: null });
    st.payments.set(job.jobId, list);
    return { paymentId: id, instalment, remainingPence: outstanding - (dup ? 0 : checked.value.amountPence), quoteNumber: reference, repeat: Boolean(dup) };
  }
  if (!isRealId(job.jobId) || !isRealId(invoice.id)) throw new BillingError('failed', 'Could not record that payment.');
  const result = await withServiceConnection((db) =>
    recordPaymentWith(db, { tenantId: s.tenantId, userId: s.userId }, { jobId: job.jobId, invoiceId: invoice.id, grossPence: inst.grossPence, payment: checked.value }),
  );
  return { paymentId: result.paymentId, instalment, remainingPence: Math.max(0, inst.grossPence - result.paidPence), quoteNumber: reference, repeat: result.repeat };
}

// ---------------------------------------------------------------- follow-on drafts (an invoice or receipt started from a job)

export interface FollowOnSaved {
  documentId: string;
  number: string;
  /** True when the document was created now; false when it was already there (a retry, or a repair). */
  created: boolean;
}

export interface FollowOnWrite {
  jobId: string;
  type: DocType;
  number: string;
  instalment: number;
  heading: string;
  netPence: number;
  vatPence: number;
  grossPence: number;
  date: string;
  /** For a receipt: the payment it confirms. */
  paymentId: string | null;
}

/**
 * Writes a draft invoice or receipt for a job in ONE transaction on the service connection: the document, its first
 * version, the current-version pointer and, for a receipt, the link from the payment. A failure anywhere rolls the lot
 * back, so a number is never burnt and a version-less draft never left behind. Idempotent and self-healing: a document
 * that already has this number is completed rather than duplicated (missing version created, unlinked payment linked).
 * Production owns begin/commit; tests pass nested: true inside their own rolled-back transaction.
 */
export async function saveFollowOnWith(db: { query: ServiceDb['query'] }, actor: Actor, w: FollowOnWrite, o: { nested?: boolean } = {}): Promise<FollowOnSaved> {
  // Production owns the transaction, so a deadlock (40P01) rolled all of it back and one more try is safe. Inside a
  // caller's transaction (tests) a deadlock has already aborted that transaction, so it is passed straight up.
  return o.nested === true ? saveFollowOnOnce(db, actor, w, true) : retryOnDeadlock(() => saveFollowOnOnce(db, actor, w, false));
}

async function saveFollowOnOnce(db: { query: ServiceDb['query'] }, actor: Actor, w: FollowOnWrite, nested: boolean): Promise<FollowOnSaved> {
  await db.query(nested ? 'savepoint followon_tx' : 'begin');
  try {
    if (!nested) {
      await db.query('reset role');
      await db.query(`select set_config('request.jwt.claims', '', true)`);
    }
    // The job row is locked so two saves of the same document queue up instead of racing.
    const job = await db.query(`select id from public.jobs where id = $1 and tenant_id = $2 for update`, [w.jobId, actor.tenantId]);
    if (!job.rows[0]) throw new BillingError('not_found', 'That job could not be found.');

    let created = false;
    let doc = await db.query(`select id, type::text as type from public.documents where job_id = $1 and tenant_id = $2 and number = $3 for update`, [w.jobId, actor.tenantId, w.number]);
    if (!doc.rows[0]) {
      doc = await db.query(
        `insert into public.documents (tenant_id, job_id, type, number, doc_date, created_by) values ($1, $2, $3::public.doc_type, $4, $5, $6) returning id, type::text as type`,
        [actor.tenantId, w.jobId, DB_DOC_TYPES[w.type], w.number, w.date, actor.userId],
      );
      created = true;
    } else if (doc.rows[0].type !== DB_DOC_TYPES[w.type]) {
      throw new BillingError('invalid', 'That document number is already used for something else.');
    }
    const documentId = String(doc.rows[0].id);

    let ver = await db.query(`select id, input from public.document_versions where document_id = $1 and tenant_id = $2 and version = 1`, [documentId, actor.tenantId]);
    if (ver.rows[0]) {
      // Repairing: the receipt on record must be for this very payment. Positions can shift; a payment is never linked to another's receipt.
      const theirs = (ver.rows[0].input as { followOn?: { paymentId?: string | null } } | null)?.followOn?.paymentId ?? null;
      // Both ways round: a version made for a payment is never reused by a save that names no payment (or another one).
      if (theirs !== w.paymentId) throw new BillingError('invalid', w.paymentId === null ? 'That document number already belongs to a receipt for a payment, so it cannot be used here.' : 'That receipt number already belongs to a different payment, so it cannot be used for this one.');
    } else {
      const input = { schema: 1, followOn: { instalment: w.instalment, heading: w.heading, netPence: w.netPence, vatPence: w.vatPence, grossPence: w.grossPence, paymentId: w.paymentId } };
      ver = await db.query(
        `insert into public.document_versions (tenant_id, document_id, version, input, created_by) values ($1, $2, 1, $3::jsonb, $4) returning id`,
        [actor.tenantId, documentId, JSON.stringify(input), actor.userId],
      );
    }
    await db.query(`update public.documents set current_version_id = $1 where id = $2 and tenant_id = $3 and current_version_id is null`, [String(ver.rows[0].id), documentId, actor.tenantId]);

    if (w.paymentId) {
      const pay = await db.query(`select receipt_document_id from public.payments where id = $1 and tenant_id = $2 and job_id = $3 for update`, [w.paymentId, actor.tenantId, w.jobId]);
      if (!pay.rows[0]) throw new BillingError('not_found', 'That payment could not be found.');
      const linked = pay.rows[0].receipt_document_id as string | null;
      if (linked === null) await db.query(`update public.payments set receipt_document_id = $1 where id = $2 and tenant_id = $3`, [documentId, w.paymentId, actor.tenantId]);
      else if (linked !== documentId) throw new BillingError('invalid', 'That payment already has a different receipt.');
    }
    await db.query(nested ? 'release savepoint followon_tx' : 'commit');
    return { documentId, number: w.number, created };
  } catch (e) {
    await db.query(nested ? 'rollback to savepoint followon_tx' : 'rollback').catch(() => undefined);
    const code = (e as { code?: string }).code;
    if (code === '23505') throw new BillingError('invalid', 'That document number has already been used.');
    if (code === '23514') {
      const msg = String((e as { message?: string }).message ?? '');
      throw new BillingError('invalid', /does not match its job/.test(msg) ? 'That document number does not fit this job.' : 'That could not be saved because it breaks a rule on the data.');
    }
    throw e;
  }
}

/**
 * "Save as draft" on an invoice or receipt started from a job. The figures and the number are recomputed here from
 * the saved quote and the recorded payments, never taken from the browser.
 */
export async function saveFollowOnDraft(reference: string, type: DocType, instalment: number | null, paymentId: string | null): Promise<FollowOnSaved> {
  const s = await requireSession();
  const job = await getJobSummary(reference);
  if (!job || !job.billing) throw new BillingError('not_found', 'That job could not be found.');
  const r = followOnFor(job.billing, type, instalment, paymentId);
  if (!r.ok) throw new BillingError('invalid', r.message);
  const f = r.followOn;
  if (isDemo()) {
    const st = demo();
    const docs = st.documents.get(job.jobId) ?? [];
    const found = docs.find((d) => d.number === f.number);
    const id = found?.id ?? `demo-doc-${job.jobId.replace(/^demo-job-/, '')}-${f.number.toLowerCase()}`;
    if (!found) docs.push({ id, type, number: f.number, status: 'draft' });
    st.documents.set(job.jobId, docs);
    if (f.payment) {
      const p = (st.payments.get(job.jobId) ?? []).find((x) => x.id === f.payment?.id);
      if (p && !p.receiptDocumentId) p.receiptDocumentId = id;
    }
    return { documentId: id, number: f.number, created: !found };
  }
  if (!isRealId(job.jobId)) throw new BillingError('failed', 'Could not save');
  const write: FollowOnWrite = {
    jobId: job.jobId,
    type,
    number: f.number,
    instalment: f.instalment,
    heading: f.heading,
    netPence: f.netPence,
    vatPence: f.vatPence,
    grossPence: f.grossPence,
    date: todayIso(),
    paymentId: f.payment?.id ?? null,
  };
  return withServiceConnection((db) => saveFollowOnWith(db, { tenantId: s.tenantId, userId: s.userId }, write));
}
