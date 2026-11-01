import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { isSafePath } from "./paths.ts";

export interface ZipEntry {
  name: string;
  data: Buffer;
  store?: boolean;
}

export const MAX_ENTRIES = 1000;
export const MAX_TOTAL_UNCOMPRESSED_BYTES = 10 * 1024 * 1024;

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const VERSION_MADE_BY_UNIX = (3 << 8) | 20;
const UNIX_FILE_MODE = 0o100644;

export function writeZip(entries: ZipEntry[]): Buffer {
  const names = new Set<string>();
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    if (!isSafePath(entry.name)) throw new Error(`Unsafe zip entry name "${entry.name}"`);
    if (names.has(entry.name)) throw new Error(`Duplicate zip entry "${entry.name}"`);
    names.add(entry.name);

    const name = Buffer.from(entry.name, "ascii");
    const checksum = crc32(entry.data);
    let method = METHOD_STORED;
    let payload = entry.data;
    if (!entry.store && entry.data.length > 0) {
      const deflated = deflateRawSync(entry.data, { level: 9 });
      if (deflated.length < entry.data.length) {
        method = METHOD_DEFLATED;
        payload = deflated;
      }
    }
    const versionNeeded = method === METHOD_DEFLATED ? 20 : 10;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    local.writeUInt16LE(versionNeeded, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
    central.writeUInt16LE(VERSION_MADE_BY_UNIX, 4);
    central.writeUInt16LE(versionNeeded, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((UNIX_FILE_MODE << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);

    localParts.push(local, name, payload);
    centralParts.push(central, name);
    offset += local.length + name.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

export function readZip(zip: Buffer): Map<string, Buffer> {
  const endOffset = findEndOfCentralDirectory(zip);
  const entryCount = zip.readUInt16LE(endOffset + 10);
  const centralSize = zip.readUInt32LE(endOffset + 12);
  const centralOffset = zip.readUInt32LE(endOffset + 16);
  if (entryCount > MAX_ENTRIES) throw new Error(`Too many entries (${entryCount})`);
  if (centralOffset + centralSize > endOffset) throw new Error("Corrupt central directory");

  const files = new Map<string, Buffer>();
  let totalSize = 0;
  let cursor = centralOffset;
  for (let i = 0; i < entryCount; i++) {
    if (zip.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("Corrupt central directory entry");
    }
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const checksum = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue;
    if (!isSafePath(name)) throw new Error(`Unsafe entry name "${name}"`);
    if (files.has(name)) throw new Error(`Duplicate entry "${name}"`);
    if (flags & 0x1) throw new Error(`Encrypted entry "${name}"`);
    totalSize += size;
    if (totalSize > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error("Package is too large");

    if (zip.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw new Error(`Corrupt local header for "${name}"`);
    }
    const dataOffset = localOffset + 30 + zip.readUInt16LE(localOffset + 26) +
      zip.readUInt16LE(localOffset + 28);
    const payload = zip.subarray(dataOffset, dataOffset + compressedSize);
    if (payload.length !== compressedSize) throw new Error(`Truncated entry "${name}"`);

    let data: Buffer;
    if (method === METHOD_STORED) {
      data = Buffer.from(payload);
    } else if (method === METHOD_DEFLATED) {
      data = inflateRawSync(payload, { maxOutputLength: Math.max(size, 1) });
    } else {
      throw new Error(`Unsupported compression method ${method} for "${name}"`);
    }
    if (data.length !== size) throw new Error(`Size mismatch for "${name}"`);
    if (crc32(data) !== checksum) throw new Error(`Checksum mismatch for "${name}"`);
    files.set(name, data);
  }
  return files;
}

function findEndOfCentralDirectory(zip: Buffer): number {
  const minimum = Math.max(0, zip.length - 22 - 0xffff);
  for (let i = zip.length - 22; i >= minimum; i--) {
    if (zip.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) return i;
  }
  throw new Error("Not a zip archive");
}
