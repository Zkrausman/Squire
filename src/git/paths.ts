import { constants, type Dirent, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { GitWorkspacePaths, ResourceIdentity } from "./domain.js";
import { assertRunId } from "./identity.js";

export class GitPathSecurityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitPathSecurityError";
  }
}

export interface GitWorkspaceFilesystemPaths {
  readonly ticketRoot: string;
  readonly gitRoot: string;
  readonly repository: string;
  readonly worktree: string;
  readonly artifactsRoot: string;
  readonly artifactRoot: string;
  readonly specPath: string;
  readonly manifestPath: string;
  readonly bundleRoot: string;
  readonly controlRoot: string;
  readonly operationPath: string;
  readonly hooksPath: string;
  readonly templatePath: string;
  readonly disposalRoot: string;
}

const LOGICAL_TICKET_ROOT = "/ticket";
const PRIVATE_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export function logicalGitWorkspacePaths(runId: string): GitWorkspacePaths {
  assertRunId(runId);
  return {
    repository: "/ticket/git/repo.git",
    worktree: "/ticket/workspace",
    artifactRoot: `artifacts/git/${runId}`,
    controlRoot: `control/git/${runId}`,
  };
}

export function createGitWorkspaceFilesystemPaths(runId: string, ticketRoot = LOGICAL_TICKET_ROOT): GitWorkspaceFilesystemPaths {
  assertRunId(runId);
  const root = assertTicketRoot(ticketRoot);
  const logical = logicalGitWorkspacePaths(runId);
  const toPhysical = (value: string): string => value.startsWith(`${LOGICAL_TICKET_ROOT}/`) || value === LOGICAL_TICKET_ROOT
    ? path.join(root, value.slice(LOGICAL_TICKET_ROOT.length + (value === LOGICAL_TICKET_ROOT ? 0 : 1)))
    : path.join(root, value);
  const artifactRoot = toPhysical(logical.artifactRoot);
  const controlRoot = toPhysical(logical.controlRoot);
  return {
    ticketRoot: root,
    gitRoot: path.join(root, "git"),
    repository: toPhysical(logical.repository),
    worktree: toPhysical(logical.worktree),
    artifactsRoot: path.join(root, "artifacts"),
    artifactRoot,
    specPath: path.join(artifactRoot, "workspace-spec.json"),
    manifestPath: path.join(artifactRoot, "workspace-manifest.json"),
    bundleRoot: artifactRoot,
    controlRoot,
    operationPath: path.join(controlRoot, "operation.json"),
    hooksPath: path.join(controlRoot, "hooks"),
    templatePath: path.join(controlRoot, "template"),
    disposalRoot: path.join(root, "control", "git-workspace-disposal"),
  };
}

export function assertTicketRoot(ticketRoot: string): string {
  if (typeof ticketRoot !== "string" || !path.isAbsolute(ticketRoot) || path.resolve(ticketRoot) !== ticketRoot || path.parse(ticketRoot).root === ticketRoot) throw new GitPathSecurityError("ticket root must be a non-root absolute canonical path");
  if (ticketRoot.includes("\0")) throw new GitPathSecurityError("ticket root contains NUL");
  return ticketRoot;
}

