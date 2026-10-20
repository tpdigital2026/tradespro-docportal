import { revalidatePath } from 'next/cache';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { DocumentError, finaliseDocument } from '../../../../../lib/data/documents';
import { getSession } from '../../../../../lib/session';
import { isSameOrigin } from '../../../../../lib/same-origin';
import { OWNER_TEMPLATE_MESSAGE, TemplateLockError } from '../../../../../lib/documents/template-lock';
import { logRenderFailure } from '../../../../../pdf/diagnostics';

export const dynamic = 'force-dynamic';
// Rendering a document takes a few seconds.
export const maxDuration = 60;

const body = z.object({
  versionId: z.string().min(1).max(80),
  key: z.string().regex(/^[0-9a-f]{32}$/),
  tokens: z.array(z.string().max(120)).max(400),
  confirmed: z.literal(true),
  confirmationVersion: z.string().min(1).max(40),
});

const STATUS: Record<DocumentError['code'], number> = { not_found: 404, locked: 409, changed: 409, missing: 422, unread: 422, unconfirmed: 422, not_allowed: 403, busy: 409, failed: 500 };

/**
 * Finalise: session first, tenant from the session, everything else re-checked on the server (README server rules).
 * The browser only says which version it read, the content key it read and the read tokens it was given.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isSameOrigin(req)) return NextResponse.json({ ok: false, message: 'Request not allowed.' }, { status: 403 });
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, message: 'Please sign in.' }, { status: 401 });
  const { id } = await ctx.params;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    raw = null;
  }
  const parsed = body.safeParse(raw);
  if (!parsed.success) {
    const unticked = (raw as { confirmed?: unknown } | null)?.confirmed !== true;
    return NextResponse.json({ ok: false, code: unticked ? 'unconfirmed' : 'invalid', message: unticked ? 'Tick the box to confirm you have checked the document.' : 'We could not finalise that. Please try again.' }, { status: 400 });
  }
  try {
    const r = await finaliseDocument(id, parsed.data);
    // Home, Documents, the job and the business tabs show the final document as soon as the owner goes back.
    revalidatePath('/', 'layout');
    return NextResponse.json({ ok: true, documentId: r.documentId, already: r.already });
  } catch (e) {
    if (e instanceof DocumentError) return NextResponse.json({ ok: false, code: e.code, message: e.message, missing: e.missing }, { status: STATUS[e.code] });
    logRenderFailure('finalise', e);
    if (e instanceof TemplateLockError) return NextResponse.json({ ok: false, code: 'template', message: OWNER_TEMPLATE_MESSAGE }, { status: 500 });
    return NextResponse.json({ ok: false, code: 'failed', message: 'We could not finalise that just now. Nothing was changed. Please try again.' }, { status: 500 });
  }
}
