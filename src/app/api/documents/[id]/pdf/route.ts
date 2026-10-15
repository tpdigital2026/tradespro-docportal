import { NextResponse } from 'next/server';
import { getPdf } from '../../../../../lib/data/documents';
import { getSession } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Download a finalised document. Drafts never download (404). The file is streamed by us after the session and tenant
 * checks; the storage bucket itself is never exposed. ?v= picks an earlier issued version.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, message: 'Please sign in.' }, { status: 401 });
  const { id } = await ctx.params;
  const v = new URL(req.url).searchParams.get('v');
  const file = await getPdf(id, v).catch(() => null);
  if (!file) return NextResponse.json({ ok: false, message: 'That document is not available to download.' }, { status: 404 });
  const ascii = file.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Content-Length': String(file.bytes.length),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
