import type { Metadata } from 'next';
import Link from 'next/link';
import { ButtonLink } from '../../../../components/Button';
import { DocTypeList } from '../../../../components/DocTypeList';
import { PageHeader } from '../../../../components/PageHeader';
import { getQuoteContext, getQuoteDraft, isKnownId, QuoteError, type QuoteContext } from '../../../../lib/data/quotes';
import { requireSession } from '../../../../lib/session';
import { emptyQuoteForm } from '../../../../lib/validation/quote';
import { DOC_TYPE_NAMES, isInvoiceType, isDocType } from '../../../../lib/job-stage';
import { FollowOnView } from './FollowOnView';
import { QuoteForm } from './QuoteForm';

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export async function generateMetadata({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<Metadata> {
  const sp = await searchParams;
  const type = first(sp.type) ?? '';
  if (type === 'quotation') {
    const draftId = first(sp.draft);
    if (draftId && isKnownId(draftId)) {
      const draft = await getQuoteDraft(draftId).catch(() => null);
      if (draft?.values.quoteNumber) return { title: `Quote ${draft.values.quoteNumber}`, description: 'Carry on with a draft quotation.' };
    }
    return { title: 'New quotation', description: 'Price a job step by step. The draft saves as you go.' };
  }
  if (isDocType(type)) return { title: `New ${DOC_TYPE_NAMES[type].toLowerCase()}`, description: 'Start a document from a saved job.' };
  return { title: 'New document', description: 'Choose the document you need: a quotation, an invoice, a receipt or a guarantee.' };
}

export default async function NewDocumentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireSession();
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
  const draftId = first(sp.draft);
  const draft = draftId && isKnownId(draftId) ? await getQuoteDraft(draftId) : null;

  if (draftId && !draft) {
    return (
      <div className="page">
        <PageHeader muted="That draft" title="is not here" lede="It may have been issued already, or the link is out of date." />
        <ButtonLink href="/documents/new?type=quotation">Start a new quotation</ButtonLink>
        <p className="cust-back"><Link href="/">Back to Home</Link></p>
      </div>
    );
  }

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
      <QuoteForm ctx={ctx} initial={initial} initialJobId={draft?.jobId ?? null} />
    </div>
  );
}
