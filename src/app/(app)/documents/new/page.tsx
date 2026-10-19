import { cache } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { ButtonLink } from '../../../../components/Button';
import { DocTypeList } from '../../../../components/DocTypeList';
import { PageHeader } from '../../../../components/PageHeader';
import { getQuoteContext, getQuoteDraft, isKnownId, QuoteError, type QuoteContext } from '../../../../lib/data/quotes';
import { upgradeLegacyApproval } from '../../../../lib/data/scope';
import { approvalState } from '../../../../lib/scope/model';
import { requireSession } from '../../../../lib/session';
import { emptyQuoteForm, QUOTE_STEPS, type QuoteStep } from '../../../../lib/validation/quote';
import { DOC_TYPE_NAMES, isInvoiceType, isDocType } from '../../../../lib/job-stage';
import { FollowOnView } from './FollowOnView';
import { QuoteForm } from './QuoteForm';
import { SurveyNewView } from './SurveyNewView';
import { GuaranteeNewView } from './GuaranteeNewView';
import { jobIdForReference, surveyedJob, surveyQuoteNote } from '../../../../lib/data/survey-links';
import { redirect } from 'next/navigation';
import { StepperBoundary } from './StepperBoundary';

// The Review step draws page 1 of the real document, which takes a few seconds the first time.
export const maxDuration = 60;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The draft read once per request for both the title and the page (React cache: per request only). */
const draftOnce = cache((id: string) => getQuoteDraft(id));

