import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('../../src/lib/session', () => ({ requireSession: async () => ({ userId: 'u1', tenantId: 't1', role: 'owner', email: 'o@example.test', fullName: 'O', businessName: 'B' }) }));

import { scopeCopyLimiter } from '../../src/ai/limits';
import { approveScopeWith, generateForOwner, LIMIT_MESSAGE } from '../../src/lib/data/scope';
import { QuoteError, type SavedDraft } from '../../src/lib/data/quotes';
import { scopeKey } from '../../src/lib/scope/model';
import { assertNoPersonalData } from '../../src/security/audit';
import { emptyQuoteForm } from '../../src/lib/validation/quote';
import { approvedScope, generatedScope, STEPS } from '../fixtures/scope';
import { approvalHash } from '../../src/lib/scope/model';

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
  it('only real AI calls count: the basic tidy is never limited, and over ten AI calls a person gets the basic tidy and is told', async () => {
    const fallback = (u: string) => generateForOwner({ userId: u, tenantId: 't1' }, STEPS, '', { client: null, label: async () => '', recordRun: noRun });
    for (let i = 0; i < 25; i++) expect((await fallback('gen-free')).ok).toBe(true);
    const client = { complete: async () => ({ text: JSON.stringify({ sections: [{ heading: 'Preparation', steps: ['Strip off the existing roof covering.', 'Take all waste away.'] }], corrections: [], uncertain: [] }) }) };
    const ai = (u: string) => generateForOwner({ userId: u, tenantId: 't1' }, STEPS, '', { client, model: 'm', label: async () => '', recordRun: noRun });
    const results = [];
    for (let i = 0; i < 11; i++) results.push(await ai('gen-limit'));
    expect(results.slice(0, 10).map((r) => r.ok && r.copy.engine)).toEqual(Array(10).fill('ai'));
    const last = results[10]!;
    expect(last.ok && last.copy.engine).toBe('fallback');
    expect(last.ok && last.notice).toBe(LIMIT_MESSAGE);
    const other = await ai('gen-other');
    expect(other.ok && other.copy.engine).toBe('ai');
    expect(scopeCopyLimiter.take('gen-other')).toBe(true);
  });
  it('hands out wording with a server proof, and no approval', async () => {
    const r = await generateForOwner({ userId: 'gen-p', tenantId: 't1' }, STEPS, '', { client: null, label: async () => '', recordRun: noRun });
    if (!r.ok) throw new Error('expected ok');
    expect(r.copy.proof).toMatch(/^[0-9a-f]{64}$/);
    expect(r.copy.approvalHash).toBeNull();
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
  const form = (over = {}) => ({ ...emptyQuoteForm({ date: '2026-10-15', vatApplies: true }), quoteNumber: 'QT-1', customerId: 'c', scope: generatedScope('t1'), ...over });

  it('sets the time and the fingerprint itself, saves with the approval, and audits ids, counts and the fingerprint only', async () => {
    const saves: unknown[] = [];
    const audits: unknown[] = [];
    const f = form();
    const r = await approveScopeWith({ userId: 'u1', tenantId: 't1' }, f, JOB, {
      now: () => new Date('2026-10-15T10:30:00Z'),
      save: async (x, id, opts) => { saves.push([x.scope.copy?.approvedAt, x.scope.copy?.approvalHash, id, opts]); return saved; },
      audit: async (_db, e) => { audits.push(e); },
    });
    const hash = approvalHash(f.scope);
    expect(r).toMatchObject({ ok: true, approvedAt: '2026-10-15T10:30:00.000Z', approvalHash: hash });
    expect(saves).toEqual([['2026-10-15T10:30:00.000Z', hash, JOB, { trustApproval: true }]]);
    expect(audits).toEqual([
      { tenantId: 't1', userId: 'u1', action: 'scope.approve', entity: 'job', entityId: JOB.replace(/-/g, ''), meta: { engine: 'fallback', sections: 1, steps: 2, hash } },
    ]);
    expect(() => assertNoPersonalData((audits[0] as { meta: unknown }).meta)).not.toThrow();
  });
  it('ignores any approval time or fingerprint sent by the browser', async () => {
    const f = form();
    f.scope.copy!.approvedAt = '1999-01-01T00:00:00.000Z';
    f.scope.copy!.approvalHash = 'hforged';
    let seen: [string | null, string | null] = [null, null];
    await approveScopeWith({ userId: 'u1', tenantId: 't1' }, f, JOB, { now: () => new Date('2026-10-15T10:30:00Z'), save: async (x) => { seen = [x.scope.copy!.approvedAt, x.scope.copy!.approvalHash]; return saved; }, audit: async () => undefined });
    expect(seen[0]).toBe('2026-10-15T10:30:00.000Z');
    expect(seen[1]).toBe(approvalHash(f.scope));
  });
  it('refuses copy with a forged or foreign proof (a crafted request that recomputes the source key)', async () => {
    const save = vi.fn();
    const forged = form();
    forged.scope.copy!.proof = 'f'.repeat(64);
    expect(await approveScopeWith({ userId: 'u1', tenantId: 't1' }, forged, JOB, { save, audit: async () => undefined })).toMatchObject({ ok: false, code: 'invalid' });
    const foreign = form({ scope: generatedScope('another-business') });
    expect(await approveScopeWith({ userId: 'u1', tenantId: 't1' }, foreign, JOB, { save, audit: async () => undefined })).toMatchObject({ ok: false, code: 'invalid' });
    const lying = form();
    lying.scope.copy!.engine = 'ai';
    expect(await approveScopeWith({ userId: 'u1', tenantId: 't1' }, lying, JOB, { save, audit: async () => undefined })).toMatchObject({ ok: false, code: 'invalid' });
    expect(save).not.toHaveBeenCalled();
  });
  it.each([
    ['no copy', () => form({ scope: approvedScope({ copy: null }) }), 'invalid'],
    ['steps changed since the copy was made', () => {
      const g = generatedScope('t1');
      return form({ scope: { ...g, items: [...g.items, { id: 'z', kind: 'step' as const, text: 'Another' }] } });
    }, 'stale'],
    ['nothing to read', () => {
      const g = generatedScope('t1');
      return form({ scope: { ...g, copy: { ...g.copy!, sections: [{ heading: 'H', steps: [' '] }] } } });
    }, 'invalid'],
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
