import { buildIndex, type IndexEntry, INDEX_PATH, loadRepo } from "./build.ts";
import { ValidationError } from "./manifest.ts";

export interface CheckResult {
  published: boolean;
  notes: string[];
}

export async function checkVersions(root: string, baseUrl: string): Promise<CheckResult> {
  const { sources } = loadRepo(root, baseUrl);
  const local = new Map(buildIndex(sources).map((e) => [e.name, e]));

  const indexUrl = `${baseUrl}/${INDEX_PATH}`;
  let response: Response;
  try {
    response = await fetch(indexUrl, { headers: { "Cache-Control": "no-cache" } });
  } catch (error) {
    const cause = (error as Error & { cause?: Error }).cause?.message ?? (error as Error).message;
    throw new Error(`Could not reach ${indexUrl}: ${cause}`);
  }
  if (response.status === 404) return { published: false, notes: [] };
  if (!response.ok) throw new Error(`${indexUrl} returned HTTP ${response.status}`);
  const live = (await response.json()) as IndexEntry[];

  const problems: string[] = [];
  const notes: string[] = [];
  for (const published of live) {
    const current = local.get(published.name);
    if (!current) {
      problems.push(`${published.name}: is published but its folder was removed; its URL must keep working`);
    } else if (current.id !== published.id) {
      problems.push(`${published.name}: id changed from "${published.id}" to "${current.id}"`);
    } else if (current.version !== published.version) {
      notes.push(`${published.name}: ${published.version} -> ${current.version}`);
    }
  }
  const publishedNames = new Set(live.map((e) => e.name));
  for (const name of local.keys()) {
    if (!publishedNames.has(name)) notes.push(`${name}: new`);
  }

  if (problems.length > 0) throw new ValidationError("Version check", problems);
  return { published: true, notes };
}
