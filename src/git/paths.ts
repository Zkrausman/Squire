import { constants, type Dirent, type Stats } from "node:fs";
import { spawn as spawnChild } from "node:child_process";
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink, type FileHandle } from "node:fs/promises";
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
  readonly hooksPath: string;
  readonly templatePath: string;
  readonly disposalRoot: string;
}

const LOGICAL_TICKET_ROOT = "/ticket";
const PRIVATE_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/**
 * Linux descriptor defense-in-depth boundary. Node does not expose openat(2)
 * or renameat2(2) directly, so sensitive paths are opened relative to held
 * O_DIRECTORY|O_NOFOLLOW descriptors and the fixed GNU coreutils
 * `mv --no-clobber --no-copy -T` helper supplies the narrow no-replace move.
 * These Node checks cannot prove absence of same-device bind mounts or make a
 * later Git pathname immune to replacement; production side effects are
 * consequently gated by the runtime-authenticated authority composed at the
 * AIDEV-223 isolation boundary.
 * Unsupported platforms fail closed instead of treating pathname lstat as a
 * proof. The helper is invoked with argv only and a fresh environment.
 */
function assertDescriptorFilesystem(): void {
  if (process.platform !== "linux" || constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) throw new GitPathSecurityError("secure descriptor filesystem operations are unsupported on this platform");
}

function assertComponent(name: string): void {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) throw new GitPathSecurityError("path component is not trusted");
}

function anchoredPath(directory: FileHandle, name: string): string {
  assertDescriptorFilesystem();
  assertComponent(name);
  if (!Number.isSafeInteger(directory.fd) || directory.fd < 0) throw new GitPathSecurityError("directory descriptor is not stable");
  return `/proc/self/fd/${directory.fd}/${name}`;
}

async function openAtNoFollow(directory: FileHandle, name: string, flags: number, mode?: number): Promise<FileHandle> {
  const target = anchoredPath(directory, name);
  try { return await open(target, flags | constants.O_NOFOLLOW!, mode); }
  catch (error) { throw new GitPathSecurityError(`cannot open trusted descriptor-relative path: ${name}`, { cause: error } as ErrorOptions); }
}

/** Returns a proc descriptor path for a direct child of a held directory.
 * It is suitable for lstat/readdir diagnostics only; mutation callers should
 * use openNoFollowAt and keep the parent descriptor alive. */
export function descriptorChildPath(directory: FileHandle, name: string): string {
  return anchoredPath(directory, name);
}

/** Opens a direct child through an already-held directory descriptor. Callers
 * must keep the parent handle alive for the whole side effect. */
export async function openNoFollowAt(directory: FileHandle, name: string, flags = constants.O_RDONLY, mode?: number): Promise<FileHandle> {
  return openAtNoFollow(directory, name, flags, mode);
}

