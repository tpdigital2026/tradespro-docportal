/**
 * Where a job is in its paperwork. Pure: no I/O, no money arithmetic.
 *
 * The stage is derived, never stored. The steps depend on how the job is billed:
 *   Quoted, then Invoiced and Paid for each instalment, then Guarantee issued.
 * So a job paid in full has 4 steps, a deposit job 6, and a job in five stages 12 (up to 22 for ten stages).
 *
 * Facts in, progress out:
 *  - an instalment is Invoiced once a final or sent invoice exists for it (a draft does not count; corrections are new versions of the same numbered document, never a new number);
 *  - it is Paid once the recorded payments against it add up to at least its gross amount;
 *  - the guarantee step is done once a final or sent guarantee exists.
 * The current step is the last one reached without a gap. A step skipped over does not count.
 *
 * When the job has a final survey report, a "Surveyed" step comes first, before Quoted. A job with a final survey
 * and no issued quote yet is shown with surveyedOnlyProgress (next step: write the quote).
 */

export const DOC_TYPES = [
  'quotation',
  'deposit-invoice',
  'balance-invoice',
  'invoice-full',
  'invoice-stage',
  'receipt',
  'guarantee',
  'survey',
] as const;

export type DocType = (typeof DOC_TYPES)[number];

export const INVOICE_TYPES = ['deposit-invoice', 'balance-invoice', 'invoice-full', 'invoice-stage'] as const satisfies readonly DocType[];
export type InvoiceType = (typeof INVOICE_TYPES)[number];

export const isInvoiceType = (t: string): t is InvoiceType => (INVOICE_TYPES as readonly string[]).includes(t);
export const isDocType = (t: string): t is DocType => (DOC_TYPES as readonly string[]).includes(t);

export const DOC_TYPE_NAMES: Record<DocType, string> = {
  quotation: 'Quotation',
  'deposit-invoice': 'Deposit invoice',
  'balance-invoice': 'Balance invoice',
  'invoice-full': 'Full invoice',
  'invoice-stage': 'Stage invoice',
  receipt: 'Receipt',
  guarantee: 'Guarantee certificate',
  survey: 'Survey report',
};

/** The database enum uses underscores. */
export const DB_DOC_TYPES: Record<DocType, string> = {
  quotation: 'quotation',
  'deposit-invoice': 'deposit_invoice',
  'balance-invoice': 'balance_invoice',
  'invoice-full': 'invoice_full',
  'invoice-stage': 'invoice_stage',
  receipt: 'receipt',
  guarantee: 'guarantee',
  survey: 'survey_report',
};

export function docTypeFromDb(raw: string): DocType | null {
  const hit = (Object.entries(DB_DOC_TYPES) as [DocType, string][]).find(([, db]) => db === raw);
  return hit ? hit[0] : null;
}

export type PlanKind = 'deposit' | 'full' | 'staged';
export type DocStatus = 'draft' | 'final' | 'sent' | 'void';

export interface StageInstalment {
  index: number;
  label: string;
  grossPence: number;
}
export interface StagePayment {
  /** Which instalment the paid invoice belongs to (1-based). */
  instalment: number;
  amountPence: number;
  /** Whether a receipt has been started for this payment. */
  receiptLinked?: boolean;
}
export interface StageDocument {
  type: DocType;
  /** The instalment this invoice or receipt belongs to; null for documents that are not tied to one. */
  instalment: number | null;
  status: DocStatus;
}

export interface ProgressStep {
  key: string;
  /** Said in words under the rail, so colour is never the only signal. */
  label: string;
}

export interface NextStep {
  label: string;
  type: DocType;
  /** create: start a new document; mark-paid: record a payment against the invoice already raised. */
  action: 'create' | 'mark-paid';
  instalment: number | null;
  /** For mark-paid: what is still to come in, in pence. */
  remainingPence?: number;
}

export interface JobProgress {
  steps: ProgressStep[];
  /** Index into steps of the last step reached. */
  currentIndex: number;
  next: NextStep | null;
  /** Instalments with at least one recorded payment that has no receipt started. */
  receiptsDue: number[];
}

const sum = (xs: number[]) => xs.reduce((s, n) => s + n, 0);

