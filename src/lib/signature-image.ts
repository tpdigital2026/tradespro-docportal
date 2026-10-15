/**
 * The owner's signature image: what may be uploaded, and what is kept. Pure (no I/O); the re-encoding itself is done by
 * the render service's browser (reencodeSignature in render-service.ts), which decodes the upload in a sandboxed page
 * with no network and draws it onto a fresh canvas, so nothing from the original file survives: no EXIF, GPS, XMP, ICC
 * profile or comments, only pixels. The PNG that comes back is then cut down to its essential chunks here as well.
 */

export const SIGNATURE_MAX_BYTES = 1024 * 1024;
/** Bigger than any sensible signature scan, small enough that decoding cannot exhaust memory. */
export const SIGNATURE_MAX_SIDE = 6000;
export const SIGNATURE_MAX_PIXELS = 24_000_000;
/** What is stored: at most this size, scaled down keeping the shape. */
export const SIGNATURE_OUT_W = 1200;
export const SIGNATURE_OUT_H = 400;

export type ImageKind = 'png' | 'jpeg';
export interface Sniffed {
  kind: ImageKind;
  width: number;
  height: number;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The real type and size from the file's own header (never the name or the browser's word for it), or null. */
export function sniffImage(b: Buffer): Sniffed | null {
  if (b.length >= 24 && b.subarray(0, 8).equals(PNG_SIG) && b.toString('latin1', 12, 16) === 'IHDR') {
    return { kind: 'png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null; // end of image or start of scan before any frame header
      const len = b.readUInt16BE(i + 2);
      if (len < 2) return null;
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { kind: 'jpeg', height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

export type UploadCheck = { ok: true; image: Sniffed } | { ok: false; message: string };

/** Size, type and dimensions, checked before the file is decoded at all. */
export function checkSignatureUpload(bytes: Buffer): UploadCheck {
  if (bytes.length === 0) return { ok: false, message: 'Choose a picture of your signature first.' };
  if (bytes.length > SIGNATURE_MAX_BYTES) return { ok: false, message: 'That picture is bigger than 1 MB. Take a closer photo or save it smaller, then try again.' };
  const image = sniffImage(bytes);
  if (!image) return { ok: false, message: 'That file is not a PNG or JPG picture. Save your signature as a PNG or JPG and try again.' };
  if (image.width < 1 || image.height < 1 || image.width > SIGNATURE_MAX_SIDE || image.height > SIGNATURE_MAX_SIDE || image.width * image.height > SIGNATURE_MAX_PIXELS) {
    return { ok: false, message: 'That picture is too large to use. Save it smaller, then try again.' };
  }
  return { ok: true, image };
}

/** The size to draw at: never larger than the original, at most SIGNATURE_OUT_W by SIGNATURE_OUT_H. */
export function outputSize(w: number, h: number): { width: number; height: number } {
  const scale = Math.min(1, SIGNATURE_OUT_W / w, SIGNATURE_OUT_H / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

const KEEP = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

/** A PNG with only the chunks needed to show the pixels. Throws if the bytes are not a well-formed PNG. */
export function stripPng(b: Buffer): Buffer {
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIG)) throw new Error('Not a PNG');
  const parts: Buffer[] = [PNG_SIG];
  let i = 8;
  let ended = false;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > b.length) throw new Error('Truncated PNG');
    if (KEEP.has(type)) parts.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') {
      ended = true;
      break;
    }
  }
  if (!ended) throw new Error('Truncated PNG');
  return Buffer.concat(parts);
}

/** The chunk types of a PNG, in order (tests and checks). */
export function pngChunks(b: Buffer): string[] {
  const out: string[] = [];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    out.push(b.toString('latin1', i + 4, i + 8));
    i += 12 + len;
  }
  return out;
}

export interface Reencoded {
  png: Buffer;
  width: number;
  height: number;
}
/** Decodes an image and draws it again as a fresh PNG (the browser does this in production; tests pass a fake). */
export type Reencoder = (bytes: Buffer, image: Sniffed) => Promise<Reencoded>;

export const signatureDataUri = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;
