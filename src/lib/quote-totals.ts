/**
 * The quote form's money, as a thin adapter over money.ts. No arithmetic lives here: every figure
 * comes from computeTotals, depositOf semantics and checkPlan.
 */
import { checkPlan, computeTotals, type Instalment, type MoneyLine, type Pence, type PaymentPlan, type PlanCheck, type PricedLine } from './money';

/** The standard UK VAT rate in basis points, used until a business sets its own. */
export const DEFAULT_VAT_RATE_BP = 2000;

export interface QuoteMoneyInput {
  /** Price of the works before VAT; null while it has not been entered. */
  priceNetPence: Pence | null;
  vatApplies: boolean;
  extras: { description: string; netPence: Pence }[];
  /** Taken off before VAT; 0 for none. */
  discountPence: Pence;
  plan: PaymentPlan | null;
}

export interface QuoteTotals {
  lines: PricedLine[];
  /** Before the discount. */
  subtotalNetPence: Pence;
  discountPence: Pence;
  netPence: Pence;
  vatPence: Pence;
  grossPence: Pence;
  /** The deposit invoice, when the plan is a complete deposit plan. */
  depositPence: Pence | null;
  /** The balance after the deposit, when the plan is a complete deposit plan. */
  balancePence: Pence | null;
  /** Present only when a plan is chosen, complete and adds up exactly. */
  schedule: Instalment[] | null;
  /** Always present when a plan is chosen, so the form can show a running total. */
  planCheck: PlanCheck | null;
}

export function quoteLines(input: QuoteMoneyInput): MoneyLine[] {
  const lines: MoneyLine[] = [];
  const vat = input.vatApplies;
  lines.push({ description: 'Works as described', kind: 'Works', qty: 1, unitNetPence: input.priceNetPence ?? 0, vatApplies: vat });
  for (const e of input.extras) lines.push({ description: e.description, kind: 'Extra', qty: 1, unitNetPence: e.netPence, vatApplies: vat });
  if (input.discountPence > 0) lines.push({ description: 'Discount', kind: 'Discount', qty: 1, unitNetPence: -input.discountPence, vatApplies: vat });
  return lines;
}

export function computeQuoteTotals(input: QuoteMoneyInput, vatRateBp: number = DEFAULT_VAT_RATE_BP): QuoteTotals {
  const totals = computeTotals(quoteLines(input), vatRateBp);
  const subtotalNetPence = totals.lines.filter((l) => l.kind !== 'Discount').reduce((s, l) => s + l.netPence, 0);
  const planCheck = input.plan ? checkPlan(totals, input.plan) : null;
  const schedule = planCheck?.instalments ?? null;
  const isDeposit = input.plan?.kind === 'deposit' && schedule !== null;
  return {
    lines: totals.lines,
    subtotalNetPence,
    discountPence: input.discountPence,
    netPence: totals.netPence,
    vatPence: totals.vatPence,
    grossPence: totals.grossPence,
    depositPence: isDeposit ? schedule[0].grossPence : null,
    balancePence: isDeposit ? schedule[1].grossPence : null,
    schedule,
    planCheck,
  };
}
