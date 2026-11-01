const SAFE_PATH = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export function isSafePath(path: string): boolean {
  return SAFE_PATH.test(path) && !path.split("/").some((part) => part === "." || part === "..");
}
