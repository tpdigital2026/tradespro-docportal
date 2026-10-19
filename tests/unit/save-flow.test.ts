import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The owner's live bug (19 October): on the Review step "Save quote" did nothing visible. The draft is a flat roof quote,
 * deposit 30 percent, no bank account, and its wording was approved at 09:49 on 15 October under the first approval
 * fingerprint (before the cover and introduction were covered). These tests run the real server path (the quote data
 * layer on an in-memory stand-in for the database, the real approval and audit checks on an in-memory audit trail).
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '22222222-2222-4222-8222-222222222222';

const h = vi.hoisted(() => ({
  client: null as unknown,
  audit: [] as { tenant_id: string; user_id: string; action: string; entity: string; entity_id: string; meta: Record<string, unknown> }[],
  auditDown: false,
  session: { userId: '33333333-3333-4333-8333-333333333333', tenantId: '11111111-1111-4111-8111-111111111111' },
  redirected: [] as string[],
}));

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    h.redirected.push(to);
    throw new Error('NEXT_REDIRECT');
  },
}));
vi.mock('../../src/lib/session', () => ({ requireSession: async () => ({ ...h.session, role: 'owner', email: 'o@example.test', fullName: 'O', businessName: 'B' }) }));
vi.mock('../../src/lib/data/customers', async (orig) => ({ ...(await orig<object>()), ownerClient: async () => h.client }));
vi.mock('../../src/lib/data/customer-admin', async (orig) => ({
  ...(await orig<object>()),
  withServiceConnection: async <T,>(fn: (db: unknown) => Promise<T>) => {
    if (h.auditDown) throw new Error('connect ETIMEDOUT');
    const db = {
      query: async (sql: string, p: unknown[]) => {
        if (/^\s*insert into public\.audit_log/i.test(sql)) {
          h.audit.push({ tenant_id: p[0] as string, user_id: p[1] as string, action: p[3] as string, entity: p[4] as string, entity_id: p[5] as string, meta: JSON.parse(p[8] as string) });
          return { rows: [] };
        }
        const rows = h.audit.filter((r) => r.tenant_id === p[0] && r.action === 'scope.approve' && r.entity === 'job' && r.entity_id === p[1] && r.meta.hash === p[2]).reverse();
        if (/select user_id from public\.audit_log/.test(sql)) return { rows: rows.slice(0, 1).map((r) => ({ user_id: r.user_id })) };
        if (/select 1 from public\.audit_log/.test(sql)) return { rows: rows.slice(0, 1).map(() => ({ '?column?': 1 })) };
        throw new Error(`unexpected query ${sql}`);
      },
      end: async () => undefined,
    };
    return fn(db);
  },
}));

import { finishQuoteAction, saveForLaterAction } from '../../src/app/(app)/documents/new/actions';
import { approveScopeWith, checkApprovedScope, upgradeLegacyApproval } from '../../src/lib/data/scope';
import { saveDraftWith, storedScopeWith } from '../../src/lib/data/quotes';
import { sanitiseIncomingScope } from '../../src/lib/scope/approval';
import { APPROVAL_OUT_OF_DATE, approvalHash, approvalHashV1, approvalState, isApproved, type ScopeFormValues } from '../../src/lib/scope/model';
import { COPY_TOO_OLD } from '../../src/lib/scope/model';
import { emptyQuoteForm, normaliseQuote, type QuoteFormValues } from '../../src/lib/validation/quote';
import { fakeClient } from '../fixtures/fake-quotes-client';
import { generatedScope } from '../fixtures/scope';

const APPROVED_AT = '2026-10-15T08:49:00.000Z'; // 09:49 in London

/** John Smith's flat roof quote as it is stored: deposit 30 percent, no bank account. */
const ownerForm = (scope: ScopeFormValues): QuoteFormValues => ({
  ...emptyQuoteForm({ date: '2026-10-15', vatApplies: true, depositPctBp: 3000 }),
  quoteNumber: 'QT-1015',
  customerId: CUSTOMER,
  propertyAddress: '1 Example Road',
  price: '6200',
  bankAccountId: '',
  scope,
});

type Fx = ReturnType<typeof fakeClient>;
let fx: Fx;

