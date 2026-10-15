import Link from 'next/link';
import { buildBalances } from '../lib/business/money-board';
import { getBusinessFacts } from '../lib/data/business';
import { todayLondon } from '../lib/london';
import { formatGBP } from '../lib/money';
import '../styles/business.css';

/**
 * Home's small Money card: the outstanding total on issued invoices and how many are overdue, linking to Money.
 * Shown only when at least one invoice has been issued, so a new business never sees a row of zeros.
 */
export async function MoneyStrip() {
  let b: ReturnType<typeof buildBalances> | null = null;
  try {
    b = buildBalances((await getBusinessFacts()).jobs, todayLondon());
  } catch {
    return null;
  }
  if (!b.anyInvoices) return null;
  return (
    <Link href="/money" className={`money-strip${b.overdueInvoices ? ' has-overdue' : ''}`}>
      <span className="money-strip-fig">
        <span className="money-strip-label">Outstanding on invoices</span>
        <span className="money-strip-n">{formatGBP(b.outstandingPence)}</span>
      </span>
      <span className="money-strip-fig">
        <span className="money-strip-label">Overdue</span>
        <span className={`money-strip-n${b.overdueInvoices ? ' is-overdue' : ''}`}>{b.overdueInvoices === 0 ? 'None' : `${b.overdueInvoices} ${b.overdueInvoices === 1 ? 'invoice' : 'invoices'}`}</span>
      </span>
      <span className="money-strip-go">Open Money</span>
    </Link>
  );
}
