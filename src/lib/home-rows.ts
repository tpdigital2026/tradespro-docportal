/**
 * Home's one table: drafts, surveyed jobs and issued jobs as one list of rows, each with its stage in words, one next
 * step and when it last changed. Pure: no I/O, so it is unit tested on its own.
 */
import { DOC_TYPE_NAMES, isInvoiceType, jobHref, newDocumentHref, nextStepHref, type JobProgress } from './job-stage';

export type HomeView = 'action' | 'quotes' | 'waiting' | 'all' | 'invoice';
export const HOME_VIEWS: { key: Exclude<HomeView, 'invoice'>; label: string }[] = [
  { key: 'action', label: 'Needs action' },
  { key: 'quotes', label: 'Quotes to finish' },
  { key: 'waiting', label: 'Waiting for payment' },
  { key: 'all', label: 'All' },
];
export const parseView = (raw: unknown): HomeView => (raw === 'quotes' || raw === 'waiting' || raw === 'all' || raw === 'invoice' || raw === 'action' ? raw : 'action');
export const viewHref = (v: HomeView) => (v === 'action' ? '/#jobs' : `/?view=${v}#jobs`);

/** Semantic status colour, always paired with words: green paid, amber waiting, neutral everything else. */
export type Tone = 'neutral' | 'amber' | 'green';

export interface HomeRow {
  key: string;
  customer: string;
  /** "Quote FJC-1043" */
  job: string;
  address: string;
  stage: string;
  tone: Tone;
  next: { label: string; href: string } | null;
  /** A second, quieter step on the same row: a receipt still to send. */
  extra: { label: string; href: string } | null;
  /** Where the row opens. */
  href: string;
  /** yyyy-mm-dd, or null when nothing is dated. */
  updated: string | null;
  kind: 'draft' | 'surveyed' | 'job';
  needsAction: boolean;
  waiting: boolean;
  readyToInvoice: boolean;
}

export interface JobIn {
  quoteNumber: string;
  customerName: string;
  addressLine: string;
  progress: JobProgress;
}
export interface DraftIn {
  jobId: string;
  documentId: string | null;
  quoteNumber: string;
  customerName: string;
  date: string;
}

export const draftHref = (d: Pick<DraftIn, 'jobId' | 'documentId'>) => (d.documentId ? `/documents/${d.documentId}` : `/documents/new?type=quotation&draft=${d.jobId}`);

function toneFor(p: JobProgress, label: string): Tone {
  if (p.next?.action === 'mark-paid') return 'amber';
  if (/paid|issued/i.test(label)) return 'green';
  return 'neutral';
}

/**
 * Jobs come in the order given (most urgent first), surveyed jobs first. A surveyed job whose quote is already a
 * draft shows once, as the draft. `updated` maps a quote number to its newest document date.
 */
export function buildHomeRows(jobs: JobIn[], drafts: DraftIn[], updated: Map<string, string> = new Map()): HomeRow[] {
  const draftNumbers = new Set(drafts.map((d) => d.quoteNumber));
  const rows: HomeRow[] = [];
  for (const j of jobs) {
    const surveyed = j.progress.steps.length === 2 && j.progress.steps[0].key === 'surveyed' && j.progress.next?.type === 'quotation';
    if (surveyed && draftNumbers.has(j.quoteNumber)) continue;
    const label = j.progress.steps[j.progress.currentIndex]?.label ?? '';
    const next = j.progress.next;
    const due = j.progress.receiptsDue[0];
    const extra = due ? { label: `Create ${DOC_TYPE_NAMES.receipt.toLowerCase()}`, href: newDocumentHref('receipt', j.quoteNumber, { n: due }) } : null;
    const waiting = next?.action === 'mark-paid';
    rows.push({
      key: `job:${j.quoteNumber}`,
      customer: j.customerName,
      job: `Quote ${j.quoteNumber}`,
      address: j.addressLine,
      stage: next === null ? 'All done' : label,
      tone: next === null ? 'green' : toneFor(j.progress, label),
      next: next ? { label: next.label, href: nextStepHref(next, j.quoteNumber) } : null,
      extra,
      href: jobHref(j.quoteNumber),
      updated: updated.get(j.quoteNumber) ?? null,
      kind: surveyed ? 'surveyed' : 'job',
      needsAction: (next !== null && !waiting) || extra !== null,
      waiting,
      readyToInvoice: next?.action === 'create' && isInvoiceType(next.type),
    });
  }
  for (const d of drafts) {
    const href = draftHref(d);
    rows.push({
      key: `draft:${d.jobId}`,
      customer: d.customerName,
      job: `Quote ${d.quoteNumber}`,
      address: '',
      stage: 'Draft quote',
      tone: 'neutral',
      next: { label: 'Finish the quote', href },
      extra: null,
      href,
      updated: d.date || null,
      kind: 'draft',
      needsAction: true,
      waiting: false,
      readyToInvoice: false,
    });
  }
  return rows;
}

export function rowsFor(rows: HomeRow[], view: HomeView): HomeRow[] {
  switch (view) {
    case 'action':
      return rows.filter((r) => r.needsAction);
    case 'quotes':
      return rows.filter((r) => r.kind === 'draft');
    case 'waiting':
      return rows.filter((r) => r.waiting);
    case 'invoice':
      return rows.filter((r) => r.readyToInvoice);
    default:
      return rows;
  }
}

/** The four figures above the table. Jobs in progress counts issued and surveyed jobs that still have a step to take. */
export function homeFigures(rows: HomeRow[]) {
  return {
    quotes: rows.filter((r) => r.kind === 'draft').length,
    inProgress: rows.filter((r) => r.kind !== 'draft' && r.next !== null).length,
    toInvoice: rows.filter((r) => r.readyToInvoice).length,
    waiting: rows.filter((r) => r.waiting).length,
  };
}

/** Newest document date per quote number, from library items. */
export function latestByQuote(items: { quoteNumber: string; date: string }[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const i of items) {
    const was = m.get(i.quoteNumber);
    if (!was || i.date > was) m.set(i.quoteNumber, i.date);
  }
  return m;
}
