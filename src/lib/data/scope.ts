import { generateScopeCopy, SCOPE_COPY_PROMPT_VERSION, type GenerateDeps, type GenerateResult } from '../../ai/scope-copy';
import { scopeCopyLimiter } from '../../ai/limits';
import { writeAudit } from '../../security/audit';
import { isDemo } from '../demo';
import { compactId, withServiceConnection, type ServiceDb } from './customer-admin';
import { getJobTypeLabel, QuoteError, saveQuoteDraft, type SavedDraft } from './quotes';
import { copyErrors, countSteps, scopeKey, type ScopeCopy, type ScopeItem } from '../scope/model';
import type { QuoteFormValues } from '../validation/quote';

/** What the browser gets back from "Generate copy". The copy is not approved. */
export type GenerateOutcome =
  | { ok: true; copy: ScopeCopy; notice: string | null; promptVersion: string }
  | { ok: false; code: 'limit' | 'empty' | 'failed'; message: string };

export const LIMIT_MESSAGE = 'You have tidied the wording a lot in the last few minutes. Wait a little and try again.';
const FAILED = 'We could not tidy that just now. Please try again.';

interface Who {
  userId: string;
  tenantId: string;
}

/** Runs the engine for one person's steps. Rate limited per person. Never keeps or logs the text. */
export async function generateForOwner(
  who: Who,
  steps: readonly ScopeItem[],
  jobTypeId: string,
  deps: GenerateDeps & { now?: () => Date; recordRun?: (r: GenerateResult) => Promise<void>; label?: (id: string) => Promise<string> } = {},
): Promise<GenerateOutcome> {
  if (countSteps(steps) === 0) return { ok: false, code: 'empty', message: 'Add at least one step first.' };
  if (!scopeCopyLimiter.take(who.userId)) return { ok: false, code: 'limit', message: LIMIT_MESSAGE };
  try {
    const label = await (deps.label ?? getJobTypeLabel)(jobTypeId).catch(() => '');
    const result = await generateScopeCopy({ steps, jobType: label }, deps);
    await (deps.recordRun ?? ((r) => recordAiRun(who.tenantId, r)))(result).catch(() => undefined);
    return {
      ok: true,
      notice: result.notice,
      promptVersion: SCOPE_COPY_PROMPT_VERSION,
      copy: {
        sections: result.sections,
        corrections: result.corrections,
        uncertain: result.uncertain,
        engine: result.engine,
        generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
        sourceKey: scopeKey(steps),
        approvedAt: null,
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
  | { ok: true; approvedAt: string; saved: SavedDraft | null }
  | { ok: false; code: 'invalid' | 'stale' | 'failed' | 'save'; message: string };

export interface ApproveDeps {
  now?: () => Date;
  save?: (form: QuoteFormValues, jobId: string | null) => Promise<SavedDraft>;
  audit?: (db: ServiceDb | null, entry: Parameters<typeof writeAudit>[1]) => Promise<void>;
}

/**
 * Approving the wording. The time comes from the server. The copy is saved with the draft (so the approval and the
 * steps it covers are stored together) and the audit trail gets the job's id, the engine and counts, nothing else.
 */
export async function approveScopeWith(who: Who, form: QuoteFormValues, jobId: string | null, deps: ApproveDeps = {}): Promise<ApproveOutcome> {
  const scope = form.scope;
  const copy = scope.copy;
  if (!copy || countSteps(scope.items) === 0) return { ok: false, code: 'invalid', message: 'Generate the copy first.' };
  if (copy.sourceKey !== scopeKey(scope.items)) return { ok: false, code: 'stale', message: 'The steps changed after the wording was made. Generate the copy again.' };
  const bad = Object.values(copyErrors(copy))[0];
  if (bad) return { ok: false, code: 'invalid', message: bad };

  const approvedAt = (deps.now ?? (() => new Date()))().toISOString();
  const approved = { ...form, scope: { ...scope, copy: { ...copy, approvedAt } } };
  let saved: SavedDraft;
  try {
    saved = await (deps.save ?? saveQuoteDraft)(approved, jobId);
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
    meta: { engine: copy.engine, sections: copy.sections.length, steps: countSteps(scope.items) },
  };
  try {
    if (deps.audit) await deps.audit(null, entry);
    else if (!isDemo()) await withServiceConnection((db) => writeAudit(db, entry));
  } catch {
    // No record, no approval: put the draft back to unapproved.
    await (deps.save ?? saveQuoteDraft)({ ...form, scope: { ...scope, copy: { ...copy, approvedAt: null } } }, saved.jobId).catch(() => undefined);
    return { ok: false, code: 'failed', message: 'We could not record the approval. Please try again.' };
  }
  return { ok: true, approvedAt, saved };
}
