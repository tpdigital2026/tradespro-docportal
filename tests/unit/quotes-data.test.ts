import { describe, expect, it } from 'vitest';
import { getDraftWith, listBankAccountsWith, listDraftsWith, listJobTypesWith, numberIsFreeWith, QuoteError, saveDraftWith } from '../../src/lib/data/quotes';
import { emptyQuoteForm, type QuoteFormValues } from '../../src/lib/validation/quote';
import type { DataClient } from '../../src/lib/data/customers';
import { fakeClient } from '../fixtures/fake-quotes-client';
import { generatedScope } from '../fixtures/scope';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

function form(over: Partial<QuoteFormValues> = {}): QuoteFormValues {
  return { ...emptyQuoteForm({ date: '2026-10-14', vatApplies: true }), quoteNumber: 'QT-0100', customerId: CUSTOMER, price: '10000', scope: generatedScope(TENANT), ...over };
}

describe('saveDraftWith', () => {
  it('first save creates the job, quotation, version and links them', async () => {
    const { client, tables } = fakeClient();
    const r = await saveDraftWith(client, TENANT, form(), null, 2000, '2026-10-14');
    expect(tables.jobs).toHaveLength(1);
    expect(tables.jobs[0]).toMatchObject({ tenant_id: TENANT, customer_id: CUSTOMER, reference: 'QT-0100' });
    expect(tables.documents[0]).toMatchObject({ type: 'quotation', number: 'QT-0100', job_id: r.jobId, doc_date: '2026-10-14' });
    expect(tables.document_versions[0]).toMatchObject({ version: 1, document_id: r.documentId });
    expect(tables.documents[0].current_version_id).toBe(tables.document_versions[0].id);
  });
  it('stores the plan on the job, with instalments that add up to the total', async () => {
    const { client, tables } = fakeClient();
    await saveDraftWith(client, TENANT, form(), null, 2000, '2026-10-14');
    const plan = tables.jobs[0].payment_plan as { kind: string; pct_bp: number; instalments: { gross_pence: number }[] };
    expect(plan.kind).toBe('deposit');
    expect(plan.pct_bp).toBe(3000);
    expect(plan.instalments.map((i) => i.gross_pence)).toEqual([360_000, 840_000]);
  });
  it('a staged plan that does not total is saved as typed, without instalments', async () => {
    const { client, tables } = fakeClient();
    await saveDraftWith(
      client,
      TENANT,
      form({ plan: { kind: 'staged', depositPct: '30', stages: [{ label: 'A', mode: 'pct', value: '30' }, { label: 'B', mode: 'pct', value: '30' }] } }),
      null,
      2000,
      '2026-10-14',
    );
    const plan = tables.jobs[0].payment_plan as Record<string, unknown>;
    expect(plan.kind).toBe('staged');
    expect('instalments' in plan).toBe(false);
  });
  it('a half-typed plan is kept in the version and the job column stays empty', async () => {
    const { client, tables } = fakeClient();
    await saveDraftWith(
      client,
      TENANT,
      form({ plan: { kind: 'staged', depositPct: '30', stages: [{ label: '', mode: 'pct', value: '' }, { label: 'B', mode: 'amount', value: '' }] } }),
      null,
      2000,
      '2026-10-14',
    );
    expect(tables.jobs[0].payment_plan).toBeNull();
    const saved = (tables.document_versions[0].input as { form: QuoteFormValues }).form;
    expect(saved.plan.stages[1]).toEqual({ label: 'B', mode: 'amount', value: '' });
  });
  it('later saves update the same rows and never add new ones', async () => {
    const { client, tables } = fakeClient();
    const first = await saveDraftWith(client, TENANT, form(), null, 2000, '2026-10-14');
    const second = await saveDraftWith(client, TENANT, form({ price: '12000', scope: generatedScope(TENANT, { note: 'Changed' }), quoteNumber: 'IGNORED-2' }), first.jobId, 2000, '2026-10-15');
    expect(second.jobId).toBe(first.jobId);
    expect(tables.jobs).toHaveLength(1);
    expect(tables.documents).toHaveLength(1);
    expect(tables.document_versions).toHaveLength(1);
    expect(tables.jobs[0].reference).toBe('QT-0100'); // the number never changes once saved
    expect((tables.document_versions[0].input as { form: QuoteFormValues }).form.price).toBe('12000');
    expect(tables.documents[0].doc_date).toBe('2026-10-14'); // date typed in the form, not today
  });
  it('refuses a number another job already holds', async () => {
    const { client } = fakeClient({ jobs: [{ id: 'x', reference: 'QT-0100', customer_id: OTHER }] });
    await expect(saveDraftWith(client, TENANT, form(), null, 2000, '2026-10-14')).rejects.toMatchObject({ code: 'number_used' });
  });
  it('carries on with its own earlier attempt that stopped before the document existed', async () => {
    const { client, tables } = fakeClient({ jobs: [{ id: '44444444-4444-4444-8444-444444444444', tenant_id: TENANT, reference: 'QT-0100', customer_id: CUSTOMER }] });
    const r = await saveDraftWith(client, TENANT, form(), null, 2000, '2026-10-14');
    expect(r.jobId).toBe('44444444-4444-4444-8444-444444444444');
    expect(tables.jobs).toHaveLength(1);
    expect(tables.documents).toHaveLength(1);
  });
  it('does not adopt a job that already has a document, or one for another customer', async () => {
    const job = { id: '44444444-4444-4444-8444-444444444444', tenant_id: TENANT, reference: 'QT-0100', customer_id: CUSTOMER };
    const a = fakeClient({ jobs: [job], documents: [{ id: 'd', job_id: job.id, type: 'quotation', status: 'draft' }] });
    await expect(saveDraftWith(a.client, TENANT, form(), null, 2000, '2026-10-14')).rejects.toMatchObject({ code: 'number_used' });
    const b = fakeClient({ jobs: [{ ...job, customer_id: OTHER }] });
    await expect(saveDraftWith(b.client, TENANT, form(), null, 2000, '2026-10-14')).rejects.toMatchObject({ code: 'number_used' });
  });
  it('repairs a save that stopped after the document but before the version', async () => {
    const first = fakeClient();
    const r = await saveDraftWith(first.client, TENANT, form(), null, 2000, '2026-10-14');
    first.tables.document_versions.length = 0; // the version insert "never happened"
    await saveDraftWith(first.client, TENANT, form({ price: '9000' }), r.jobId, 2000, '2026-10-14');
    expect(first.tables.document_versions).toHaveLength(1);
    expect(first.tables.documents[0].current_version_id).toBe(first.tables.document_versions[0].id);
  });
  it('the job row owns its number and customer: a tampered form changes nothing', async () => {
    const { client, tables } = fakeClient();
    const first = await saveDraftWith(client, TENANT, form(), null, 2000, '2026-10-14');
    expect(first).toMatchObject({ quoteNumber: 'QT-0100', customerId: CUSTOMER });
    const second = await saveDraftWith(client, TENANT, form({ quoteNumber: 'QT-0999', customerId: OTHER, price: '5' }), first.jobId, 2000, '2026-10-14');
    expect(second).toMatchObject({ quoteNumber: 'QT-0100', customerId: CUSTOMER });
    expect(tables.jobs[0]).toMatchObject({ reference: 'QT-0100', customer_id: CUSTOMER });
    expect(tables.documents[0].number).toBe('QT-0100');
    const stored = (tables.document_versions[0].input as { form: QuoteFormValues }).form;
    expect(stored).toMatchObject({ quoteNumber: 'QT-0100', customerId: CUSTOMER, price: '5' });
    expect(tables.used_numbers.length + tables.jobs.length).toBeGreaterThan(0);
  });
  it('two quick edits around a first save end with the claimed number everywhere', async () => {
    const { client, tables } = fakeClient();
    const first = await saveDraftWith(client, TENANT, form({ quoteNumber: 'QT-0100' }), null, 2000, '2026-10-14');
    // the browser typed a different number while the first save was in flight, then sent it with the job id
    const second = await saveDraftWith(client, TENANT, form({ quoteNumber: 'QT-0101', price: '77' }), first.jobId, 2000, '2026-10-14');
    expect(second.quoteNumber).toBe('QT-0100');
    expect(tables.jobs.map((j) => j.reference)).toEqual(['QT-0100']);
    expect(tables.documents.map((d) => d.number)).toEqual(['QT-0100']);
    expect((tables.document_versions[0].input as { form: QuoteFormValues }).form.quoteNumber).toBe('QT-0100');
  });
  it('the heal branch takes the document number from the job, not the form', async () => {
    const { client, tables } = fakeClient();
    const first = await saveDraftWith(client, TENANT, form(), null, 2000, '2026-10-14');
    tables.documents.length = 0;
    tables.document_versions.length = 0;
    await saveDraftWith(client, TENANT, form({ quoteNumber: 'QT-0999' }), first.jobId, 2000, '2026-10-14');
    expect(tables.documents.map((d) => d.number)).toEqual(['QT-0100']);
    expect((tables.document_versions[0].input as { form: QuoteFormValues }).form.quoteNumber).toBe('QT-0100');
  });
  it('will not edit a quote that has been issued', async () => {
    const { client, tables } = fakeClient();
    const first = await saveDraftWith(client, TENANT, form(), null, 2000, '2026-10-14');
    tables.documents[0].status = 'final';
    await expect(saveDraftWith(client, TENANT, form({ price: '1' }), first.jobId, 2000, '2026-10-14')).rejects.toMatchObject({ code: 'locked' });
  });
  it('rejects an unknown draft id and a malformed one', async () => {
    const { client } = fakeClient();
    await expect(saveDraftWith(client, TENANT, form(), '55555555-5555-4555-8555-555555555555', 2000, '2026-10-14')).rejects.toMatchObject({ code: 'not_found' });
    await expect(saveDraftWith(client, TENANT, form(), "1' or '1'='1", 2000, '2026-10-14')).rejects.toMatchObject({ code: 'not_found' });
  });
  it('rejects a draft with no customer or a bad number before touching the database', async () => {
    const { client, log } = fakeClient();
    await expect(saveDraftWith(client, TENANT, form({ customerId: '' }), null, 2000, '2026-10-14')).rejects.toBeInstanceOf(QuoteError);
    await expect(saveDraftWith(client, TENANT, form({ quoteNumber: "x'; drop" }), null, 2000, '2026-10-14')).rejects.toMatchObject({ code: 'invalid' });
    await expect(saveDraftWith(client, TENANT, form({ customerId: 'demo-customer-1' }), null, 2000, '2026-10-14')).rejects.toMatchObject({ code: 'invalid' });
    expect(log).toEqual([]);
  });
  it('database failures surface as a generic error, never the database message', async () => {
    const { client } = fakeClient({}, { failOn: (t, op) => t === 'documents' && op === 'insert' });
    const e = await saveDraftWith(client, TENANT, form(), null, 2000, '2026-10-14').catch((x) => x);
    expect(e).toBeInstanceOf(QuoteError);
    expect(e.code).toBe('failed');
    expect(String(e.message)).not.toMatch(/boom/);
  });
});

