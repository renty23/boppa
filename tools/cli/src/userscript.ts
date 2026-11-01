import type { InjectionTime } from "./manifest.ts";

export interface UserScriptMetadata {
  name: string;
  injectionTime: InjectionTime;
}

const OPEN = "// ==UserScript==";
const CLOSE = "// ==/UserScript==";
const RUN_AT: Record<string, InjectionTime> = {
  "document-start": "atDocumentStart",
  "document-end": "atDocumentEnd",
  "document-idle": "atDocumentEnd",
};
const INFORMATIONAL_KEYS = new Set(["description", "version", "author", "namespace"]);

export function parseUserScriptMetadata(source: string): UserScriptMetadata {
  const lines = source.replace(/^﻿/, "").split(/\r?\n/);
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  if (lines[start]?.trim() !== OPEN) {
    throw new Error(`must start with a "${OPEN}" metadata block`);
  }

  const values = new Map<string, string>();
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === CLOSE) return toMetadata(values);
    if (line === "" || line === "//") continue;
    const match = /^\/\/\s*@([\w:-]+)(?:\s+(.*))?$/.exec(line);
    if (!match) throw new Error(`metadata block line ${i + 1} is not "// @key value": ${line}`);
    const [, key, value = ""] = match;
    if (key !== "name" && key !== "run-at" && !INFORMATIONAL_KEYS.has(key)) {
      throw new Error(`@${key} is not supported; use @name and @run-at`);
    }
    if (values.has(key)) throw new Error(`@${key} is declared more than once`);
    values.set(key, value.trim());
  }
  throw new Error(`metadata block is not closed with "${CLOSE}"`);
}

function toMetadata(values: Map<string, string>): UserScriptMetadata {
  const name = values.get("name");
  if (!name) throw new Error("metadata block is missing @name");
  const runAt = values.get("run-at") ?? "document-idle";
  const injectionTime = RUN_AT[runAt];
  if (!injectionTime) {
    throw new Error(`@run-at ${runAt} is not supported; use ${Object.keys(RUN_AT).join(", ")}`);
  }
  return { name, injectionTime };
}
