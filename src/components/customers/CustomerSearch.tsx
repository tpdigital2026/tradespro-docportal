'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ButtonLink } from '../Button';
import { EmptyState } from '../EmptyState';
import { initials } from '../../lib/initials';

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

  if (customers.length === 0) {
    return (
      <EmptyState icon="people" title="You have no customers yet" action={<ButtonLink href="/customers/new">Add your first customer</ButtonLink>}>
        Add a customer once and their name and address go on every quote, invoice and receipt you make for them.
      </EmptyState>
    );
  }

  return (
    <div className="cust-search">
      <div className="field search-field">
        <label htmlFor="customer-search">Find a customer</label>
        <svg className="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M10.5 17a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM15.5 15.5L20 20" /></svg>
        <input
          id="customer-search"
          className="input search-input"
          type="search"
          inputMode="search"
          placeholder="Name, street or postcode"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <p className="cust-count" role="status" aria-live="polite">
        {q.trim() === '' ? `${customers.length} ${customers.length === 1 ? 'customer' : 'customers'}, most recent first` : `${shown.length} of ${customers.length} ${customers.length === 1 ? 'customer' : 'customers'}`}
      </p>
      {shown.length === 0 ? (
        <EmptyState icon="search" title="Nobody matches that" compact>
          Check the spelling, or try part of the postcode or street instead.
        </EmptyState>
      ) : (
        <ul className="cust-list">
          {shown.map((c) => (
            <li key={c.id}>
              <Link href={`/customers/${c.id}`} className="cust-row">
                <span className="avatar" aria-hidden="true">{initials(c.name)}</span>
                <span className="cust-main">
                  <span className="cust-name">{c.name}</span>
                  <span className="cust-addr">{[c.address, c.postcode].filter(Boolean).join(', ')}</span>
                </span>
                <span className={`chip${c.runningOut ? ' is-warn' : ''}`}>
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
