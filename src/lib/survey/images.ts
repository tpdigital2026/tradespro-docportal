/**
 * The photo pipeline, server side. Every uploaded photo is:
 *  1. checked by its first bytes (JPEG, PNG or WebP only; the name and the declared type are never trusted);
 *  2. checked for size and pixel count before it is decoded in full (a "decompression bomb" is refused);
 *  3. decoded, turned upright from its orientation flag, shrunk to at most 2000 pixels on the long edge, and
 *     re-encoded as a fresh JPEG. Re-encoding writes none of the original metadata: no EXIF, no GPS position, no
 *     camera serial, no XMP, no comments. Only the pixels survive.
 * The result is what is stored; the original bytes are never kept or logged.
 */
import { createHash } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';

// Photos are one-off: a decoded image is never reused, so libvips keeps no cache of them.
sharp.cache(false);

export const PHOTO_LIMITS = {
  /**
   * Bytes accepted from the browser. Phones resize before upload, so real uploads are far smaller (1 to 3 MB). Kept
   * under the 10 MB that the proxy (src/proxy.ts) buffers of a request body, so a body is never cut short there.
   */
  maxUploadBytes: 8 * 1024 * 1024,
  /** Long edge of the stored photo. */
  maxEdge: 2000,
  /** Refuse anything that would decode to more pixels than this: 36 megapixels covers every phone camera. */
  maxInputPixels: 36_000_000,
  minEdge: 64,
  quality: 82,
} as const;

export type ImageKind = 'jpeg' | 'png' | 'webp';

export class PhotoError extends Error {
  constructor(
    readonly code: 'empty' | 'too_big' | 'not_image' | 'too_small' | 'unreadable',
    message: string,
  ) {
    super(message);
    this.name = 'PhotoError';
  }
}

/** What the first bytes say the file is, or null. */
export function sniffImage(b: Uint8Array): ImageKind | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  return null;
}

export interface CleanPhoto {
  bytes: Buffer;
  width: number;
  height: number;
  sha256: string;
}

const TOO_MANY_PIXELS = 'That photo has too many pixels. Choose a smaller one, or take it with the camera button.';
const NOT_IMAGE = 'That file is not a photo we can use. Choose a JPEG, PNG or WebP photo.';

/** At most two photos are decoded at once in one server process, so memory stays bounded however many arrive. */
const MAX_DECODES = 2;
let decoding = 0;
const waiting: (() => void)[] = [];
async function withDecodeSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (decoding >= MAX_DECODES) await new Promise<void>((resolve) => waiting.push(resolve));
  decoding += 1;
  try {
    return await fn();
  } finally {
    decoding -= 1;
    waiting.shift()?.();
  }
}
/** Test hook: how many decodes are running now. */
export const decodesRunning = () => decoding;

/** Validates and re-encodes one uploaded photo. Throws PhotoError with a message fit to show the owner. */
export function cleanPhoto(input: Uint8Array): Promise<CleanPhoto> {
  return withDecodeSlot(() => cleanPhotoNow(input));
}

async function cleanPhotoNow(input: Uint8Array): Promise<CleanPhoto> {
  if (!input || input.length === 0) throw new PhotoError('empty', 'That file is empty.');
  if (input.length > PHOTO_LIMITS.maxUploadBytes) throw new PhotoError('too_big', 'That photo is too large. Choose one under 8 MB.');
  const kind = sniffImage(input);
  if (!kind) throw new PhotoError('not_image', NOT_IMAGE);
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let meta: Metadata;
  try {
    // Header only: no pixels are decoded here.
    meta = await sharp(buf, { limitInputPixels: PHOTO_LIMITS.maxInputPixels, failOn: 'error', sequentialRead: true }).metadata();
  } catch (e) {
    if (/pixel limit/i.test(String((e as Error)?.message))) throw new PhotoError('too_big', TOO_MANY_PIXELS);
    throw new PhotoError('unreadable', NOT_IMAGE);
  }
  // The container must agree with the first bytes (a PNG header on a WebP body is not a photo).
  if (meta.format !== kind) throw new PhotoError('not_image', NOT_IMAGE);
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) throw new PhotoError('unreadable', NOT_IMAGE);
  if (w * h > PHOTO_LIMITS.maxInputPixels) throw new PhotoError('too_big', TOO_MANY_PIXELS);
  if (Math.min(w, h) < PHOTO_LIMITS.minEdge) throw new PhotoError('too_small', 'That photo is too small to be useful in a report.');
  if ((meta.pages ?? 1) > 1) throw new PhotoError('not_image', 'Animated images cannot be used. Choose a photo.');
  try {
    // ONE decode, streamed top to bottom (sequentialRead), straight into the shrink and the new JPEG: the full-size
    // image is never held as a whole in memory more than libvips needs, and nothing is cached between photos.
    const { data, info } = await sharp(buf, { limitInputPixels: PHOTO_LIMITS.maxInputPixels, failOn: 'error', sequentialRead: true })
      .rotate() // upright from the orientation flag, before the flag is dropped with everything else
      .resize({ width: PHOTO_LIMITS.maxEdge, height: PHOTO_LIMITS.maxEdge, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .jpeg({ quality: PHOTO_LIMITS.quality, mozjpeg: true, chromaSubsampling: '4:2:0' })
      .toBuffer({ resolveWithObject: true });
    return { bytes: data, width: info.width, height: info.height, sha256: createHash('sha256').update(data).digest('hex') };
  } catch (e) {
    if (/pixel limit/i.test(String((e as Error)?.message))) throw new PhotoError('too_big', TOO_MANY_PIXELS);
    throw new PhotoError('unreadable', NOT_IMAGE);
  }
}

/** A smaller copy for the PDF, sized to how large the photo is printed. Never stored. */
export async function printCopy(bytes: Buffer, longEdge: number): Promise<{ src: string; width: number; height: number }> {
  const { data, info } = await sharp(bytes, { limitInputPixels: PHOTO_LIMITS.maxInputPixels, sequentialRead: true })
    .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
    // Plain libjpeg at 80: these copies are throwaway print copies, and mozjpeg costs several times as long for little gain.
    .jpeg({ quality: 80 })
    .toBuffer({ resolveWithObject: true });
  return { src: `data:image/jpeg;base64,${data.toString('base64')}`, width: info.width, height: info.height };
}

/** Markers that would show metadata survived: an APP1 (EXIF or XMP) segment, the EXIF and GPS tags, an XMP packet. */
export function hasMetadataMarkers(jpeg: Buffer): boolean {
  if (jpeg.includes(Buffer.from('Exif\0\0', 'latin1'))) return true;
  if (jpeg.includes(Buffer.from('http://ns.adobe.com/xap/1.0/', 'latin1'))) return true;
  // Walk the segments before the image data: any APP1 (0xFFE1) or COM (0xFFFE) segment means metadata.
  let i = 2;
  while (i + 4 <= jpeg.length && jpeg[i] === 0xff) {
    const marker = jpeg[i + 1];
    if (marker === 0xda) break; // start of scan
    const len = jpeg.readUInt16BE(i + 2);
    if (marker === 0xe1 || marker === 0xfe) return true;
    i += 2 + len;
  }
  return false;
}
