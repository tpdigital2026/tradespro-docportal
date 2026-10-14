/**
 * A job's billing, worked out from facts. Pure: the data layer fetches rows, this turns them into
 * the schedule, the progress and the prefill for the next document.
 *
 * The stored `instalments` on a job are never read here. The schedule is ALWAYS recomputed with
 * buildSchedule from the totals of the latest quote version and the plan's inputs (README, Payment plans).
 */
import { buildSchedule, computeTotals, formatPct, type Instalment, type Pence, type PaymentPlan, type Totals } from './money';
import {
  deriveJobStage,
  documentNumberFor,
  instalmentFromNumber,
  invoiceTypeFor,
  isInvoiceType,
  type DocStatus,
  type DocType,
  type JobProgress,
  type PlanKind,
} from './job-stage';
import { quoteLines, type QuoteMoneyInput } from './quote-totals';
import { normaliseQuote, type QuoteFormValues } from './validation/quote';

export interface RawDocument {
  id: string;
  type: DocType;
  number: string;
  status: DocStatus;
}
export interface RawPayment {
  id: string;
  documentId: string;
  amountPence: Pence;
  paidOn: string;
  method: string;
  note: string | null;
  receiptDocumentId: string | null;
}
export interface BillingDocument extends RawDocument {
  instalment: number | null;
}
export interface BillingPayment extends RawPayment {
  instalment: number;
}

export interface JobBilling {
  quoteNumber: string;
  kind: PlanKind;
  /** Recomputed, 1-based. Their gross amounts add up to the job gross exactly. */
  instalments: Instalment[];
  /** Deposit percentage in basis points, for a deposit plan. */
  depositPctBp: number | null;
  totals: { netPence: Pence; vatPence: Pence; grossPence: Pence };
  documents: BillingDocument[];
  payments: BillingPayment[];
  progress: JobProgress;
}

export type BillingResult = { ok: true; billing: JobBilling } | { ok: false; message: string };

export const NO_SCHEDULE = 'We cannot work out how this job is billed. Open the quote and check its price and payment plan.';

/** The money of a quote version's saved form, as the adapter expects it. Draft mode: tolerant of fields that do not matter here. */
export function quoteMoneyFromForm(form: QuoteFormValues, vatRateBp: number): { money: QuoteMoneyInput; plan: PaymentPlan | null } | null {
  const { input } = normaliseQuote(form, 'draft', vatRateBp);
  if (input.priceNetPence === null) return null;
  return {
    money: { priceNetPence: input.priceNetPence, vatApplies: input.vatApplies, extras: input.extras, discountPence: input.discountPence, plan: null },
    plan: input.plan,
  };
}

/**
 * plan: the plan inputs (from jobs.payment_plan, or the form in demo mode). form: the latest quote version's saved form.
 * Never throws.
 */
export function buildJobBilling(args: {
  quoteNumber: string;
  plan: PaymentPlan | null;
  form: QuoteFormValues;
  vatRateBp: number;
  documents: RawDocument[];
  payments: RawPayment[];
}): BillingResult {
  try {
    const m = quoteMoneyFromForm(args.form, args.vatRateBp);
    const plan = args.plan;
    if (!m || !plan) return { ok: false, message: NO_SCHEDULE };
    const totals: Totals = computeTotals(quoteLines(m.money), args.vatRateBp);
    const instalments = buildSchedule(totals, plan);
    const kind: PlanKind = plan.kind;

    const documents: BillingDocument[] = args.documents.map((d) => ({
      ...d,
      instalment: d.type === 'quotation' ? null : instalmentFromNumber(d.type, d.number, args.quoteNumber, kind, instalments.length),
    }));
    const instalmentOfDoc = new Map(documents.map((d) => [d.id, d.instalment]));
    const payments: BillingPayment[] = [];
    for (const p of args.payments) {
      const inst = instalmentOfDoc.get(p.documentId);
      if (typeof inst === 'number') payments.push({ ...p, instalment: inst });
    }
    const progress = deriveJobStage(
      { kind },
      instalments.map((i) => ({ index: i.index, label: i.label, grossPence: i.grossPence })),
      payments.map((p) => ({ instalment: p.instalment, amountPence: p.amountPence })),
      documents.map((d) => ({ type: d.type, instalment: d.instalment, status: d.status })),
    );
    return {
      ok: true,
      billing: {
        quoteNumber: args.quoteNumber,
        kind,
        instalments,
        depositPctBp: plan.kind === 'deposit' ? plan.pctBp : null,
        totals: { netPence: totals.netPence, vatPence: totals.vatPence, grossPence: totals.grossPence },
        documents,
        payments,
        progress,
      },
    };
  } catch {
    return { ok: false, message: NO_SCHEDULE };
  }
}

