import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import {
  encodeHeaderPayload,
  HEADER_ENTRY_NAME,
  type PackageHeader,
  parseHeader,
} from "./header.ts";
import {
  type Manifest,
  MANIFEST_FILE,
  parseJson,
  validateSource,
  ValidationError,
} from "./manifest.ts";
import { readZip, writeZip } from "./zip.ts";

export interface Source {
  manifest: Manifest;
  files: Map<string, Buffer>;
}

export interface Package extends Source {
  header: PackageHeader;
}

export function loadSourceDir(dir: string): Source {
  const subject = basename(dir);
  const files = new Map<string, Buffer>();
  const problems: string[] = [];
  let manifestText: string | undefined;

  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      const rel = relative(dir, path).split(sep).join("/");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        problems.push(`${rel}: symbolic links are not allowed`);
      } else if (stat.isDirectory()) {
        walk(path);
      } else if (rel === MANIFEST_FILE) {
        manifestText = readFileSync(path, "utf8");
      } else {
        files.set(rel, readFileSync(path));
      }
    }
  };
  walk(dir);

  if (problems.length > 0) throw new ValidationError(subject, problems);
  if (manifestText === undefined) throw new ValidationError(subject, [`${MANIFEST_FILE} is missing`]);
  const manifest = validateSource(subject, parseJson(manifestText, `${subject}/${MANIFEST_FILE}`), files);
  return { manifest, files };
}

export function packageManifest(manifest: Manifest): Buffer {
  const { $schema: _, ...rest } = manifest;
  return Buffer.from(JSON.stringify(rest, null, 2) + "\n", "utf8");
}

export function pack(source: Source): Buffer {
  const { manifest, files } = source;
  const sorted = [...files.keys()].sort();
  return writeZip([
    { name: HEADER_ENTRY_NAME, data: encodeHeaderPayload(manifest.id, manifest.version), store: true },
    { name: MANIFEST_FILE, data: packageManifest(manifest) },
    ...sorted.map((name) => ({ name, data: files.get(name)! })),
  ]);
}

export function readPackage(bytes: Buffer, subject = "package"): Package {
  const header = parseHeader(bytes);
  const entries = readZip(bytes);
  const manifestBytes = entries.get(MANIFEST_FILE);
  if (!manifestBytes) throw new ValidationError(subject, [`${MANIFEST_FILE} is missing`]);

  const files = new Map(entries);
  files.delete(HEADER_ENTRY_NAME);
  files.delete(MANIFEST_FILE);
  const manifest = validateSource(subject, parseJson(manifestBytes.toString("utf8"), MANIFEST_FILE), files);

  const problems: string[] = [];
  if (header.id !== manifest.id) problems.push(`header id "${header.id}" does not match manifest id "${manifest.id}"`);
  if (header.version !== manifest.version) {
    problems.push(`header version "${header.version}" does not match manifest version "${manifest.version}"`);
  }
  if (problems.length > 0) throw new ValidationError(subject, problems);
  return { header, manifest, files };
}

export function contentHash(source: Source): string {
  const hash = createHash("sha256");
  const entries: [string, Buffer][] = [
    [MANIFEST_FILE, packageManifest(source.manifest)],
    ...[...source.files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ];
  for (const [name, data] of entries) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(data.length));
    hash.update(name).update("\0").update(length).update(data);
  }
  return hash.digest("hex");
}
