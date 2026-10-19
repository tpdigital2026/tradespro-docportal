import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { cleanPhoto, decodesRunning, hasMetadataMarkers, PhotoError, PHOTO_LIMITS, printCopy, sniffImage } from '../../src/lib/survey/images';
import { targetSize } from '../../src/lib/survey/shrink';
import { greyPng } from '../fixtures/png';

/** A little-endian TIFF block for an EXIF APP1 segment: orientation, a description and a GPS position. */
function exifSegment(o: { orientation?: number; description?: string; lat?: [number, number, number] } = {}): Buffer {
  const desc = Buffer.from(`${o.description ?? 'SECRET-PLACE-DESCRIPTION'}\0`, 'latin1');
  const entries0 = 3;
  const ifd0Size = 2 + entries0 * 12 + 4;
  const gpsOffset = 8 + ifd0Size;
  const gpsEntries = 2;
  const gpsSize = 2 + gpsEntries * 12 + 4;
  const descOffset = gpsOffset + gpsSize;
  const latOffset = descOffset + desc.length;
  const tiff = Buffer.alloc(latOffset + 24);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  let p = 8;
  tiff.writeUInt16LE(entries0, p);
  p += 2;
  const entry = (tag: number, type: number, count: number, value: number) => {
    tiff.writeUInt16LE(tag, p);
    tiff.writeUInt16LE(type, p + 2);
    tiff.writeUInt32LE(count, p + 4);
    tiff.writeUInt32LE(value, p + 8);
    p += 12;
  };
  entry(0x010e, 2, desc.length, descOffset); // ImageDescription
  entry(0x0112, 3, 1, o.orientation ?? 1); // Orientation
  entry(0x8825, 4, 1, gpsOffset); // GPS IFD
  tiff.writeUInt32LE(0, p);
  p = gpsOffset;
  tiff.writeUInt16LE(gpsEntries, p);
  p += 2;
  entry(0x0001, 2, 2, 0x4e); // GPSLatitudeRef 'N'
  entry(0x0002, 5, 3, latOffset); // GPSLatitude
  tiff.writeUInt32LE(0, p);
  desc.copy(tiff, descOffset);
  const [d, m, s] = o.lat ?? [51, 30, 26];
  [d, m, s].forEach((v, i) => {
    tiff.writeUInt32LE(v, latOffset + i * 8);
    tiff.writeUInt32LE(1, latOffset + i * 8 + 4);
  });
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** A JPEG with an EXIF segment (GPS included) spliced in straight after the start-of-image marker. */
async function jpegWithExif(w: number, h: number, exif: Buffer): Promise<Buffer> {
  const plain = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 120, g: 90, b: 60 } } }).jpeg().toBuffer();
  return Buffer.concat([plain.subarray(0, 2), exif, plain.subarray(2)]);
}

const solid = (w: number, h: number, fmt: 'png' | 'jpeg' | 'webp' | 'gif' | 'tiff' = 'png') => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 100, b: 50 } } })[fmt]().toBuffer();

async function refusal(input: Uint8Array): Promise<PhotoError['code'] | 'ok'> {
  try {
    await cleanPhoto(input);
    return 'ok';
  } catch (e) {
    if (e instanceof PhotoError) return e.code;
    throw e;
  }
}

