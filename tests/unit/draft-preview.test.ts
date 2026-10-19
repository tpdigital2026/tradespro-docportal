import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ preview: vi.fn(), userId: 'u-preview-1' }));

vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('../../src/lib/session', () => ({ requireSession: async () => ({ userId: h.userId, tenantId: '11111111-1111-4111-8111-111111111111', role: 'owner', email: 'o@example.test', fullName: 'O', businessName: 'B' }) }));
vi.mock('../../src/lib/data/documents', () => ({ getPreview: (id: string) => h.preview(id) }));

import { previewDraftPageAction } from '../../src/app/(app)/documents/new/preview-actions';
import { missingFacts, pageImageUrl } from '../../src/lib/documents/draft-preview';

const DOC = '5b1f8a52-8f6e-4c1b-9a77-1f0c4c2d9e10';

beforeEach(() => {
  h.preview.mockReset();
  h.userId = `u-${Math.random()}`;
});

describe('previewDraftPageAction', () => {
  it('gives page 1 of the real document, private and tied to its content key', async () => {
    h.preview.mockResolvedValue({ state: 'ready', versionId: 'v', key: 'a'.repeat(32), pageCount: 3, confirmation: {} });
    const r = await previewDraftPageAction(DOC);
    expect(r).toEqual({ state: 'ready', documentId: DOC, key: 'a'.repeat(32), pageCount: 3, imageUrl: `/api/documents/${DOC}/pages/1?key=${'a'.repeat(32)}`, previewHref: `/documents/${DOC}/preview` });
    expect(h.preview).toHaveBeenCalledWith(DOC);
  });

  it('turns what the document is missing into a checklist with a place to fix each (never Settings for what TradesPro sets up)', async () => {
    h.preview.mockResolvedValue({ state: 'missing', missing: ['The scope wording has not been approved. Open the quote, check the wording and approve it.', 'Your quotation terms are not set up yet. Contact TradesPro Digital.'] });
    const r = await previewDraftPageAction(DOC);
    expect(r).toMatchObject({ state: 'missing', missing: [{ fix: { kind: 'step', step: 'scope' } }, { fix: null }] });
  });

  it('another business\'s document, or a junk id, is simply not there', async () => {
    h.preview.mockResolvedValue(null);
    expect(await previewDraftPageAction(DOC)).toMatchObject({ state: 'error', diag: 'PV-NOT-FOUND' });
    expect(await previewDraftPageAction('../../etc')).toMatchObject({ state: 'error', diag: 'PV-ID' });
    expect(h.preview).toHaveBeenCalledTimes(1);
  });

  it('a render failure is an honest error with a code, logged without any of the document', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.preview.mockRejectedValue(new Error('Mr John Smith at 1 Example Road'));
    const r = await previewDraftPageAction(DOC);
    expect(r).toMatchObject({ state: 'error', diag: 'PV-RENDER' });
    expect(err.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(/John|Example Road/);
  });

  it('a person asking very often is told it will catch up, and the renderer is not called', async () => {
    h.preview.mockResolvedValue({ state: 'ready', versionId: 'v', key: 'b'.repeat(32), pageCount: 1, confirmation: {} });
    for (let i = 0; i < 20; i++) await previewDraftPageAction(DOC);
    expect(await previewDraftPageAction(DOC)).toMatchObject({ state: 'busy', diag: 'PV-LIMIT' });
    expect(h.preview).toHaveBeenCalledTimes(20);
  });
});

describe('missingFacts', () => {
  it('links each known gap to its step, and leaves unknown lines unlinked', () => {
    const r = missingFacts([
      'The quote has no payment plan. Choose one on the plan step.',
      'The quote has no price, or the amounts are too large to work out.',
      'The customer has no name.',
      'The quote has no property address.',
      'No bank account is set up yet, so the customer would not know how to pay. The owner can add one in Settings.',
      'Something new.',
    ]);
    expect(r.map((m) => (m.fix?.kind === 'step' ? m.fix.step : m.fix?.kind === 'link' ? m.fix.href : null))).toEqual(['plan', 'price', 'customer', 'job', '/settings', null]);
  });
  it('a missing title or introduction opens the Scope step, where the cover is written', () => {
    const r = missingFacts(['The quote is not finished: give the quote a title.']);
    expect(r[0].fix).toMatchObject({ kind: 'step', step: 'scope' });
  });
  it('encodes the page address', () => {
    expect(pageImageUrl('a b', 'k/1')).toBe('/api/documents/a%20b/pages/1?key=k%2F1');
  });
});
