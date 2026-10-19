import { generateScopeCopy, SCOPE_COPY_PROMPT_VERSION, type GenerateDeps, type GenerateResult } from '../../ai/scope-copy';
import { scopeCopyLimiter } from '../../ai/limits';
import { writeAudit } from '../../security/audit';
import type { Db } from '../../security/login-guard';
import { isDemo } from '../demo';
import { compactId, withServiceConnection, type ServiceDb } from './customer-admin';
import { getJobTypeLabel, getQuoteDraft, QuoteError, saveQuoteDraft, storedScopeWith, type SaveOptions, type SavedDraft } from './quotes';
import { ownerClient } from './customers';
import { APPROVAL_OUT_OF_DATE, approvalHash, approvalHashV1, approvalState, copyErrors, countSteps, isApproved, scopeKey, sectionsKey, withoutApproval, type ScopeCopy, type ScopeFormValues, type ScopeItem } from '../scope/model';
import { sameGeneration, signGenerated, verifyGenerated } from '../scope/proof';
import type { QuoteFormValues } from '../validation/quote';

/** What the browser gets back from "Generate copy". The copy is not approved. */
export type GenerateOutcome =
  | { ok: true; copy: ScopeCopy; notice: string | null; promptVersion: string }
  | { ok: false; code: 'empty' | 'failed'; message: string };

export const LIMIT_MESSAGE = 'You have used the AI assistant a lot in the last few minutes, so the basic tidy was used this time. Try the AI again in a little while.';
export { COPY_TOO_OLD } from '../scope/model';
import { COPY_TOO_OLD } from '../scope/model';
const FAILED = 'We could not tidy that just now. Please try again.';

interface Who {
  userId: string;
  tenantId: string;
}

/**
 * Runs the engine for one person's steps. Only a real AI call counts against the person's limit (the basic tidy is
 * free); over the limit they get the basic tidy and are told. Never keeps or logs the text.
 */
export async function generateForOwner(
  who: Who,
  steps: readonly ScopeItem[],
  jobTypeId: string,
  deps: GenerateDeps & { now?: () => Date; recordRun?: (r: GenerateResult) => Promise<void>; label?: (id: string) => Promise<string> } = {},
): Promise<GenerateOutcome> {
  if (countSteps(steps) === 0) return { ok: false, code: 'empty', message: 'Add at least one step first.' };
  // The person's limit is taken only when a model call is really about to be made (not for a skipped step, not for the basic tidy).
  const useDeps: GenerateDeps = { ...deps, permit: () => scopeCopyLimiter.take(who.userId) };
  try {
    const label = await (deps.label ?? getJobTypeLabel)(jobTypeId).catch(() => '');
    const result = await generateScopeCopy({ steps, jobType: label }, useDeps);
    await (deps.recordRun ?? ((r) => recordAiRun(who.tenantId, r)))(result).catch(() => undefined);
    const base = {
      engine: result.engine,
      generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
      sourceKey: scopeKey(steps),
      genKey: sectionsKey(result.sections),
    };
    return {
      ok: true,
      notice: result.limited ? LIMIT_MESSAGE : result.notice,
      promptVersion: SCOPE_COPY_PROMPT_VERSION,
      copy: {
        sections: result.sections,
        corrections: result.corrections,
        uncertain: result.uncertain,
        ...base,
        proof: signGenerated(who.tenantId, base),
        approvedAt: null,
        approvalHash: null,
      },
    };
  } catch {
    return { ok: false, code: 'failed', message: FAILED };
  }
}

/** One row per model call: the model and the token counts, never the wording. */
async function recordAiRun(tenantId: string, r: GenerateResult): Promise<void> {
  if (!r.usage || isDemo()) return;
  const u = r.usage;
  await withServiceConnection((db) =>
    db.query('insert into public.ai_runs (tenant_id, model, input_tokens, output_tokens, valid) values ($1, $2, $3, $4, $5)', [tenantId, u.model, u.inputTokens, u.outputTokens, u.valid]),
  );
}