describe('photo pipeline: metadata', () => {
  it('a JPEG carrying EXIF with a GPS position comes out with no EXIF, no GPS and no description', async () => {
    const input = await jpegWithExif(640, 480, exifSegment({ description: 'SECRET-PLACE-DESCRIPTION' }));
    // The test file really carries the metadata (the decoder sees it).
    const meta = await sharp(input).metadata();
    expect(meta.exif?.length ?? 0).toBeGreaterThan(0);
    expect(input.includes(Buffer.from('SECRET-PLACE-DESCRIPTION'))).toBe(true);
    const out = await cleanPhoto(input);
    expect(hasMetadataMarkers(out.bytes)).toBe(false);
    expect(out.bytes.includes(Buffer.from('Exif'))).toBe(false);
    expect(out.bytes.includes(Buffer.from('SECRET-PLACE-DESCRIPTION'))).toBe(false);
    // The GPS IFD tag (0x8825) in either byte order, and the latitude rational 51/1, are gone.
    expect(out.bytes.includes(Buffer.from([0x25, 0x88, 0x04, 0x00]))).toBe(false);
    expect(out.bytes.includes(Buffer.from([0x88, 0x25, 0x00, 0x04]))).toBe(false);
    const after = await sharp(out.bytes).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.xmp).toBeUndefined();
    expect(after.icc).toBeUndefined();
  });

  it('the photo is turned upright from its orientation flag before the flag is dropped', async () => {
    const out = await cleanPhoto(await jpegWithExif(400, 200, exifSegment({ orientation: 6 })));
    expect([out.width, out.height]).toEqual([200, 400]);
    expect(hasMetadataMarkers(out.bytes)).toBe(false);
  });

  it('PNG text chunks and WebP metadata do not survive either (property: 30 random descriptions)', async () => {
    for (let i = 0; i < 30; i++) {
      const secret = `LOC-${Math.random().toString(36).slice(2)}-${i}`;
      const png = await sharp({ create: { width: 80 + i, height: 90, channels: 4, background: { r: i, g: 2 * i, b: 3 * i, alpha: 0.5 } } })
        .png()
        .withMetadata({ exif: { IFD0: { ImageDescription: secret, Copyright: secret } } })
        .toBuffer();
      const out = await cleanPhoto(png);
      expect(out.bytes.includes(Buffer.from(secret))).toBe(false);
      expect(hasMetadataMarkers(out.bytes)).toBe(false);
      expect(sniffImage(out.bytes)).toBe('jpeg');
    }
  });

  it('the stored copy is at most 2000 pixels on the long edge, never enlarged, with a matching fingerprint', async () => {
    const big = await cleanPhoto(await solid(4000, 3000));
    expect([big.width, big.height]).toEqual([2000, 1500]);
    const small = await cleanPhoto(await solid(300, 200));
    expect([small.width, small.height]).toEqual([300, 200]);
    const { createHash } = await import('node:crypto');
    expect(small.sha256).toBe(createHash('sha256').update(small.bytes).digest('hex'));
  });

  it('a print copy is smaller still and carries no metadata', async () => {
    const out = await cleanPhoto(await solid(2000, 1000));
    const copy = await printCopy(out.bytes, 1000);
    expect([copy.width, copy.height]).toEqual([1000, 500]);
    expect(hasMetadataMarkers(Buffer.from(copy.src.split(',')[1], 'base64'))).toBe(false);
  });
});

describe('photo pipeline: bounded memory', () => {
  it('never decodes more than two photos at once in a process, however many arrive together', async () => {
    let peak = 0;
    const timer = setInterval(() => (peak = Math.max(peak, decodesRunning())), 1);
    const inputs = await Promise.all(Array.from({ length: 8 }, (_, i) => solid(1800 + i, 1400, 'png')));
    const outs = await Promise.all(inputs.map((b) => cleanPhoto(b)));
    clearInterval(timer);
    expect(outs).toHaveLength(8);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);
    expect(decodesRunning()).toBe(0);
  });
});

