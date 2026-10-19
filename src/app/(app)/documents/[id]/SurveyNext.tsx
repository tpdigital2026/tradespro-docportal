import { ButtonLink } from '../../../../components/Button';
import type { DocumentPage } from '../../../../lib/data/documents';
import { startQuoteFromSurveyAction } from '../new/survey-actions';

/** On a final survey report: the one next step, the quote for the same job. */
export function SurveyNext({ doc, failed }: { doc: DocumentPage; failed: boolean }) {
  const quote = doc.survey?.quote ?? null;
  return (
    <section className="doc-next sv-next" aria-labelledby="sv-next-h">
      <h2 id="sv-next-h" className="section-title">{quote ? 'The quote for this job' : 'Next: the quote'}</h2>
      {quote ? (
        <>
          <p className="section-sub">{quote.status === 'draft' ? `Quote ${doc.quoteNumber} is in progress for this job.` : `Quote ${doc.quoteNumber} has been finalised for this job.`} The survey and the quote stay separate downloads.</p>
          <ButtonLink href={quote.status === 'draft' ? `/documents/new?type=quotation&draft=${encodeURIComponent(doc.jobId)}` : `/documents/${quote.id}`}>{quote.status === 'draft' ? 'Carry on with the quote' : 'Open the quote'}</ButtonLink>
        </>
      ) : (
        <form action={startQuoteFromSurveyAction}>
          <p className="section-sub">The customer, the address and the job are filled in for you, with a note to read the quote alongside report {doc.number}.</p>
          <input type="hidden" name="id" value={doc.id} />
          <button type="submit" className="btn btn-primary">Create quote from this survey</button>
        </form>
      )}
      {failed ? <p className="error" role="alert">The quote could not be started just now. Please try again.</p> : null}
    </section>
  );
}