/** Store the draft, then put an approval on it exactly as an older version of the app would have written it. */
async function storeDraft(approval: 'v1' | 'v0' | 'v2' | 'none', generatedAt = '2026-10-15T08:40:00.000Z'): Promise<{ jobId: string; form: QuoteFormValues }> {
  const over = { coverTitle: 'Flat roof quotation', intro: 'Thank you for asking us to quote.' };
  const first = await saveDraftWith(fx.client, TENANT, ownerForm(generatedScope(TENANT, over)), null, 2000, '2026-10-15');
  const v = fx.tables.document_versions[0] as { input: { form: QuoteFormValues } };
  // The wording as it was saved back then (its proof was a day old or less at the time).
  v.input.form.scope = generatedScope(TENANT, over, generatedAt);
  const s = v.input.form.scope;
  if (approval === 'v1') s.copy = { ...s.copy!, approvedAt: APPROVED_AT, approvalHash: approvalHashV1(s) };
  if (approval === 'v0') s.copy = { ...s.copy!, approvedAt: APPROVED_AT, approvalHash: null };
  if (approval === 'v2') s.copy = { ...s.copy!, approvedAt: APPROVED_AT, approvalHash: approvalHash(s) };
  return { jobId: first.jobId, form: structuredClone(v.input.form) };
}

/** The audit row the approval wrote at the time (the first fingerprint went into meta.hash). */
function audited(jobId: string, hash: string, userId = OWNER) {
  h.audit.push({ tenant_id: TENANT, user_id: userId, action: 'scope.approve', entity: 'job', entity_id: jobId.replace(/-/g, ''), meta: { engine: 'fallback', sections: 1, steps: 2, hash } });
}

