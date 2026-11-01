#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { APP_CONFIG_FILE, BASE_URL_VARIABLE, build, defaultBaseUrl, loadRepo, normalizeBaseUrl } from "./build.ts";
import { checkVersions } from "./check.ts";
import { loadContainer } from "./container.ts";
import { HEADER_SIZE, parseHeader } from "./header.ts";
import {
  ENTRY_DIRS,
  entryKeys,
  MANIFEST_FILE,
  PLAYBACK_DIR,
  readPlaybackConfig,
  CONTAINER_DIR,
  userScripts,
  usesContainerPlayback,
} from "./manifest.ts";
import { contentHash, loadSourceDir, pack, packageManifest, readPackage } from "./package.ts";

const DEFAULT_BASE_URL = defaultBaseUrl();
const REPO_COMMANDS = new Set(["validate", "build", "check-versions"]);

const USAGE = `Usage: boppa <command> [options]

Commands:
  validate [dir...]            Validate source folders, or the whole repository when run from its root
  pack <dir> [-o file]         Pack a source folder into a .boppa file
  inspect <file|url>           Print a package's header and contents; for a URL, fetch only the header
  unpack <file> [-o dir]       Extract a .boppa file into a source folder
  build [-o dir]               Build the repository into a deployable site (default: dist)
  check-versions               Fail if a published source was removed or its id changed

Options:
  -o, --out <path>             Output path
      --base-url <url>         Site the repository deploys to
                               (default: ${DEFAULT_BASE_URL || `$${BASE_URL_VARIABLE}, or "boppa.baseUrl" in package.json`})
  -h, --help                   Show this help`;

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      "base-url": { type: "string", default: DEFAULT_BASE_URL },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, ...args] = positionals;
  const baseUrl = normalizeBaseUrl(values["base-url"]!);
  if (values.help || !command) {
    console.log(USAGE);
    return;
  }
  if (REPO_COMMANDS.has(command) && baseUrl === "") {
    throw new UsageError(`Set ${BASE_URL_VARIABLE}, add "boppa": { "baseUrl": "https://..." } to package.json, or pass --base-url`);
  }

  switch (command) {
    case "validate": {
      if (args.length === 0) {
        const { appConfig, sources } = loadRepo(process.cwd(), baseUrl);
        for (const [name, source] of sources) console.log(`✓ ${name} (${source.manifest.id} ${source.manifest.version})`);
        if (appConfig) console.log(`✓ ${APP_CONFIG_FILE}`);
      } else {
        for (const dir of args) {
          const { manifest } = loadSourceDir(resolve(dir));
          console.log(`✓ ${basename(resolve(dir))} (${manifest.id} ${manifest.version})`);
        }
      }
      return;
    }
    case "pack": {
      const dir = resolve(required(args[0], "pack needs a source folder"));
      const out = resolve(values.out ?? `${basename(dir)}.boppa`);
      const bytes = pack(loadSourceDir(dir));
      readPackage(bytes, basename(out));
      writeFileSync(out, bytes);
      console.log(`${out} (${bytes.length} bytes)`);
      return;
    }
    case "inspect": {
      const target = required(args[0], "inspect needs a file or URL");
      if (/^https?:\/\//.test(target)) {
        await inspectUrl(target);
      } else {
        inspectFile(resolve(target));
      }
      return;
    }
    case "unpack": {
      const file = resolve(required(args[0], "unpack needs a .boppa file"));
      const out = resolve(values.out ?? basename(file, ".boppa"));
      const pkg = readPackage(readFileSync(file), basename(file));
      write(join(out, MANIFEST_FILE), packageManifest(pkg.manifest));
      for (const [path, data] of pkg.files) write(join(out, path), data);
      console.log(out);
      return;
    }
    case "build": {
      const out = resolve(values.out ?? "dist");
      const output = build(process.cwd(), out, baseUrl);
      for (const [path, data] of output) console.log(`${path} (${data.length} bytes)`);
      return;
    }
    case "check-versions": {
      const result = await checkVersions(process.cwd(), baseUrl);
      if (!result.published) {
        console.log(`Nothing published at ${baseUrl} yet, skipping`);
      } else {
        for (const note of result.notes) console.log(note);
        console.log("✓ versions");
      }
      return;
    }
    default:
      throw new UsageError(`Unknown command "${command}"`);
  }
}

function inspectFile(file: string): void {
  const bytes = readFileSync(file);
  const pkg = readPackage(bytes, basename(file));
  console.log(`format        ${pkg.header.format}`);
  console.log(`id            ${pkg.header.id}`);
  console.log(`version       ${pkg.header.version}`);
  console.log(`name          ${pkg.manifest.name}`);
  console.log(`size          ${bytes.length} bytes`);
  console.log(`content hash  ${contentHash(pkg)}`);
  const usesContainer = usesContainerPlayback(pkg.files);
  const container = loadContainer(pkg.files);
  console.log(
    "playback      " +
      (usesContainer
        ? `container (${container.playbackHandlers.join(", ") || "no handlers"})`
        : readPlaybackConfig(pkg.files)?.url ?? "playback/index.html"),
  );
  const libraries = [...pkg.files.keys()].filter((path) => path.startsWith(`${CONTAINER_DIR}/`)).sort();
  if (libraries.length > 0) {
    console.log("container");
    for (const path of libraries) console.log(`  ${path}`);
  }
  console.log("data handlers");
  for (const name of container.dataHandlers) console.log(`  ${name}`);
  const scriptDirs = [
    ...(usesContainer ? [] : [PLAYBACK_DIR]),
    ...ENTRY_DIRS.flatMap((kind) => entryKeys(pkg.files, kind).map((key) => `${kind}/${key}`)),
  ];
  for (const dir of scriptDirs) {
    const scripts = userScripts(pkg.files, dir);
    if (scripts.length === 0) continue;
    console.log(`${dir} scripts`);
    for (const s of scripts) console.log(`  ${s.file}  "${s.name}"  ${s.injectionTime}`);
  }
  console.log("files");
  for (const [path, data] of [...pkg.files].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${path} (${data.length} bytes)`);
  }
}

async function inspectUrl(url: string): Promise<void> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { Range: `bytes=0-${HEADER_SIZE - 1}`, "Accept-Encoding": "identity" },
    signal: controller.signal,
  });
  if (response.status !== 200 && response.status !== 206) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response.body!) {
    chunks.push(Buffer.from(chunk));
    length += chunk.length;
    if (length >= HEADER_SIZE) break;
  }
  controller.abort();
  const header = parseHeader(Buffer.concat(chunks).subarray(0, HEADER_SIZE));
  console.log(`HTTP          ${response.status}${response.status === 206 ? ` (${response.headers.get("content-range")})` : " (range ignored, stream cancelled)"}`);
  console.log(`cache         ${response.headers.get("cf-cache-status") ?? "-"}`);
  console.log(`format        ${header.format}`);
  console.log(`id            ${header.id}`);
  console.log(`version       ${header.version}`);
}

function write(path: string, data: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new UsageError(message);
  return value;
}

class UsageError extends Error {}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
