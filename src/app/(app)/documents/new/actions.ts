'use server';

import { redirect } from 'next/navigation';
import { checkQuoteNumber, getQuoteVatRateBp, isKnownId, QuoteError, saveQuoteDraft, type QuoteErrorCode } from '../../../../lib/data/quotes';
import { requireApprovedScope } from '../../../../lib/data/scope';
import { requireSession } from '../../../../lib/session';
import { normaliseQuote, quoteFormSchema, type QuoteErrors, type QuoteFormValues } from '../../../../lib/validation/quote';

export type SaveResult =
  | { ok: true; jobId: string; savedAt: string; quoteNumber: string; customerId: string }
  | { ok: false; code: QuoteErrorCode; message: string; errors?: QuoteErrors };

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
    return { ok: true, jobId: saved.jobId, savedAt: saved.savedAt, quoteNumber: saved.quoteNumber, customerId: saved.customerId };
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

/**
 * "Save quote" on the review step. The strict check runs here, on the server, against the business's own VAT rate:
 * a quote whose payment plan does not total the job gross exactly is refused, whatever the browser says.
 */
export async function finishQuoteAction(raw: unknown, jobIdRaw: unknown): Promise<SaveResult> {
  const session = await requireSession();
  const form = readForm(raw);
  const jobId = readJobId(jobIdRaw);
  if (!form || jobId === undefined) return { ok: false, code: 'invalid', message: GENERIC };
  let number: string;
  try {
    const vatRateBp = await getQuoteVatRateBp();
    const { errors } = normaliseQuote(form, 'final', vatRateBp);
    if (Object.keys(errors).length > 0) return { ok: false, code: 'invalid', message: 'Check the highlighted fields', errors };
    // The reference comes back from the stored job, never from the form.
    const saved = await saveQuoteDraft(form, jobId);
    number = saved.quoteNumber;
    // The browser's word that the wording is approved counts for nothing: the stored approval and its audit row must be real.
    await requireApprovedScope(session.tenantId, saved.jobId);
  } catch (e) {
    return toResult(e);
  }
  redirect(`/?quote=${encodeURIComponent(number)}`);
}
