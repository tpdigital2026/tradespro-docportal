import Link from 'next/link';
import { ButtonLink } from '../../../../../components/Button';
import { PageHeader } from '../../../../../components/PageHeader';
import { StageChips } from '../../../../../components/StageChips';
import type { SurveyedJobView } from '../../../../../lib/data/survey-links';
import { surveyedOnlyProgress } from '../../../../../lib/job-stage';

/** A job that has been surveyed and has no issued quote yet: the survey, and the quote to write. */
export function SurveyedJob({ s }: { s: SurveyedJobView }) {
  return (
    <div className="page page-mid">
      <PageHeader eyebrow={`Job ${s.quoteNumber}`} title={s.customerName} lede={s.addressLine || undefined} />
      {s.surveyFinal ? (
        <section aria-label="Where this job is" className="job-top">
          <StageChips progress={surveyedOnlyProgress()} />
        </section>
      ) : null}
      <section className="doc-next" aria-labelledby="sj-h">
        <h2 id="sj-h" className="section-title">{s.surveyFinal ? 'Surveyed. Next, the quote.' : 'The survey report is a draft'}</h2>
        <p className="section-sub">
          {s.surveyFinal ? `Survey report ${s.surveyNumber} is final. The quote for this job uses the same job number.` : `Finish survey report ${s.surveyNumber} first, then make the quote from it.`}
        </p>
        <div className="doc-actions">
          {s.surveyFinal ? (
            <ButtonLink href={s.quoteDraftJobId ? `/documents/new?type=quotation&draft=${encodeURIComponent(s.quoteDraftJobId)}` : `/documents/${s.surveyId}`}>{s.quoteDraftJobId ? 'Carry on with the quote' : 'Create the quote from the survey'}</ButtonLink>
          ) : null}
          <ButtonLink href={`/documents/${s.surveyId}`} variant={s.surveyFinal ? 'secondary' : 'primary'}>{s.surveyFinal ? 'Open the survey report' : 'Open the survey'}</ButtonLink>
        </div>
      </section>
      <p className="cust-back"><Link href="/">Back to Home</Link></p>
    </div>
  );
}
