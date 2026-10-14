'use client';

import { formatGBP } from '../../lib/money';
import { MAX_EXTRAS } from '../../lib/validation/quote';
import { Button } from '../Button';
import { Field } from '../Field';
import { MoneyField } from '../MoneyField';
import type { StepProps } from './types';

export function PriceStep({ values, set, err, touch, totals, vatRatePct }: StepProps & { vatRatePct: string }) {
  const setExtra = (i: number, patch: Partial<{ description: string; amount: string }>) =>
    set({ extras: values.extras.map((e, k) => (k === i ? { ...e, ...patch } : e)) });
  return (
    <section aria-labelledby="step-h" className="qt-step">
      <h2 id="step-h" className="qt-h" tabIndex={-1}>The price</h2>

      <MoneyField announce={false}
        id="price"
        label="Price of the work, before VAT"
        hint="Pounds and pence, like 8,400 or 8,400.50."
        value={values.price}
        onChange={(e) => set({ price: e.target.value })}
        onBlur={() => touch('price')}
        error={err('price')}
        maxLength={34}
      />

      <fieldset className="qt-vat">
        <legend>VAT</legend>
        <label className={`qt-opt${values.vatApplies ? ' is-on' : ''}`}>
          <input type="radio" name="vat" checked={values.vatApplies} onChange={() => set({ vatApplies: true })} />
          <span className="qt-opt-main">
            <span className="qt-opt-title">Add VAT at {vatRatePct}%</span>
            <span className="qt-opt-meta">VAT is added to the price and any extras.</span>
          </span>
        </label>
        <label className={`qt-opt${!values.vatApplies ? ' is-on' : ''}`}>
          <input type="radio" name="vat" checked={!values.vatApplies} onChange={() => set({ vatApplies: false })} />
          <span className="qt-opt-main">
            <span className="qt-opt-title">No VAT</span>
            <span className="qt-opt-meta">For a business that is not VAT registered.</span>
          </span>
        </label>
      </fieldset>

      <div className="qt-extras">
        <h3 className="qt-h3">Extras</h3>
        <p className="hint">Anything on top of the main price, like extra flashing. Optional.</p>
        {values.extras.map((x, i) => (
          <div className="qt-extra" key={i}>
            <Field announce={false}
              id={`extra-d-${i}`}
              label={`Extra ${i + 1}`}
              value={x.description}
              onChange={(e) => setExtra(i, { description: e.target.value })}
              onBlur={() => touch(`extras.${i}.description`)}
              error={err(`extras.${i}.description`)}
              maxLength={120}
              autoComplete="off"
            />
            <MoneyField announce={false}
              id={`extra-a-${i}`}
              label="Amount, before VAT"
              value={x.amount}
              onChange={(e) => setExtra(i, { amount: e.target.value })}
              onBlur={() => touch(`extras.${i}.amount`)}
              error={err(`extras.${i}.amount`)}
              maxLength={34}
            />
            <Button type="button" variant="secondary" onClick={() => set({ extras: values.extras.filter((_, k) => k !== i) })} aria-label={`Remove extra ${i + 1}`}>
              Remove
            </Button>
          </div>
        ))}
        {values.extras.length < MAX_EXTRAS ? (
          <Button type="button" variant="secondary" onClick={() => set({ extras: [...values.extras, { description: '', amount: '' }] })}>
            Add an extra
          </Button>
        ) : (
          <p className="hint">That is the most extras one quote can carry.</p>
        )}
      </div>

      <MoneyField announce={false}
        id="discount"
        label="Discount, before VAT"
        hint="Optional. Taken off the price and extras before VAT is worked out."
        value={values.discount}
        onChange={(e) => set({ discount: e.target.value })}
        onBlur={() => touch('discount')}
        error={err('discount')}
        maxLength={34}
      />

      <dl className="qt-sum">
        <div><dt>Price and extras</dt><dd>{formatGBP(totals.subtotalNetPence)}</dd></div>
        {totals.discountPence > 0 ? <div><dt>Discount</dt><dd>{formatGBP(-totals.discountPence)}</dd></div> : null}
        <div><dt>Before VAT</dt><dd>{formatGBP(totals.netPence)}</dd></div>
        <div><dt>{values.vatApplies ? `VAT at ${vatRatePct}%` : 'VAT'}</dt><dd>{values.vatApplies ? formatGBP(totals.vatPence) : 'None'}</dd></div>
        <div className="is-total"><dt>Total</dt><dd>{formatGBP(totals.grossPence)}</dd></div>
      </dl>
    </section>
  );
}