export type ApproveOutcome =
  | { ok: true; approvedAt: string; approvalHash: string; saved: SavedDraft | null }
  | { ok: false; code: 'invalid' | 'stale' | 'failed' | 'save'; message: string };

export interface ApproveDeps {
  now?: () => Date;
  save?: (form: QuoteFormValues, jobId: string | null, opts?: SaveOptions) => Promise<SavedDraft>;
  audit?: (db: ServiceDb | null, entry: Parameters<typeof writeAudit>[1]) => Promise<void>;
  /** The draft as it is stored right now. Used to undo an approval only if it is still the current one. */
  loadCurrent?: (jobId: string) => Promise<QuoteFormValues | null>;
  /** The scope as stored for this draft, so wording already saved with it can be approved after its proof's day. */
  loadStored?: (jobId: string) => Promise<ScopeFormValues | null>;
}

const loadStoredScope = async (jobId: string): Promise<ScopeFormValues | null> =>
  isDemo() ? ((await getQuoteDraft(jobId))?.values.scope ?? null) : storedScopeWith(await ownerClient(), jobId);

/**
 * Approving the wording, the only place an approval is made. The time and the fingerprint come from the server. The
 * generated copy must carry the server's proof (so its engine and source are real). The copy is saved with the
 * draft (approval and the exact content it covers together) and the audit trail gets the job id, the engine, counts
 * and the fingerprint, nothing else. If the audit cannot be written the approval is taken back.
 */
export async function approveScopeWith(who: Who, form: QuoteFormValues, jobId: string | null, deps: ApproveDeps = {}): Promise<ApproveOutcome> {
  const scope = form.scope;
  const copy = scope.copy;
  if (!copy || countSteps(scope.items) === 0) return { ok: false, code: 'invalid', message: 'Generate the copy first.' };
  // Wording already saved with this very draft (same proof, same time) was checked when it was saved. Approving it
  // again later (an approval that has gone out of date) must not force new wording, so its day does not apply.
  const storedCopy = jobId ? ((await (deps.loadStored ?? loadStoredScope)(jobId).catch(() => null))?.copy ?? null) : null;
  const alreadyStored = sameGeneration(copy, storedCopy);
  if (!verifyGenerated(who.tenantId, copy, { allowExpired: alreadyStored })) {
    // Genuine but more than a day old: say so, rather than a generic refusal.
    if (verifyGenerated(who.tenantId, copy, { allowExpired: true })) return { ok: false, code: 'invalid', message: COPY_TOO_OLD };
    return { ok: false, code: 'invalid', message: 'Generate the copy again, then approve it.' };
  }
  if (copy.sourceKey !== scopeKey(scope.items)) return { ok: false, code: 'stale', message: 'The steps changed after the wording was made. Generate the copy again.' };
  const bad = Object.values(copyErrors(copy))[0];
  if (bad) return { ok: false, code: 'invalid', message: bad };

  const approvedAt = (deps.now ?? (() => new Date()))().toISOString();
  const hash = approvalHash(scope);
  const approved = { ...form, scope: { ...scope, copy: { ...copy, approvedAt, approvalHash: hash } } };
  const save = deps.save ?? saveQuoteDraft;
  let saved: SavedDraft;
  try {
    saved = await save(approved, jobId, { trustApproval: true });
  } catch (e) {
    if (e instanceof QuoteError) return { ok: false, code: 'save', message: e.message };
    return { ok: false, code: 'failed', message: 'We could not save that. Please try again.' };
  }

  const entry = {
    tenantId: who.tenantId,
    userId: who.userId,
    action: 'scope.approve',
    entity: 'job',
    entityId: compactId(saved.jobId),
    meta: { engine: copy.engine, sections: copy.sections.length, steps: countSteps(scope.items), hash },
  };
  try {
    if (deps.audit) await deps.audit(null, entry);
    else if (!isDemo()) await withServiceConnection((db) => writeAudit(db, entry));
  } catch {
    // No record, no approval: put the draft back to unapproved, but only if the stored draft still carries THIS
    // approval. If the owner has saved something newer since, that save has already settled the approval (it keeps
    // it only when the content still matches) and is left exactly as it is. An approval without an audit row never
    // lets a quote finish anyway, so this undo is tidiness, not the safeguard.
    try {
      const current = await (deps.loadCurrent ?? (async (id) => (await getQuoteDraft(id))?.values ?? null))(saved.jobId);
      if (current?.scope.copy?.approvalHash === hash) await save({ ...current, scope: withoutApproval(current.scope) }, saved.jobId, { trustApproval: true });
    } catch {
      // Leave it: finishing still needs the audit row.
    }
    return { ok: false, code: 'failed', message: 'We could not record the approval. Please try again.' };
  }
  return { ok: true, approvedAt, approvalHash: hash, saved };
}

