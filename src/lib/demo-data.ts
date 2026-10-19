/** Clearly dummy data for demo mode. Never shown outside it. */
import type { DocType } from './job-stage';
import type { RawDocument, RawPayment } from './job-billing';
import { FJC_WORDING } from '../db/wording';
import { FJC_SCOPE_EXAMPLES } from './scope/fjc-examples';
import { approvalHash, approvalHashV1, emptyScope, scopeKey, sectionsKey, type ScopeFormValues } from './scope/model';
import { signGenerated } from './scope/proof';
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


// ------------------------------------------------------------------ the business on demo documents

/** FJC's own business facts and wording (as seeded), so demo documents look like the real thing. Customers stay dummy. */
export const demoBusiness = {
  tenant: {
    name: 'FJC Roofing Ltd',
    addressLine: 'Rochester · United Kingdom · ME3 9UD',
    phone: '07596115834',
    email: 'Ben@fjcroofingltd.com',
    web: 'www.fjcroofingltd.co.uk',
    companyNo: '13855379',
    vatNo: 'GB 408094403',
    tagline: 'Covering Your Home, Protecting Your Family',
    ownerName: 'Ben Cunningham',
    ownerTitle: 'Director',
  },
  wording: FJC_WORDING,
  disclaimer: '',
  validityDays: 30,
};

/**
 * Dummy scope wording, already approved, so demo quotes can be previewed and finalised. Generic steps only: no
 * measurements, products, brands or guarantees.
 */
function demoScope(title: string): ScopeFormValues {
  const items = [
    { id: 'd1', kind: 'heading' as const, text: 'Getting ready' },
    { id: 'd2', kind: 'step' as const, text: 'Protect the paths and the garden under the work area.' },
    { id: 'd3', kind: 'step' as const, text: 'Set up safe access to the roof.' },
    { id: 'd4', kind: 'heading' as const, text: 'The work' },
    { id: 'd5', kind: 'step' as const, text: 'Strip the old roof covering and take it away.' },
    { id: 'd6', kind: 'step' as const, text: 'Check the boards underneath and replace any that are rotten.' },
    { id: 'd7', kind: 'step' as const, text: 'Lay the new roof covering.' },
    { id: 'd8', kind: 'heading' as const, text: 'Finishing off' },
    { id: 'd9', kind: 'step' as const, text: 'Clear all waste from site.' },
    { id: 'd10', kind: 'step' as const, text: 'Walk round the finished job with you.' },
  ];
  const scope: ScopeFormValues = {
    coverTitle: title,
    coverSub: 'Scope of works and price (demo)',
    intro: 'Thank you for asking us to quote. This is demo wording: it shows how a quotation is laid out.',
    specCards: [],
    note: '',
    items,
    copy: {
      sections: [
        { heading: 'Getting ready', steps: ['Protect the paths and the garden under the work area.', 'Set up safe access to the roof.'] },
        { heading: 'The work', steps: ['Strip the old roof covering and take it away.', 'Check the boards underneath and replace any that are rotten.', 'Lay the new roof covering.'] },
        { heading: 'Finishing off', steps: ['Clear all waste from site.', 'Walk round the finished job with you.'] },
      ],
      corrections: [],
      uncertain: [],
      engine: 'fallback',
      generatedAt: '2026-10-12T09:00:00.000Z',
      sourceKey: scopeKey(items),
      proof: 'demo',
      approvedAt: null,
      approvalHash: null,
    },
  };
  // A real proof for the demo business, so an autosave keeps the wording (a made-up proof makes the server drop it).
  const made = { ...scope.copy!, genKey: sectionsKey(scope.copy!.sections) };
  let proof = 'demo';
  try {
    proof = signGenerated('demo-tenant', made);
  } catch {
    // No proof secret here (never the case in demo mode): the dummy wording simply is not kept on save.
  }
  const signed = { ...scope, copy: { ...made, proof } };
  return { ...signed, copy: { ...signed.copy, approvedAt: '2026-10-12T09:05:00.000Z', approvalHash: approvalHash(signed) } };
}

// ------------------------------------------------------------------ quote form (dummy data only)

export const demoJobTypes = [
  { id: 'demo-jobtype-flat', label: 'Flat roof (demo)', guaranteeYears: 20, scopeExamples: FJC_SCOPE_EXAMPLES.flat_roof ?? null },
  { id: 'demo-jobtype-tiled', label: 'Tiled roof (demo)', guaranteeYears: 25, scopeExamples: FJC_SCOPE_EXAMPLES.tiled_roof ?? null },
  { id: 'demo-jobtype-fascia', label: 'Fascias and gutters (demo)', guaranteeYears: null, scopeExamples: FJC_SCOPE_EXAMPLES.fascia ?? null },
];

/** Dummy account, last four digits only. */
export const demoBankAccounts = [
  { id: 'demo-bank-main', label: 'Demo Business Account, Demo Bank, ending 0000', last4: '0000', isDefault: true },
  { id: 'demo-bank-second', label: 'Demo Savings Account, Demo Bank, ending 1111', last4: '1111', isDefault: false },
];

