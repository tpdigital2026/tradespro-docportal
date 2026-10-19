import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ButtonLink } from '../../../../components/Button';
import { PageHeader } from '../../../../components/PageHeader';
import { getDocumentPage, pdfFilename, type DocumentPage } from '../../../../lib/data/documents';
import { SEND_REMINDER } from '../../../../lib/documents/confirmation';
import type { SummarySection } from '../../../../lib/documents/summary';
import { DOC_TYPE_NAMES, jobHref } from '../../../../lib/job-stage';
import { upgradeLegacyApproval } from '../../../../lib/data/scope';
import { requireSession } from '../../../../lib/session';
import { DownloadButton } from './DownloadButton';
import { DraftPreview } from './DraftPreview';
import { EmailPanel } from './EmailPanel';
import { ReviseForm } from './ReviseForm';
import { SurveyNext } from './SurveyNext';
import { SurveyReviseForm } from './SurveyReviseForm';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const doc = await getDocumentPage(id).catch(() => null);
  if (!doc) return { title: 'Document', description: 'One of your documents.' };
  return { title: `${DOC_TYPE_NAMES[doc.type]} ${doc.number}${doc.status === 'draft' ? ' (draft)' : ''}`, description: doc.status === 'draft' ? 'Check what was entered, then preview and finalise.' : 'Download the finalised document and copy a covering email.' };
}

// A draft shows page 1 of the real document, which takes a few seconds to draw the first time.
export const maxDuration = 60;

const longFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });

function Summary({ sections }: { sections: SummarySection[] }) {
  return (
    <div className="doc-summary">
      {sections.filter((s) => s.rows.length > 0).map((s) => (
        <section key={s.title} className="doc-sum-sec" aria-label={s.title}>
          <h2 className="fgroup-h">{s.title}</h2>
          <dl className="doc-facts">
            {s.rows.map((r) => (
              <div key={r.label} className={r.tone ? `is-${r.tone}` : undefined}>
                <dt>{r.label}</dt>
                <dd>{r.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

function Draft({ doc, saved }: { doc: DocumentPage; saved: boolean }) {
  const name = DOC_TYPE_NAMES[doc.type];
  return (
    <div className="page page-mid">
      <PageHeader eyebrow={`Draft ${name.toLowerCase()}`} title={doc.type === 'quotation' ? `Quote ${doc.number}` : doc.number} lede={`For ${doc.customerName}. Check what was entered, then preview every page before it becomes final.`} />
      {saved ? <p className="flash" role="status">Saved. Preview it when you are ready.</p> : null}
      {doc.isRevision ? (
        <p className="doc-note" role="note">This is version {doc.version}, a change to a {doc.type === 'survey' ? 'report' : 'quote'} you had already finalised. The earlier version stays exactly as it was.</p>
      ) : null}
      <div className="doc-layout">
        <div className="doc-main">
          <Summary sections={doc.summary} />
          <DraftPreview id={doc.id} noun={doc.type === 'quotation' ? 'quote' : doc.type === 'survey' ? 'report' : name.toLowerCase()} quoteJobId={doc.type === 'quotation' ? doc.jobId : null} />
        </div>
        <aside className="doc-side" aria-label="What next">
          <div className="doc-next">
            <h2 className="section-title">Ready to check it?</h2>
            <p className="section-sub">You will see every page as your customer will. Read them all, tick to confirm, and it becomes final with a PDF to download.</p>
            <ButtonLink href={`/documents/${doc.id}/preview`}>Preview and finalise</ButtonLink>
            {doc.editHref ? (
              <ButtonLink href={doc.editHref} variant="secondary">Edit</ButtonLink>
            ) : (
              <p className="hint">The figures come from the quote and the payments you recorded, so there is nothing to edit here.</p>
            )}
            <p className="hint">A draft cannot be downloaded or sent.</p>
          </div>
        </aside>
      </div>
      <p className="cust-back"><Link href="/documents">Back to Documents</Link></p>
    </div>
  );
}

function Final({ doc, justFinalised, quoteFailed }: { doc: DocumentPage; justFinalised: boolean; quoteFailed: boolean }) {
  const name = DOC_TYPE_NAMES[doc.type];
  const pdf = `/api/documents/${doc.id}/pdf`;
  const when = doc.finalisedAt ? new Date(doc.finalisedAt) : null;
  return (
    <div className="page page-wide">
      <PageHeader
        eyebrow={`${name} · Final`}
        title={doc.number}
        lede={`For ${doc.customerName}.${when ? ` Finalised on ${longFmt.format(when)} at ${timeFmt.format(when)}.` : ''}`}
      />
      {justFinalised ? <p className="flash is-done" role="status">Finalised. It is saved in Documents and ready to download.</p> : null}
      <div className="doc-layout">
        <div className="doc-main">
          <section className="doc-download" aria-labelledby="dl-h">
            <h2 id="dl-h" className="sr-only">Download</h2>
            <DownloadButton href={pdf} filename={pdfFilename(doc.number, null)} title={`${name} ${doc.number}`} />
            <p className="send-reminder">{SEND_REMINDER}</p>
          </section>

          {doc.pages > 0 ? (
            <section aria-labelledby="pages-h" className="doc-pages">
              <div className="sec-head">
                <h2 id="pages-h" className="section-title">The pages</h2>
                <p className="section-sub">{doc.pages === 1 ? 'One page, exactly as in the PDF.' : `${doc.pages} pages, exactly as in the PDF.`}</p>
              </div>
              <ol className="thumbs">
                {Array.from({ length: doc.pages }, (_, i) => (
                  <li key={i}>
                    <a href={`/api/documents/${doc.id}/pages/${i + 1}`} target="_blank" rel="noopener" className="thumb">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={`/api/documents/${doc.id}/pages/${i + 1}`} alt={`Page ${i + 1} of ${doc.pages}`} width={794} height={1123} loading="lazy" decoding="async" />
                      <span className="thumb-n">Page {i + 1}</span>
                    </a>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {doc.email ? <EmailPanel facts={doc.email} /> : null}
        </div>

        <aside className="doc-side" aria-label="Details">
          {doc.survey ? <SurveyNext doc={doc} failed={quoteFailed} /> : null}
          <div className="doc-side-panel">
            <h2 className="section-title">What is on it</h2>
            <Summary sections={doc.summary} />
            <p className="cust-back doc-job-link"><Link href={jobHref(doc.quoteNumber)}>Open job {doc.quoteNumber}</Link></p>
          </div>
          {doc.revise ? (
            doc.revise.allowed ? (
              doc.type === 'survey' ? <SurveyReviseForm id={doc.id} /> : <ReviseForm id={doc.id} number={doc.number} />
            ) : (
              <p className="hint doc-revise-no">{doc.revise.reason}</p>
            )
          ) : null}
          {doc.earlier.length ? (
            <section aria-labelledby="earlier-h" className="doc-earlier">
              <h2 id="earlier-h" className="fgroup-h">Earlier versions</h2>
              <ul>
                {doc.earlier.map((v) => (
                  <li key={v.versionId}>
                    <a href={`${pdf}?v=${encodeURIComponent(v.versionId)}`} download={pdfFilename(doc.number, v.version)}>
                      Version {v.version}, finalised {longFmt.format(new Date(v.finalisedAt))}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </aside>
      </div>
      <p className="cust-back"><Link href="/documents">Back to Documents</Link></p>
    </div>
  );
}

export default async function DocumentPageRoute({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const { id } = await params;
  const sp = await searchParams;
  let doc = await getDocumentPage(id);
  if (!doc) notFound();
  // A draft quote opened from Home (Quotes to finish) with an approval from before 15 October: checked and upgraded
  // here as on the preview page, so its page 1 and summary do not ask for an approval the owner already gave.
  if (doc.status === 'draft' && doc.type === 'quotation') {
    const up = await upgradeLegacyApproval({ userId: session.userId, tenantId: session.tenantId }, doc.jobId).catch(() => 'failed' as const);
    if (up === 'upgraded') doc = (await getDocumentPage(id)) ?? doc;
  }
  return doc.status === 'draft' ? <Draft doc={doc} saved={sp.saved === '1'} /> : <Final doc={doc} justFinalised={sp.finalised === '1'} quoteFailed={sp.quote === 'failed'} />;
}
