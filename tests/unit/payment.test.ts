import { describe, expect, it } from 'vitest';
import { checkPayment, defaultPaymentForm, isIsoDate, outstandingPence, PAYMENT_METHODS, type PaymentFormValues } from '../../src/lib/payment';

const TODAY = '2026-10-15';
const form = (over: Partial<PaymentFormValues> = {}): PaymentFormValues => ({ amount: '302.40', paidOn: TODAY, method: 'bank transfer', note: '', ...over });

describe('outstandingPence', () => {
  it('is the gross less what has been paid, never below zero', () => {
    expect(outstandingPence(10000, [])).toBe(10000);
    expect(outstandingPence(10000, [2500, 2500])).toBe(5000);
    expect(outstandingPence(10000, [10000])).toBe(0);
    expect(outstandingPence(10000, [12000])).toBe(0);
  });
});

describe('defaultPaymentForm', () => {
  it('opens with what is still owed, today and bank transfer', () => {
    expect(defaultPaymentForm(302400, TODAY)).toEqual({ amount: '3024', paidOn: TODAY, method: 'bank transfer', note: '' });
    expect(defaultPaymentForm(302450, TODAY).amount).toBe('3024.50');
  });
});

describe('checkPayment', () => {
  it('accepts the full amount, a part payment and the exact penny', () => {
    expect(checkPayment(form({ amount: '3024' }), 302400, TODAY)).toEqual({ ok: true, value: { amountPence: 302400, paidOn: TODAY, method: 'bank transfer', note: null } });
    expect(checkPayment(form({ amount: '1,000.50' }), 302400, TODAY)).toMatchObject({ ok: true, value: { amountPence: 100050 } });
    expect(checkPayment(form({ amount: '0.01' }), 302400, TODAY)).toMatchObject({ ok: true, value: { amountPence: 1 } });
  });

  it('refuses nothing, more than is owed, junk and negatives', () => {
    expect(checkPayment(form({ amount: '0' }), 302400, TODAY)).toMatchObject({ ok: false, errors: { amount: expect.any(String) } });
    expect(checkPayment(form({ amount: '' }), 302400, TODAY)).toMatchObject({ ok: false });
    expect(checkPayment(form({ amount: '3024.01' }), 302400, TODAY)).toMatchObject({ ok: false, errors: { amount: 'That is more than is still owed, £3,024.00' } });
    expect(checkPayment(form({ amount: '-5' }), 302400, TODAY)).toMatchObject({ ok: false });
    expect(checkPayment(form({ amount: '1e3' }), 302400, TODAY)).toMatchObject({ ok: false });
    expect(checkPayment(form({ amount: '5' }), 0, TODAY)).toMatchObject({ ok: false, errors: { amount: 'This invoice is already paid in full' } });
  });

  it('checks the date is real, not in the future and not ancient', () => {
    expect(checkPayment(form({ paidOn: '2026-10-16' }), 302400, TODAY)).toMatchObject({ ok: false, errors: { paidOn: 'The date cannot be in the future' } });
    expect(checkPayment(form({ paidOn: '2026-02-30' }), 302400, TODAY)).toMatchObject({ ok: false, errors: { paidOn: expect.any(String) } });
    expect(checkPayment(form({ paidOn: '' }), 302400, TODAY)).toMatchObject({ ok: false });
    expect(checkPayment(form({ paidOn: '1999-12-31' }), 302400, TODAY)).toMatchObject({ ok: false });
    expect(checkPayment(form({ paidOn: '2026-10-15' }), 302400, TODAY)).toMatchObject({ ok: true });
  });

  it('accepts only the fixed list of methods', () => {
    for (const m of PAYMENT_METHODS) expect(checkPayment(form({ method: m }), 302400, TODAY)).toMatchObject({ ok: true, value: { method: m } });
    expect(PAYMENT_METHODS).toEqual(['bank transfer', 'cash', 'cheque', 'card', 'other']);
    expect(checkPayment(form({ method: 'bitcoin' }), 302400, TODAY)).toMatchObject({ ok: false, errors: { method: expect.any(String) } });
    expect(checkPayment(form({ method: '' }), 302400, TODAY)).toMatchObject({ ok: false });
  });

  it('trims the note, keeps it optional and caps it', () => {
    expect(checkPayment(form({ note: '  cheque 1042  ' }), 302400, TODAY)).toMatchObject({ ok: true, value: { note: 'cheque 1042' } });
    expect(checkPayment(form({ note: 'x'.repeat(201) }), 302400, TODAY)).toMatchObject({ ok: false, errors: { note: expect.any(String) } });
    expect(checkPayment(form({ note: 'x'.repeat(200) }), 302400, TODAY)).toMatchObject({ ok: true });
  });

  it('reports every problem at once', () => {
    const r = checkPayment({ amount: 'abc', paidOn: 'nope', method: 'x', note: '' }, 100, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['amount', 'method', 'paidOn']);
  });
});

describe('isIsoDate', () => {
  it('accepts real days only', () => {
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2025-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('26-10-15')).toBe(false);
    expect(isIsoDate('2026-10-15T00:00')).toBe(false);
  });
});
