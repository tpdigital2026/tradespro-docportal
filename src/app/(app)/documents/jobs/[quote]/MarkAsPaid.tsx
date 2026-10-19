'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import { Button } from '../../../../../components/Button';
import { Field } from '../../../../../components/Field';
import { MoneyField } from '../../../../../components/MoneyField';
import { formatGBP } from '../../../../../lib/money';
import { defaultPaymentForm, PAYMENT_METHOD_LABELS, PAYMENT_NOTE_MAX, type PaymentErrors, type PaymentFormValues, type PaymentMethod } from '../../../../../lib/payment';
import { markAsPaidAction, refreshAfterPaymentAction, type PayResult } from './actions';
import { CreateReceipt } from './CreateReceipt';

/** The four ways a trades customer pays, as one clear choice. A cheque is recorded as Other, with its number in the note. */
const PAY_CHOICES: PaymentMethod[] = ['bank transfer', 'cash', 'card', 'other'];

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
  autoOpen = false,
}: {
  quote: string;
  instalment: number;
  heading: string;
  invoiceNumber: string;
  outstandingPence: number;
  today: string;
  label: string;
  primary: boolean;
  /** Opened from Home's "Mark invoice as paid": the form shows at once. */
  autoOpen?: boolean;
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

  const opened = useRef(false);
  useEffect(() => {
    if (autoOpen && !opened.current && dialog.current && !dialog.current.open) {
      opened.current = true;
      dialog.current.showModal();
    }
  }, [autoOpen]);

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
    if (done) void refreshAfterPaymentAction().catch(() => undefined).finally(() => router.refresh());
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
      <Button ref={opener} type="button" variant={primary ? 'primary' : 'secondary'} onClick={open} aria-haspopup="dialog" data-pay-open={instalment}>
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
              <CreateReceipt quote={quote} instalment={instalment} paymentId={done.paymentId} />
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
            <fieldset className="pay-methods" aria-describedby={errors.method ? `${id}-method-error` : undefined}>
              <legend>How was it paid?</legend>
              <div className="pay-method-opts">
                {PAY_CHOICES.map((m) => (
                  <label key={m} className={`pay-method${values.method === m ? ' is-on' : ''}`}>
                    <input type="radio" name={`${id}-method`} value={m} checked={values.method === m} onChange={() => set({ method: m })} />
                    <span>{PAYMENT_METHOD_LABELS[m]}</span>
                  </label>
                ))}
              </div>
              {errors.method ? <p className="error" id={`${id}-method-error`} role="alert">{errors.method}</p> : null}
            </fieldset>
            <Field id={`${id}-note`} label="Note" hint="Optional, for example a cheque number." maxLength={PAYMENT_NOTE_MAX} value={values.note} onChange={(e) => set({ note: e.target.value })} error={errors.note} />
            {message ? <p className="form-error" role="alert">{message}</p> : null}
            <div className="pay-actions">
              <Button type="submit" pending={pending}>{pending ? 'Saving' : 'Save payment'}</Button>
              <Button type="button" variant="secondary" onClick={close}>Cancel</Button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