async function openDirectoryChain(root: string, target: string): Promise<FileHandle> {
  assertDescriptorFilesystem();
  const rootPath = assertTicketRoot(root);
  const absolute = assertPathWithin(rootPath, target);
  const relative = path.relative(rootPath, absolute);
  const parts = relative ? relative.split(path.sep) : [];
  let current: FileHandle;
  try { current = await open(rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW!); }
  catch (error) { throw new GitPathSecurityError(`cannot open trusted ticket root: ${rootPath}`, { cause: error } as ErrorOptions); }
  let rootInfo: Stats;
  try { rootInfo = await current.stat(); }
  catch (error) {
    await current.close().catch(() => undefined);
    throw new GitPathSecurityError(`cannot inspect trusted ticket root: ${rootPath}`, { cause: error } as ErrorOptions);
  }
  if (!rootInfo.isDirectory()) { await current.close(); throw new GitPathSecurityError("ticket root is not a directory"); }
  const device = String(rootInfo.dev);
  try {
    for (const part of parts) {
      assertComponent(part);
      const next = await openAtNoFollow(current, part, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        const info = await next.stat();
        if (!info.isDirectory() || String(info.dev) !== device) throw new GitPathSecurityError(`trusted path crosses a filesystem boundary: ${absolute}`);
        await current.close();
        current = next;
      } catch (error) {
        await next.close().catch(() => undefined);
        throw error;
      }
    }
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

/** Opens a file/directory relative to descriptor-bound ancestors and compares
 * the opened object with the canonical leaf. The returned descriptor remains
 * the authority for reads and chmod; the pathname is not reopened by callers. */
export async function openNoFollowWithin(target: string, root: string, flags = constants.O_RDONLY, mode?: number): Promise<FileHandle> {
  const rootPath = assertTicketRoot(root);
  const absolute = assertPathWithin(rootPath, target);
  if (absolute === rootPath) {
    assertDescriptorFilesystem();
    let handle: FileHandle | undefined;
    try {
      handle = await open(rootPath, flags | constants.O_NOFOLLOW!, mode);
      const handleInfo = await handle.stat();
      const pathInfo = await lstat(absolute);
      if (handleInfo.dev !== pathInfo.dev || handleInfo.ino !== pathInfo.ino || handleInfo.mode !== pathInfo.mode || handleInfo.nlink !== pathInfo.nlink) throw new GitPathSecurityError(`trusted path was replaced during descriptor open: ${absolute}`);
      return handle;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw error;
    }
  }
  const parent = await openDirectoryChain(rootPath, path.dirname(absolute));
  let child: FileHandle | undefined;
  try {
    child = await openAtNoFollow(parent, path.basename(absolute), flags, mode);
    const childInfo = await child.stat();
    const pathInfo = await lstat(absolute).catch(error => { throw new GitPathSecurityError(`trusted path disappeared during descriptor open: ${absolute}`, { cause: error } as ErrorOptions); });
    if (childInfo.dev !== pathInfo.dev || childInfo.ino !== pathInfo.ino || childInfo.mode !== pathInfo.mode || childInfo.nlink !== pathInfo.nlink) throw new GitPathSecurityError(`trusted path was replaced during descriptor open: ${absolute}`);
    await parent.close();
    return child;
  } catch (error) {
    await child?.close().catch(() => undefined);
    await parent.close().catch(() => undefined);
    throw error;
  }
}

/** fchmod on the opened directory, never chmod(pathname). */
export async function chmodDirectoryNoFollow(directory: string, root: string, mode = PRIVATE_MODE): Promise<ResourceIdentity> {
  const handle = await openNoFollowWithin(directory, root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const before = await handle.stat();
    if (!before.isDirectory() || String(before.dev) !== String((await lstat(assertTicketRoot(root))).dev)) throw new GitPathSecurityError(`directory is not a trusted same-filesystem directory: ${directory}`);
    await handle.chmod(mode);
    await handle.sync();
    const after = await handle.stat();
    if (!after.isDirectory() || String(after.dev) !== String(before.dev) || String(after.ino) !== String(before.ino) || after.nlink !== before.nlink || (after.mode & 0o777) !== mode) throw new GitPathSecurityError(`directory changed during descriptor chmod: ${directory}`);
  } finally { await handle.close(); }
  return inspectResource(directory, "directory", true, root);
}

export async function chmodFileNoFollow(file: string, root: string, mode = PRIVATE_FILE_MODE): Promise<ResourceIdentity> {
  const handle = await openNoFollowWithin(file, root, constants.O_RDONLY);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) throw new GitPathSecurityError(`file is not a trusted regular file: ${file}`);
    await handle.chmod(mode);
    await handle.sync();
    const after = await handle.stat();
    if (!after.isFile() || String(after.dev) !== String(before.dev) || String(after.ino) !== String(before.ino) || after.nlink !== before.nlink || (after.mode & 0o777) !== mode) throw new GitPathSecurityError(`file changed during descriptor chmod: ${file}`);
  } finally { await handle.close(); }
  return inspectResource(file, "file", true, root);
}

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
    hooksPath: path.join(controlRoot, "hooks"),
    templatePath: path.join(controlRoot, "template"),
    disposalRoot: path.join(root, "control", "git-workspace-disposal"),
  };
}

