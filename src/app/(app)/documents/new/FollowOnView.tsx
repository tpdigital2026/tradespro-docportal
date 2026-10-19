import Link from 'next/link';
import { ButtonLink } from '../../../../components/Button';
import { EmptyState } from '../../../../components/EmptyState';
import { PageHeader } from '../../../../components/PageHeader';
import { initials } from '../../../../lib/initials';
import { getJobSummary, listJobSummaries } from '../../../../lib/data/billing';
import { followOnFor, type JobBilling } from '../../../../lib/job-billing';
import { DOC_TYPE_NAMES, invoiceTypeFor, newDocumentHref, type DocType } from '../../../../lib/job-stage';
import { formatGBP } from '../../../../lib/money';
import { PAYMENT_METHOD_LABELS, type PaymentMethod } from '../../../../lib/payment';
import { FollowOnForm } from './FollowOnForm';

const dateFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

const Back = () => <p className="cust-back"><Link href="/">Back to Home</Link></p>;

/** The instalment a document of this type would be for next on this job, or null when none fits. */
function candidate(b: JobBilling, type: DocType): number | null {
  if (type === 'receipt') {
    const hit = b.instalments.find((i) => b.payments.some((p) => p.instalment === i.index && p.receiptDocumentId === null));
    return hit ? hit.index : null;
  }
  const hit = b.instalments.find((i) => invoiceTypeFor(b.kind, i.index) === type && !b.documents.some((d) => d.instalment === i.index && d.type === type ));
  return hit ? hit.index : null;
}

/** No job chosen yet: the jobs this document could be for. */
async function Chooser({ type }: { type: DocType }) {
  let jobs: Awaited<ReturnType<typeof listJobSummaries>> = [];
  try {
    jobs = await listJobSummaries();
  } catch {
    jobs = [];
  }
  const options = jobs.flatMap((j) => {
    if (!j.billing) return [];
    const n = candidate(j.billing, type);
    return n === null ? [] : [{ job: j, n }];
  });
  return (
    <div className="page">
      <PageHeader muted={`New ${DOC_TYPE_NAMES[type].toLowerCase()}`} title="Which job is it for?" lede="Pick the job and everything else fills in from its saved quote." />
      {options.length > 0 ? (
        <ul className="cust-list">
          {options.map(({ job, n }) => (
            <li key={job.quoteNumber}>
              <Link href={newDocumentHref(type, job.quoteNumber, { n })} className="cust-row">
                <span className="avatar" aria-hidden="true">{initials(job.customerName)}</span>
                <span className="cust-main">
                  <span className="cust-name">{job.customerName}</span>
                  <span className="cust-addr">Quote {job.quoteNumber}{job.addressLine ? `, ${job.addressLine}` : ''}</span>
                </span>
                <span className="chip is-go">Choose</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon="jobs" title={`No job needs a ${DOC_TYPE_NAMES[type].toLowerCase()} right now`} action={<span className="empty-actions"><ButtonLink href="/documents/new?type=quotation">Start a quotation</ButtonLink><ButtonLink href="/" variant="secondary">Back to Home</ButtonLink></span>}>
          {DOC_TYPE_NAMES[type]}s are made from a job whose quotation has been finalised. Finalise a quote first, and its jobs show up here when the payment plan has a {DOC_TYPE_NAMES[type].toLowerCase()} due.
        </EmptyState>
      )}
      {options.length > 0 ? <Back /> : null}
    </div>
  );
}

export async function FollowOnView({ type, job, n, payment }: { type: DocType; job: string | undefined; n: string | undefined; payment: string | undefined }) {
  if (!job) return <Chooser type={type} />;
  const summary = await getJobSummary(job);
  if (!summary || !summary.billing) {
    return (
      <div className="page">
        <PageHeader muted="That job" title="is not here" lede={summary?.problem ?? 'It may have been removed, or the link is out of date.'} />
        <ButtonLink href="/documents/new">Choose a document</ButtonLink>
        <Back />
      </div>
    );
  }
  const b = summary.billing;
  const index = n && /^\d{1,2}$/.test(n) ? Number(n) : null;
  const r = followOnFor(b, type, index, payment && payment.length <= 80 ? payment : null);
  if (!r.ok) {
    return (
      <div className="page">
        <PageHeader muted="We cannot start" title={`a ${DOC_TYPE_NAMES[type].toLowerCase()}`} lede={r.message} />
        <ButtonLink href={`/documents/jobs/${encodeURIComponent(job)}`}>Back to the job</ButtonLink>
        <Back />
      </div>
    );
  }
  const f = r.followOn;
  const isReceipt = type === 'receipt';
  const received = f.receivedEarlier.reduce((s, p) => s + p.amountPence, 0);
  return (
    <div className="page page-quote">
      <PageHeader compact eyebrow={`Job ${summary.quoteNumber}`} title={`New ${DOC_TYPE_NAMES[type].toLowerCase()}`} lede="Everything here comes from the saved quote, so nothing is typed twice. Check it, then save the draft." />
      <div className="fo-layout">
      <div className="fo-main">
      <h2 className="fgroup-h">{isReceipt ? 'The payment' : 'Who and what'}</h2>
      <dl className="qt-facts">
        <div><dt>For</dt><dd>{summary.customerName}</dd></div>
        {summary.addressLine ? <div><dt>Address of the work</dt><dd>{summary.addressLine}</dd></div> : null}
        <div><dt>Number</dt><dd>{f.number}</dd></div>
        <div><dt>{isReceipt ? 'Receipt for' : 'This invoice is for'}</dt><dd>{f.heading}</dd></div>
        {isReceipt && f.payment ? (
          <>
            <div><dt>Amount received</dt><dd>{formatGBP(f.payment.amountPence)}</dd></div>
            <div><dt>Date received</dt><dd>{dateFmt.format(new Date(f.payment.paidOn))}</dd></div>
            <div><dt>How it was paid</dt><dd>{PAYMENT_METHOD_LABELS[f.payment.method as PaymentMethod] ?? f.payment.method}</dd></div>
          </>
        ) : null}
      </dl>
      {!isReceipt && f.receivedEarlier.length > 0 ? (
        <p className="qt-note">Already received on this job: {formatGBP(received)}. It is listed on the invoice.</p>
      ) : null}
      {f.exists ? <p className="qt-note">A document with this number is already saved for the job.</p> : null}
      </div>
      <aside className="fo-side qt-sum-card" aria-label="Money">
      <p className="eyebrow">{f.number}</p>
      <dl className="qt-sum">
        <div><dt>Before VAT</dt><dd>{formatGBP(f.netPence)}</dd></div>
        <div><dt>VAT</dt><dd>{f.vatPence > 0 ? formatGBP(f.vatPence) : 'None'}</dd></div>
        <div className="is-total"><dt>{isReceipt ? 'Received' : 'To pay'}</dt><dd>{formatGBP(f.grossPence)}</dd></div>
      </dl>
      <FollowOnForm job={summary.quoteNumber} type={type} n={f.instalment} payment={f.payment?.id ?? null} exists={f.exists} />
      <p className="qt-note">Saving keeps the draft with the job. Making the PDF and sending it come next.</p>
      </aside>
      </div>
      <p className="cust-back"><Link href={`/documents/jobs/${encodeURIComponent(summary.quoteNumber)}`}>Back to the job</Link></p>
    </div>
  );
}
