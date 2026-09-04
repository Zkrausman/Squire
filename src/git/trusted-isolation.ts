import { createHash } from "node:crypto";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { assertTicketRoot } from "./paths.js";

/**
 * Runtime authority for Git's filesystem side effects.
 *
 * The token class, constructor secret, WeakSet, and WeakMap are module-private.
 * The exported name is a type only: JavaScript callers cannot construct a
 * lookalike token or invoke a public mint. The sole issuer below performs the
 * live namespace/mount/root checks and binds the resulting token to that exact
 * root and descriptor-backed observation. AIDEV-223 owns sandbox provisioning
 * and composes this boundary after its OS setup; AIDEV-222 does not create
 * mounts.
 */
class TrustedFilesystemIsolationAuthorityToken {
  // A private member makes the exported type nominal at compile time. Runtime
  // authentication still comes only from the module-private WeakSet below.
  private readonly nominal!: void;

  constructor(secret: symbol) {
    if (secret !== ISSUER_SECRET) throw new TrustedFilesystemIsolationError("trusted filesystem authority constructor is private");
    // The issued object has no reachable constructor/static issuer. Runtime
    // authentication is still the module-private WeakSet, not this shape.
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }
}

/** Nominal token type; there is intentionally no runtime export or interface. */
export type TrustedFilesystemIsolationAuthority = TrustedFilesystemIsolationAuthorityToken;

export class TrustedFilesystemIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrustedFilesystemIsolationError";
  }
}

interface DescriptorIdentity {
  readonly device: string;
  readonly inode: string;
  readonly mode: string;
  readonly linkCount: string;
}

interface IsolationEvidence {
  /** Held procfs root proves the mountinfo descriptor is still procfs-backed. */
  readonly proc: FileHandle;
  /** Held nsfs descriptor is the namespace identity issued with the token. */
  readonly namespace: FileHandle;
  /** Held procfs mountinfo descriptor is the only topology read source. */
  readonly mountInfo: FileHandle;
  readonly procIdentity: DescriptorIdentity;
  readonly namespaceIdentity: DescriptorIdentity;
  readonly mountInfoIdentity: DescriptorIdentity;
}

interface IsolationObservation {
  readonly root: string;
  readonly namespace: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly mountFingerprint: string;
}

interface AuthorityState {
  readonly evidence: IsolationEvidence;
  readonly observation: IsolationObservation;
  lifecycle: "open" | "closing" | "closed";
  closePromise?: Promise<void>;
}

interface MountObservation {
  readonly mountPoint: string;
  readonly record: string;
}

const ISSUER_SECRET = Symbol("aidev-222-trusted-filesystem-issuer");
const AUTHORITIES = new WeakSet<TrustedFilesystemIsolationAuthorityToken>();
const STATES = new WeakMap<TrustedFilesystemIsolationAuthorityToken, AuthorityState>();
const MOUNT_INFO_CHUNK_BYTES = 64 * 1024;
const MAX_MOUNT_INFO_BYTES = 16 * 1024 * 1024;
const FILE_TYPE_MASK = 0o170000n;
const DIRECTORY_TYPE = 0o040000n;
const REGULAR_TYPE = 0o100000n;
const READ_ONLY_MODE = 0o222n;

/**
 * Trusted composition/issuer boundary. It has no assertion/proof parameter:
 * issuance is possible only after this module opens and validates stable
 * procfs/nsfs descriptors, reads live mount topology through the held
 * mountinfo descriptor, and checks the exact canonical root. Nested mounts
 * below the ticket root are rejected, including same-device bind mounts.
 */
export async function composeTrustedFilesystemIsolationAuthority(ticketRoot: string): Promise<TrustedFilesystemIsolationAuthority> {
  if (process.platform !== "linux") throw new TrustedFilesystemIsolationError("runtime filesystem isolation requires Linux mount-namespace evidence");
  const root = canonicalRoot(ticketRoot);
  const evidence = await openIsolationEvidence();
  try {
    const observation = await captureIsolationObservation(root, evidence);
    const authority = new TrustedFilesystemIsolationAuthorityToken(ISSUER_SECRET);
    AUTHORITIES.add(authority);
    STATES.set(authority, { evidence, observation, lifecycle: "open" });
    return authority;
  } catch (error) {
    await closeEvidence(evidence);
    throw error;
  }
}

