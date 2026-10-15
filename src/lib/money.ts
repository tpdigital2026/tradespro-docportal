export type Pence = number;

export interface MoneyLine {
  description: string;
  kind: string;
  qty: number;
  unitNetPence: Pence;
  vatApplies: boolean;
}

export interface PricedLine extends MoneyLine {
  netPence: Pence;
  vatPence: Pence;
  grossPence: Pence;
}

export interface Totals {
  lines: PricedLine[];
  netPence: Pence;
  vatPence: Pence;
  grossPence: Pence;
}

function assertInt(n: number, label: string): void {
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`${label} must be a whole number, got ${n}`);
  }
}

/** value * num / den, rounded half away from zero, using integer arithmetic only. */
export function mulDivRound(value: number, num: number, den: number): number {
  assertInt(value, 'value');
  assertInt(num, 'numerator');
  assertInt(den, 'denominator');
  if (den <= 0) throw new RangeError('denominator must be positive');
  if (num < 0) throw new RangeError('numerator must not be negative');
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  const scaled = abs * num * 2 + den;
  if (!Number.isSafeInteger(scaled)) throw new RangeError('amount too large to calculate exactly');
  const rounded = Math.floor(scaled / (den * 2));
  // Avoid returning -0 for negative values that round to zero.
  return rounded === 0 ? 0 : sign * rounded;
}

export function vatOnNet(netPence: Pence, rateBp: number): Pence {
  return mulDivRound(netPence, rateBp, 10000);
}

export function priceLine(line: MoneyLine, rateBp: number): PricedLine {
  assertInt(line.qty, 'quantity');
  if (line.qty < 1) throw new RangeError('quantity must be at least 1');
  assertInt(line.unitNetPence, 'unit price');
  const netPence = line.qty * line.unitNetPence;
  const vatPence = line.vatApplies ? vatOnNet(netPence, rateBp) : 0;
  return { ...line, netPence, vatPence, grossPence: netPence + vatPence };
}

export function computeTotals(lines: MoneyLine[], rateBp: number): Totals {
  const priced = lines.map((l) => priceLine(l, rateBp));
  const netPence = priced.reduce((s, l) => s + l.netPence, 0);
  const vatPence = priced.reduce((s, l) => s + l.vatPence, 0);
  return { lines: priced, netPence, vatPence, grossPence: netPence + vatPence };
}

export function depositOf(totals: Totals, pctBp: number) {
  const netPence = mulDivRound(totals.netPence, pctBp, 10000);
  const vatPence = mulDivRound(totals.vatPence, pctBp, 10000);
  return { netPence, vatPence, grossPence: netPence + vatPence };
}

export function balanceDue(quoteGrossPence: Pence, receivedPence: Pence[]): Pence {
  assertInt(quoteGrossPence, 'quote total');
  receivedPence.forEach((p) => assertInt(p, 'payment'));
  const remaining = quoteGrossPence - receivedPence.reduce((s, p) => s + p, 0);
  if (remaining < 0) throw new RangeError('Payments exceed the quote total');
  return remaining;
}

export function formatGBP(pence: Pence): string {
  assertInt(pence, 'amount');
  const abs = Math.abs(pence);
  const pounds = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rest = String(abs % 100).padStart(2, '0');
  return `${pence < 0 ? '-' : ''}£${pounds}.${rest}`;
}

export interface BalanceStatement {
  quote: Totals;
  adjustments: Totals | null;
  deposit: { netPence: Pence; vatPence: Pence; grossPence: Pence };
  balance: { netPence: Pence; vatPence: Pence; grossPence: Pence };
  totalGrossPence: Pence;
}

/** Balance invoice maths. The deposit is taken on the original quote only; extras and credits sit on top. */
export function balanceStatement(
  quoteLines: MoneyLine[],
  adjustmentLines: MoneyLine[],
  rateBp: number,
  depositPctBp: number,
): BalanceStatement {
  const quote = computeTotals(quoteLines, rateBp);
  const adjustments = adjustmentLines.length > 0 ? computeTotals(adjustmentLines, rateBp) : null;
  const all = computeTotals([...quoteLines, ...adjustmentLines], rateBp);
  const deposit = depositOf(quote, depositPctBp);
  const balance = {
    netPence: all.netPence - deposit.netPence,
    vatPence: all.vatPence - deposit.vatPence,
    grossPence: all.grossPence - deposit.grossPence,
  };
  if (balance.grossPence < 0) throw new RangeError('The deposit is larger than the total');
  return { quote, adjustments, deposit, balance, totalGrossPence: all.grossPence };
}

// ------------------------------------------------------------------ payment plans

