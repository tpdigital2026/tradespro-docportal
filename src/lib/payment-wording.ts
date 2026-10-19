/**
 * The payment wording an owner can read and change in Settings: the "Due" line, the note under the amount due, the terms,
 * and what the payment reference says, for deposit and balance invoices (full and stage invoices follow the balance
 * invoice's wording unless the business has set their own). Pure: no I/O. The wording is the business's own: the code never
 * writes a payment term, it only checks, stores and previews what the owner typed.
 */
import { FJC_WORDING, tenantWordingSchema, type TenantWording } from '../db/wording';
import { formatGBP } from './money';

export const PAYMENT_REFERENCE_CHOICES = ['address_line_1', 'invoice_number'] as const;
export type PaymentReferenceChoice = (typeof PAYMENT_REFERENCE_CHOICES)[number];

export const PAYMENT_REFERENCE_LABELS: Record<PaymentReferenceChoice, string> = {
  address_line_1: 'The first line of the job address',
  invoice_number: 'The invoice number',
};

export interface PaymentWording {
  depositDueLabel: string;
  depositTerms: string;
  balanceDueLabel: string;
  balanceDueNote: string;
  balanceTerms: string;
  paymentReference: PaymentReferenceChoice;
}

export type PaymentWordingField = keyof PaymentWording;

export const PAYMENT_LIMITS = { label: 60, note: 120, terms: 400 } as const;
/** Where the amount still to pay goes in the deposit terms. */
export const BALANCE_SLOT = '{balance}';

const tidy = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** What the screen shows: the business's stored wording, and the agreed FJC wording for anything not yet set. */
export function paymentWordingOf(raw: unknown): PaymentWording {
  const parsed = tenantWordingSchema.safeParse(raw);
  const w: TenantWording = parsed.success ? parsed.data : FJC_WORDING;
  return {
    depositDueLabel: w.deposit_invoice.dueLabel,
    depositTerms: w.deposit_invoice.terms,
    balanceDueLabel: w.balance_invoice.dueLabel ?? FJC_WORDING.balance_invoice.dueLabel ?? '',
    balanceDueNote: w.balance_invoice.dueNote,
    balanceTerms: w.balance_invoice.terms,
    paymentReference: w.paymentReference ?? 'address_line_1',
  };
}

/** Only what is really stored (a field never set is absent), so saving the suggested wording counts as a change. */
export function storedPaymentWording(w: TenantWording): Partial<PaymentWording> {
  return {
    depositDueLabel: w.deposit_invoice.dueLabel,
    depositTerms: w.deposit_invoice.terms,
    balanceDueLabel: w.balance_invoice.dueLabel,
    balanceDueNote: w.balance_invoice.dueNote,
    balanceTerms: w.balance_invoice.terms,
    paymentReference: w.paymentReference,
  };
}

/** The business's wording with these fields replaced. The result is checked against the same strict schema as everything stored. */
export function applyPaymentWording(w: TenantWording, p: PaymentWording): TenantWording {
  return tenantWordingSchema.parse({
    ...w,
    deposit_invoice: { ...w.deposit_invoice, dueLabel: p.depositDueLabel, terms: p.depositTerms },
    balance_invoice: { ...w.balance_invoice, dueLabel: p.balanceDueLabel, dueNote: p.balanceDueNote, terms: p.balanceTerms },
    paymentReference: p.paymentReference,
  });
}

export type PaymentWordingErrors = Partial<Record<PaymentWordingField, string>>;

function text(raw: unknown, what: string, max: number, slot: boolean): { value: string } | { error: string } {
  const value = tidy(typeof raw === 'string' ? raw : '');
  if (value === '') return { error: `Enter the ${what}` };
  if (value.length > max) return { error: `Keep the ${what} to ${max} characters or fewer` };
  if (CONTROL.test(value)) return { error: `The ${what} has a character that cannot be printed` };
  const stripped = slot ? value.split(BALANCE_SLOT).join('') : value;
  if (/[{}]/.test(stripped)) return { error: slot ? `Only ${BALANCE_SLOT} can go in curly brackets` : `Leave out curly brackets from the ${what}` };
  return { value };
}

/** What the owner typed, checked the same way in the browser and on the server. */
export function parsePaymentWording(raw: Partial<Record<PaymentWordingField, unknown>>): { ok: true; value: PaymentWording } | { ok: false; errors: PaymentWordingErrors } {
  const errors: PaymentWordingErrors = {};
  const fields = {
    depositDueLabel: text(raw.depositDueLabel, 'due line for deposit invoices', PAYMENT_LIMITS.label, false),
    depositTerms: text(raw.depositTerms, 'deposit invoice terms', PAYMENT_LIMITS.terms, true),
    balanceDueLabel: text(raw.balanceDueLabel, 'due line for balance invoices', PAYMENT_LIMITS.label, false),
    balanceDueNote: text(raw.balanceDueNote, 'note under the amount due', PAYMENT_LIMITS.note, false),
    balanceTerms: text(raw.balanceTerms, 'balance invoice terms', PAYMENT_LIMITS.terms, false),
  };
  const out: Record<string, string> = {};
  for (const [k, r] of Object.entries(fields)) {
    if ('error' in r) errors[k as PaymentWordingField] = r.error;
    else out[k] = r.value;
  }
  const choice = PAYMENT_REFERENCE_CHOICES.find((c) => c === raw.paymentReference);
  if (!choice) errors.paymentReference = 'Choose what the payment reference says';
  if (Object.keys(errors).length > 0 || !choice) return { ok: false, errors };
  return { ok: true, value: { ...(out as Omit<PaymentWording, 'paymentReference'>), paymentReference: choice } };
}

export interface PaymentPreview {
  deposit: { due: string; note: string; terms: string };
  balance: { due: string; note: string; terms: string };
  reference: string;
}

/** How the wording reads on an invoice, with obviously made-up example figures. */
export function previewPaymentWording(p: PaymentWording): PaymentPreview {
  const exampleBalance = formatGBP(210000);
  return {
    deposit: {
      due: p.depositDueLabel,
      note: `Payable ${p.depositDueLabel.toLowerCase()} · 30% deposit`,
      terms: p.depositTerms.split(BALANCE_SLOT).join(exampleBalance),
    },
    balance: { due: p.balanceDueLabel, note: p.balanceDueNote, terms: p.balanceTerms },
    reference: p.paymentReference === 'address_line_1' ? '12 Example Street' : 'INV-ES-001-D',
  };
}

/** The fields whose value differs, for the audit trail (names only, never the wording itself). */
export function changedFields(before: Partial<PaymentWording>, after: PaymentWording): PaymentWordingField[] {
  return (Object.keys(after) as PaymentWordingField[]).filter((k) => before[k] !== after[k]);
}
