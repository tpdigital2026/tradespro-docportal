'use client';

import { useState, type FormEvent } from 'react';
import { setPaymentWordingAction } from '../../app/(app)/settings/actions';
import {
  PAYMENT_LIMITS,
  PAYMENT_REFERENCE_CHOICES,
  PAYMENT_REFERENCE_LABELS,
  previewPaymentWording,
  type PaymentWording,
  type PaymentWordingField,
} from '../../lib/payment-wording';
import { Button } from '../Button';
import { Field } from '../Field';
import { StepUp } from '../StepUp';
import { useGuarded } from './useGuarded';

/** How the wording reads on an invoice. The figures are made-up examples. */
function Preview({ wording }: { wording: PaymentWording }) {
  const p = previewPaymentWording(wording);
  return (
    <div className="set-preview" aria-label="How this reads on an invoice">
      <p className="set-preview-h">Deposit invoice</p>
      <dl className="set-dl">
        <div><dt>Due, in the header</dt><dd>{p.deposit.due}</dd></div>
        <div><dt>Under the amount due</dt><dd>{p.deposit.note}</dd></div>
        <div><dt>Terms and conditions</dt><dd>{p.deposit.terms}</dd></div>
      </dl>
      <p className="set-preview-h">Balance invoice</p>
      <dl className="set-dl">
        <div><dt>Due, in the header</dt><dd>{p.balance.due}</dd></div>
        <div><dt>Under the amount due</dt><dd>{p.balance.note}</dd></div>
        <div><dt>Terms and conditions</dt><dd>{p.balance.terms}</dd></div>
      </dl>
      <p className="set-preview-h">Payment reference</p>
      <dl className="set-dl"><div><dt>Printed on the pay card, for example</dt><dd>{p.reference}</dd></div></dl>
      <p className="set-note">The amounts in these examples are made up. Each invoice uses its own figures.</p>
    </div>
  );
}

export function PaymentWordingSettings({ wording, isOwner, email, demo }: { wording: PaymentWording; isOwner: boolean; email: string; demo: boolean }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState<PaymentWording>(wording);
  const g = useGuarded(() => setEditing(false));
  const set = (k: PaymentWordingField) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });

  async function save(e: FormEvent) {
    e.preventDefault();
    await g.run(() => setPaymentWordingAction(v));
  }

  return (
    <div className="set-wording">
      {!editing ? <Preview wording={wording} /> : null}
      <p className="set-note">Full and stage invoices use the balance invoice wording. Invoices already finalised keep the wording they were made with.</p>
      {isOwner && !editing && !g.stepUp ? (
        <button type="button" className="linklike set-change" onClick={() => { g.clear(); setV(wording); setEditing(true); }}>
          Change the payment wording
        </button>
      ) : null}
      {editing && !g.stepUp ? (
        <form className="set-inline-form" onSubmit={save} noValidate>
          <fieldset className="set-fieldset">
            <legend>Deposit invoices</legend>
            <Field id="pw-dep-due" label="Due line" hint="Printed after Due in the header, and in the note under the amount." value={v.depositDueLabel} maxLength={PAYMENT_LIMITS.label} autoComplete="off" onChange={set('depositDueLabel')} error={g.errors.depositDueLabel} />
            <Field id="pw-dep-terms" multiline rows={3} label="Terms and conditions" hint="Write {balance} where the amount still to pay after the deposit should go." value={v.depositTerms} maxLength={PAYMENT_LIMITS.terms} onChange={set('depositTerms')} error={g.errors.depositTerms} />
          </fieldset>
          <fieldset className="set-fieldset">
            <legend>Balance invoices</legend>
            <Field id="pw-bal-due" label="Due line" hint="Printed after Due in the header." value={v.balanceDueLabel} maxLength={PAYMENT_LIMITS.label} autoComplete="off" onChange={set('balanceDueLabel')} error={g.errors.balanceDueLabel} />
            <Field id="pw-bal-note" label="Note under the amount due" value={v.balanceDueNote} maxLength={PAYMENT_LIMITS.note} autoComplete="off" onChange={set('balanceDueNote')} error={g.errors.balanceDueNote} />
            <Field id="pw-bal-terms" multiline rows={3} label="Terms and conditions" value={v.balanceTerms} maxLength={PAYMENT_LIMITS.terms} onChange={set('balanceTerms')} error={g.errors.balanceTerms} />
          </fieldset>
          <fieldset className="qt-vat">
            <legend>The payment reference on invoices says</legend>
            {PAYMENT_REFERENCE_CHOICES.map((c) => (
              <label key={c} className={`qt-opt${v.paymentReference === c ? ' is-on' : ''}`}>
                <input type="radio" name="pw-ref" checked={v.paymentReference === c} onChange={() => setV({ ...v, paymentReference: c })} />
                <span className="qt-opt-main">
                  <span className="qt-opt-title">{PAYMENT_REFERENCE_LABELS[c]}</span>
                  <span className="qt-opt-meta">{c === 'address_line_1' ? 'So you can match a payment to a job. If a job has no address, the invoice number is used.' : 'For example INV-ES-001-D.'}</span>
                </span>
              </label>
            ))}
            {g.errors.paymentReference ? <p className="error" role="alert">{g.errors.paymentReference}</p> : null}
          </fieldset>
          <Preview wording={v} />
          {g.error ? <p className="form-error" role="alert">{g.error}</p> : null}
          <div className="set-row-actions">
            <Button type="submit" pending={g.busy}>{g.busy ? 'Checking' : 'Save'}</Button>
            <button type="button" className="linklike" onClick={() => { setEditing(false); g.clear(); }}>Cancel</button>
          </div>
        </form>
      ) : null}
      {g.stepUp ? <StepUp email={email} demo={demo} idPrefix="su-pw" intro="before changing the payment wording" confirmLabel="Confirm and save" onVerified={g.retry} onCancel={g.cancel} /> : null}
      {!editing && g.error ? <p className="form-error" role="alert">{g.error}</p> : null}
      {g.message ? <p className="set-done" role="status">{g.message}</p> : null}
    </div>
  );
}
