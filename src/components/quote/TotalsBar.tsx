'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { formatGBP } from '../../lib/money';
import type { QuoteTotals } from '../../lib/quote-totals';

const PLAN_NAME = { deposit: 'Deposit, then the balance', full: 'Paid in full', staged: 'Stage payments' } as const;

/**
 * The live quote summary. Desktop: a sticky panel beside the form with the customer, the number, the running totals,
 * the payment plan and the one primary button. Phone and tablet: a slim bar stuck to the bottom with the total and
 * the same button. The visible figures change on every keystroke; screen readers hear the settled figure only.
 */
export function TotalsBar({
  totals,
  vatApplies,
  quoteNumber,
  customer,
  jobType,
  planKind,
  children,
}: {
  totals: QuoteTotals;
  vatApplies: boolean;
  quoteNumber: string;
  customer: { name: string; address: string } | null;
  jobType: string | null;
  planKind: keyof typeof PLAN_NAME;
  /** The primary action for this step. */
  children: ReactNode;
}) {
  const spoken = `Total ${formatGBP(totals.grossPence)}. ${formatGBP(totals.netPence)} before VAT, ${vatApplies ? `VAT ${formatGBP(totals.vatPence)}` : 'no VAT'}.`;
  const [settled, setSettled] = useState(spoken);
  useEffect(() => {
    const t = setTimeout(() => setSettled(spoken), 700);
    return () => clearTimeout(t);
  }, [spoken]);
  return (
    <div className="qt-sum-card">
      <div className="qt-sum-who">
        <p className="eyebrow">{quoteNumber ? `Quote ${quoteNumber}` : 'New quote'}</p>
        <p className="qt-sum-name">{customer ? customer.name : 'No customer chosen yet'}</p>
        {customer?.address ? <p className="qt-sum-meta">{customer.address}</p> : null}
        {jobType ? <p className="qt-sum-meta">{jobType}</p> : null}
      </div>
      <dl className="qt-sum-money" aria-hidden="true">
        <div><dt>Before VAT</dt><dd>{formatGBP(totals.netPence)}</dd></div>
        <div><dt>VAT</dt><dd>{vatApplies ? formatGBP(totals.vatPence) : 'None'}</dd></div>
      </dl>
      <p className="qt-sum-total" aria-hidden="true">
        <span className="qt-sum-label">Total</span>
        <span className="qt-sum-amount">{formatGBP(totals.grossPence)}</span>
      </p>
      <div className="qt-sum-plan">
        <p className="qt-sum-label">{PLAN_NAME[planKind]}</p>
        {totals.schedule ? (
          <ul>
            {totals.schedule.map((i) => (
              <li key={i.index}><span>{i.label}</span><span>{formatGBP(i.grossPence)}</span></li>
            ))}
          </ul>
        ) : (
          <p className="qt-sum-meta">Worked out once the price is in.</p>
        )}
      </div>
      <div className="qt-sum-action">{children}</div>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{settled}</p>
    </div>
  );
}
