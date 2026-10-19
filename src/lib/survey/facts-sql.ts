/**
 * Loads a survey report's facts on a service connection. As everywhere on that connection, EVERY query is filtered
 * by the tenant from the session.
 */
import type { Db } from '../../security/login-guard';
import { brandWith, businessWith, type DocumentHead, type Loaded } from '../documents/facts-sql';
import { surveyFormSchema, type SurveyFormValues } from './model';
import type { PhotoRef, SurveyFacts } from './map';

export function parseSurveyInput(input: unknown): SurveyFormValues | null {
  const r = surveyFormSchema.safeParse((input as { survey?: unknown } | null)?.survey);
  return r.success ? r.data : null;
}

export async function jobPhotosWith(db: Db, tenantId: string, jobId: string): Promise<Record<string, PhotoRef>> {
  const r = await db.query(
    `select id, storage_path, sha256, width, height from public.job_photos where job_id = $1 and tenant_id = $2 and sha256 is not null order by created_at, id limit 500`,
    [jobId, tenantId],
  );
  const out: Record<string, PhotoRef> = {};
  for (const p of r.rows) out[String(p.id)] = { id: String(p.id), path: String(p.storage_path), sha256: String(p.sha256), width: Number(p.width) || 0, height: Number(p.height) || 0 };
  return out;
}

export async function loadSurveyWith(db: Db, tenantId: string, head: DocumentHead): Promise<Loaded> {
  const problems: string[] = [];
  const newest = head.versions[0] ?? null;
  const form = newest ? parseSurveyInput(newest.input) : null;
  const cr = await db.query(`select name from public.customers where id = $1 and tenant_id = $2`, [head.customerId, tenantId]);
  if (!cr.rows[0]) problems.push('The job or customer for this document could not be found.');
  const photos = await jobPhotosWith(db, tenantId, head.jobId);
  const biz = await businessWith(db, tenantId);
  problems.push(...biz.problems);
  const brand = await brandWith(db, tenantId, biz.slug);
  problems.push(...brand.problems);
  const survey: SurveyFacts = { number: head.number, jobReference: head.quoteNumber, customerName: String(cr.rows[0]?.name ?? ''), form, photos };
  return { head, facts: null, problems, business: biz.business, brand: brand.brand, bankLabel: null, bankAccountId: null, survey };
}
