import Link from 'next/link';
import { ButtonLink } from '../../../../components/Button';
import { PageHeader } from '../../../../components/PageHeader';
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
      <PageHeader muted="Which job is the" title={DOC_TYPE_NAMES[type].toLowerCase() + ' for?'} />
      {options.length > 0 ? (
        <ul className="rows">
          {options.map(({ job, n }) => (
            <li key={job.quoteNumber}>
              <Link href={newDocumentHref(type, job.quoteNumber, { n })} className="cust-row">
                <span className="cust-main">
                  <span className="row-title">{job.customerName}</span>
                  <span className="row-meta">Quote {job.quoteNumber}</span>
                </span>
                <span className="cust-kept">Choose</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">No job is waiting for a {DOC_TYPE_NAMES[type].toLowerCase()}. Jobs show up here once their quote has been issued and the payment plan fits.</p>
      )}
      <Back />
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
      <PageHeader eyebrow={`Quote ${summary.quoteNumber}`} muted="Start a" title={DOC_TYPE_NAMES[type].toLowerCase()} lede="Everything below comes from the saved quote. Nothing is typed twice." />
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
      <h3 className="qt-h3">Money</h3>
      <dl className="qt-sum">
        <div><dt>Before VAT</dt><dd>{formatGBP(f.netPence)}</dd></div>
        <div><dt>VAT</dt><dd>{f.vatPence > 0 ? formatGBP(f.vatPence) : 'None'}</dd></div>
        <div className="is-total"><dt>{isReceipt ? 'Received' : 'To pay'}</dt><dd>{formatGBP(f.grossPence)}</dd></div>
      </dl>
      {!isReceipt ? (
        <>
          {f.receivedEarlier.length > 0 ? (
            <p className="qt-note">Already received on this job: {formatGBP(received)}. It is listed on the invoice.</p>
          ) : null}
        </>
      ) : null}
      {f.exists ? <p className="qt-note">A document with this number is already saved for the job.</p> : null}
      <FollowOnForm job={summary.quoteNumber} type={type} n={f.instalment} payment={f.payment?.id ?? null} exists={f.exists} />
      <p className="qt-note">Making the PDF and finalising it come next. Saving now keeps the draft with the job.</p>
      <p className="cust-back"><Link href={`/documents/jobs/${encodeURIComponent(summary.quoteNumber)}`}>Back to the job</Link></p>
    </div>
  );
}