describe('reading drafts back', () => {
  it('round trips what was typed, including half-typed stages', async () => {
    const { client, tables } = fakeClient({ customers: [{ id: CUSTOMER, name: 'Mr John Smith' }] });
    const typed = form({ propertyAddress: '1 Test Road', plan: { kind: 'staged', depositPct: '30', stages: [{ label: 'One', mode: 'pct', value: '40' }, { label: '', mode: 'amount', value: '12' }] } });
    const saved = await saveDraftWith(client, TENANT, typed, null, 2000, '2026-10-14');
    const back = await getDraftWith(client, saved.jobId);
    expect(back?.values).toEqual({ ...typed, jobTypeId: '', propertyAddress: '1 Test Road' });
    expect(back?.customerName).toBe('Mr John Smith');
    tables.documents[0].status = 'final';
    expect(await getDraftWith(client, saved.jobId)).toBeNull();
  });
  it('does not trust a damaged saved form', async () => {
    const { client, tables } = fakeClient({ customers: [{ id: CUSTOMER, name: 'A' }] });
    const saved = await saveDraftWith(client, TENANT, form(), null, 2000, '2026-10-14');
    tables.document_versions[0].input = { form: { price: 5 } };
    const back = await getDraftWith(client, saved.jobId);
    expect(back?.values.quoteNumber).toBe('QT-0100');
    expect(back?.values.price).toBe('');
  });
  it('lists draft quotations with the customer name', async () => {
    const { client } = fakeClient({ customers: [{ id: CUSTOMER, name: 'Mr John Smith' }] });
    await saveDraftWith(client, TENANT, form(), null, 2000, '2026-10-14');
    expect(await listDraftsWith(client)).toEqual([{ jobId: expect.any(String), quoteNumber: 'QT-0100', customerName: 'Mr John Smith', date: '2026-10-14' }]);
  });
});

