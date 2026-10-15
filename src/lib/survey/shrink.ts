/**
 * Browser side: shrinks a photo to at most 2000 pixels on the long edge and re-encodes it as JPEG before upload, so
 * phone photos upload quickly on a poor signal. Drawing to a canvas also drops the photo's metadata in the browser;
 * the server strips it again regardless and never trusts this step. Where the browser cannot decode the file, nothing
 * is sent: the owner is asked to take the photo again with the camera button or choose a JPEG.
 */
export const MAX_EDGE = 2000;

export function targetSize(w: number, h: number, max = MAX_EDGE): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: 0, height: 0 };
  const s = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** Said when the browser cannot read a photo. The raw file is never sent instead (an iPhone HEIC would be refused). */
export const UNSUPPORTED_PHOTO = 'That photo format is not supported. Take it again with the camera button or choose a JPEG.';

export class UnsupportedPhotoError extends Error {
  constructor() {
    super(UNSUPPORTED_PHOTO);
    this.name = 'UnsupportedPhotoError';
  }
}

/** The types the file inputs offer. Without HEIC in the list, iOS hands over a JPEG copy of the photo. */
export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp';

/**
 * Decodes the photo in the browser, shrinks it to 2000 pixels and returns a JPEG. If the browser cannot decode it, it
 * throws UnsupportedPhotoError: the original file is never uploaded in its place.
 */
export async function shrinkPhoto(file: Blob, env: { createImageBitmap?: typeof createImageBitmap; document?: Pick<Document, 'createElement'> } = globalThis as never): Promise<Blob> {
  const decode = env.createImageBitmap;
  const doc = env.document;
  if (typeof decode !== 'function' || !doc) throw new UnsupportedPhotoError();
  let bmp: ImageBitmap;
  try {
    bmp = await decode(file, { imageOrientation: 'from-image' });
  } catch {
    throw new UnsupportedPhotoError();
  }
  try {
    const { width, height } = targetSize(bmp.width, bmp.height);
    if (!width || !height) throw new UnsupportedPhotoError();
    const canvas = doc.createElement('canvas') as HTMLCanvasElement;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new UnsupportedPhotoError();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bmp, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    if (!blob || blob.size === 0) throw new UnsupportedPhotoError();
    return blob;
  } finally {
    bmp.close();
  }
}
