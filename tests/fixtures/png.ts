import { crc32, deflateSync } from 'node:zlib';

/**
 * A real, CRC-valid greyscale PNG of any size, made in memory. A single-colour image compresses to almost nothing, so
 * a 10001 x 10001 picture is a tiny file that still decodes to 100 million pixels.
 */
export function greyPng(width: number, height: number, shade = 128): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // Each row: filter byte 0, then one byte per pixel.
  const row = Buffer.alloc(width + 1, shade);
  row[0] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) row.copy(raw, y * (width + 1));
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
