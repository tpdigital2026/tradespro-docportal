import { NextResponse } from 'next/server';
import { checkSurveyPhotoRoom, PhotoError, SurveyError, uploadSurveyPhoto } from '../../../../../lib/data/surveys';
import { PHOTO_LIMITS } from '../../../../../lib/survey/images';
import { FINDING_ID } from '../../../../../lib/survey/model';
import { readCapped } from '../../../../../lib/survey/read-capped';
import { getSession } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';

/** Room for the multipart wrapping around the photo. */
const OVERHEAD = 64 * 1024;
const CAP = PHOTO_LIMITS.maxUploadBytes + OVERHEAD;
const TOO_BIG = 'That photo is too large. Choose one under 12 MB.';

const fail = (message: string, status: number) => NextResponse.json({ ok: false, message }, { status, headers: { 'Cache-Control': 'no-store' } });
const statusOf = (e: SurveyError) => (e.code === 'not_found' ? 404 : e.code === 'locked' ? 409 : e.code === 'limit' ? 429 : 400);

/**
 * One photo for one finding of a draft survey report: multipart form data, field "photo", `?finding=f-...`. Same-origin
 * is checked for every non-GET request in front of this route (src/lib/route-guard.ts). In order, before any image
 * work: signed in; a declared length within the cap (411 without one, 413 over it); the survey, its job and the
 * finding in this business with room for a photo; then the body is read with a hard byte cap (never an unbounded
 * formData()); then the server cleans the image and stores it.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return fail('Please sign in.', 401);
  const { id } = await ctx.params;
  const finding = new URL(req.url).searchParams.get('finding') ?? '';
  if (!FINDING_ID.test(finding)) return fail('That finding could not be found.', 400);
  const declared = req.headers.get('content-length');
  if (declared === null || !/^\d{1,9}$/.test(declared)) return fail('The upload did not say how large it is. Please try again.', 411);
  if (Number(declared) > CAP) return fail(TOO_BIG, 413);
  const type = req.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data;\s*boundary=/i.test(type)) return fail('Choose a photo to add.', 400);
  try {
    await checkSurveyPhotoRoom(id, finding);
  } catch (e) {
    if (e instanceof SurveyError) return fail(e.message, statusOf(e));
    return fail('The photo could not be added. Please try again.', 500);
  }
  // A body longer than it said it was is cut off at the declared length plus one byte, and refused.
  const bytes = await readCapped(req.body, Math.min(CAP, Number(declared))).catch(() => null);
  if (!bytes) return fail(TOO_BIG, 413);
  let file: FormDataEntryValue | null;
  try {
    // Parsed from the bounded copy, so it can never grow past the cap.
    file = (await new Request('http://local/upload', { method: 'POST', headers: { 'content-type': type }, body: new Uint8Array(bytes) }).formData()).get('photo');
  } catch {
    return fail('That upload did not arrive whole. Please try again.', 400);
  }
  if (!file || typeof file === 'string') return fail('Choose a photo to add.', 400);
  if (file.size > PHOTO_LIMITS.maxUploadBytes) return fail(TOO_BIG, 413);
  try {
    const photo = await uploadSurveyPhoto(id, finding, new Uint8Array(await file.arrayBuffer()));
    return NextResponse.json({ ok: true, photo }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof PhotoError) return fail(e.message, e.code === 'too_big' ? 413 : 415);
    if (e instanceof SurveyError) return fail(e.message, statusOf(e));
    return fail('The photo could not be added. Please try again.', 500);
  }
}