/** "Deposit (30%)", "Balance", "Invoice" or "Stage 2 of 5: Roof structure complete". */
export function instalmentHeading(b: Pick<JobBilling, 'kind' | 'instalments' | 'depositPctBp'>, index: number): string {
  const inst = b.instalments.find((i) => i.index === index);
  if (!inst) return '';
  if (b.kind === 'full') return 'Invoice';
  if (b.kind === 'deposit') return index === 1 ? `Deposit (${formatPct(b.depositPctBp ?? 0)}%)` : 'Balance';
  return `Stage ${index} of ${b.instalments.length}: ${inst.label}`;
}

export interface FollowOn {
  type: DocType;
  instalment: number;
  number: string;
  heading: string;
  netPence: Pence;
  vatPence: Pence;
  grossPence: Pence;
  /** Payments already recorded on earlier instalments, shown on an invoice as money received. */
  receivedEarlier: BillingPayment[];
  /** The recorded payment a receipt confirms. */
  payment: BillingPayment | null;
  /** A document with this number already exists (any status). */
  exists: boolean;
}

export type FollowOnResult = { ok: true; followOn: FollowOn } | { ok: false; message: string };

const MISMATCH = 'That document does not fit how this job is billed.';

/** The prefill for a deposit, balance, full or stage invoice, or a receipt, from the job. */
export function followOnFor(b: JobBilling, type: DocType, instalment: number | null, paymentId: string | null): FollowOnResult {
  if (type !== 'receipt' && !isInvoiceType(type)) return { ok: false, message: MISMATCH };
  // A deposit, balance or full invoice implies its instalment; a stage invoice and a receipt need one.
  let n = instalment;
  if (n === null) {
    if (type === 'deposit-invoice' || type === 'invoice-full') n = 1;
    else if (type === 'balance-invoice') n = 2;
    else if (type === 'receipt' && paymentId) n = b.payments.find((p) => p.id === paymentId)?.instalment ?? null;
    else if (type === 'receipt' && b.instalments.length === 1) n = 1;
  }
  if (n === null) return { ok: false, message: 'Choose which part of the job this is for.' };
  const inst = b.instalments.find((i) => i.index === n);
  if (!inst) return { ok: false, message: MISMATCH };
  if (type !== 'receipt' && invoiceTypeFor(b.kind, n) !== type) return { ok: false, message: MISMATCH };
  const number = documentNumberFor(type, b.quoteNumber, b.kind, n);
  if (!number) return { ok: false, message: MISMATCH };

  let payment: BillingPayment | null = null;
  if (type === 'receipt') {
    const here = b.payments.filter((p) => p.instalment === n);
    payment = paymentId ? (here.find((p) => p.id === paymentId) ?? null) : (here.find((p) => p.receiptDocumentId === null) ?? here[0] ?? null);
    if (!payment) return { ok: false, message: 'There is no recorded payment to make a receipt for. Mark the invoice as paid first.' };
  }
  return {
    ok: true,
    followOn: {
      type,
      instalment: n,
      number,
      heading: instalmentHeading(b, n),
      netPence: inst.netPence,
      vatPence: inst.vatPence,
      grossPence: inst.grossPence,
      receivedEarlier: type === 'receipt' ? [] : b.payments.filter((p) => p.instalment < n),
      payment,
      exists: b.documents.some((d) => d.number === number),
    },
  };
}

/** The final invoice for an instalment, if one has been raised (a draft or void one cannot be paid). */
export function payableInvoice(b: JobBilling, instalment: number): BillingDocument | null {
  return b.documents.find((d) => d.instalment === instalment && isInvoiceType(d.type) && (d.status === 'final' || d.status === 'sent')) ?? null;
}

export function paidOnInstalment(b: JobBilling, instalment: number): Pence {
  return b.payments.filter((p) => p.instalment === instalment).reduce((s, p) => s + p.amountPence, 0);
}
