import { describe, expect, it } from 'vitest';
import { imageDimensions } from '../../utils/image-dimensions.js';

/** A PNG header with the given size and nothing after it: enough to measure. */
export function pngHeader(width: number, height: number): Buffer {
  const out = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(out, 0);
  out.writeUInt32BE(13, 8);
  out.write('IHDR', 12, 'latin1');
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  return out;
}

describe('imageDimensions', () => {
  it('reads a PNG', () => {
    expect(imageDimensions(pngHeader(1179, 2556))).toEqual({ width: 1179, height: 2556 });
  });

  it('reads a JPEG past its EXIF segment', () => {
    // SOI, an APP1 segment of 300 bytes, then SOF0 carrying 640x480.
    const app1 = Buffer.alloc(304);
    app1[0] = 0xff; app1[1] = 0xe1; app1.writeUInt16BE(302, 2);
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03]);
    const data = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof]);
    expect(imageDimensions(data)).toEqual({ width: 640, height: 480 });
  });

  it('does not take a Huffman table for a frame', () => {
    const dht = Buffer.from([0xff, 0xc4, 0x00, 0x06, 0x00, 0x11, 0x22, 0x33]);
    const sof = Buffer.from([0xff, 0xc2, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03]);
    expect(imageDimensions(Buffer.concat([Buffer.from([0xff, 0xd8]), dht, sof]))).toEqual({ width: 32, height: 16 });
  });

  it('reads a GIF', () => {
    const data = Buffer.alloc(16);
    data.write('GIF89a', 0, 'latin1');
    data.writeUInt16LE(200, 6);
    data.writeUInt16LE(100, 8);
    expect(imageDimensions(data)).toEqual({ width: 200, height: 100 });
  });

  it('reads the three WebP layouts', () => {
    const riff = (chunk: string, body: Buffer) => {
      const out = Buffer.alloc(30 + body.length);
      out.write('RIFF', 0, 'latin1'); out.write('WEBP', 8, 'latin1'); out.write(chunk, 12, 'latin1');
      body.copy(out, 20);
      return out;
    };
    const vp8x = Buffer.alloc(10);
    vp8x.writeUIntLE(1023, 4, 3); vp8x.writeUIntLE(767, 7, 3);
    expect(imageDimensions(riff('VP8X', vp8x))).toEqual({ width: 1024, height: 768 });
    const vp8l = Buffer.alloc(5);
    vp8l[0] = 0x2f; vp8l.writeUInt32LE((299 << 14) | 399, 1);
    expect(imageDimensions(riff('VP8L', vp8l))).toEqual({ width: 400, height: 300 });
    const vp8 = Buffer.alloc(10);
    vp8[3] = 0x9d; vp8[4] = 0x01; vp8[5] = 0x2a; vp8.writeUInt16LE(320, 6); vp8.writeUInt16LE(240, 8);
    expect(imageDimensions(riff('VP8 ', vp8))).toEqual({ width: 320, height: 240 });
  });

  it('answers null for what it cannot read', () => {
    expect(imageDimensions(Buffer.from('%PDF-1.4'))).toBeNull();
    expect(imageDimensions(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]))).toBeNull();
    expect(imageDimensions(Buffer.alloc(0))).toBeNull();
    expect(imageDimensions(pngHeader(0, 10))).toBeNull();
  });
});
