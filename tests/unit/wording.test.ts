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

describe('payment terms wording (the owner\'s rulings)', () => {
  it('FJC\'s wording says what the owner ruled, word for word', () => {
    expect(FJC_WORDING.deposit_invoice.dueLabel).toBe('Before works start');
    expect(FJC_WORDING.deposit_invoice.terms).toBe('The 30% deposit is payable before works start. The remaining balance of {balance} is due on completion of works.');
    expect(FJC_WORDING.balance_invoice.dueLabel).toBe('On receipt');
    expect(FJC_WORDING.balance_invoice.dueNote).toBe('Payment is due upon receipt of this invoice');
    expect(FJC_WORDING.balance_invoice.terms).toBe('Payment is due upon receipt of this invoice.');
    expect(FJC_WORDING.paymentReference).toBe('address_line_1');
  });
  it('the due label is optional (a business that has not supplied one gets no Due line) but never empty', () => {
    const { dueLabel: _d, ...rest } = FJC_WORDING.balance_invoice;
    expect(tenantWordingSchema.parse({ ...FJC_WORDING, balance_invoice: rest }).balance_invoice.dueLabel).toBeUndefined();
    expect(() => tenantWordingSchema.parse({ ...FJC_WORDING, balance_invoice: { ...rest, dueLabel: '' } })).toThrow();
    expect(() => tenantWordingSchema.parse({ ...FJC_WORDING, balance_invoice: { ...rest, dueLabel: 'x'.repeat(61) } })).toThrow();
  });
  it('full and stage invoices can carry their own due label too', () => {
    const w = tenantWordingSchema.parse({
      ...FJC_WORDING,
      invoice_full: { terms: 't', dueNote: 'n', dueLabel: 'On receipt' },
      invoice_stage: { terms: 't', dueNote: 'n', dueLabel: 'Within 7 days' },
    });
    expect(w.invoice_full?.dueLabel).toBe('On receipt');
    expect(w.invoice_stage?.dueLabel).toBe('Within 7 days');
  });
  it('the payment reference convention is one of two choices', () => {
    expect(tenantWordingSchema.parse({ ...FJC_WORDING, paymentReference: 'invoice_number' }).paymentReference).toBe('invoice_number');
    expect(() => tenantWordingSchema.parse({ ...FJC_WORDING, paymentReference: 'whatever' })).toThrow();
  });
  it('FJC\'s payment wording contains no invented figures: only the 30% in the owner\'s own sentence', () => {
    const text = [FJC_WORDING.deposit_invoice.terms, FJC_WORDING.balance_invoice.terms, FJC_WORDING.balance_invoice.dueNote].join(' ');
    expect(text.match(/\d+/g)).toEqual(['30']);
  });
});
