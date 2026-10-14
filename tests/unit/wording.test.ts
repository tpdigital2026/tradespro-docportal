import { describe, expect, it } from 'vitest';
import { FJC_WORDING, tenantWordingSchema } from '../../src/db/wording';

describe('tenantWordingSchema', () => {
  it('accepts the FJC wording', () => {
    expect(tenantWordingSchema.parse(FJC_WORDING)).toEqual(FJC_WORDING);
  });
  it('rejects a missing key', () => {
    const { quote: _quote, ...rest } = FJC_WORDING;
    expect(() => tenantWordingSchema.parse(rest)).toThrow();
  });
  it('rejects empty strings', () => {
    expect(() => tenantWordingSchema.parse({ ...FJC_WORDING, quote: { terms: '' } })).toThrow();
  });
  it('allows the guarantee disclaimer line to be null', () => {
    expect(tenantWordingSchema.parse({ ...FJC_WORDING, guarantee: { statement: 'x', disclaimerLine: null } }).guarantee.disclaimerLine).toBeNull();
  });
  it('the FJC wording contains no personal data and no bank details', () => {
    const text = JSON.stringify(FJC_WORDING);
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/\d{2}-\d{2}-\d{2}/);
  });
});

describe('tenantWordingSchema is strict', () => {
  it('rejects unknown keys at the top and inside sections', () => {
    expect(() => tenantWordingSchema.parse({ ...FJC_WORDING, extra: { terms: 'x' } })).toThrow();
    expect(() => tenantWordingSchema.parse({ ...FJC_WORDING, quote: { terms: 'x', surprise: 'y' } })).toThrow();
  });
});
