import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const script = (name: string, runAt = "document-end", body = "(function() {})();\n") =>
  `// ==UserScript==\n// @name         ${name}\n// @run-at       ${runAt}\n// ==/UserScript==\n\n${body}`;

export const dataLibrary = (...paths: string[]) =>
  `boppa.data.register({\n${paths.map((path) => `  ${JSON.stringify(path)}: async function() { return { items: [] }; },\n`).join("")}});\n`;

export const playerLibrary = "boppa.playback.register({ resolve: function() {} });\n";

export const baseManifest = {
  id: "example.com",
  fqdn: "example.com",
  version: "1.0.0",
  name: "Example",
  trackTypes: [{ id: "song" }],
  profileTypes: [],
  tracklistTypes: [],
};

export function makeSource(files: Record<string, string | object | undefined>): string {
  const dir = mkdtempSync(join(tmpdir(), "boppa-source-"));
  const all: Record<string, string | object | undefined> = {
    "manifest.json": baseManifest,
    "container/50-search-tracks-song.js": dataLibrary("search/tracks/song"),
    "playback/index.html": "<!doctype html><html></html>\n",
    "playback/01-bridge.js": script("Bridge", "document-start"),
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    if (content === undefined) continue;
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}
