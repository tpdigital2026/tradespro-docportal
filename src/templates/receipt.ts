import { html, raw } from '../lib/html';
import { balanceDue, formatGBP, type Pence } from '../lib/money';
import { documentShell } from '../pdf/document';
import type { Brand, Tenant } from '../themes/types';
import { documentCss } from './css';
import * as F from './finance-parts';
import * as P from './parts';

export interface ReceiptInput {
  receiptNo: string;
  invoiceRef: string;
  quoteRef: string;
  /** dd/mm/yyyy */
  paidDateLabel: string;
  customer: F.Customer;
  /** Which payment this is: a deposit, a balance, one stage of a staged job, or a payment against a single full invoice. */
  kind: 'deposit' | 'balance' | 'stage' | 'full';
  description: string;
  method: string;
  amountPaidPence: Pence;
  previousPaymentsPence: Pence[];
  /** Job total including any extras, VAT inclusive where VAT applies. */
  jobTotalGrossPence: Pence;
  vatIncluded: boolean;
  /** Wording for a deposit balance still to come, for example "Due on completion of works". */
  balanceDueLabel: string;
}

const ROW_KIND: Record<ReceiptInput['kind'], string> = { deposit: 'Deposit', balance: 'Balance', stage: 'Stage', full: 'Payment' };

export function buildReceipt(input: ReceiptInput, tenant: Tenant, brand: Brand): string {
  if (input.amountPaidPence <= 0) throw new RangeError('The amount paid must be greater than zero');
  if (input.previousPaymentsPence.some((p) => p <= 0)) throw new RangeError('Previous payments must each be greater than zero');
  const remaining = balanceDue(input.jobTotalGrossPence, [...input.previousPaymentsPence, input.amountPaidPence]);
  const paidInFull = remaining === 0;
  const stampLabel = paidInFull ? 'Paid in full' : input.kind === 'deposit' ? 'Deposit' : 'Part payment';
  const stampDate = input.paidDateLabel.split('/').join(' · ');
  const lowerFirst = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);
  const outstanding = input.kind === 'deposit' ? lowerFirst(input.balanceDueLabel) : 'still outstanding';
  const amount = formatGBP(input.amountPaidPence);
  const quoteTotal = `total ${formatGBP(input.jobTotalGrossPence)}${input.vatIncluded ? ' inc. VAT' : ''}`;
  const remainingText = paidInFull
    ? `Paid in full – no balance outstanding (quote ${input.quoteRef}, ${quoteTotal}).`
    : `${formatGBP(remaining)} – ${outstanding} (quote ${input.quoteRef}, ${quoteTotal}).`;
  const remainingNote = paidInFull ? 'Paid in full' : input.kind === 'deposit' ? input.balanceDueLabel : 'Still outstanding';
  const row = {
    description: input.description,
    kind: ROW_KIND[input.kind],
    qty: '1',
    unit: amount,
    vat: '',
    total: amount,
  };

  const inner = html`<div class="parties" style="align-items:center">${F.partyBlock('Received from', input.customer)}<div style="display:flex;justify-content:flex-end;padding-right:6mm"><div class="stamp"><div class="b">${stampLabel}</div><div class="a">PAID</div><div class="b">${stampDate}</div></div></div></div><div class="panel" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6mm;border-top:1mm solid var(--gold);margin-bottom:7mm"><div><span class="eyebrow">Amount paid</span><div class="serif" style="font-size:22pt;color:var(--navy);margin-top:1.5mm">${amount}</div></div><div><span class="eyebrow">Payment method</span><div class="serif" style="font-size:13pt;margin-top:3mm">${input.method}</div></div><div><span class="eyebrow">Balance remaining</span><div class="serif" style="font-size:13pt;margin-top:3mm">${formatGBP(remaining)}</div><div class="small">${remainingNote}</div></div></div><div class="sechead"><span class="eyebrow">Payment received</span><h3>Receipt details</h3></div>${P.priceTable([row], false)}${P.totalsBlock([], 'Amount paid', amount)}<div class="terms" style="margin-top:9mm"><div class="t"><h5>Balance remaining</h5><p>${remainingText}</p></div>${input.vatIncluded && tenant.vatNo ? html`<div class="t"><h5>VAT registration number</h5><p class="mono">${tenant.vatNo}</p></div>` : null}</div><div class="callout" style="margin-top:9mm;border-left-color:var(--navy);background:var(--ice)">This receipt confirms payment has been received against the invoice referenced above. Please retain this receipt for your records.</div>`;

  const doc = F.financePage(
    F.financeHeader(tenant, brand, 'Receipt', [['Date paid', input.paidDateLabel], ['Receipt no.', input.receiptNo], ['Invoice ref.', input.invoiceRef]]),
    inner,
    F.financeFooter(tenant),
  );
  return documentShell({ title: `${tenant.name} Receipt ${input.receiptNo}`, css: documentCss(brand), body: raw(doc.value) });
}
