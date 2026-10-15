/**
 * From the facts stored for a document to the input its template takes. Pure: the data layer loads the facts
 * (rows, the decrypted bank details at render time), this decides what the document says.
 *
 * Truth rules: nothing is invented. Money is recomputed with money.ts from the quote version's totals and the plan's
 * inputs (buildSchedule), never taken from stored instalments. A fact that is not on record is left out where the
 * template can do without it, and otherwise blocks finalising with a plain message saying what is missing.
 */
import type { TenantWording } from '../../db/wording';
import type { BankDetails, Customer as PartyCustomer } from '../../templates/finance-parts';
import type { BalanceInvoiceInput, DepositInvoiceInput, FullInvoiceInput, StageInvoiceInput } from '../../templates/invoice';
import type { QuotationInput } from '../../templates/quotation';
import type { ReceiptInput } from '../../templates/receipt';
import type { SurveyMappedInput } from '../survey/map';
import type { Tenant } from '../../themes/types';
import { buildJobBilling, followOnFor, type RawDocument, type RawPayment } from '../job-billing';
import { DOC_TYPE_NAMES, type DocType } from '../job-stage';
import { buildSchedule, computeTotals, formatGBP, formatPct, type Instalment, type PaymentPlan } from '../money';
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from '../payment';
import { computeQuoteTotals, quoteLines } from '../quote-totals';
import { toQuotationScope } from '../scope/to-quotation';
import { normaliseQuote, type QuoteFormValues } from '../validation/quote';

export interface BusinessFacts {
  tenant: Tenant;
  wording: TenantWording | null;
  disclaimer: string;
  validityDays: number;
  vatRateBp: number;
}

export interface CustomerFacts {
  name: string;
  addressLines: string[];
  postcode: string;
  email: string;
  phone: string;
}

export interface DocumentFacts {
  type: DocType;
  /** The document's own number as stored (claimed once). */
  number: string;
  /** yyyy-mm-dd */
  docDate: string;
  quoteNumber: string;
  propertyAddress: string;
  jobTypeLabel: string;
  guaranteeYears: number | null;
  customer: CustomerFacts;
  /** The quote form the money and scope come from: for a quotation its own version, otherwise the latest issued quote version. */
  quoteForm: QuoteFormValues;
  /** The plan's inputs (jobs.payment_plan). Never the stored instalments. */
  plan: PaymentPlan | null;
  /** For invoices and receipts: the job's documents and recorded payments, in the order recorded. */
  documents: RawDocument[];
  payments: RawPayment[];
  /** For invoices and receipts: what the draft version was made for. */
  followOn: { instalment: number; paymentId: string | null } | null;
  /** Decrypted only at render time, never stored. null when the business has no bank account on record. */
  bank: BankDetails | null;
}

export type Mapped =
  | { kind: 'quotation'; input: QuotationInput }
  | { kind: 'deposit-invoice'; input: DepositInvoiceInput }
  | { kind: 'balance-invoice'; input: BalanceInvoiceInput }
  | { kind: 'invoice-full'; input: FullInvoiceInput }
  | { kind: 'invoice-stage'; input: StageInvoiceInput }
  | { kind: 'receipt'; input: ReceiptInput }
  | { kind: 'survey'; input: SurveyMappedInput };

/** The figures that are written to the version and the document row when it is finalised. */
export interface DocumentMoney {
  netPence: number;
  vatPence: number;
  grossPence: number;
  /** A quotation's schedule, recomputed with buildSchedule. */
  schedule?: Instalment[];
  instalment?: number;
  paymentId?: string;
}

