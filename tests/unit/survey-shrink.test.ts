import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PHOTO_ACCEPT, shrinkPhoto, UNSUPPORTED_PHOTO, UnsupportedPhotoError } from '../../src/lib/survey/shrink';

/** A fake browser: a canvas that hands back a JPEG blob, and a decoder that can be told to fail. */
function browser(o: { decodes: boolean; width?: number; height?: number; blob?: Blob | null }) {
  const drawn: { w: number; h: number }[] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ fillStyle: '', fillRect: () => undefined, drawImage: (_b: unknown, _x: number, _y: number, w: number, h: number) => drawn.push({ w, h }) }),
    toBlob: (cb: (b: Blob | null) => void, type: string) => cb(o.blob === undefined ? new Blob(['jpeg'], { type }) : o.blob),
  };
  const close = vi.fn();
  return {
    drawn,
    close,
    env: {
      createImageBitmap: (async () => {
        if (!o.decodes) throw new DOMException('The source image could not be decoded.');
        return { width: o.width ?? 4032, height: o.height ?? 3024, close } as unknown as ImageBitmap;
      }) as unknown as typeof createImageBitmap,
      document: { createElement: () => canvas } as unknown as Pick<Document, 'createElement'>,
    },
  };
}

describe('shrinkPhoto: what the browser sends', () => {
  it('a photo the browser can decode is shrunk to 2000 pixels and sent as a JPEG', async () => {
    const b = browser({ decodes: true });
    const out = await shrinkPhoto(new Blob(['x'], { type: 'image/jpeg' }), b.env);
    expect(out.type).toBe('image/jpeg');
    expect(b.drawn).toEqual([{ w: 2000, h: 1500 }]);
    expect(b.close).toHaveBeenCalled();
  });

  it('a photo the browser cannot decode (an iPhone HEIC on a desktop, say) is NOT sent: the owner is told why', async () => {
    const original = new Blob(['heic'], { type: 'image/heic' });
    await expect(shrinkPhoto(original, browser({ decodes: false }).env)).rejects.toBeInstanceOf(UnsupportedPhotoError);
    await expect(shrinkPhoto(original, browser({ decodes: false }).env)).rejects.toThrow(UNSUPPORTED_PHOTO);
    expect(UNSUPPORTED_PHOTO).toBe('That photo format is not supported. Take it again with the camera button or choose a JPEG.');
  });

  it('no decoder at all, or a canvas that gives nothing back, never falls back to the raw file', async () => {
    await expect(shrinkPhoto(new Blob(['x']), { document: browser({ decodes: true }).env.document })).rejects.toBeInstanceOf(UnsupportedPhotoError);
    await expect(shrinkPhoto(new Blob(['x']), browser({ decodes: true, blob: null }).env)).rejects.toBeInstanceOf(UnsupportedPhotoError);
  });

  it('the file inputs offer JPEG, PNG and WebP only, so iOS converts HEIC to JPEG', () => {
    expect(PHOTO_ACCEPT).toBe('image/jpeg,image/png,image/webp');
    const card = readFileSync(path.join(process.cwd(), 'src/components/survey/FindingCard.tsx'), 'utf8');
    expect(card.match(/accept=\{PHOTO_ACCEPT\}/g)).toHaveLength(2);
    expect(card).toContain('capture="environment"');
    expect(card).not.toMatch(/image\/\*|heic|heif/);
  });
});
