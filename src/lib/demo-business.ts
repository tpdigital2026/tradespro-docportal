/**
 * Demo mode only: dummy facts for the Pipeline, Money, Calendar and Guarantees tabs. Never used outside demo mode.
 *
 * The issued demo jobs come from the in-memory billing state, so Mark as paid in demo mode shows up here straight away.
 * A few extra dummy jobs (paid in full, guarantees issued) and one survey fill the columns that the billing demo does
 * not reach. Their figures are made up. Demo money is worked out from the dummy quote forms, which is fine for dummy
 * data; real mode reads only what was stored when each document was issued.
 */
import { FJC_WORDING } from '../db/wording';
import { demoCustomers, demoQuoteDefaults } from './demo-data';
import { demoSlot } from './demo';
import { buildJobBilling } from './job-billing';
import { addDays, londonToUtc, todayLondon } from './london';
import { normaliseQuote } from './validation/quote';
import type { DocType } from './job-stage';
import type { FactDocument, FactPayment, JobFacts } from './business/facts';
import type { Appointment, AppointmentKind } from './calendar/model';
import { demoBillingState } from './data/billing';
import { demoDraftRows } from './data/quotes';
import { demoGuaranteeRows } from './demo-guarantees';
import { parseYears } from './guarantee/model';

/** When each dummy document was issued (yyyy-mm-dd). Anything not listed uses its quote's date. */
const ISSUED_ON: Record<string, string> = {
  'demo-doc-3001-q': '2026-10-08',
  'demo-doc-3001-d': '2026-10-09',
  'demo-doc-3002-q': '2026-10-09',
  'demo-doc-3002-f': '2026-10-10',
  'demo-doc-3003-q': '2026-09-28',
  'demo-doc-3003-s1': '2026-09-29',
  'demo-doc-3003-s2': '2026-10-05',
  'demo-doc-3003-s3': '2026-10-12',
  'demo-doc-3003-r1': '2026-10-01',
};

const w = FJC_WORDING;
function dueWordingFor(type: DocType): string | null {
  if (type === 'deposit-invoice') return w.deposit_invoice.dueLabel;
  if (type === 'balance-invoice') return w.balance_invoice.dueNote;
  if (type === 'invoice-full') return w.invoice_full?.dueNote ?? w.balance_invoice.dueNote;
  if (type === 'invoice-stage') return w.invoice_stage?.dueNote ?? w.balance_invoice.dueNote;
  return null;
}

const customerName = (id: string) => demoCustomers.find((c) => c.id === id)?.name ?? 'Customer';
const at = (date: string, time = '10:00') => {
  const r = londonToUtc(date, time);
  return r.ok ? r.at.toISOString() : `${date}T10:00:00.000Z`;
};

function issuedJobs(): JobFacts[] {
  const st = demoBillingState();
  return st.jobs.flatMap((j): JobFacts[] => {
    const docs = st.documents.get(j.jobId) ?? [];
    const pays = st.payments.get(j.jobId) ?? [];
    const plan = normaliseQuote(j.form, 'draft', demoQuoteDefaults.vatRateBp).input.plan;
    const r = buildJobBilling({ quoteNumber: j.form.quoteNumber, plan, form: j.form, vatRateBp: demoQuoteDefaults.vatRateBp, documents: docs, payments: pays });
    if (!r.ok) return [];
    const b = r.billing;
    const quoteDoc = docs.find((d) => d.type === 'quotation');
    const documents: FactDocument[] = b.documents.map((d) => {
      const live = d.status === 'final' || d.status === 'sent';
      const docDate = ISSUED_ON[d.id] ?? j.form.date;
      const inst = d.instalment ? b.instalments.find((i) => i.index === d.instalment) : undefined;
      return {
        id: d.id,
        type: d.type,
        number: d.number,
        status: d.status,
        docDate,
        finalisedAt: live ? at(docDate) : null,
        totalPence: live ? (d.type === 'quotation' ? b.totals.grossPence : (inst?.grossPence ?? null)) : null,
        dueWording: live ? dueWordingFor(d.type) : null,
        guaranteeYears: null,
        certificateNo: null,
      };
    });
    const payments: FactPayment[] = pays.map((p) => ({ id: p.id, documentId: p.documentId, amountPence: p.amountPence, paidOn: p.paidOn, method: p.method, recordedAt: at(p.paidOn, '18:00'), receiptDocumentId: p.receiptDocumentId }));
    return [
      {
        jobId: j.jobId,
        quoteNumber: j.form.quoteNumber,
        customerId: j.form.customerId,
        customerName: customerName(j.form.customerId),
        addressLine: j.form.propertyAddress,
        planKind: b.kind,
        quote: quoteDoc && (quoteDoc.status === 'final' || quoteDoc.status === 'sent') ? { documentId: quoteDoc.id, issuedAt: at(ISSUED_ON[quoteDoc.id] ?? j.form.date), grossPence: b.totals.grossPence, schedule: b.instalments.map((i) => ({ index: i.index, label: i.label, grossPence: i.grossPence })) } : null,
        draftQuoteId: null,
        documents,
        payments,
      },
    ];
  });
}

