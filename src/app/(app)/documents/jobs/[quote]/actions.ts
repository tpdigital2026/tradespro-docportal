'use server';

import { z } from 'zod';
import { BillingError, markAsPaid } from '../../../../../lib/data/billing';
import { paymentFormSchema, type PaymentErrors } from '../../../../../lib/payment';
import { requireSession } from '../../../../../lib/session';

export type PayResult =
  | { ok: true; paymentId: string; quoteNumber: string; instalment: number; remainingPence: number; repeat: boolean }
  | { ok: false; message: string; errors?: PaymentErrors };

const GENERIC = 'We could not record that. Please try again.';

const argsSchema = z.object({ quote: z.string().min(2).max(40), instalment: z.number().int().min(1).max(10) });

/** "Mark as paid". The tenant comes from the session; the browser sends only what the owner typed. */
export async function markAsPaidAction(quoteRaw: unknown, instalmentRaw: unknown, formRaw: unknown): Promise<PayResult> {
  await requireSession();
  const args = argsSchema.safeParse({ quote: quoteRaw, instalment: instalmentRaw });
  const form = paymentFormSchema.safeParse(formRaw);
  if (!args.success || !form.success) return { ok: false, message: GENERIC };
  try {
    const r = await markAsPaid(args.data.quote, args.data.instalment, form.data);
    return { ok: true, paymentId: r.paymentId, quoteNumber: r.quoteNumber, instalment: r.instalment, remainingPence: r.remainingPence, repeat: r.repeat };
  } catch (e) {
    if (e instanceof BillingError) return { ok: false, message: e.message, errors: e.errors };
    return { ok: false, message: GENERIC };
  }
}
