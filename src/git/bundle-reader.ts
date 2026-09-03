import { constants, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { GitPathSecurityError, assertPathWithin, assertSafeAncestors, fsyncDirectory, openNoFollow, removeTreeNoFollow, resourceIdentity, sameStat } from "./paths.js";
import type { ResourceIdentity } from "./domain.js";
import type { GitCommandOptions, GitCommandResult, GitCommandRunner } from "./git-command.js";

export interface DescriptorDigest {
  readonly byteLength: number;
  readonly sha256: string;
  readonly before: FileStatIdentity;
  readonly after: FileStatIdentity;
}

export interface FileStatIdentity {
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly linkCount: number;
  readonly size: number;
  readonly mtime: string;
  readonly ctime: string;
}

export interface OpenedImmutableFile {
  readonly path: string;
  readonly handle: FileHandle;
  readonly identity: FileStatIdentity;
}

export const DEFAULT_MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;
export const DESCRIPTOR_ARGUMENT = "__SQUIRE_DESCRIPTOR_FD__";

/** Opens a regular single-link file and retains the descriptor for every later
 * digest/content operation. The pathname is never reopened by the verifier. */
export async function openImmutableFile(filePath: string, maxBytes = DEFAULT_MAX_BUNDLE_BYTES, root?: string): Promise<OpenedImmutableFile> {
  const absolute = root ? assertPathWithin(root, filePath) : path.resolve(filePath);
  if (root) await assertSafeAncestors(path.dirname(absolute), root, false);
  const handle = root ? await openNoFollow(absolute, constants.O_RDONLY, root) : await openNoFollow(absolute);
  try {
    const info = await handle.stat();
    assertRegularSingleLink(info, maxBytes);
    return { path: absolute, handle, identity: statIdentity(info) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function digestDescriptor(handle: FileHandle, maxBytes = DEFAULT_MAX_BUNDLE_BYTES, signal?: AbortSignal): Promise<DescriptorDigest> {
  const before = await handle.stat();
  assertRegularSingleLink(before, maxBytes);
  const hash = createHash("sha256");
  const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, before.size)));
  let offset = 0;
  while (offset < before.size) {
    if (signal?.aborted) throw new GitPathSecurityError("descriptor digest was aborted");
    const length = Math.min(chunk.length, before.size - offset);
    const read = await handle.read(chunk, 0, length, offset);
    if (read.bytesRead !== length) throw new GitPathSecurityError("bundle descriptor ended before its stable size");
    hash.update(chunk.subarray(0, read.bytesRead));
    offset += read.bytesRead;
  }
  const after = await handle.stat();
  if (!sameStat(before, after)) throw new GitPathSecurityError("bundle changed during descriptor digest");
  return { byteLength: before.size, sha256: hash.digest("hex"), before: statIdentity(before), after: statIdentity(after) };
}

export async function copyDescriptorToExclusive(
  source: FileHandle,
  destination: string,
  root: string,
  expected: DescriptorDigest,
  signal?: AbortSignal,
): Promise<void> {
  const before = await source.stat();
  if (!sameFileStatIdentity(before, expected.before)) throw new GitPathSecurityError("bundle descriptor identity changed before copy");
  const parent = path.dirname(assertPathWithin(root, destination));
  await assertSafeAncestors(parent, root, false);
  const target = assertPathWithin(root, destination);
  if (constants.O_NOFOLLOW === undefined) throw new GitPathSecurityError("secure no-follow bundle publication is unsupported on this platform");
  const output = await openNoFollow(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, root, 0o600).catch(error => { throw new GitPathSecurityError(`bundle destination is not an exclusive file: ${target}`, { cause: error }); });
  let outputResource: ResourceIdentity | undefined;
  try {
    const opened = await output.stat();
    if (!opened.isFile() || opened.nlink !== 1) throw new GitPathSecurityError("bundle destination is not a private regular file");
    outputResource = resourceIdentity(target, "file", opened);
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < expected.byteLength) {
      if (signal?.aborted) throw new GitPathSecurityError("bundle copy was aborted");
      const length = Math.min(chunk.length, expected.byteLength - offset);
      const read = await source.read(chunk, 0, length, offset);
      if (read.bytesRead !== length) throw new GitPathSecurityError("bundle descriptor changed during copy");
      await output.write(chunk, 0, read.bytesRead);
      offset += read.bytesRead;
    }
    // Published evidence is immutable at the pathname level as well as by
    // digest. The descriptor remains open while permissions are changed.
    await output.chmod(0o400);
    outputResource = resourceIdentity(target, "file", await output.stat());
    await output.sync();
  } catch (error) {
    await output.close();
    if (outputResource) await removeTreeNoFollow(target, outputResource, root).catch(() => undefined);
    throw error;
  }
  await output.close();
  await fsyncDirectory(parent, root);
  const copied = await openImmutableFile(target, expected.byteLength, root);
  try {
    const digest = await digestDescriptor(copied.handle, expected.byteLength, signal);
    if (digest.byteLength !== expected.byteLength || digest.sha256 !== expected.sha256) throw new GitPathSecurityError("published bundle digest mismatch");
    const sourceAfter = await source.stat();
    if (!sameFileStatIdentity(sourceAfter, expected.before)) throw new GitPathSecurityError("bundle descriptor changed after copy");
  } finally { await copied.handle.close(); }
}

