import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { loadContainer } from "./container.ts";
import { headerPayloadFits } from "./header.ts";
import { isSafePath } from "./paths.ts";
import { parseUserScriptMetadata, type UserScriptMetadata } from "./userscript.ts";

export type InjectionTime = "atDocumentStart" | "atDocumentEnd";

export interface PopupConfig {
  $schema?: string;
  title: string;
  url: string;
  customUserAgent?: string;
}

export interface PlaybackConfig {
  $schema?: string;
  url?: string;
  customUserAgent?: string;
}

export interface WorkerConfig {
  $schema?: string;
  title: string;
  url: string;
  customUserAgent?: string;
}

export type PluralName = string | { one: string; other?: string };

export interface TrackTypeDeclaration {
  id: string;
  name?: PluralName;
  media?: "audio" | "video";
  belongsTo?: string[];
}

export interface ProfileTypeDeclaration {
  id: string;
  name?: PluralName;
}

export interface TracklistTypeDeclaration {
  id: string;
  name?: PluralName;
  presentation?: "album" | "playlist";
}

export interface Manifest {
  $schema?: string;
  id: string;
  fqdn: string;
  version: string;
  name: string;
  author?: string;
  gitUrl?: string;
  highlightColor?: string;
  allowedUrls?: string[];
  trackTypes: TrackTypeDeclaration[];
  profileTypes: ProfileTypeDeclaration[];
  tracklistTypes: TracklistTypeDeclaration[];
}

export interface AppConfig {
  $schema?: string;
  format: 1;
  defaultMediaSources: string[];
}

export interface UserScript extends UserScriptMetadata {
  file: string;
}

export const MANIFEST_FILE = "manifest.json";
export const CONFIG_FILE = "config.json";
export const ENTRY_DIRS = ["workers", "popup"] as const;
export const ICON_FILE = "icon.svg";
export const PLAYBACK_DIR = "playback";
export const PLAYBACK_HTML_FILE = `${PLAYBACK_DIR}/index.html`;
export const PLAYBACK_CONFIG_FILE = `${PLAYBACK_DIR}/${CONFIG_FILE}`;
export const PLAYBACK_SCHEMA = "playback.v1.schema.json";
export const CONTAINER_DIR = "container";

export const TRACK_RADIO_PATH = "list/trackRadio";

export function dataPaths(manifest: Manifest): string[] {
  const tracks = manifest.trackTypes.map((type) => type.id);
  const profiles = manifest.profileTypes.map((type) => type.id);
  const tracklists = manifest.tracklistTypes.map((type) => type.id);
  const groups: [string, string[]][] = [
    ["search/tracks", tracks],
    ["search/profiles", profiles],
    ["search/tracklists", tracklists],
    ["get/track", tracks],
    ["get/profile", profiles],
    ["get/tracklist", tracklists],
    ["list/tracklist", tracklists],
    ["list/profileTracks", tracks],
    ["list/profileTracklists", tracklists],
  ];
  return [
    ...groups.flatMap(([dir, ids]) => ids.map((id) => `${dir}/${id}`)),
    TRACK_RADIO_PATH,
  ];
}

export type EntryKind = typeof ENTRY_DIRS[number];

export const ENTRY_SCHEMAS: Record<EntryKind, string> = {
  workers: "worker.v1.schema.json",
  popup: "popup.v1.schema.json",
};

const ENTRY_KEY = /^[A-Za-z0-9_-]+$/;

export const MAX_SOURCE_BYTES = 5 * 1024 * 1024;

export class ValidationError extends Error {
  readonly problems: string[];

