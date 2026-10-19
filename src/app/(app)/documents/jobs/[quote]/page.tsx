import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ButtonLink } from '../../../../../components/Button';
import { PageHeader } from '../../../../../components/PageHeader';
import { StageChips } from '../../../../../components/StageChips';
import { getJobSummary } from '../../../../../lib/data/billing';
import { instalmentHeading, paidOnInstalment, payableInvoice } from '../../../../../lib/job-billing';
import { DOC_TYPE_NAMES, invoiceTypeFor, newDocumentHref } from '../../../../../lib/job-stage';
import { formatGBP } from '../../../../../lib/money';
import { PAYMENT_METHOD_LABELS, todayLondon, type PaymentMethod } from '../../../../../lib/payment';
import { requireSession } from '../../../../../lib/session';
import { MarkAsPaid } from './MarkAsPaid';
import { SurveyedJob } from './SurveyedJob';
import { surveyedJob } from '../../../../../lib/data/survey-links';

export async function generateMetadata({ params }: { params: Promise<{ quote: string }> }): Promise<Metadata> {
  const { quote } = await params;
  let shown = quote;
  try {
    shown = decodeURIComponent(quote);
  } catch {
    shown = quote;
  }
  return { title: `Job ${shown.slice(0, 40)}`, description: 'Invoices, payments and receipts for one job.' };
}

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export default async function JobPage({ params, searchParams }: { params: Promise<{ quote: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireSession();
  const { quote: raw } = await params;
  const sp = await searchParams;
  const draftedRaw = sp.drafted;
  const payParam = typeof sp.pay === 'string' && /^\d{1,2}$/.test(sp.pay) ? Number(sp.pay) : null;
  const drafted = typeof draftedRaw === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{1,63}$/.test(draftedRaw) ? draftedRaw : null;
  // Next hands over the segment already decoded; a stray % is not a valid quote number, so it is a plain 404, never an error.
  let quote = raw;
  if (raw.includes('%')) {
    try {
      quote = decodeURIComponent(raw);
    } catch {
      notFound();
    }
  }
  const job = await getJobSummary(quote);
  if (!job?.billing) {
    const surveyed = await surveyedJob(quote).catch(() => null);
    if (surveyed) return <SurveyedJob s={surveyed} />;
  }
  if (!job) notFound();
  const b = job.billing;
  if (!b) {
    return (
      <div className="page">
        <PageHeader eyebrow={`Job ${job.quoteNumber}`} title={job.customerName} lede={job.problem ?? 'The money side of this job shows here once its quote has been issued.'} />
        <p className="cust-back"><Link href="/">Back to Home</Link></p>
      </div>
    );
  }
  const today = todayLondon();
  const nextIdx = b.progress.next?.instalment ?? null;

  return (
    <div className="page page-wide">
      <PageHeader eyebrow={`Job ${job.quoteNumber}`} title={job.customerName} lede={job.addressLine || undefined} />
      {drafted ? <p className="flash" role="status">Draft {drafted} is saved with this job.</p> : null}
      <section aria-label="Where this job is" className="job-top">
        <p className="job-total">
          <span className="job-total-label">Job total</span>
          <span className="job-total-amount">{formatGBP(b.totals.grossPence)}</span>
          <span className="job-total-plan">{b.kind === 'full' ? 'Paid in full' : b.kind === 'deposit' ? 'Deposit, then the balance' : `${b.instalments.length} stage payments`}</span>
        </p>
        <StageChips progress={b.progress} />
      </section>

      <section aria-labelledby="inst-h" className="job-section">
        <div className="sec-head">
          <h2 id="inst-h" className="section-title">{b.kind === 'full' ? 'The invoice' : b.kind === 'deposit' ? 'Deposit and balance' : 'The stages'}</h2>
          <p className="section-sub">Raise each invoice when it is due, then mark it paid when the money arrives.</p>
        </div>
        <ul className="inst-list">
          {b.instalments.map((inst) => {
            const heading = instalmentHeading(b, inst.index);
            const invoice = payableInvoice(b, inst.index);
            const draft = b.documents.find((d) => d.instalment === inst.index && d.type === invoiceTypeFor(b.kind, inst.index) && d.status === 'draft');
            const paid = paidOnInstalment(b, inst.index);
            const outstanding = Math.max(0, inst.grossPence - paid);
            const mine = b.payments.filter((p) => p.instalment === inst.index);
            const status = !invoice ? (draft ? 'Draft saved, not yet final' : 'Not invoiced yet') : paid >= inst.grossPence ? 'Paid' : paid > 0 ? `Part paid, ${formatGBP(outstanding)} to come` : 'Invoiced, waiting for payment';
            const tone = !invoice ? 'is-draft' : paid >= inst.grossPence ? 'is-paid' : paid > 0 ? 'is-part' : 'is-final';
            const isNext = nextIdx === inst.index;
            return (
              <li key={inst.index} id={`instalment-${inst.index}`} className={`inst${isNext ? ' is-next' : ''}${tone === 'is-paid' ? ' is-done' : ''}`}>
                <div className="inst-main">
                  <h3 className="inst-h">{heading}</h3>
                  <p className="inst-amount">{formatGBP(inst.grossPence)}</p>
                  <p className={`status-chip ${tone}`}>{status}</p>
                </div>
                {mine.length > 0 ? (
                  <ul className="inst-pays">
                    {mine.map((p) => (
                      <li key={p.id}>
                        <span>{formatGBP(p.amountPence)} by {PAYMENT_METHOD_LABELS[p.method as PaymentMethod]?.toLowerCase() ?? p.method}, {dateFmt.format(new Date(p.paidOn))}</span>
                        {p.receiptDocumentId ? (
                          <Link className="inst-receipt-link" href={`/documents/${p.receiptDocumentId}`}>{b.documents.find((d) => d.id === p.receiptDocumentId)?.status === 'draft' ? 'Finish the receipt' : 'Open the receipt'}</Link>
                        ) : (
                          <Link className="inst-receipt-link" href={newDocumentHref('receipt', b.quoteNumber, { n: inst.index, payment: p.id })}>Create receipt</Link>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="inst-actions">
                  {!invoice && !draft ? (
                    <ButtonLink href={newDocumentHref(invoiceTypeFor(b.kind, inst.index), b.quoteNumber, { n: inst.index })} variant={isNext ? 'primary' : 'secondary'}>
                      {`Raise ${DOC_TYPE_NAMES[invoiceTypeFor(b.kind, inst.index)].toLowerCase()}`}
                    </ButtonLink>
                  ) : null}
                  {!invoice && draft ? (
                    <ButtonLink href={`/documents/${draft.id}`} variant={isNext ? 'primary' : 'secondary'}>Preview and finalise</ButtonLink>
                  ) : null}
                  {invoice ? <ButtonLink href={`/documents/${invoice.id}`} variant="secondary">Open {invoice.number}</ButtonLink> : null}
                  {invoice && outstanding > 0 ? (
                    <MarkAsPaid
                      quote={b.quoteNumber}
                      instalment={inst.index}
                      heading={heading}
                      invoiceNumber={invoice.number}
                      outstandingPence={outstanding}
                      today={today}
                      label={paid > 0 ? 'Record more' : 'Mark as paid'}
                      primary={isNext}
                      autoOpen={payParam === inst.index}
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
      <p className="cust-back"><Link href="/">Back to Home</Link></p>
    </div>
  );
}
