'use server';

import { z } from 'zod';
import { approveScopeWith, generateForOwner, type ApproveOutcome, type GenerateOutcome } from '../../../../lib/data/scope';
import { isKnownId } from '../../../../lib/data/quotes';
import { scopeItemSchema, SCOPE_LIMITS } from '../../../../lib/scope/model';
import { requireSession } from '../../../../lib/session';
import { quoteFormSchema, type QuoteFormValues } from '../../../../lib/validation/quote';

const generateInput = z.object({ items: z.array(scopeItemSchema).max(SCOPE_LIMITS.items), jobTypeId: z.string().max(80) });
const GENERIC = 'We could not do that. Please try again.';

/** "Generate copy". The person and business come from the session; the steps are checked again here. */
export async function generateScopeCopyAction(raw: unknown): Promise<GenerateOutcome> {
  const s = await requireSession();
  const parsed = generateInput.safeParse(raw);
  if (!parsed.success) return { ok: false, code: 'failed', message: GENERIC };
  const jobTypeId = isKnownId(parsed.data.jobTypeId) ? parsed.data.jobTypeId : '';
  return generateForOwner({ userId: s.userId, tenantId: s.tenantId }, parsed.data.items, jobTypeId);
}

/** "Approve this copy". Saves the draft with the approval time (set here, not by the browser) and records it. */
export async function approveScopeAction(raw: unknown, jobIdRaw: unknown): Promise<ApproveOutcome> {
  const s = await requireSession();
  const form = quoteFormSchema.safeParse(raw);
  const jobId = jobIdRaw === null || jobIdRaw === undefined || jobIdRaw === '' ? null : isKnownId(jobIdRaw) ? jobIdRaw : undefined;
  if (!form.success || jobId === undefined) return { ok: false, code: 'invalid', message: GENERIC };
  return approveScopeWith({ userId: s.userId, tenantId: s.tenantId }, form.data as QuoteFormValues, jobId);
}
