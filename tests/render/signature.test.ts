import { afterAll, describe, expect, it } from 'vitest';
import { closeRenderBrowser, reencodeSignature } from '../../src/lib/render-service';
import { launchBrowser, newLockedPage } from '../../src/pdf/browser';
import { checkSignatureUpload, pngChunks } from '../../src/lib/signature-image';

afterAll(() => closeRenderBrowser());

/** A JPEG drawn by Chrome, with an EXIF segment carrying GPS-like text spliced in after the start marker. */
async function dirtyJpeg(): Promise<Buffer> {
  const b = await launchBrowser();
  try {
    const page = await newLockedPage(b);
    const b64 = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 1800;
      c.height = 600;
      const x = c.getContext('2d')!;
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, 1800, 600);
      x.strokeStyle = '#102040';
      x.lineWidth = 14;
      x.beginPath();
      x.moveTo(100, 400);
      x.bezierCurveTo(400, 50, 700, 550, 1700, 200);
      x.stroke();
      return c.toDataURL('image/jpeg', 0.9).split(',')[1];
    });
    const jpg = Buffer.from(b64, 'base64');
    const payload = Buffer.from('Exif\0\0GPSLatitude 51.39N Owner phone 07000000000', 'latin1');
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 2);
    return Buffer.concat([jpg.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, payload, jpg.subarray(2)]);
  } finally {
    await b.close();
  }
}

/** A landscape-coded JPEG (1200 x 400 pixels) whose EXIF says "rotate 90 degrees" (orientation 6): it shows upright. */
async function rotatedJpeg(): Promise<Buffer> {
  const b = await launchBrowser();
  try {
    const page = await newLockedPage(b);
    const b64 = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 1200;
      c.height = 400;
      const x = c.getContext('2d')!;
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, 1200, 400);
      x.fillStyle = '#102040';
      x.fillRect(100, 150, 1000, 100);
      return c.toDataURL('image/jpeg', 0.9).split(',')[1];
    });
    const jpg = Buffer.from(b64, 'base64');
    // TIFF, big-endian: one IFD entry, tag 0x0112 (Orientation), SHORT, count 1, value 6.
    const tiff = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(payload.length + 2);
    return Buffer.concat([jpg.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, payload, jpg.subarray(2)]);
  } finally {
    await b.close();
  }
}

describe('signature re-encoding (real Chrome)', () => {
  it('a photo turned upright by its EXIF orientation keeps its shape (sized after decoding, not from the header)', async () => {
    const input = await rotatedJpeg();
    const check = checkSignatureUpload(input);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect([check.image.width, check.image.height]).toEqual([1200, 400]);
    const out = await reencodeSignature(input, check.image);
    // Upright it is 400 wide and 1200 tall: fitted into 1200 x 400 that is 133 x 400, not a squashed 1200 x 400.
    expect([out.width, out.height]).toEqual([133, 400]);
    expect([out.png.readUInt32BE(16), out.png.readUInt32BE(20)]).toEqual([133, 400]);
    expect(out.png.toString('latin1')).not.toMatch(/Exif/);
  }, 30_000);

  it('returns a fresh PNG of only the pixels, scaled to fit 1200 by 400, with paper made transparent', async () => {
    const input = await dirtyJpeg();
    const check = checkSignatureUpload(input);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    const out = await reencodeSignature(input, check.image);
    expect(out.png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect([...new Set(pngChunks(out.png))]).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(out.png.toString('latin1')).not.toMatch(/Exif|GPS|07000000000/);
    expect([out.width, out.height]).toEqual([1200, 400]);
    expect(out.png.readUInt32BE(16)).toBe(1200);
    // Colour type 6 (RGBA): the white paper became transparent.
    expect(out.png[25]).toBe(6);
  }, 30_000);
  it('a file that claims to be a JPEG but does not decode is refused', async () => {
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 1, 0, 1, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), Buffer.alloc(64, 7)]);
    const check = checkSignatureUpload(fake);
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    await expect(reencodeSignature(fake, check.image)).rejects.toThrow();
  }, 30_000);
});
