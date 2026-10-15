/**
 * The signature picture routes: GET shows the stored picture to anyone signed in to the business (the Settings
 * preview); POST stores a new one (owner only, fresh emailed code). Thin routes in src/app/api/settings/signature call
 * these with the real dependencies; tests pass fakes.
 */
import { NextResponse } from 'next/server';
import type { Session } from './session';
import { checkSignatureUpload, SIGNATURE_MAX_BYTES, type Reencoder } from './signature-image';
import type { Reencoded } from './signature-image';
import { StepUpRequiredError } from '../security/step-up';
import { SettingsError } from './data/settings';

export interface SignatureDeps {
  session(): Promise<Session | null>;
  requireStepUp(): Promise<void>;
  /** The stored picture of this business, or null. */
  load(tenantId: string): Promise<Buffer | null>;
  reencode: Reencoder;
  save(s: Session, image: Reencoded): Promise<void>;
}

const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function handleSignatureGet(deps: SignatureDeps): Promise<Response> {
  const s = await deps.session();
  if (!s) return json(401, { ok: false, message: 'Please sign in.' });
  const png = await deps.load(s.tenantId).catch(() => null);
  if (!png) return json(404, { ok: false, message: 'No signature is stored.' });
  return new Response(new Uint8Array(png), {
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(png.length),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
    },
  });
}

/** Room for the multipart wrapping around a 1 MB file. Anything bigger is refused before it is read. */
const MAX_BODY = SIGNATURE_MAX_BYTES + 64 * 1024;

export async function handleSignaturePost(req: Request, deps: SignatureDeps): Promise<Response> {
  const s = await deps.session();
  if (!s) return json(401, { status: 'error', message: 'Please sign in.' });
  if (s.role !== 'owner') return json(403, { status: 'error', message: 'Only the owner can change this.' });
  const declared = Number(req.headers.get('content-length') ?? 'NaN');
  if (!Number.isFinite(declared) || declared > MAX_BODY) return json(413, { status: 'error', message: 'That picture is bigger than 1 MB. Take a closer photo or save it smaller, then try again.' });
  try {
    await deps.requireStepUp();
  } catch (e) {
    if (e instanceof StepUpRequiredError) return json(200, { status: 'step-up' });
    return json(500, { status: 'error', message: 'That could not be saved. Please try again.' });
  }
  let bytes: Buffer;
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') return json(400, { status: 'error', message: 'Choose a picture of your signature first.' });
    if (file.size > SIGNATURE_MAX_BYTES) return json(413, { status: 'error', message: 'That picture is bigger than 1 MB. Take a closer photo or save it smaller, then try again.' });
    bytes = Buffer.from(await file.arrayBuffer());
  } catch {
    return json(400, { status: 'error', message: 'That picture could not be read. Try again.' });
  }
  const check = checkSignatureUpload(bytes);
  if (!check.ok) return json(400, { status: 'error', message: check.message });
  let image: Reencoded;
  try {
    image = await deps.reencode(bytes, check.image);
  } catch {
    return json(400, { status: 'error', message: 'That picture could not be read. Save it again as a PNG or JPG and try once more.' });
  }
  try {
    await deps.save(s, image);
  } catch (e) {
    if (e instanceof SettingsError) return json(400, { status: 'error', message: e.message });
    console.error(`signature save failed: ${e instanceof Error ? e.name : 'Error'}`);
    return json(500, { status: 'error', message: 'That could not be saved. Nothing was changed. Please try again.' });
  }
  return json(200, { status: 'ok', message: 'Your signature picture is saved. Check how it looks in the preview.' });
}