describe('lookups', () => {
  it('number check says taken or free', async () => {
    const { client } = fakeClient({ used_numbers: [{ number: 'QT-0100' }] });
    expect(await numberIsFreeWith(client, 'QT-0100')).toBe(false);
    expect(await numberIsFreeWith(client, 'QT-0101')).toBe(true);
    expect(await numberIsFreeWith(client, "x';")).toBe(false);
  });
  it('job types carry their guarantee years; bank accounts show the last four only', async () => {
    const { client } = fakeClient({
      job_types: [{ id: 'a', label: 'Flat roof', guarantee_years: 20 }, { id: 'b', label: 'Fascia', guarantee_years: null }],
      bank_accounts: [{ id: 'c', account_name: 'Business', bank_name: 'Demo Bank', last4: '0000', is_default: true, archived_at: null, sort_code_enc: 'SECRET' }],
    });
    expect(await listJobTypesWith(client)).toEqual([
      { id: 'a', label: 'Flat roof', guaranteeYears: 20, scopeExamples: null },
      { id: 'b', label: 'Fascia', guaranteeYears: null, scopeExamples: null },
    ]);
    const banks = await listBankAccountsWith(client);
    expect(banks).toEqual([{ id: 'c', label: 'Business, Demo Bank, ending 0000', last4: '0000', isDefault: true }]);
    expect(JSON.stringify(banks)).not.toMatch(/SECRET/);
  });
});
