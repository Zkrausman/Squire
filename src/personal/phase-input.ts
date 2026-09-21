import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { persistWindowsPhaseInput } from "./windows-launch.js";

/** Exclusive, private generation input. Never repair an existing directory or
 * overwrite/unlink a colliding file, even after a failed launch. */
export async function persistPhaseInput(file: string, bytes: string): Promise<void> {
  file = path.resolve(file);
  if (process.platform === "win32") { persistWindowsPhaseInput(file, bytes); return; }
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory) throw new Error("unsafe phase input ancestor");
  for (let cursor = directory; ; cursor = path.dirname(cursor)) {
    const s = await lstat(cursor);
    if (!s.isDirectory() || s.isSymbolicLink() || (s.uid !== 0 && s.uid !== process.getuid!()) || ((s.mode & 0o022) && !(s.mode & 0o1000)) || (cursor === directory && (s.uid !== process.getuid!() || (s.mode & 0o077)))) throw new Error("unsafe private phase input directory");
    if (path.dirname(cursor) === cursor) break;
  }
  // Pin the verified parent; publication is relative to it, not a re-resolved
  // attacker-swappable pathname. Linux is the only non-Windows runtime.
  const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const pinned = await parent.stat();
    const named = await lstat(directory);
    if (pinned.ino !== named.ino || pinned.dev !== named.dev) throw new Error("phase input parent changed");
    const handle = await open(`/proc/self/fd/${parent.fd}/${path.basename(file)}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await parent.sync();
  } finally { await parent.close(); }
}
