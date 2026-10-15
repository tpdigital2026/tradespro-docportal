/**
 * The survey's approvals, checked against the audit trail. An approval counts only if the stored finding (or
 * opinion) still hashes to its approval fingerprint AND the audit log holds the approval of that very fingerprint for
 * this document. Same rule as the quote's scope wording (Task 4c).
 */
import type { Db } from '../../security/login-guard';
import { compactId } from '../data/customer-admin';
import { isFindingApproved, isOpinionApproved, type SurveyFormValues } from './model';

export const SURVEY_APPROVE_ACTION = 'survey.approve';

export async function auditedSurveyHashesWith(db: Db, tenantId: string, documentId: string, hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();
  const r = await db.query(
    `select distinct meta->>'hash' as h from public.audit_log where tenant_id = $1 and action = $2 and entity = 'document' and entity_id = $3 and meta->>'hash' = any($4::text[])`,
    [tenantId, SURVEY_APPROVE_ACTION, compactId(documentId), hashes],
  );
  return new Set(r.rows.map((x) => String(x.h)));
}

/** Plain messages for every approval that is missing or not on record. Empty: all approved and audited. */
export async function surveyApprovalProblemsWith(db: Db, tenantId: string, documentId: string, v: SurveyFormValues | null): Promise<string[]> {
  if (!v) return ['This survey has nothing saved in it yet.'];
  const out: string[] = [];
  const wanted: string[] = [];
  v.findings.forEach((f, i) => {
    if (!isFindingApproved(f) || !f.approvalHash) out.push(`Finding ${i + 1} has not been approved.`);
    else wanted.push(f.approvalHash);
  });
  if (!isOpinionApproved(v) || !v.opinionHash) out.push('Your professional opinion has not been approved.');
  else wanted.push(v.opinionHash);
  const audited = await auditedSurveyHashesWith(db, tenantId, documentId, wanted);
  v.findings.forEach((f, i) => {
    if (f.approvalHash && isFindingApproved(f) && !audited.has(f.approvalHash)) out.push(`Finding ${i + 1}: the approval is not on record. Approve it again.`);
  });
  if (v.opinionHash && isOpinionApproved(v) && !audited.has(v.opinionHash)) out.push('Your professional opinion: the approval is not on record. Approve it again.');
  // The opinion is signed by the person who approved it, in their own profile name, and by nobody else.
  if (v.opinionHash && isOpinionApproved(v) && audited.has(v.opinionHash)) {
    const r = await db.query(
      `select p.full_name from public.audit_log a join public.profiles p on p.id = a.user_id and p.tenant_id = a.tenant_id
        where a.tenant_id = $1 and a.action = $2 and a.entity = 'document' and a.entity_id = $3 and a.meta->>'hash' = $4 and a.meta->>'part' = 'opinion'`,
      [tenantId, SURVEY_APPROVE_ACTION, compactId(documentId), v.opinionHash],
    );
    const names = new Set(r.rows.map((x) => String(x.full_name ?? '').replace(/\s+/g, ' ').trim()));
    const signer = v.signName.replace(/\s+/g, ' ').trim();
    if (!names.has(signer) || v.preparedBy.replace(/\s+/g, ' ').trim() !== signer) out.push('Your professional opinion must be approved by the person who signs it. Open the report and approve it as yourself.');
  }
  return out;
}
