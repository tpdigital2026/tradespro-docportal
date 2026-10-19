'use server';

import { z } from 'zod';
import { createRateLimiter } from '../../../../ai/rate-limit';
import { GuaranteeError, saveGuarantee, type SavedGuarantee } from '../../../../lib/data/guarantees';
import { isKnownId } from '../../../../lib/data/quotes';
import { requireSession } from '../../../../lib/session';

const GENERIC = 'We could not save that. Please try again.';

export type GuaranteeOutcome = { ok: true; value: SavedGuarantee } | { ok: false; message: string; field?: string; existingId?: string };

const values = z.object({
  roofType: z.enum(['', 'flat', 'tiled', 'dormer', 'pitched', 'other']),
  roofOther: z.string().max(200),
  years: z.string().max(10),
  address: z.string().max(400),
  completedOn: z.string().max(20),
  linkedQuote: z.string().max(80),
});
const jobChoice = z.union([z.object({ kind: z.literal('existing'), id: z.string().max(80) }), z.object({ kind: z.literal('new'), customerId: z.string().max(80), reference: z.string().max(60) })]);
const saveInput = z.object({ documentId: z.string().max(80).nullable(), job: jobChoice.nullable(), values });

/** One hundred and twenty saves per person in ten minutes: the draft saves a second after each pause, so only a runaway loop meets it. */
const limiter = createRateLimiter(120, 10 * 60_000);

/** The autosave. Business and person come from the session; everything is checked again on the server. */
export async function saveGuaranteeAction(raw: unknown): Promise<GuaranteeOutcome> {
  const s = await requireSession();
  const p = saveInput.safeParse(raw);
  if (!p.success) return { ok: false, message: 'Some of that could not be saved. Check the boxes and try again.' };
  if (p.data.documentId !== null && !isKnownId(p.data.documentId)) return { ok: false, message: GENERIC };
  if (!limiter.take(s.userId)) return { ok: false, message: 'That is a lot of saving. Wait a moment and it will catch up.' };
  try {
    return { ok: true, value: await saveGuarantee(p.data) };
  } catch (e) {
    return e instanceof GuaranteeError ? { ok: false, message: e.message, ...(e.field ? { field: e.field } : {}), ...(e.existingId ? { existingId: e.existingId } : {}) } : { ok: false, message: GENERIC };
  }
}
