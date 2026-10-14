'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';

export interface CustomerListItem {
  id: string;
  name: string;
  address: string;
  postcode: string;
  keptUntil: string;
  daysLeft: number;
  runningOut: boolean;
}

function norm(s: string): string {
  return s.normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

/** Filters as you type. The list arrives most recently active first and keeps that order. */
export function CustomerSearch({ customers }: { customers: CustomerListItem[] }) {
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const words = q.split(/\s+/).map(norm).filter(Boolean);
    if (words.length === 0) return customers;
    return customers.filter((c) => {
      const hay = norm(`${c.name} ${c.address} ${c.postcode}`);
      return words.every((w) => hay.includes(w));
    });
  }, [q, customers]);

  return (
    <div className="cust-search">
      <div className="field">
        <label htmlFor="customer-search">Find a customer</label>
        <input
          id="customer-search"
          className="input"
          type="search"
          inputMode="search"
          placeholder="Name or postcode"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <p className="cust-count" role="status" aria-live="polite">
        {customers.length === 0 ? '' : `${shown.length} of ${customers.length} ${customers.length === 1 ? 'customer' : 'customers'}`}
      </p>
      {customers.length === 0 ? (
        <p className="empty">No customers yet. Add your first one and it will appear here.</p>
      ) : shown.length === 0 ? (
        <p className="empty">Nobody matches that. Check the spelling or try the postcode.</p>
      ) : (
        <ul className="rows">
          {shown.map((c) => (
            <li key={c.id}>
              <Link href={`/customers/${c.id}`} className="cust-row">
                <span className="cust-main">
                  <span className="row-title">{c.name}</span>
                  <span className="row-meta">{[c.address, c.postcode].filter(Boolean).join(', ')}</span>
                </span>
                <span className={`cust-kept${c.runningOut ? ' is-warn' : ''}`}>
                  {c.runningOut ? `${c.daysLeft === 0 ? 'Due for deletion' : `${c.daysLeft} ${c.daysLeft === 1 ? 'day' : 'days'} left`}` : `Kept until ${c.keptUntil}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
