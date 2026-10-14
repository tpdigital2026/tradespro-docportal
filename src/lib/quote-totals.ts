/**
 * The quote form's money, as a thin adapter over money.ts. No arithmetic lives here: every figure
 * comes from computeTotals, depositOf semantics and checkPlan.
 */
import {
  checkPlan,
  computeTotals,
  MAX_AMOUNT_PENCE,
  MAX_VAT_RATE_BP,
  TOO_LARGE_MESSAGE,
  totalsWithinBounds,
  type Instalment,
  type MoneyLine,
  type Pence,
  type PaymentPlan,
  type PlanCheck,
  type PricedLine,
} from './money';

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
  /** Set when the amounts are beyond what can be calculated exactly; every figure is then zero. Never thrown. */
  error: string | null;
}

/** Most lines one quote may have: the price, up to 10 extras and a discount (with headroom for other callers). */
export const MAX_QUOTE_LINES = 12;

export function quoteLines(input: QuoteMoneyInput): MoneyLine[] {
  const lines: MoneyLine[] = [];
  const vat = input.vatApplies;
  lines.push({ description: 'Works as described', kind: 'Works', qty: 1, unitNetPence: input.priceNetPence ?? 0, vatApplies: vat });
  for (const e of input.extras) lines.push({ description: e.description, kind: 'Extra', qty: 1, unitNetPence: e.netPence, vatApplies: vat });
  if (input.discountPence > 0) lines.push({ description: 'Discount', kind: 'Discount', qty: 1, unitNetPence: -input.discountPence, vatApplies: vat });
  return lines;
}

function tooLarge(input: QuoteMoneyInput): QuoteTotals {
  return {
    lines: [],
    subtotalNetPence: 0,
    discountPence: 0,
    netPence: 0,
    vatPence: 0,
    grossPence: 0,
    depositPence: null,
    balancePence: null,
    schedule: null,
    planCheck: input.plan ? { ok: false, instalments: null, declaredPerStage: [], declaredPence: 0, remainingPence: 0, problems: [{ stage: null, message: TOO_LARGE_MESSAGE }] } : null,
    error: TOO_LARGE_MESSAGE,
  };
}

const inRange = (n: unknown, max: number): boolean => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= max;

/** Never throws. Amounts, line count and VAT rate are bounded before any arithmetic, so the plan maths cannot overflow. */
export function computeQuoteTotals(input: QuoteMoneyInput, vatRateBp: number = DEFAULT_VAT_RATE_BP): QuoteTotals {
  try {
    if (
      !inRange(vatRateBp, MAX_VAT_RATE_BP) ||
      input.extras.length + 2 > MAX_QUOTE_LINES ||
      !(input.priceNetPence === null || inRange(input.priceNetPence, MAX_AMOUNT_PENCE)) ||
      !inRange(input.discountPence, MAX_AMOUNT_PENCE) ||
      !input.extras.every((e) => inRange(e.netPence, MAX_AMOUNT_PENCE))
    ) {
      return tooLarge(input);
    }
    const totals = computeTotals(quoteLines(input), vatRateBp);
    if (!totalsWithinBounds(totals)) return tooLarge(input);
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
      error: null,
    };
  } catch {
    return tooLarge(input);
  }
}
