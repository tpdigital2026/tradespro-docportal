import { NextResponse } from 'next/server';
import { getPageImage } from '../../../../../../lib/data/documents';
import { getSession } from '../../../../../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * One page image. With ?key= it is a page of the draft being read, and the response carries this person's read token
 * for that page (X-Read-Token); without it, a page of the issued document.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string; n: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, message: 'Please sign in.' }, { status: 401 });
  const { id, n } = await ctx.params;
  const page = /^\d{1,3}$/.test(n) ? Number(n) : NaN;
  const key = new URL(req.url).searchParams.get('key');
  const img = await getPageImage(id, page, key).catch(() => null);
  if (!img) return NextResponse.json({ ok: false, message: 'That page is not available.' }, { status: 404 });
  const headers: Record<string, string> = { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  if (img.token) headers['X-Read-Token'] = img.token;
  return new Response(new Uint8Array(img.bytes), { headers });
}
