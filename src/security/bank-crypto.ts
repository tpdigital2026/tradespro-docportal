import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';

export function parseKey(b64: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('BANK_ENCRYPTION_KEY must be 32 bytes, base64 encoded');
  return key;
}

/** `aad` binds the ciphertext to its context (tenant and field), so it cannot be moved elsewhere. */
export function encryptSecret(plain: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(blob: string, key: Buffer, aad: string): string {
  const parts = blob.split(':');
  if (parts.length !== 4) throw new Error('Malformed encrypted value');
  const [version, iv, tag, ct] = parts;
  if (version !== VERSION) throw new Error(`Unsupported encryption version: ${version}`);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

export function normaliseSortCode(raw: string): string {
  const digits = raw.replace(/[\s-]/g, '');
  if (!/^\d{6}$/.test(digits)) throw new Error('A sort code must be 6 digits');
  return `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}`;
}

export function normaliseAccountNumber(raw: string): string {
  const digits = raw.replace(/\s/g, '');
  if (!/^\d{8}$/.test(digits)) throw new Error('An account number must be 8 digits');
  return digits;
}

export const last4 = (accountNumber: string): string => accountNumber.slice(-4);
export const maskAccountNumber = (l4: string): string => `••••${l4}`;

const fieldContext = (tenantId: string, field: string): string => `bank:${tenantId}:${field}`;

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
