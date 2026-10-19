'use server';

import { createRateLimiter } from '../../../../ai/rate-limit';
import { getPreview } from '../../../../lib/data/documents';
import { isKnownId } from '../../../../lib/data/quotes';
import { missingFacts, pageImageUrl, type DraftPreview } from '../../../../lib/documents/draft-preview';
import { logRenderFailure } from '../../../../pdf/diagnostics';
import { requireSession } from '../../../../lib/session';

/**
 * Twenty preview requests per person a minute. An unchanged draft costs one storage read (the pages are kept by
 * content key), so this only bites on rapid changes; the screen also waits for the owner to stop typing.
 */
const limiter = createRateLimiter(20, 60_000);

/**
 * Page 1 of the real document for the draft on screen, drawn by the same renderer as the preview page and kept by
 * content key (an unchanged draft is never drawn twice; the full preview later reuses these very pages). The
 * business and the draft come from the session and the stored draft: another business's document is simply not
 * found. Nothing is finalised and no read is recorded.
 */
export async function previewDraftPageAction(documentIdRaw: unknown): Promise<DraftPreview> {
  const s = await requireSession();
  if (!isKnownId(documentIdRaw)) return { state: 'error', message: 'Save the draft first, then the preview appears here.', diag: 'PV-ID' };
  const documentId = documentIdRaw;
  if (!limiter.take(s.userId)) return { state: 'busy', message: 'The preview is updating a lot. It will catch up in a moment.', diag: 'PV-LIMIT' };
  try {
    const st = await getPreview(documentId);
    const previewHref = `/documents/${encodeURIComponent(documentId)}/preview`;
    if (!st) return { state: 'error', message: 'We could not find this draft. Go back to Home and open it again.', diag: 'PV-NOT-FOUND' };
    if (st.state === 'final') return { state: 'error', message: 'This document has already been finalised.', diag: 'PV-FINAL' };
    if (st.state === 'missing') return { state: 'missing', documentId, missing: missingFacts(st.missing), previewHref };
    return { state: 'ready', documentId, key: st.key, pageCount: st.pageCount, imageUrl: pageImageUrl(documentId, st.key), previewHref };
  } catch (e) {
    // One safe log line (stage, error class and code; never the document).
    logRenderFailure('draft-preview', e);
    return { state: 'error', message: 'We could not draw the preview just now. Your draft is safe.', diag: 'PV-RENDER' };
  }
}