const doc = (id: string, type: DocType, number: string, docDate: string, totalPence: number | null, extra: Partial<FactDocument> = {}): FactDocument => ({
  id,
  type,
  number,
  status: 'final',
  docDate,
  finalisedAt: at(docDate),
  totalPence,
  dueWording: dueWordingFor(type),
  guaranteeYears: null,
  certificateNo: null,
  ...extra,
});
const pay = (id: string, documentId: string, amountPence: number, paidOn: string, method: string, receiptDocumentId: string | null = null): FactPayment => ({ id, documentId, amountPence, paidOn, method, recordedAt: at(paidOn, '17:30'), receiptDocumentId });

/** Dummy jobs that only these tabs show (made-up figures). They have no job page in demo mode. */
function extraJobs(): JobFacts[] {
  return [
    {
      jobId: 'demo-job-4001',
      quoteNumber: 'DEMO-4001',
      customerId: 'demo-customer-2',
      customerName: customerName('demo-customer-2'),
      addressLine: '9 Sample Close, AB1 2CD',
      planKind: 'deposit',
      quote: { documentId: 'demo-doc-4001-q', issuedAt: at('2026-09-01'), grossPence: 552000, schedule: [{ index: 1, label: 'Deposit', grossPence: 165600 }, { index: 2, label: 'Balance', grossPence: 386400 }] },
      draftQuoteId: null,
      documents: [
        doc('demo-doc-4001-q', 'quotation', 'DEMO-4001', '2026-09-01', 552000),
        doc('demo-doc-4001-d', 'deposit-invoice', 'INV-DEMO-4001-D', '2026-09-02', 165600),
        doc('demo-doc-4001-b', 'balance-invoice', 'INV-DEMO-4001-B', '2026-09-24', 386400),
      ],
      payments: [pay('demo-payment-4001-1', 'demo-doc-4001-d', 165600, '2026-09-04', 'bank transfer'), pay('demo-payment-4001-2', 'demo-doc-4001-b', 386400, '2026-10-02', 'bank transfer')],
    },
    {
      jobId: 'demo-job-1004',
      quoteNumber: 'DEMO-1004',
      customerId: 'demo-customer-1',
      customerName: customerName('demo-customer-1'),
      addressLine: '123 Bromley Road, BR2 8BG',
      planKind: 'full',
      quote: { documentId: 'demo-doc-1004-q', issuedAt: at('2026-06-10'), grossPence: 744000, schedule: [{ index: 1, label: 'Invoice', grossPence: 744000 }] },
      draftQuoteId: null,
      documents: [
        doc('demo-doc-1004-q', 'quotation', 'DEMO-1004', '2026-06-10', 744000),
        doc('demo-doc-1004-f', 'invoice-full', 'INV-DEMO-1004', '2026-07-03', 744000),
        doc('demo-doc-1004-g', 'guarantee', 'GUA-DEMO-1004', '2026-07-10', null, { guaranteeYears: 20, certificateNo: 'GUA-DEMO-1004' }),
      ],
      payments: [pay('demo-payment-1004-1', 'demo-doc-1004-f', 744000, '2026-07-08', 'cheque')],
    },
    {
      jobId: 'demo-job-1001',
      quoteNumber: 'DEMO-1001',
      customerId: 'demo-customer-2',
      customerName: customerName('demo-customer-2'),
      addressLine: '9 Sample Close, AB1 2CD',
      planKind: 'full',
      quote: { documentId: 'demo-doc-1001-q', issuedAt: at('2016-03-01'), grossPence: 216000, schedule: [{ index: 1, label: 'Invoice', grossPence: 216000 }] },
      draftQuoteId: null,
      documents: [
        doc('demo-doc-1001-q', 'quotation', 'DEMO-1001', '2016-03-01', 216000),
        doc('demo-doc-1001-f', 'invoice-full', 'INV-DEMO-1001', '2016-03-20', 216000),
        doc('demo-doc-1001-g', 'guarantee', 'GUA-DEMO-1001', '2016-03-24', null, { guaranteeYears: 10, certificateNo: 'GUA-DEMO-1001' }),
      ],
      payments: [pay('demo-payment-1001-1', 'demo-doc-1001-f', 216000, '2016-03-22', 'bank transfer')],
    },
  ];
}

