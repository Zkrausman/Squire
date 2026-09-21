import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Node canonicalizes ESM file URLs; argv retains the caller's spelling.
 * Comparing their URL strings can silently skip main on Windows (drive/path
 * case) or when invoked through a symlink. Imports still must not execute main. */
export function sameEntryPath(modulePath: string, invokedPath: string, platform: NodeJS.Platform = process.platform): boolean {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const normalize = (value: string) => platform === "win32" ? paths.normalize(value).toLowerCase() : paths.normalize(value);
  return normalize(modulePath) === normalize(invokedPath);
}
export function isDirectEntry(moduleUrl: string, invokedPath: string | undefined): boolean {
  if (!invokedPath) return false;
  try { return sameEntryPath(realpathSync(fileURLToPath(moduleUrl)), realpathSync(invokedPath)); }
  catch { return false; }
}
