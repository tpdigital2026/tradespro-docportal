import { generateScopeCopy, SCOPE_COPY_PROMPT_VERSION, type GenerateDeps, type GenerateResult } from '../../ai/scope-copy';
import { scopeCopyLimiter } from '../../ai/limits';
import { writeAudit } from '../../security/audit';
import type { Db } from '../../security/login-guard';
import { isDemo } from '../demo';
import { compactId, withServiceConnection, type ServiceDb } from './customer-admin';
import { getJobTypeLabel, getQuoteDraft, QuoteError, saveQuoteDraft, storedScopeWith, type SaveOptions, type SavedDraft } from './quotes';
import { ownerClient } from './customers';
import { approvalHash, copyErrors, countSteps, isApproved, scopeKey, sectionsKey, withoutApproval, type ScopeCopy, type ScopeFormValues, type ScopeItem } from '../scope/model';
import { signGenerated, verifyGenerated } from '../scope/proof';
import type { QuoteFormValues } from '../validation/quote';

/** What the browser gets back from "Generate copy". The copy is not approved. */
export type GenerateOutcome =
  | { ok: true; copy: ScopeCopy; notice: string | null; promptVersion: string }
  | { ok: false; code: 'empty' | 'failed'; message: string };

export const LIMIT_MESSAGE = 'You have used the AI assistant a lot in the last few minutes, so the basic tidy was used this time. Try the AI again in a little while.';
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
}

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
  if (!verifyGenerated(who.tenantId, copy)) return { ok: false, code: 'invalid', message: 'Generate the copy again, then approve it.' };
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

/**
 * Before a quote is finished: the approval on the STORED draft must be real. The stored steps, wording and note must
 * still hash to the approved fingerprint, and the audit trail must hold the approval of that very fingerprint.
 */
export async function requireApprovedScope(tenantId: string, jobId: string, deps: ApprovalCheckDeps = {}): Promise<void> {
  const refuse = (): never => {
    throw new QuoteError('invalid', 'The wording has not been approved. Go back to the scope step.', { 'scope.approval': 'Check the wording and approve it before the price.' });
  };
  const stored = await (deps.load ?? (async (id) => (isDemo() ? ((await getQuoteDraft(id))?.values.scope ?? null) : storedScopeWith(await ownerClient(), id))))(jobId);
  if (!stored || !isApproved(stored) || !stored.copy?.approvalHash) return refuse();
  if (isDemo() && !deps.audited) return;
  const hash = stored.copy.approvalHash;
  const ok = await (deps.audited ?? auditedApproval)(tenantId, jobId, hash).catch(() => false);
  if (!ok) refuse();
}

/** Is there an audit row for exactly this approval (this business, this job, this fingerprint)? */
export async function auditedApprovalWith(db: Db, tenantId: string, jobId: string, hash: string): Promise<boolean> {
  const r = await db.query(`select 1 from public.audit_log where tenant_id = $1 and action = 'scope.approve' and entity = 'job' and entity_id = $2 and meta->>'hash' = $3 limit 1`, [tenantId, compactId(jobId), hash]);
  return r.rows.length > 0;
}

const auditedApproval = (tenantId: string, jobId: string, hash: string) => withServiceConnection((db) => auditedApprovalWith(db, tenantId, jobId, hash));