export function assertPathWithin(root: string, target: string): string {
  const canonicalRoot = path.resolve(assertTicketRoot(root));
  if (typeof target !== "string" || target.includes("\0")) throw new GitPathSecurityError("path contains NUL or is not a string");
  const canonicalTarget = path.resolve(target);
  if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`)) throw new GitPathSecurityError("path escapes ticket root");
  return canonicalTarget;
}

/** Walks existing ancestors with lstat. Missing leaf components are allowed for
 * create-only publication, but no existing symlink or non-directory ancestor is. */
export async function assertSafeAncestors(target: string, root: string, allowMissingLeaf = true): Promise<void> {
  if (process.platform === "win32") throw new GitPathSecurityError("secure no-follow path operations are unsupported on win32");
  const absolute = assertPathWithin(root, target);
  const rootPath = assertTicketRoot(root);
  const relative = path.relative(rootPath, absolute);
  const parts = relative ? relative.split(path.sep) : [];
  let current = rootPath;
  let rootDevice: string | undefined;
  for (let index = -1; index < parts.length; index += 1) {
    if (index >= 0) current = path.join(current, parts[index]!);
    let info: Stats;
    try { info = await lstat(current); }
    catch (error) {
      if (isMissing(error) && index >= 0 && allowMissingLeaf) return;
      throw new GitPathSecurityError(`path ancestor is unavailable: ${current}`);
    }
    if (index === -1) rootDevice = String(info.dev);
    else if (String(info.dev) !== rootDevice) throw new GitPathSecurityError(`filesystem crossing is not trusted: ${current}`);
    if (info.isSymbolicLink()) throw new GitPathSecurityError(`symbolic-link path component is not trusted: ${current}`);
    if (!info.isDirectory()) {
      if (index === parts.length - 1 && allowMissingLeaf) throw new GitPathSecurityError(`path leaf is not a directory: ${current}`);
      throw new GitPathSecurityError(`path component is not a directory: ${current}`);
    }
  }
}

export async function ensurePrivateDirectory(directory: string, root: string, mode = PRIVATE_MODE): Promise<ResourceIdentity> {
  const target = assertPathWithin(root, directory);
  await assertSafeAncestors(path.dirname(target), root, true);
  try { await mkdir(target, { recursive: false, mode }); }
  catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  const identity = await inspectResource(target, "directory", true, root);
  if ((identity.mode & 0o777) !== mode) throw new GitPathSecurityError(`directory does not have required private mode ${mode.toString(8)}: ${target}`);
  return identity;
}

export async function inspectResource(
  target: string,
  expectedKind?: "file" | "directory",
  requireSingleLink = true,
  containmentRoot?: string,
): Promise<ResourceIdentity> {
  const absolute = containmentRoot ? assertPathWithin(containmentRoot, target) : path.resolve(target);
  if (containmentRoot) await assertSafeAncestors(expectedKind === "directory" ? absolute : path.dirname(absolute), containmentRoot, false);
  const before = await lstat(absolute).catch(error => { throw new GitPathSecurityError(`required path is missing: ${absolute}`, { cause: error } as ErrorOptions); });
  const kind = entryKind(before);
  if (kind === "symlink") throw new GitPathSecurityError(`symbolic link is not a trusted resource: ${absolute}`);
  if (expectedKind && kind !== expectedKind) throw new GitPathSecurityError(`expected ${expectedKind}: ${absolute}`);
  if (kind !== "file" && kind !== "directory") throw new GitPathSecurityError(`unsupported resource type: ${absolute}`);
  if (requireSingleLink && kind === "file" && before.nlink !== 1) throw new GitPathSecurityError(`hardlinked resource is not trusted: ${absolute}`);
  if (containmentRoot) {
    const canonicalRoot = await realpath(assertTicketRoot(containmentRoot));
    const rootInfo = await lstat(canonicalRoot);
    if (String(rootInfo.dev) !== String(before.dev)) throw new GitPathSecurityError(`resource crosses the ticket filesystem: ${absolute}`);
    const canonicalTarget = await realpath(absolute);
    if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`)) throw new GitPathSecurityError(`resource escapes ticket root: ${absolute}`);
  }
  const after = await lstat(absolute);
  if (!sameStat(before, after)) throw new GitPathSecurityError(`resource changed during identity inspection: ${absolute}`);
  return resourceIdentity(absolute, kind, after);
}

export async function openNoFollow(target: string, flags = constants.O_RDONLY): Promise<FileHandle> {
  if (constants.O_NOFOLLOW === undefined) throw new GitPathSecurityError("secure no-follow file operations are unsupported on this platform");
  try { return await open(target, flags | constants.O_NOFOLLOW); }
  catch (error) { throw new GitPathSecurityError(`cannot open trusted no-follow path: ${target}`, { cause: error } as ErrorOptions); }
}

export async function writeExclusiveFile(target: string, bytes: Uint8Array, root: string, mode = PRIVATE_FILE_MODE): Promise<ResourceIdentity> {
  const absolute = assertPathWithin(root, target);
  await assertSafeAncestors(path.dirname(absolute), root, false);
  const handle = await openNoFollow(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(mode);
  } finally { await handle.close(); }
  await fsyncDirectory(path.dirname(absolute));
  return inspectResource(absolute, "file", true, root);
}

export async function readExactNoFollow(target: string, root: string, maxBytes = 16 * 1024 * 1024): Promise<Buffer> {
  const identity = await inspectResource(target, "file", true, root);
  if (identity.linkCount !== 1) throw new GitPathSecurityError("hardlinked artifact is not trusted");
  const handle = await openNoFollow(target);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) throw new GitPathSecurityError("file is not a bounded regular file");
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < before.size) {
      const read = await handle.read(bytes, offset, before.size - offset, offset);
      if (read.bytesRead <= 0) throw new GitPathSecurityError("file ended during bounded read");
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (!sameStat(before, after)) throw new GitPathSecurityError("file changed during read");
    return bytes;
  } finally { await handle.close(); }
}

