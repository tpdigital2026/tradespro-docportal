/**
 * What the draft page shows: a plain summary of what was entered, worked out from the same facts the document is
 * made from. Pure. Figures come from money.ts; nothing is shown that is not on record.
 */
import { buildJobBilling, followOnFor } from '../job-billing';
import { DOC_TYPE_NAMES } from '../job-stage';
import { buildSchedule, computeTotals, formatGBP, formatPct, type Instalment } from '../money';
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from '../payment';
import { computeQuoteTotals, quoteLines } from '../quote-totals';
import { countSteps, isApproved } from '../scope/model';
import { normaliseQuote } from '../validation/quote';
import { longDate, type BusinessFacts, type DocumentFacts } from './map';

export interface SummaryRow {
  label: string;
  value: string;
  /** A value worth drawing the eye to (a total, or something not done yet). */
  tone?: 'strong' | 'warn';
}

export interface SummarySection {
  title: string;
  rows: SummaryRow[];
}

export function planWords(kind: string, schedule: Instalment[] | null, depositPctBp: number | null): string {
  if (!schedule) return 'Not worked out yet';
  if (kind === 'full') return `Paid in full, ${formatGBP(schedule[0].grossPence)}`;
  if (kind === 'deposit' && schedule.length === 2) return `${formatPct(depositPctBp ?? 0)}% deposit of ${formatGBP(schedule[0].grossPence)}, then the balance of ${formatGBP(schedule[1].grossPence)}`;
  return `${schedule.length} stage payments`;
}

export function summarise(f: DocumentFacts, b: BusinessFacts, bankLabel: string | null): SummarySection[] {
  const who: SummaryRow[] = [{ label: 'Customer', value: f.customer.name || 'Not given' }];
  const address = f.propertyAddress.trim() || [...f.customer.addressLines, f.customer.postcode].filter(Boolean).join(', ');
  if (address) who.push({ label: 'Property', value: address });

  if (f.type === 'quotation') {
    const { input } = normaliseQuote(f.quoteForm, 'draft', b.vatRateBp);
    const totals = computeQuoteTotals({ priceNetPence: input.priceNetPence, vatApplies: input.vatApplies, extras: input.extras, discountPence: input.discountPence, plan: null }, b.vatRateBp);
    let schedule: Instalment[] | null = null;
    try {
      if (f.plan && input.priceNetPence !== null && !totals.error) schedule = buildSchedule(computeTotals(quoteLines({ ...input, priceNetPence: input.priceNetPence, plan: null }), b.vatRateBp), f.plan);
    } catch {
      schedule = null;
    }
    const scope = f.quoteForm.scope;
    const job: SummaryRow[] = [
      { label: 'Quote number', value: f.quoteNumber },
      { label: 'Quote date', value: longDate(f.docDate) || 'Not set' },
    ];
    if (f.jobTypeLabel) job.push({ label: 'Type of job', value: f.jobTypeLabel });
    if (scope.coverTitle.trim()) job.push({ label: 'Title', value: scope.coverTitle.trim() });
    const steps = countSteps(scope.items);
    job.push({ label: 'Scope of works', value: steps === 0 ? 'No steps yet' : `${steps} ${steps === 1 ? 'step' : 'steps'}` });
    job.push(isApproved(scope) ? { label: 'Wording', value: 'Approved' } : { label: 'Wording', value: 'Not approved yet', tone: 'warn' });
    const money: SummaryRow[] = [];
    if (input.priceNetPence === null || totals.error) money.push({ label: 'Price', value: 'Not entered yet', tone: 'warn' });
    else {
      if (input.extras.length) money.push({ label: 'Extras', value: `${input.extras.length}, ${formatGBP(input.extras.reduce((s, e) => s + e.netPence, 0))} before VAT` });
      if (input.discountPence > 0) money.push({ label: 'Discount', value: formatGBP(input.discountPence) });
      money.push({ label: input.vatApplies ? 'Before VAT' : 'Price', value: formatGBP(totals.netPence) });
      if (input.vatApplies) money.push({ label: `VAT at ${formatPct(b.vatRateBp)}%`, value: formatGBP(totals.vatPence) });
      money.push({ label: 'Total', value: formatGBP(totals.grossPence), tone: 'strong' });
      money.push({ label: 'Payment plan', value: f.plan ? planWords(f.plan.kind, schedule, f.plan.kind === 'deposit' ? f.plan.pctBp : null) : 'Not chosen yet', ...(schedule ? {} : { tone: 'warn' as const }) });
    }
    if (bankLabel) money.push({ label: 'Paid into', value: bankLabel });
    return [
      { title: 'Who it is for', rows: who },
      { title: 'The job', rows: job },
      { title: 'The money', rows: money },
    ];
  }

  // Invoices and receipts are worked out from the issued quote and the payments.
  const rows: SummaryRow[] = [{ label: 'For quote', value: f.quoteNumber }];
  const money: SummaryRow[] = [];
  if (f.plan && f.followOn) {
    const billing = buildJobBilling({ quoteNumber: f.quoteNumber, plan: f.plan, form: f.quoteForm, vatRateBp: b.vatRateBp, documents: f.documents, payments: f.payments });
    if (billing.ok) {
      const r = followOnFor(billing.billing, f.type, f.followOn.instalment, f.followOn.paymentId);
      if (r.ok) {
        rows.push({ label: 'Part of the job', value: r.followOn.heading });
        if (f.type === 'receipt' && r.followOn.payment) {
          const p = r.followOn.payment;
          money.push({ label: 'Payment received', value: formatGBP(p.amountPence), tone: 'strong' });
          money.push({ label: 'Paid on', value: longDate(p.paidOn) });
          money.push({ label: 'Paid by', value: PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? p.method });
        } else {
          if (r.followOn.vatPence > 0) {
            money.push({ label: 'Before VAT', value: formatGBP(r.followOn.netPence) });
            money.push({ label: 'VAT', value: formatGBP(r.followOn.vatPence) });
          }
          money.push({ label: 'Amount due', value: formatGBP(r.followOn.grossPence), tone: 'strong' });
          money.push({ label: 'Job total', value: formatGBP(billing.billing.totals.grossPence) });
        }
      } else money.push({ label: 'Amount', value: r.message, tone: 'warn' });
    } else money.push({ label: 'Amount', value: billing.message, tone: 'warn' });
  }
  rows.push({ label: 'Date', value: longDate(f.docDate) || 'Not set' });
  if (bankLabel && f.type !== 'receipt') money.push({ label: 'Paid into', value: bankLabel });
  return [
    { title: 'Who it is for', rows: who },
    { title: DOC_TYPE_NAMES[f.type], rows },
    { title: 'The money', rows: money },
  ];
}