export async function generateMetadata({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<Metadata> {
  const sp = await searchParams;
  const type = first(sp.type) ?? '';
  if (type === 'quotation') {
    const draftId = first(sp.draft);
    if (draftId && isKnownId(draftId)) {
      const draft = await draftOnce(draftId).catch(() => null);
      if (draft?.values.quoteNumber) return { title: `Quote ${draft.values.quoteNumber}`, description: 'Carry on with a draft quotation.' };
    }
    return { title: 'New quotation', description: 'Price a job step by step. The draft saves as you go.' };
  }
  if (type === 'guarantee') return { title: first(sp.draft) ? 'Guarantee certificate' : 'New guarantee certificate', description: 'The roof, the years and the date the work was completed. The draft saves as you go.' };
  if (type === 'survey') return { title: first(sp.draft) ? 'Survey report' : 'New survey report', description: 'Photos and one line for each finding, then your professional opinion. The draft saves as you go.' };
  if (isDocType(type)) return { title: `New ${DOC_TYPE_NAMES[type].toLowerCase()}`, description: 'Start a document from a saved job.' };
  return { title: 'New document', description: 'Choose the document you need: a quotation, an invoice, a receipt or a guarantee.' };
}

export default async function NewDocumentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await requireSession();
  const sp = await searchParams;
  const type = first(sp.type) ?? '';

  if (type === '') {
    return (
      <div className="page page-wide">
        <PageHeader muted="Make a" title="new document" lede="Pick what you need. Anything that belongs to a job fills itself in from the saved quote." />
        <DocTypeList />
      </div>
    );
  }

  if (type === 'guarantee') return <GuaranteeNewView draft={first(sp.draft)} job={first(sp.job)} />;

  if (type === 'survey') return <SurveyNewView draft={first(sp.draft)} step={first(sp.step)} job={first(sp.job)} revised={first(sp.revised) === '1'} />;

  if (isDocType(type) && (type === 'receipt' || isInvoiceType(type))) {
    return <FollowOnView type={type} job={first(sp.job)} n={first(sp.n)} payment={first(sp.payment)} />;
  }

  if (type !== 'quotation') {
    return (
      <div className="page">
        <PageHeader muted="Nearly ready" title={`${DOC_TYPE_NAMES[type as keyof typeof DOC_TYPE_NAMES] ?? 'That document'} is coming soon`} lede="We are still building this one. In the meantime you can price a job with a quotation." />
        <ButtonLink href="/documents/new?type=quotation">Start a quotation</ButtonLink>
        <p className="cust-back"><Link href="/">Back to Home</Link></p>
      </div>
    );
  }

  // The form's lists and the draft load side by side. The draft's own errors surface below, exactly as before.
  const jobRef = first(sp.job);
  const draftLoad = (async () => {
    const draftId = first(sp.draft) ?? (jobRef ? ((await jobIdForReference(jobRef)) ?? undefined) : undefined);
    return { draftId, draft: draftId && isKnownId(draftId) ? await draftOnce(draftId) : null };
  })();
  draftLoad.catch(() => undefined); // awaited below; never an unhandled rejection if the context fails first
  let ctx: QuoteContext;
  try {
    ctx = await getQuoteContext();
  } catch (e) {
    return (
      <div className="page">
        <PageHeader muted="We cannot start" title="a quotation" lede={e instanceof QuoteError ? e.message : 'Something went wrong loading your settings. Please try again.'} />
        <p className="cust-back"><Link href="/">Back to Home</Link></p>
      </div>
    );
  }
  // From a job's next step ("Write the quote" after a survey): the job number names the job.
  const loaded = await draftLoad;
  const draftId = loaded.draftId;
  let draft = loaded.draft;
  // An approval made before 15 October under the first fingerprint: checked against it and its audit row, and upgraded
  // when that proves the same person approved exactly this content. Otherwise the screen asks for it to be approved again.
  if (draft && approvalState(draft.values.scope) === 'legacy') {
    const up = await upgradeLegacyApproval({ userId: session.userId, tenantId: session.tenantId }, draft.jobId).catch(() => 'failed' as const);
    if (up === 'upgraded') draft = (await getQuoteDraft(draft.jobId)) ?? draft;
  }
  // A surveyed job's first quote: the note says to read it alongside the survey report.
  if (draft && !draft.documentId && !draft.values.scope.note.trim()) {
    const note = await surveyQuoteNote(draft.jobId).catch(() => null);
    if (note) draft.values = { ...draft.values, scope: { ...draft.values.scope, note } };
  }

  // A surveyed job whose quote cannot be opened here yet: the survey page has "Create quote from this survey".
  if (jobRef && !draft) {
    const surveyed = await surveyedJob(jobRef).catch(() => null);
    if (surveyed) redirect(`/documents/${surveyed.surveyId}`);
  }

  if (draftId && !draft) {
    return (
      <div className="page">
        <PageHeader muted="That draft" title="is not here" lede="It may have been issued already, or the link is out of date." />
        <ButtonLink href="/documents/new?type=quotation">Start a new quotation</ButtonLink>
        <p className="cust-back"><Link href="/">Back to Home</Link></p>
      </div>
    );
  }

  const stepRaw = first(sp.step);
  const stepParam = (QUOTE_STEPS as readonly string[]).includes(stepRaw ?? '') ? (stepRaw as QuoteStep) : undefined;
  const preselect = first(sp.customer);
  const initial =
    draft?.values ??
    emptyQuoteForm({
      date: ctx.today,
      vatApplies: ctx.defaults.vatDefault,
      depositPctBp: ctx.defaults.depositPctBp,
    });
  if (!draft && preselect) {
    const c = ctx.customers.find((x) => x.id === preselect);
    if (c) {
      initial.customerId = c.id;
      initial.propertyAddress = [c.addressLine, c.postcode].filter(Boolean).join(', ');
    }
  }

  return (
    <div className="page page-quote">
      <PageHeader
        compact
        eyebrow={draft ? 'Draft quotation' : 'New quotation'}
        title={draft ? `Quote ${draft.values.quoteNumber}` : 'Price a new job'}
        lede="Six short steps. Everything saves as you go, so you can stop and come back any time."
      />
      {first(sp.from) === 'survey' && draft ? (
        <p className="doc-note" role="note">This quote is for the job you surveyed. The customer and address are filled in, and the note says to read it alongside the survey report.</p>
      ) : null}
      {first(sp.revised) === '1' && draft ? (
        <p className="doc-note" role="note">This is a new version of a quote you had already finalised. Make your changes, save, then read and tick it again. The earlier version stays as it was.</p>
      ) : null}
      <StepperBoundary>
        <QuoteForm ctx={ctx} initial={initial} initialJobId={draft?.jobId ?? null} initialDocumentId={draft?.documentId ?? null} initialStep={stepParam} />
      </StepperBoundary>
    </div>
  );
}
