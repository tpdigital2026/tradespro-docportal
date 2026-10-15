import 'server-only';
import { isDemo } from '../demo';
import { requireSession } from '../session';
import { NUMBER_RE } from '../validation/quote';
import { ownerClient } from './customers';
import { demoSurveyRows, demoSurveyJob } from './surveys';
import { demoBillingState } from './billing';
import { surveyedOnlyProgress, type JobProgress } from '../job-stage';

/** The job with this number, for links that name a job by its number. Row level security scopes the lookup. */
export async function jobIdForReference(reference: string): Promise<string | null> {
  await requireSession();
  if (typeof reference !== 'string' || !NUMBER_RE.test(reference)) return null;
  if (isDemo()) return demoSurveyRows().map((s) => demoSurveyJob(s.jobId)).find((j) => j?.reference === reference)?.jobId ?? null;
  const r = await (await ownerClient()).from('jobs').select('id').eq('reference', reference).maybeSingle();
  return (r.data as { id?: string } | null)?.id ?? null;
}

export interface SurveyedJob {
  quoteNumber: string;
  customerName: string;
  addressLine: string;
  progress: JobProgress;
}

/** Jobs with a final survey report and no issued quote yet: Home lists them with "Write the quote" next. */
export async function listSurveyedJobs(): Promise<SurveyedJob[]> {
  await requireSession();
  if (isDemo()) {
    const issued = new Set(demoBillingState().jobs.map((j) => j.jobId));
    return demoSurveyRows()
      .filter((s) => s.status === 'final' && !issued.has(s.jobId))
      .map((s) => ({ quoteNumber: demoSurveyJob(s.jobId)?.reference ?? '', customerName: s.customerName, addressLine: demoSurveyJob(s.jobId)?.propertyAddress ?? '', progress: surveyedOnlyProgress() }));
  }
  const client = await ownerClient();
  const docs = await client.from('documents').select('job_id, type, status').in('type', ['survey_report', 'quotation']).limit(2000);
  if (docs.error) return [];
  const rows = (docs.data ?? []) as { job_id: string; type: string; status: string }[];
  const quoted = new Set(rows.filter((r) => r.type === 'quotation' && r.status !== 'draft').map((r) => r.job_id));
  const jobIds = [...new Set(rows.filter((r) => r.type === 'survey_report' && r.status !== 'draft' && !quoted.has(r.job_id)).map((r) => r.job_id))].slice(0, 50);
  if (jobIds.length === 0) return [];
  const jobs = await client.from('jobs').select('id, reference, customer_id, property_address').in('id', jobIds);
  if (jobs.error) return [];
  const jr = (jobs.data ?? []) as { id: string; reference: string; customer_id: string; property_address: string | null }[];
  const custs = await client.from('customers').select('id, name').in('id', [...new Set(jr.map((j) => j.customer_id))]);
  const names = new Map(((custs.data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  return jr.map((j) => ({ quoteNumber: j.reference, customerName: names.get(j.customer_id) ?? 'Customer', addressLine: j.property_address ?? '', progress: surveyedOnlyProgress() }));
}
