/** Clearly dummy data for demo mode. Never shown outside it. */
import type { DocType } from './job-stage';
import type { RawDocument, RawPayment } from './job-billing';
import type { QuoteFormValues } from './validation/quote';

export const demoSession = {
  userId: 'demo-user',
  tenantId: 'demo-tenant',
  role: 'owner' as const,
  email: 'owner@demo.invalid',
  fullName: 'Demo Owner',
  businessName: 'FJC Roofing Ltd',
};

export type DemoCustomer = {
  id: string;
  name: string;
  addressLines: string[];
  postcode: string;
  email: string | null;
  phone: string | null;
  /** Days of the retention period left, so demo mode can show both the calm and the warning state. */
  daysLeft: number;
};

export const demoCustomers: DemoCustomer[] = [
  {
    id: 'demo-customer-1',
    name: 'Mr John Smith',
    addressLines: ['123 Bromley Road'],
    postcode: 'BR2 8BG',
    email: null,
    phone: null,
    daysLeft: 90,
  },
  {
    id: 'demo-customer-2',
    name: 'Mrs Jane Example',
    addressLines: ['9 Sample Close'],
    postcode: 'AB1 2CD',
    email: null,
    phone: null,
    daysLeft: 9,
  },
];

export type DemoQuote = {
  id: string;
  quoteNumber: string;
  customerId: string;
  date: string;
  status: 'draft' | 'final';
};

export const demoQuotes: DemoQuote[] = [
  {
    id: 'demo-quote-1',
    quoteNumber: 'DEMO-0001',
    customerId: 'demo-customer-1',
    date: '2026-10-12',
    status: 'draft',
  },
];

export type DemoRecentDoc = {
  type: DocType;
  number: string;
  customerName: string;
  date: string;
  status: 'Draft' | 'Final';
};

export const demoRecentDocs: DemoRecentDoc[] = [
  { type: 'receipt', number: 'RCP-DEMO-3003-S1', customerName: 'Mr John Smith', date: '2026-10-14', status: 'Final' },
  { type: 'invoice-stage', number: 'INV-DEMO-3003-S3', customerName: 'Mr John Smith', date: '2026-10-13', status: 'Final' },
  { type: 'invoice-full', number: 'INV-DEMO-3002', customerName: 'Mrs Jane Example', date: '2026-10-12', status: 'Final' },
  { type: 'deposit-invoice', number: 'INV-DEMO-3001-D', customerName: 'Mr John Smith', date: '2026-10-10', status: 'Final' },
  { type: 'quotation', number: 'DEMO-2001', customerName: 'Mr John Smith', date: '2026-10-12', status: 'Draft' },
  { type: 'survey', number: 'SUR-DEMO-3007', customerName: 'Mr Ray Pretend', date: '2026-10-03', status: 'Draft' },
];

// ------------------------------------------------------------------ quote form (dummy data only)

export const demoJobTypes = [
  { id: 'demo-jobtype-flat', label: 'Flat roof (demo)', guaranteeYears: 20 },
  { id: 'demo-jobtype-tiled', label: 'Tiled roof (demo)', guaranteeYears: 25 },
  { id: 'demo-jobtype-fascia', label: 'Fascias and gutters (demo)', guaranteeYears: null },
];

/** Dummy account, last four digits only. */
export const demoBankAccounts = [
  { id: 'demo-bank-main', label: 'Demo Business Account, Demo Bank, ending 0000', last4: '0000', isDefault: true },
  { id: 'demo-bank-second', label: 'Demo Savings Account, Demo Bank, ending 1111', last4: '1111', isDefault: false },
];

export const demoQuoteDefaults = { vatDefault: true, vatRateBp: 2000, depositPctBp: 3000 };

/** Quote numbers already used in demo mode, newest first. */
export const demoUsedNumbers = ['DEMO-3003', 'DEMO-3002', 'DEMO-3001', 'DEMO-2003', 'DEMO-2002', 'DEMO-2001', 'DEMO-1006', 'DEMO-1005', 'DEMO-1004', 'DEMO-1003', 'DEMO-1002', 'DEMO-1001'];

const demoForm = (over: Partial<QuoteFormValues>): QuoteFormValues => ({
  quoteNumber: '',
  customerId: 'demo-customer-1',
  date: '2026-10-12',
  jobTypeId: 'demo-jobtype-flat',
  propertyAddress: '',
  scopeNotes: 'Demo scope text: remove the old covering and fit the new one. Dummy data for screenshots only.',
  price: '',
  vatApplies: true,
  extras: [],
  discount: '',
  plan: { kind: 'deposit', depositPct: '30', stages: [{ label: '', mode: 'pct', value: '' }, { label: '', mode: 'pct', value: '' }] },
  bankAccountId: 'demo-bank-main',
  ...over,
});

