import 'server-only';
import { isDemo } from '../demo';
import { requireSession } from '../session';
import { NUMBER_RE } from '../validation/quote';
import { ownerClient } from './customers';
import { demoSurveyRows, demoSurveyJob } from './surveys';
import { demoBillingState } from './billing';
import { surveyedOnlyProgress, type JobProgress } from '../job-stage';
import { quoteLinkLine } from '../survey/map';
import { FJC_WORDING, tenantWordingSchema } from '../../db/wording';

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
    const { demoDraftRows } = await import('./quotes');
    const drafts = new Set(demoDraftRows().map((d) => d.jobId));
    return demoSurveyRows()
      .filter((s) => s.status === 'final' && !issued.has(s.jobId))
      .map((s) => ({ quoteNumber: demoSurveyJob(s.jobId)?.reference ?? '', customerName: s.customerName, addressLine: demoSurveyJob(s.jobId)?.propertyAddress ?? '', progress: surveyedOnlyProgress(drafts.has(s.jobId)) }));
  }
  const client = await ownerClient();
  const docs = await client.from('documents').select('job_id, type, status').in('type', ['survey_report', 'quotation']).limit(2000);
  if (docs.error) return [];
  const rows = (docs.data ?? []) as { job_id: string; type: string; status: string }[];
  const quoted = new Set(rows.filter((r) => r.type === 'quotation' && r.status !== 'draft').map((r) => r.job_id));
  const drafting = new Set(rows.filter((r) => r.type === 'quotation' && r.status === 'draft').map((r) => r.job_id));
  const jobIds = [...new Set(rows.filter((r) => r.type === 'survey_report' && r.status !== 'draft' && !quoted.has(r.job_id)).map((r) => r.job_id))].slice(0, 50);
  if (jobIds.length === 0) return [];
  const jobs = await client.from('jobs').select('id, reference, customer_id, property_address').in('id', jobIds);
  if (jobs.error) return [];
  const jr = (jobs.data ?? []) as { id: string; reference: string; customer_id: string; property_address: string | null }[];
  const custs = await client.from('customers').select('id, name').in('id', [...new Set(jr.map((j) => j.customer_id))]);
  const names = new Map(((custs.data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
  return jr.map((j) => ({ quoteNumber: j.reference, customerName: names.get(j.customer_id) ?? 'Customer', addressLine: j.property_address ?? '', progress: surveyedOnlyProgress(drafting.has(j.id)) }));
}

export interface SurveyedJobView {
  quoteNumber: string;
  customerName: string;
  addressLine: string;
  surveyId: string;
  surveyNumber: string;
  surveyFinal: boolean;
  /** The job's quote, if one has been started. */
  quoteDraftJobId: string | null;
}

/** For the job page of a job that has a survey report but no issued quote yet. */
export async function surveyedJob(reference: string): Promise<SurveyedJobView | null> {
  await requireSession();
  if (typeof reference !== 'string' || !NUMBER_RE.test(reference)) return null;
  if (isDemo()) {
    const s = demoSurveyRows().find((x) => demoSurveyJob(x.jobId)?.reference === reference);
    if (!s) return null;
    const job = demoSurveyJob(s.jobId);
    const { demoDraftRows } = await import('./quotes');
    return { quoteNumber: reference, customerName: s.customerName, addressLine: job?.propertyAddress ?? '', surveyId: s.id, surveyNumber: s.number, surveyFinal: s.status === 'final', quoteDraftJobId: demoDraftRows().some((d) => d.jobId === s.jobId) ? s.jobId : null };
  }
  const client = await ownerClient();
  const j = await client.from('jobs').select('id, reference, customer_id, property_address').eq('reference', reference).maybeSingle();
  const job = j.data as { id: string; customer_id: string; property_address: string | null } | null;
  if (!job) return null;
  const d = await client.from('documents').select('id, type, number, status').eq('job_id', job.id).in('type', ['survey_report', 'quotation']);
  const docs = (d.data ?? []) as { id: string; type: string; number: string; status: string }[];
  const s = docs.find((x) => x.type === 'survey_report');
  const q = docs.find((x) => x.type === 'quotation');
  if (!s || (q && q.status !== 'draft')) return null;
  const c = await client.from('customers').select('name').eq('id', job.customer_id).maybeSingle();
  return { quoteNumber: reference, customerName: (c.data as { name?: string } | null)?.name ?? 'Customer', addressLine: job.property_address ?? '', surveyId: s.id, surveyNumber: s.number, surveyFinal: s.status !== 'draft', quoteDraftJobId: q ? job.id : null };
}

/**
 * For a quote opened on a surveyed job that has no quote yet: the business's "read alongside" line with the job's
 * survey report number, or null. Read only (nothing is saved until the owner changes something).
 */
export async function surveyQuoteNote(jobId: string): Promise<string | null> {
  await requireSession();
  if (isDemo()) {
    const s = demoSurveyRows().find((x) => x.jobId === jobId && x.status === 'final');
    return s ? quoteLinkLine(FJC_WORDING.survey, s.number) : null;
  }
  const client = await ownerClient();
  const d = await client.from('documents').select('number, status').eq('job_id', jobId).eq('type', 'survey_report').maybeSingle();
  const doc = d.data as { number?: string; status?: string } | null;
  if (!doc?.number || doc.status === 'draft') return null;
  const t = await client.from('tenant_defaults').select('terms').maybeSingle();
  const w = tenantWordingSchema.safeParse((t.data as { terms?: unknown } | null)?.terms);
  return quoteLinkLine(w.success ? w.data.survey : null, doc.number);
}