/** A dummy survey on the demo job whose quote is still a draft, so the Surveyed column has something in it. */
function surveyedJob(): JobFacts | null {
  const draft = demoDraftRows().find((d) => d.jobId === 'demo-job-2002');
  if (!draft) return null;
  return {
    jobId: draft.jobId,
    quoteNumber: draft.values.quoteNumber,
    customerId: draft.values.customerId,
    customerName: customerName(draft.values.customerId),
    addressLine: draft.values.propertyAddress,
    planKind: null,
    quote: null,
    draftQuoteId: draft.jobId,
    documents: [doc('demo-doc-2002-sr', 'survey', 'SR-DEMO-2002', '2026-10-13', null)],
    payments: [],
  };
}

/** The certificates made in this demo session, added to their jobs (a job made for a certificate gets a plain entry). */
function withGuarantees(jobs: JobFacts[]): { jobs: JobFacts[]; added: string[] } {
  const out = jobs.map((j) => ({ ...j, documents: [...j.documents] }));
  const added: string[] = [];
  for (const g of demoGuaranteeRows()) {
    let job = out.find((j) => j.jobId === g.jobId);
    if (!job) {
      const reference = g.number.replace(/^GC-/, '').replace(/-G\d+$/, '');
      job = { jobId: g.jobId, quoteNumber: reference, customerId: g.customerId, customerName: customerName(g.customerId), addressLine: g.values.address, planKind: null, quote: null, draftQuoteId: null, documents: [], payments: [] };
      out.push(job);
      added.push(g.jobId);
    }
    const live = g.status === 'final';
    job.documents.push({ id: g.id, type: 'guarantee', number: g.number, status: g.status, docDate: g.docDate, finalisedAt: live && g.finalisedAt ? g.finalisedAt : null, totalPence: null, dueWording: null, guaranteeYears: live ? parseYears(g.values.years) : null, certificateNo: live ? g.number : null });
  }
  return { jobs: out, added };
}

export function demoBusinessFacts() {
  const extra = extraJobs();
  const survey = surveyedJob();
  const all = withGuarantees([...issuedJobs(), ...(survey ? [survey] : []), ...extra]);
  return {
    jobs: all.jobs,
    truncated: false,
    noJobPage: new Set([...extra.map((j) => j.jobId), ...(survey ? [survey.jobId] : []), ...all.added]),
  };
}

// ---------------------------------------------------------------- demo appointments (in memory)

interface DemoAppointments {
  list: Appointment[];
  seq: number;
}

function seedAppointments(): Appointment[] {
  const today = todayLondon();
  const mk = (n: number, kind: AppointmentKind, title: string, day: number, start: string, end: string | null, customerId: string | null, jobId: string | null, quote: string | null, notes: string | null): Appointment => ({
    id: `demo-appt-${n}`,
    kind,
    title,
    startsAt: at(addDays(today, day), start),
    endsAt: end ? at(addDays(today, day), end) : null,
    customerId,
    customerName: customerId ? customerName(customerId) : null,
    jobId,
    quoteNumber: quote,
    notes,
  });
  return [
    mk(1, 'site_visit', 'Measure up for new fascias (demo)', 0, '09:00', '10:00', 'demo-customer-2', null, null, 'Demo note: side gate code is on the job sheet.'),
    mk(2, 'survey', 'Roof survey (demo)', 1, '14:00', '15:30', 'demo-customer-1', null, null, null),
    mk(3, 'job_start', 'Start tiled re-roof (demo)', 3, '08:00', null, 'demo-customer-1', 'demo-job-3003', 'QT-BR-003', 'Demo note: scaffold arrives the day before.'),
    mk(4, 'other', 'Pick up materials (demo)', 3, '07:00', '07:45', null, null, null, null),
    mk(5, 'job_finish', 'Handover walk round (demo)', 9, '15:00', '16:00', 'demo-customer-1', 'demo-job-3003', 'QT-BR-003', null),
    mk(6, 'site_visit', 'Check gutter leak (demo)', -2, '11:00', '11:30', 'demo-customer-2', 'demo-job-3002', 'QT-BR-002', null),
  ];
}

const box = demoSlot<DemoAppointments>('appointments', () => ({ list: seedAppointments(), seq: 100 }));
export const demoAppointments = () => box.get();
export function resetDemoAppointments(): void {
  box.set(null);
}
