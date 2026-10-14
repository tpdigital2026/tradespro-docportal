import type { Metadata } from 'next';
import Link from 'next/link';
import { ButtonLink } from '../../../../components/Button';
import { DocTypeList } from '../../../../components/DocTypeList';
import { PageHeader } from '../../../../components/PageHeader';
import { getQuoteContext, getQuoteDraft, isKnownId } from '../../../../lib/data/quotes';
import { requireSession } from '../../../../lib/session';
import { emptyQuoteForm } from '../../../../lib/validation/quote';
import { QuoteForm } from './QuoteForm';

export const metadata: Metadata = { title: 'New document | TradesPro DocPortal' };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function NewDocumentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireSession();
  const sp = await searchParams;
  const type = first(sp.type) ?? '';

  if (type === '') {
    return (
      <div className="page page-wide">
        <PageHeader muted="Make a" title="document" lede="Choose what you need." />
        <DocTypeList />
      </div>
    );
  }

  if (type !== 'quotation') {
    return (
      <div className="page">
        <PageHeader muted="Coming" title="soon" lede="That document is built in a later step. For now you can start a quotation." />
        <ButtonLink href="/documents/new?type=quotation">Start a quotation</ButtonLink>
        <p className="cust-back"><Link href="/">Back to Home</Link></p>
      </div>
    );
  }

  const ctx = await getQuoteContext();
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
      <PageHeader eyebrow={draft ? `Draft ${draft.values.quoteNumber}` : undefined} muted={draft ? 'Carry on with the' : 'Start a'} title="quotation" />
      <QuoteForm ctx={ctx} initial={initial} initialJobId={draft?.jobId ?? null} />
    </div>
  );
}
