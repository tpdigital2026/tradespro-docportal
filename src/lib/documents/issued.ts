/**
 * What a finalised version says, read back from what was stored when it was finalised (final_content and money),
 * never recomputed from today's VAT rate, wording or customer record. Pure. Used for the final page's summary and the
 * covering email.
 */
import type { CoveringEmailFacts, EmailDocKind } from '../covering-email';
import { formatGBP, formatPct } from '../money';
import type { SummaryRow, SummarySection } from './summary';

interface StoredMoney {
  netPence?: number;
  vatPence?: number;
  grossPence?: number;
}

interface StoredContent {
  business?: { name?: string; ownerName?: string };
  content?: { kind?: string; input?: Record<string, unknown> };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);

export interface Issued {
  customerName: string;
  summary: SummarySection[];
  email: CoveringEmailFacts | null;
}

function partOf(kind: string, input: Record<string, unknown>): string | undefined {
  if (kind === 'deposit-invoice') return 'the deposit';
  if (kind === 'balance-invoice') return 'the balance';
  if (kind === 'invoice-stage') {
    const st = input.stage as { index?: unknown; label?: unknown } | undefined;
    const n = num(st?.index);
    const of = num(input.stageCount);
    return n && of ? `Stage ${n} of ${of}: ${str(st?.label)}` : undefined;
  }
  return undefined;
}

/** null when the version holds no stored content (finalised before content was kept). */
export function readIssued(finalContent: unknown, money: unknown, number: string): Issued | null {
  const fc = (finalContent ?? {}) as StoredContent;
  const kind = str(fc.content?.kind);
  const input = fc.content?.input;
  if (!kind || !input || typeof input !== 'object') return null;
  const m = (money ?? {}) as StoredMoney;
  const customer = (input.customer ?? {}) as { name?: unknown; addressLines?: unknown };
  const customerName = str(customer.name);
  const who: SummaryRow[] = [{ label: 'Customer', value: customerName || 'Not given' }];
  const address = kind === 'quotation' ? str(input.property) : Array.isArray(customer.addressLines) ? (customer.addressLines as unknown[]).map(str).filter(Boolean).join(', ') : '';
  if (address) who.push({ label: kind === 'quotation' ? 'Property' : 'Address', value: address });

  const doc: SummaryRow[] = [{ label: 'Number', value: number }];
  const date = str(input.dateLabel) || str(input.paidDateLabel);
  if (date) doc.push({ label: kind === 'receipt' ? 'Paid on' : 'Date', value: date });
  if (kind !== 'quotation' && str(input.quoteRef)) doc.push({ label: 'For quote', value: str(input.quoteRef) });
  if (kind === 'receipt' && str(input.invoiceRef)) doc.push({ label: 'For invoice', value: str(input.invoiceRef) });
  const part = partOf(kind, input);
  if (kind === 'deposit-invoice' && num(input.depositPctBp)) doc.push({ label: 'Part of the job', value: `Deposit (${formatPct(num(input.depositPctBp) as number)}%)` });
  else if (part && kind !== 'balance-invoice') doc.push({ label: 'Part of the job', value: part.replace(/^the /, '').replace(/^./, (c) => c.toUpperCase()) });
  else if (kind === 'balance-invoice') doc.push({ label: 'Part of the job', value: 'Balance' });
  if (kind === 'receipt' && str(input.method)) doc.push({ label: 'Paid by', value: str(input.method) });

  const rows: SummaryRow[] = [];
  const net = num(m.netPence);
  const vat = num(m.vatPence);
  const gross = num(kind === 'receipt' ? input.amountPaidPence : m.grossPence) ?? num(m.grossPence);
  if (kind !== 'receipt' && vat !== null && vat > 0 && net !== null) {
    rows.push({ label: 'Before VAT', value: formatGBP(net) });
    rows.push({ label: 'VAT', value: formatGBP(vat) });
  }
  if (gross !== null) rows.push({ label: kind === 'quotation' ? 'Total' : kind === 'receipt' ? 'Payment received' : 'Amount due', value: formatGBP(gross), tone: 'strong' });
  if (kind === 'quotation' && Array.isArray(input.paymentSchedule)) {
    for (const r of input.paymentSchedule as unknown[]) if (Array.isArray(r) && r.length === 2) rows.push({ label: str(r[0]), value: str(r[1]) });
  }
  const bank = input.bank as { accountName?: unknown; bankName?: unknown; accountEnding?: unknown } | undefined;
  if (bank && str(bank.accountName)) rows.push({ label: 'Paid into', value: `${str(bank.accountName)}, ${str(bank.bankName)}, ending ${str(bank.accountEnding)}` });

  const emailKinds: EmailDocKind[] = ['quotation', 'deposit-invoice', 'balance-invoice', 'invoice-full', 'invoice-stage', 'receipt'];
  const email: CoveringEmailFacts | null = emailKinds.includes(kind as EmailDocKind)
    ? {
        kind: kind as EmailDocKind,
        number,
        customerName,
        businessName: str(fc.business?.name),
        ownerName: str(fc.business?.ownerName),
        property: kind === 'quotation' ? address || undefined : undefined,
        amountPence: gross,
        validityDays: kind === 'quotation' ? num(input.validityDays) : null,
        quoteRef: kind === 'quotation' ? undefined : str(input.quoteRef) || undefined,
        partLabel: part,
      }
    : null;
  return {
    customerName,
    summary: [
      { title: 'Who it is for', rows: who },
      { title: 'The document', rows: doc },
      { title: 'The money', rows },
    ],
    email,
  };
}