/** One part of the job's bill. Index is 1-based. All three amounts are whole pence and net + VAT = gross. */
export interface Instalment {
  index: number;
  label: string;
  netPence: Pence;
  vatPence: Pence;
  grossPence: Pence;
}

/** A stage of a staged plan: a label and either a share of the job (basis points of 100%) or a fixed gross amount. */
export type PlanStage = { label: string } & ({ mode: 'pct'; pctBp: number } | { mode: 'amount'; grossPence: Pence });

export type PaymentPlan =
  | { kind: 'deposit'; pctBp: number }
  | { kind: 'full' }
  | { kind: 'staged'; stages: PlanStage[] };

/**
 * Hard bounds, checked before any plan maths so nothing can overflow an exact integer product.
 * Largest product anywhere: a fixed stage amount x the job VAT x 2 inside mulDivRound. With the job gross at most
 * 125,000,000 pence (1,000,000 pounds net plus 25% VAT) and VAT at most 25,000,000, that is 6.25e15, under 2^53 (9.007e15).
 * The rate cap is conservative: UK VAT tops out at 20%, so 25% leaves room without admitting nonsense.
 */
export const MAX_VAT_RATE_BP = 2500;
export const MAX_AMOUNT_PENCE: Pence = 100_000_000;
export const MAX_TOTAL_NET_PENCE: Pence = 100_000_000;
export const MAX_TOTAL_GROSS_PENCE: Pence = MAX_TOTAL_NET_PENCE + (MAX_TOTAL_NET_PENCE * MAX_VAT_RATE_BP) / 10000;
/** The one bounds check for a quote's totals, used by every caller before any plan maths. */
export function totalsWithinBounds(t: { netPence: number; vatPence: number; grossPence: number }): boolean {
  return (
    Number.isSafeInteger(t.netPence) && Number.isSafeInteger(t.vatPence) && Number.isSafeInteger(t.grossPence) &&
    t.netPence <= MAX_TOTAL_NET_PENCE && t.vatPence <= MAX_TOTAL_GROSS_PENCE - MAX_TOTAL_NET_PENCE && t.grossPence <= MAX_TOTAL_GROSS_PENCE
  );
}
export const TOO_LARGE_MESSAGE = 'This quote is too large to calculate. Check the amounts.';

export const MIN_STAGES = 2;
export const MAX_STAGES = 10;
export const STAGE_LABEL_MAX = 80;
/** Deposits move in half-percent steps (50 basis points) from 1% to 99%. */
export const DEPOSIT_STEP_BP = 50;
export const DEPOSIT_MIN_BP = 100;
export const DEPOSIT_MAX_BP = 9900;

export interface PlanProblem {
  /** Zero-based stage the problem belongs to, or null when it is about the plan as a whole. */
  stage: number | null;
  message: string;
}

export interface PlanCheck {
  ok: boolean;
  /** Present only when the plan is complete and adds up exactly. */
  instalments: Instalment[] | null;
  /** What each stage works out at as typed (gross pence), or null where it cannot be worked out yet. */
  declaredPerStage: (Pence | null)[];
  /** What the owner has placed so far. For an all-percentage plan this is the job gross times the percentages entered. */
  declaredPence: Pence;
  /** Job gross minus declaredPence. Positive means money still to place, negative means over-allocated. */
  remainingPence: Pence;
  problems: PlanProblem[];
}

export class PlanError extends RangeError {
  constructor(
    message: string,
    readonly stage: number | null = null,
  ) {
    super(message);
    this.name = 'PlanError';
  }
}