export interface ApprovalCheckDeps {
  load?: (jobId: string) => Promise<ScopeFormValues | null>;
  /** Is there an audit row for this approval? */
  audited?: (tenantId: string, jobId: string, hash: string) => Promise<boolean>;
}

/** Why a stored approval does not let a quote go ahead. The codes are safe to log: they never carry content. */
export type ApprovalProblem = 'no_draft' | 'not_approved' | 'out_of_date' | 'no_record' | 'check_failed';

export const APPROVAL_MESSAGES: Record<ApprovalProblem, string> = {
  no_draft: 'We could not find the saved draft. Go back to Home and open it again.',
  not_approved: 'The wording has not been approved yet. Open the Scope step, check the wording and approve it.',
  out_of_date: APPROVAL_OUT_OF_DATE,
  no_record: 'We have no record of the wording being approved. Open the Scope step and approve it again.',
  check_failed: 'We could not check the approved wording just now. Please try again in a moment.',
};

/**
 * Before a quote goes ahead: the approval on the STORED draft must be real. The stored steps, wording and note must
 * still hash to the approved fingerprint, and the audit trail must hold the approval of that very fingerprint.
 */
export async function checkApprovedScope(tenantId: string, jobId: string, deps: ApprovalCheckDeps = {}): Promise<{ ok: true } | { ok: false; problem: ApprovalProblem }> {
  let stored: ScopeFormValues | null;
  try {
    stored = await (deps.load ?? loadStoredScope)(jobId);
  } catch {
    return { ok: false, problem: 'check_failed' };
  }
  if (!stored) return { ok: false, problem: 'no_draft' };
  const st = approvalState(stored);
  if (st === 'none') return { ok: false, problem: 'not_approved' };
  if (st !== 'approved' || !stored.copy?.approvalHash) return { ok: false, problem: 'out_of_date' };
  if (isDemo() && !deps.audited) return { ok: true };
  try {
    const ok = await (deps.audited ?? auditedApproval)(tenantId, jobId, stored.copy.approvalHash);
    return ok ? { ok: true } : { ok: false, problem: 'no_record' };
  } catch {
    return { ok: false, problem: 'check_failed' };
  }
}

/** The throwing form, for callers that only need yes or no. The message says exactly what is wrong. */
export async function requireApprovedScope(tenantId: string, jobId: string, deps: ApprovalCheckDeps = {}): Promise<void> {
  const r = await checkApprovedScope(tenantId, jobId, deps);
  if (!r.ok) throw new QuoteError(r.problem === 'check_failed' ? 'failed' : 'invalid', APPROVAL_MESSAGES[r.problem], { 'scope.approval': APPROVAL_MESSAGES[r.problem] });
}

/** Is there an audit row for exactly this approval (this business, this job, this fingerprint)? */
export async function auditedApprovalWith(db: Db, tenantId: string, jobId: string, hash: string): Promise<boolean> {
  const r = await db.query(`select 1 from public.audit_log where tenant_id = $1 and action = 'scope.approve' and entity = 'job' and entity_id = $2 and meta->>'hash' = $3 limit 1`, [tenantId, compactId(jobId), hash]);
  return r.rows.length > 0;
}

