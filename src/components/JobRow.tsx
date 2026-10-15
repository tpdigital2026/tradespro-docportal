import Link from 'next/link';
import { ButtonLink } from './Button';
import { StageChips } from './StageChips';
import { DOC_TYPE_NAMES, jobHref, newDocumentHref, nextStepHref, type JobProgress } from '../lib/job-stage';

export type Job = { quoteNumber: string; customerName: string; addressLine: string; progress: JobProgress };

/** One job as a soft panel: who and where, a bold progress bar, and the one next step. */
export function JobRow({ job, primary }: { job: Job; primary: boolean }) {
  const next = job.progress.next;
  const due = job.progress.receiptsDue[0];
  return (
    <li className="job">
      <div className="job-who">
        <p className="job-name">
          <Link href={jobHref(job.quoteNumber)} className="job-link">{job.customerName}</Link>
        </p>
        {job.addressLine ? <p className="job-meta">{job.addressLine}</p> : null}
        <p className="job-ref">Quote {job.quoteNumber}</p>
      </div>
      <StageChips progress={job.progress} />
      <div className="job-actions">
        {next ? (
          <ButtonLink href={nextStepHref(next, job.quoteNumber)} variant={primary ? 'primary' : 'secondary'} className="job-go">
            {next.label}
          </ButtonLink>
        ) : (
          <p className="job-done">All done for now</p>
        )}
        {due ? (
          <Link href={newDocumentHref('receipt', job.quoteNumber, { n: due })} className="job-sub">
            Create {DOC_TYPE_NAMES.receipt.toLowerCase()}
          </Link>
        ) : null}
      </div>
    </li>
  );
}
