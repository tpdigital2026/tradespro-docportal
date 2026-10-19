import Link from 'next/link';
import { ButtonLink } from '../../../../components/Button';
import { PageHeader } from '../../../../components/PageHeader';
import { getGuaranteeContext, getGuaranteeDraft, GuaranteeError, type GuaranteeContext } from '../../../../lib/data/guarantees';
import { isKnownId } from '../../../../lib/data/quotes';
import { GuaranteeForm } from './GuaranteeForm';

/** New guarantee certificate, or carry on with a draft one. */
export async function GuaranteeNewView({ draft: draftId, job }: { draft?: string; job?: string }) {
  let ctx: GuaranteeContext;
  try {
    ctx = await getGuaranteeContext();
  } catch (e) {
    return (
      <div className="page">
        <PageHeader muted="We cannot start" title="a guarantee certificate" lede={e instanceof GuaranteeError ? e.message : 'Something went wrong loading your jobs. Please try again.'} />
        <p className="cust-back"><Link href="/">Back to Home</Link></p>
      </div>
    );
  }
  const draft = draftId && isKnownId(draftId) ? await getGuaranteeDraft(draftId) : null;
  if (draftId && (!draft || draft.status !== 'draft')) {
    return (
      <div className="page">
        <PageHeader muted="That certificate" title={draft ? 'is already final' : 'is not here'} lede={draft ? 'A finalised certificate cannot be changed. Open it to download it.' : 'The link may be out of date.'} />
        {draft ? <ButtonLink href={`/documents/${draft.documentId}`}>Open the certificate</ButtonLink> : <ButtonLink href="/documents/new?type=guarantee">Start a new certificate</ButtonLink>}
        <p className="cust-back"><Link href="/documents">Back to Documents</Link></p>
      </div>
    );
  }
  const presetJob = !draft && job ? (ctx.jobs.find((j) => j.reference === job) ?? null) : null;
  return (
    <div className="page page-quote">
      <PageHeader
        compact
        eyebrow={draft ? `Draft guarantee certificate · ${draft.number}` : 'New guarantee certificate'}
        title={draft ? `Guarantee for ${draft.customerName}` : 'Issue a guarantee'}
        lede="The certificate is drawn as you fill it in. The draft saves as you go, and the issue date is always the day you finalise it."
      />
      <GuaranteeForm ctx={ctx} draft={draft} presetJobId={presetJob?.id ?? null} />
    </div>
  );
}
