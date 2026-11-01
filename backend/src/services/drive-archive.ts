import { crc32 } from 'node:zlib';

/**
 * A Drive folder as one .zip (note #694).
 *
 * Written by hand because the format needed here is the oldest and smallest
 * part of it: every file STORED, not compressed, one after another, with the
 * directory at the end. Drive is mostly pictures, PDFs and recordings, which
 * are compressed already; storing them costs nothing in size and buys the
 * one thing a reader watches on a large download — an exact Content-Length,
 * known before the first byte, so the browser can draw real progress.
 *
 * No ZIP64: the caller keeps an archive far below the 4 GiB its offsets can
 * address and Drive's 10,000 items below the 65,535 entries it can count.
 */
export interface ZipEntry {
  /** Slash-separated, a folder's ending in `/`. Names cannot carry a slash
   *  or `..` (Drive refuses both), so nothing here can climb out on unzip. */
  path: string;
  kind: 'file' | 'folder';
  sizeBytes: number;
  modifiedAt: string;
}

const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
/** Bit 11: the names are UTF-8, so 画面.png unzips as 画面.png. */
const UTF8_NAMES = 0x0800;

/** The archive's exact size, from the records alone. */
export function zipLength(entries: ZipEntry[]): number {
  return entries.reduce((sum, entry) => sum + LOCAL_HEADER + CENTRAL_HEADER
    + 2 * Buffer.byteLength(entry.path) + (entry.kind === 'file' ? entry.sizeBytes : 0), END_RECORD);
}

/** MS-DOS date and time, which have no zone; UTC is the honest choice. */
function dosStamp(iso: string): { time: number; date: number } {
  const parsed = new Date(iso);
  const at = Number.isFinite(parsed.getTime()) ? parsed : new Date();
  const year = Math.min(Math.max(at.getUTCFullYear(), 1980), 2107);
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

/**
 * Write the archive through `write`, reading each file's bytes as its turn
 * comes so only one file is ever held. A file whose bytes are not the size
 * its record promised stops the archive rather than mislabelling it: the
 * Content-Length is already on the wire, and a short or long body there is a
 * corrupt download either way.
 */
export async function writeZip<T extends ZipEntry>(entries: T[], read: (entry: T) => Promise<Buffer>,
  write: (chunk: Buffer) => Promise<void>): Promise<void> {
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const data = entry.kind === 'file' ? await read(entry) : Buffer.alloc(0);
    if (entry.kind === 'file' && data.length !== entry.sizeBytes) throw new Error('A file changed size while it was being archived.');
    const crc = data.length ? crc32(data) : 0;
    const { time, date } = dosStamp(entry.modifiedAt);

    const local = Buffer.alloc(LOCAL_HEADER);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    await write(Buffer.concat([local, name]));
    if (data.length) await write(data);

    const central = Buffer.alloc(CENTRAL_HEADER);
    central.writeUInt32LE(0x02014b50, 0);
    // Made by Unix, so the modes below are read: rw-r--r-- and rwxr-xr-x.
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.kind === 'folder' ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += LOCAL_HEADER + name.length + data.length;
  }
  const central = Buffer.concat(directory);
  const end = Buffer.alloc(END_RECORD);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  await write(central);
  await write(end);
}
