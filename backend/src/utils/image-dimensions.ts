/**
 * The pixel size of a picture, read from its header — the one fact the chat
 * needs BEFORE the bytes arrive (note #302).
 *
 * A transcript row that says "there is a picture here" but not how big lets
 * the screen draw nothing for it until the browser has fetched and decoded
 * it, and then grow the row under the reader. With the size known the row is
 * drawn at its final height from the first paint, and the pixels land into a
 * frame that was already there.
 *
 * Headers only: PNG, JPEG, GIF and WebP are what phones and screenshot tools
 * produce, and each writes its size within the first few hundred bytes. No
 * decoder and no dependency; anything else — or a damaged header — answers
 * null, which the screen treats as "unknown", exactly as it treats a row
 * stored before this existed.
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const plausible = (width: number, height: number): ImageDimensions | null =>
  (width > 0 && height > 0 && width < 1 << 16 && height < 1 << 16 ? { width, height } : null);

function png(data: Buffer): ImageDimensions | null {
  // Signature, then the IHDR chunk: length(4) type(4) width(4) height(4).
  if (data.length < 24 || !data.subarray(0, 8).equals(PNG_MAGIC)) return null;
  if (data.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return plausible(data.readUInt32BE(16), data.readUInt32BE(20));
}

function gif(data: Buffer): ImageDimensions | null {
  if (data.length < 10) return null;
  const head = data.subarray(0, 6).toString('latin1');
  if (head !== 'GIF87a' && head !== 'GIF89a') return null;
  return plausible(data.readUInt16LE(6), data.readUInt16LE(8));
}

function jpeg(data: Buffer): ImageDimensions | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  // Walk the marker segments to the first start-of-frame, which carries the
  // size. EXIF and ICC segments sit before it and can be tens of kilobytes,
  // so this is a walk rather than a fixed offset. Frames 0–15 except the
  // DHT/JPG/DAC markers (C4, C8, CC) are SOF variants.
  let at = 2;
  while (at + 9 < data.length) {
    if (data[at] !== 0xff) { at += 1; continue; }
    const marker = data[at + 1]!;
    if (marker === 0xff) { at += 1; continue; }
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / scan data before any frame
    const length = data.readUInt16BE(at + 2);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (at + 9 > data.length) return null;
      return plausible(data.readUInt16BE(at + 7), data.readUInt16BE(at + 5));
    }
    at += 2 + length;
  }
  return null;
}

function webp(data: Buffer): ImageDimensions | null {
  if (data.length < 30) return null;
  if (data.subarray(0, 4).toString('latin1') !== 'RIFF' || data.subarray(8, 12).toString('latin1') !== 'WEBP') return null;
  const chunk = data.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8X') {
    // Canvas size, 24 bits each, minus one.
    return plausible(1 + data.readUIntLE(24, 3), 1 + data.readUIntLE(27, 3));
  }
  if (chunk === 'VP8L') {
    if (data[20] !== 0x2f) return null;
    const bits = data.readUInt32LE(21);
    return plausible(1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff));
  }
  if (chunk === 'VP8 ') {
    // Lossy: after the 3-byte frame tag comes a start code, then 14-bit sizes.
    if (data[23] !== 0x9d || data[24] !== 0x01 || data[25] !== 0x2a) return null;
    return plausible(data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff);
  }
  return null;
}

/** The picture's pixel size from its header, or null for anything that is not
 *  a picture this reads. The bytes are sniffed, never the declared type: a
 *  screenshot named `.jpg` that is really a PNG still measures. */
export function imageDimensions(data: Buffer | Uint8Array): ImageDimensions | null {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return png(bytes) ?? jpeg(bytes) ?? gif(bytes) ?? webp(bytes);
}
