/**
 * The guarantee register: one row per issued (final or sent) guarantee certificate, read from what the certificate
 * stored when it was issued. Pure. Expiry is the issue year plus the certificate's years; a certificate that did not
 * store its years shows "Not recorded" rather than a guess.
 */
import { londonDate } from '../london';
import { isLive, type JobFacts } from './facts';

export interface GuaranteeRow {
  documentId: string;
  /** The certificate's own number when it stored one, else the document number. */
  certificateNo: string;
  customerName: string;
  quoteNumber: string;
  addressLine: string;
  /** yyyy-mm-dd (London) the certificate was issued. */
  issuedOn: string;
  years: number | null;
  expiryYear: number | null;
}

export type GuaranteeFilter = 'all' | 'this-year';
export const isGuaranteeFilter = (s: unknown): s is GuaranteeFilter => s === 'all' || s === 'this-year';

export function guaranteeRows(jobs: JobFacts[]): GuaranteeRow[] {
  const rows: GuaranteeRow[] = [];
  for (const j of jobs) {
    for (const d of j.documents) {
      if (d.type !== 'guarantee' || !isLive(d.status)) continue;
      const issuedOn = d.finalisedAt ? londonDate(d.finalisedAt) : d.docDate;
      const years = d.guaranteeYears !== null && Number.isInteger(d.guaranteeYears) && d.guaranteeYears >= 1 && d.guaranteeYears <= 50 ? d.guaranteeYears : null;
      rows.push({
        documentId: d.id,
        certificateNo: d.certificateNo || d.number,
        customerName: j.customerName,
        quoteNumber: j.quoteNumber,
        addressLine: j.addressLine,
        issuedOn,
        years,
        expiryYear: years === null ? null : Number(issuedOn.slice(0, 4)) + years,
      });
    }
  }
  return rows.sort((a, b) => b.issuedOn.localeCompare(a.issuedOn) || a.certificateNo.localeCompare(b.certificateNo, 'en', { numeric: true }));
}

/** Plain substring search on certificate number, quote number, customer and address (no patterns). */
export function filterGuarantees(rows: GuaranteeRow[], f: { filter: GuaranteeFilter; q: string; year: number }): GuaranteeRow[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (f.filter === 'all' || r.expiryYear === f.year) &&
      (q === '' || [r.certificateNo, r.quoteNumber, r.customerName, r.addressLine].some((s) => s.toLowerCase().includes(q))),
  );
}