beforeEach(() => {
  fx = fakeClient({ customers: [{ id: CUSTOMER, name: 'John Smith' }] });
  h.client = fx.client;
  h.audit = [];
  h.auditDown = false;
  h.redirected = [];
  h.session = { userId: OWNER, tenantId: TENANT };
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe("the owner's draft, before the fix", () => {
  it('reproduces it: the screen blocks on the approval, and the server would refuse it too', async () => {
    const { jobId, form } = await storeDraft('v1');
    audited(jobId, approvalHashV1(form.scope));
    // The screen's own check (it worked out today's fingerprint): the approval did not count, so the old button was
    // disabled with the reason in a box at the top of the page, out of sight on a phone and beside a grey button.
    expect(isApproved(form.scope)).toBe(false);
    expect(approvalState(form.scope)).toBe('legacy');
    expect(normaliseQuote(form, 'final', 2000).errors['scope.approval']).toBe(APPROVAL_OUT_OF_DATE);
    // The server's check of the stored draft, without the upgrade: refused as out of date.
    expect(await checkApprovedScope(TENANT, jobId)).toEqual({ ok: false, problem: 'out_of_date' });
  });
});

describe('Preview the document (finishQuoteAction)', () => {
  it('upgrades an approval made under the first fingerprint when the same person approved exactly this content, then goes to the preview', async () => {
    const { jobId, form } = await storeDraft('v1');
    const oldHash = approvalHashV1(form.scope);
    audited(jobId, oldHash);
    const r = await finishQuoteAction(form, jobId);
    expect(r).toMatchObject({ ok: true, jobId, quoteNumber: 'QT-1015' });
    if (!r.ok) throw new Error(r.message);
    expect(r.href).toBe(`/documents/${r.documentId}/preview`);
    const stored = (await storedScopeWith(fx.client, jobId))!;
    expect(isApproved(stored)).toBe(true);
    expect(stored.copy!.approvedAt).toBe(APPROVED_AT);
    expect(stored.copy!.approvalHash).toBe(approvalHash(stored));
    const row = h.audit.at(-1)!;
    expect(row).toMatchObject({ user_id: OWNER, action: 'scope.approve', meta: { hash: approvalHash(stored), upgradedFrom: oldHash } });
    expect(h.redirected).toEqual([]);
  });

  it.each([
    ['someone else approved it', (jobId: string, form: QuoteFormValues) => audited(jobId, approvalHashV1(form.scope), OTHER)],
    ['there is no audit row for it', () => undefined],
    ['the audit row is for different content', (jobId: string) => audited(jobId, 'h' + 'a'.repeat(64))],
  ])('asks for the wording to be approved again when %s, with a button to the Scope check', async (_n, seed) => {
    const { jobId, form } = await storeDraft('v1');
    seed(jobId, form);
    const r = await finishQuoteAction(form, jobId);
    expect(r).toMatchObject({ ok: false, saved: true, message: APPROVAL_OUT_OF_DATE, diag: 'QF-SCOPE-OUT-OF-DATE', fix: { step: 'scope', scopeView: 'review' } });
    expect(isApproved((await storedScopeWith(fx.client, jobId))!)).toBe(false);
    expect(h.audit.some((a) => a.meta.upgradedFrom)).toBe(false);
  });

  it('an approval from before fingerprints existed (a time and nothing else) is never upgraded', async () => {
    const { jobId, form } = await storeDraft('v0');
    expect(await finishQuoteAction(form, jobId)).toMatchObject({ ok: false, message: APPROVAL_OUT_OF_DATE, fix: { step: 'scope', scopeView: 'review' } });
  });

  it('an old approval does not survive a change to the cover or introduction (the first fingerprint never covered them)', async () => {
    const { jobId, form } = await storeDraft('v1');
    audited(jobId, approvalHashV1(form.scope));
    const changed = { ...form, scope: { ...form.scope, coverTitle: 'A different title' } };
    const r = await finishQuoteAction(changed, jobId);
    expect(r).toMatchObject({ ok: false, message: APPROVAL_OUT_OF_DATE, fix: { step: 'scope', scopeView: 'review' } });
    expect(approvalState((await storedScopeWith(fx.client, jobId))!)).toBe('none');
    expect(h.audit.some((a) => a.meta.upgradedFrom)).toBe(false);
  });

  it('today\'s approval with no audit row behind it is refused out loud (no record), not silently', async () => {
    const { jobId, form } = await storeDraft('v2');
    const r = await finishQuoteAction(form, jobId);
    expect(r).toMatchObject({ ok: false, saved: true, diag: 'QF-SCOPE-NO-RECORD', fix: { step: 'scope', scopeView: 'review' } });
    expect(r.ok ? '' : r.message).toMatch(/no record of the wording being approved/);
  });

  it('when the audit trail cannot be reached, it says to try again and does not blame the wording', async () => {
    const { jobId, form } = await storeDraft('v2');
    audited(jobId, approvalHash(form.scope));
    h.auditDown = true;
    const r = await finishQuoteAction(form, jobId);
    expect(r).toMatchObject({ ok: false, code: 'failed', saved: true, diag: 'QF-SCOPE-CHECK-FAILED' });
    expect(r.ok ? null : r.fix).toBeUndefined();
  });

  it('passes with today\'s approval and its audit row, with no bank account (quotes do not need one)', async () => {
    const { jobId, form } = await storeDraft('v2');
    audited(jobId, approvalHash(form.scope));
    expect(form.bankAccountId).toBe('');
    expect(await finishQuoteAction(form, jobId)).toMatchObject({ ok: true });
  });

  it('a missing price is named, with a button to the Price step, and the draft is still saved', async () => {
    const { jobId, form } = await storeDraft('v2');
    audited(jobId, approvalHash(form.scope));
    const r = await finishQuoteAction({ ...form, price: '' }, jobId);
    expect(r).toMatchObject({ ok: false, saved: true, diag: 'QF-CHECK', fix: { step: 'price' } });
  });

  it('a save that fails says nothing was saved, and why', async () => {
    const { jobId, form } = await storeDraft('v2');
    fx = fakeClient({ customers: [{ id: CUSTOMER, name: 'John Smith' }] }, { failOn: (t) => t === 'jobs' });
    h.client = fx.client;
    const r = await finishQuoteAction(form, jobId);
    expect(r).toMatchObject({ ok: false, saved: false, diag: 'QF-SAVE' });
    expect(r.ok ? '' : r.message).toMatch(/^Nothing was saved because/);
  });

  it('a form that cannot be read is reported, never thrown', async () => {
    expect(await finishQuoteAction({ nonsense: true }, null)).toMatchObject({ ok: false, saved: false, diag: 'QF-FORM' });
  });

  it('logs only a code and the job id, never any of the quote', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { jobId, form } = await storeDraft('v1');
    await finishQuoteAction(form, jobId);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toContain(`[quote-finish] code=QF-SCOPE-OUT-OF-DATE job=${jobId.replace(/-/g, '')}`);
    for (const l of lines) expect(l).not.toMatch(/John|Smith|Example Road|roof|6200/i);
  });
});

describe('Save and come back later', () => {
  it('saves without the strict check and returns Home with the quote named', async () => {
    const { jobId, form } = await storeDraft('none');
    const r = await saveForLaterAction({ ...form, price: '' }, jobId);
    expect(r).toMatchObject({ ok: true, href: '/?quote=QT-1015' });
  });
});

describe('legacy approvals in the data layer', () => {
  it('an ordinary autosave keeps an old approval (so it can still be checked) while its content is unchanged', async () => {
    const { jobId, form } = await storeDraft('v1');
    await saveDraftWith(fx.client, TENANT, form, jobId, 2000, '2026-10-19');
    expect(approvalState((await storedScopeWith(fx.client, jobId))!)).toBe('legacy');
    // a change to a step drops it
    const edited = { ...form, scope: { ...form.scope, items: [...form.scope.items, { id: 'x9', kind: 'step' as const, text: 'one more step' }] } };
    await saveDraftWith(fx.client, TENANT, edited, jobId, 2000, '2026-10-19');
    expect(approvalState((await storedScopeWith(fx.client, jobId))!)).not.toBe('legacy');
  });

  it('sanitise never takes the browser\'s word for an old approval', () => {
    const s = generatedScope(TENANT);
    const forged = { ...s, copy: { ...s.copy!, approvedAt: APPROVED_AT, approvalHash: approvalHashV1(s) } };
    const kept = sanitiseIncomingScope(forged, s, () => true);
    expect(kept.copy?.approvedAt).toBeNull();
  });

  it('upgradeLegacyApproval reports each case', async () => {
    const legacy = await storeDraft('v1');
    expect(await upgradeLegacyApproval({ userId: OWNER, tenantId: TENANT }, legacy.jobId)).toBe('needs_approval');
    audited(legacy.jobId, approvalHashV1(legacy.form.scope));
    expect(await upgradeLegacyApproval({ userId: OTHER, tenantId: TENANT }, legacy.jobId)).toBe('needs_approval');
    expect(await upgradeLegacyApproval({ userId: OWNER, tenantId: TENANT }, legacy.jobId)).toBe('upgraded');
    expect(await upgradeLegacyApproval({ userId: OWNER, tenantId: TENANT }, legacy.jobId)).toBe('current');
    fx = fakeClient({ customers: [{ id: CUSTOMER, name: 'John Smith' }] });
    h.client = fx.client;
    const none = await storeDraft('none');
    expect(await upgradeLegacyApproval({ userId: OWNER, tenantId: TENANT }, none.jobId)).toBe('not_approved');
  });

  it('when writing the upgrade record fails, nothing is upgraded', async () => {
    const { jobId, form } = await storeDraft('v1');
    const r = await upgradeLegacyApproval({ userId: OWNER, tenantId: TENANT }, jobId, {
      approverOf: async () => OWNER,
      audit: async () => {
        throw new Error('db');
      },
    });
    expect(r).toBe('failed');
    expect(approvalState((await storedScopeWith(fx.client, jobId))!)).toBe('legacy');
    expect(form).toBeTruthy();
  });
});

describe('approving the wording again', () => {
  it('wording already saved with this draft can be approved after its proof\'s day, so an out-of-date approval can be put right without new wording', async () => {
    const { jobId, form } = await storeDraft('v1', '2026-10-15T08:40:00.000Z');
    const save = (f: QuoteFormValues, id: string | null, opts?: { trustApproval?: boolean }) => saveDraftWith(fx.client, TENANT, f, id, 2000, '2026-10-19', opts);
    const r = await approveScopeWith({ userId: OWNER, tenantId: TENANT }, form, jobId, { save, audit: async () => undefined, loadStored: (id) => storedScopeWith(fx.client, id) });
    expect(r).toMatchObject({ ok: true });
    expect(isApproved((await storedScopeWith(fx.client, jobId))!)).toBe(true);
  });

  it('old wording that is not the draft\'s own stored wording still needs generating again', async () => {
    const { jobId } = await storeDraft('none', new Date().toISOString());
    const old = ownerForm(generatedScope(TENANT, {}, '2026-10-15T08:40:00.000Z'));
    const r = await approveScopeWith({ userId: OWNER, tenantId: TENANT }, old, jobId, { save: async () => { throw new Error('should not save'); }, audit: async () => undefined, loadStored: (id) => storedScopeWith(fx.client, id) });
    expect(r).toEqual({ ok: false, code: 'invalid', message: COPY_TOO_OLD });
  });
});
