import type { Db } from '../security/login-guard';
import { FJC_SURVEY_WORDING, surveyWordingSchema } from './wording';

/** Adds FJC's survey report wording where the business has none yet. Never overwrites wording that is already there. */
export async function seedSurveyWording(db: Db, tenantId: string): Promise<void> {
  const wording = surveyWordingSchema.parse(FJC_SURVEY_WORDING);
  await db.query(
    `update public.tenant_defaults set terms = jsonb_set(terms, '{survey}', $2::jsonb, true)
      where tenant_id = $1 and jsonb_typeof(terms) = 'object' and not (terms ? 'survey')`,
    [tenantId, JSON.stringify(wording)],
  );
}
