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
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from '../../../../../lib/payment';
import { requireSession } from '../../../../../lib/session';
import { MarkAsPaid } from './MarkAsPaid';

export const metadata: Metadata = { title: 'Job | TradesPro DocPortal' };

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const todayIso = () => new Date().toISOString().slice(0, 10);

export default async function JobPage({ params, searchParams }: { params: Promise<{ quote: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireSession();
  const { quote: raw } = await params;
  const sp = await searchParams;
  const draftedRaw = sp.drafted;
  const drafted = typeof draftedRaw === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{1,63}$/.test(draftedRaw) ? draftedRaw : null;
  const quote = decodeURIComponent(raw);
  const job = await getJobSummary(quote);
  if (!job) notFound();
  const b = job.billing;
  if (!b) {
    return (
      <div className="page">
        <PageHeader eyebrow={`Quote ${job.quoteNumber}`} muted="This job" title={job.customerName} lede={job.problem ?? undefined} />
        <p className="cust-back"><Link href="/">Back to Home</Link></p>
      </div>
    );
  }
  const today = todayIso();
  const nextIdx = b.progress.next?.instalment ?? null;

  return (
    <div className="page page-wide">
      <PageHeader eyebrow={`Quote ${job.quoteNumber}`} muted="Money for" title={job.customerName} lede={job.addressLine || undefined} />
      {drafted ? <p className="cust-flash" role="status">Draft {drafted} is saved with this job.</p> : null}
      <section aria-label="Where this job is" className="job-top">
        <StageChips progress={b.progress} />
        <p className="job-total">Job total <strong>{formatGBP(b.totals.grossPence)}</strong></p>
      </section>

      <section aria-labelledby="inst-h" className="home-section">
        <h2 id="inst-h" className="section-title">{b.kind === 'full' ? 'The invoice' : b.kind === 'deposit' ? 'Deposit and balance' : 'The stages'}</h2>
        <ul className="inst-list">
          {b.instalments.map((inst) => {
            const heading = instalmentHeading(b, inst.index);
            const invoice = payableInvoice(b, inst.index);
            const draft = b.documents.find((d) => d.instalment === inst.index && d.type === invoiceTypeFor(b.kind, inst.index) && d.status === 'draft');
            const paid = paidOnInstalment(b, inst.index);
            const outstanding = Math.max(0, inst.grossPence - paid);
            const mine = b.payments.filter((p) => p.instalment === inst.index);
            const status = !invoice ? (draft ? 'Draft saved, not yet final' : 'Not invoiced yet') : paid >= inst.grossPence ? 'Paid' : paid > 0 ? `Part paid, ${formatGBP(outstanding)} to come` : 'Invoiced, waiting for payment';
            const isNext = nextIdx === inst.index;
            return (
              <li key={inst.index} id={`instalment-${inst.index}`} className="inst">
                <div className="inst-main">
                  <h3 className="inst-h">{heading}</h3>
                  <p className="inst-amount">{formatGBP(inst.grossPence)}</p>
                  <p className="inst-status">{status}</p>
                </div>
                {mine.length > 0 ? (
                  <ul className="inst-pays">
                    {mine.map((p) => (
                      <li key={p.id}>
                        <span>{formatGBP(p.amountPence)} by {PAYMENT_METHOD_LABELS[p.method as PaymentMethod]?.toLowerCase() ?? p.method}, {dateFmt.format(new Date(p.paidOn))}</span>
                        {p.receiptDocumentId ? (
                          <span className="inst-receipt">Receipt started</span>
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
                    <ButtonLink href={newDocumentHref(invoiceTypeFor(b.kind, inst.index), b.quoteNumber, { n: inst.index })} variant="secondary">Open the draft</ButtonLink>
                  ) : null}
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
