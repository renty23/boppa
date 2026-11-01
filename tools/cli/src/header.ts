import { crc32 } from "node:zlib";

export const HEADER_ENTRY_NAME = "boppa.json";
export const HEADER_PAYLOAD_SIZE = 256;
export const HEADER_PAYLOAD_OFFSET = 30 + HEADER_ENTRY_NAME.length;
export const HEADER_SIZE = HEADER_PAYLOAD_OFFSET + HEADER_PAYLOAD_SIZE;
export const PACKAGE_FORMAT = 1;

export interface PackageHeader {
  format: number;
  id: string;
  version: string;
}

export function encodeHeaderPayload(id: string, version: string): Buffer {
  const json = Buffer.from(JSON.stringify({ format: PACKAGE_FORMAT, id, version }), "utf8");
  if (json.length > HEADER_PAYLOAD_SIZE) {
    throw new Error(
      `id and version are too long for the ${HEADER_PAYLOAD_SIZE}-byte header ` +
        `(${json.length} bytes encoded)`,
    );
  }
  return Buffer.concat([json, Buffer.alloc(HEADER_PAYLOAD_SIZE - json.length, 0x20)]);
}

export function headerPayloadFits(id: string, version: string): boolean {
  return Buffer.byteLength(JSON.stringify({ format: PACKAGE_FORMAT, id, version })) <=
    HEADER_PAYLOAD_SIZE;
}

export function parseHeader(bytes: Buffer): PackageHeader {
  if (bytes.length < HEADER_SIZE) throw new Error(`Header needs ${HEADER_SIZE} bytes, got ${bytes.length}`);
  const expect = (condition: boolean, message: string) => {
    if (!condition) throw new Error(`Invalid .boppa header: ${message}`);
  };
  expect(bytes.readUInt32LE(0) === 0x04034b50, "missing zip local file header signature");
  expect((bytes.readUInt16LE(6) & 0x1) === 0, "first entry is encrypted");
  expect(bytes.readUInt16LE(8) === 0, "first entry is not stored uncompressed");
  expect(bytes.readUInt32LE(18) === HEADER_PAYLOAD_SIZE, "first entry has the wrong compressed size");
  expect(bytes.readUInt32LE(22) === HEADER_PAYLOAD_SIZE, "first entry has the wrong size");
  expect(bytes.readUInt16LE(26) === HEADER_ENTRY_NAME.length, "first entry has the wrong name length");
  expect(bytes.readUInt16LE(28) === 0, "first entry has an extra field");
  expect(
    bytes.subarray(30, HEADER_PAYLOAD_OFFSET).toString("ascii") === HEADER_ENTRY_NAME,
    `first entry is not ${HEADER_ENTRY_NAME}`,
  );
  const payload = bytes.subarray(HEADER_PAYLOAD_OFFSET, HEADER_SIZE);
  expect(crc32(payload) === bytes.readUInt32LE(14), "header checksum mismatch");

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error("Invalid .boppa header: payload is not JSON");
  }
  const header = parsed as Partial<PackageHeader>;
  expect(typeof header.format === "number", "format is missing");
  expect(typeof header.id === "string" && header.id.length > 0, "id is missing");
  expect(typeof header.version === "string" && header.version.length > 0, "version is missing");
  return header as PackageHeader;
}
