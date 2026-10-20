/**
 * Readiness of a business set up by TradesPro: every document type is run through the real mappers with the business's
 * own stored facts and dummy draft facts, and any line asking for set-up (wording, terms, colours, logo) is a failure.
 * Pure: the script (scripts/check-fjc-readiness.ts) loads the stored facts; the unit test uses the FJC wording.
 */
import { demoCustomers, demoIssuedJobs } from '../demo-data';
import { mapDocument, type BusinessFacts, type DocumentFacts } from '../documents/map';
import { mapGuarantee } from '../guarantee/map';
import { emptyGuarantee } from '../guarantee/model';
import { mapSurvey } from '../survey/map';
import { emptyFinding, emptySurvey } from '../survey/model';
import { normaliseQuote } from '../validation/quote';
import type { DocType } from '../job-stage';

export interface ReadinessItem {
  name: string;
  ok: boolean;
  /** Set-up lines that appeared (the failure reason). Never customer data: the facts are dummy. */
  setUpLines: string[];
}

const SET_UP = /not set up|contact tradespro/i;
const BANK = { accountName: 'Dummy Account', bankName: 'Dummy Bank', sortCode: '00-00-00', accountNumber: '00000000' };

function facts(type: DocType, number: string, followOn: DocumentFacts['followOn']): DocumentFacts {
  const j = demoIssuedJobs[0];
  const c = demoCustomers.find((x) => x.id === j.form.customerId) ?? demoCustomers[0];
  return {
    type, number, docDate: j.form.date, quoteNumber: j.form.quoteNumber, propertyAddress: j.form.propertyAddress,
    jobTypeLabel: 'Flat roof', jobTypeKey: 'flat_roof', guaranteeYears: 20, customer: { name: c.name, addressLines: c.addressLines, postcode: c.postcode, email: '', phone: '' },
    quoteForm: j.form, plan: normaliseQuote(j.form, 'draft', 2000).input.plan, documents: j.documents, payments: j.payments, followOn, bank: BANK,
  };
}

const item = (name: string, missing: string[], extra: string[] = []): ReadinessItem => {
  const lines = [...missing, ...extra].filter((m) => SET_UP.test(m));
  return { name, ok: lines.length === 0, setUpLines: lines };
};

/** `brandProblems`: what the brand loader reported for the business (colours, logo). */
export function readinessChecks(b: BusinessFacts, brandProblems: string[], today: string): ReadinessItem[] {
  const out: ReadinessItem[] = [];
  const doc = (name: string, f: DocumentFacts) => {
    const r = mapDocument(f, b);
    out.push(item(name, r.ok ? [] : r.missing, brandProblems));
  };
  const ref = demoIssuedJobs[0].form.quoteNumber;
  const stem = ref.replace(/^QT-/, '');
  doc('quotation', facts('quotation', ref, null));
  doc('deposit invoice', facts('deposit-invoice', `INV-${stem}-D`, { instalment: 1, paymentId: null }));
  doc('balance invoice', facts('balance-invoice', `INV-${stem}-B`, { instalment: 2, paymentId: null }));
  doc('receipt', facts('receipt', `RCP-${stem}-D`, { instalment: 1, paymentId: demoIssuedJobs[0].payments[0]?.id ?? null }));
  const g = mapGuarantee({ number: `GC-${stem}`, jobReference: ref, customerName: 'Dummy Customer', values: emptyGuarantee({ roofType: 'flat', years: '20', address: '1 Dummy Road, Anytown', completedOn: today }) }, b, today);
  out.push(item('guarantee', g.ok ? [] : g.missing, brandProblems));
  const photo = { id: 'p1', path: 'dummy/p1.jpg', sha256: '0'.repeat(64), width: 1200, height: 900 };
  const finding = { ...emptyFinding('f1'), photoIds: ['p1'], title: 'Dummy finding', observation: 'Dummy observation.', assessment: 'Dummy assessment.' };
  const form = { ...emptySurvey({ surveyDate: today, preparedBy: b.tenant.ownerName || 'Dummy Name', propertyAddress: '1 Dummy Road, Anytown' }), findings: [finding], opinion: 'Dummy opinion.' };
  const s = mapSurvey({ number: `SR-${ref}`, jobReference: ref, customerName: 'Dummy Customer', form, photos: { p1: photo } }, b.tenant, b.wording?.survey);
  out.push(item('survey report', s.ok ? [] : s.missing, brandProblems));
  return out;
}
