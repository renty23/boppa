import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HEADER_SIZE, parseHeader } from "../src/header.ts";
import { entryConfig, entryKeys, readPlaybackConfig, userScripts, ValidationError } from "../src/manifest.ts";
import { contentHash, loadSourceDir, pack, readPackage } from "../src/package.ts";
import { readZip } from "../src/zip.ts";
import { baseManifest, dataLibrary, makeSource, playerLibrary, script } from "./helpers.ts";

const problemsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationError) return error.problems;
    throw error;
  }
  assert.fail("expected a ValidationError");
};

test("header is readable from the first bytes alone", () => {
  const bytes = pack(loadSourceDir(makeSource({})));
  assert.deepEqual(parseHeader(bytes.subarray(0, HEADER_SIZE)), {
    format: 1,
    id: "example.com",
    version: "1.0.0",
  });
  assert.equal(HEADER_SIZE, 296);
});

test("header rejects bytes that are not a .boppa header", () => {
  assert.throws(() => parseHeader(Buffer.alloc(HEADER_SIZE)), /signature/);
  const bytes = pack(loadSourceDir(makeSource({})));
  const tampered = Buffer.from(bytes.subarray(0, HEADER_SIZE));
  tampered[60] ^= 1;
  assert.throws(() => parseHeader(tampered), /checksum/);
});

test("packing is deterministic and round-trips", () => {
  const dir = makeSource({});
  const a = pack(loadSourceDir(dir));
  const b = pack(loadSourceDir(dir));
  assert.deepEqual(a, b);
  const pkg = readPackage(a);
  assert.equal(contentHash(pkg), contentHash(loadSourceDir(dir)));
  assert.deepEqual([...readZip(a).keys()].slice(0, 2), ["boppa.json", "manifest.json"]);
});

test("user scripts come from metadata blocks, ordered by file name", () => {
  const source = loadSourceDir(makeSource({
    "playback/02-player.js": script("Player"),
    "playback/10-late.js": script("Late", "document-idle"),
  }));
  assert.deepEqual(userScripts(source.files, "playback").map((s) => [s.file, s.name, s.injectionTime]), [
    ["playback/01-bridge.js", "Bridge", "atDocumentStart"],
    ["playback/02-player.js", "Player", "atDocumentEnd"],
    ["playback/10-late.js", "Late", "atDocumentEnd"],
  ]);
});

test("user scripts without a valid metadata block are rejected", () => {
  const problems = problemsOf(() => loadSourceDir(makeSource({
    "playback/02-no-header.js": "(function() {})();\n",
    "playback/03-no-name.js": "// ==UserScript==\n// @run-at document-end\n// ==/UserScript==\n",
    "playback/04-bad-run-at.js": script("Bad", "context-menu"),
    "playback/05-match.js": "// ==UserScript==\n// @name X\n// @match *://*/*\n// ==/UserScript==\n",
    "playback/06-unclosed.js": "// ==UserScript==\n// @name X\n",
  })));
  assert.equal(problems.length, 5);
  assert.match(problems.join("\n"), /02-no-header\.js: must start with/);
  assert.match(problems.join("\n"), /03-no-name\.js: metadata block is missing @name/);
  assert.match(problems.join("\n"), /04-bad-run-at\.js: @run-at context-menu is not supported/);
  assert.match(problems.join("\n"), /05-match\.js: @match is not supported/);
  assert.match(problems.join("\n"), /06-unclosed\.js: metadata block is not closed/);
});

test("playback takes at most one of index.html or a playback config url", () => {
  const dir = makeSource({ "playback/config.json": { url: "https://example.com/player", customUserAgent: "Agent" } });
  assert.match(problemsOf(() => loadSourceDir(dir)).join(), /not both/);
  rmSync(join(dir, "playback/index.html"));
  assert.deepEqual(readPlaybackConfig(loadSourceDir(dir).files), { url: "https://example.com/player", customUserAgent: "Agent" });
  rmSync(join(dir, "manifest.json"));
  const noPlayback = makeSource({});
  rmSync(join(noPlayback, "playback/index.html"));
  assert.match(problemsOf(() => loadSourceDir(noPlayback)).join(), /playback\/ only holds a WebView player page/);
  rmSync(join(noPlayback, "playback/01-bridge.js"));
  assert.match(problemsOf(() => loadSourceDir(noPlayback)).join(), /no player/);
});

test("a source without a player page or playback config url plays through its container", () => {
  const dir = makeSource({ "container/90-playback.js": playerLibrary });
  rmSync(join(dir, "playback"), { recursive: true });
  assert.doesNotThrow(() => loadSourceDir(dir));
});

test("a WebView source cannot also register a playback resolve handler", () => {
  assert.match(
    problemsOf(() => loadSourceDir(makeSource({ "container/90-playback.js": playerLibrary }))).join(" "),
    /registers a playback resolve handler but plays in a WebView/,
  );
});

test("worker and popup folders carry their own config.json", () => {
  const source = loadSourceDir(makeSource({
    "workers/token/config.json": { title: "Token", url: "https://example.com/token" },
    "workers/token/01-mint.js": script("Mint Token"),
    "popup/login/config.json": { title: "Log In", url: "https://example.com/login" },
    "popup/login/01-detect.js": script("Detect Login"),
  }));
  assert.deepEqual(entryKeys(source.files, "workers"), ["token"]);
  assert.deepEqual(entryConfig(source.files, "workers", "token"), {
    title: "Token",
    url: "https://example.com/token",
  });
  assert.deepEqual(entryConfig(source.files, "popup", "login"), {
    title: "Log In",
    url: "https://example.com/login",
  });
  assert.equal(userScripts(source.files, "workers/token")[0].name, "Mint Token");
  assert.equal(userScripts(source.files, "popup/login")[0].name, "Detect Login");
});

