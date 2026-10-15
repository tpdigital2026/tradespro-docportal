/**
 * Money: balances owed per job and the log of payments received. Pure, and every figure is a sum of recorded facts:
 *  - quoted: the issued quote version's stored gross;
 *  - invoiced to date: the stored totals of issued (final or sent) invoices;
 *  - received: payments recorded with Mark as paid against those invoices;
 *  - outstanding: the sum of each issued invoice's own outstanding (its total less what was paid on it, never below
 *    zero), so a payment over one invoice never hides another that is unpaid;
 *  - still to invoice: quoted less invoiced to date (never below zero).
 * Nothing is estimated or forecast. Payments are recorded by the owner and are not checked against a bank.
 */
import { isInvoiceType, type DocType } from '../job-stage';
import { addDays, daysBetween, monthOf } from '../london';
import { isLive, type FactDocument, type FactPayment, type JobFacts } from './facts';
import { instalmentOf } from './pipeline';

// ---------------------------------------------------------------- due dates from the business's own wording

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, twenty: 20, 'twenty one': 21, 'twenty eight': 28, thirty: 30, 'thirty one': 31, sixty: 60, ninety: 90,
};
const WORD_ALT = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join('|');

export type DueRule = { kind: 'on-receipt' } | { kind: 'days'; days: number } | { kind: 'check' };

/** An anchor that means the invoice date: "the invoice", "this invoice", "the invoice date", "the date of invoice". */
const INVOICE_ANCHOR = String.raw`(?:of|from|after)\s+(?:the\s+|this\s+)?(?:date\s+of\s+(?:the\s+|this\s+)?)?invoice(?:\s+date)?\b`;

/**
 * Reads a due rule from an invoice's printed wording, only when it is counted from the invoice itself:
 *   "due upon receipt", "payable on receipt"                       -> due on the invoice date (wins over any interest wording)
 *   "within 14 days", "within 14 days of the invoice date"         -> invoice date plus 14 days
 *   "14 days from the invoice", "30 days of the invoice date"      -> invoice date plus N days
 * A count of days from anything else ("of completion", "after the due date") is { kind: 'check' }: no due date, and
 * the screen asks the owner to check it. Wording with no count of days ("Before works start") is null. Never guessed.
 */
export function dueRuleFrom(wording: string | null | undefined): DueRule | null {
  if (!wording) return null;
  const w = wording.normalize('NFKC').toLowerCase().replace(/[-‐-―]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(?:upon|on)\s+receipt\b/.test(w)) return { kind: 'on-receipt' };
  const count = new RegExp(String.raw`\b(\d{1,3}|${WORD_ALT})\s+(?:calendar\s+)?days?\b`).exec(w);
  if (!count) return null;
  const days = /^\d+$/.test(count[1]) ? Number(count[1]) : NUMBER_WORDS[count[1]];
  if (!Number.isInteger(days) || days < 0 || days > 365) return { kind: 'check' };
  const before = w.slice(0, count.index);
  const after = w.slice(count.index + count[0].length).trim();
  if (new RegExp(`^${INVOICE_ANCHOR}`).test(after)) return { kind: 'days', days };
  // "within 14 days" with nothing after it (or the end of a sentence) counts from the invoice.
  if (/\bwithin\s+$/.test(before) && /^(?:[.,;)]|$)/.test(after)) return { kind: 'days', days };
  return { kind: 'check' };
}

/** yyyy-mm-dd the invoice falls due, or null when its wording gives no calendar date counted from the invoice. */
export function dueDateFor(d: Pick<FactDocument, 'docDate' | 'dueWording'>): string | null {
  const r = dueRuleFrom(d.dueWording);
  if (!r || r.kind === 'check') return null;
  return r.kind === 'on-receipt' ? d.docDate : addDays(d.docDate, r.days);
}

// ---------------------------------------------------------------- balances owed

export interface InvoiceLine {
  documentId: string;
  type: DocType;
  number: string;
  /** "Deposit (30%)", "Balance", "Invoice", "Stage 2 of 5". */
  part: string;
  instalment: number | null;
  issuedOn: string;
  grossPence: number;
  receivedPence: number;
  outstandingPence: number;
  dueOn: string | null;
  dueWording: string | null;
  /** The wording counts days from something other than the invoice: no due date, the owner should check it. */
  dueCheck: boolean;
  /** Recorded payments equal the invoice's gross. */
  settled: boolean;
  /** Past its due date (Europe/London), not settled. */
  overdue: boolean;
  /** Days past due, when overdue. */
  daysOverdue: number;
}