export function invoiceTypeFor(kind: PlanKind, index: number): InvoiceType {
  if (kind === 'full') return 'invoice-full';
  if (kind === 'deposit') return index === 1 ? 'deposit-invoice' : 'balance-invoice';
  return 'invoice-stage';
}

/** How an instalment is called in words: "deposit", "balance", "invoice" or "stage 2". */
function noun(kind: PlanKind, index: number): string {
  if (kind === 'full') return 'invoice';
  if (kind === 'deposit') return index === 1 ? 'deposit' : 'balance';
  return `stage ${index}`;
}

function raiseLabel(kind: PlanKind, index: number): string {
  if (kind === 'full') return 'Raise full invoice';
  return `Raise ${noun(kind, index)} invoice`;
}

function invoicedLabel(kind: PlanKind, index: number, count: number): string {
  if (kind === 'full') return 'Invoiced';
  if (kind === 'deposit') return index === 1 ? 'Deposit invoiced' : 'Balance invoiced';
  return `Stage ${index} of ${count} invoiced`;
}

function paidLabel(kind: PlanKind, index: number, count: number): string {
  if (index === count) return 'Paid in full';
  if (kind === 'deposit') return 'Deposit paid';
  return `Stage ${index} of ${count} paid`;
}

const live = (s: DocStatus) => s === 'final' || s === 'sent';

export function deriveJobStage(
  plan: { kind: PlanKind },
  instalments: StageInstalment[],
  payments: StagePayment[],
  documents: StageDocument[],
): JobProgress {
  const list = [...instalments].sort((a, b) => a.index - b.index);
  const count = list.length;
  const surveyed = documents.some((d) => d.type === 'survey' && live(d.status));
  const steps: ProgressStep[] = [...(surveyed ? [{ key: 'surveyed', label: 'Surveyed' }] : []), { key: 'quoted', label: 'Quoted' }];
  const done: boolean[] = surveyed ? [true, true] : [true];
  const paidSoFar = (i: number) => sum(payments.filter((p) => p.instalment === i).map((p) => p.amountPence));

  for (const inst of list) {
    const type = invoiceTypeFor(plan.kind, inst.index);
    steps.push({ key: `invoiced:${inst.index}`, label: invoicedLabel(plan.kind, inst.index, count) });
    done.push(documents.some((d) => d.type === type && d.instalment === inst.index && live(d.status)));
    steps.push({ key: `paid:${inst.index}`, label: paidLabel(plan.kind, inst.index, count) });
    done.push(inst.grossPence > 0 && paidSoFar(inst.index) >= inst.grossPence);
  }
  steps.push({ key: 'guarantee', label: 'Guarantee issued' });
  done.push(documents.some((d) => d.type === 'guarantee' && live(d.status)));

  let currentIndex = 0;
  while (currentIndex + 1 < steps.length && done[currentIndex + 1]) currentIndex += 1;

  let next: NextStep | null = null;
  const at = currentIndex + 1;
  if (at < steps.length) {
    const key = steps[at].key;
    if (key === 'guarantee') {
      next = { label: 'Issue guarantee certificate', type: 'guarantee', action: 'create', instalment: null };
    } else {
      const [kind, n] = key.split(':');
      const index = Number(n);
      const type = invoiceTypeFor(plan.kind, index);
      if (kind === 'invoiced') {
        next = { label: raiseLabel(plan.kind, index), type, action: 'create', instalment: index };
      } else {
        const inst = list.find((x) => x.index === index);
        const paid = paidSoFar(index);
        next = {
          label: paid > 0 ? `Record the rest of ${noun(plan.kind, index)}` : `Mark ${noun(plan.kind, index)} as paid`,
          type,
          action: 'mark-paid',
          instalment: index,
          remainingPence: Math.max(0, (inst?.grossPence ?? 0) - paid),
        };
      }
    }
  }

  const receiptsDue = list.filter((inst) => payments.some((p) => p.instalment === inst.index && !p.receiptLinked)).map((inst) => inst.index);

  return { steps, currentIndex, next, receiptsDue };
}

