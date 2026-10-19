import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); } }));

import { saveGuaranteeAction } from '../../src/app/(app)/documents/new/guarantee-actions';
import { demoBusinessFacts } from '../../src/lib/demo-business';
import { resetDemoGuarantees } from '../../src/lib/demo-guarantees';
import { getGuaranteeContext, getGuaranteeDraft, GuaranteeError, saveGuarantee, saveGuaranteeWith } from '../../src/lib/data/guarantees';
import { guaranteeRows } from '../../src/lib/business/guarantees';
import { emptyGuarantee, type GuaranteeValues } from '../../src/lib/guarantee/model';
import { demoGuaranteeMarkFinal } from '../../src/lib/demo-guarantees';
import { todayLondon } from '../../src/lib/london';

const today = todayLondon();
const values = (over: Partial<GuaranteeValues> = {}): GuaranteeValues => emptyGuarantee({ roofType: 'tiled', years: '25', address: '5 Sample Road, Anytown', completedOn: '2020-06-01', ...over });

beforeEach(() => {
  vi.stubEnv('DEMO_MODE', '1');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('VERCEL', undefined as unknown as string);
  resetDemoGuarantees();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetDemoGuarantees();
});

async function firstJob() {
  const ctx = await getGuaranteeContext();
  const job = ctx.jobs.find((j) => j.reference === 'DEMO-3002');
  if (!job) throw new Error('no demo job');
  return { ctx, job };
}

describe('guarantee drafts (demo mode)', () => {
  it('offers the jobs with the date of issue as today', async () => {
    const { ctx } = await firstJob();
    expect(ctx.today).toBe(today);
    expect(ctx.jobs.length).toBeGreaterThan(2);
  });

  it('creates a draft numbered after the job, then a second roof gets -G2, and the same roof twice is refused', async () => {
    const { job } = await firstJob();
    const a = await saveGuarantee({ documentId: null, job: { kind: 'existing', id: job.id }, values: values() });
    expect(a.number).toBe('GC-DEMO-3002');
    const b = await saveGuarantee({ documentId: null, job: { kind: 'existing', id: job.id }, values: values({ roofType: 'flat', years: '20' }) });
    expect(b.number).toBe('GC-DEMO-3002-G2');
    const dup = await saveGuarantee({ documentId: null, job: { kind: 'existing', id: job.id }, values: values({ years: '10' }) }).catch((e) => e);
    expect(dup).toBeInstanceOf(GuaranteeError);
    expect((dup as GuaranteeError).code).toBe('exists');
    expect((dup as GuaranteeError).existingId).toBe(a.documentId);
    // Another roof typed in words is its own roof, and the same words again are the same roof.
    await saveGuarantee({ documentId: null, job: { kind: 'existing', id: job.id }, values: values({ roofType: 'other', roofOther: 'Garage roof' }) });
    const dupOther = await saveGuarantee({ documentId: null, job: { kind: 'existing', id: job.id }, values: values({ roofType: 'other', roofOther: 'garage  ROOF.' }) }).catch((e) => e);
    expect((dupOther as GuaranteeError).code).toBe('exists');
  });

  it('autosave updates the draft, and an edit that would clash with another roof is refused', async () => {
    const { job } = await firstJob();
    const a = await saveGuarantee({ documentId: null, job: { kind: 'existing', id: job.id }, values: values() });
    const b = await saveGuarantee({ documentId: null, job: { kind: 'existing', id: job.id }, values: values({ roofType: 'flat', years: '20' }) });
    await saveGuarantee({ documentId: a.documentId, job: null, values: values({ years: '30' }) });
    expect((await getGuaranteeDraft(a.documentId))?.values.years).toBe('30');
    const clash = await saveGuarantee({ documentId: b.documentId, job: null, values: values({ roofType: 'tiled' }) }).catch((e) => e);
    expect((clash as GuaranteeError).code).toBe('exists');
  });

  it('never stores a completion date in the future, a bad number of years or a stray quote number', async () => {
    const { job } = await firstJob();
    const mk = (v: Partial<GuaranteeValues>) => saveGuarantee({ documentId: null, job: { kind: 'existing', id: job.id }, values: values(v) }).catch((e) => e as GuaranteeError);
    expect(((await mk({ completedOn: '2999-01-01' })) as GuaranteeError).field).toBe('completedOn');
    expect(((await mk({ years: '99' })) as GuaranteeError).field).toBe('years');
    expect(((await mk({ linkedQuote: 'NOPE-1' })) as GuaranteeError).field).toBe('linkedQuote');
    expect(((await mk({ roofType: '' })) as GuaranteeError).field).toBe('roofType');
    // An empty box is fine in a draft.
    expect(((await mk({ years: '', completedOn: '' })) as { documentId?: string }).documentId).toBeTruthy();
  });

  it('a linked quote must be one of the business’s quotes, and the job’s own number is', async () => {
    const { job } = await firstJob();
    const r = await saveGuarantee({ documentId: null, job: { kind: 'existing', id: job.id }, values: values({ linkedQuote: job.reference }) });
    expect((await getGuaranteeDraft(r.documentId))?.values.linkedQuote).toBe(job.reference);
  });

  it('can make a new job for a customer, with a number that is not reserved and not used', async () => {
    const ctx = await getGuaranteeContext();
    const c = ctx.customers[0];
    const mk = (reference: string) => saveGuarantee({ documentId: null, job: { kind: 'new', customerId: c.id, reference }, values: values() }).catch((e) => e as GuaranteeError);
    expect(((await mk('GC-5')) as GuaranteeError).code).toBe('invalid');
    expect(((await mk('Q-5-G2')) as GuaranteeError).code).toBe('invalid');
    expect(((await mk('DEMO-3002')) as GuaranteeError).code).toBe('number_used');
    const made = (await mk('NEW-77')) as { number: string };
    expect(made.number).toBe('GC-NEW-77');
  });

  it('a finalised certificate cannot be edited, and shows on the Guarantees list with its years and number', async () => {
    const { job } = await firstJob();
    const a = await saveGuarantee({ documentId: null, job: { kind: 'existing', id: job.id }, values: values() });
    expect(guaranteeRows(demoBusinessFacts().jobs).some((r) => r.certificateNo === a.number)).toBe(false);
    demoGuaranteeMarkFinal(a.documentId, today);
    const err = await saveGuarantee({ documentId: a.documentId, job: null, values: values({ years: '5' }) }).catch((e) => e);
    expect((err as GuaranteeError).code).toBe('locked');
    const row = guaranteeRows(demoBusinessFacts().jobs).find((r) => r.certificateNo === a.number);
    expect(row).toMatchObject({ years: 25, issuedOn: today, expiryYear: Number(today.slice(0, 4)) + 25 });
  });
});