export type BalanceFilter = 'all' | 'deposit' | 'balance' | 'overdue' | 'settled';
export const BALANCE_FILTERS: { key: BalanceFilter; label: string }[] = [
  { key: 'all', label: 'All jobs' },
  { key: 'deposit', label: 'Awaiting deposit' },
  { key: 'balance', label: 'Awaiting balance' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'settled', label: 'Settled' },
];
export const isBalanceFilter = (s: unknown): s is BalanceFilter => BALANCE_FILTERS.some((f) => f.key === s);

export interface JobBalance {
  jobId: string;
  quoteNumber: string;
  customerName: string;
  quotedPence: number;
  invoicedPence: number;
  receivedPence: number;
  outstandingPence: number;
  toInvoicePence: number;
  invoices: InvoiceLine[];
  awaitingDeposit: boolean;
  awaitingBalance: boolean;
  overdue: boolean;
  /** Every part of the job has been invoiced and every invoice is settled. */
  settled: boolean;
}

function partLabel(_job: JobFacts, d: FactDocument, n: number | null, count: number): string {
  if (d.type === 'deposit-invoice') return 'Deposit';
  if (d.type === 'balance-invoice') return 'Balance';
  if (d.type === 'invoice-full') return 'Invoice';
  return n ? `Stage ${n} of ${count}` : 'Stage';
}

const paidOn = (payments: FactPayment[], documentId: string) => payments.filter((p) => p.documentId === documentId).reduce((s, p) => s + p.amountPence, 0);

/** One job's balance, or null when no quote has been issued for it. */
export function jobBalance(job: JobFacts, today: string): JobBalance | null {
  if (!job.quote) return null;
  const count = job.quote.schedule?.length ?? 0;
  const invoices: InvoiceLine[] = job.documents
    .filter((d) => isInvoiceType(d.type) && isLive(d.status) && d.totalPence !== null)
    .map((d) => {
      const n = count ? instalmentOf(job, d, count) : null;
      const gross = d.totalPence as number;
      const received = paidOn(job.payments, d.id);
      const dueOn = dueDateFor(d);
      const settled = received >= gross;
      const overdue = !settled && dueOn !== null && today > dueOn;
      return {
        documentId: d.id,
        type: d.type,
        number: d.number,
        part: partLabel(job, d, n, count),
        instalment: n,
        issuedOn: d.docDate,
        grossPence: gross,
        receivedPence: received,
        outstandingPence: Math.max(0, gross - received),
        dueOn,
        dueWording: d.dueWording,
        dueCheck: dueRuleFrom(d.dueWording)?.kind === 'check',
        settled,
        overdue,
        daysOverdue: overdue && dueOn ? daysBetween(dueOn, today) : 0,
      };
    })
    .sort((a, b) => (a.instalment ?? 99) - (b.instalment ?? 99) || a.number.localeCompare(b.number, 'en', { numeric: true }));
  const invoiced = invoices.reduce((s, i) => s + i.grossPence, 0);
  const received = invoices.reduce((s, i) => s + i.receivedPence, 0);
  const allInvoiced = count > 0 && Array.from({ length: count }, (_, i) => i + 1).every((n) => invoices.some((x) => x.instalment === n));
  return {
    jobId: job.jobId,
    quoteNumber: job.quoteNumber,
    customerName: job.customerName,
    quotedPence: job.quote.grossPence,
    invoicedPence: invoiced,
    receivedPence: received,
    outstandingPence: invoices.reduce((s, i) => s + i.outstandingPence, 0),
    toInvoicePence: Math.max(0, job.quote.grossPence - invoiced),
    invoices,
    awaitingDeposit: invoices.some((i) => i.type === 'deposit-invoice' && !i.settled),
    awaitingBalance: invoices.some((i) => i.type !== 'deposit-invoice' && !i.settled),
    overdue: invoices.some((i) => i.overdue),
    settled: allInvoiced && invoices.every((i) => i.settled),
  };
}

export function matchesFilter(b: JobBalance, f: BalanceFilter): boolean {
  if (f === 'deposit') return b.awaitingDeposit;
  if (f === 'balance') return b.awaitingBalance;
  if (f === 'overdue') return b.overdue;
  if (f === 'settled') return b.settled;
  return true;
}

export interface Balances {
  rows: JobBalance[];
  /** Over every job, whatever the filter. */
  outstandingPence: number;
  overdueInvoices: number;
  overduePence: number;
  /** At least one issued invoice exists: there is something real to show. */
  anyInvoices: boolean;
  counts: Record<BalanceFilter, number>;
}

/** Overdue first, then most outstanding, then by quote number. */
function balanceOrder(a: JobBalance, b: JobBalance): number {
  return Number(b.overdue) - Number(a.overdue) || b.outstandingPence - a.outstandingPence || Number(a.settled) - Number(b.settled) || a.quoteNumber.localeCompare(b.quoteNumber, 'en', { numeric: true });
}

