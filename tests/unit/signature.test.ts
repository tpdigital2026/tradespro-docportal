import { describe, expect, it, vi } from 'vitest';
import { crc32 } from 'node:zlib';
import { checkSignatureUpload, outputSize, pngChunks, sniffImage, stripPng, SIGNATURE_MAX_BYTES } from '../../src/lib/signature-image';
import { handleSignatureGet, handleSignaturePost, type SignatureDeps } from '../../src/lib/signature-handlers';
import { StepUpRequiredError } from '../../src/security/step-up';
import type { Session } from '../../src/lib/session';

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
function png(w: number, h: number, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', Buffer.from([1, 2, 3])), chunk('IEND', Buffer.alloc(0))]);
}
function jpeg(w: number, h: number, exif = true): Buffer {
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x14]), Buffer.from('Exif\0\0GPS 51.4N 0.5E', 'latin1').subarray(0, 18)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), exif ? app1 : Buffer.alloc(0), sof, Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9])]);
}

describe('signature picture checks', () => {
  it('reads the real type and size from the header, never the name', () => {
    expect(sniffImage(png(900, 300))).toEqual({ kind: 'png', width: 900, height: 300 });
    expect(sniffImage(jpeg(1200, 400))).toEqual({ kind: 'jpeg', width: 1200, height: 400 });
    expect(sniffImage(Buffer.from('GIF89a........'))).toBeNull();
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
  it('refuses empty, over 1 MB, the wrong type and huge dimensions, in plain words', () => {
    expect(checkSignatureUpload(Buffer.alloc(0))).toMatchObject({ ok: false });
    expect(checkSignatureUpload(Buffer.concat([png(10, 10), Buffer.alloc(SIGNATURE_MAX_BYTES)]))).toMatchObject({ ok: false, message: expect.stringMatching(/bigger than 1 MB/) });
    expect(checkSignatureUpload(Buffer.from('%PDF-1.7 not a picture'))).toMatchObject({ ok: false, message: expect.stringMatching(/not a PNG or JPG/) });
    expect(checkSignatureUpload(png(20000, 20000))).toMatchObject({ ok: false, message: expect.stringMatching(/too large/) });
    expect(checkSignatureUpload(png(5000, 5000))).toMatchObject({ ok: false });
    expect(checkSignatureUpload(png(0, 10))).toMatchObject({ ok: false });
    expect(checkSignatureUpload(jpeg(1200, 400))).toMatchObject({ ok: true, image: { kind: 'jpeg' } });
  });
  it('scales down to at most 1200 by 400, never up', () => {
    expect(outputSize(2400, 400)).toEqual({ width: 1200, height: 200 });
    expect(outputSize(600, 1200)).toEqual({ width: 200, height: 400 });
    expect(outputSize(300, 100)).toEqual({ width: 300, height: 100 });
  });
  it('keeps only the chunks needed to draw the pixels (text, EXIF, ICC and time are dropped)', () => {
    const dirty = png(10, 10, [chunk('tEXt', Buffer.from('Comment\0GPS here')), chunk('eXIf', Buffer.from('MM\0*')), chunk('iCCP', Buffer.from('x')), chunk('tIME', Buffer.alloc(7))]);
    const clean = stripPng(dirty);
    expect(pngChunks(clean)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(clean.toString('latin1')).not.toContain('GPS');
    expect(() => stripPng(dirty.subarray(0, dirty.length - 6))).toThrow();
    expect(() => stripPng(Buffer.from('nope'))).toThrow();
  });
});

const owner: Session = { userId: 'u', tenantId: 't', role: 'owner', email: 'o@example.test', fullName: 'O', businessName: 'B' };
function deps(over: Partial<SignatureDeps> = {}): SignatureDeps & { saved: unknown[] } {
  const saved: unknown[] = [];
  return {
    saved,
    session: async () => owner,
    requireStepUp: async () => undefined,
    load: async () => Buffer.from('stored-png'),
    reencode: vi.fn(async () => ({ png: Buffer.from('clean'), width: 300, height: 100 })),
    save: async (_s, image) => {
      saved.push(image);
    },
    ...over,
  };
}
function upload(bytes: Buffer, size = bytes.length + 300) {
  const body = new FormData();
  body.set('file', new File([new Uint8Array(bytes)], 'sig.jpg', { type: 'image/jpeg' }));
  return new Request('https://app.example.test/api/settings/signature', { method: 'POST', body, headers: { 'content-length': String(size) } });
}

describe('signature routes', () => {
  it('GET needs a session and serves the picture privately, never cached', async () => {
    expect((await handleSignatureGet(deps({ session: async () => null }))).status).toBe(401);
    expect((await handleSignatureGet(deps({ load: async () => null }))).status).toBe(404);
    const r = await handleSignatureGet(deps());
    expect(r.headers.get('content-type')).toBe('image/png');
    expect(r.headers.get('cache-control')).toBe('private, no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });
  it('POST: owner only, fresh code, size first; stores only the re-encoded picture', async () => {
    expect((await handleSignaturePost(upload(jpeg(900, 300)), deps({ session: async () => ({ ...owner, role: 'staff' }) }))).status).toBe(403);
    const asked = await handleSignaturePost(upload(jpeg(900, 300)), deps({ requireStepUp: async () => { throw new StepUpRequiredError(); } }));
    expect(await asked.json()).toEqual({ status: 'step-up' });
    const big = deps();
    expect((await handleSignaturePost(upload(jpeg(900, 300), 3_000_000), big)).status).toBe(413);
    expect(big.reencode).not.toHaveBeenCalled();
    const d = deps();
    const ok = await handleSignaturePost(upload(jpeg(900, 300)), d);
    expect((await ok.json()).status).toBe('ok');
    expect(d.saved).toEqual([{ png: Buffer.from('clean'), width: 300, height: 100 }]);
  });
  it('a file that is not a picture, or that cannot be decoded, is refused and nothing is stored', async () => {
    const d = deps();
    const bad = await handleSignaturePost(upload(Buffer.from('<svg onload=alert(1)>')), d);
    expect(bad.status).toBe(400);
    expect(d.reencode).not.toHaveBeenCalled();
    const broken = deps({ reencode: async () => { throw new Error('decode'); } });
    expect((await handleSignaturePost(upload(jpeg(900, 300)), broken)).status).toBe(400);
    expect(broken.saved).toEqual([]);
  });
});
