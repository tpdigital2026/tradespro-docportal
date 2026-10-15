import { describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('../../src/lib/session', () => ({ requireSession: async () => ({ userId: 'u1', tenantId: '11111111-1111-4111-8111-111111111111', role: 'owner', email: 'o@example.test', fullName: 'O', businessName: 'B' }) }));

import { approveScopeWith, requireApprovedScope } from '../../src/lib/data/scope';
import { getDraftWith, QuoteError, saveDraftWith, storedScopeWith } from '../../src/lib/data/quotes';
import { approvalHash, isApproved, scopeFormSchema, type ScopeFormValues } from '../../src/lib/scope/model';
import { emptyQuoteForm, type QuoteFormValues } from '../../src/lib/validation/quote';
import { fakeClient } from '../fixtures/fake-quotes-client';
import { generatedScope } from '../fixtures/scope';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';
const TODAY = '2026-10-15';
const form = (scope: ScopeFormValues): QuoteFormValues => ({ ...emptyQuoteForm({ date: TODAY, vatApplies: true }), quoteNumber: 'QT-7', customerId: CUSTOMER, price: '10000', scope });

function setup() {
  const fx = fakeClient({ customers: [{ id: CUSTOMER, name: 'A' }] });
  const save = (f: QuoteFormValues, id: string | null, opts?: { trustApproval?: boolean }) => saveDraftWith(fx.client, TENANT, f, id, 2000, TODAY, opts);
  const stored = async (jobId: string) => (await storedScopeWith(fx.client, jobId))!;
  /** The honest flow: save the generated copy, then approve it on the server. */
  const approved = async () => {
    const first = await save(form(generatedScope(TENANT)), null);
    const r = await approveScopeWith({ userId: 'u1', tenantId: TENANT }, form(generatedScope(TENANT)), first.jobId, { save, audit: async () => undefined });
    if (!r.ok) throw new Error(r.message);
    return first.jobId;
  };
  return { ...fx, save, stored, approved };
}

describe('approval is only ever made by the server', () => {
  it('a crafted request with approvedAt "x" and a recomputed hash or key is not believed', async () => {
    const { save, stored } = setup();
    const crafted = generatedScope(TENANT);
    crafted.copy = { ...crafted.copy!, approvedAt: 'x', approvalHash: 'x' };
    crafted.copy.approvalHash = approvalHash(crafted);
    const first = await save(form(crafted), null);
    const s = await stored(first.jobId);
    expect(s.copy?.approvedAt).toBeNull();
    expect(s.copy?.approvalHash).toBeNull();
    expect(isApproved(s)).toBe(false);
    // and again on a later save of the same draft
    await save(form(crafted), first.jobId);
    expect(isApproved(await stored(first.jobId))).toBe(false);
  });

  it('generated wording whose proof does not verify is dropped, however it was made up', async () => {
    const made = generatedScope(TENANT);
    const cases = [{ proof: '' }, { proof: 'f'.repeat(64) }, { engine: 'ai' as const }, { sourceKey: 'k1.1.abc' }, { generatedAt: '2030-01-01T00:00:00.000Z' }];
    for (const bad of cases) {
      const { save, stored } = setup();
      const first = await save(form({ ...made, copy: { ...made.copy!, ...bad } }), null);
      expect((await stored(first.jobId)).copy, JSON.stringify(Object.keys(bad))).toBeNull();
    }
    const { save, stored } = setup();
    const first = await save(form(generatedScope('some-other-business')), null);
    expect((await stored(first.jobId)).copy).toBeNull();
  });

  it('the honest flow works: approve, then ordinary autosaves keep the approval', async () => {
    const { save, stored, approved } = setup();
    const jobId = await approved();
    const s = await stored(jobId);
    expect(isApproved(s)).toBe(true);
    expect(s.copy?.approvalHash).toBe(approvalHash(s));
    await save(form(s), jobId);
    expect(isApproved(await stored(jobId))).toBe(true);
    // the browser sending the approval fields back unchanged is fine, and so is it sending none
    await save(form({ ...s, copy: { ...s.copy!, approvedAt: null, approvalHash: null } }), jobId);
    expect(isApproved(await stored(jobId))).toBe(true);
  });

  it.each([
    ['the wording is changed', (s: ScopeFormValues) => ({ ...s, copy: { ...s.copy!, sections: [{ heading: 'Preparation', steps: ['Strip off the existing roof covering.', 'Take all waste away.', 'Added line.'] }] } })],
    ['one word of the wording is changed', (s: ScopeFormValues) => ({ ...s, copy: { ...s.copy!, sections: [{ heading: 'Preparation', steps: ['Strip off the existing roof covering.', 'Take all waste away!'] }] } })],
    ['a step is changed', (s: ScopeFormValues) => ({ ...s, items: s.items.map((i) => (i.id === 's1' ? { ...i, text: 'strip off the whole roof' } : i)) })],
    ['a step is added', (s: ScopeFormValues) => ({ ...s, items: [...s.items, { id: 'zz', kind: 'step' as const, text: 'one more thing' }] })],
    ['the note is changed', (s: ScopeFormValues) => ({ ...s, note: 'Scaffold is not included.' })],
  ])('the stored approval is cleared when %s', async (_n, change) => {
    const { save, stored, approved } = setup();
    const jobId = await approved();
    const s = await stored(jobId);
    await save(form(change(s)), jobId);
    const after = await stored(jobId);
    expect(after.copy?.approvedAt).toBeNull();
    expect(isApproved(after)).toBe(false);
    // putting it back does not bring the approval back
    await save(form(s), jobId);
    expect(isApproved(await stored(jobId))).toBe(false);
  });
});

describe('finishing needs the real, audited approval of the stored draft', () => {
  const load = (fx: ReturnType<typeof setup>) => (id: string) => storedScopeWith(fx.client, id);

  it('passes for an approval that is stored, matches its content and has its audit row', async () => {
    const fx = setup();
    const jobId = await fx.approved();
    const s = await fx.stored(jobId);
    const audited = vi.fn(async (_t: string, _j: string, h: string) => h === s.copy!.approvalHash);
    await expect(requireApprovedScope(TENANT, jobId, { load: load(fx), audited })).resolves.toBeUndefined();
    expect(audited).toHaveBeenCalledWith(TENANT, jobId, s.copy!.approvalHash);
  });
  it('refuses with no audit row, an unapproved draft, a missing draft, or stored content that no longer matches', async () => {
    const fx = setup();
    const jobId = await fx.approved();
    const refuse = (deps: Parameters<typeof requireApprovedScope>[2]) => requireApprovedScope(TENANT, jobId, deps).then(() => 'ok', (e) => (e instanceof QuoteError ? e.errors?.['scope.approval'] : 'other'));
    expect(await refuse({ load: load(fx), audited: async () => false })).toBeTruthy();
    expect(await refuse({ load: load(fx), audited: async () => { throw new Error('db'); } })).toBeTruthy();
    expect(await refuse({ load: async () => null, audited: async () => true })).toBeTruthy();
    const s = await fx.stored(jobId);
    expect(await refuse({ load: async () => ({ ...s, copy: { ...s.copy!, approvedAt: null, approvalHash: null } }), audited: async () => true })).toBeTruthy();
    // someone edits the stored row directly: the fingerprint no longer matches
    const v = fx.tables.document_versions[0] as { input: { form: { scope: ScopeFormValues } } };
    v.input.form.scope.copy!.sections[0]!.steps[0] = 'Strip off something else.';
    expect(await refuse({ load: load(fx), audited: async () => true })).toBeTruthy();
  });
});

describe('drafts from before the scope builder', () => {
  const legacy = async (notes: string) => {
    const fx = fakeClient({ customers: [{ id: CUSTOMER, name: 'A' }] });
    const j = await fx.client.from('jobs').insert({ tenant_id: TENANT, customer_id: CUSTOMER, reference: 'OLD-1' }).select('id').single();
    const jobId = (j.data as { id: string }).id;
    const d = await fx.client.from('documents').insert({ tenant_id: TENANT, job_id: jobId, type: 'quotation', number: 'OLD-1', doc_date: TODAY }).select('id').single();
    const docId = (d.data as { id: string }).id;
    await fx.client.from('document_versions').insert({ tenant_id: TENANT, document_id: docId, version: 1, input: { schema: 1, form: { ...emptyQuoteForm({ date: TODAY, vatApplies: true }), scope: undefined, scopeNotes: notes, quoteNumber: 'OLD-1', customerId: CUSTOMER } } });
    return getDraftWith(fx.client, jobId);
  };
  it('each non-empty line of the old scope box becomes a step, in order, nothing lost', async () => {
    const d = await legacy('  Strip off the roof  \n\n\nFit new felt\r\nClear the site ');
    expect(d?.values.scope.items.map((i) => [i.kind, i.text])).toEqual([['step', 'Strip off the roof'], ['step', 'Fit new felt'], ['step', 'Clear the site']]);
    expect(d?.values.scope.copy).toBeNull();
  });
  it('long lines are cut at a word, and more than 30 lines are grouped so every limit holds', async () => {
    const long = Array.from({ length: 80 }, () => 'word').join(' ') + ' end';
    const d = await legacy(long);
    const steps = d!.values.scope.items;
    expect(steps.length).toBeGreaterThan(1);
    expect(steps.every((i) => i.text.length <= 300)).toBe(true);
    expect(steps.map((i) => i.text).join(' ')).toBe(long);
    const many = await legacy(Array.from({ length: 70 }, (_, i) => `line ${i}`).join('\n'));
    const items = many!.values.scope.items;
    expect(items.filter((i) => i.kind === 'heading')).toHaveLength(3);
    expect(items.filter((i) => i.kind === 'step').map((i) => i.text)).toEqual(Array.from({ length: 70 }, (_, i) => `line ${i}`));
  });
  it('a 400-line old note loses nothing: every line is recoverable from the steps and the kept overflow', async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `Old line number ${i} about the job`);
    const d = await legacy(lines.join('\n'));
    const scope = d!.values.scope;
    const items = scope.items;
    expect(items.filter((i) => i.kind === 'step').length).toBeLessThanOrEqual(360);
    expect(items.filter((i) => i.kind === 'heading').length).toBeLessThanOrEqual(12);
    const fitsLimits = scopeFormSchema.safeParse(scope);
    expect(fitsLimits.success).toBe(true);
    const everything = `${items.map((i) => i.text).join('\n')}\n${scope.legacyOverflow ?? ''}`;
    for (const l of lines) expect(everything, l).toContain(l);
    // the first autosave keeps all of it as well
    const fx = fakeClient({ customers: [{ id: CUSTOMER, name: 'A' }] });
    const first = await saveDraftWith(fx.client, TENANT, form(scope), null, 2000, TODAY);
    const back = (await storedScopeWith(fx.client, first.jobId))!;
    const kept = `${back.items.map((i) => i.text).join('\n')}\n${back.legacyOverflow ?? ''}`;
    for (const l of lines) expect(kept, l).toContain(l);
  });
  it('text that cannot be packed into the steps is kept untouched in the preserved field, and a save that leaves the field out does not drop it', async () => {
    const big = Array.from({ length: 400 }, (_, i) => `${i} ${'long '.repeat(55)}`.trim());
    expect(big.every((l) => l.length > 250)).toBe(true);
    const d = await legacy(big.join('\n'));
    const scope = d!.values.scope;
    expect(scope.items.filter((i) => i.kind === 'step')).toHaveLength(360);
    expect((scope.legacyOverflow ?? '').split('\n')).toHaveLength(40);
    const all = `${scope.items.map((i) => i.text).join('\n')}\n${scope.legacyOverflow}`;
    for (const l of big) expect(all.replace(/\s+/g, ' '), l.slice(0, 20)).toContain(l.slice(0, 20));
    const fx = fakeClient({ customers: [{ id: CUSTOMER, name: 'A' }] });
    const first = await saveDraftWith(fx.client, TENANT, form(scope), null, 2000, TODAY);
    // the browser sends the scope back without the field (an older screen, a rebuilt object)
    const { legacyOverflow: _gone, ...without } = scope;
    await saveDraftWith(fx.client, TENANT, form(without), first.jobId, 2000, TODAY);
    expect((await storedScopeWith(fx.client, first.jobId))!.legacyOverflow).toBe(scope.legacyOverflow);
    // an explicit empty string is the owner discarding it
    await saveDraftWith(fx.client, TENANT, form({ ...scope, legacyOverflow: '' }), first.jobId, 2000, TODAY);
    expect((await storedScopeWith(fx.client, first.jobId))!.legacyOverflow ?? '').toBe('');
  });
  it('an empty old box, or a draft that already has steps, is left alone', async () => {
    expect((await legacy('   \n '))?.values.scope.items).toEqual([]);
  });
});
