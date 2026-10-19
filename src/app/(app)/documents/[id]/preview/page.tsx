import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ButtonLink } from '../../../../../components/Button';
import { PageHeader } from '../../../../../components/PageHeader';
import { getDocumentPage, getPreview } from '../../../../../lib/data/documents';
import { logRenderFailure } from '../../../../../pdf/diagnostics';
import { DOC_TYPE_NAMES } from '../../../../../lib/job-stage';
import { upgradeLegacyApproval } from '../../../../../lib/data/scope';
import { requireSession } from '../../../../../lib/session';
import { Preview } from '../Preview';

export const metadata: Metadata = { title: 'Preview and finalise', description: 'Read every page, confirm you have checked it, and finalise.' };
// The pages are drawn the first time they are wanted, which takes a few seconds.
export const maxDuration = 60;

export default async function PreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const doc = await getDocumentPage(id);
  if (!doc) notFound();
  if (doc.status !== 'draft') redirect(`/documents/${id}`);
  // A quote opened from Home (Quotes to finish) with an approval from before 15 October: checked and upgraded here
  // too, so the pages and Finalise work without a trip back through the steps. Nothing happens for any other draft.
  if (doc.type === 'quotation') await upgradeLegacyApproval({ userId: session.userId, tenantId: session.tenantId }, doc.jobId).catch(() => undefined);
  const name = DOC_TYPE_NAMES[doc.type];
  const title = doc.type === 'quotation' ? `Quote ${doc.number}` : doc.number;

  let state: Awaited<ReturnType<typeof getPreview>>;
  try {
    state = await getPreview(id);
  } catch (e) {
    // One safe log line (stage, error class and code; never the document). The page below stays as it was.
    logRenderFailure('preview', e);
    return (
      <div className="page">
        <PageHeader eyebrow={`Draft ${name.toLowerCase()}`} title={title} lede="We could not draw the pages just now. Nothing has changed. Please try again in a moment." />
        <ButtonLink href={`/documents/${id}/preview`}>Try again</ButtonLink>
        <p className="cust-back"><Link href={`/documents/${id}`}>Back to the draft</Link></p>
      </div>
    );
  }
  if (!state) notFound();
  if (state.state === 'final') redirect(`/documents/${id}`);

  if (state.state === 'missing') {
    return (
      <div className="page">
        <PageHeader eyebrow={`Draft ${name.toLowerCase()}`} title={title} lede="This cannot be finalised yet, because some details it needs are missing. Nothing is made up to fill the gaps." />
        <section className="missing-panel" aria-labelledby="missing-h">
          <h2 id="missing-h" className="section-title">What is missing</h2>
          <ul className="missing-list">
            {state.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </section>
        <div className="doc-actions">
          {doc.editHref ? <ButtonLink href={doc.editHref}>Open the quote</ButtonLink> : <ButtonLink href={`/documents/${id}`}>Back to the draft</ButtonLink>}
        </div>
        <p className="cust-back"><Link href="/documents">Back to Documents</Link></p>
      </div>
    );
  }

  return (
    <div className="page page-wide">
      <PageHeader
        compact
        eyebrow={`Draft ${name.toLowerCase()} · ${doc.customerName}`}
        title={`Read ${title} before it is final`}
        lede="These are the real pages your customer will get. Scroll through every page, or tap a page to open it full size."
      />
      <Preview
        documentId={id}
        versionId={state.versionId}
        contentKey={state.key}
        pageCount={state.pageCount}
        confirmation={state.confirmation}
        corrections={doc.corrections}
        uncertain={doc.uncertain}
        showNotes={doc.type === 'quotation'}
        editHref={doc.editHref}
      />
    </div>
  );
}
