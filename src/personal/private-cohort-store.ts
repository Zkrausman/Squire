import { constants } from "node:fs";
import { open, lstat, realpath, mkdir, link, unlink, statfs, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { windowsLaunch } from "./windows-launch.js";
import { canonicalJson } from "./canonical-json.js";
import { check, digestBytes, filePath, reference, type ArtifactReference } from "./cohort-manifest.js";

const MAX_SOURCE = 64 * 1024 * 1024;
function within(root: string, file: string): boolean { const relative = path.relative(root, file); return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
async function boundaries(root: string, file: string, repository: string): Promise<void> {
  filePath(root); filePath(file); filePath(repository);
  check(path.isAbsolute(root) && path.resolve(root) === root && path.isAbsolute(file) && path.resolve(file) === file && within(root, file) && root !== file);
  const repo = await realpath(repository);
  check(!within(repo, root) && !within(repo, file));
  // Native/descriptor-relative traversal below rejects aliases and reparses.
}
async function directoryLease(directory: string, create: boolean) {
  check(process.platform === "linux" && path.resolve(directory) === directory);
  const held: { handle: FileHandle; name: string; dev: number; ino: number }[] = [];
  const close = async () => { for (const row of held.reverse()) await row.handle.close(); };
  const verify = async () => {
    for (const row of held) {
      const s = await row.handle.stat(), named = await lstat(row.name);
      check(s.isDirectory() && !named.isSymbolicLink() && named.dev === row.dev && named.ino === row.ino && s.dev === row.dev && s.ino === row.ino);
      check((s.uid === 0 || s.uid === process.getuid!()) && (!(s.mode & 0o022) || !!(s.mode & 0o1000)));
      if (row === held.at(-1)) check(s.uid === process.getuid!() && !(s.mode & 0o077));
    }
    check(await realpath(directory) === directory);
  };
  try {
    let name = "/";
    for (const component of ["", ...directory.split("/").filter(Boolean)]) {
      if (component) name = path.join(name, component);
      const anchored = held.length ? `/proc/self/fd/${held.at(-1)!.handle.fd}/${component}` : "/";
      if (create && component) await mkdir(anchored, { mode: 0o700 }).catch(e => { if (e.code !== "EEXIST") throw e; });
      const handle = await open(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const s = await handle.stat(); held.push({ handle, name, dev: s.dev, ino: s.ino });
      check((s.uid === 0 || s.uid === process.getuid!()) && (!(s.mode & 0o022) || !!(s.mode & 0o1000)));
    }
    await verify();
    // Remote/FUSE filesystems do not provide this boundary's local ownership
    // and immutable descriptor semantics. Fail closed, including unknown types.
    const filesystem = await statfs(`/proc/self/fd/${held.at(-1)!.handle.fd}`);
    check([0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630, 0x2fc12fc1].includes(filesystem.type));
    return { anchor: `/proc/self/fd/${held.at(-1)!.handle.fd}`, handle: held.at(-1)!.handle, verify, close };
  } catch (e) { await close(); throw e; }
}
/** Explicit immutable file only. No discovery, source repair or source writes. */
export async function readPrivateArtifact(file: string, root: string, repository: string, maxBytes = MAX_SOURCE): Promise<Buffer> {
  check(Number.isSafeInteger(maxBytes) && maxBytes >= 0 && maxBytes <= MAX_SOURCE);
  await boundaries(root, file, repository);
  if (process.platform === "win32") {
    const native = windowsLaunch(), held = native.openHistorical(file);
    try { const bytes = native.readReport(held.lease); check(bytes.length <= maxBytes); return bytes; }
    finally { native.closeReport(held.lease); }
  }
  const directory = await directoryLease(path.dirname(file), false);
  try {
    const anchored = `${directory.anchor}/${path.basename(file)}`;
    const h = await open(anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = await h.stat();
      check(s.isFile() && s.nlink === 1 && s.uid === process.getuid!() && !(s.mode & 0o077) && s.size <= maxBytes);
      const bytes = Buffer.alloc(s.size + 1); let used = 0;
      while (used < bytes.length) { const read = await h.read(bytes, used, bytes.length - used, used); if (!read.bytesRead) break; used += read.bytesRead; }
      const after = await h.stat(), named = await lstat(anchored);
      check(used === s.size && s.size === after.size && s.mtimeMs === after.mtimeMs && s.ctimeMs === after.ctimeMs && s.mode === after.mode && s.nlink === after.nlink && s.uid === after.uid && s.dev === named.dev && s.ino === named.ino && !named.isSymbolicLink());
      await directory.verify(); return bytes.subarray(0, used);
    } finally { await h.close(); }
  } finally { await directory.close(); }
}
export async function readBoundArtifact(ref: ArtifactReference, repository: string, maxBytes = MAX_SOURCE): Promise<Buffer> {
  ref = reference(ref); check(ref.bytes <= maxBytes);
  const bytes = await readPrivateArtifact(ref.file, ref.root, repository, maxBytes);
  check(bytes.length === ref.bytes && digestBytes(bytes) === ref.digest); return bytes;
}
export interface CohortPublication { schemaVersion: 1; manifestDigest: string; artifactDigest: string; }
export async function publishCohort(dataRoot: string, repository: string, manifestDigest: string, value: unknown): Promise<CohortPublication> {
  check(/^[a-f0-9]{64}$/u.test(manifestDigest));
  const text = canonicalJson(value), bytes = Buffer.from(text); check(bytes.length <= 8_000_000);
  const root = path.join(dataRoot, "cohort-artifacts"), file = path.join(root, `${digestBytes(bytes)}.json`);
  await boundaries(dataRoot, file, repository);
  const same = async () => { check((await readPrivateArtifact(file, root, repository, 8_000_000)).equals(bytes)); };
  const exists = await lstat(file).then(() => true, e => { if (e.code === "ENOENT") return false; throw e; });
  if (exists) await same();
  else if (process.platform === "win32") {
    try { windowsLaunch().persist(file, repository, text); } catch { await same(); }
    await same();
  } else {
    const directory = await directoryLease(root, true);
    const temporary = `${directory.anchor}/${randomUUID()}.tmp`, target = `${directory.anchor}/${path.basename(file)}`;
    let created = false;
    try {
      const h = await open(temporary, "wx", 0o600);
      created = true;
      try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
      await directory.verify();
      try { await link(temporary, target); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; await same(); }
      finally { await unlink(temporary); created = false; }
      await directory.handle.sync(); await directory.verify();
    } finally { try { if (created) await unlink(temporary); } finally { await directory.close(); } }
    await same();
  }
  return { schemaVersion: 1, manifestDigest, artifactDigest: digestBytes(bytes) };
}
