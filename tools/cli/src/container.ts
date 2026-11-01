import vm from "node:vm";
import { CONTAINER_DIR } from "./manifest.ts";

export interface LoadedContainer {
  dataHandlers: string[];
  playbackHandlers: string[];
  problems: string[];
}

const LOAD_TIMEOUT_MS = 2000;

export function containerScripts(files: Map<string, Buffer>): string[] {
  return [...files.keys()]
    .filter((path) => path.startsWith(`${CONTAINER_DIR}/`) && path.endsWith(".js") && path.split("/").length === 2)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

export function loadContainer(files: Map<string, Buffer>): LoadedContainer {
  const dataHandlers = new Set<string>();
  const playbackHandlers = new Set<string>();
  const problems: string[] = [];

  const registerInto = (target: Set<string>, api: string) => (value: unknown) => {
    if (!value || typeof value !== "object") throw new Error(`${api} expects an object`);
    for (const [name, handler] of Object.entries(value)) {
      if (typeof handler !== "function") throw new Error(`${api}: '${name}' is not a function`);
      target.add(name);
    }
  };

  const stub = (): unknown =>
    new Proxy(function () {}, {
      get: (_target, key) => (key === "then" ? undefined : stub()),
      apply: () => stub(),
    });

  const api: Record<string, unknown> = {
    playback: { register: registerInto(playbackHandlers, "boppa.playback.register") },
    data: { register: registerInto(dataHandlers, "boppa.data.register") },
  };
  const boppa = new Proxy(api, { get: (target, key) => (typeof key === "string" && key in target ? target[key] : stub()) });
  const quiet = () => {};
  const sandbox: Record<string, unknown> = {
    boppa,
    console: { log: quiet, info: quiet, debug: quiet, warn: quiet, error: quiet },
    fetch: () => new Promise(() => {}),
    setTimeout: () => 0,
    clearTimeout: quiet,
    setInterval: () => 0,
    clearInterval: quiet,
    URL,
    URLSearchParams,
    AbortController,
    AbortSignal,
    atob,
    btoa,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  for (const path of containerScripts(files)) {
    try {
      vm.runInContext(files.get(path)!.toString("utf8"), sandbox, { filename: path, timeout: LOAD_TIMEOUT_MS });
    } catch (error) {
      problems.push(`${path}: threw while loading: ${(error as Error).message}`);
    }
  }
  return { dataHandlers: [...dataHandlers].sort(), playbackHandlers: [...playbackHandlers].sort(), problems };
}