export function assertTicketRoot(ticketRoot: string): string {
  if (typeof ticketRoot !== "string" || !path.isAbsolute(ticketRoot) || path.resolve(ticketRoot) !== ticketRoot || path.parse(ticketRoot).root === ticketRoot || ticketRoot.includes("\\") || ticketRoot.includes("//")) throw new GitPathSecurityError("ticket root must be a non-root absolute canonical path");
  if (/[\u0000-\u001f\u007f\r\n]/u.test(ticketRoot)) throw new GitPathSecurityError("ticket root contains control data");
  return ticketRoot;
}

export function assertPathWithin(root: string, target: string): string {
  const canonicalRoot = path.resolve(assertTicketRoot(root));
  if (typeof target !== "string" || target.includes("\0") || target.includes("\\") || /[\u0000-\u001f\u007f\r\n]/u.test(target) || !path.isAbsolute(target) || path.normalize(target) !== target || target.includes("//") || target !== path.parse(target).root && target.endsWith(path.sep) || target.split(path.sep).some(part => part === "." || part === "..")) throw new GitPathSecurityError("path is not canonical or contains unsafe traversal");
  const canonicalTarget = path.resolve(target);
  if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`)) throw new GitPathSecurityError("path escapes ticket root");
  return canonicalTarget;
}

/** Walks existing ancestors with lstat. Missing leaf components are allowed for
 * create-only publication, but no existing symlink or non-directory ancestor is.
 * The st_dev comparison is defense in depth only; it does not prove that a
 * same-device bind mount is absent. Production Git side effects therefore
 * require the runtime-authenticated authority composed at the AIDEV-223
 * boundary. */
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
      if (isMissing(error) && index === parts.length - 1 && allowMissingLeaf) return;
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
  const parent = await openDirectoryChain(root, path.dirname(target));
  try {
    try { await mkdir(anchoredPath(parent, path.basename(target)), { recursive: false, mode }); }
    catch (error) { if (!isAlreadyExists(error)) throw error; }
  } finally { await parent.close(); }
  return chmodDirectoryNoFollow(target, root, mode);
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
    // Re-open relative to held ancestor descriptors. This is the actual
    // no-follow/containment proof; lstat above is only the type diagnostic.
    const flags = kind === "directory" ? constants.O_RDONLY | constants.O_DIRECTORY! : constants.O_RDONLY;
    const descriptor = await openNoFollowWithin(absolute, containmentRoot, flags);
    try {
      const descriptorInfo = await descriptor.stat();
      if (!sameStat(before, descriptorInfo)) throw new GitPathSecurityError(`resource changed during descriptor identity inspection: ${absolute}`);
      const after = await lstat(absolute);
      if (!sameStat(descriptorInfo, after)) throw new GitPathSecurityError(`resource changed during identity inspection: ${absolute}`);
      return resourceIdentity(absolute, kind, descriptorInfo);
    } finally { await descriptor.close(); }
  }
  const after = await lstat(absolute);
  if (!sameStat(before, after)) throw new GitPathSecurityError(`resource changed during identity inspection: ${absolute}`);
  return resourceIdentity(absolute, kind, after);
}

export async function openNoFollow(target: string, flags = constants.O_RDONLY, root?: string, mode?: number): Promise<FileHandle> {
  if (root) return openNoFollowWithin(target, root, flags, mode);
  if (constants.O_NOFOLLOW === undefined) throw new GitPathSecurityError("secure no-follow file operations are unsupported on this platform");
  try { return await open(target, flags | constants.O_NOFOLLOW, mode); }
  catch (error) { throw new GitPathSecurityError(`cannot open trusted no-follow path: ${target}`, { cause: error } as ErrorOptions); }
}

export async function writeExclusiveFile(target: string, bytes: Uint8Array, root: string, mode = PRIVATE_FILE_MODE): Promise<ResourceIdentity> {
  const absolute = assertPathWithin(root, target);
  await assertSafeAncestors(path.dirname(absolute), root, false);
  const parent = await openDirectoryChain(root, path.dirname(absolute));
  let handle: FileHandle | undefined;
  try {
    handle = await openAtNoFollow(parent, path.basename(absolute), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle?.close();
    try { await parent.sync(); } finally { await parent.close(); }
  }
  return inspectResource(absolute, "file", true, root);
}

export async function readExactNoFollow(target: string, root: string, maxBytes = 16 * 1024 * 1024): Promise<Buffer> {
  const identity = await inspectResource(target, "file", true, root);
  if (identity.linkCount !== 1) throw new GitPathSecurityError("hardlinked artifact is not trusted");
  const handle = await openNoFollow(target, constants.O_RDONLY, root);
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

export async function fsyncDirectory(directory: string, root?: string): Promise<void> {
  const handle = root
    ? await openNoFollow(directory, constants.O_RDONLY | constants.O_DIRECTORY!, root)
    : await openNoFollow(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
}

async function runNoReplaceMove(source: string, destination: string, sourceFd: number, destinationFd: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnChild("/usr/bin/mv", ["--no-clobber", "--no-copy", "--no-target-directory", "--", source, destination], { shell: false, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" }, stdio: ["ignore", "ignore", "pipe", sourceFd, destinationFd] });
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr += chunk.toString("utf8").slice(0, 4_096); });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`no-replace move failed (${code ?? "unknown"}): ${stderr}`)));
  });
}

export async function renameWithIdentity(source: string, destination: string, root: string, expected: ResourceIdentity): Promise<void> {
  const sourceIdentity = await inspectResource(source, expected.kind, true, root);
  if (!sameResourceIdentity(sourceIdentity, expected)) throw new GitPathSecurityError(`resource identity changed before rename: ${source}`);
  const sourceParent = await openDirectoryChain(root, path.dirname(assertPathWithin(root, source)));
  const destinationParent = await openDirectoryChain(root, path.dirname(assertPathWithin(root, destination)));
  try {
    const sourceParentInfo = await sourceParent.stat();
    const destinationParentInfo = await destinationParent.stat();
    if (String(sourceParentInfo.dev) !== String(destinationParentInfo.dev)) throw new GitPathSecurityError("disposal rename crosses a filesystem boundary");
    // execFile closes arbitrary descriptors unless they are explicitly passed
    // through. Bind the two held parents as child fd 3/4, so the helper never
    // resolves a parent pathname in its own namespace.
    const sourceName = path.basename(source);
    const destinationName = path.basename(destination);
    const sourceBoundPath = anchoredPath(sourceParent, sourceName);
    const sourceBoundInfo = await lstat(sourceBoundPath);
    if (entryKind(sourceBoundInfo) !== expected.kind || !sameResourceIdentity(resourceIdentity(source, expected.kind, sourceBoundInfo), expected)) throw new GitPathSecurityError(`resource identity changed during parent binding: ${source}`);
    const sourcePath = `/proc/self/fd/3/${sourceName}`;
    const destinationPath = `/proc/self/fd/4/${destinationName}`;
    const destinationBoundPath = anchoredPath(destinationParent, destinationName);
    try { await lstat(destinationBoundPath); throw new GitPathSecurityError(`disposal destination already exists: ${destination}`); }
    catch (error) { if (!(error instanceof GitPathSecurityError) && !isMissing(error)) throw error; if (error instanceof GitPathSecurityError) throw error; }
    // Node has no renameat2(RENAME_NOREPLACE). GNU mv is used only as the
    // fixed, argv-only Linux helper; --no-copy prevents a cross-device copy
    // from turning a move into an unjournaled recursive operation.
    assertDescriptorFilesystem();
    try {
      await runNoReplaceMove(sourcePath, destinationPath, sourceParent.fd, destinationParent.fd);
      await sourceParent.sync();
      if (destinationParent.fd !== sourceParent.fd) await destinationParent.sync();
    } catch (error) {
      if (isMissing(error)) throw new GitPathSecurityError(`resource disappeared before rename: ${source}`, { cause: error } as ErrorOptions);
      throw new GitPathSecurityError(`secure no-replace disposal rename failed: ${source}`, { cause: error } as ErrorOptions);
    }
    const sourceAfter = await lstat(source).catch(error => { if (isMissing(error)) return undefined; throw error; });
    const destinationAfter = await lstat(destination).catch(error => { if (isMissing(error)) return undefined; throw error; });
    if (sourceAfter || !destinationAfter) {
      if (destinationAfter) throw new GitPathSecurityError(`disposal destination already exists: ${destination}`);
      throw new GitPathSecurityError(`resource disappeared before rename: ${source}`);
    }
  } finally {
    await sourceParent.close();
    await destinationParent.close();
  }
  const moved = await inspectResource(destination, expected.kind, true, root);
  if (!sameResourceIdentity({ ...moved, path: expected.path }, expected)) throw new GitPathSecurityError(`resource identity changed after rename: ${destination}`);
}

/** Removes only the supplied tree and never follows a symlink entry. The
 * walk carries held directory descriptors and exact child identities; a
 * pathname-only recursive rm is deliberately not used. */
export async function removeEmptyDirectoryNoFollow(target: string, root: string, expected?: ResourceIdentity): Promise<boolean> {
  assertDescriptorFilesystem();
  const absolute = assertPathWithin(root, target);
  await assertSafeAncestors(path.dirname(absolute), root, false);
  const parent = await openDirectoryChain(root, path.dirname(absolute));
  try {
    const name = path.basename(absolute);
    assertComponent(name);
    const targetPath = anchoredPath(parent, name);
    const info = await lstat(targetPath).catch(error => { if (isMissing(error)) return undefined; throw error; });
    if (!info) return false;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new GitPathSecurityError(`trusted empty-directory target is unsafe: ${absolute}`);
    if (String(info.dev) !== String((await parent.stat()).dev)) throw new GitPathSecurityError(`trusted empty-directory target crosses a filesystem boundary: ${absolute}`);
    if (expected && !sameResourceIdentity(resourceIdentity(absolute, "directory", info), expected)) throw new GitPathSecurityError(`trusted empty-directory identity changed: ${absolute}`);
    const directory = await openAtNoFollow(parent, name, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const opened = await directory.stat();
      if (!sameStatExceptSizeAndTime(opened, info)) throw new GitPathSecurityError(`trusted empty-directory identity changed during open: ${absolute}`);
      if ((await readdir(`/proc/self/fd/${directory.fd}`)).length !== 0) return false;
      const final = await directory.stat();
      if (!sameStatExceptSizeAndTime(final, opened)) throw new GitPathSecurityError(`trusted empty-directory identity changed before removal: ${absolute}`);
      const targetBeforeRemove = await lstat(targetPath).catch(error => { if (isMissing(error)) return undefined; throw error; });
      if (!targetBeforeRemove || !sameStatExceptSizeAndTime(targetBeforeRemove, opened)) throw new GitPathSecurityError(`trusted empty-directory identity changed before final removal: ${absolute}`);
      try { await rmdir(targetPath); return true; }
      catch (error) { if (isMissing(error) || isCode(error, "ENOTEMPTY")) return false; throw error; }
    } finally { await directory.close(); }
  } finally { await parent.close(); }
}

export interface RemovalOptions {
  readonly signal?: AbortSignal;
  readonly maxEntries?: number;
  readonly maxDepth?: number;
}

export async function removeTreeNoFollow(
  target: string,
  expected?: ResourceIdentity,
  root?: string,
  expectedChildren?: readonly RemovalChildIdentity[],
  options: RemovalOptions = {},
): Promise<void> {
  assertDescriptorFilesystem();
  if (!root || !options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => !["maxDepth", "maxEntries", "signal"].includes(key)) || options.maxEntries !== undefined && (!Number.isSafeInteger(options.maxEntries) || options.maxEntries <= 0 || options.maxEntries > 1_000_000) || options.maxDepth !== undefined && (!Number.isSafeInteger(options.maxDepth) || options.maxDepth <= 0 || options.maxDepth > 128) || options.signal?.aborted) throw new GitPathSecurityError("safe tree removal requires a live containment root and bounded options");
  const absolute = assertPathWithin(root, target);
  await assertSafeAncestors(path.dirname(absolute), root, false);
  const parent = root
    ? await openDirectoryChain(root, path.dirname(absolute))
    : await open(path.dirname(absolute), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW!);
  try {
    const parentInfo = await parent.stat();
    const name = path.basename(absolute);
    assertComponent(name);
    const childPath = anchoredPath(parent, name);
    const info = await lstat(childPath).catch(error => { if (isMissing(error)) return undefined; throw error; });
    if (!info) return;
    const kind = entryKind(info);
    if (kind !== "file" && kind !== "directory" && !info.isSymbolicLink()) throw new GitPathSecurityError(`unsupported resource type during removal: ${absolute}`);
    if (String(info.dev) !== String(parentInfo.dev)) throw new GitPathSecurityError(`filesystem crossing during removal: ${absolute}`);
    if (expected && (kind !== "file" && kind !== "directory" || !sameResourceIdentity(resourceIdentity(absolute, kind, info), expected))) throw new GitPathSecurityError(`resource identity changed before removal: ${absolute}`);
    if (options.signal?.aborted) throw new GitPathSecurityError("tree removal was aborted");
    if (info.isSymbolicLink()) {
      await removeEntryAt(parent, name, { dev: info.dev, ino: info.ino, mode: info.mode, nlink: info.nlink, kind: "symlink" });
      return;
    }
    if (info.isFile()) {
      if (info.nlink !== 1) throw new GitPathSecurityError(`hardlinked resource encountered during removal: ${absolute}`);
      await removeEntryAt(parent, name, { dev: info.dev, ino: info.ino, mode: info.mode, nlink: info.nlink, kind: "file" });
      return;
    }
    const directory = await openAtNoFollow(parent, name, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const opened = await directory.stat();
      if (!opened.isDirectory() || !sameStatExceptSizeAndTime(opened, info)) throw new GitPathSecurityError(`directory identity changed before removal: ${absolute}`);
      const budget = { remaining: options.maxEntries ?? 100_000, maxDepth: options.maxDepth ?? 64, ...(options.signal ? { signal: options.signal } : {}) };
      await removeDirectoryHandle(directory, parent, name, absolute, String(parentInfo.dev), expectedChildren, budget, 0);
    } finally { await directory.close(); }
  } finally { await parent.close(); }
}

/** Recurses through a directory descriptor. The parent descriptor and child
 * name are retained until the final unlink/rmdir, so a replacement ancestor is
 * never reopened by its original absolute pathname. */
async function removeDirectoryHandle(
  directory: FileHandle,
  parent: FileHandle,
  name: string,
  absolute: string,
  device: string,
  expectedChildren: readonly RemovalChildIdentity[] | undefined,
  budget: { remaining: number; readonly signal?: AbortSignal; readonly maxDepth: number },
  depth: number,
): Promise<void> {
  if (budget.signal?.aborted) throw new GitPathSecurityError("tree removal was aborted");
  if (depth > budget.maxDepth) throw new GitPathSecurityError("tree removal exceeded its depth bound");
  const opened = await directory.stat();
  const expectedMap = new Map((expectedChildren ?? []).map(child => [child.name, child]));
  const entries = await readdir(`/proc/self/fd/${directory.fd}`, { withFileTypes: true });
  if (expectedChildren && (entries.length !== expectedChildren.length || entries.some(entry => !expectedMap.has(entry.name)))) throw new GitPathSecurityError(`directory contents changed before removal: ${absolute}`);
  for (const entry of entries) {
    if (budget.signal?.aborted) throw new GitPathSecurityError("tree removal was aborted");
    if (--budget.remaining < 0) throw new GitPathSecurityError("tree removal exceeded its entry bound");
    assertComponent(entry.name);
    const childPath = anchoredPath(directory, entry.name);
    const childInfo = await lstat(childPath);
    if (String(childInfo.dev) !== device) throw new GitPathSecurityError(`filesystem crossing during removal: ${childPath}`);
    const expectedChild = expectedMap.get(entry.name);
    if (expectedChild && !sameRemovalIdentity(childInfo, expectedChild)) throw new GitPathSecurityError(`child identity changed during removal: ${childPath}`);
    if (childInfo.isSymbolicLink()) {
      await removeEntryAt(directory, entry.name, { dev: childInfo.dev, ino: childInfo.ino, mode: childInfo.mode, nlink: childInfo.nlink, kind: "symlink" });
    } else if (childInfo.isDirectory()) {
      const childDirectory = await openAtNoFollow(directory, entry.name, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        const childOpened = await childDirectory.stat();
        if (!childOpened.isDirectory() || !sameStatExceptSizeAndTime(childOpened, childInfo)) throw new GitPathSecurityError(`directory identity changed during removal: ${childPath}`);
        await removeDirectoryHandle(childDirectory, directory, entry.name, path.join(absolute, entry.name), device, undefined, budget, depth + 1);
      } finally { await childDirectory.close(); }
    } else if (childInfo.isFile()) {
      if (childInfo.nlink !== 1) throw new GitPathSecurityError(`hardlinked resource encountered during removal: ${childPath}`);
      await removeEntryAt(directory, entry.name, { dev: childInfo.dev, ino: childInfo.ino, mode: childInfo.mode, nlink: childInfo.nlink, kind: "file" });
    } else throw new GitPathSecurityError(`unsupported resource type during removal: ${childPath}`);
  }
  const remaining = await readdir(`/proc/self/fd/${directory.fd}`, { withFileTypes: true });
  if (remaining.length !== 0) throw new GitPathSecurityError(`directory contents changed during removal: ${absolute}`);
  const final = await directory.stat();
  if (!final.isDirectory() || String(opened.dev) !== String(final.dev) || String(opened.ino) !== String(final.ino) || opened.mode !== final.mode) throw new GitPathSecurityError(`directory identity changed during removal: ${absolute}`);
  await removeEntryAt(parent, name, { dev: opened.dev, ino: opened.ino, mode: opened.mode, nlink: opened.nlink, kind: "directory" });
}

async function removeEntryAt(parent: FileHandle, name: string, expected: { readonly dev: number; readonly ino: number; readonly mode: number; readonly nlink?: number; readonly kind: "file" | "directory" | "symlink" }): Promise<void> {
  const target = anchoredPath(parent, name);
  const current = await lstat(target);
  if (current.dev !== expected.dev || current.ino !== expected.ino || current.mode !== expected.mode || (expected.kind !== "directory" && current.nlink !== expected.nlink) || entryKind(current) !== expected.kind) throw new GitPathSecurityError(`resource identity changed before final removal: ${target}`);
  if (expected.kind === "directory") await rmdir(target);
  else await unlink(target);
}

function sameStatExceptSizeAndTime(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink;
}

export interface RemovalChildIdentity {
  readonly name: string;
  readonly kind: "file" | "directory";
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly linkCount: number;
}

function sameRemovalIdentity(info: Stats, expected: RemovalChildIdentity): boolean {
  return entryKind(info) === expected.kind && String(info.dev) === expected.device && String(info.ino) === expected.inode && (info.mode & 0o777) === expected.mode && info.nlink === expected.linkCount;
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

function assertTicketRootForExport(root: string): string { return assertTicketRoot(root); }

function isCode(error: unknown, code: string, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 3) return false;
  if ("code" in error && (error as { code?: unknown }).code === code) return true;
  if ("cause" in error) return isCode((error as { cause?: unknown }).cause, code, depth + 1);
  return false;
}

// Keep the helper referenced so tree-shaking cannot accidentally turn the root
// policy into a lexical-only check in a future build.
void assertTicketRootForExport;
