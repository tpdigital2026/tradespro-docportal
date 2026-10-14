'use client';

import { useEffect, useState } from 'react';
import { formatGBP } from '../../lib/money';
import type { QuoteTotals } from '../../lib/quote-totals';

/** Sticky running total. The visible figures change on every keystroke; screen readers hear the settled figure only. */
export function TotalsBar({ totals, vatApplies }: { totals: QuoteTotals; vatApplies: boolean }) {
  const spoken = `Total ${formatGBP(totals.grossPence)}. ${formatGBP(totals.netPence)} before VAT, ${vatApplies ? `VAT ${formatGBP(totals.vatPence)}` : 'no VAT'}.`;
  const [settled, setSettled] = useState(spoken);
  useEffect(() => {
    const t = setTimeout(() => setSettled(spoken), 700);
    return () => clearTimeout(t);
  }, [spoken]);
  return (
    <div className="qt-bar">
      <p className="qt-bar-total">
        <span className="qt-bar-label">Total</span>
        <span className="qt-bar-amount">{formatGBP(totals.grossPence)}</span>
      </p>
      <p className="qt-bar-parts" aria-hidden="true">
        <span>{formatGBP(totals.netPence)} before VAT</span>
        <span>{vatApplies ? `VAT ${formatGBP(totals.vatPence)}` : 'No VAT'}</span>
      </p>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">{settled}</p>
    </div>
  );
}