/** Who approved this fingerprint for this job, from the audit trail (the newest row), or null when nobody did. */
export async function approverOfWith(db: Db, tenantId: string, jobId: string, hash: string): Promise<string | null> {
  const r = await db.query(
    `select user_id from public.audit_log where tenant_id = $1 and action = 'scope.approve' and entity = 'job' and entity_id = $2 and meta->>'hash' = $3 order by at desc, id desc limit 1`,
    [tenantId, compactId(jobId), hash],
  );
  const u = (r.rows[0] as { user_id?: unknown } | undefined)?.user_id;
  return typeof u === 'string' ? u : null;
}

const auditedApproval = (tenantId: string, jobId: string, hash: string) => withServiceConnection((db) => auditedApprovalWith(db, tenantId, jobId, hash));

export type UpgradeOutcome = 'current' | 'upgraded' | 'needs_approval' | 'not_approved' | 'failed';

export interface UpgradeDeps {
  loadForm?: (jobId: string) => Promise<QuoteFormValues | null>;
  save?: (form: QuoteFormValues, jobId: string, opts: SaveOptions) => Promise<SavedDraft>;
  /** The person recorded as approving this fingerprint for this job, or null. */
  approverOf?: (tenantId: string, jobId: string, hash: string) => Promise<string | null>;
  audit?: (entry: Parameters<typeof writeAudit>[1]) => Promise<void>;
}

/**
 * An approval made under the first fingerprint (before 15 October 2026, when the cover and introduction were added
 * to it) is upgraded to today's fingerprint, but only when all of this holds:
 *  - the stored content still hashes to the old fingerprint exactly (nothing it covered has changed);
 *  - the audit trail holds the approval of that old fingerprint for this job, made by the person asking now.
 * The upgrade keeps the original approval time, is recorded in the audit trail as its own row (with both
 * fingerprints, no content), and only then saved. Anything less and the owner is asked to approve again.
 */
export async function upgradeLegacyApproval(who: Who, jobId: string, deps: UpgradeDeps = {}): Promise<UpgradeOutcome> {
  let form: QuoteFormValues | null;
  try {
    form = await (deps.loadForm ?? (async (id) => (await getQuoteDraft(id))?.values ?? null))(jobId);
  } catch {
    return 'failed';
  }
  if (!form) return 'failed';
  const st = approvalState(form.scope);
  if (st === 'approved') return 'current';
  if (st === 'none') return 'not_approved';
  if (st !== 'legacy') return 'needs_approval';
  const copy = form.scope.copy!;
  const oldHash = approvalHashV1(form.scope);
  if (copy.approvalHash !== oldHash) return 'needs_approval';
  const demo = isDemo() && !deps.approverOf;
  try {
    // In demo mode there is no audit trail to prove anything with; the dummy approval is upgraded as it stands.
    const approver = demo ? who.userId : await (deps.approverOf ?? ((t, j, h) => withServiceConnection((db) => approverOfWith(db, t, j, h))))(who.tenantId, jobId, oldHash);
    if (approver === null || approver !== who.userId) return 'needs_approval';
  } catch {
    return 'failed';
  }
  const hash = approvalHash(form.scope);
  const entry = {
    tenantId: who.tenantId,
    userId: who.userId,
    action: 'scope.approve',
    entity: 'job',
    entityId: compactId(jobId),
    meta: { engine: copy.engine, sections: copy.sections.length, steps: countSteps(form.scope.items), hash, upgradedFrom: oldHash },
  };
  try {
    // The record first: a saved fingerprint without its audit row would never let the quote go ahead anyway.
    if (deps.audit) await deps.audit(entry);
    else if (!isDemo()) await withServiceConnection((db) => writeAudit(db, entry));
    await (deps.save ?? saveQuoteDraft)({ ...form, scope: { ...form.scope, copy: { ...copy, approvalHash: hash } } }, jobId, { trustApproval: true });
  } catch {
    return 'failed';
  }
  return 'upgraded';
}