  constructor(subject: string, problems: string[]) {
    super(`${subject} is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.problems = problems;
  }
}

const schemaUrl = (name: string) => new URL(`../../../schema/${name}`, import.meta.url);
const ajv = new Ajv2020({ allErrors: true, strict: false });
let manifestValidator: ValidateFunction | undefined;
let appConfigValidator: ValidateFunction | undefined;
let playbackValidator: ValidateFunction | undefined;
const entryValidators = new Map<EntryKind, ValidateFunction>();

function compile(name: string): ValidateFunction {
  return ajv.compile(JSON.parse(readFileSync(schemaUrl(name), "utf8")));
}

function describeSchemaErrors(errors: ErrorObject[] | null | undefined): string[] {
  return [...new Set((errors ?? []).map((e) => {
    const at = e.instancePath || "(root)";
    if (e.keyword === "additionalProperties") {
      return `${at}: unknown field "${(e.params as { additionalProperty: string }).additionalProperty}"`;
    }
    return `${at}: ${e.message}`;
  }))];
}

export function parseJson(text: string, subject: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ValidationError(subject, [`not valid JSON: ${(error as Error).message}`]);
  }
}

export function validateAppConfig(value: unknown): AppConfig {
  appConfigValidator ??= compile("iOS-config.v1.schema.json");
  if (!appConfigValidator(value)) {
    throw new ValidationError("iOS-config.json", describeSchemaErrors(appConfigValidator.errors));
  }
  return value as AppConfig;
}

export function isEntryKind(value: string): value is EntryKind {
  return (ENTRY_DIRS as readonly string[]).includes(value);
}

export function entryKeys(files: Map<string, Buffer>, kind: EntryKind): string[] {
  const keys = new Set<string>();
  for (const path of files.keys()) {
    const parts = path.split("/");
    if (parts[0] === kind && parts.length >= 3) keys.add(parts[1]);
  }
  return [...keys].sort(compareBytes);
}

export function entryConfig<T>(files: Map<string, Buffer>, kind: EntryKind, key: string): T | undefined {
  const data = files.get(`${kind}/${key}/${CONFIG_FILE}`);
  return data === undefined ? undefined : JSON.parse(data.toString("utf8")) as T;
}

export function userScripts(files: Map<string, Buffer>, dir: string): UserScript[] {
  const prefix = `${dir}/`;
  return [...files.keys()]
    .filter((path) => path.startsWith(prefix) && path.endsWith(".js") && !path.slice(prefix.length).includes("/"))
    .sort(compareBytes)
    .map((file) => ({ file, ...parseUserScriptMetadata(files.get(file)!.toString("utf8")) }));
}

export function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export function validateSource(
  subject: string,
  manifestValue: unknown,
  files: Map<string, Buffer>,
): Manifest {
  manifestValidator ??= compile("manifest.v1.schema.json");
  if (!manifestValidator(manifestValue)) {
    throw new ValidationError(subject, describeSchemaErrors(manifestValidator.errors));
  }
  const manifest = manifestValue as Manifest;
  const problems: string[] = [];

  if (!headerPayloadFits(manifest.id, manifest.version)) {
    problems.push("id and version are too long to fit in the 256-byte package header");
  }

  const hasPlaybackHtml = files.has(PLAYBACK_HTML_FILE);
  const playback = validatePlaybackConfig(files, problems);
  const usesContainer = !hasPlaybackHtml && playback?.url === undefined;
  if (hasPlaybackHtml && playback?.url !== undefined) {
    problems.push(`use either ${PLAYBACK_HTML_FILE} or "url" in ${PLAYBACK_CONFIG_FILE}, not both`);
  }

  problems.push(...typeProblems(manifest));
  problems.push(...entryProblems(files));
  let totalBytes = 0;

  for (const [path, data] of files) {
    totalBytes += data.length;
    if (!isSafePath(path)) {
      problems.push(`${path}: file names may only contain letters, digits, ".", "_" and "-"`);
      continue;
    }
    let text: string | undefined;
    try {
      text = utf8.decode(data);
    } catch {
      problems.push(`${path}: not valid UTF-8`);
    }

    const parts = path.split("/");
    const userScriptDir = parts.length >= 2 && parts.at(-1)!.endsWith(".js") ? parts.slice(0, -1).join("/") : undefined;

    if (path === ICON_FILE) {
      if (text !== undefined && !/<svg[\s>]/.test(text)) problems.push(`${path}: does not contain an <svg> element`);
    } else if (path === PLAYBACK_HTML_FILE) {
      continue;
    } else if (parts[0] === CONTAINER_DIR) {
      if (!isContainerLibrary(path)) {
        problems.push(`${path}: ${CONTAINER_DIR}/ only holds .js files, directly inside it`);
      }
    } else if (usesContainer && parts[0] === PLAYBACK_DIR) {
      problems.push(`${path}: ${PLAYBACK_DIR}/ only holds a WebView player page and its user scripts`);
    } else if (path === PLAYBACK_CONFIG_FILE) {
      continue;
    } else if (userScriptDir !== undefined && isUserScriptDir(userScriptDir)) {
      if (text !== undefined) {
        try {
          parseUserScriptMetadata(text);
        } catch (error) {
          problems.push(`${path}: ${(error as Error).message}`);
        }
      }
    } else if (parts.length === 3 && isEntryKind(parts[0]) && parts[2] === CONFIG_FILE) {
      continue;
    } else {
      problems.push(`${path}: not part of the package layout`);
    }
  }

  if (totalBytes > MAX_SOURCE_BYTES) {
    problems.push(`source is ${totalBytes} bytes, the limit is ${MAX_SOURCE_BYTES}`);
  }

  const container = loadContainer(files);
  problems.push(...container.problems);
  const registersResolve = container.playbackHandlers.includes("resolve");
  if (usesContainer && !registersResolve) {
    problems.push(
      `no player: register resolve with boppa.playback.register in ${CONTAINER_DIR}/*.js, or add ${PLAYBACK_HTML_FILE} or "url" in ${PLAYBACK_CONFIG_FILE}`,
    );
  } else if (!usesContainer && registersResolve) {
    problems.push(
      `registers a playback resolve handler but plays in a WebView from ${PLAYBACK_HTML_FILE} or "url" in ${PLAYBACK_CONFIG_FILE}; use one player`,
    );
  }
  const knownDataPaths = new Set(dataPaths(manifest));
  for (const name of container.dataHandlers) {
    if (!knownDataPaths.has(name)) {
      problems.push(
        `boppa.data.register: "${name}" is not a data path for the declared types; expected one of ${[...knownDataPaths].join(", ")}`,
      );
    }
  }
  if (container.dataHandlers.length === 0) {
    problems.push(`no data handlers registered with boppa.data.register in ${CONTAINER_DIR}/*.js`);
  }

  if (problems.length > 0) throw new ValidationError(subject, problems);
  return manifest;
}

export function usesContainerPlayback(files: Map<string, Buffer>): boolean {
  return !files.has(PLAYBACK_HTML_FILE) && readPlaybackConfig(files)?.url === undefined;
}

export function readPlaybackConfig(files: Map<string, Buffer>): PlaybackConfig | undefined {
  const data = files.get(PLAYBACK_CONFIG_FILE);
  return data === undefined ? undefined : JSON.parse(data.toString("utf8")) as PlaybackConfig;
}

function validatePlaybackConfig(files: Map<string, Buffer>, problems: string[]): PlaybackConfig | undefined {
  const data = files.get(PLAYBACK_CONFIG_FILE);
  if (data === undefined) return undefined;
  let value: unknown;
  try {
    value = parseJson(data.toString("utf8"), PLAYBACK_CONFIG_FILE);
  } catch (error) {
    problems.push(...(error as ValidationError).problems.map((p) => `${PLAYBACK_CONFIG_FILE}: ${p}`));
    return undefined;
  }
  playbackValidator ??= compile(PLAYBACK_SCHEMA);
  if (!playbackValidator(value)) {
    problems.push(...describeSchemaErrors(playbackValidator.errors).map((p) => `${PLAYBACK_CONFIG_FILE}: ${p}`));
    return undefined;
  }
  return value as PlaybackConfig;
}

function isContainerLibrary(path: string): boolean {
  const parts = path.split("/");
  return parts.length === 2 && parts[0] === CONTAINER_DIR && parts[1].endsWith(".js");
}

function isUserScriptDir(dir: string): boolean {
  if (dir === PLAYBACK_DIR) return true;
  const [kind, key, ...rest] = dir.split("/");
  return rest.length === 0 && isEntryKind(kind) && ENTRY_KEY.test(key);
}

function entryProblems(files: Map<string, Buffer>): string[] {
  const problems: string[] = [];
  for (const kind of ENTRY_DIRS) {
    for (const key of entryKeys(files, kind)) {
      const path = `${kind}/${key}/${CONFIG_FILE}`;
      if (!ENTRY_KEY.test(key)) {
        problems.push(`${kind}/${key}: folder names may only contain letters, digits, "_" and "-"`);
        continue;
      }
      const data = files.get(path);
      if (data === undefined) {
        problems.push(`${kind}/${key}: ${CONFIG_FILE} is missing`);
        continue;
      }
      let value: unknown;
      try {
        value = parseJson(data.toString("utf8"), path);
      } catch (error) {
        problems.push(...(error as ValidationError).problems.map((p) => `${path}: ${p}`));
        continue;
      }
      const validate = entryValidator(kind);
      if (!validate(value)) {
        problems.push(...describeSchemaErrors(validate.errors).map((p) => `${path}: ${p}`));
      }
    }
  }
  return problems;
}

function entryValidator(kind: EntryKind): ValidateFunction {
  let validate = entryValidators.get(kind);
  if (validate === undefined) {
    validate = compile(ENTRY_SCHEMAS[kind]);
    entryValidators.set(kind, validate);
  }
  return validate;
}

function typeProblems(manifest: Manifest): string[] {
  const problems: string[] = [];
  const families: [string, { id: string }[]][] = [
    ["trackTypes", manifest.trackTypes],
    ["profileTypes", manifest.profileTypes],
    ["tracklistTypes", manifest.tracklistTypes],
  ];
  for (const [family, types] of families) {
    const seen = new Set<string>();
    for (const type of types) {
      if (seen.has(type.id)) problems.push(`${family}: "${type.id}" is declared more than once`);
      seen.add(type.id);
    }
  }
  const tracklistIds = new Set(manifest.tracklistTypes.map((type) => type.id));
  for (const type of manifest.trackTypes) {
    for (const parent of type.belongsTo ?? []) {
      if (!tracklistIds.has(parent)) {
        problems.push(`trackTypes: "${type.id}" belongsTo "${parent}", which is not a declared tracklist type`);
      }
    }
  }
  return problems;
}
