/**
 * Recording a payment by hand ("Mark as paid"). Pure: validation and the arithmetic of what is still owed.
 * Money is whole pence. The invoice is never changed by a payment; "paid" is worked out from the payments.
 */
import { z } from 'zod';
import { formatGBP, type Pence } from './money';
import { parsePoundsToPence, penceToInput } from './validation/quote';

export const PAYMENT_METHODS = ['bank transfer', 'cash', 'cheque', 'card', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  'bank transfer': 'Bank transfer',
  cash: 'Cash',
  cheque: 'Cheque',
  card: 'Card',
  other: 'Other',
};

export const PAYMENT_NOTE_MAX = 200;
export const EARLIEST_PAID_ON = '2000-01-01';

export interface PaymentFormValues {
  amount: string;
  paidOn: string;
  method: string;
  note: string;
}

export const paymentFormSchema = z.object({
  amount: z.string().max(40),
  paidOn: z.string().max(10),
  method: z.string().max(20),
  note: z.string().max(PAYMENT_NOTE_MAX * 2),
});

export interface RecordablePayment {
  amountPence: Pence;
  paidOn: string;
  method: PaymentMethod;
  note: string | null;
}

export type PaymentErrors = Partial<Record<keyof PaymentFormValues, string>>;

/** A real calendar date in YYYY-MM-DD form. */
export function isIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** What is still to come in on an invoice, never below zero. */
export function outstandingPence(invoiceGrossPence: Pence, paidSoFar: Pence[]): Pence {
  return Math.max(0, invoiceGrossPence - paidSoFar.reduce((s, n) => s + n, 0));
}

/** The values the dialog opens with: the amount still owed, today, bank transfer. */
export function defaultPaymentForm(outstanding: Pence, today: string): PaymentFormValues {
  return { amount: penceToInput(outstanding), paidOn: today, method: 'bank transfer', note: '' };
}

export type PaymentCheck = { ok: true; value: RecordablePayment } | { ok: false; errors: PaymentErrors };

/**
 * Checks what the owner typed. The amount must be more than nothing and no more than is still owed on the
 * invoice (part payments are fine, over-payments are not), the date a real day that is not in the future.
 * today is passed in so this stays pure.
 */
export function checkPayment(raw: PaymentFormValues, outstanding: Pence, today: string): PaymentCheck {
  const errors: PaymentErrors = {};
  const amount = parsePoundsToPence(raw.amount);
  let amountPence = 0;
  if (!amount.ok) errors.amount = amount.message;
  else if (amount.pence < 1) errors.amount = 'Enter an amount more than nothing';
  else if (outstanding < 1) errors.amount = 'This invoice is already paid in full';
  else if (amount.pence > outstanding) errors.amount = `That is more than is still owed, ${formatGBP(outstanding)}`;
  else amountPence = amount.pence;

  const paidOn = raw.paidOn.trim();
  if (!isIsoDate(paidOn)) errors.paidOn = 'Choose the date the money arrived';
  else if (paidOn > today) errors.paidOn = 'The date cannot be in the future';
  else if (paidOn < EARLIEST_PAID_ON) errors.paidOn = 'That date is too long ago';

  const method = (PAYMENT_METHODS as readonly string[]).includes(raw.method) ? (raw.method as PaymentMethod) : null;
  if (!method) errors.method = 'Choose how it was paid';

  const note = raw.note.trim();
  if (note.length > PAYMENT_NOTE_MAX) errors.note = `Keep the note to ${PAYMENT_NOTE_MAX} characters or fewer`;

  if (Object.keys(errors).length > 0 || !method) return { ok: false, errors };
  return { ok: true, value: { amountPence, paidOn, method, note: note === '' ? null : note } };
}

const LONDON_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Today's date in the UK (YYYY-MM-DD), not UTC, so a payment taken in the evening is not "tomorrow" or "yesterday". */
export function todayLondon(now: Date = new Date()): string {
  return LONDON_DAY.format(now);
}
