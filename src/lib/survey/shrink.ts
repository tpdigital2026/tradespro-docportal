/**
 * Browser side: shrinks a photo to at most 2000 pixels on the long edge and re-encodes it as JPEG before upload, so
 * phone photos upload quickly on a poor signal. Drawing to a canvas also drops the photo's metadata in the browser;
 * the server strips it again regardless and never trusts this step. Where the browser cannot decode the file, the
 * original is sent and the server decides.
 */
export const MAX_EDGE = 2000;

export function targetSize(w: number, h: number, max = MAX_EDGE): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: 0, height: 0 };
  const s = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

export async function shrinkPhoto(file: File): Promise<Blob> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }
  try {
    const { width, height } = targetSize(bmp.width, bmp.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bmp, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    return blob ?? file;
  } finally {
    bmp.close();
  }
}
