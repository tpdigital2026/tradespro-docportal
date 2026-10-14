import type { ReceiptInput } from '../../src/templates/receipt';
import { customer } from './common';

export const depositReceiptFixture: ReceiptInput = {
  receiptNo: 'RCP-JS-001-D',
  invoiceRef: 'INV-JS-001-D',
  quoteRef: 'QT-JS-001',
  paidDateLabel: '07/10/2026',
  customer,
  kind: 'deposit',
  description: '30% Deposit – flat roof replacement (inc. VAT)',
  method: 'Bank transfer',
  amountPaidPence: 98820,
  previousPaymentsPence: [],
  jobTotalGrossPence: 329400,
  vatIncluded: true,
  balanceDueLabel: 'Due on completion of works',
};

export const finalReceiptFixture: ReceiptInput = {
  ...depositReceiptFixture,
  receiptNo: 'RCP-JS-001-B',
  invoiceRef: 'INV-JS-001-B',
  paidDateLabel: '11/10/2026',
  kind: 'balance',
  description: 'Balance payment – flat roof replacement (inc. VAT)',
  amountPaidPence: 230580,
  previousPaymentsPence: [98820],
};
