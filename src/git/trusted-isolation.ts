import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { assertTicketRoot } from "./paths.js";

/**
 * Runtime authority for Git's filesystem side effects.
 *
 * The token class, constructor secret, WeakSet, and WeakMap are module-private.
 * The exported name is a type only: JavaScript callers cannot construct a
 * lookalike token or invoke a public mint. The sole issuer below performs the
 * live namespace/mount/root checks and binds the resulting token to that exact
 * root and observation. AIDEV-223 owns sandbox provisioning and composes this
 * boundary after its OS setup; AIDEV-222 does not create mounts.
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

interface IsolationObservation {
  readonly root: string;
  readonly namespace: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly mountFingerprint: string;
}

interface MountObservation {
  readonly mountPoint: string;
  readonly record: string;
}

const ISSUER_SECRET = Symbol("aidev-222-trusted-filesystem-issuer");
const AUTHORITIES = new WeakSet<TrustedFilesystemIsolationAuthorityToken>();
const OBSERVATIONS = new WeakMap<TrustedFilesystemIsolationAuthorityToken, IsolationObservation>();

/**
 * Trusted composition/issuer boundary. It has no assertion/proof parameter:
 * issuance is possible only after this module reads the live mount namespace,
 * exact canonical root, root identity, and mount topology. Nested mounts below
 * the ticket root are rejected, including same-device bind mounts.
 */
export async function composeTrustedFilesystemIsolationAuthority(ticketRoot: string): Promise<TrustedFilesystemIsolationAuthority> {
  const observation = await captureIsolationObservation(ticketRoot);
  const authority = new TrustedFilesystemIsolationAuthorityToken(ISSUER_SECRET);
  AUTHORITIES.add(authority);
  OBSERVATIONS.set(authority, observation);
  return authority;
}

/** Synchronous constructor gate used before a service can retain the authority. */
export function authenticateTrustedFilesystemAuthority(value: unknown, ticketRoot: string): asserts value is TrustedFilesystemIsolationAuthority {
  const root = canonicalRoot(ticketRoot);
  const observation = authenticatedObservation(value);
  if (observation.root !== root) throw new TrustedFilesystemIsolationError("trusted filesystem authority is bound to a different ticket root");
}

/**
 * Operation boundary used immediately before every service side effect. The
 * original namespace/root/mount observation is re-read and must remain exact;
 * a namespace change, root replacement, new nested mount, or mount topology
 * change makes the token stale and fails closed.
 */
export async function assertTrustedFilesystemOperation(value: unknown, ticketRoot: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new TrustedFilesystemIsolationError("trusted filesystem operation was aborted");
  const root = canonicalRoot(ticketRoot);
  const expected = authenticatedObservation(value);
  if (expected.root !== root) throw new TrustedFilesystemIsolationError("trusted filesystem operation root is not exact");
  const current = await captureIsolationObservation(root);
  if (current.namespace !== expected.namespace || current.device !== expected.device || current.inode !== expected.inode || current.mode !== expected.mode || current.mountFingerprint !== expected.mountFingerprint) {
    throw new TrustedFilesystemIsolationError("trusted filesystem authority is stale or filesystem topology changed");
  }
  if (signal?.aborted) throw new TrustedFilesystemIsolationError("trusted filesystem operation was aborted");
}

function authenticatedObservation(value: unknown): IsolationObservation {
  if (!value || (typeof value !== "object" && typeof value !== "function") || !AUTHORITIES.has(value as TrustedFilesystemIsolationAuthorityToken)) throw new TrustedFilesystemIsolationError("runtime-authenticated trusted filesystem authority is required");
  const observation = OBSERVATIONS.get(value as TrustedFilesystemIsolationAuthorityToken);
  if (!observation) throw new TrustedFilesystemIsolationError("trusted filesystem authority observation is unavailable");
  return observation;
}

function canonicalRoot(ticketRoot: string): string {
  try { return assertTicketRoot(ticketRoot); }
  catch (error) { throw new TrustedFilesystemIsolationError(error instanceof Error ? error.message : "ticket root is not canonical"); }
}

async function captureIsolationObservation(ticketRoot: string): Promise<IsolationObservation> {
  if (process.platform !== "linux") throw new TrustedFilesystemIsolationError("runtime filesystem isolation requires Linux mount-namespace evidence");
  const root = canonicalRoot(ticketRoot);
  let rootReal: string;
  let namespace: string;
  let mountInfo: string;
  try {
    [rootReal, namespace, mountInfo] = await Promise.all([
      realpath(root),
      readlink("/proc/self/ns/mnt"),
      readFile("/proc/self/mountinfo", "utf8"),
    ]);
  } catch (error) {
    throw new TrustedFilesystemIsolationError(`trusted filesystem namespace/root evidence is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (rootReal !== root || !/^mnt:\[[0-9]+\]$/u.test(namespace)) throw new TrustedFilesystemIsolationError("trusted filesystem root or mount namespace is not canonical");
  let info: Awaited<ReturnType<typeof lstat>>;
  try { info = await lstat(root); }
  catch (error) { throw new TrustedFilesystemIsolationError(`trusted filesystem root is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new TrustedFilesystemIsolationError("trusted filesystem root is not a regular canonical directory");
  const mounts = parseMountInfo(mountInfo);
  const nested = mounts.filter(mount => isWithin(root, mount.mountPoint) && mount.mountPoint !== root);
  if (nested.length > 0) throw new TrustedFilesystemIsolationError(`trusted filesystem root contains a nested mount: ${nested[0]!.mountPoint}`);
  const relevant = mounts.filter(mount => isWithin(root, mount.mountPoint)).sort((a, b) => a.record.localeCompare(b.record));
  const mountFingerprint = createHash("sha256").update(relevant.map(mount => mount.record).join("\n"), "utf8").digest("hex");
  return Object.freeze({ root, namespace, device: String(info.dev), inode: String(info.ino), mode: info.mode & 0o7777, mountFingerprint });
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
