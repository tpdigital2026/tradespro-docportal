import { NextResponse } from 'next/server';
import { PhotoError, SurveyError, uploadSurveyPhoto } from '../../../../../lib/data/surveys';
import { PHOTO_LIMITS } from '../../../../../lib/survey/images';
import { getSession } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * One photo for a draft survey report, sent as multipart form data (field "photo"). The browser has already shrunk
 * it; the server checks it is really an image, re-encodes it without any metadata and stores it privately. Same-origin
 * is checked for every non-GET request in front of this route (src/lib/route-guard.ts).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, message: 'Please sign in.' }, { status: 401 });
  const { id } = await ctx.params;
  const length = Number(req.headers.get('content-length') ?? '0');
  if (length > PHOTO_LIMITS.maxUploadBytes + 64 * 1024) return NextResponse.json({ ok: false, message: 'That photo is too large. Choose one under 12 MB.' }, { status: 413 });
  let file: FormDataEntryValue | null;
  try {
    file = (await req.formData()).get('photo');
  } catch {
    return NextResponse.json({ ok: false, message: 'That upload did not arrive whole. Please try again.' }, { status: 400 });
  }
  if (!file || typeof file === 'string') return NextResponse.json({ ok: false, message: 'Choose a photo to add.' }, { status: 400 });
  if (file.size > PHOTO_LIMITS.maxUploadBytes) return NextResponse.json({ ok: false, message: 'That photo is too large. Choose one under 12 MB.' }, { status: 413 });
  try {
    const photo = await uploadSurveyPhoto(id, new Uint8Array(await file.arrayBuffer()));
    return NextResponse.json({ ok: true, photo }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof PhotoError) return NextResponse.json({ ok: false, message: e.message }, { status: 415 });
    if (e instanceof SurveyError) return NextResponse.json({ ok: false, message: e.message }, { status: e.code === 'not_found' ? 404 : e.code === 'locked' ? 409 : 400 });
    return NextResponse.json({ ok: false, message: 'The photo could not be added. Please try again.' }, { status: 500 });
  }
}
