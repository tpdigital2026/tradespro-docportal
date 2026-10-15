'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { Button, ButtonLink } from '../../../../../components/Button';
import { Field } from '../../../../../components/Field';
import { MoneyField } from '../../../../../components/MoneyField';
import { formatGBP } from '../../../../../lib/money';
import { defaultPaymentForm, PAYMENT_METHODS, PAYMENT_METHOD_LABELS, PAYMENT_NOTE_MAX, type PaymentErrors, type PaymentFormValues } from '../../../../../lib/payment';
import { newDocumentHref } from '../../../../../lib/job-stage';
import { markAsPaidAction, type PayResult } from './actions';

/**
 * A button that opens a dialog: confirm the amount (it starts as what is still owed), the date and how it was paid.
 * The invoice itself is never changed. When it is saved the dialog offers "Create receipt".
 */
export function MarkAsPaid({
  quote,
  instalment,
  heading,
  invoiceNumber,
  outstandingPence,
  today,
  label,
  primary,
}: {
  quote: string;
  instalment: number;
  heading: string;
  invoiceNumber: string;
  outstandingPence: number;
  today: string;
  label: string;
  primary: boolean;
}) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [values, setValues] = useState<PaymentFormValues>(() => defaultPaymentForm(outstandingPence, today));
  const [errors, setErrors] = useState<PaymentErrors>({});
  const [message, setMessage] = useState('');
  const [done, setDone] = useState<Extract<PayResult, { ok: true }> | null>(null);
  const [pending, start] = useTransition();
  const id = `pay-${instalment}`;

  const set = (patch: Partial<PaymentFormValues>) => setValues((v) => ({ ...v, ...patch }));

  const open = () => {
    setValues(defaultPaymentForm(outstandingPence, today));
    setErrors({});
    setMessage('');
    setDone(null);
    dialog.current?.showModal();
  };
  const close = () => {
    dialog.current?.close();
  };
  const onClosed = () => {
    opener.current?.focus();
    if (done) router.refresh();
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    setMessage('');
    start(async () => {
      const r = await markAsPaidAction(quote, instalment, values);
      if (r.ok) setDone(r);
      else {
        setErrors(r.errors ?? {});
        setMessage(r.errors && Object.keys(r.errors).length ? '' : r.message);
      }
    });
  };

  return (
    <>
      <Button ref={opener} type="button" variant={primary ? 'primary' : 'secondary'} onClick={open} aria-haspopup="dialog">
        {label}
      </Button>
      <dialog ref={dialog} className="pay-dialog" aria-labelledby={`${id}-h`} onClose={onClosed}>
        {done ? (
          <div className="pay-body" role="status">
            <span className="pay-tick" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
            </span>
            <h2 id={`${id}-h`} className="pay-h">{done.repeat ? 'Already recorded' : 'Payment recorded'}</h2>
            {done.repeat ? <p className="pay-lede">That payment was already recorded just now.</p> : null}
            <p className="pay-lede">
              {done.remainingPence > 0 ? `${formatGBP(done.remainingPence)} is still to come in on this invoice.` : `${heading} is paid in full.`}
            </p>
            <div className="pay-actions">
              <ButtonLink href={newDocumentHref('receipt', quote, { n: instalment, payment: done.paymentId })}>Create receipt</ButtonLink>
              <Button type="button" variant="secondary" onClick={close}>Not now</Button>
            </div>
          </div>
        ) : (
          <form className="pay-body" onSubmit={submit} noValidate>
            <div className="pay-head">
              <p className="eyebrow">{invoiceNumber}</p>
              <h2 id={`${id}-h`} className="pay-h">Mark as paid</h2>
              <p className="pay-lede">{heading}</p>
            </div>
            <p className="pay-owed"><span>Still owed</span><strong>{formatGBP(outstandingPence)}</strong></p>
            <MoneyField id={`${id}-amount`} label="Amount received" hint="Change it if only part has been paid." value={values.amount} onChange={(e) => set({ amount: e.target.value })} error={errors.amount} />
            <Field id={`${id}-date`} label="Date received" type="date" max={today} value={values.paidOn} onChange={(e) => set({ paidOn: e.target.value })} error={errors.paidOn} />
            <div className="field">
              <label htmlFor={`${id}-method`}>How was it paid?</label>
              <select id={`${id}-method`} className="input" value={values.method} onChange={(e) => set({ method: e.target.value })} aria-invalid={errors.method ? true : undefined} aria-describedby={errors.method ? `${id}-method-error` : undefined}>
                {PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
                ))}
              </select>
              {errors.method ? <p className="error" id={`${id}-method-error`} role="alert">{errors.method}</p> : null}
            </div>
            <Field id={`${id}-note`} label="Note" hint="Optional, for example a cheque number." maxLength={PAYMENT_NOTE_MAX} value={values.note} onChange={(e) => set({ note: e.target.value })} error={errors.note} />
            {message ? <p className="form-error" role="alert">{message}</p> : null}
            <div className="pay-actions">
              <Button type="submit" disabled={pending}>{pending ? 'Saving' : 'Save payment'}</Button>
              <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
