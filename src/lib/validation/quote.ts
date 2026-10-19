import { z } from 'zod';
import {
  DEPOSIT_MAX_BP,
  DEPOSIT_MIN_BP,
  DEPOSIT_STEP_BP,
  MAX_AMOUNT_PENCE,
  MAX_STAGES,
  MIN_STAGES,
  TOO_LARGE_MESSAGE,
  STAGE_LABEL_MAX,
  type Pence,
  type PaymentPlan,
  type PlanStage,
} from '../money';
import { computeQuoteTotals, DEFAULT_VAT_RATE_BP } from '../quote-totals';
import { emptyScope, scopeErrors, scopeFormSchema, type ScopeFormValues } from '../scope/model';

// ------------------------------------------------------------------ money text to whole numbers (never floats)

/** The most any single amount may be: one million pounds. Keeps every product in money.ts exact. */
export const MAX_PENCE: Pence = MAX_AMOUNT_PENCE;
/** Longest amount text we will look at, including commas and the pound sign. */
export const MAX_AMOUNT_CHARS = 14;

export type PenceParse =
  | { ok: true; pence: Pence }
  | { ok: false; reason: 'empty' | 'negative' | 'format' | 'too_long' | 'too_large'; message: string };

const FAIL = {
  empty: 'Enter an amount, like 1250.50',
  negative: 'Enter an amount that is not negative',
  format: 'Use pounds and pence only, like 1,250.50',
  too_long: 'That amount is too long',
  too_large: 'That amount is too large. The most is £1,000,000.00',
} as const;

const fail = (reason: keyof typeof FAIL): PenceParse => ({ ok: false, reason, message: FAIL[reason] });

const POUNDS = /^(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d{1,2})?$/;

/**
 * Pounds text to whole pence. Accepts "1250", "1,250.50", "£0.1" (10p), ".5" (50p). Rejects exponents,
 * signs, negatives, stray commas, more than two decimals and anything over 14 characters. Pure integer maths.
 */