export async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await openNoFollow(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function renameWithIdentity(source: string, destination: string, root: string, expected: ResourceIdentity): Promise<void> {
  const sourceIdentity = await inspectResource(source, expected.kind, true, root);
  if (!sameResourceIdentity(sourceIdentity, expected)) throw new GitPathSecurityError(`resource identity changed before rename: ${source}`);
  await assertSafeAncestors(path.dirname(destination), root, false);
  try { await lstat(destination); throw new GitPathSecurityError(`disposal destination already exists: ${destination}`); }
  catch (error) { if (!(error instanceof GitPathSecurityError) && !isMissing(error)) throw error; if (error instanceof GitPathSecurityError) throw error; }
  await rename(source, destination);
  const moved = await inspectResource(destination, expected.kind, true, root);
  if (!sameResourceIdentity({ ...moved, path: expected.path }, expected)) throw new GitPathSecurityError(`resource identity changed after rename: ${destination}`);
}

/** Removes only the supplied tree and never follows a symlink entry. */
export async function removeTreeNoFollow(target: string, expected?: ResourceIdentity, root?: string): Promise<void> {
  const absolute = root ? assertPathWithin(root, target) : path.resolve(target);
  if (root) await assertSafeAncestors(path.dirname(absolute), root, false);
  const info = await lstat(absolute).catch(error => { if (isMissing(error)) return undefined; throw error; });
  if (!info) return;
  const kind = entryKind(info);
  if (kind !== "file" && kind !== "directory" && !info.isSymbolicLink()) throw new GitPathSecurityError(`unsupported resource type during removal: ${absolute}`);
  if (expected && (kind !== "file" && kind !== "directory" || !sameResourceIdentity(resourceIdentity(absolute, kind, info), expected))) throw new GitPathSecurityError(`resource identity changed before removal: ${absolute}`);
  if (info.isSymbolicLink()) { await unlink(absolute); return; }
  if (!info.isDirectory()) { await unlink(absolute); return; }
  const rootDevice = String(info.dev);
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(absolute, entry.name);
    const childInfo = await lstat(child);
    if (String(childInfo.dev) !== rootDevice) throw new GitPathSecurityError(`filesystem crossing during removal: ${child}`);
    if (childInfo.isSymbolicLink()) await unlink(child);
    else if (childInfo.isDirectory()) await removeTreeNoFollow(child, undefined, root);
    else {
      if (childInfo.nlink !== 1) throw new GitPathSecurityError(`hardlinked resource encountered during removal: ${child}`);
      await unlink(child);
    }
  }
  const final = await lstat(absolute);
  // The directory link count legitimately changes as child directories are
  // removed by this same no-follow walk. Device, inode, type, and mode still
  // prove that the original directory was not replaced.
  if (String(info.dev) !== String(final.dev) || String(info.ino) !== String(final.ino) || info.mode !== final.mode || !final.isDirectory()) throw new GitPathSecurityError(`directory identity changed during removal: ${absolute}`);
  await unlinkOrRmdir(absolute);
}

export function sameResourceIdentity(a: ResourceIdentity, b: ResourceIdentity): boolean {
  return a.path === b.path && a.kind === b.kind && a.device === b.device && a.inode === b.inode && a.mode === b.mode && a.linkCount === b.linkCount;
}

export function resourceIdentity(target: string, kind: "file" | "directory", info: Stats): ResourceIdentity {
  return { path: path.resolve(target), kind, device: String(info.dev), inode: String(info.ino), mode: info.mode & 0o777, linkCount: info.nlink };
}

export function sameStat(a: Stats, b: Stats): boolean {
  return String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino) && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

export function entryKind(info: Stats | Dirent): "file" | "directory" | "symlink" | "other" {
  if (info.isSymbolicLink()) return "symlink";
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  return "other";
}

export function isMissing(error: unknown): boolean { return isCode(error, "ENOENT"); }
export function isAlreadyExists(error: unknown): boolean { return isCode(error, "EEXIST"); }

async function unlinkOrRmdir(target: string): Promise<void> {
  try { await unlink(target); }
  catch (error) {
    if (!isCode(error, "EISDIR") && !isCode(error, "EPERM")) throw error;
    // `rmdir` is deliberately only reached after a no-follow recursive walk.
    const directory = await openNoFollow(target, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
    try { await directory.close(); } finally { /* close is explicit for auditability */ }
    await rmdir(target);
  }
}

function assertTicketRootForExport(root: string): string { return assertTicketRoot(root); }

function isCode(error: unknown, code: string): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code); }

// Keep the helper referenced so tree-shaking cannot accidentally turn the root
// policy into a lexical-only check in a future build.
void assertTicketRootForExport;
