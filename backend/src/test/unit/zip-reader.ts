import { crc32 } from 'node:zlib';

/** The entries of a stored (uncompressed) .zip, read the way an unzip tool
 *  reads one: from the directory at the end, each checked against its own
 *  local header and checksum. Enough to prove an archive, not a general reader. */
export function readZip(zip: Buffer): { path: string; data: Buffer; folder: boolean }[] {
  const end = zip.length - 22;
  if (zip.readUInt32LE(end) !== 0x06054b50) throw new Error('no end record');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  if (at + zip.readUInt32LE(end + 12) !== end) throw new Error('directory does not end where the end record starts');
  const entries: { path: string; data: Buffer; folder: boolean }[] = [];
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('bad directory entry');
    if (zip.readUInt16LE(at + 10) !== 0) throw new Error('compressed entry');
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    const path = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    if (zip.readUInt32LE(offset) !== 0x04034b50) throw new Error(`bad local header for ${path}`);
    if (zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8') !== path) throw new Error(`name mismatch for ${path}`);
    const start = offset + 30 + nameLength + zip.readUInt16LE(offset + 28);
    const data = zip.subarray(start, start + size);
    if ((size ? crc32(data) : 0) !== crc) throw new Error(`checksum mismatch for ${path}`);
    entries.push({ path, data: Buffer.from(data), folder: path.endsWith('/') });
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return entries;
}