test("an entry folder without a config.json is rejected", () => {
  const problems = problemsOf(() => loadSourceDir(makeSource({
    "workers/token/01-mint.js": script("Mint Token"),
    "popup/login/01-detect.js": script("Detect Login"),
  })));
  assert.match(problems.join("\n"), /workers\/token: config\.json is missing/);
  assert.match(problems.join("\n"), /popup\/login: config\.json is missing/);
});

test("entry configs are checked against their own schema", () => {
  const problems = problemsOf(() => loadSourceDir(makeSource({
    "workers/token/config.json": { title: "Token", url: "https://example.com", intervalSeconds: 60 },
    "popup/login/config.json": "{",
  })));
  assert.match(problems.join("\n"), /workers\/token\/config\.json: .*unknown field "intervalSeconds"/);
  assert.match(problems.join("\n"), /popup\/login\/config\.json: not valid JSON/);
});


test("unknown files, including the old data folder, are rejected", () => {
  const problems = problemsOf(() => loadSourceDir(makeSource({
    "data/search/tracks/song.js": "postResult({ items: [] });\n",
    "container/nested/x.js": "var x = {};\n",
    "notes.txt": "hi",
    "playback/nested/x.js": script("X"),
  })));
  assert.match(problems.join("\n"), /data\/search\/tracks\/song\.js: not part of the package layout/);
  assert.match(problems.join("\n"), /container\/nested\/x\.js: container\/ only holds \.js files, directly inside it/);
  assert.match(problems.join("\n"), /notes\.txt: not part of the package layout/);
  assert.match(problems.join("\n"), /playback\/nested\/x\.js: not part of the package layout/);
});

test("data handlers must belong to a declared type", () => {
  const problems = problemsOf(() => loadSourceDir(makeSource({
    "container/60-extra.js": dataLibrary("search/tracks/video", "get/profile/artist"),
  })));
  assert.match(problems.join("\n"), /"search\/tracks\/video" is not a data path for the declared types/);
  assert.match(problems.join("\n"), /"get\/profile\/artist" is not a data path for the declared types/);
});

test("a source must register at least one data handler", () => {
  assert.match(
    problemsOf(() => loadSourceDir(makeSource({ "container/50-search-tracks-song.js": undefined }))).join(" "),
    /no data handlers registered with boppa\.data\.register/,
  );
});

test("container scripts that throw while loading are reported", () => {
  assert.match(
    problemsOf(() => loadSourceDir(makeSource({ "container/40-broken.js": "throw new Error('boom');\n" }))).join(" "),
    /container\/40-broken\.js: threw while loading: boom/,
  );
});

test("declared types are accepted with their scripts", () => {
  const manifest = {
    ...baseManifest,
    trackTypes: [
      { id: "song" },
      { id: "episode", name: { one: "Episode", other: "Episodes" }, belongsTo: ["series"] },
    ],
    profileTypes: [{ id: "user", name: { one: "Person", other: "People" } }],
    tracklistTypes: [{ id: "series", name: "Show", presentation: "album" }],
  };
  assert.doesNotThrow(() => loadSourceDir(makeSource({
    "manifest.json": manifest,
    "container/50-search-tracks-song.js": undefined,
    "container/50-data.js": dataLibrary("search/tracks/episode", "get/profile/user", "list/profileTracklists/series"),
  })));
});

test("type declarations are checked for duplicates and unknown parents", () => {
  const problems = problemsOf(() => loadSourceDir(makeSource({
    "manifest.json": {
      ...baseManifest,
      trackTypes: [{ id: "song", belongsTo: ["album"] }],
      tracklistTypes: [{ id: "playlist" }, { id: "playlist" }],
    },
  })));
  assert.match(problems.join("\n"), /trackTypes: "song" belongsTo "album", which is not a declared tracklist type/);
  assert.match(problems.join("\n"), /tracklistTypes: "playlist" is declared more than once/);
});

test("manifest fields are checked against the schema", () => {
  const problems = problemsOf(() => loadSourceDir(makeSource({
    "manifest.json": { ...baseManifest, version: "", playback: {}, highlightColor: "white" },
  })));
  assert.match(problems.join("\n"), /unknown field "playback"/);
  assert.match(problems.join("\n"), /\/version/);
  assert.match(problems.join("\n"), /\/highlightColor/);
});

test("id and version must fit in the header", () => {
  const problems = problemsOf(() => loadSourceDir(makeSource({
    "manifest.json": { ...baseManifest, version: "x".repeat(250) },
  })));
  assert.match(problems.join(), /256-byte package header/);
});

test("playback config is validated against its schema", () => {
  const problems = problemsOf(() => loadSourceDir(makeSource({ "playback/config.json": { url: 42, userAgent: "Agent" } })));
  assert.match(problems.join("\n"), /playback\/config\.json: \/url: must be string/);
  assert.match(problems.join("\n"), /playback\/config\.json: \(root\): unknown field "userAgent"/);
});

test("a playback config without a url keeps index.html as the player", () => {
  const source = loadSourceDir(makeSource({ "playback/config.json": { customUserAgent: "Agent" } }));
  assert.deepEqual(readPlaybackConfig(source.files), { customUserAgent: "Agent" });
});
