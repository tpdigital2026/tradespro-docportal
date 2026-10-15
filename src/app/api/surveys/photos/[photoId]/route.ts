import { NextResponse } from 'next/server';
import { readSurveyPhoto } from '../../../../../lib/data/surveys';
import { PHOTO_ID } from '../../../../../lib/survey/model';
import { getSession } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';

/** One stored survey photo of the signed-in business, streamed after the session and tenant checks. Never public. */
export async function GET(_req: Request, ctx: { params: Promise<{ photoId: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, message: 'Please sign in.' }, { status: 401 });
  const { photoId } = await ctx.params;
  if (!PHOTO_ID.test(photoId)) return NextResponse.json({ ok: false, message: 'That photo is not available.' }, { status: 404 });
  const bytes = await readSurveyPhoto(photoId).catch(() => null);
  if (!bytes) return NextResponse.json({ ok: false, message: 'That photo is not available.' }, { status: 404 });
  return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' } });
}
