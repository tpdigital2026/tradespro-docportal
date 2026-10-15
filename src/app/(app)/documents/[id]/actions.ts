'use server';

import { redirect } from 'next/navigation';
import { DocumentError, reviseDocument } from '../../../../lib/data/documents';
import { requireSession } from '../../../../lib/session';

export type ReviseState = { message: string } | null;

/** "Change this quote": a new draft version of an issued quote, then straight back into the stepper. */
export async function reviseAction(_prev: ReviseState, form: FormData): Promise<ReviseState> {
  await requireSession();
  const id = form.get('id');
  if (typeof id !== 'string') return { message: 'We could not do that. Please try again.' };
  let jobId: string;
  try {
    jobId = (await reviseDocument(id)).jobId;
  } catch (e) {
    return { message: e instanceof DocumentError ? e.message : 'We could not do that. Please try again.' };
  }
  redirect(`/documents/new?type=quotation&draft=${encodeURIComponent(jobId)}&step=review&revised=1`);
}
