import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { assertTicketRoot } from "./paths.js";
import { parseMountInfo as parseGuestMountInfo } from "../sandbox/isolation-probes.js";

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
  /** Held ticket root prevents a pathname replacement from being treated as the protected root. */
  readonly ticketRoot: FileHandle;
  readonly procIdentity: DescriptorIdentity;
  readonly namespaceIdentity: DescriptorIdentity;
  readonly mountInfoIdentity: DescriptorIdentity;
  readonly ticketRootIdentity: DescriptorIdentity;
}

export interface TrustedFilesystemObservation {
  readonly root: string;
  readonly namespace: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly mountFingerprint: string;
}
interface IsolationObservation extends TrustedFilesystemObservation {}

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
 * below the ticket root are rejected, including same-device bind mounts,
 * except for the one measured Docker Sandboxes passthrough at exactly
 * `/ticket/bridge`. That mount is intentionally untrusted and is included in
 * the immutable topology fingerprint; every descendant of it and every other
 * nested mount remains forbidden.
 */
export async function composeTrustedFilesystemIsolationAuthority(ticketRoot: string): Promise<TrustedFilesystemIsolationAuthority> {
  if (process.platform !== "linux") throw new TrustedFilesystemIsolationError("runtime filesystem isolation requires Linux mount-namespace evidence");
  const root = canonicalRoot(ticketRoot);
  const evidence = await openIsolationEvidence(root);
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

/** Returns immutable live evidence from an already authenticated authority.
 * Callers may compare it with a measured guest proof, but cannot construct or
 * mint the authority from this observation. */
export function trustedFilesystemObservation(value: unknown, ticketRoot: string): TrustedFilesystemObservation {
  const root = canonicalRoot(ticketRoot);
  const state = authenticatedState(value);
  if (state.observation.root !== root) throw new TrustedFilesystemIsolationError("trusted filesystem authority is bound to a different ticket root");
  return Object.freeze({ ...state.observation });
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
      for (const handle of [state.evidence.ticketRoot, state.evidence.mountInfo, state.evidence.namespace, state.evidence.proc]) {
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

async function openIsolationEvidence(root: string): Promise<IsolationEvidence> {
  let proc: FileHandle | undefined;
  let namespace: FileHandle | undefined;
  let mountInfo: FileHandle | undefined;
  let ticketRoot: FileHandle | undefined;
  try {
    if (constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) throw new TrustedFilesystemIsolationError("descriptor no-follow filesystem evidence is unsupported");
    // These are opened once by trusted composition. The operation path never
    // reopens their replaceable `/proc` or ticket-root names; it only fstats
    // and reads these held kernel references.
    proc = await open("/proc", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    // `/proc/self/ns/mnt` is a kernel magic link: Linux deliberately returns
    // ELOOP for O_NOFOLLOW on it. It is the one fixed procfs identity path
    // opened with O_RDONLY; the resulting nsfs descriptor is fstat-checked and
    // held for the authority lifetime, while all replaceable filesystem paths
    // remain O_NOFOLLOW.
    namespace = await open("/proc/self/ns/mnt", constants.O_RDONLY);
    mountInfo = await open("/proc/self/mountinfo", constants.O_RDONLY | constants.O_NOFOLLOW);
    ticketRoot = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const [procIdentity, namespaceIdentity, mountInfoIdentity, ticketRootIdentity] = await Promise.all([
      descriptorIdentity(proc, "procfs root"),
      descriptorIdentity(namespace, "mount namespace"),
      descriptorIdentity(mountInfo, "mountinfo"),
      descriptorIdentity(ticketRoot, "ticket root"),
    ]);
    assertProcEvidence(procIdentity, namespaceIdentity, mountInfoIdentity);
    assertTicketRootEvidence(ticketRootIdentity);
    return { proc, namespace, mountInfo, ticketRoot, procIdentity, namespaceIdentity, mountInfoIdentity, ticketRootIdentity };
  } catch (error) {
    await closeHandles([ticketRoot, mountInfo, namespace, proc]);
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

function assertTicketRootEvidence(identity: DescriptorIdentity): void {
  const mode = BigInt(identity.mode);
  if ((mode & FILE_TYPE_MASK) !== DIRECTORY_TYPE || identity.inode === "0" || BigInt(identity.linkCount) < 2n || (mode & 0o077n) !== 0n || (mode & 0o700n) !== 0o700n) throw new TrustedFilesystemIsolationError("held ticket root descriptor is not a stable private directory");
}

async function verifyEvidence(evidence: IsolationEvidence): Promise<void> {
  const [proc, namespace, mountInfo, ticketRoot] = await Promise.all([
    descriptorIdentity(evidence.proc, "procfs root"),
    descriptorIdentity(evidence.namespace, "mount namespace"),
    descriptorIdentity(evidence.mountInfo, "mountinfo"),
    descriptorIdentity(evidence.ticketRoot, "ticket root"),
  ]);
  // procfs directory link counts can change as processes appear/disappear;
  // the kernel object identity/type are stable. The regular nsfs/mountinfo
  // and ticket-root descriptors retain and verify their complete fstat
  // identity, including link count.
  if (!sameDescriptor(proc, evidence.procIdentity, false) || !sameDescriptor(namespace, evidence.namespaceIdentity) || !sameDescriptor(mountInfo, evidence.mountInfoIdentity) || !sameDescriptor(ticketRoot, evidence.ticketRootIdentity, false)) throw new TrustedFilesystemIsolationError("trusted filesystem evidence descriptor identity changed");
  assertProcEvidence(proc, namespace, mountInfo);
  assertTicketRootEvidence(ticketRoot);
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
  const [rootReal, mountInfo, heldRoot] = await Promise.all([
    realpath(root).catch(error => { throw new TrustedFilesystemIsolationError(`trusted filesystem root evidence is unavailable: ${error instanceof Error ? error.message : String(error)}`); }),
    readMountInfo(evidence),
    descriptorIdentity(evidence.ticketRoot, "ticket root"),
  ]);
  if (rootReal !== root) throw new TrustedFilesystemIsolationError("trusted filesystem root is not canonical");
  assertTicketRootEvidence(heldRoot);
  let info: Awaited<ReturnType<typeof lstat>>;
  try { info = await lstat(root); }
  catch (error) { throw new TrustedFilesystemIsolationError(`trusted filesystem root is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  const pathRoot: DescriptorIdentity = { device: String(info.dev), inode: String(info.ino), mode: String(info.mode), linkCount: String(info.nlink) };
  if (!info.isDirectory() || info.isSymbolicLink() || !sameDescriptor(heldRoot, pathRoot, false)) throw new TrustedFilesystemIsolationError("trusted filesystem root was replaced during observation");
  const mounts = parseMountInfo(mountInfo);
  assertTicketMountSources(root, mounts);
  const nested = mounts.filter(mount => isWithin(root, mount.mountPoint) && mount.mountPoint !== root && !isExactUntrustedBridgeMount(root, mount.mountPoint));
  if (nested.length > 0) throw new TrustedFilesystemIsolationError(`trusted filesystem root contains a nested mount: ${nested[0]!.mountPoint}`);
  if (root === "/ticket" && !mounts.some(mount => isExactUntrustedBridgeMount(root, mount.mountPoint))) throw new TrustedFilesystemIsolationError("trusted filesystem root is missing the exact untrusted /ticket/bridge mount");
  const relevant = mounts.filter(mount => isWithin(root, mount.mountPoint)).sort((a, b) => a.record.localeCompare(b.record));
  const mountFingerprint = createHash("sha256").update(relevant.map(mount => mount.record).join("\n"), "utf8").digest("hex");
  return Object.freeze({ root, namespace: `mnt:[${evidence.namespaceIdentity.inode}]`, device: String(info.dev), inode: String(info.ino), mode: info.mode & 0o7777, mountFingerprint });
}

async function closeEvidence(evidence: IsolationEvidence): Promise<void> {
  await closeHandles([evidence.ticketRoot, evidence.mountInfo, evidence.namespace, evidence.proc]);
}

async function closeHandles(handles: readonly (FileHandle | undefined)[]): Promise<void> {
  for (const handle of handles) await handle?.close().catch(() => undefined);
}

function parseMountInfo(value: string): MountObservation[] {
  try { return parseGuestMountInfo(value).map(mount => ({ mountPoint: mount.mountPoint, record: mount.record })); }
  catch (error) { throw new TrustedFilesystemIsolationError(`trusted filesystem mount namespace evidence is malformed: ${error instanceof Error ? error.message : String(error)}`); }
}

function assertTicketMountSources(root: string, mounts: readonly MountObservation[]): void {
  if (root !== "/ticket") return;
  const ticket = mounts.find(mount => mount.mountPoint === root);
  const bridge = mounts.find(mount => mount.mountPoint === "/ticket/bridge");
  if (!ticket || !bridge) throw new TrustedFilesystemIsolationError("trusted filesystem topology lacks the exact /ticket and /ticket/bridge mounts");
  const ticketFields = mountFields(ticket.record);
  const bridgeFields = mountFields(bridge.record);
  const ticketSeparator = ticketFields.indexOf("-");
  const bridgeSeparator = bridgeFields.indexOf("-");
  const ticketFilesystem = ticketFields[ticketSeparator + 1]?.toLowerCase();
  const bridgeFilesystem = bridgeFields[bridgeSeparator + 1]?.toLowerCase();
  if (!ticketFilesystem || !["ext4", "xfs", "btrfs", "f2fs", "zfs", "bcachefs"].includes(ticketFilesystem)) throw new TrustedFilesystemIsolationError("trusted filesystem /ticket root is not a persistent local filesystem");
  if (bridgeFilesystem !== "virtiofs") throw new TrustedFilesystemIsolationError("trusted filesystem /ticket/bridge is not the exact virtiofs passthrough");
}

function mountFields(record: string): readonly string[] {
  const fields = record.split(" ");
  const separator = fields.indexOf("-");
  if (fields.length < 7 || separator < 6 || separator !== fields.lastIndexOf("-") || separator + 3 >= fields.length || !fields[separator + 1] || !fields[separator + 2]) throw new TrustedFilesystemIsolationError("trusted filesystem mount record is malformed");
  return fields;
}

function decodeMountInfoPath(value: string): string {
  if (/\\(?![0-7]{3})/u.test(value)) throw new TrustedFilesystemIsolationError("trusted filesystem mount point has an invalid escape");
  return value.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/** The only nested mount tolerated by the AIDEV-222 authority is the
 * controller-created, empty, untrusted Docker Sandboxes passthrough. Keep
 * this predicate exact and root-bound: accepting a caller-supplied path here
 * would turn the filesystem authority into a general mount exemption. */
function isExactUntrustedBridgeMount(root: string, mountPoint: string): boolean {
  return root === "/ticket" && mountPoint === "/ticket/bridge";
}
