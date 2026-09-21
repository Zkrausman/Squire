import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, link, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { windowsLaunch } from "./windows-launch.js";
export const ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
export const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
function check(v: unknown): asserts v { if (!v) throw new Error("unsafe private cohort artifact"); }
export function outsideRepository(file: string, repository: string): void {
  const relative = path.relative(path.resolve(repository), path.resolve(file));
  check(relative !== "" && (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)));
}
async function directory(root: string): Promise<void> {
  check(await realpath(root) === root);
  for (let cursor = root; ; cursor = path.dirname(cursor)) {
    const s = await lstat(cursor); check(s.isDirectory() && !s.isSymbolicLink());
    check((s.uid === 0 || s.uid === process.getuid!()) && (!(s.mode & 0o022) || !!(s.mode & 0o1000)));
    if (cursor === root) check(s.uid === process.getuid!() && !(s.mode & 0o077));
    if (cursor === path.dirname(cursor)) break;
  }
}
/** Explicit files only, immutable identity checked before/after reading. */
export async function readPrivateArtifact(file: string, repository: string, maxBytes = ARTIFACT_MAX_BYTES): Promise<Buffer> {
  check(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= ARTIFACT_MAX_BYTES);
  file = path.resolve(file); outsideRepository(file, repository);
  if (process.platform === "win32") {
    const native = windowsLaunch(), handle = native.openArtifact(file);
    try { const bytes = native.readReport(handle.lease); check(bytes.length <= maxBytes); return bytes; }
    finally { native.closeReport(handle.lease); }
  }
  check(process.platform === "linux");
  const root = path.dirname(file); await directory(root);
  const parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const pinned = await parent.stat(), anchored = `/proc/self/fd/${parent.fd}/${path.basename(file)}`;
    const h = await open(anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = await h.stat(); check(s.isFile() && s.nlink === 1 && s.size <= maxBytes && s.uid === process.getuid!() && !(s.mode & 0o077));
      const bytes = Buffer.alloc(s.size + 1); let used = 0;
      while (used < bytes.length) { const r = await h.read(bytes, used, bytes.length - used, used); if (!r.bytesRead) break; used += r.bytesRead; }
      const after = await h.stat(), named = await lstat(anchored), p = await lstat(root);
      check(used === s.size && s.ino === named.ino && s.dev === named.dev && !named.isSymbolicLink() && after.nlink === 1 && s.size === after.size && s.mtimeMs === after.mtimeMs && s.ctimeMs === after.ctimeMs && s.mode === after.mode);
      check(pinned.ino === p.ino && pinned.dev === p.dev && !p.isSymbolicLink()); await directory(root);
      return bytes.subarray(0, used);
    } finally { await h.close(); }
  } finally { await parent.close(); }
}
/** One canonical document contains both scorecard and provenance; publication is
 * exclusive and atomic. Existing equal bytes are returned, never rewritten. */
export async function publishCohort(dataDirectory: string, repository: string, id: string, bytes: Buffer): Promise<string> {
  check(/^[a-f0-9]{64}$/u.test(id) && bytes.length <= 2 * 1024 * 1024);
  const file = path.resolve(dataDirectory, "cohort-artifacts", `${id}.json`); outsideRepository(file, repository);
  const equal = async () => check((await readPrivateArtifact(file, repository)).equals(bytes));
  try { await equal(); return file; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(process.platform === "win32" && !await lstat(file).then(() => true, e => { if (e.code !== "ENOENT") throw e; return false; }))) throw error;
  }
  if (process.platform === "win32") {
    // Native no-reparse handle-relative rename refuses replacing existing bytes.
    try { windowsLaunch().persist(file, repository, new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { await equal(); }
    await equal(); return file;
  }
  check(process.platform === "linux");
  const root = path.dirname(file); await mkdir(root, { recursive: true, mode: 0o700 }); await directory(root);
  const parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const pinned = await parent.stat(), anchor = `/proc/self/fd/${parent.fd}`, target = `${anchor}/${path.basename(file)}`, temporary = `${target}.${randomUUID()}.tmp`;
    const h = await open(temporary, "wx", 0o600);
    try {
      try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
      const p = await lstat(root); check(pinned.ino === p.ino && pinned.dev === p.dev && !p.isSymbolicLink()); await directory(root);
      try { await link(temporary, target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; await equal(); }
    } finally { await unlink(temporary); }
    await parent.sync();
  } finally { await parent.close(); }
  await equal(); return file;
}
