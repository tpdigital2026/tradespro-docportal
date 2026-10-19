import Link from 'next/link';
import { ButtonLink } from '../../../../components/Button';
import { PageHeader } from '../../../../components/PageHeader';
import { getSurveyContext, getSurveyDraft, SurveyError, type SurveyContext } from '../../../../lib/data/surveys';
import { jobIdForReference } from '../../../../lib/data/survey-links';
import { isKnownId } from '../../../../lib/data/quotes';
import { SurveyForm } from './SurveyForm';
import { SURVEY_STEPS, type SurveyStep } from '../../../../lib/survey/page';

/** New survey report, or carry on with a draft one. */
export async function SurveyNewView({ draft: draftId, step, job, revised }: { draft?: string; step?: string; job?: string; revised?: boolean }) {
  let ctx: SurveyContext;
  try {
    ctx = await getSurveyContext();
  } catch (e) {
    return (
      <div className="page">
        <PageHeader muted="We cannot start" title="a survey report" lede={e instanceof SurveyError ? e.message : 'Something went wrong loading your customers. Please try again.'} />
        <p className="cust-back"><Link href="/">Back to Home</Link></p>
      </div>
    );
  }
  const draft = draftId && isKnownId(draftId) ? await getSurveyDraft(draftId) : null;
  if (draftId && (!draft || draft.status !== 'draft')) {
    return (
      <div className="page">
        <PageHeader muted="That survey" title={draft ? 'is already final' : 'is not here'} lede={draft ? 'A finalised report cannot be changed. Open it to download it or make the quote from it.' : 'The link may be out of date.'} />
        {draft ? <ButtonLink href={`/documents/${draft.documentId}`}>Open the report</ButtonLink> : <ButtonLink href="/documents/new?type=survey">Start a new survey report</ButtonLink>}
        <p className="cust-back"><Link href="/documents">Back to Documents</Link></p>
      </div>
    );
  }
  const presetJobId = !draft && job ? await jobIdForReference(job) : null;
  const initialStep = (SURVEY_STEPS as readonly string[]).includes(step ?? '') ? (step as SurveyStep) : undefined;
  return (
    <div className="page page-quote">
      <PageHeader
        compact
        eyebrow={draft ? `Draft survey report · ${draft.number}` : 'New survey report'}
        title={draft ? `Survey for ${draft.customerName}` : 'Record what you found'}
        lede="Photos and one line for each finding, then your professional opinion. Everything saves as you go."
      />
      {revised && draft ? <p className="doc-note" role="note">This is a correction to a report you had already finalised. The earlier version stays as it was. Every finding and your opinion need approving again, then you read and tick the new version.</p> : null}
      <SurveyForm ctx={ctx} draft={draft} initialStep={initialStep} presetJobId={presetJobId} />
    </div>
  );
}
