/**
 * The recorded facts the Pipeline, Money and Guarantees screens are built from. Pure types and small readers.
 *
 * Every figure comes from something stored: the issued quote version's money (net, VAT, gross and the payment schedule
 * worked out when it was finalised), the stored total of each issued invoice, and the payments recorded with Mark as
 * paid. Nothing here estimates, forecasts or recomputes a price.
 */
import type { DocStatus, DocType, PlanKind } from '../job-stage';

export interface FactDocument {
  id: string;
  type: DocType;
  number: string;
  status: DocStatus;
  /** yyyy-mm-dd: the date printed on the document. */
  docDate: string;
  /** ISO timestamp of finalising, or null for a draft. */
  finalisedAt: string | null;
  /** The stored total of an issued document (its issued version's gross), or null. */
  totalPence: number | null;
  /** The due wording printed on an issued invoice (from the business's own wording when it was issued). */
  dueWording: string | null;
  /** A guarantee certificate's years, as issued. */
  guaranteeYears: number | null;
  /** A guarantee certificate's own number, as issued. */
  certificateNo: string | null;
}

export interface FactPayment {
  id: string;
  documentId: string;
  amountPence: number;
  /** yyyy-mm-dd */
  paidOn: string;
  method: string;
  /** ISO timestamp the payment was recorded. */
  recordedAt: string;
  receiptDocumentId: string | null;
}

export interface StoredInstalment {
  index: number;
  label: string;
  grossPence: number;
}

export interface IssuedQuote {
  documentId: string;
  /** ISO timestamp the issued version was finalised. */
  issuedAt: string;
  grossPence: number;
  /** The payment schedule stored with the issued version; null when it was not stored. */
  schedule: StoredInstalment[] | null;
}

export interface JobFacts {
  jobId: string;
  quoteNumber: string;
  customerId: string;
  customerName: string;
  addressLine: string;
  planKind: PlanKind | null;
  /** The issued quote (final or sent), or null when the quote is still a draft or missing. */
  quote: IssuedQuote | null;
  /** A draft quotation document for this job, if any (where "Finish the quote" goes). */
  draftQuoteId: string | null;
  documents: FactDocument[];
  payments: FactPayment[];
}

export const isLive = (s: DocStatus) => s === 'final' || s === 'sent';

const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : null);

/** The schedule a quote version stored in its money when it was finalised; null if missing or malformed. */
export function storedSchedule(money: unknown): StoredInstalment[] | null {
  const s = (money as { schedule?: unknown } | null)?.schedule;
  if (!Array.isArray(s) || s.length === 0 || s.length > 10) return null;
  const out: StoredInstalment[] = [];
  for (const raw of s) {
    const r = raw as { index?: unknown; label?: unknown; grossPence?: unknown };
    const index = int(r.index);
    const gross = int(r.grossPence);
    if (index === null || index < 1 || gross === null || gross < 0) return null;
    out.push({ index, label: typeof r.label === 'string' ? r.label : '', grossPence: gross });
  }
  out.sort((a, b) => a.index - b.index);
  if (out.some((x, i) => x.index !== i + 1)) return null;
  return out;
}

export function storedGross(money: unknown): number | null {
  const g = int((money as { grossPence?: unknown } | null)?.grossPence);
  return g !== null && g >= 0 ? g : null;
}
