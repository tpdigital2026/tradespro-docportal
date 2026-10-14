'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Field } from '../Field';
import type { StepProps } from './types';

const SHOWN = 8;

export function CustomerStep({ values, set, err, touch, ctx, locked }: StepProps) {
  const [q, setQ] = useState('');
  const term = q.trim().toLowerCase();
  const selected = ctx.customers.find((c) => c.id === values.customerId);
  const matches = term
    ? ctx.customers.filter((c) => `${c.name} ${c.postcode} ${c.addressLine}`.toLowerCase().includes(term))
    : ctx.customers.slice(0, SHOWN);
  // The chosen customer always stays in the list, even when a search would hide them.
  const list = selected && !matches.some((c) => c.id === selected.id) ? [selected, ...matches] : matches;
  const error = err('customerId');

  if (locked && selected) {
    return (
      <section aria-labelledby="step-h" className="qt-step">
        <h2 id="step-h" className="qt-h" tabIndex={-1}>Who is it for?</h2>
        <p className="qt-locked">
          <strong>{selected.name}</strong>
          <span>{[selected.addressLine, selected.postcode].filter(Boolean).join(', ')}</span>
        </p>
        <p className="hint">The customer is fixed once a draft is saved. To quote someone else, start a new quote.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="step-h" className="qt-step">
      <h2 id="step-h" className="qt-h" tabIndex={-1}>Who is it for?</h2>
      {ctx.customers.length === 0 ? (
        <p className="empty">You have no customers yet. Add the first one, then come back to start the quote.</p>
      ) : (
        <>
          <Field
            id="cust-q"
            type="search"
            label="Find a customer"
            hint="Type a name or postcode."
            autoComplete="off"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={60}
          />
          <div role="radiogroup" aria-labelledby="step-h" aria-describedby={error ? 'cust-error' : undefined} className="qt-pick">
            {list.map((c) => (
              <label key={c.id} className={`qt-opt${c.id === values.customerId ? ' is-on' : ''}`}>
                <input
                  type="radio"
                  name="customer"
                  value={c.id}
                  checked={c.id === values.customerId}
                  onChange={() => {
                    // Fill the job address from the customer's, unless the owner has typed their own.
                    const addr = [c.addressLine, c.postcode].filter(Boolean).join(', ');
                    set({ customerId: c.id, propertyAddress: values.propertyAddress.trim() === '' ? addr : values.propertyAddress });
                    touch('customerId');
                  }}
                />
                <span className="qt-opt-main">
                  <span className="qt-opt-title">{c.name}</span>
                  <span className="qt-opt-meta">{[c.addressLine, c.postcode].filter(Boolean).join(', ')}</span>
                </span>
              </label>
            ))}
            {list.length === 0 ? <p className="empty">No customer matches that. Check the spelling or add them.</p> : null}
          </div>
          {!term && ctx.customers.length > SHOWN ? <p className="hint">Showing your {SHOWN} most recent customers. Search to find the rest.</p> : null}
          {error ? <p className="error" id="cust-error" role="alert">{error}</p> : null}
        </>
      )}
      <p className="qt-link"><Link href="/customers/new">Add a new customer</Link></p>
    </section>
  );
}