/** Linux is the production descriptor-to-Git handoff. Reopening a pathname on
 * other platforms would reintroduce a substitution race, so it fails closed. */
export function descriptorPathForGit(handle: FileHandle, childFd = handle.fd): string {
  if (process.platform !== "linux") throw new GitPathSecurityError("descriptor-backed Git bundle verification is unsupported on this platform");
  if (!Number.isInteger(handle.fd) || handle.fd < 0 || !Number.isInteger(childFd) || childFd < 3) throw new GitPathSecurityError("bundle descriptor has no stable file descriptor");
  return `/proc/self/fd/${childFd}`;
}

export async function runGitWithDescriptor(
  runner: GitCommandRunner,
  args: readonly string[],
  handle: FileHandle,
  options: GitCommandOptions,
): Promise<GitCommandResult> {
  // DefaultGitProcessFactory appends passed descriptors after stdin/stdout/
  // stderr, so the first descriptor is fd 3 in the Git child even when the
  // parent descriptor has another number.
  const descriptor = descriptorPathForGit(handle, 3);
  const boundArgs = args.map(argument => argument === DESCRIPTOR_ARGUMENT ? descriptor : argument);
  if (!boundArgs.some(argument => argument === descriptor)) throw new GitPathSecurityError("Git descriptor command did not bind the held bundle descriptor");
  return runner.run(boundArgs, { ...options, passFileDescriptors: [handle.fd], cwd: options.cwd, runId: options.runId });
}

export async function verifyDescriptorDigest(handle: FileHandle, expectedSha256: string, expectedLength: number, maxBytes = DEFAULT_MAX_BUNDLE_BYTES): Promise<DescriptorDigest> {
  const result = await digestDescriptor(handle, maxBytes);
  if (result.sha256 !== expectedSha256 || result.byteLength !== expectedLength) throw new GitPathSecurityError("bundle descriptor digest or length did not match the expected identity");
  return result;
}

function assertRegularSingleLink(info: Stats, maxBytes: number): void {
  if (!info.isFile()) throw new GitPathSecurityError("bundle is not a regular file");
  if (info.nlink !== 1) throw new GitPathSecurityError("hardlinked bundle is not trusted");
  if (!Number.isSafeInteger(info.size) || info.size <= 0 || info.size > maxBytes) throw new GitPathSecurityError("bundle size is outside the bounded range");
}

function statIdentity(info: Stats): FileStatIdentity {
  return { device: String(info.dev), inode: String(info.ino), mode: info.mode, linkCount: info.nlink, size: info.size, mtime: String(info.mtimeMs), ctime: String(info.ctimeMs) };
}

function sameFileStatIdentity(info: Stats, expected: FileStatIdentity): boolean {
  const actual = statIdentity(info);
  return actual.device === expected.device && actual.inode === expected.inode && actual.mode === expected.mode && actual.linkCount === expected.linkCount && actual.size === expected.size && actual.mtime === expected.mtime && actual.ctime === expected.ctime;
}