export type MapResult = { ok: true; mapped: Mapped; money: DocumentMoney } | { ok: false; missing: string[] };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "21 September 2026" from 2026-09-21; empty if the date is not a real date. */
export function longDate(iso: string): string {
  const m = DATE_RE.exec(iso);
  if (!m) return '';
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCDate() !== Number(m[3])) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "21/09/2026" from 2026-09-21. */
export function slashDate(iso: string): string {
  const m = DATE_RE.exec(iso);
  return m && longDate(iso) ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

const NOT_SET_UP = 'Contact TradesPro Digital to set it up.';
const WORKS_LINE = 'The works as set out in the scope above';

function quoteMoney(f: DocumentFacts, vatRateBp: number) {
  const { input, errors } = normaliseQuote(f.quoteForm, 'draft', vatRateBp);
  if (input.priceNetPence === null || errors.price) return null;
  const money = { priceNetPence: input.priceNetPence, vatApplies: input.vatApplies, extras: input.extras, discountPence: input.discountPence, plan: null };
  const totals = computeQuoteTotals(money, vatRateBp);
  if (totals.error) return null;
  const lines = quoteLines(money).map((l) => (l.kind === 'Works' ? { ...l, description: WORKS_LINE } : l));
  return { input, money, totals, lines };
}

function partyCustomer(c: CustomerFacts): PartyCustomer {
  return { name: c.name, addressLines: [...c.addressLines, ...(c.postcode ? [c.postcode] : [])].filter((l) => l.trim() !== ''), email: c.email, phone: c.phone };
}

function guaranteeOf(f: DocumentFacts, b: BusinessFacts): { years: number; text: string } | null {
  const statement = b.wording?.guarantee.statement;
  return f.guaranteeYears && statement ? { years: f.guaranteeYears, text: statement } : null;
}

/** A percentage written into the business's own wording must agree with the job's, or the document would say something untrue. */
function pctMismatch(text: string, pctBp: number): boolean {
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(text);
  return m !== null && m[1] !== formatPct(pctBp);
}

/** "Deposit (30%)  £3,024.00", the business's own balance label, "Stage 2: Roof structure complete". A single payment adds nothing. */
function scheduleRows(plan: PaymentPlan | null, schedule: Instalment[] | undefined, balanceLabel: string): [string, string][] {
  if (!plan || !schedule || plan.kind === 'full') return [];
  if (plan.kind === 'deposit') return [[`Deposit (${formatPct(plan.pctBp)}%)`, formatGBP(schedule[0].grossPence)], [balanceLabel, formatGBP(schedule[1].grossPence)]];
  return schedule.map((i) => [`Stage ${i.index}: ${i.label}`, formatGBP(i.grossPence)]);
}

export function mapQuotation(f: DocumentFacts, b: BusinessFacts): MapResult {
  const missing: string[] = [];
  const { errors } = normaliseQuote(f.quoteForm, 'final', b.vatRateBp);
  const firstError = Object.values(errors).filter((m) => !/approve/i.test(m))[0];
  if (firstError) missing.push(`The quote is not finished: ${firstError.charAt(0).toLowerCase()}${firstError.slice(1).replace(/\.$/, '')}.`);
  const scope = toQuotationScope(f.quoteForm.scope);
  if (!scope.ok) missing.push('The scope wording has not been approved. Open the quote, check the wording and approve it.');
  const m = quoteMoney(f, b.vatRateBp);
  if (!m) missing.push('The quote has no price, or the amounts are too large to work out.');
  let schedule: Instalment[] | undefined;
  if (m) {
    if (!f.plan) missing.push('The quote has no payment plan. Choose one on the plan step.');
    else {
      try {
        schedule = buildSchedule(computeTotals(quoteLines(m.money), b.vatRateBp), f.plan);
      } catch {
        missing.push('The payment plan does not add up to the quote total. Open the quote and check the plan step.');
      }
    }
  }
  const terms = b.wording?.quote.terms;
  if (!terms) missing.push(`Your quotation terms are not set up yet. ${NOT_SET_UP}`);
  if (!f.customer.name.trim()) missing.push('The customer has no name.');
  const property = f.propertyAddress.trim() || [...f.customer.addressLines, f.customer.postcode].filter(Boolean).join(', ');
  if (!property) missing.push('The quote has no property address.');
  const dateLabel = longDate(f.docDate);
  if (!dateLabel) missing.push('The quote has no date.');
  if (missing.length > 0 || !m || !scope.ok || !terms) return { ok: false, missing };

  const s = scope.value;
  const input: QuotationInput = {
    ref: f.quoteNumber,
    dateLabel,
    validityDays: b.validityDays,
    customer: { name: f.customer.name, email: f.customer.email, phone: f.customer.phone },
    property,
    coverEyebrow: f.jobTypeLabel ? `${f.jobTypeLabel} · Quotation` : 'Quotation',
    coverTitle: s.coverTitle,
    coverSub: s.coverSub,
    introText: s.introText,
    specEyebrow: 'Specification',
    specHeading: 'At a glance',
    specCards: s.specCards,
    diagram: null,
    callout: s.callout,
    scopeHeading: 'What we will do',
    scope: s.scope,
    guarantee: guaranteeOf(f, b),
    vatRateBp: b.vatRateBp,
    lines: m.lines,
    paymentSchedule: scheduleRows(f.plan, schedule, b.wording?.deposit_invoice.balanceDueLabel ?? 'Balance'),
    terms,
    disclaimer: b.disclaimer,
  };
  return { ok: true, mapped: { kind: 'quotation', input }, money: { netPence: m.totals.netPence, vatPence: m.totals.vatPence, grossPence: m.totals.grossPence, schedule } };
}

/** Invoices and receipts: the job's billing is recomputed from the latest issued quote version and the plan inputs. */
export function mapFollowOn(f: DocumentFacts, b: BusinessFacts): MapResult {
  const missing: string[] = [];
  const name = DOC_TYPE_NAMES[f.type].toLowerCase();
  if (!f.followOn) return { ok: false, missing: [`This ${name} does not say which part of the job it is for.`] };
  const m = quoteMoney(f, b.vatRateBp);
  const scope = toQuotationScope(f.quoteForm.scope);
  if (!m) missing.push('The quote this comes from has no price.');
  if (!scope.ok) missing.push('The quote this comes from has no approved scope wording.');
  if (!f.plan) missing.push('The quote this comes from has no payment plan.');
  if (!m || !scope.ok || !f.plan) return { ok: false, missing };

  const billing = buildJobBilling({ quoteNumber: f.quoteNumber, plan: f.plan, form: f.quoteForm, vatRateBp: b.vatRateBp, documents: f.documents, payments: f.payments });
  if (!billing.ok) return { ok: false, missing: [billing.message] };
  const bl = billing.billing;
  const r = followOnFor(bl, f.type, f.followOn.instalment, f.followOn.paymentId);
  if (!r.ok) return { ok: false, missing: [r.message] };
  const fo = r.followOn;
  if (fo.number !== f.number) return { ok: false, missing: ['This document no longer matches the job. The quote or the payments changed after it was started.'] };

  const customer = partyCustomer(f.customer);
  if (!customer.name.trim()) missing.push('The customer has no name.');
  const dateLabel = longDate(f.docDate);
  if (!dateLabel) missing.push('The document has no date.');
  const w = b.wording;
  const showVat = m.input.vatApplies;
  const money: DocumentMoney = { netPence: fo.netPence, vatPence: fo.vatPence, grossPence: fo.grossPence, instalment: fo.instalment, ...(fo.payment ? { paymentId: fo.payment.id } : {}) };

  if (f.type === 'receipt') {
    const p = fo.payment;
    if (!p) return { ok: false, missing: ['There is no recorded payment for this receipt.'] };
    const invoice = bl.documents.find((d) => d.id === p.documentId);
    const balanceDueLabel = w?.receipt.balanceDueLabel;
    if (!balanceDueLabel) missing.push(`Your receipt wording is not set up yet. ${NOT_SET_UP}`);
    const paidDateLabel = slashDate(p.paidOn);
    if (!paidDateLabel) missing.push('The payment has no date.');
    if (!invoice) missing.push('The invoice this payment was made against cannot be found.');
    if (missing.length > 0 || !balanceDueLabel || !invoice) return { ok: false, missing };
    const order = bl.payments.map((x) => x.id);
    const previous = bl.payments.slice(0, order.indexOf(p.id)).map((x) => x.amountPence);
    const kind: ReceiptInput['kind'] = bl.kind === 'deposit' ? (fo.instalment === 1 ? 'deposit' : 'balance') : bl.kind === 'full' ? 'full' : 'stage';
    const input: ReceiptInput = {
      receiptNo: f.number,
      invoiceRef: invoice.number,
      quoteRef: f.quoteNumber,
      paidDateLabel,
      customer,
      kind,
      description: `${fo.heading} – ${scope.value.coverTitle}${showVat ? ' (inc. VAT)' : ''}`,
      method: PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? p.method,
      amountPaidPence: p.amountPence,
      previousPaymentsPence: previous,
      jobTotalGrossPence: bl.totals.grossPence,
      vatIncluded: showVat,
      balanceDueLabel,
    };
    return { ok: true, mapped: { kind: 'receipt', input }, money: { ...money, grossPence: p.amountPence } };
  }

  // Invoices.
  if (!f.bank) missing.push('Your bank details are not on record, so the customer would not know how to pay. Contact TradesPro Digital to add them.');
  const common = {
    invoiceNo: f.number,
    quoteRef: f.quoteNumber,
    dateLabel,
    customer,
    jobTitle: scope.value.coverTitle,
    scope: scope.value.scope,
    jobDescription: 'the works as set out above',
    vatRateBp: b.vatRateBp,
    quoteLines: m.lines,
    guarantee: guaranteeOf(f, b),
    bank: f.bank as BankDetails,
    paymentRef: f.number,
    disclaimer: b.disclaimer,
  };
  if (f.type === 'deposit-invoice') {
    const d = w?.deposit_invoice;
    if (!d) missing.push(`Your deposit invoice wording is not set up yet. ${NOT_SET_UP}`);
    const pct = bl.depositPctBp ?? 0;
    if (d && pctMismatch(d.terms, pct)) missing.push(`Your deposit invoice wording names a different deposit from this job's ${formatPct(pct)}%. ${NOT_SET_UP.replace('set it up', 'change the wording')}`);
    if (missing.length > 0 || !d) return { ok: false, missing };
    return { ok: true, mapped: { kind: 'deposit-invoice', input: { ...common, depositPctBp: pct, dueLabel: d.dueLabel, balanceDueLabel: d.balanceDueLabel, terms: d.terms } }, money };
  }
  if (f.type === 'balance-invoice') {
    const d = w?.balance_invoice;
    if (!d) missing.push(`Your balance invoice wording is not set up yet. ${NOT_SET_UP}`);
    const deposit = bl.instalments[0];
    const received = bl.payments.filter((p) => p.instalment === 1).reduce((s, p) => s + p.amountPence, 0);
    if (deposit && received !== deposit.grossPence) missing.push('The deposit has not been paid in full yet. Record the deposit payment first, so the balance invoice can show it as received.');
    if (missing.length > 0 || !d) return { ok: false, missing };
    const receipt = bl.documents.find((x) => x.type === 'receipt' && x.instalment === 1 && (x.status === 'final' || x.status === 'sent'));
    return {
      ok: true,
      mapped: { kind: 'balance-invoice', input: { ...common, depositPctBp: bl.depositPctBp ?? 0, adjustmentLines: [], depositReceiptRef: receipt?.number ?? null, depositReceivedPence: received, dueNote: d.dueNote, terms: d.terms } },
      money,
    };
  }
  const own = f.type === 'invoice-full' ? w?.invoice_full : w?.invoice_stage;
  const d = own ?? w?.balance_invoice;
  if (!d) missing.push(`Your invoice wording is not set up yet. ${NOT_SET_UP}`);
  if (missing.length > 0 || !d) return { ok: false, missing };
  if (f.type === 'invoice-full') {
    return { ok: true, mapped: { kind: 'invoice-full', input: { ...common, dueNote: d.dueNote, terms: d.terms } }, money };
  }
  const stage = bl.instalments.find((i) => i.index === fo.instalment);
  if (!stage) return { ok: false, missing: ['That stage is not part of this job.'] };
  const receivedPence = bl.payments.filter((p) => p.instalment < fo.instalment).reduce((s, p) => s + p.amountPence, 0);
  return { ok: true, mapped: { kind: 'invoice-stage', input: { ...common, stage, stageCount: bl.instalments.length, receivedPence, dueNote: d.dueNote, terms: d.terms } }, money };
}

export function mapDocument(f: DocumentFacts, b: BusinessFacts): MapResult {
  if (f.type === 'quotation') return mapQuotation(f, b);
  if (f.type === 'guarantee' || f.type === 'survey') return { ok: false, missing: [`${DOC_TYPE_NAMES[f.type]}s cannot be finalised here yet.`] };
  return mapFollowOn(f, b);
}

/** A template input with the bank numbers taken out: what is kept with a finalised version. */
export function redactMapped(m: Mapped): unknown {
  if ('bank' in m.input) {
    const { bank, ...rest } = m.input as { bank: BankDetails };
    return { kind: m.kind, input: { ...rest, bank: { accountName: bank.accountName, bankName: bank.bankName, accountEnding: bank.accountNumber.slice(-4) } } };
  }
  return { kind: m.kind, input: m.input };
}