export function buildBalances(jobs: JobFacts[], today: string, filter: BalanceFilter = 'all'): Balances {
  const all = jobs.flatMap((j) => {
    const b = jobBalance(j, today);
    return b ? [b] : [];
  });
  all.sort(balanceOrder);
  const counts = Object.fromEntries(BALANCE_FILTERS.map((f) => [f.key, all.filter((b) => matchesFilter(b, f.key)).length])) as Record<BalanceFilter, number>;
  const lines = all.flatMap((b) => b.invoices);
  return {
    rows: all.filter((b) => matchesFilter(b, filter)),
    outstandingPence: all.reduce((s, b) => s + b.outstandingPence, 0),
    overdueInvoices: lines.filter((i) => i.overdue).length,
    overduePence: lines.filter((i) => i.overdue).reduce((s, i) => s + i.outstandingPence, 0),
    anyInvoices: lines.length > 0,
    counts,
  };
}

export function overdueJobIds(jobs: JobFacts[], today: string): Set<string> {
  return new Set(jobs.flatMap((j) => (jobBalance(j, today)?.overdue ? [j.jobId] : [])));
}

// ---------------------------------------------------------------- payments received

export interface PaymentRow {
  id: string;
  paidOn: string;
  customerName: string;
  quoteNumber: string;
  invoiceNumber: string;
  part: string;
  instalment: number | null;
  amountPence: number;
  method: string;
  receiptDocumentId: string | null;
  receiptNumber: string | null;
  receiptFinal: boolean;
  invoiceDocumentId: string;
  jobId: string;
  recordedAt: string;
}

export function paymentRows(jobs: JobFacts[]): PaymentRow[] {
  const rows: PaymentRow[] = [];
  for (const j of jobs) {
    const count = j.quote?.schedule?.length ?? 0;
    for (const p of j.payments) {
      const inv = j.documents.find((d) => d.id === p.documentId);
      if (!inv) continue;
      const n = count ? instalmentOf(j, inv, count) : null;
      const receipt = p.receiptDocumentId ? j.documents.find((d) => d.id === p.receiptDocumentId) : undefined;
      rows.push({
        id: p.id,
        paidOn: p.paidOn,
        customerName: j.customerName,
        quoteNumber: j.quoteNumber,
        invoiceNumber: inv.number,
        part: partLabel(j, inv, n, count),
        instalment: n,
        amountPence: p.amountPence,
        method: p.method,
        receiptDocumentId: p.receiptDocumentId,
        receiptNumber: receipt?.number ?? null,
        receiptFinal: receipt ? isLive(receipt.status) : false,
        invoiceDocumentId: inv.id,
        jobId: j.jobId,
        recordedAt: p.recordedAt,
      });
    }
  }
  // Newest first; payments on the same day in the order they were recorded, newest first.
  return rows.sort((a, b) => b.paidOn.localeCompare(a.paidOn) || b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id));
}

export interface PaymentTotals {
  monthPence: number;
  yearPence: number;
  monthCount: number;
  yearCount: number;
}

/** Totals of recorded payments for a calendar month (yyyy-mm) and its calendar year. */
export function paymentTotals(rows: PaymentRow[], month: string): PaymentTotals {
  const year = month.slice(0, 4);
  const inMonth = rows.filter((r) => monthOf(r.paidOn) === month);
  const inYear = rows.filter((r) => r.paidOn.slice(0, 4) === year);
  return {
    monthPence: inMonth.reduce((s, r) => s + r.amountPence, 0),
    yearPence: inYear.reduce((s, r) => s + r.amountPence, 0),
    monthCount: inMonth.length,
    yearCount: inYear.length,
  };
}

export const METHOD_LABELS: Record<string, string> = { 'bank transfer': 'Bank transfer', cash: 'Cash', cheque: 'Cheque', card: 'Card', other: 'Other' };
export const methodLabel = (m: string) => METHOD_LABELS[m] ?? 'Other';

// ---------------------------------------------------------------- Home strip (invoices only, no job load)

export interface InvoiceTotalsLine {
  docDate: string;
  grossPence: number;
  paidPence: number;
  dueWording: string | null;
}

/** The same rules as jobBalance, over issued invoices alone: outstanding is the sum of each invoice's own outstanding. */
export function summariseInvoices(lines: InvoiceTotalsLine[], today: string): { anyInvoices: boolean; outstandingPence: number; overdueInvoices: number } {
  let outstanding = 0;
  let overdue = 0;
  for (const l of lines) {
    const left = Math.max(0, l.grossPence - l.paidPence);
    outstanding += left;
    const due = dueDateFor({ docDate: l.docDate, dueWording: l.dueWording });
    if (left > 0 && due !== null && today > due) overdue += 1;
  }
  return { anyInvoices: lines.length > 0, outstandingPence: outstanding, overdueInvoices: overdue };
}
