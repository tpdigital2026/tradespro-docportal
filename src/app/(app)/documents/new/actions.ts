'use server';

import { checkQuoteNumber, getQuoteVatRateBp, isKnownId, QuoteError, saveQuoteDraft, type QuoteErrorCode } from '../../../../lib/data/quotes';
import { APPROVAL_MESSAGES, checkApprovedScope, upgradeLegacyApproval } from '../../../../lib/data/scope';
import { requireSession } from '../../../../lib/session';
import { approvalState } from '../../../../lib/scope/model';
import { normaliseQuote, quoteFormSchema, stepOfError, type QuoteErrors, type QuoteFormValues, type QuoteStep } from '../../../../lib/validation/quote';
import { logFinish } from './finish-log';

export type SaveResult =
  | { ok: true; jobId: string; documentId: string; savedAt: string; quoteNumber: string; customerId: string }
  | { ok: false; code: QuoteErrorCode; message: string; errors?: QuoteErrors };

/** Where the owner is sent to put a refusal right. */
export interface FixTarget {
  step: QuoteStep;
  /** Open the Scope step on its wording check rather than the steps. */
  scopeView?: 'review';
  label: string;
}

export type FinishResult =
  | { ok: true; jobId: string; documentId: string; href: string; quoteNumber: string; customerId: string; savedAt: string }
  | {
      ok: false;
      code: QuoteErrorCode;
      /** What is wrong, in plain words. */
      message: string;
      errors?: QuoteErrors;
      /** True when the draft itself was saved (only the step to the preview was refused). */
      saved: boolean;
      fix?: FixTarget;
      /** A short, safe reference for support. Never carries any of the quote. */
      diag: string;
      /** Saved draft identifiers, when the save went through. */
      jobId?: string;
      quoteNumber?: string;
      customerId?: string;
    };

const GENERIC = 'We could not save that. Please try again.';

function toResult(e: unknown): SaveResult {
  if (e instanceof QuoteError) return { ok: false, code: e.code, message: e.message, errors: e.errors };
  return { ok: false, code: 'failed', message: GENERIC };
}

function readForm(raw: unknown): QuoteFormValues | null {
  const r = quoteFormSchema.safeParse(raw);
  return r.success ? (r.data as QuoteFormValues) : null;
}

function readJobId(raw: unknown): string | null | undefined {
  if (raw === null || raw === undefined || raw === '') return null;
  return isKnownId(raw) ? raw : undefined;
}

/** Autosave. The tenant comes from the session; everything from the browser is re-validated here. */
export async function saveDraftAction(raw: unknown, jobIdRaw: unknown): Promise<SaveResult> {
  await requireSession();
  const form = readForm(raw);
  const jobId = readJobId(jobIdRaw);
  if (!form || jobId === undefined) return { ok: false, code: 'invalid', message: GENERIC };
  try {
    const saved = await saveQuoteDraft(form, jobId);
    return { ok: true, jobId: saved.jobId, documentId: saved.documentId, savedAt: saved.savedAt, quoteNumber: saved.quoteNumber, customerId: saved.customerId };
  } catch (e) {
    return toResult(e);
  }
}

export type NumberCheck = { status: 'free' | 'taken' | 'invalid' | 'error' };

/** Is this quote number free? Only the format and the answer are returned, never anything about who holds it. */
export async function checkNumberAction(numberRaw: unknown): Promise<NumberCheck> {
  await requireSession();
  if (typeof numberRaw !== 'string' || numberRaw.length > 60) return { status: 'invalid' };
  try {
    const n = numberRaw.trim();
    const free = await checkQuoteNumber(n);
    return { status: free ? 'free' : 'taken' };
  } catch {
    return { status: 'error' };
  }
}

const STEP_FIX: Record<QuoteStep, string> = {
  customer: 'Open the Customer step',
  job: 'Open the Job step',
  scope: 'Open the Scope step',
  price: 'Open the Price step',
  plan: 'Open the Plan step',
  review: 'Check the review',
};

const ORDER: QuoteStep[] = ['customer', 'job', 'scope', 'price', 'plan', 'review'];

/**
 * "Preview the document" on the review step. Every outcome comes back as a result the screen shows next to the
 * button; nothing here redirects, so nothing can be lost between the server and the screen.
 *  1. The draft is saved as it stands (so nothing typed is lost, whatever happens next).
 *  2. An approval made under the first fingerprint is checked against it and upgraded, when the audit trail proves it.
 *  3. The strict check runs against the business's own VAT rate.
 *  4. The approval on the STORED draft must be real (fingerprint and audit row); the browser's word counts for nothing.
 * Then the screen goes to the preview, where the real pages are read, ticked and finalised.
 */
