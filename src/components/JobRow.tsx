import { ButtonLink } from './Button';
import { StageChips } from './StageChips';
import { newDocumentHref, nextStep, type Stage } from '../lib/job-stage';

export type Job = { quoteNumber: string; customerName: string; addressLine: string; stage: Stage };

export function JobRow({ job, primary }: { job: Job; primary: boolean }) {
  const next = nextStep(job.stage);
  return (
    <li className="job">
      <div className="job-who">
        <p className="job-name">{job.customerName}</p>
        <p className="job-meta">{job.addressLine}</p>
        <p className="job-meta">Quote {job.quoteNumber}</p>
      </div>
      <StageChips stage={job.stage} />
      {next ? (
        <ButtonLink
          href={newDocumentHref(next.type, job.quoteNumber)}
          variant={primary ? 'primary' : 'secondary'}
          className="job-go"
        >
          {next.label}
        </ButtonLink>
      ) : null}
    </li>
  );
}
