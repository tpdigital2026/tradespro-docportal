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
  const rounded = Math.floor((abs * num * 2 + den) / (den * 2));
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
