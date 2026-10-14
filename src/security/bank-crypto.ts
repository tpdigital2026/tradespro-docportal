import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Rotation: v1 carries no key id. A rotation adds a `v2:<kid>:...` format and a re-encrypt job.
const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const MALFORMED = 'Malformed encrypted value';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Canonical base64 only: no whitespace, no base64url characters, no trailing-bit junk. */
function strictBase64(part: string, allowEmpty = false): Buffer {
  if (part === '' && allowEmpty) return Buffer.alloc(0);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(part)) throw new Error(MALFORMED);
  const buf = Buffer.from(part, 'base64');
  if (buf.toString('base64') !== part) throw new Error(MALFORMED);
  return buf;
}

export function parseKey(b64: string): Buffer {
  const message = 'BANK_ENCRYPTION_KEY must be 32 bytes, base64 encoded';
  let key: Buffer;
  try {
    key = strictBase64(b64);
  } catch {
    throw new Error(message);
  }
  if (key.length !== 32) throw new Error(message);
  return key;
}

/** `aad` binds the ciphertext to its context (tenant and field), so it cannot be moved elsewhere. */
export function encryptSecret(plain: string, key: Buffer, aad: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(blob: string, key: Buffer, aad: string): string {
  const parts = blob.split(':');
  if (parts.length !== 4) throw new Error(MALFORMED);
  const [version, iv, tag, ct] = parts;
  if (version !== VERSION) throw new Error('Unsupported encryption version');
  const ivBuf = strictBase64(iv);
  const tagBuf = strictBase64(tag);
  const ctBuf = strictBase64(ct, true);
  if (ivBuf.length !== IV_LENGTH || tagBuf.length !== TAG_LENGTH) throw new Error(MALFORMED);
  const decipher = createDecipheriv(ALGORITHM, key, ivBuf, { authTagLength: TAG_LENGTH });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tagBuf);
  return Buffer.concat([decipher.update(ctBuf), decipher.final()]).toString('utf8');
}

export function normaliseSortCode(raw: string): string {
  const digits = raw.replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(digits)) throw new Error('A sort code must be 6 digits');
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
}

// Strict 8 digits for Phase 1 (BACS standard). Building society or 6-7 digit numbers must be
// zero-padded by the user; the form help text should say so.
export function normaliseAccountNumber(raw: string): string {
  const digits = raw.replace(/\s/g, '');
  if (!/^\d{8}$/.test(digits)) throw new Error('An account number must be 8 digits');
  return digits;
}

export const last4 = (accountNumber: string): string => accountNumber.slice(-4);
export const maskAccountNumber = (l4: string): string => `••••${l4}`;

const fieldContext = (tenantId: string, field: string): string => {
  if (!UUID.test(tenantId)) throw new Error('Invalid tenant id');
  return `bank:${tenantId}:${field}`;
};

export function encryptBankDetails(d: { sortCode: string; accountNumber: string }, key: Buffer, tenantId: string) {
  const sortCode = normaliseSortCode(d.sortCode);
  const accountNumber = normaliseAccountNumber(d.accountNumber);
  return {
    sort_code_enc: encryptSecret(sortCode, key, fieldContext(tenantId, 'sort_code')),
    account_number_enc: encryptSecret(accountNumber, key, fieldContext(tenantId, 'account_number')),
    last4: last4(accountNumber),
  };
}

export function decryptBankDetails(row: { sort_code_enc: string; account_number_enc: string }, key: Buffer, tenantId: string) {
  return {
    sortCode: decryptSecret(row.sort_code_enc, key, fieldContext(tenantId, 'sort_code')),
    accountNumber: decryptSecret(row.account_number_enc, key, fieldContext(tenantId, 'account_number')),
  };
}
