import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('../../src/lib/session', () => ({ requireSession: async () => ({ userId: 'u1', tenantId: 't1', role: 'owner', email: 'o@example.test', fullName: 'O', businessName: 'B' }) }));

import { scopeCopyLimiter } from '../../src/ai/limits';
import { approveScopeWith, generateForOwner, LIMIT_MESSAGE } from '../../src/lib/data/scope';
import { QuoteError, type SavedDraft } from '../../src/lib/data/quotes';
import { scopeKey } from '../../src/lib/scope/model';
import { assertNoPersonalData } from '../../src/security/audit';
import { emptyQuoteForm } from '../../src/lib/validation/quote';
import { approvedScope, STEPS } from '../fixtures/scope';

const JOB = '3f2c1b7e-5c1a-4a8e-9a55-0d6c3e9d1a11';
const saved: SavedDraft = { jobId: JOB, documentId: 'd', savedAt: '2026-10-15T09:00:00.000Z', quoteNumber: 'QT-1', customerId: 'c' };
const noRun = async () => undefined;

afterEach(() => vi.restoreAllMocks());

describe('generateForOwner', () => {
  it('returns unapproved copy tied to exactly these steps, labelled with its engine', async () => {
    const r = await generateForOwner({ userId: 'gen-1', tenantId: 't1' }, STEPS, 'jt', { client: null, label: async () => 'Flat roof', recordRun: noRun, now: () => new Date('2026-10-15T09:00:00Z') });
    if (!r.ok) throw new Error('expected ok');
    expect(r.copy.engine).toBe('fallback');
    expect(r.copy.approvedAt).toBeNull();
    expect(r.copy.sourceKey).toBe(scopeKey(STEPS));
    expect(r.copy.generatedAt).toBe('2026-10-15T09:00:00.000Z');
    expect(r.promptVersion).toBe('scope-copy.v1');
  });
  it('says so when there are no steps', async () => {
    const r = await generateForOwner({ userId: 'gen-2', tenantId: 't1' }, [{ id: 'a', kind: 'heading', text: 'Only a heading' }], '', { client: null, recordRun: noRun });
    expect(r).toMatchObject({ ok: false, code: 'empty' });
  });
  it('limits each person to ten in ten minutes, and other people are unaffected', async () => {
    const run = (u: string) => generateForOwner({ userId: u, tenantId: 't1' }, STEPS, '', { client: null, label: async () => '', recordRun: noRun });
    const results = [];
    for (let i = 0; i < 11; i++) results.push(await run('gen-limit'));
    expect(results.slice(0, 10).every((r) => r.ok)).toBe(true);
    expect(results[10]).toEqual({ ok: false, code: 'limit', message: LIMIT_MESSAGE });
    expect((await run('gen-other')).ok).toBe(true);
    expect(scopeCopyLimiter.take('gen-other')).toBe(true);
  });
  it('records the model call (not the wording) when a model was used, and survives the record failing', async () => {
    const seen: unknown[] = [];
    const client = { complete: async () => ({ text: JSON.stringify({ sections: [{ heading: 'The works', steps: ['Strip off the roof.'] }], corrections: [], uncertain: [] }), inputTokens: 5, outputTokens: 6 }) };
    const r = await generateForOwner({ userId: 'gen-3', tenantId: 't1' }, [{ id: 'a', kind: 'step', text: 'strip off the roof' }], '', {
      client,
      model: 'm-1',
      label: async () => '',
      recordRun: async (x) => { seen.push(x.usage); },
    });
    expect(r.ok && r.copy.engine).toBe('ai');
    expect(seen).toEqual([{ model: 'm-1', inputTokens: 5, outputTokens: 6, valid: true }]);
    const r2 = await generateForOwner({ userId: 'gen-4', tenantId: 't1' }, STEPS, '', { client: null, label: async () => '', recordRun: async () => { throw new Error('db down'); } });
    expect(r2.ok).toBe(true);
  });
});

describe('approveScopeWith', () => {
  const form = (over = {}) => ({ ...emptyQuoteForm({ date: '2026-10-15', vatApplies: true }), quoteNumber: 'QT-1', customerId: 'c', scope: approvedScope({ copy: { ...approvedScope().copy!, approvedAt: null } }), ...over });

  it('sets the time itself, saves the draft with the approval, and audits ids and counts only', async () => {
    const saves: unknown[] = [];
    const audits: unknown[] = [];
    const r = await approveScopeWith({ userId: 'u1', tenantId: 't1' }, form(), JOB, {
      now: () => new Date('2026-10-15T10:30:00Z'),
      save: async (f, id) => { saves.push([f.scope.copy?.approvedAt, id]); return saved; },
      audit: async (_db, e) => { audits.push(e); },
    });
    expect(r).toMatchObject({ ok: true, approvedAt: '2026-10-15T10:30:00.000Z' });
    expect(saves).toEqual([['2026-10-15T10:30:00.000Z', JOB]]);
    expect(audits).toEqual([
      { tenantId: 't1', userId: 'u1', action: 'scope.approve', entity: 'job', entityId: JOB.replace(/-/g, ''), meta: { engine: 'fallback', sections: 1, steps: 2 } },
    ]);
    expect(() => assertNoPersonalData((audits[0] as { meta: unknown }).meta)).not.toThrow();
  });
  it('ignores an approval time sent by the browser', async () => {
    const f = form();
    f.scope.copy!.approvedAt = '1999-01-01T00:00:00.000Z';
    let at = '';
    await approveScopeWith({ userId: 'u1', tenantId: 't1' }, f, JOB, { now: () => new Date('2026-10-15T10:30:00Z'), save: async (x) => { at = x.scope.copy!.approvedAt!; return saved; }, audit: async () => undefined });
    expect(at).toBe('2026-10-15T10:30:00.000Z');
  });
  it.each([
    ['no copy', () => form({ scope: approvedScope({ copy: null }) }), 'invalid'],
    ['steps changed since the copy was made', () => form({ scope: approvedScope({ items: [...STEPS, { id: 'z', kind: 'step', text: 'Another' }], copy: { ...approvedScope().copy!, approvedAt: null } }) }), 'stale'],
    ['nothing to read', () => form({ scope: approvedScope({ copy: { ...approvedScope().copy!, sections: [{ heading: 'H', steps: [' '] }] } }) }), 'invalid'],
    ['no steps', () => form({ scope: approvedScope({ items: [] }) }), 'invalid'],
  ])('refuses: %s', async (_n, make, code) => {
    const save = vi.fn();
    const r = await approveScopeWith({ userId: 'u1', tenantId: 't1' }, make(), JOB, { save, audit: async () => undefined });
    expect(r).toMatchObject({ ok: false, code });
    expect(save).not.toHaveBeenCalled();
  });
  it('passes on a refusal to save (for example an unused customer)', async () => {
    const r = await approveScopeWith({ userId: 'u1', tenantId: 't1' }, form(), null, { save: async () => { throw new QuoteError('invalid', 'Choose who this quote is for'); }, audit: async () => undefined });
    expect(r).toEqual({ ok: false, code: 'save', message: 'Choose who this quote is for' });
  });
  it('no audit record, no approval: the draft is put back to unapproved', async () => {
    const saves: (string | null)[] = [];
    const r = await approveScopeWith({ userId: 'u1', tenantId: 't1' }, form(), JOB, {
      save: async (f) => { saves.push(f.scope.copy!.approvedAt); return saved; },
      audit: async () => { throw new Error('audit down'); },
    });
    expect(r).toMatchObject({ ok: false, code: 'failed' });
    expect(saves[0]).not.toBeNull();
    expect(saves[1]).toBeNull();
  });
});
