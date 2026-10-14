/** Clearly dummy data for demo mode. Never shown outside it. */
import type { DocType, Stage } from './job-stage';
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

export type DemoJob = {
  quoteNumber: string;
  customerName: string;
  addressLine: string;
  stage: Stage;
};

/** Dummy jobs at different stages. Names and addresses are clearly made up. */
export const demoJobs: DemoJob[] = [
  { quoteNumber: 'DEMO-1001', customerName: 'Mr John Smith', addressLine: '123 Bromley Road, BR2 8BG', stage: 'quoted' },
  { quoteNumber: 'DEMO-1002', customerName: 'Mrs Jane Example', addressLine: '9 Sample Close, AB1 2CD', stage: 'deposit-invoiced' },
  { quoteNumber: 'DEMO-1003', customerName: 'Mr Sam Placeholder', addressLine: '45 Test Avenue, TE5 7ST', stage: 'deposit-paid' },
  { quoteNumber: 'DEMO-1004', customerName: 'Ms Alex Dummy', addressLine: '2 Nowhere Lane, ZZ1 1ZZ', stage: 'balance-invoiced' },
  { quoteNumber: 'DEMO-1005', customerName: 'Mr Kim Sample', addressLine: '77 Demo Street, DM7 7DM', stage: 'paid-in-full' },
  { quoteNumber: 'DEMO-1006', customerName: 'Mrs Pat Fictional', addressLine: '31 Made Up Gardens, MU3 1UP', stage: 'guarantee-issued' },
];

export type DemoRecentDoc = {
  type: DocType;
  number: string;
  customerName: string;
  date: string;
  status: 'Draft' | 'Final';
};

export const demoRecentDocs: DemoRecentDoc[] = [
  { type: 'quotation', number: 'DEMO-1001', customerName: 'Mr John Smith', date: '2026-10-13', status: 'Draft' },
  { type: 'deposit-invoice', number: 'INV-DEMO-1002-D', customerName: 'Mrs Jane Example', date: '2026-10-12', status: 'Final' },
  { type: 'receipt', number: 'RCT-DEMO-1003-D', customerName: 'Mr Sam Placeholder', date: '2026-10-10', status: 'Final' },
  { type: 'balance-invoice', number: 'INV-DEMO-1004-B', customerName: 'Ms Alex Dummy', date: '2026-10-08', status: 'Final' },
  { type: 'guarantee', number: 'GUA-DEMO-1006', customerName: 'Mrs Pat Fictional', date: '2026-10-06', status: 'Final' },
  { type: 'survey', number: 'SUR-DEMO-1007', customerName: 'Mr Ray Pretend', date: '2026-10-03', status: 'Draft' },
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
export const demoUsedNumbers = ['DEMO-2003', 'DEMO-2002', 'DEMO-2001', 'DEMO-1006', 'DEMO-1005', 'DEMO-1004', 'DEMO-1003', 'DEMO-1002', 'DEMO-1001'];

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
