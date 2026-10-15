'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  approveSurveyPart,
  deleteSurveyPhoto,
  draftSurveyFinding,
  draftSurveyOpinion,
  saveSurvey,
  startQuoteFromSurvey,
  SurveyError,
  type FindingDraftOutcome,
  type SavedSurvey,
} from '../../../../lib/data/surveys';
import { isKnownId } from '../../../../lib/data/quotes';
import { DocumentError, reviseDocument } from '../../../../lib/data/documents';
import { PHOTO_ID, FINDING_ID, surveyFormSchema, type SurveyFormValues } from '../../../../lib/survey/model';
import { requireSession } from '../../../../lib/session';

const GENERIC = 'We could not do that. Please try again.';

export type SurveyOutcome<T> = { ok: true; value: T } | { ok: false; message: string; field?: string };

const fail = (e: unknown): { ok: false; message: string; field?: string } =>
  e instanceof SurveyError ? { ok: false, message: e.message, ...(e.field ? { field: e.field } : {}) } : { ok: false, message: GENERIC };

const customerChoice = z.union([
  z.object({ kind: z.literal('existing'), id: z.string().max(80) }),
  z.object({
    kind: z.literal('new'),
    customer: z.object({ name: z.string().max(200), addressLines: z.array(z.string().max(200)).max(4), postcode: z.string().max(20), email: z.string().max(254), phone: z.string().max(30) }),
  }),
]);
const jobChoice = z.union([z.object({ kind: z.literal('existing'), id: z.string().max(80) }), z.object({ kind: z.literal('new'), reference: z.string().max(60) })]);
const saveInput = z.object({ documentId: z.string().max(80).nullable(), customer: customerChoice.nullable(), job: jobChoice.nullable(), values: surveyFormSchema });

const docId = (raw: unknown): string | null => (typeof raw === 'string' && isKnownId(raw) ? raw : null);

/** The autosave. Business and person come from the session; everything is checked again on the server. */
export async function saveSurveyAction(raw: unknown): Promise<SurveyOutcome<SavedSurvey>> {
  await requireSession();
  const p = saveInput.safeParse(raw);
  if (!p.success) return { ok: false, message: 'Some of that could not be saved. Check the boxes and try again.' };
  if (p.data.documentId !== null && !docId(p.data.documentId)) return { ok: false, message: GENERIC };
  try {
    return { ok: true, value: await saveSurvey(p.data as Parameters<typeof saveSurvey>[0]) };
  } catch (e) {
    return fail(e);
  }
}

/** Approve one finding, or the professional opinion. The time and fingerprint are set on the server. */
export async function approveSurveyAction(documentIdRaw: unknown, valuesRaw: unknown, partRaw: unknown): Promise<SurveyOutcome<SavedSurvey>> {
  await requireSession();
  const id = docId(documentIdRaw);
  const values = surveyFormSchema.safeParse(valuesRaw);
  const part = z.union([z.object({ kind: z.literal('finding'), findingId: z.string().regex(FINDING_ID) }), z.object({ kind: z.literal('opinion') })]).safeParse(partRaw);
  if (!id || !values.success || !part.success) return { ok: false, message: GENERIC };
  try {
    return { ok: true, value: await approveSurveyPart(id, values.data as SurveyFormValues, part.data) };
  } catch (e) {
    return fail(e);
  }
}

export async function draftFindingAction(documentIdRaw: unknown, ownerLineRaw: unknown, photoIdsRaw: unknown): Promise<SurveyOutcome<FindingDraftOutcome>> {
  await requireSession();
  const id = docId(documentIdRaw);
  const line = z.string().max(300).safeParse(ownerLineRaw);
  const photos = z.array(z.string().regex(PHOTO_ID)).max(4).safeParse(photoIdsRaw);
  if (!id || !line.success || !photos.success) return { ok: false, message: GENERIC };
  if (line.data.trim() === '') return { ok: false, message: 'Say what you found in one line first.' };
  try {
    return { ok: true, value: await draftSurveyFinding(id, line.data, photos.data) };
  } catch {
    return { ok: false, message: GENERIC };
  }
}

export async function draftOpinionAction(documentIdRaw: unknown, valuesRaw: unknown): Promise<SurveyOutcome<Awaited<ReturnType<typeof draftSurveyOpinion>>>> {
  await requireSession();
  const id = docId(documentIdRaw);
  const values = surveyFormSchema.safeParse(valuesRaw);
  if (!id || !values.success) return { ok: false, message: GENERIC };
  if (values.data.conclusionLine.trim() === '') return { ok: false, message: 'Say what you conclude in a line first.' };
  try {
    return { ok: true, value: await draftSurveyOpinion(id, values.data as SurveyFormValues) };
  } catch {
    return { ok: false, message: GENERIC };
  }
}

export async function deleteSurveyPhotoAction(documentIdRaw: unknown, photoIdRaw: unknown): Promise<SurveyOutcome<null>> {
  await requireSession();
  const id = docId(documentIdRaw);
  if (!id || typeof photoIdRaw !== 'string' || !PHOTO_ID.test(photoIdRaw)) return { ok: false, message: GENERIC };
  try {
    await deleteSurveyPhoto(id, photoIdRaw);
    return { ok: true, value: null };
  } catch (e) {
    return fail(e);
  }
}

/** "Create quote from this survey": makes (or finds) the job's quote and opens it. */
export async function startQuoteFromSurveyAction(formData: FormData): Promise<void> {
  await requireSession();
  const id = docId(formData.get('id'));
  if (!id) redirect('/documents');
  let href: string;
  try {
    href = (await startQuoteFromSurvey(id)).href;
  } catch {
    redirect(`/documents/${id}?quote=failed`);
  }
  redirect(href);
}

export type SurveyReviseState = { message: string } | null;

/** "Correct this report": a new draft version of an issued survey report, every approval taken off, then the form. */
export async function reviseSurveyAction(_prev: SurveyReviseState, form: FormData): Promise<SurveyReviseState> {
  await requireSession();
  const id = docId(form.get('id'));
  if (!id) return { message: GENERIC };
  try {
    await reviseDocument(id);
  } catch (e) {
    return { message: e instanceof DocumentError ? e.message : GENERIC };
  }
  redirect(`/documents/new?type=survey&draft=${encodeURIComponent(id)}&step=findings&revised=1`);
}
