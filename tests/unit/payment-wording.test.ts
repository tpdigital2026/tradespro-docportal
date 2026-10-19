import { describe, expect, it } from 'vitest';
import { FJC_WORDING, tenantWordingSchema } from '../../src/db/wording';
import {
  applyPaymentWording,
  changedFields,
  parsePaymentWording,
  paymentWordingOf,
  previewPaymentWording,
  storedPaymentWording,
  type PaymentWording,
} from '../../src/lib/payment-wording';

const fjc = paymentWordingOf(FJC_WORDING);

describe('paymentWordingOf', () => {
  it('reads the payment wording from the stored wording', () => {
    expect(fjc).toEqual({
      depositDueLabel: 'Before works start',
      depositTerms: 'The 30% deposit is payable before works start. The remaining balance of {balance} is due on completion of works.',
      balanceDueLabel: 'On receipt',
      balanceDueNote: 'Payment is due upon receipt of this invoice',
      balanceTerms: 'Payment is due upon receipt of this invoice.',
      paymentReference: 'address_line_1',
    });
  });

  it('shows the agreed wording for what a business has not set yet, and the wording that is stored for the rest', () => {
    const { dueLabel: _d, ...balance } = FJC_WORDING.balance_invoice;
    const { paymentReference: _p, ...rest } = FJC_WORDING;
    const old = paymentWordingOf({ ...rest, balance_invoice: { ...balance, terms: 'Own balance terms.' } });
    expect(old.balanceDueLabel).toBe('On receipt');
    expect(old.balanceTerms).toBe('Own balance terms.');
    expect(old.paymentReference).toBe('address_line_1');
    expect(paymentWordingOf(null)).toEqual(fjc);
  });

  it('what is stored is reported as stored: a field never set is absent', () => {
    const { dueLabel: _d, ...balance } = FJC_WORDING.balance_invoice;
    const { paymentReference: _p, ...rest } = FJC_WORDING;
    const stored = storedPaymentWording({ ...rest, balance_invoice: balance });
    expect(stored.balanceDueLabel).toBeUndefined();
    expect(stored.paymentReference).toBeUndefined();
    // So saving the suggested wording is a change worth saving.
    expect(changedFields(stored, fjc).sort()).toEqual(['balanceDueLabel', 'paymentReference']);
    expect(changedFields(storedPaymentWording(FJC_WORDING), fjc)).toEqual([]);
  });
});

describe('parsePaymentWording', () => {
  const ok = { ...fjc };

  it('accepts the wording as it stands', () => {
    expect(parsePaymentWording(ok)).toEqual({ ok: true, value: fjc });
  });

  it('tidies spaces and refuses empty, over-long and unprintable text, field by field', () => {
    const r = parsePaymentWording({ ...ok, depositDueLabel: '  Before   works start  ', balanceDueLabel: '', balanceDueNote: 'x'.repeat(121), balanceTerms: 'bad\u0000text' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(['balanceDueLabel', 'balanceDueNote', 'balanceTerms']);
    const good = parsePaymentWording({ ...ok, depositDueLabel: '  Before   works start  ' });
    expect(good.ok && good.value.depositDueLabel).toBe('Before works start');
  });

  it('allows {balance} in the deposit terms only', () => {
    expect(parsePaymentWording({ ...ok, depositTerms: 'Balance of {balance} on completion.' }).ok).toBe(true);
    const a = parsePaymentWording({ ...ok, depositTerms: 'Balance of {amount} on completion.' });
    expect(!a.ok && a.errors.depositTerms).toMatch(/curly brackets/);
    const b = parsePaymentWording({ ...ok, balanceTerms: 'Pay {balance}.' });
    expect(!b.ok && b.errors.balanceTerms).toMatch(/curly brackets/);
  });

  it('needs one of the two payment reference choices', () => {
    expect(parsePaymentWording({ ...ok, paymentReference: 'invoice_number' }).ok).toBe(true);
    const r = parsePaymentWording({ ...ok, paymentReference: 'something else' });
    expect(!r.ok && r.errors.paymentReference).toBeDefined();
    expect(parsePaymentWording({}).ok).toBe(false);
  });
});

describe('applyPaymentWording', () => {
  it('changes only the payment wording and the result is still a valid wording', () => {
    const next: PaymentWording = { ...fjc, depositDueLabel: 'On acceptance', paymentReference: 'invoice_number' };
    const w = applyPaymentWording(FJC_WORDING, next);
    expect(w.deposit_invoice.dueLabel).toBe('On acceptance');
    expect(w.deposit_invoice.balanceDueLabel).toBe(FJC_WORDING.deposit_invoice.balanceDueLabel);
    expect(w.quote).toEqual(FJC_WORDING.quote);
    expect(w.guarantee).toEqual(FJC_WORDING.guarantee);
    expect(w.survey).toEqual(FJC_WORDING.survey);
    expect(w.paymentReference).toBe('invoice_number');
    expect(tenantWordingSchema.parse(w)).toEqual(w);
  });
});

describe('previewPaymentWording', () => {
  it('shows how the wording reads, with an example balance in place of {balance}', () => {
    const p = previewPaymentWording(fjc);
    expect(p.deposit).toEqual({
      due: 'Before works start',
      note: 'Payable before works start · 30% deposit',
      terms: 'The 30% deposit is payable before works start. The remaining balance of £2,100.00 is due on completion of works.',
    });
    expect(p.balance).toEqual({ due: 'On receipt', note: 'Payment is due upon receipt of this invoice', terms: 'Payment is due upon receipt of this invoice.' });
    expect(p.reference).toBe('12 Example Street');
    expect(previewPaymentWording({ ...fjc, paymentReference: 'invoice_number' }).reference).toBe('INV-ES-001-D');
  });
});
