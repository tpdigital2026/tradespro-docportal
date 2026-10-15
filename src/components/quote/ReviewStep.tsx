'use client';

import { formatGBP } from '../../lib/money';
import { isApproved } from '../../lib/scope/model';
import type { QuoteStep } from '../../lib/validation/quote';
import type { StepProps } from './types';

const longDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const showDate = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(Date.parse(iso)) ? longDate.format(new Date(`${iso}T00:00:00Z`)) : iso || 'Not set');

export function ReviewStep({
  values,
  set,
  ctx,
  totals,
  blockers,
  goTo,
  vatRatePct,
}: StepProps & { blockers: { step: QuoteStep; key: string; message: string }[]; goTo: (s: QuoteStep) => void; vatRatePct: string }) {
  const approvedCopy = isApproved(values.scope) ? values.scope.copy : null;
  const customer = ctx.customers.find((c) => c.id === values.customerId);
  const type = ctx.jobTypes.find((t) => t.id === values.jobTypeId);
  const guarantee = type ? (type.guaranteeYears ? `${type.guaranteeYears} years` : 'No guarantee set') : 'No guarantee';
  const stepName: Record<QuoteStep, string> = { customer: 'Customer', job: 'Job', scope: 'Scope', price: 'Price', plan: 'Plan', review: 'Review' };
  return (
    <section aria-labelledby="step-h" className="qt-step">
      <div className="qt-step-head">
        <h2 id="step-h" className="qt-h" tabIndex={-1}>Check it over</h2>
        <p className="qt-lede">Everything the quote will say. Tap a step above to change anything.</p>
      </div>

      {blockers.length > 0 ? (
        <div className="qt-blockers">
          <p className="qt-blockers-h">A few things to fix before this quote can be saved as ready.</p>
          <ul>
            {blockers.map((b) => (
              <li key={b.key}>
                <button type="button" className="linklike" onClick={() => goTo(b.step)}>
                  {stepName[b.step]}: {b.message}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <dl className="qt-facts">
        <div><dt>For</dt><dd>{customer ? customer.name : 'Not chosen'}</dd></div>
        <div><dt>Quote number</dt><dd>{values.quoteNumber || 'Not set'}</dd></div>
        <div><dt>Date</dt><dd>{showDate(values.date)}</dd></div>
        <div><dt>Job type</dt><dd>{type ? type.label : 'Not listed'}</dd></div>
        <div><dt>Guarantee</dt><dd>{guarantee}</dd></div>
        <div><dt>Address of the work</dt><dd>{values.propertyAddress || 'Not set'}</dd></div>
        <div><dt>Quote title</dt><dd>{values.scope.coverTitle || 'Not set'}</dd></div>
        <div>
          <dt>The work</dt>
          <dd>
            {approvedCopy ? (
              <button type="button" className="linklike" onClick={() => goTo('scope')}>
                {approvedCopy.sections.length} {approvedCopy.sections.length === 1 ? 'group' : 'groups'}, {approvedCopy.sections.reduce((n, s) => n + s.steps.length, 0)} steps. Approved wording.
              </button>
            ) : (
              <button type="button" className="linklike" onClick={() => goTo('scope')}>Not approved yet</button>
            )}
          </dd>
        </div>
      </dl>

      <h3 className="fgroup-h">Money</h3>
      <dl className="qt-sum">
        <div><dt>Price and extras</dt><dd>{formatGBP(totals.subtotalNetPence)}</dd></div>
        {totals.discountPence > 0 ? <div><dt>Discount</dt><dd>{formatGBP(-totals.discountPence)}</dd></div> : null}
        <div><dt>Before VAT</dt><dd>{formatGBP(totals.netPence)}</dd></div>
        <div><dt>{values.vatApplies ? `VAT at ${vatRatePct}%` : 'VAT'}</dt><dd>{values.vatApplies ? formatGBP(totals.vatPence) : 'None'}</dd></div>
        <div className="is-total"><dt>Total</dt><dd>{formatGBP(totals.grossPence)}</dd></div>
      </dl>

      <h3 className="fgroup-h">How it is paid</h3>
      {totals.schedule ? (
        <ul className="qt-sched">
          {totals.schedule.map((i) => (
            <li key={i.index}>
              <span>{i.label}</span>
              <span>{formatGBP(i.grossPence)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">The payment plan is not complete yet.</p>
      )}

      <div className="field">
        <label htmlFor="bank">Pay into</label>
        {ctx.bankAccounts.length === 0 ? (
          <p className="hint">No bank account is set up for your business yet. Payment details are added by TradesPro Digital.</p>
        ) : (
          <>
            <select id="bank" className="input" value={values.bankAccountId} onChange={(e) => set({ bankAccountId: e.target.value })} aria-describedby="bank-hint">
              <option value="">Choose an account</option>
              {ctx.bankAccounts.map((b) => (
                <option key={b.id} value={b.id}>{b.label}</option>
              ))}
            </select>
            <p className="hint" id="bank-hint">Only the last four digits are shown here.</p>
          </>
        )}
      </div>
    </section>
  );
}