/** Three dummy drafts, one per way of being paid. Figures are made up for the demo. */
export const demoQuoteDrafts: { jobId: string; values: QuoteFormValues }[] = [
  {
    jobId: 'demo-job-2001',
    values: demoForm({ quoteNumber: 'DEMO-2001', customerId: 'demo-customer-1', price: '8400', propertyAddress: '123 Bromley Road, BR2 8BG' }),
  },
  {
    jobId: 'demo-job-2002',
    values: demoForm({
      quoteNumber: 'DEMO-2002',
      customerId: 'demo-customer-2',
      jobTypeId: 'demo-jobtype-fascia',
      price: '1850',
      date: '2026-10-13',
      plan: { kind: 'full', depositPct: '30', stages: [{ label: '', mode: 'pct', value: '' }, { label: '', mode: 'pct', value: '' }] },
      propertyAddress: '9 Sample Close, AB1 2CD',
    }),
  },
  {
    jobId: 'demo-job-2003',
    values: demoForm({
      quoteNumber: 'DEMO-2003',
      customerId: 'demo-customer-1',
      jobTypeId: 'demo-jobtype-tiled',
      price: '25000',
      date: '2026-10-14',
      plan: {
        kind: 'staged',
        depositPct: '30',
        stages: [
          { label: 'Deposit', mode: 'pct', value: '20' },
          { label: 'Scaffold up and strip complete', mode: 'pct', value: '20' },
          { label: 'Roof structure complete', mode: 'pct', value: '25' },
          { label: 'Roof covering complete', mode: 'pct', value: '20' },
          { label: 'Handover', mode: 'pct', value: '15' },
        ],
      },
    }),
  },
];

// ------------------------------------------------------------------ issued jobs (dummy data only)

export interface DemoIssuedJob {
  jobId: string;
  /** The saved quote form the figures come from. The schedule is recomputed from it, never stored. */
  form: QuoteFormValues;
  documents: RawDocument[];
  payments: RawPayment[];
}

const dDoc = (id: string, type: DocType, number: string, status: RawDocument['status'] = 'final'): RawDocument => ({ id, type, number, status });
const dPay = (id: string, documentId: string, amountPence: number, paidOn: string, method: string, receiptDocumentId: string | null = null): RawPayment => ({
  id,
  documentId,
  amountPence,
  paidOn,
  method,
  note: null,
  receiptDocumentId,
});

/**
 * Three jobs whose quotes have been issued, one for each way of being paid. Figures are made up:
 *  DEMO-3001 deposit plan, deposit paid, balance not yet raised
 *  DEMO-3002 pay in full, invoice raised and not yet paid
 *  DEMO-3003 five stages, stages 1 and 2 paid, stage 3 invoiced and part paid
 */
export const demoIssuedJobs: DemoIssuedJob[] = [
  {
    jobId: 'demo-job-3001',
    form: demoForm({ quoteNumber: 'DEMO-3001', customerId: 'demo-customer-1', price: '8400', date: '2026-10-08', propertyAddress: '123 Bromley Road, BR2 8BG' }),
    documents: [dDoc('demo-doc-3001-q', 'quotation', 'DEMO-3001'), dDoc('demo-doc-3001-d', 'deposit-invoice', 'INV-DEMO-3001-D')],
    payments: [dPay('demo-payment-3001-1', 'demo-doc-3001-d', 302400, '2026-10-11', 'bank transfer')],
  },
  {
    jobId: 'demo-job-3002',
    form: demoForm({
      quoteNumber: 'DEMO-3002',
      customerId: 'demo-customer-2',
      jobTypeId: 'demo-jobtype-fascia',
      price: '1850',
      date: '2026-10-09',
      plan: { kind: 'full', depositPct: '30', stages: [{ label: '', mode: 'pct', value: '' }, { label: '', mode: 'pct', value: '' }] },
      propertyAddress: '9 Sample Close, AB1 2CD',
    }),
    documents: [dDoc('demo-doc-3002-q', 'quotation', 'DEMO-3002'), dDoc('demo-doc-3002-f', 'invoice-full', 'INV-DEMO-3002')],
    payments: [],
  },
  {
    jobId: 'demo-job-3003',
    form: demoForm({
      quoteNumber: 'DEMO-3003',
      customerId: 'demo-customer-1',
      jobTypeId: 'demo-jobtype-tiled',
      price: '25000',
      date: '2026-09-28',
      propertyAddress: '123 Bromley Road, BR2 8BG',
      plan: {
        kind: 'staged',
        depositPct: '30',
        stages: [
          { label: 'Deposit', mode: 'pct', value: '20' },
          { label: 'Scaffold up and strip complete', mode: 'pct', value: '20' },
          { label: 'Roof structure complete', mode: 'pct', value: '25' },
          { label: 'Roof covering complete', mode: 'pct', value: '20' },
          { label: 'Handover', mode: 'pct', value: '15' },
        ],
      },
    }),
    documents: [
      dDoc('demo-doc-3003-q', 'quotation', 'DEMO-3003'),
      dDoc('demo-doc-3003-s1', 'invoice-stage', 'INV-DEMO-3003-S1'),
      dDoc('demo-doc-3003-s2', 'invoice-stage', 'INV-DEMO-3003-S2'),
      dDoc('demo-doc-3003-s3', 'invoice-stage', 'INV-DEMO-3003-S3'),
      dDoc('demo-doc-3003-r1', 'receipt', 'RCP-DEMO-3003-S1'),
    ],
    payments: [
      dPay('demo-payment-3003-1', 'demo-doc-3003-s1', 600000, '2026-10-01', 'bank transfer', 'demo-doc-3003-r1'),
      dPay('demo-payment-3003-2', 'demo-doc-3003-s2', 600000, '2026-10-08', 'bank transfer'),
      dPay('demo-payment-3003-3', 'demo-doc-3003-s3', 300000, '2026-10-14', 'cheque'),
    ],
  },
];
