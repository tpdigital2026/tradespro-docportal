import type { MoneyLine } from '../../src/lib/money';
import type { BalanceInvoiceInput, DepositInvoiceInput, InvoiceCommon } from '../../src/templates/invoice';
import { bank, customer } from './common';

const quoteLines: MoneyLine[] = [
  { description: 'Flat roof replacement', kind: 'Work', qty: 1, unitNetPence: 274500, vatApplies: true },
];

const common: InvoiceCommon = {
  invoiceNo: 'INV-JS-001-D',
  quoteRef: 'QT-JS-001',
  dateLabel: '07/10/2026',
  customer,
  jobTitle: 'Flat Roof Replacement',
  jobDescription: 'flat roof replacement as specified above',
  scope: [
    { heading: 'Site set-up', bullets: ['No skip is needed, as all rubbish will be loaded onto the back of our truck.'] },
    {
      heading: 'Removal process',
      bullets: [
        'All original felt will be removed to expose the ply deck.',
        'A full inspection will be carried out on the ply deck to make sure it is in adequate condition.',
      ],
    },
    {
      heading: 'Felt roofing system',
      bullets: [
        'A 2mm perforated tack-down layer will be installed.',
        'A 3mm underlay will be installed, fully bonded, with all edging flashings.',
        'A 5mm mineral cap sheet will be installed with all edging flashings and drip edges.',
      ],
    },
  ],
  vatRateBp: 2000,
  quoteLines,
  depositPctBp: 3000,
  guarantee: { years: 20, text: 'The roofing system specified above allows us to provide a 20 year guarantee on this roof.' },
  bank,
  paymentRef: 'INV-JS-001-D',
  terms: 'The 30% deposit is payable before works start. The remaining balance is due on completion of works.',
  disclaimer:
    'This invoice is generated using third-party software. The platform is not a party to any contract formed between the customer and the trader for the services listed within this document. The platform has not benchmarked, endorsed, or verified the services or prices stated. For information on how personal data is processed, please refer to the relevant Privacy Notice.',
};

export const depositInvoiceFixture: DepositInvoiceInput = { ...common, dueLabel: 'Before works start', balanceDueLabel: 'Balance due on completion' };

export const balanceInvoiceFixture: BalanceInvoiceInput = {
  ...common,
  invoiceNo: 'INV-JS-001-B',
  paymentRef: 'INV-JS-001-B',
  adjustmentLines: [],
  depositReceiptRef: 'RCP-JS-001-D',
  depositReceivedPence: 98820,
  dueNote: 'Payment is due upon receipt of this invoice',
  terms: 'Payment is due upon receipt of this invoice.',
};
