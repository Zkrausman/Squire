import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, link, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { windowsLaunch } from "./windows-launch.js";
import { cohortAssert as assert } from "./canonical-json.js";

/** Same private boundary as launch material; no repository/sandbox file is read. */
export async function secureDirectory(directory: string, create: boolean) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  assert(await realpath(directory) === directory);
  for (let cursor = directory; ; cursor = path.dirname(cursor)) {
    const s = await lstat(cursor);
    assert(s.isDirectory() && !s.isSymbolicLink());
    if (process.platform !== "win32") assert((s.uid === 0 || s.uid === process.getuid!()) && (!(s.mode & 0o022) || !!(s.mode & 0o1000)));
    if (cursor === directory && process.platform !== "win32") assert(s.uid === process.getuid!() && !(s.mode & 0o077));
    if (path.dirname(cursor) === cursor) break;
  }
}
export async function readPrivateBytes(file: string, maximum = 2 * 1024 * 1024): Promise<Buffer> {
  assert(Number.isSafeInteger(maximum) && maximum >= 0 && maximum <= 64 * 1024 * 1024);
  if (process.platform === "win32") {
    return windowsLaunch().readPrivateBytes(file, "", maximum);
  }
  if (process.platform !== "linux") throw new Error("unsupported private telemetry platform");
  const root = path.dirname(file);
  await secureDirectory(root, false);
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const pinned = await directory.stat();
    const anchored = `/proc/self/fd/${directory.fd}/${path.basename(file)}`;
    const h = await open(anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = await h.stat(); assert(s.isFile() && s.nlink === 1 && s.size <= maximum && s.uid === process.getuid!() && !(s.mode & 0o077));
      const bytes = Buffer.alloc(s.size + 1); let used = 0;
      while (used < bytes.length) { const result = await h.read(bytes, used, bytes.length - used, used); if (!result.bytesRead) break; used += result.bytesRead; }
      assert(used === s.size);
      const after = await h.stat(); const named = await lstat(anchored); const parent = await lstat(root);
      assert(s.ino === named.ino && s.dev === named.dev && s.size === after.size && s.mtimeMs === after.mtimeMs && s.ctimeMs === after.ctimeMs && s.mode === after.mode && !named.isSymbolicLink());
      assert(pinned.ino === parent.ino && pinned.dev === parent.dev && !parent.isSymbolicLink() && await realpath(root) === root);
      return bytes.subarray(0, used);
    } finally { await h.close(); }
  } finally { await directory.close(); }
}
async function readPublishedBytes(file: string): Promise<Buffer> {
  // A competing publisher may still own the short-lived second hard link.
  // Retry only reads; never remove or repair another publisher's evidence.
  for (let attempt = 0; ; attempt++) {
    try { return await readPrivateBytes(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || attempt === 10) throw error;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
}
export async function publishPrivateBytes(file: string, text: string) {
  const maximum = 2 * 1024 * 1024; assert(Buffer.byteLength(text) <= maximum);
  try { const previous = await readPublishedBytes(file); assert(previous.equals(Buffer.from(text))); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(process.platform === "win32" && !await lstat(file).then(() => true, e => { if (e.code !== "ENOENT") throw e; return false; }))) throw error; }
  if (process.platform === "win32") {
    try { windowsLaunch().persist(file, "", text); }
    catch { assert((await readPublishedBytes(file)).equals(Buffer.from(text))); }
    return;
  }
  if (process.platform !== "linux") throw new Error("unsupported private telemetry platform");
  const root = path.dirname(file);
  await secureDirectory(root, true);
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const pinned = await directory.stat();
    const anchored = `/proc/self/fd/${directory.fd}`;
    const target = `${anchored}/${path.basename(file)}`;
    const temporary = `${target}.${randomUUID()}.tmp`;
    const h = await open(temporary, "wx", 0o600);
    try { await h.writeFile(text); await h.sync(); } finally { await h.close(); }
    try {
      const named = await lstat(root);
      assert(pinned.ino === named.ino && pinned.dev === named.dev && !named.isSymbolicLink() && await realpath(root) === root);
      try { await link(temporary, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; assert((await readPublishedBytes(file)).equals(Buffer.from(text))); }
    } finally { await unlink(temporary); }
    await directory.sync();
  } finally { await directory.close(); }
}
