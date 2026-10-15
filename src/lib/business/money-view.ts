/**
 * What the Money screen shows for a set of URL parameters, and the same rows as CSV. Pure: the page and the export
 * route both call this, so the export is exactly the rows on screen.
 */
import { DOC_TYPE_NAMES } from '../job-stage';
import { addMonths, isMonth, monthLabel, monthOf, shortDate } from '../london';
import type { JobFacts } from './facts';
import { buildBalances, isBalanceFilter, methodLabel, paymentRows, paymentTotals, type BalanceFilter, type Balances, type PaymentRow, type PaymentTotals } from './money-board';
import { pounds, toCsv } from './csv';

export type MoneyTab = 'balances' | 'payments';

export interface MoneyParams {
  view: MoneyTab;
  filter: BalanceFilter;
  /** yyyy-mm, the month of payments shown. */
  month: string;
}

const one = (v: string | string[] | null | undefined) => (Array.isArray(v) ? v[0] : (v ?? undefined));

export function parseMoneyParams(sp: Record<string, string | string[] | undefined> | URLSearchParams, today: string): MoneyParams {
  const get = (k: string) => (sp instanceof URLSearchParams ? (sp.get(k) ?? undefined) : one(sp[k]));
  const view = get('view') === 'payments' ? 'payments' : 'balances';
  const f = get('f');
  const m = get('m');
  const thisMonth = monthOf(today);
  // Never a month after this one: there cannot be payments recorded in the future.
  const month = isMonth(m) && m <= thisMonth ? m : thisMonth;
  return { view, filter: isBalanceFilter(f) ? f : 'all', month };
}

export function moneyHref(p: Partial<MoneyParams>): string {
  const q = new URLSearchParams();
  if (p.view === 'payments') q.set('view', 'payments');
  if (p.view !== 'payments' && p.filter && p.filter !== 'all') q.set('f', p.filter);
  if (p.view === 'payments' && p.month) q.set('m', p.month);
  const s = q.toString();
  return s ? `/money?${s}` : '/money';
}

export function exportHref(p: MoneyParams): string {
  const q = new URLSearchParams({ view: p.view });
  if (p.view === 'balances') q.set('f', p.filter);
  else q.set('m', p.month);
  return `/api/money/export?${q.toString()}`;
}

export interface MoneyView {
  params: MoneyParams;
  balances: Balances;
  /** Every recorded payment, newest first. */
  allPayments: PaymentRow[];
  /** The payments in the chosen month. */
  monthPayments: PaymentRow[];
  totals: PaymentTotals;
  /** This calendar month's and year's totals, whatever month is being looked at. */
  current: PaymentTotals;
  prevMonth: string;
  nextMonth: string | null;
}

export function moneyView(jobs: JobFacts[], params: MoneyParams, today: string): MoneyView {
  const allPayments = paymentRows(jobs);
  const thisMonth = monthOf(today);
  const next = addMonths(params.month, 1);
  return {
    params,
    balances: buildBalances(jobs, today, params.filter),
    allPayments,
    monthPayments: allPayments.filter((r) => monthOf(r.paidOn) === params.month),
    totals: paymentTotals(allPayments, params.month),
    current: paymentTotals(allPayments, thisMonth),
    prevMonth: addMonths(params.month, -1),
    nextMonth: next <= thisMonth ? next : null,
  };
}

/** The visible rows as CSV, with a filename that says what they are. */
export function moneyCsv(v: MoneyView): { filename: string; body: string } {
  if (v.params.view === 'payments') {
    const rows = v.monthPayments.map((r) => [r.paidOn, r.customerName, r.quoteNumber, r.invoiceNumber, r.part, pounds(r.amountPence), methodLabel(r.method), r.receiptNumber ?? '']);
    return {
      filename: `payments-received-${v.params.month}.csv`,
      body: toCsv(['Date paid', 'Customer', 'Quote', 'Invoice', 'For', 'Amount (GBP)', 'Method', 'Receipt'], rows),
    };
  }
  const rows: (string | number | null)[][] = [];
  for (const b of v.balances.rows) {
    if (b.invoices.length === 0) {
      rows.push([b.customerName, b.quoteNumber, '', '', '', '', '', '', 'Not invoiced yet', pounds(b.quotedPence), pounds(b.toInvoicePence)]);
      continue;
    }
    for (const i of b.invoices) {
      const status = i.settled ? 'Settled' : i.overdue ? `Overdue by ${i.daysOverdue} ${i.daysOverdue === 1 ? 'day' : 'days'}` : i.receivedPence > 0 ? 'Part paid' : 'Not paid';
      rows.push([b.customerName, b.quoteNumber, i.number, `${DOC_TYPE_NAMES[i.type]} (${i.part})`, i.issuedOn, i.dueOn ?? (i.dueCheck ? `Check the due date on this invoice: ${i.dueWording ?? ''}` : (i.dueWording ?? '')), pounds(i.grossPence), pounds(i.receivedPence), status, pounds(b.quotedPence), pounds(b.toInvoicePence)]);
    }
  }
  return {
    filename: `balances-${v.params.filter}.csv`,
    body: toCsv(['Customer', 'Quote', 'Invoice', 'Type', 'Issued', 'Due', 'Invoice total (GBP)', 'Received (GBP)', 'Status', 'Quote total (GBP)', 'Still to invoice (GBP)'], rows),
  };
}

export const monthTitle = monthLabel;
export const payDate = (iso: string) => shortDate(iso);
