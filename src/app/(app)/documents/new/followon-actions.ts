'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { BillingError, saveFollowOnDraft } from '../../../../lib/data/billing';
import { isDocType, isInvoiceType } from '../../../../lib/job-stage';
import { requireSession } from '../../../../lib/session';
import { NUMBER_RE } from '../../../../lib/validation/quote';

export type FollowOnState = { message: string } | null;

const GENERIC = 'We could not save that. Please try again.';

const schema = z.object({
  job: z.string().regex(NUMBER_RE),
  type: z.string().refine((t) => isDocType(t) && (t === 'receipt' || isInvoiceType(t))),
  n: z.coerce.number().int().min(1).max(10),
  payment: z.string().max(80).optional(),
});

/**
 * "Save as draft" on an invoice or receipt that starts from a job. The browser sends only which job, which
 * document and which part of the job; every figure and the number are recomputed on the server.
 */
export async function saveFollowOnAction(_prev: FollowOnState, form: FormData): Promise<FollowOnState> {
  await requireSession();
  const parsed = schema.safeParse({
    job: form.get('job'),
    type: form.get('type'),
    n: form.get('n'),
    payment: (form.get('payment') as string | null) || undefined,
  });
  if (!parsed.success) return { message: GENERIC };
  let documentId: string;
  try {
    const saved = await saveFollowOnDraft(parsed.data.job, parsed.data.type as Parameters<typeof saveFollowOnDraft>[1], parsed.data.n, parsed.data.payment ?? null);
    documentId = saved.documentId;
  } catch (e) {
    return { message: e instanceof BillingError ? e.message : GENERIC };
  }
  revalidatePath('/', 'layout');
  // A receipt made straight after recording its payment opens in the preview; otherwise the draft page to check first.
  if (form.get('open') === 'preview' && parsed.data.type === 'receipt') redirect(`/documents/${encodeURIComponent(documentId)}/preview`);
  redirect(`/documents/${encodeURIComponent(documentId)}?saved=1`);
}