export function parsePoundsToPence(raw: unknown): PenceParse {
  if (typeof raw !== 'string') return fail('format');
  let s = raw.trim();
  if (s === '') return fail('empty');
  if (s.length > MAX_AMOUNT_CHARS) return fail('too_long');
  if (/^[-\u2212\u2013\u2014(]/.test(s)) return fail('negative');
  if (s.startsWith('£')) s = s.slice(1).trim();
  if (s === '' || s === '.' || !POUNDS.test(s)) return fail('format');
  const [intPart = '', frac = ''] = s.split('.');
  const pounds = Number(intPart.replace(/,/g, '') || '0');
  const pence = pounds * 100 + Number(frac.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(pence) || pence > MAX_PENCE) return fail('too_large');
  return { ok: true, pence };
}

/** 125050 -> "1250.50"; 125000 -> "1250"; used to refill the form from saved pence. */
export function penceToInput(pence: Pence): string {
  if (!Number.isSafeInteger(pence) || pence < 0) return '';
  const p = Math.floor(pence / 100);
  const rest = pence % 100;
  return rest === 0 ? String(p) : `${p}.${String(rest).padStart(2, '0')}`;
}

export type BpParse = { ok: true; bp: number } | { ok: false; message: string };

const PERCENT = /^\d{1,3}(?:\.\d{1,2})?$/;

/** Percentage text to basis points: "30" -> 3000, "32.5" -> 3250, "33.33%" -> 3333. Up to two decimals. */
export function parsePercentToBp(raw: unknown): BpParse {
  if (typeof raw !== 'string') return { ok: false, message: 'Enter a percentage, like 30' };
  let s = raw.trim();
  if (s === '') return { ok: false, message: 'Enter a percentage, like 30' };
  if (s.length > 7) return { ok: false, message: 'That percentage is too long' };
  if (s.endsWith('%')) s = s.slice(0, -1).trim();
  if (!PERCENT.test(s)) return { ok: false, message: 'Use a percentage like 30 or 32.5' };
  const [whole = '', frac = ''] = s.split('.');
  const bp = Number(whole) * 100 + Number(frac.padEnd(2, '0') || '0');
  if (bp > 10_000) return { ok: false, message: 'A percentage cannot be more than 100' };
  return { ok: true, bp };
}

export function bpToInput(bp: number): string {
  if (!Number.isSafeInteger(bp) || bp < 0) return '';
  const whole = Math.trunc(bp / 100);
  const frac = String(bp % 100).padStart(2, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

// ------------------------------------------------------------------ form values (what the owner has typed)

export interface StageFormValue {
  label: string;
  mode: 'pct' | 'amount';
  value: string;
}
export interface PlanFormValues {
  kind: 'deposit' | 'full' | 'staged';
  depositPct: string;
  stages: StageFormValue[];
}
export interface ExtraFormValue {
  description: string;
  amount: string;
}
export interface QuoteFormValues {
  quoteNumber: string;
  customerId: string;
  date: string;
  jobTypeId: string;
  propertyAddress: string;
  scope: ScopeFormValues;
  price: string;
  vatApplies: boolean;
  extras: ExtraFormValue[];
  discount: string;
  plan: PlanFormValues;
  bankAccountId: string;
}

export const MAX_EXTRAS = 10;
export const NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{1,39}$/;
/**
 * Document numbers are built from the quote number: INV-{q}-D, INV-{q}-B, INV-{q}, INV-{q}-S{n}, RCP-{q}..., with -P{k} on later
 * receipts, guarantees use GC-{q} and GC-{q}-G{k}, and survey reports use SR-. A quote number that ends like one of those endings, or starts like one
 * of those prefixes, could make two jobs produce the same document number, so it is refused here and by the database.
 */
export const NUMBER_SUFFIX_RE = /-(?:D|B|S\d+|P\d+|G\d+)$/;
export const NUMBER_PREFIX_RE = /^(?:INV|RCP|GC|SR|GUA|SUR)-/;
export const NUMBER_SUFFIX_MESSAGE = 'A quote number cannot start with INV-, RCP-, GC-, SR-, GUA- or SUR-, or end in -D, -B, -S, -P or -G and a number, because document numbers use those';
/** The reason a well-formed quote number cannot be used, or null. */
export function quoteNumberReserved(n: string): string | null {
  return NUMBER_SUFFIX_RE.test(n) || NUMBER_PREFIX_RE.test(n) ? NUMBER_SUFFIX_MESSAGE : null;
}
const ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|demo-[a-z]+-[\w-]{1,40})$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

export const EMPTY_PLAN: PlanFormValues = {
  kind: 'deposit',
  depositPct: '30',
  stages: [
    { label: '', mode: 'pct', value: '' },
    { label: '', mode: 'pct', value: '' },
  ],
};

export function emptyQuoteForm(defaults: { date: string; vatApplies: boolean; depositPctBp?: number; quoteNumber?: string }): QuoteFormValues {
  const dep = defaults.depositPctBp && defaults.depositPctBp >= DEPOSIT_MIN_BP && defaults.depositPctBp <= DEPOSIT_MAX_BP ? bpToInput(defaults.depositPctBp) : '30';
  return {
    quoteNumber: defaults.quoteNumber ?? '',
    customerId: '',
    date: defaults.date,
    jobTypeId: '',
    propertyAddress: '',
    scope: emptyScope(),
    price: '',
    vatApplies: defaults.vatApplies,
    extras: [],
    discount: '',
    plan: { ...EMPTY_PLAN, depositPct: dep, stages: EMPTY_PLAN.stages.map((s) => ({ ...s })) },
    bankAccountId: '',
  };
}

const short = (max: number) => z.string().max(max).refine((v) => !CONTROL.test(v), 'That has characters we cannot save');

/** Shape and size limits for what the form sends. Everything is text, exactly as typed. */
export const quoteFormSchema = z.object({
  quoteNumber: short(40),
  customerId: short(80),
  date: short(10),
  jobTypeId: short(80),
  propertyAddress: short(200),
  scope: scopeFormSchema.default(() => emptyScope()),
  price: short(MAX_AMOUNT_CHARS + 20),
  vatApplies: z.boolean(),
  extras: z.array(z.object({ description: short(120), amount: short(MAX_AMOUNT_CHARS + 20) })).max(MAX_EXTRAS),
  discount: short(MAX_AMOUNT_CHARS + 20),
  plan: z.object({
    kind: z.enum(['deposit', 'full', 'staged']),
    depositPct: short(12),
    stages: z.array(z.object({ label: short(STAGE_LABEL_MAX * 2), mode: z.enum(['pct', 'amount']), value: short(MAX_AMOUNT_CHARS + 20) })).max(MAX_STAGES),
  }),
  bankAccountId: short(80),
});

// ------------------------------------------------------------------ normalised input (whole pence, parsed plan)

export interface QuoteInput {
  quoteNumber: string;
  customerId: string;
  date: string | null;
  jobTypeId: string | null;
  propertyAddress: string | null;
  priceNetPence: Pence | null;
  vatApplies: boolean;
  extras: { description: string; netPence: Pence }[];
  discountPence: Pence;
  plan: PaymentPlan | null;
  bankAccountId: string | null;
}

/** Field key to message. Keys: customerId, quoteNumber, date, jobTypeId, propertyAddress, scope.*, price, discount,
 *  extras.N.description, extras.N.amount, plan, plan.depositPct, plan.stages.N, plan.stages.N.label, plan.stages.N.value, bankAccountId. */
export type QuoteErrors = Record<string, string>;

export type QuoteStep = 'customer' | 'job' | 'scope' | 'price' | 'plan' | 'review';
export const QUOTE_STEPS: readonly QuoteStep[] = ['customer', 'job', 'scope', 'price', 'plan', 'review'];

export function stepOfError(key: string): QuoteStep {
  if (key === 'customerId') return 'customer';
  if (['quoteNumber', 'date', 'jobTypeId', 'propertyAddress'].includes(key)) return 'job';
  if (key === 'scope' || key.startsWith('scope.')) return 'scope';
  if (key === 'price' || key === 'discount' || key.startsWith('extras')) return 'price';
  if (key === 'bankAccountId') return 'review';
  return 'plan';
}

function isRealDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function planFromForm(f: PlanFormValues, errors: QuoteErrors): PaymentPlan | null {
  if (f.kind === 'full') return { kind: 'full' };
  if (f.kind === 'deposit') {
    const p = parsePercentToBp(f.depositPct);
    if (!p.ok) {
      errors['plan.depositPct'] = p.message;
      return null;
    }
    if (p.bp < DEPOSIT_MIN_BP || p.bp > DEPOSIT_MAX_BP || p.bp % DEPOSIT_STEP_BP !== 0) {
      errors['plan.depositPct'] = 'The deposit must be between 1% and 99%, in steps of half a percent';
      return null;
    }
    return { kind: 'deposit', pctBp: p.bp };
  }
  if (f.stages.length < MIN_STAGES || f.stages.length > MAX_STAGES) {
    errors['plan'] = `A staged plan has between ${MIN_STAGES} and ${MAX_STAGES} stages`;
    return null;
  }
  const stages: PlanStage[] = [];
  let bad = false;
  f.stages.forEach((s, i) => {
    const label = s.label.trim();
    if (label === '') {
      errors[`plan.stages.${i}.label`] = 'Give this stage a name, like "Scaffold up and strip complete"';
      bad = true;
    } else if (label.length > STAGE_LABEL_MAX) {
      errors[`plan.stages.${i}.label`] = `Keep the name to ${STAGE_LABEL_MAX} characters or fewer`;
      bad = true;
    }
    if (s.mode === 'pct') {
      const p = parsePercentToBp(s.value);
      if (!p.ok) {
        errors[`plan.stages.${i}.value`] = p.message;
        bad = true;
      } else if (p.bp < 1 || p.bp > 9999) {
        errors[`plan.stages.${i}.value`] = 'A stage must be more than 0% and less than 100%';
        bad = true;
      } else stages.push({ label, mode: 'pct', pctBp: p.bp });
    } else {
      const a = parsePoundsToPence(s.value);
      if (!a.ok) {
        errors[`plan.stages.${i}.value`] = a.message;
        bad = true;
      } else if (a.pence < 1) {
        errors[`plan.stages.${i}.value`] = 'Enter an amount above £0.00';
        bad = true;
      } else stages.push({ label, mode: 'amount', grossPence: a.pence });
    }
  });
  return bad ? null : { kind: 'staged', stages };
}

/**
 * Turns the typed form into whole pence and a parsed plan.
 * 'draft': only a quote number and a customer are required; whatever else is typed is checked for format but may be incomplete.
 * 'final': everything needed to issue the quote must be present, and the payment plan must add up to the job total exactly.
 */
function normaliseQuoteInner(
  v: QuoteFormValues,
  mode: 'draft' | 'final',
  vatRateBp: number = DEFAULT_VAT_RATE_BP,
): { input: QuoteInput; errors: QuoteErrors } {
  const errors: QuoteErrors = {};
  const strict = mode === 'final';

  const quoteNumber = v.quoteNumber.trim();
  if (quoteNumber === '') errors.quoteNumber = 'Enter a quote number';
  else if (!NUMBER_RE.test(quoteNumber)) errors.quoteNumber = 'Use 2 to 40 letters, numbers, dots, dashes or slashes, starting with a letter or number';
  else if (quoteNumberReserved(quoteNumber)) errors.quoteNumber = NUMBER_SUFFIX_MESSAGE;

  const customerId = v.customerId.trim();
  if (customerId === '') errors.customerId = 'Choose who this quote is for';
  else if (!ID_RE.test(customerId)) errors.customerId = 'Choose who this quote is for';

  const date = v.date.trim();
  let dateOut: string | null = null;
  if (date === '') {
    if (strict) errors.date = 'Enter the date of the quote';
  } else if (!isRealDate(date)) errors.date = 'Enter a real date';
  else dateOut = date;

  const jobTypeId = v.jobTypeId.trim();
  if (jobTypeId !== '' && !ID_RE.test(jobTypeId)) errors.jobTypeId = 'Choose a job type from the list';

  Object.assign(errors, scopeErrors(v.scope, strict ? 'final' : 'draft'));

  let priceNetPence: Pence | null = null;
  if (v.price.trim() === '') {
    if (strict) errors.price = 'Enter the price before VAT';
  } else {
    const p = parsePoundsToPence(v.price);
    if (!p.ok) errors.price = p.message;
    else if (p.pence === 0 && strict) errors.price = 'The price must be more than £0.00';
    else priceNetPence = p.pence;
  }

  const extras: { description: string; netPence: Pence }[] = [];
  v.extras.forEach((e, i) => {
    const description = e.description.trim();
    const blank = description === '' && e.amount.trim() === '';
    if (blank) return;
    if (description === '') errors[`extras.${i}.description`] = 'Describe this extra';
    const a = parsePoundsToPence(e.amount);
    if (!a.ok) errors[`extras.${i}.amount`] = a.message;
    else if (a.pence === 0) errors[`extras.${i}.amount`] = 'An extra must be more than £0.00';
    else if (description !== '') extras.push({ description, netPence: a.pence });
  });

  let discountPence: Pence = 0;
  if (v.discount.trim() !== '') {
    const d = parsePoundsToPence(v.discount);
    if (!d.ok) errors.discount = d.message;
    else discountPence = d.pence;
  }

  const plan = planFromForm(v.plan, errors);

  const bankAccountId = v.bankAccountId.trim();
  if (bankAccountId !== '' && !ID_RE.test(bankAccountId)) errors.bankAccountId = 'Choose a bank account from the list';

  const propertyAddress = v.propertyAddress.trim();
  const input: QuoteInput = {
    quoteNumber,
    customerId,
    date: dateOut,
    jobTypeId: jobTypeId === '' ? null : jobTypeId,
    propertyAddress: propertyAddress === '' ? null : propertyAddress,
    priceNetPence,
    vatApplies: v.vatApplies,
    extras,
    discountPence,
    plan,
    bankAccountId: bankAccountId === '' ? null : bankAccountId,
  };

  // Cross-field checks need the figures. computeQuoteTotals bounds everything before any plan maths and never throws.
  if (v.extras.length > MAX_EXTRAS) errors.extras = `A quote can have at most ${MAX_EXTRAS} extras`;
  if (!errors.price && !errors.discount && !errors.extras && !Object.keys(errors).some((k) => k.startsWith('extras'))) {
    const totals = computeQuoteTotals(input, vatRateBp);
    if (totals.error) errors.price = TOO_LARGE_MESSAGE;
    else if (discountPence > 0 && totals.netPence <= 0 && (priceNetPence ?? 0) > 0) errors.discount = 'The discount must be less than the price';
    else if (strict && plan && totals.planCheck && !totals.planCheck.ok) {
      for (const p of totals.planCheck.problems) {
        const key = p.stage === null ? 'plan' : plan.kind === 'deposit' ? 'plan.depositPct' : `plan.stages.${p.stage}`;
        if (!errors[key]) errors[key] = p.message;
      }
    }
  }
  if (strict && !plan && !errors['plan'] && !Object.keys(errors).some((k) => k.startsWith('plan'))) errors['plan'] = 'Choose how this job is paid';
  if (strict && v.plan.kind === 'staged' && Object.keys(errors).some((k) => k.startsWith('plan.stages')) && !errors['plan']) {
    errors['plan'] = 'Fix the stages marked below';
  }

  if (!strict) {
    // A draft only has to be identifiable. Half-typed prices and plans are kept as typed and judged when the quote is issued.
    const keep = new Set(['quoteNumber', 'customerId', 'jobTypeId', 'bankAccountId', 'date']);
    for (const k of Object.keys(errors)) if (!keep.has(k)) delete errors[k];
  }
  return { input, errors };
}

/** Never throws, whatever it is handed: anything unexpected becomes a message on the price. */
export function normaliseQuote(
  v: QuoteFormValues,
  mode: 'draft' | 'final',
  vatRateBp: number = DEFAULT_VAT_RATE_BP,
): { input: QuoteInput; errors: QuoteErrors } {
  try {
    return normaliseQuoteInner(v, mode, vatRateBp);
  } catch {
    const blank: QuoteInput = {
      quoteNumber: '', customerId: '', date: null, jobTypeId: null, propertyAddress: null,
      priceNetPence: null, vatApplies: true, extras: [], discountPence: 0, plan: null, bankAccountId: null,
    };
    return { input: blank, errors: { price: TOO_LARGE_MESSAGE } };
  }
}

function toIssues(errors: QuoteErrors, input: unknown) {
  return Object.entries(errors).map(([key, message]) => ({ code: 'custom' as const, message, input, path: key.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) }));
}

/** Everything needed to issue a quote. Output is the normalised input. Pass the business VAT rate for the plan check. */
export function quoteSchemaFor(mode: 'draft' | 'final', vatRateBp: number = DEFAULT_VAT_RATE_BP) {
  return quoteFormSchema.transform((form, ctx) => {
    const { input, errors } = normaliseQuote(form, mode, vatRateBp);
    if (Object.keys(errors).length > 0) {
      ctx.issues.push(...toIssues(errors, form));
      return z.NEVER;
    }
    return input;
  });
}

/** Strict: the quote can be previewed and issued. Default VAT rate; use quoteSchemaFor for a business's own. */
export const quoteInputSchema = quoteSchemaFor('final');
/** Lenient: enough to start or keep a draft. */
export const quoteDraftSchema = quoteSchemaFor('draft');

/** Blockers that stop a quote being finalised, grouped by form step, in step order. */
export function quoteBlockers(v: QuoteFormValues, vatRateBp: number = DEFAULT_VAT_RATE_BP): { step: QuoteStep; key: string; message: string }[] {
  const { errors } = normaliseQuote(v, 'final', vatRateBp);
  return Object.entries(errors)
    .map(([key, message]) => ({ step: stepOfError(key), key, message }))
    .sort((a, b) => QUOTE_STEPS.indexOf(a.step) - QUOTE_STEPS.indexOf(b.step));
}