/** 3000 -> "30", 3250 -> "32.5", 3333 -> "33.33". Never uses floats. */
export function formatPct(bp: number): string {
  assertInt(bp, 'percentage');
  const whole = Math.trunc(bp / 100);
  const frac = String(bp % 100).padStart(2, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

type Share = { netPence: Pence; vatPence: Pence; grossPence: Pence };

/**
 * What a stage is worth taken on its own.
 * Percentage: that share of the job's net and of its VAT, each rounded half away from zero (the same rule as depositOf).
 * Fixed amount: entered as gross; its VAT is the job's VAT share of that amount (amount x job VAT / job gross, rounded
 * half away from zero) and the net is the rest, so the split follows the job's own VAT mix.
 */
function shareOf(totals: Totals, stage: PlanStage): Share {
  if (stage.mode === 'pct') {
    const netPence = mulDivRound(totals.netPence, stage.pctBp, 10000);
    const vatPence = mulDivRound(totals.vatPence, stage.pctBp, 10000);
    return { netPence, vatPence, grossPence: netPence + vatPence };
  }
  const vatPence = mulDivRound(stage.grossPence, totals.vatPence, totals.grossPence);
  return { netPence: stage.grossPence - vatPence, vatPence, grossPence: stage.grossPence };
}

const isWholePence = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n);

function finish(
  totals: Totals,
  parts: { label: string; share: Share }[],
  declaredPerStage: (Pence | null)[],
  declaredPence: Pence,
  problems: PlanProblem[],
): PlanCheck {
  if (problems.length > 0) {
    return { ok: false, instalments: null, declaredPerStage, declaredPence, remainingPence: totals.grossPence - declaredPence, problems };
  }
  const instalments = parts.map((p, i) => ({ index: i + 1, label: p.label, ...p.share }));
  return { ok: true, instalments, declaredPerStage, declaredPence, remainingPence: totals.grossPence - declaredPence, problems };
}

/** Everything the UI and the server need to know about a plan against a job's totals. Never throws, whatever it is given. */
export function checkPlan(totals: Totals, plan: PaymentPlan): PlanCheck {
  const refuse = (): PlanCheck => ({ ok: false, instalments: null, declaredPerStage: [], declaredPence: 0, remainingPence: 0, problems: [{ stage: null, message: TOO_LARGE_MESSAGE }] });
  if (!totalsWithinBounds(totals)) {
    return totals.grossPence <= 0 || totals.netPence < 0 ? checkPlanUnsafe(totals, plan) : refuse();
  }
  try {
    return checkPlanUnsafe(totals, plan);
  } catch {
    return refuse();
  }
}

function checkPlanUnsafe(totals: Totals, plan: PaymentPlan): PlanCheck {
  const problems: PlanProblem[] = [];
  const gross = totals.grossPence;
  if (!isWholePence(gross) || !isWholePence(totals.netPence) || !isWholePence(totals.vatPence)) {
    return { ok: false, instalments: null, declaredPerStage: [], declaredPence: 0, remainingPence: 0, problems: [{ stage: null, message: 'The job total is not valid yet.' }] };
  }
  if (gross <= 0 || totals.netPence < 0 || totals.vatPence < 0) {
    return { ok: false, instalments: null, declaredPerStage: [], declaredPence: 0, remainingPence: gross, problems: [{ stage: null, message: 'The job total must be more than zero before you choose how it is paid.' }] };
  }

  if (plan.kind === 'full') {
    const share = { netPence: totals.netPence, vatPence: totals.vatPence, grossPence: gross };
    return finish(totals, [{ label: 'Invoice', share }], [gross], gross, problems);
  }

  if (plan.kind === 'deposit') {
    const bp = plan.pctBp;
    if (!isWholePence(bp) || bp < DEPOSIT_MIN_BP || bp > DEPOSIT_MAX_BP || bp % DEPOSIT_STEP_BP !== 0) {
      return {
        ok: false,
        instalments: null,
        declaredPerStage: [null, null],
        declaredPence: 0,
        remainingPence: gross,
        problems: [{ stage: 0, message: 'The deposit must be between 1% and 99%, in steps of half a percent.' }],
      };
    }
    const dep = depositOf(totals, bp);
    const bal = { netPence: totals.netPence - dep.netPence, vatPence: totals.vatPence - dep.vatPence, grossPence: gross - dep.grossPence };
    if (dep.grossPence <= 0) problems.push({ stage: 0, message: 'That deposit works out at nothing. Choose a larger percentage.' });
    if (bal.grossPence <= 0) problems.push({ stage: 1, message: 'The deposit leaves nothing for the balance. Choose a smaller percentage.' });
    return finish(
      totals,
      [
        { label: `Deposit (${formatPct(bp)}%)`, share: dep },
        { label: 'Balance', share: bal },
      ],
      [dep.grossPence, bal.grossPence],
      gross,
      problems,
    );
  }

  // staged
  const stages = plan.stages;
  const n = stages.length;
  if (n < MIN_STAGES || n > MAX_STAGES) {
    problems.push({ stage: null, message: `A staged plan has between ${MIN_STAGES} and ${MAX_STAGES} stages.` });
  }
  const declared: (Pence | null)[] = stages.map(() => null);
  const shares: (Share | null)[] = stages.map(() => null);
  stages.forEach((s, i) => {
    const label = typeof s.label === 'string' ? s.label.trim() : '';
    if (label === '') problems.push({ stage: i, message: 'Give this stage a name, like "Scaffold up and strip complete".' });
    else if (label.length > STAGE_LABEL_MAX) problems.push({ stage: i, message: `Keep the stage name to ${STAGE_LABEL_MAX} characters or fewer.` });
    if (s.mode === 'pct') {
      if (!isWholePence(s.pctBp) || s.pctBp < 1 || s.pctBp > 9999) {
        problems.push({ stage: i, message: 'A stage percentage must be more than 0% and less than 100%.' });
        return;
      }
    } else if (s.mode === 'amount') {
      if (!isWholePence(s.grossPence) || s.grossPence < 1) {
        problems.push({ stage: i, message: 'Enter an amount above £0.00 for this stage.' });
        return;
      }
      if (s.grossPence >= gross) {
        problems.push({ stage: i, message: 'One stage cannot be the whole job. Split it across the stages.' });
        return;
      }
    } else {
      problems.push({ stage: i, message: 'Choose a percentage or an amount for this stage.' });
      return;
    }
    shares[i] = shareOf(totals, s);
    declared[i] = shares[i]!.grossPence;
  });

  const allPct = stages.every((s) => s.mode === 'pct');
  const bpSum = allPct ? stages.reduce((sum, s) => sum + (s.mode === 'pct' && isWholePence(s.pctBp) ? s.pctBp : 0), 0) : 0;
  const declaredPence = allPct
    ? mulDivRound(gross, bpSum, 10000)
    : declared.reduce<number>((sum, d) => sum + (d ?? 0), 0);

  if (problems.length > 0) {
    return { ok: false, instalments: null, declaredPerStage: declared, declaredPence, remainingPence: gross - declaredPence, problems };
  }

  // Every stage but the last is worked out on its own; the last takes whatever is left, so the sum is exact.
  const head = shares.slice(0, n - 1) as Share[];
  head.forEach((h, i) => {
    if (h.grossPence <= 0) problems.push({ stage: i, message: 'This stage works out at £0.00. Raise its percentage or amount.' });
  });
  const last: Share = {
    netPence: totals.netPence - head.reduce((s, h) => s + h.netPence, 0),
    vatPence: totals.vatPence - head.reduce((s, h) => s + h.vatPence, 0),
    grossPence: gross - head.reduce((s, h) => s + h.grossPence, 0),
  };
  if (last.grossPence <= 0 || last.netPence < 0 || last.vatPence < 0) {
    problems.push({ stage: n - 1, message: 'The earlier stages already use the whole job. Lower them so the last stage has something left.' });
  } else if (allPct) {
    if (bpSum !== 10000) {
      const diff = bpSum - 10000;
      problems.push({ stage: null, message: diff > 0 ? `The stages add up to ${formatPct(bpSum)}%, which is ${formatPct(diff)}% too much. They must total 100%.` : `The stages add up to ${formatPct(bpSum)}%. ${formatPct(-diff)}% is still to place so they total 100%.` });
    }
  } else if (declared[n - 1] !== last.grossPence) {
    const diff = last.grossPence - (declared[n - 1] as number);
    problems.push({
      stage: null,
      message:
        diff > 0
          ? `The stages leave ${formatGBP(diff)} of the job unplaced. They must add up to ${formatGBP(gross)}.`
          : `The stages are ${formatGBP(-diff)} over the job total of ${formatGBP(gross)}.`,
    });
  }

  const parts = stages.map((s, i) => ({ label: s.label.trim(), share: i === n - 1 ? last : (shares[i] as Share) }));
  return finish(totals, parts, declared, declaredPence, problems);
}

/**
 * The instalments a plan produces for a job. Throws PlanError when the plan is incomplete or does not add up.
 * The instalments always sum to the job's net, VAT and gross exactly: the balance, or the last stage, is taken by subtraction.
 */
export function buildSchedule(totals: Totals, plan: PaymentPlan): Instalment[] {
  const c = checkPlan(totals, plan);
  if (!c.ok || !c.instalments) throw new PlanError(c.problems[0]?.message ?? 'The payment plan is not complete.', c.problems[0]?.stage ?? null);
  return c.instalments;
}

/**
 * The net and VAT of one payment received against an instalment. The VAT of everything received so far is the
 * instalment's VAT share of that amount (amount x instalment VAT / instalment gross, half away from zero, the same
 * rule as a fixed stage amount); a payment is the difference between that after it and before it. So part payments
 * always add up to the instalment's own net and VAT once it is paid in full. priorPence is what was received
 * before this payment, in order.
 */
export function paymentShare(inst: { vatPence: Pence; grossPence: Pence }, priorPence: Pence, amountPence: Pence): { netPence: Pence; vatPence: Pence; grossPence: Pence } {
  assertInt(priorPence, 'prior payments');
  assertInt(amountPence, 'payment');
  if (priorPence < 0 || amountPence < 1 || inst.grossPence < 1 || priorPence + amountPence > inst.grossPence) throw new RangeError('The payment does not fit the instalment');
  const cum = (x: Pence) => mulDivRound(x, inst.vatPence, inst.grossPence);
  const vatPence = cum(priorPence + amountPence) - cum(priorPence);
  return { netPence: amountPence - vatPence, vatPence, grossPence: amountPence };
}