export const demoQuoteDefaults = { vatDefault: true, vatRateBp: 2000, depositPctBp: 3000 };

/** Quote numbers already used in demo mode, newest first. */
export const demoUsedNumbers = ['QT-BR-003', 'QT-BR-002', 'QT-BR-001', 'DEMO-2003', 'DEMO-2002', 'DEMO-2001', 'DEMO-1006', 'DEMO-1005', 'DEMO-1004', 'DEMO-1003', 'DEMO-1002', 'DEMO-1001'];

const demoForm = (over: Partial<QuoteFormValues>): QuoteFormValues => ({
  quoteNumber: '',
  customerId: 'demo-customer-1',
  date: '2026-10-12',
  jobTypeId: 'demo-jobtype-flat',
  propertyAddress: '',
  scope: emptyScope(),
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
    values: demoForm({ quoteNumber: 'DEMO-2001', customerId: 'demo-customer-1', price: '8400', propertyAddress: '123 Bromley Road, BR2 8BG', scope: demoScope('Flat roof replacement') }),
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
  {
    // Approved on the morning of 15 October under the first fingerprint (before the cover and introduction were
    // covered too). Opening it shows the upgrade path: the approval is checked against the old fingerprint and kept.
    jobId: 'demo-job-2004',
    values: demoForm({ quoteNumber: 'DEMO-2004', customerId: 'demo-customer-1', price: '6200', date: '2026-10-15', propertyAddress: '123 Bromley Road, BR2 8BG', scope: legacyApproved(demoScope('Flat roof quotation')) }),
  },
];

/** The same scope as if it had been approved under the first fingerprint, at 09:49 on 15 October. */
function legacyApproved(s: ScopeFormValues): ScopeFormValues {
  return { ...s, copy: { ...s.copy!, approvedAt: '2026-10-15T08:49:00.000Z', approvalHash: approvalHashV1(s) } };
}

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
 *  QT-BR-001 deposit plan, deposit paid, balance not yet raised
 *  QT-BR-002 pay in full, invoice raised and not yet paid
 *  QT-BR-003 five stages, stages 1 and 2 paid, stage 3 invoiced and part paid
 */
export const demoIssuedJobs: DemoIssuedJob[] = [
  {
    jobId: 'demo-job-3001',
    form: demoForm({ quoteNumber: 'QT-BR-001', customerId: 'demo-customer-1', price: '8400', date: '2026-10-08', propertyAddress: '123 Bromley Road, BR2 8BG', scope: demoScope('Flat roof replacement') }),
    documents: [dDoc('demo-doc-3001-q', 'quotation', 'QT-BR-001'), dDoc('demo-doc-3001-d', 'deposit-invoice', 'INV-BR-001-D')],
    payments: [dPay('demo-payment-3001-1', 'demo-doc-3001-d', 302400, '2026-10-11', 'bank transfer')],
  },
  {
    jobId: 'demo-job-3002',
    form: demoForm({
      quoteNumber: 'QT-BR-002',
      customerId: 'demo-customer-2',
      jobTypeId: 'demo-jobtype-fascia',
      price: '1850',
      date: '2026-10-09',
      plan: { kind: 'full', depositPct: '30', stages: [{ label: '', mode: 'pct', value: '' }, { label: '', mode: 'pct', value: '' }] },
      propertyAddress: '9 Sample Close, AB1 2CD',
      scope: demoScope('Fascia and gutter replacement'),
    }),
    documents: [dDoc('demo-doc-3002-q', 'quotation', 'QT-BR-002'), dDoc('demo-doc-3002-f', 'invoice-full', 'INV-BR-002')],
    payments: [],
  },
  {
    jobId: 'demo-job-3003',
    form: demoForm({
      quoteNumber: 'QT-BR-003',
      customerId: 'demo-customer-1',
      jobTypeId: 'demo-jobtype-tiled',
      price: '25000',
      date: '2026-09-28',
      propertyAddress: '123 Bromley Road, BR2 8BG',
      scope: demoScope('Tiled re-roof'),
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
      dDoc('demo-doc-3003-q', 'quotation', 'QT-BR-003'),
      dDoc('demo-doc-3003-s1', 'invoice-stage', 'INV-BR-003-S1'),
      dDoc('demo-doc-3003-s2', 'invoice-stage', 'INV-BR-003-S2'),
      dDoc('demo-doc-3003-s3', 'invoice-stage', 'INV-BR-003-S3'),
      dDoc('demo-doc-3003-r1', 'receipt', 'RCP-BR-003-S1'),
    ],
    payments: [
      dPay('demo-payment-3003-1', 'demo-doc-3003-s1', 600000, '2026-10-01', 'bank transfer', 'demo-doc-3003-r1'),
      dPay('demo-payment-3003-2', 'demo-doc-3003-s2', 600000, '2026-10-08', 'bank transfer'),
      dPay('demo-payment-3003-3', 'demo-doc-3003-s3', 300000, '2026-10-14', 'cheque'),
    ],
  },
];
