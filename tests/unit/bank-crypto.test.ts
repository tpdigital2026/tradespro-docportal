import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptBankDetails,
  decryptSecret,
  encryptBankDetails,
  encryptSecret,
  last4,
  maskAccountNumber,
  normaliseAccountNumber,
  normaliseSortCode,
  parseKey,
} from '../../src/security/bank-crypto';

const key = randomBytes(32);
const tenant = '11111111-1111-1111-1111-111111111111';

describe('parseKey', () => {
  it('accepts a 32 byte base64 key', () => {
    expect(parseKey(randomBytes(32).toString('base64'))).toHaveLength(32);
  });
  it('rejects the wrong length', () => {
    expect(() => parseKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => parseKey('')).toThrow(/32 bytes/);
  });
});

describe('encryptSecret / decryptSecret', () => {
  it('round-trips', () => {
    expect(decryptSecret(encryptSecret('00-00-00', key, 'ctx'), key, 'ctx')).toBe('00-00-00');
  });
  it('produces different ciphertext each time and a versioned format', () => {
    const a = encryptSecret('12345678', key, 'ctx');
    const b = encryptSecret('12345678', key, 'ctx');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1:')).toBe(true);
    expect(a.split(':')).toHaveLength(4);
  });
  it('never contains the plaintext', () => {
    expect(encryptSecret('12345678', key, 'ctx')).not.toContain('12345678');
  });
  it('detects tampering', () => {
    const [v, iv, tag, ct] = encryptSecret('12345678', key, 'ctx').split(':');
    const flipped = Buffer.from(ct, 'base64');
    flipped[0] ^= 1;
    expect(() => decryptSecret([v, iv, tag, flipped.toString('base64')].join(':'), key, 'ctx')).toThrow();
  });
  it('fails with the wrong key', () => {
    expect(() => decryptSecret(encryptSecret('x', key, 'ctx'), randomBytes(32), 'ctx')).toThrow();
  });
  it('fails with the wrong context, so ciphertext cannot be moved between fields or tenants', () => {
    expect(() => decryptSecret(encryptSecret('x', key, 'ctx-a'), key, 'ctx-b')).toThrow();
  });
  it('rejects malformed or unknown-version blobs', () => {
    expect(() => decryptSecret('garbage', key, 'ctx')).toThrow();
    expect(() => decryptSecret('v9:a:b:c', key, 'ctx')).toThrow(/version/i);
  });
});

describe('normalising', () => {
  it('formats sort codes', () => {
    expect(normaliseSortCode('230580')).toBe('23-05-80');
    expect(normaliseSortCode('23 05 80')).toBe('23-05-80');
    expect(normaliseSortCode('23-05-80')).toBe('23-05-80');
  });
  it('rejects bad sort codes', () => {
    expect(() => normaliseSortCode('2305')).toThrow();
    expect(() => normaliseSortCode('ab-cd-ef')).toThrow();
  });
  it('accepts 8 digit account numbers and rejects others', () => {
    expect(normaliseAccountNumber('0000 0000')).toBe('00000000');
    expect(() => normaliseAccountNumber('1234567')).toThrow();
    expect(() => normaliseAccountNumber('1234567a')).toThrow();
  });
  it('last4 and masking', () => {
    expect(last4('44211750')).toBe('1750');
    expect(maskAccountNumber('1750')).toBe('••••1750');
  });
});

describe('encryptBankDetails / decryptBankDetails', () => {
  it('round-trips and exposes only last4 in clear', () => {
    const enc = encryptBankDetails({ sortCode: '000000', accountNumber: '00000000' }, key, tenant);
    expect(enc.last4).toBe('0000');
    expect(enc.sort_code_enc).not.toContain('00-00-00');
    expect(decryptBankDetails(enc, key, tenant)).toEqual({ sortCode: '00-00-00', accountNumber: '00000000' });
  });
  it('cannot be decrypted for a different tenant', () => {
    const enc = encryptBankDetails({ sortCode: '000000', accountNumber: '00000000' }, key, tenant);
    expect(() => decryptBankDetails(enc, key, '22222222-2222-2222-2222-222222222222')).toThrow();
  });
  it('cannot swap the two encrypted fields', () => {
    const enc = encryptBankDetails({ sortCode: '000000', accountNumber: '00000000' }, key, tenant);
    expect(() => decryptBankDetails({ sort_code_enc: enc.account_number_enc, account_number_enc: enc.sort_code_enc }, key, tenant)).toThrow();
  });
});
