import type { MoneyLine } from '../../src/lib/money';
import type { BalanceInvoiceInput, DepositInvoiceInput, FullInvoiceInput, InvoiceCommon, StageInvoiceInput } from '../../src/templates/invoice';
import type { ScopeSection } from '../../src/templates/parts';
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
  paymentRef: '123 Bromley Road',
  terms: 'The 30% deposit is payable before works start. The remaining balance of {balance} is due on completion of works.',
  disclaimer:
    'This invoice is generated using third-party software. The platform is not a party to any contract formed between the customer and the trader for the services listed within this document. The platform has not benchmarked, endorsed, or verified the services or prices stated. For information on how personal data is processed, please refer to the relevant Privacy Notice.',
};

export const depositInvoiceFixture: DepositInvoiceInput = { ...common, dueLabel: 'Before works start', balanceDueLabel: 'Balance due on completion' };

export const balanceInvoiceFixture: BalanceInvoiceInput = {
  ...common,
  invoiceNo: 'INV-JS-001-B',
  dueLabel: 'On receipt',
  adjustmentLines: [],
  depositReceiptRef: 'RCP-JS-001-D',
  depositReceivedPence: 98820,
  dueNote: 'Payment is due upon receipt of this invoice',
  terms: 'Payment is due upon receipt of this invoice.',
};

/** A scope the size of the real ones (7 sections, 17 bullets) with a customer address of two lines, as on the real invoices: at the standard size it would spill onto a third page. */
export const longScope: ScopeSection[] = [
  { heading: 'Site set-up', bullets: ['A skip will be delivered on the start date, allowing for the safe removal and disposal of all waste materials.', 'Scaffolding will be erected to the front and rear of the property, allowing safe access to the roof.'] },
  { heading: 'Removal process', bullets: ['All hips and ridges will be removed.', 'All tiles will be removed.', 'All original battens will be removed.', 'Any rafters that have dropped will be replaced.'] },
  { heading: 'Ventilation & underlay', bullets: ['Over-fascia vents will be installed, providing the correct ventilation to the roof.', 'An eaves support tray will be installed to the perimeter of the roof.', 'A breathable membrane will be installed over the rafters.', 'Pressure-treated battens will be installed to the correct gauge for the tiles.'] },
  { heading: 'Tiling, hips & ridges', bullets: ['New tiles will be installed in a colour of your choice, all cut in to the hips.', 'Hip and ridge tiles will be fixed down with a dry ridge system.'] },
  { heading: 'Chimney', bullets: ['Code 4, 12-inch lead step flashing will be installed to the chimney.', 'The chimney will be re-flaunched.'] },
  { heading: 'Guttering', bullets: ['The original guttering will be removed back to the rafters.', 'New white square guttering will be installed with all fittings and downpipe connectors.'] },
  { heading: 'Finishing', bullets: ['All debris will be cleared from the roof and the site left clean and tidy.'] },
];

const twoLineCustomer = { ...customer, addressLines: ['123 Bromley Road', 'BR2 8BG'] };
export const longDepositInvoiceFixture: DepositInvoiceInput = { ...depositInvoiceFixture, scope: longScope, customer: twoLineCustomer };
export const longBalanceInvoiceFixture: BalanceInvoiceInput = { ...balanceInvoiceFixture, scope: longScope, customer: twoLineCustomer };

const { depositPctBp: _deposit, ...withoutDeposit } = common;
const PAYABLE_ON_RECEIPT = { dueLabel: 'On receipt', dueNote: 'Payment is due upon receipt of this invoice', terms: 'Payment is due upon receipt of this invoice.' };

export const fullInvoiceFixture: FullInvoiceInput = {
  ...withoutDeposit,
  ...PAYABLE_ON_RECEIPT,
  invoiceNo: 'INV-JS-001',
  jobDescription: 'flat roof replacement as specified above',
  quoteLines: [{ description: 'Flat roof replacement – 123 Bromley Road, complete works as specified above', kind: 'Work', qty: 1, unitNetPence: 274500, vatApplies: true }],
};

export const stageInvoiceFixture: StageInvoiceInput = {
  ...withoutDeposit,
  ...PAYABLE_ON_RECEIPT,
  invoiceNo: 'INV-JS-001-S2',
  stage: { index: 2, label: 'Roof structure complete', netPence: 137250, vatPence: 27450, grossPence: 164700 },
  stageCount: 3,
  receivedPence: 98820,
};