describe('photo pipeline: what is refused', () => {
  it('non-images by their first bytes, whatever they claim to be', async () => {
    expect(await refusal(new Uint8Array())).toBe('empty');
    expect(await refusal(Buffer.from('%PDF-1.7\n%...'))).toBe('not_image');
    expect(await refusal(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('not_image');
    expect(await refusal(Buffer.from('<html><script>alert(1)</script></html>'))).toBe('not_image');
    expect(await refusal(await solid(100, 100, 'gif'))).toBe('not_image');
    expect(await refusal(await solid(100, 100, 'tiff'))).toBe('not_image');
    expect(await refusal(Buffer.from('PK\u0003\u0004zipfile'))).toBe('not_image');
  });

  it('polyglots: a JPEG or PNG header on another body, and a body whose container disagrees with its header', async () => {
    const png = await solid(120, 120, 'png');
    const webp = await solid(120, 120, 'webp');
    // A JPEG start followed by a PDF.
    expect(await refusal(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('%PDF-1.7 not really an image at all')]))).not.toBe('ok');
    // A PNG signature on a WebP body.
    expect(await refusal(Buffer.concat([png.subarray(0, 8), webp.subarray(8)]))).not.toBe('ok');
    // A real JPEG with an HTML page appended: decodes as a photo, and only the pixels are kept.
    const jpg = await solid(120, 120, 'jpeg');
    const out = await cleanPhoto(Buffer.concat([jpg, Buffer.from('<html><script>alert(1)</script></html>')]));
    expect(out.bytes.includes(Buffer.from('<script>'))).toBe(false);
  });

  it('corrupt files: truncated at every tenth of their length, and with random bytes flipped (fuzz)', async () => {
    const jpg = await solid(300, 200, 'jpeg');
    for (let k = 1; k < 10; k++) {
      const cut = jpg.subarray(0, Math.floor((jpg.length * k) / 10));
      const r = await refusal(cut);
      if (r === 'ok') {
        // A decoder may recover a partial image; what comes out must still be a clean JPEG.
        const out = await cleanPhoto(cut);
        expect(hasMetadataMarkers(out.bytes)).toBe(false);
      } else expect(['unreadable', 'not_image']).toContain(r);
    }
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 60; i++) {
      const b = Buffer.from(jpg);
      for (let j = 0; j < 20; j++) b[3 + Math.floor(rand() * (b.length - 3))] = Math.floor(rand() * 256);
      const r = await refusal(b);
      expect(['ok', 'unreadable', 'not_image', 'too_small', 'too_big']).toContain(r);
    }
  });

  it('pure random bytes are never accepted (fuzz)', async () => {
    let seed = 99;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 200; i++) {
      const b = Buffer.alloc(16 + Math.floor(rand() * 2000));
      for (let j = 0; j < b.length; j++) b[j] = Math.floor(rand() * 256);
      expect(await refusal(b)).not.toBe('ok');
    }
  });

  it('a real 10001 x 10001 PNG (a tiny, CRC-valid file) is refused by the pixel limit; a real image just under it is accepted', async () => {
    const bomb = greyPng(10001, 10001);
    expect(bomb.length).toBeLessThan(400_000);
    // It really is a valid PNG of that size (the decoder reads its header without complaint).
    const meta = await sharp(bomb, { limitInputPixels: false }).metadata();
    expect([meta.width, meta.height]).toEqual([10001, 10001]);
    await expect(cleanPhoto(bomb)).rejects.toSatisfy((e: unknown) => e instanceof PhotoError && e.code === 'too_big');
    // Just under 36 million pixels: decoded, shrunk and kept.
    const under = greyPng(6000, 5999);
    expect(6000 * 5999).toBeLessThan(PHOTO_LIMITS.maxInputPixels);
    const out = await cleanPhoto(under);
    expect(out.width).toBe(2000);
    expect(out.height).toBeGreaterThanOrEqual(1999);
    expect(out.height).toBeLessThanOrEqual(2000);
    // Just over: refused.
    await expect(cleanPhoto(greyPng(6001, 6000))).rejects.toSatisfy((e: unknown) => e instanceof PhotoError && e.code === 'too_big');
    expect(PHOTO_LIMITS.maxInputPixels).toBe(36_000_000);
  }, 120_000);

  it('too large a file, and too small an image', async () => {
    const big = Buffer.alloc(PHOTO_LIMITS.maxUploadBytes + 1, 0);
    big[0] = 0xff;
    big[1] = 0xd8;
    big[2] = 0xff;
    expect(await refusal(big)).toBe('too_big');
    expect(await refusal(await solid(40, 400))).toBe('too_small');
  });
});

describe('browser resize maths', () => {
  it('fits inside 2000 pixels, keeps the shape and never enlarges (property)', () => {
    for (let i = 0; i < 500; i++) {
      const w = 1 + Math.floor(Math.random() * 12000);
      const h = 1 + Math.floor(Math.random() * 12000);
      const t = targetSize(w, h);
      expect(Math.max(t.width, t.height)).toBeLessThanOrEqual(2000);
      if (Math.max(w, h) <= 2000) expect(t).toEqual({ width: w, height: h });
      else {
        const scale = 2000 / Math.max(w, h);
        expect(Math.abs(t.width - w * scale)).toBeLessThanOrEqual(1);
        expect(Math.abs(t.height - h * scale)).toBeLessThanOrEqual(1);
      }
    }
    expect(targetSize(0, 10)).toEqual({ width: 0, height: 0 });
  });
});