export async function finishQuoteAction(raw: unknown, jobIdRaw: unknown): Promise<FinishResult> {
  const session = await requireSession();
  const form = readForm(raw);
  const jobId = readJobId(jobIdRaw);
  if (!form || jobId === undefined) {
    logFinish('QF-FORM', null);
    return { ok: false, code: 'invalid', message: 'Nothing was saved because the quote could not be read. Reload the page and try again.', saved: false, diag: 'QF-FORM' };
  }

  // 1. save the draft (the reference and the customer come back from the stored job, never from the form)
  let saved: Awaited<ReturnType<typeof saveQuoteDraft>>;
  try {
    saved = await saveQuoteDraft(form, jobId);
  } catch (e) {
    const r = toResult(e);
    if (r.ok) throw new Error('unreachable');
    const first = r.errors ? Object.keys(r.errors).map(stepOfError).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0] : undefined;
    const diag = r.code === 'failed' ? 'QF-SAVE' : `QF-SAVE-${r.code.toUpperCase()}`;
    logFinish(diag, jobId);
    return { ok: false, code: r.code, message: `Nothing was saved because ${lower(r.message)}`, errors: r.errors, saved: false, diag, fix: first ? { step: first, label: STEP_FIX[first] } : undefined };
  }
  const ids = { jobId: saved.jobId, quoteNumber: saved.quoteNumber, customerId: saved.customerId };

  // 2. an approval from before 15 October: checked against the old fingerprint and its audit row, then upgraded
  const upgrade = await upgradeLegacyApproval({ userId: session.userId, tenantId: session.tenantId }, saved.jobId).catch(() => 'failed' as const);
  if (upgrade === 'upgraded') logFinish('QF-SCOPE-UPGRADED', saved.jobId);

  // 3. the strict check (the approval itself is checked on the stored draft below, not on what the browser holds)
  let vatRateBp: number;
  try {
    vatRateBp = await getQuoteVatRateBp();
  } catch (e) {
    logFinish('QF-VAT', saved.jobId);
    return { ok: false, code: 'failed', message: e instanceof QuoteError ? e.message : 'We could not load your VAT setting. Please try again.', saved: true, diag: 'QF-VAT', ...ids };
  }
  const { errors: all } = normaliseQuote(form, 'final', vatRateBp);
  const errors: QuoteErrors = Object.fromEntries(Object.entries(all).filter(([k]) => k !== 'scope.approval'));
  const keys = Object.keys(errors);
  if (keys.length > 0) {
    const first = keys.map((k) => ({ k, s: stepOfError(k) })).sort((a, b) => ORDER.indexOf(a.s) - ORDER.indexOf(b.s))[0]!;
    logFinish('QF-CHECK', saved.jobId);
    return {
      ok: false,
      code: 'invalid',
      message: keys.length === 1 ? errors[first.k]! : `${errors[first.k]!} (and ${keys.length - 1} more ${keys.length === 2 ? 'thing' : 'things'} to fix)`,
      errors,
      saved: true,
      diag: 'QF-CHECK',
      fix: { step: first.s, label: STEP_FIX[first.s] },
      ...ids,
    };
  }

  // 4. the approval on the stored draft, with its audit row
  const checked = await checkApprovedScope(session.tenantId, saved.jobId);
  // The save drops an approval that cannot count any more. If the screen was holding one (an approval from before
  // fingerprints, say), say it needs making again rather than that it never happened. Only the wording of the
  // message follows the browser here; whether the quote may go ahead never does.
  const held = approvalState(form.scope);
  const approval = !checked.ok && checked.problem === 'not_approved' && (held === 'legacy' || held === 'out_of_date') ? { ok: false as const, problem: 'out_of_date' as const } : checked;
  if (!approval.ok) {
    const diag = `QF-SCOPE-${approval.problem.toUpperCase().replace(/_/g, '-')}`;
    logFinish(diag, saved.jobId);
    const message = APPROVAL_MESSAGES[approval.problem];
    return {
      ok: false,
      code: approval.problem === 'check_failed' ? 'failed' : 'invalid',
      message,
      errors: approval.problem === 'check_failed' ? undefined : { 'scope.approval': message },
      saved: true,
      diag,
      fix: approval.problem === 'check_failed' || approval.problem === 'no_draft' ? undefined : { step: 'scope', scopeView: 'review', label: 'Open the Scope step' },
      ...ids,
    };
  }

  return { ok: true, documentId: saved.documentId, href: `/documents/${encodeURIComponent(saved.documentId)}/preview`, savedAt: saved.savedAt, ...ids };
}

/** "Save and come back later": saves the draft as it stands (no strict check) and sends the owner Home with a notice. */
export async function saveForLaterAction(raw: unknown, jobIdRaw: unknown): Promise<FinishResult> {
  await requireSession();
  const form = readForm(raw);
  const jobId = readJobId(jobIdRaw);
  if (!form || jobId === undefined) {
    logFinish('QL-FORM', null);
    return { ok: false, code: 'invalid', message: 'Nothing was saved because the quote could not be read. Reload the page and try again.', saved: false, diag: 'QL-FORM' };
  }
  try {
    const s = await saveQuoteDraft(form, jobId);
    return { ok: true, jobId: s.jobId, documentId: s.documentId, quoteNumber: s.quoteNumber, customerId: s.customerId, savedAt: s.savedAt, href: `/?quote=${encodeURIComponent(s.quoteNumber)}` };
  } catch (e) {
    const r = toResult(e);
    if (r.ok) throw new Error('unreachable');
    const diag = r.code === 'failed' ? 'QL-SAVE' : `QL-SAVE-${r.code.toUpperCase()}`;
    logFinish(diag, jobId);
    const first = r.errors ? Object.keys(r.errors).map(stepOfError).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0] : undefined;
    return { ok: false, code: r.code, message: `Nothing was saved because ${lower(r.message)}`, errors: r.errors, saved: false, diag, fix: first ? { step: first, label: STEP_FIX[first] } : undefined };
  }
}

/** "Could not save" reads as "Nothing was saved because we could not save"; anything else keeps its words. */
function lower(m: string): string {
  const t = m.trim().replace(/\.$/, '');
  if (/^could not save$/i.test(t) || t === GENERIC.replace(/\.$/, '') || /^we could not save that/i.test(t)) return 'the connection to the server failed. Please try again.';
  return `${t.charAt(0).toLowerCase()}${t.slice(1)}.`;
}
