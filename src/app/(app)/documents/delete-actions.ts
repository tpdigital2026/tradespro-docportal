'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { deleteDraftDocument } from '../../../lib/data/documents';
import { DELETE_DRAFT_MESSAGES } from '../../../lib/documents/delete-draft';
import { logFailure } from '../../../lib/log-failure';
import { requireSession } from '../../../lib/session';

export type DeleteDraftState = { message: string } | null;

/** Where to land after a delete: a fixed list, never a URL from the browser. */
const BACK = { home: '/?view=quotes&deleted=draft#jobs', documents: '/documents?deleted=draft', drafts: '/documents?status=draft&deleted=draft' } as const;
export type DeleteBack = keyof typeof BACK;

/**
 * Deletes one draft that was never issued. The session gives the business and the person; the data layer and the
 * database check everything again. On success it goes back to the list with a short confirmation; otherwise the
 * reason comes back to the dialog.
 */
export async function deleteDraftAction(id: string, back: DeleteBack): Promise<DeleteDraftState> {
  await requireSession();
  if (typeof id !== 'string' || id.length > 80) return { message: DELETE_DRAFT_MESSAGES.not_found };
  let status: string;
  try {
    status = (await deleteDraftDocument(id)).status;
  } catch (e) {
    logFailure('documents.delete_draft', e);
    return { message: 'We could not delete that draft just now. Please try again.' };
  }
  if (status !== 'deleted') return { message: DELETE_DRAFT_MESSAGES[status as keyof typeof DELETE_DRAFT_MESSAGES] ?? DELETE_DRAFT_MESSAGES.not_found };
  revalidatePath('/', 'layout');
  redirect(BACK[back] ?? BACK.documents);
}
