/**
 * The covering email the owner copies into their own email app. Deterministic for now; the AI plan replaces the body
 * behind this same signature.
 *
 * Facts come only from the finalised document. A fact with no value is left out, never guessed. The owner's own extra
 * detail is added as they wrote it (tidied for spacing only). No dates, prices or promises are added that are not on
 * the document. No em dashes.
 */
import { formatGBP } from './money';

export type EmailDocKind = 'quotation' | 'deposit-invoice' | 'balance-invoice' | 'invoice-full' | 'invoice-stage' | 'receipt';

export interface CoveringEmailFacts {
  kind: EmailDocKind;
  number: string;
  /** The customer's name as on the document, for the greeting. */
  customerName: string;
  businessName: string;
  ownerName: string;
  /** The property, when the document names one. */
  property?: string;
  /** Total of a quotation, amount due on an invoice, amount received on a receipt. */
  amountPence?: number | null;
  /** For a quotation: how many days it is valid for. */
  validityDays?: number | null;
  /** For an invoice or receipt: the quote it belongs to. */
  quoteRef?: string;
  /** For an invoice: "Stage 2 of 5: Roof structure complete" and similar, as on the document. */
  partLabel?: string;
}

const MAX_NOTES = 2000;

/** Spacing only: trimmed, runs of spaces collapsed, no more than one blank line in a row. Words are never changed. */
export function tidyNotes(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_NOTES);
}

/** "Mr John Smith" stays as written; an empty name gives a plain "Hello". */
function greeting(name: string): string {
  const n = name.trim();
  return n ? `Dear ${n},` : 'Hello,';
}

function subjectLine(f: CoveringEmailFacts): string {
  const what: Record<EmailDocKind, string> = {
    quotation: 'Quotation',
    'deposit-invoice': 'Deposit invoice',
    'balance-invoice': 'Balance invoice',
    'invoice-full': 'Invoice',
    'invoice-stage': 'Stage invoice',
    receipt: 'Receipt',
  };
  const from = f.businessName.trim() ? ` from ${f.businessName.trim()}` : '';
  return `${what[f.kind]} ${f.number}${from}`;
}

function bodyLines(f: CoveringEmailFacts): string[] {
  const amount = typeof f.amountPence === 'number' && f.amountPence > 0 ? formatGBP(f.amountPence) : null;
  const at = f.property?.trim() ? ` for the work at ${f.property.trim()}` : '';
  const quote = f.quoteRef?.trim() ? ` (quote ${f.quoteRef.trim()})` : '';
  switch (f.kind) {
    case 'quotation': {
      const lines = [`Please find attached our quotation ${f.number}${at}.`];
      if (amount) lines.push(`The total is ${amount}.`);
      if (f.validityDays && f.validityDays > 0) lines.push(`The quotation is valid for ${f.validityDays} days from the date on it.`);
      lines.push('If you have any questions, or would like to go ahead, just reply to this email.');
      return lines;
    }
    case 'receipt': {
      const lines = [`Please find attached receipt ${f.number}${quote}.`];
      if (amount) lines.push(`It confirms we have received your payment of ${amount}. Thank you.`);
      else lines.push('It confirms we have received your payment. Thank you.');
      return lines;
    }
    default: {
      const part = f.partLabel?.trim() ? ` for ${f.partLabel.trim().replace(/^./, (c) => c.toLowerCase())}` : '';
      const lines = [`Please find attached invoice ${f.number}${part}${quote}.`];
      if (amount) lines.push(`The amount due is ${amount}. The payment details are on the invoice.`);
      else lines.push('The payment details are on the invoice.');
      lines.push('If you have any questions, just reply to this email.');
      return lines;
    }
  }
}

export interface CoveringEmail {
  subject: string;
  body: string;
}

export function draftCoveringEmailParts(args: { facts: CoveringEmailFacts; ownerNotes?: string }): CoveringEmail {
  const f = args.facts;
  const notes = tidyNotes(args.ownerNotes ?? '');
  const sign = [f.ownerName.trim(), f.businessName.trim()].filter(Boolean);
  const parts = [greeting(f.customerName), '', ...bodyLines(f)];
  if (notes) parts.push('', notes);
  parts.push('', 'Kind regards,', ...sign);
  return { subject: subjectLine(f), body: parts.join('\n').replace(/\u2014/g, ',') };
}

/** The whole thing as one block of text for the Copy button: subject line, then the body. */
export function asCopyText(e: CoveringEmail): string {
  return `Subject: ${e.subject}\n\n${e.body}`;
}

/** The seam the screen calls (the AI plan replaces the body behind it): the email as one block of copyable text. */
export function draftCoveringEmail(args: { facts: CoveringEmailFacts; ownerNotes?: string }): string {
  return asCopyText(draftCoveringEmailParts(args));
}