/** A job with a final survey report and no issued quote yet: Surveyed, then the quote to write. */
export function surveyedOnlyProgress(): JobProgress {
  return {
    steps: [
      { key: 'surveyed', label: 'Surveyed' },
      { key: 'quoted', label: 'Quoted' },
    ],
    currentIndex: 0,
    next: { label: 'Write the quote', type: 'quotation', action: 'create', instalment: null },
    receiptsDue: [],
  };
}

export interface HrefOptions {
  /** The instalment the document is for (1-based). */
  n?: number;
  /** For a receipt: the recorded payment it confirms. */
  payment?: string;
}

export function newDocumentHref(type: DocType, job?: string, opts: HrefOptions = {}): string {
  const q = new URLSearchParams({ type });
  if (job) q.set('job', job);
  if (job && opts.n) q.set('n', String(opts.n));
  if (job && opts.payment) q.set('payment', opts.payment);
  return `/documents/new?${q.toString()}`;
}

export function jobHref(job: string, instalment?: number): string {
  return `/documents/jobs/${encodeURIComponent(job)}${instalment ? `#instalment-${instalment}` : ''}`;
}

/** Where a next step goes: a new document, or the job page where the payment is recorded. */
export function nextStepHref(step: NextStep, job: string): string {
  if (step.action === 'mark-paid') return jobHref(job, step.instalment ?? undefined);
  return newDocumentHref(step.type, job, step.instalment ? { n: step.instalment } : {});
}

export const MAX_RECEIPTS_PER_INSTALMENT = 99;

/**
 * Numbers follow the job's quote number: INV-{q}-D, INV-{q}-B, INV-{q}, INV-{q}-S{n}, and for receipts
 * RCP-{q}-D, RCP-{q}-B, RCP-{q}, RCP-{q}-S{n}. Each payment has its own receipt: the first one on an instalment has
 * the plain number, the next ones add -2 to -99 (RCP-{q}-S3-2). seq is that 1-based position; it is ignored for invoices.
 * The database enforces the same patterns.
 */
export function documentNumberFor(type: DocType, quote: string, kind: PlanKind, index: number, seq = 1): string | null {
  if (type === 'receipt') {
    if (!Number.isInteger(seq) || seq < 1 || seq > MAX_RECEIPTS_PER_INSTALMENT) return null;
    let base: string | null;
    if (kind === 'full') base = index === 1 ? `RCP-${quote}` : null;
    else if (kind === 'deposit') base = index === 1 ? `RCP-${quote}-D` : index === 2 ? `RCP-${quote}-B` : null;
    else base = index >= 1 && index <= 10 ? `RCP-${quote}-S${index}` : null;
    return base === null ? null : seq === 1 ? base : `${base}-P${seq}`;
  }
  if (type === 'deposit-invoice') return kind === 'deposit' && index === 1 ? `INV-${quote}-D` : null;
  if (type === 'balance-invoice') return kind === 'deposit' && index === 2 ? `INV-${quote}-B` : null;
  if (type === 'invoice-full') return kind === 'full' && index === 1 ? `INV-${quote}` : null;
  if (type === 'invoice-stage') return kind === 'staged' && index >= 1 && index <= 10 ? `INV-${quote}-S${index}` : null;
  return null;
}

/** The instalment a stored invoice or receipt number refers to, or null when it does not match the job's patterns. */
export function instalmentFromNumber(type: DocType, number: string, quote: string, kind: PlanKind, count: number): number | null {
  const seqs = type === 'receipt' ? MAX_RECEIPTS_PER_INSTALMENT : 1;
  for (let i = 1; i <= count; i += 1) for (let k = 1; k <= seqs; k += 1) if (documentNumberFor(type, quote, kind, i, k) === number) return i;
  return null;
}

/** Jobs furthest from done come first, so the most urgent paperwork leads. Finished jobs are dropped. */
export function byUrgency<T extends { progress: JobProgress; quoteNumber?: string }>(jobs: T[]): T[] {
  const fraction = (p: JobProgress) => p.currentIndex / Math.max(1, p.steps.length - 1);
  return [...jobs]
    .filter((j) => j.progress.next !== null)
    .sort((a, b) => fraction(a.progress) - fraction(b.progress) || String(a.quoteNumber ?? '').localeCompare(String(b.quoteNumber ?? '')));
}