/** Synchronous constructor gate used before a service can retain the authority. */
export function authenticateTrustedFilesystemAuthority(value: unknown, ticketRoot: string): asserts value is TrustedFilesystemIsolationAuthority {
  const root = canonicalRoot(ticketRoot);
  const state = authenticatedState(value);
  if (state.observation.root !== root) throw new TrustedFilesystemIsolationError("trusted filesystem authority is bound to a different ticket root");
}

/**
 * Explicit owner lifecycle for the descriptor-backed authority. Closing is
 * idempotent; every later operation fails closed. The Git workspace component
 * does not own this token and therefore never closes it implicitly. Trusted
 * controller composition closes it after all component work and recovery have
 * quiesced.
 */
export async function closeTrustedFilesystemIsolationAuthority(value: unknown): Promise<void> {
  const state = authenticatedState(value, true);
  if (state.lifecycle === "closed") return;
  if (state.closePromise) return state.closePromise;
  state.lifecycle = "closing";
  state.closePromise = (async () => {
    const errors: string[] = [];
    for (const handle of [state.evidence.mountInfo, state.evidence.namespace, state.evidence.proc]) {
      try { await handle.close(); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
    state.lifecycle = "closed";
    if (errors.length > 0) throw new TrustedFilesystemIsolationError(`trusted filesystem authority descriptor closure failed: ${errors.join("; ")}`);
  })();
  return state.closePromise;
}

/**
 * Operation boundary used immediately before every service side effect. The
 * original namespace/root/mount observation is rechecked from the exact
 * descriptors opened at issuance; no `/proc/<pid>/mountinfo` or namespace
 * pathname is reopened. A descriptor error, descriptor identity change,
 * namespace change, root replacement, new nested mount, malformed topology,
 * or bounded-read overflow makes the token stale and fails closed.
 */
export async function assertTrustedFilesystemOperation(value: unknown, ticketRoot: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new TrustedFilesystemIsolationError("trusted filesystem operation was aborted");
  const root = canonicalRoot(ticketRoot);
  const state = authenticatedState(value);
  if (state.observation.root !== root) throw new TrustedFilesystemIsolationError("trusted filesystem operation root is not exact");
  const current = await captureIsolationObservation(root, state.evidence);
  if (state.lifecycle !== "open") throw new TrustedFilesystemIsolationError("trusted filesystem authority is closed");
  if (current.namespace !== state.observation.namespace || current.device !== state.observation.device || current.inode !== state.observation.inode || current.mode !== state.observation.mode || current.mountFingerprint !== state.observation.mountFingerprint) {
    throw new TrustedFilesystemIsolationError("trusted filesystem authority is stale or filesystem topology changed");
  }
  if (signal?.aborted) throw new TrustedFilesystemIsolationError("trusted filesystem operation was aborted");
}

function authenticatedState(value: unknown, allowClosed = false): AuthorityState {
  if (!value || (typeof value !== "object" && typeof value !== "function") || !AUTHORITIES.has(value as TrustedFilesystemIsolationAuthorityToken)) throw new TrustedFilesystemIsolationError("runtime-authenticated trusted filesystem authority is required");
  const state = STATES.get(value as TrustedFilesystemIsolationAuthorityToken);
  if (!state) throw new TrustedFilesystemIsolationError("trusted filesystem authority state is unavailable");
  if (!allowClosed && state.lifecycle !== "open") throw new TrustedFilesystemIsolationError("trusted filesystem authority is closed");
  return state;
}

function canonicalRoot(ticketRoot: string): string {
  try { return assertTicketRoot(ticketRoot); }
  catch (error) { throw new TrustedFilesystemIsolationError(error instanceof Error ? error.message : "ticket root is not canonical"); }
}

async function openIsolationEvidence(): Promise<IsolationEvidence> {
  let proc: FileHandle | undefined;
  let namespace: FileHandle | undefined;
  let mountInfo: FileHandle | undefined;
  try {
    // These are opened once by trusted composition. The operation path never
    // reopens their replaceable `/proc` names; it only fstats/reads these held
    // kernel references.
    proc = await open("/proc", "r");
    namespace = await open("/proc/self/ns/mnt", "r");
    mountInfo = await open("/proc/self/mountinfo", "r");
    const [procIdentity, namespaceIdentity, mountInfoIdentity] = await Promise.all([
      descriptorIdentity(proc, "procfs root"),
      descriptorIdentity(namespace, "mount namespace"),
      descriptorIdentity(mountInfo, "mountinfo"),
    ]);
    assertProcEvidence(procIdentity, namespaceIdentity, mountInfoIdentity);
    return { proc, namespace, mountInfo, procIdentity, namespaceIdentity, mountInfoIdentity };
  } catch (error) {
    await closeHandles([mountInfo, namespace, proc]);
    if (error instanceof TrustedFilesystemIsolationError) throw error;
    throw new TrustedFilesystemIsolationError(`trusted filesystem evidence descriptors are unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertProcEvidence(proc: DescriptorIdentity, namespace: DescriptorIdentity, mountInfo: DescriptorIdentity): void {
  const procMode = BigInt(proc.mode);
  const namespaceMode = BigInt(namespace.mode);
  const mountInfoMode = BigInt(mountInfo.mode);
  if ((procMode & FILE_TYPE_MASK) !== DIRECTORY_TYPE || proc.inode !== "1" || (procMode & READ_ONLY_MODE) !== 0n) throw new TrustedFilesystemIsolationError("held procfs descriptor is not the canonical proc root");
  if ((namespaceMode & FILE_TYPE_MASK) !== REGULAR_TYPE || namespace.linkCount !== "1" || (namespaceMode & READ_ONLY_MODE) !== 0n || namespace.inode === "0") throw new TrustedFilesystemIsolationError("held mount namespace descriptor is not stable nsfs evidence");
  if ((mountInfoMode & FILE_TYPE_MASK) !== REGULAR_TYPE || mountInfo.linkCount !== "1" || (mountInfoMode & READ_ONLY_MODE) !== 0n || mountInfo.device !== proc.device) throw new TrustedFilesystemIsolationError("held mountinfo descriptor is not procfs evidence");
  if (namespace.device === proc.device) throw new TrustedFilesystemIsolationError("held mount namespace descriptor is not nsfs evidence");
}

async function descriptorIdentity(handle: FileHandle, label: string): Promise<DescriptorIdentity> {
  try {
    const info = await handle.stat({ bigint: true });
    return { device: info.dev.toString(), inode: info.ino.toString(), mode: info.mode.toString(), linkCount: info.nlink.toString() };
  } catch (error) {
    throw new TrustedFilesystemIsolationError(`${label} descriptor is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function verifyEvidence(evidence: IsolationEvidence): Promise<void> {
  const [proc, namespace, mountInfo] = await Promise.all([
    descriptorIdentity(evidence.proc, "procfs root"),
    descriptorIdentity(evidence.namespace, "mount namespace"),
    descriptorIdentity(evidence.mountInfo, "mountinfo"),
  ]);
  // procfs directory link counts change as processes appear/disappear; the
  // kernel object identity/type are stable. The regular nsfs/mountinfo
  // evidence descriptors retain and verify their complete fstat identity.
  if (!sameDescriptor(proc, evidence.procIdentity, false) || !sameDescriptor(namespace, evidence.namespaceIdentity) || !sameDescriptor(mountInfo, evidence.mountInfoIdentity)) throw new TrustedFilesystemIsolationError("trusted filesystem evidence descriptor identity changed");
  assertProcEvidence(proc, namespace, mountInfo);
}

function sameDescriptor(left: DescriptorIdentity, right: DescriptorIdentity, includeLinkCount = true): boolean {
  return left.device === right.device && left.inode === right.inode && left.mode === right.mode && (!includeLinkCount || left.linkCount === right.linkCount);
}

async function readMountInfo(evidence: IsolationEvidence): Promise<string> {
  await verifyEvidence(evidence);
  const chunks: Buffer[] = [];
  let position = 0;
  let total = 0;
  try {
    for (;;) {
      const buffer = Buffer.allocUnsafe(MOUNT_INFO_CHUNK_BYTES);
      const result = await evidence.mountInfo.read(buffer, 0, buffer.length, position);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      if (total > MAX_MOUNT_INFO_BYTES) throw new TrustedFilesystemIsolationError("trusted filesystem mount namespace evidence exceeds its bounded size");
      chunks.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
      position += result.bytesRead;
    }
  } catch (error) {
    if (error instanceof TrustedFilesystemIsolationError) throw error;
    throw new TrustedFilesystemIsolationError(`trusted filesystem mount namespace descriptor cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  await verifyEvidence(evidence);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)); }
  catch (error) { throw new TrustedFilesystemIsolationError(`trusted filesystem mount namespace evidence is not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`); }
}

async function captureIsolationObservation(root: string, evidence: IsolationEvidence): Promise<IsolationObservation> {
  const [rootReal, mountInfo] = await Promise.all([
    realpath(root).catch(error => { throw new TrustedFilesystemIsolationError(`trusted filesystem root evidence is unavailable: ${error instanceof Error ? error.message : String(error)}`); }),
    readMountInfo(evidence),
  ]);
  if (rootReal !== root) throw new TrustedFilesystemIsolationError("trusted filesystem root is not canonical");
  let info: Awaited<ReturnType<typeof lstat>>;
  try { info = await lstat(root); }
  catch (error) { throw new TrustedFilesystemIsolationError(`trusted filesystem root is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new TrustedFilesystemIsolationError("trusted filesystem root is not a regular canonical directory");
  const mounts = parseMountInfo(mountInfo);
  const nested = mounts.filter(mount => isWithin(root, mount.mountPoint) && mount.mountPoint !== root);
  if (nested.length > 0) throw new TrustedFilesystemIsolationError(`trusted filesystem root contains a nested mount: ${nested[0]!.mountPoint}`);
  const relevant = mounts.filter(mount => isWithin(root, mount.mountPoint)).sort((a, b) => a.record.localeCompare(b.record));
  const mountFingerprint = createHash("sha256").update(relevant.map(mount => mount.record).join("\n"), "utf8").digest("hex");
  return Object.freeze({ root, namespace: `mnt:[${evidence.namespaceIdentity.inode}]`, device: String(info.dev), inode: String(info.ino), mode: info.mode & 0o7777, mountFingerprint });
}

async function closeEvidence(evidence: IsolationEvidence): Promise<void> {
  await closeHandles([evidence.mountInfo, evidence.namespace, evidence.proc]);
}

async function closeHandles(handles: readonly (FileHandle | undefined)[]): Promise<void> {
  for (const handle of handles) await handle?.close().catch(() => undefined);
}

function parseMountInfo(value: string): MountObservation[] {
  const result: MountObservation[] = [];
  for (const line of value.split("\n").map(item => item.trimEnd()).filter(Boolean)) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (fields.length < 7 || separator < 6 || !fields[4]) throw new TrustedFilesystemIsolationError("trusted filesystem mount namespace evidence is malformed");
    const mountPoint = decodeMountInfoPath(fields[4]);
    if (!path.isAbsolute(mountPoint)) throw new TrustedFilesystemIsolationError("trusted filesystem mount point is not absolute");
    result.push({ mountPoint, record: line });
  }
  if (result.length === 0) throw new TrustedFilesystemIsolationError("trusted filesystem mount namespace evidence is empty");
  return result;
}

function decodeMountInfoPath(value: string): string {
  if (/\\(?![0-7]{3})/u.test(value)) throw new TrustedFilesystemIsolationError("trusted filesystem mount point has an invalid escape");
  return value.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}
