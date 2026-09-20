import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
export async function readOnlyTree(directory: string): Promise<unknown> {
  const entries = [];
  for (const name of (await readdir(directory)).sort()) {
    const file = path.join(directory, name), stat = await lstat(file, { bigint: true });
    entries.push([name, `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`, stat.isDirectory() ? await readOnlyTree(file) : (await readFile(file)).toString("base64")]);
  }
  return entries;
}

