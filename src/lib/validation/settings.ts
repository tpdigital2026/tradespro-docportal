/**
 * What the owner may type on the Settings screen, checked the same way in the browser and on the server. Pure.
 * Bank numbers go through the normalisers in security/bank-crypto (the ones encryption uses), so what is checked is
 * exactly what is stored.
 */
import { z } from 'zod';
import { normaliseAccountNumber, normaliseSortCode } from '../../security/bank-crypto';
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS } from '../retention';
import { IDLE_MINUTES, MAX_SESSION_DAYS } from '../session-policy-limits';

export const BANK_NAME_MAX = 60;
export const MAX_ACTIVE_ACCOUNTS = 10;

// Letters (any language), digits, spaces and the punctuation that turns up in business and bank names.
const NAME_CHARS = /^[\p{L}\p{N} &'.,()/-]*$/u;
const tidy = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim();

export type BankField = 'accountName' | 'bankName' | 'sortCode' | 'accountNumber';
export type BankErrors = Partial<Record<BankField, string>>;
export interface BankInput {
  accountName: string;
  bankName: string;
  sortCode: string;
  accountNumber: string;
}

function checkName(raw: unknown, required: boolean, what: string): { value: string } | { error: string } {
  const value = tidy(typeof raw === 'string' ? raw : '');
  if (required && !value) return { error: `Enter the ${what}` };
  if (value.length > BANK_NAME_MAX) return { error: `Keep the ${what} to ${BANK_NAME_MAX} characters or fewer` };
  if (!NAME_CHARS.test(value)) return { error: `Use letters, numbers, spaces and simple punctuation in the ${what}` };
  return { value };
}

export const SORT_CODE_ERROR = 'Enter the 6 digit sort code, like 12-34-56';
export const ACCOUNT_NUMBER_ERROR = 'Enter the 8 digit account number. If yours has 7 digits, put a 0 at the front';

/** The names of an account (adding or renaming). */
export function parseBankNames(raw: { accountName?: unknown; bankName?: unknown }): { ok: true; value: { accountName: string; bankName: string } } | { ok: false; errors: BankErrors } {
  const errors: BankErrors = {};
  const a = checkName(raw.accountName, true, 'account name');
  const b = checkName(raw.bankName, false, 'bank name');
  if ('error' in a) errors.accountName = a.error;
  if ('error' in b) errors.bankName = b.error;
  if ('error' in a || 'error' in b) return { ok: false, errors };
  return { ok: true, value: { accountName: a.value, bankName: b.value } };
}

/** A new account. On success the numbers are normalised (sort code 12-34-56, account number 8 digits). */
export function parseBankAccount(raw: { accountName?: unknown; bankName?: unknown; sortCode?: unknown; accountNumber?: unknown }): { ok: true; value: BankInput } | { ok: false; errors: BankErrors } {
  const names = parseBankNames(raw);
  const errors: BankErrors = names.ok ? {} : { ...names.errors };
  let sortCode = '';
  let accountNumber = '';
  try {
    // Only spaces and hyphens may separate the digits; anything else (letters, dots, full-width digits) is refused.
    const s = typeof raw.sortCode === 'string' ? raw.sortCode : '';
    if (s.length > 20) throw new Error();
    sortCode = normaliseSortCode(s);
  } catch {
    errors.sortCode = SORT_CODE_ERROR;
  }
  try {
    const n = typeof raw.accountNumber === 'string' ? raw.accountNumber.replace(/-/g, ' ') : '';
    if (n.length > 20) throw new Error();
    accountNumber = normaliseAccountNumber(n);
  } catch {
    errors.accountNumber = ACCOUNT_NUMBER_ERROR;
  }
  if (!names.ok || errors.sortCode || errors.accountNumber) return { ok: false, errors };
  return { ok: true, value: { ...names.value, sortCode, accountNumber } };
}

const wholeNumber = (min: number, max: number, message: string) =>
  z.preprocess((v) => (typeof v === 'string' && /^\s*\d{1,4}\s*$/.test(v) ? Number(v) : v), z.number({ error: message }).int(message).min(min, message).max(max, message));

export const RETENTION_ERROR = `Choose between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days`;
export const retentionSchema = z.object({ days: wholeNumber(MIN_RETENTION_DAYS, MAX_RETENTION_DAYS, RETENTION_ERROR) });

export const IDLE_ERROR = `Choose between ${IDLE_MINUTES.min} and ${IDLE_MINUTES.max} minutes`;
export const MAX_DAYS_ERROR = `Choose between ${MAX_SESSION_DAYS.min} and ${MAX_SESSION_DAYS.max} days`;
export const sessionPolicySchema = z.object({
  idleMinutes: wholeNumber(IDLE_MINUTES.min, IDLE_MINUTES.max, IDLE_ERROR),
  maxDays: wholeNumber(MAX_SESSION_DAYS.min, MAX_SESSION_DAYS.max, MAX_DAYS_ERROR),
});

/** zod issues as one message per field. */
export function fieldErrors(issues: { path: PropertyKey[]; message: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const k = String(i.path[0] ?? 'form');
    out[k] ??= i.message;
  }
  return out;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