describe('the save action', () => {
  it('turns a thrown rule into a message, and refuses a malformed request', async () => {
    const bad = await saveGuaranteeAction({ nope: true });
    expect(bad.ok).toBe(false);
    const { job } = await firstJob();
    const r = await saveGuaranteeAction({ documentId: null, job: { kind: 'existing', id: job.id }, values: values({ completedOn: '2999-01-01' }) });
    expect(r).toMatchObject({ ok: false, field: 'completedOn' });
    const good = await saveGuaranteeAction({ documentId: null, job: { kind: 'existing', id: job.id }, values: values() });
    expect(good.ok).toBe(true);
  });

  it('limits saves per person', async () => {
    const { job } = await firstJob();
    let blocked = 0;
    for (let i = 0; i < 130; i += 1) {
      const r = await saveGuaranteeAction({ documentId: null, job: { kind: 'existing', id: job.id }, values: values({ roofType: 'other', roofOther: `roof ${i}` }) });
      if (!r.ok && /lot of saving/.test(r.message)) blocked += 1;
    }
    expect(blocked).toBeGreaterThan(0);
  });
});

describe('the real save (a stand-in for the database)', () => {
  it('writes the job lock, the document and its version in one transaction, with an audit row of ids only', async () => {
    const sql: { text: string; params: unknown[] }[] = [];
    const db = {
      query: async (text: string, params: unknown[] = []) => {
        sql.push({ text: text.replace(/\s+/g, ' ').trim(), params });
        if (/select id, reference, customer_id from public\.jobs/.test(text)) return { rows: [{ id: '11111111-1111-4111-8111-111111111111', reference: 'Q-9', customer_id: '22222222-2222-4222-8222-222222222222' }] };
        if (/insert into public\.documents/.test(text)) return { rows: [{ id: '33333333-3333-4333-8333-333333333333' }] };
        if (/insert into public\.document_versions/.test(text)) return { rows: [{ id: '44444444-4444-4444-8444-444444444444' }] };
        return { rows: [] };
      },
    };
    const out = await saveGuaranteeWith(db as never, { tenantId: '55555555-5555-4555-8555-555555555555', userId: '66666666-6666-4666-8666-666666666666' }, { documentId: null, job: { kind: 'existing', id: '11111111-1111-4111-8111-111111111111' }, values: values() }, today);
    expect(out.number).toBe('GC-Q-9');
    const texts = sql.map((s) => s.text);
    expect(texts[0]).toBe('begin');
    expect(texts.at(-1)).toBe('commit');
    expect(texts.findIndex((t) => /from public\.jobs where id = \$1 and tenant_id = \$2 for update/.test(t))).toBeLessThan(texts.findIndex((t) => /insert into public\.documents/.test(t)));
    const doc = sql.find((s) => /insert into public\.documents/.test(s.text))!;
    expect(doc.params).toContain(today);
    const ver = sql.find((s) => /insert into public\.document_versions/.test(s.text))!;
    expect(JSON.parse(String(ver.params[2])).guarantee.roofKey).toBe('tiled');
    const audit = sql.find((s) => /audit_log/.test(s.text))!;
    expect(audit.params[3]).toBe('guarantee.create');
    expect(JSON.stringify(audit.params)).not.toContain('Sample Road');
  });

  it('rolls everything back when the roof clashes', async () => {
    const sql: string[] = [];
    const db = {
      query: async (text: string) => {
        sql.push(text.replace(/\s+/g, ' ').trim());
        if (/select id, reference, customer_id from public\.jobs/.test(text)) return { rows: [{ id: '11111111-1111-4111-8111-111111111111', reference: 'Q-9', customer_id: '22222222-2222-4222-8222-222222222222' }] };
        if (/v\.input -> 'guarantee' ->> 'roofKey'/.test(text)) return { rows: [{ id: '77777777-7777-4777-8777-777777777777', number: 'GC-Q-9' }] };
        return { rows: [] };
      },
    };
    const err = await saveGuaranteeWith(db as never, { tenantId: '55555555-5555-4555-8555-555555555555', userId: '66666666-6666-4666-8666-666666666666' }, { documentId: null, job: { kind: 'existing', id: '11111111-1111-4111-8111-111111111111' }, values: values() }, today).catch((e) => e);
    expect((err as GuaranteeError).code).toBe('exists');
    expect(sql.at(-1)).toBe('rollback');
    expect(sql.some((s) => /insert into public\.documents/.test(s))).toBe(false);
  });
});
