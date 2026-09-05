import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, readdir, rmdir, statfs, unlink } from "node:fs/promises";
import path from "node:path";
import type { SandboxBridgeSpec } from "./domain.js";
import type { ResourceIdentity } from "../git/domain.js";
import { assertBridgeName, assertSandboxRunId, canonicalBytes, deriveBridgeName, deriveBridgeIdentityReference, sha256Bytes, BRIDGE_NAME_PATTERN } from "./identity.js";
import { ensurePrivateDirectory, openNoFollowWithin, readExactNoFollow, removeTreeNoFollow, renameWithIdentity, resourceIdentity, writeExclusiveFile } from "../git/paths.js";
import { processStartTime } from "./host-process-supervisor.js";

export interface BridgeQuotaProof {
  readonly path: string;
  readonly quotaBytes: number;
  readonly enforcement: "project-quota" | "filesystem-quota";
  readonly observedAt: string;
  readonly digest: string;
}

export interface BridgeQuotaAdministrator {
  create(path: string, quotaBytes: number): Promise<BridgeQuotaProof>;
  observe(path: string, expected: BridgeQuotaProof): Promise<BridgeQuotaProof>;
  /** Release is idempotent for the exact proof. Teardown is restartable after
   * a crash between quota release and metadata/tree cleanup. */
  release(path: string, expected: BridgeQuotaProof): Promise<void>;
}

export interface BridgeRecord {
  readonly schemaVersion: 1;
  readonly kind: "squire-sandbox-bridge";
  readonly runId: string;
  readonly name: string;
  readonly path: string;
  readonly logicalPath: "/ticket/bridge";
  readonly quotaBytes: number;
  readonly identityReference: string;
  readonly identity: ResourceIdentity;
  readonly quota: BridgeQuotaProof;
  readonly createdAt: string;
}

export interface BridgeManagerOptions {
  readonly controllerDataRoot: string;
  readonly quota: BridgeQuotaAdministrator;
  readonly rejectStorage?: (path: string) => Promise<void> | void;
  readonly quarantineRoot?: string;
}

export interface BridgeCanaryResult {
  readonly runId: string;
  readonly markerDigest: string;
  readonly emptyAfterCleanup: true;
  readonly identity: ResourceIdentity;
}

export class BridgeError extends Error {
  constructor(message: string) { super(message); this.name = "BridgeError"; }
}

/** Owns exactly one empty, quota-backed, run-specific passthrough directory.
 * The bridge is treated as untrusted data and is never used for trusted
 * import/export or controller evidence. */
export class BridgeManager {
  readonly #root: string;
  readonly #bridgesRoot: string;
  readonly #metaRoot: string;
  readonly #quarantineRoot: string;
  readonly #quota: BridgeQuotaAdministrator;
  readonly #rejectStorage: ((path: string) => Promise<void> | void) | undefined;
  constructor(options: BridgeManagerOptions) {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new BridgeError("bridge manager options are required");
    this.#root = assertControllerRoot(options.controllerDataRoot);
    this.#bridgesRoot = path.join(this.#root, "sandbox-bridges");
    this.#metaRoot = path.join(this.#root, "sandbox-bridges-meta");
    this.#quarantineRoot = options.quarantineRoot ? assertControllerRoot(options.quarantineRoot) : path.join(this.#root, "sandbox-bridges-quarantine");
    if (!isPathWithin(this.#root, this.#quarantineRoot) || this.#quarantineRoot === this.#root || pathsOverlap(this.#bridgesRoot, this.#quarantineRoot) || pathsOverlap(this.#metaRoot, this.#quarantineRoot)) throw new BridgeError("bridge quarantine root must be a separate private controller subtree");
    if (!options.quota || typeof options.quota.create !== "function" || typeof options.quota.observe !== "function" || typeof options.quota.release !== "function") throw new BridgeError("bridge quota administrator is required");
    this.#quota = options.quota;
    this.#rejectStorage = options.rejectStorage;
  }

  bridgePath(runId: string): string { return path.join(this.#bridgesRoot, this.bridgeName(runId)); }
  bridgeName(runId: string): string { assertSandboxRunId(runId); return deriveBridgeName(runId); }
  metadataPath(runId: string): string { return path.join(this.#metaRoot, this.bridgeName(runId), "identity.json"); }

  async create(runId: string, quotaBytes: number): Promise<BridgeRecord> {
    assertSandboxRunId(runId);
    if (!Number.isSafeInteger(quotaBytes) || quotaBytes < 4096 || quotaBytes > 107_374_182_400) throw new BridgeError("bridge quota is not a bounded positive byte count");
    const name = this.bridgeName(runId);
    await this.#ensureRoots();
    return this.#withRunLock(runId, async () => {
    const bridgePath = this.bridgePath(runId);
    const metaDir = path.join(this.#metaRoot, name);
    await this.#rejectStorage?.(bridgePath);
    if (await kind(bridgePath) !== "missing" || await kind(metaDir) !== "missing") throw new BridgeError("bridge or bridge metadata already exists");
    let identity: ResourceIdentity | undefined;
    let quota: BridgeQuotaProof | undefined;
    try {
      identity = await ensurePrivateDirectory(bridgePath, this.#bridgesRoot, 0o700);
      await this.#assertLocalPrivateDirectory(bridgePath);
      identity = await inspectHostResource(bridgePath, "directory");
      quota = await this.#quota.create(bridgePath, quotaBytes);
      assertQuotaProof(quota, bridgePath, quotaBytes);
      if (quota.path !== bridgePath || quota.quotaBytes !== quotaBytes) throw new BridgeError("quota administrator returned an untrusted proof");
      const record: BridgeRecord = { schemaVersion: 1, kind: "squire-sandbox-bridge", runId, name, path: bridgePath, logicalPath: "/ticket/bridge", quotaBytes, identityReference: deriveBridgeIdentityReference(runId, name), identity, quota, createdAt: new Date().toISOString() };
      await ensurePrivateDirectory(metaDir, this.#metaRoot, 0o700);
      await this.#assertLocalPrivateDirectory(metaDir);
      const metadataFile = path.join(metaDir, "identity.json");
      await writeExclusiveFile(metadataFile, canonicalBytes(record), this.#metaRoot, 0o600);
      await this.assertEmpty(runId);
      return deepFreeze(record);
    } catch (error) {
      if (!await this.#bestEffortRelease(bridgePath, quota, identity)) throw new BridgeError("bridge quota release could not be proven; exact bridge retained for recovery");
      const currentMeta = await inspectHostResource(metaDir, "directory").catch(error => { if (isCode(error, "ENOENT")) return undefined; return undefined; });
      if (currentMeta) await removeTreeNoFollow(metaDir, { ...currentMeta, path: metaDir }, this.#metaRoot).catch(() => undefined);
      const currentBridge = await inspectHostResource(bridgePath, "directory").catch(error => { if (isCode(error, "ENOENT")) return undefined; return undefined; });
      if (currentBridge && identity && sameIdentity(currentBridge, identity)) await removeTreeNoFollow(bridgePath, identity, this.#bridgesRoot).catch(() => undefined);
      throw error instanceof BridgeError ? error : new BridgeError(error instanceof Error ? error.message : String(error));
    }
    });
  }

  async read(runId: string): Promise<BridgeRecord | undefined> {
    assertSandboxRunId(runId);
    await this.#ensureRoots();
    const record = await this.#readManifest(runId);
    if (!record) return undefined;
    try {
      const actual = await inspectHostResource(record.path, "directory");
      if (!sameIdentity(actual, record.identity)) throw new BridgeError("bridge identity changed");
      const quota = await this.#quota.observe(record.path, record.quota);
      assertQuotaProof(quota, record.path, record.quotaBytes);
      if (quota.path !== record.path || quota.quotaBytes !== record.quotaBytes || quota.digest !== record.quota.digest) throw new BridgeError("bridge quota identity changed");
      return record;
    } catch (error) {
      throw error instanceof BridgeError ? error : new BridgeError(error instanceof Error ? error.message : String(error));
    }
  }

  /** Reads only the authenticated, deterministic manifest. This intentionally
   * does not require the live bridge or quota path so restart recovery can
   * finish a crash after quarantine or quota release. */
  async #readManifest(runId: string): Promise<BridgeRecord | undefined> {
    const metadata = this.metadataPath(runId);
    const metadataDir = path.dirname(metadata);
    const metadataDirInfo = await lstat(metadataDir).catch(error => { if (isCode(error, "ENOENT")) return undefined; throw error; });
    if (!metadataDirInfo) return undefined;
    if (!metadataDirInfo.isDirectory() || metadataDirInfo.isSymbolicLink() || (metadataDirInfo.mode & 0o777) !== 0o700 || metadataDirInfo.nlink < 2) throw new BridgeError("bridge metadata directory is not private");
    const metadataInfo = await lstat(metadata).catch(error => { if (isCode(error, "ENOENT")) return undefined; throw error; });
    if (!metadataInfo) return undefined;
    if (!metadataInfo.isFile() || metadataInfo.isSymbolicLink() || metadataInfo.nlink !== 1 || (metadataInfo.mode & 0o777) !== 0o600 || metadataInfo.size > 4 * 1024 * 1024) throw new BridgeError("bridge identity manifest is not a bounded private file");
    let bytes: Buffer;
    try { bytes = await readExactNoFollow(metadata, this.#metaRoot, 4 * 1024 * 1024); }
    catch (error) { if (isCode(error, "ENOENT")) return undefined; throw new BridgeError(error instanceof Error ? error.message : String(error)); }
    try {
      const record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as BridgeRecord;
      if (!bytes.equals(canonicalBytes(record))) throw new BridgeError("bridge identity manifest is not deterministically serialized");
      assertBridgeRecord(record, runId, this.bridgePath(runId));
      return deepFreeze(record);
    } catch (error) {
      throw error instanceof BridgeError ? error : new BridgeError(error instanceof Error ? error.message : String(error));
    }
  }

  async assertEmpty(runId: string): Promise<void> {
    const record = await this.read(runId);
    if (!record) throw new BridgeError("bridge metadata is missing");
    const handle = await openNoFollowWithin(record.path, this.#bridgesRoot, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const opened = await handle.stat();
      if (!sameIdentity(resourceIdentity(record.path, "directory", opened), record.identity)) throw new BridgeError("bridge identity changed during emptiness check");
      const entries = await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true });
      if (entries.length !== 0) throw new BridgeError("sandbox bridge must be empty before create or trusted launch");
    } finally { await handle.close(); }
  }

  /** The VM/host acceptance worker calls this after observing a random marker
   * written by the guest. This method never writes a marker itself. */
  async verifyProvisionCanary(runId: string, markerName: string, expectedMarkerDigest: string): Promise<BridgeCanaryResult> {
    assertSandboxRunId(runId);
    await this.#ensureRoots();
    return this.#withRunLock(runId, async () => {
    const record = await this.read(runId);
    if (!record) throw new BridgeError("bridge metadata is missing");
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(markerName) || markerName === "." || markerName === "..") throw new BridgeError("bridge canary marker name is invalid");
    const target = path.join(record.path, markerName);
    const markerInfo = await inspectHostResource(target, "file").catch(error => { throw new BridgeError(`bridge canary marker is unavailable: ${error instanceof Error ? error.message : String(error)}`); });
    const marker = await readExactNoFollow(target, this.#bridgesRoot, 1_048_576).catch(error => { throw new BridgeError(`bridge canary marker is unavailable: ${error instanceof Error ? error.message : String(error)}`); });
    const digest = sha256Bytes(marker);
    if (digest !== expectedMarkerDigest) throw new BridgeError("bridge canary marker digest mismatch");
    await removeTreeNoFollow(target, markerInfo, this.#bridgesRoot);
    await this.assertEmpty(runId);
    const identity = await inspectHostResource(record.path, "directory");
    if (!sameIdentity(identity, record.identity)) throw new BridgeError("bridge identity changed during canary cleanup");
    return { runId, markerDigest: digest, emptyAfterCleanup: true, identity };
    });
  }

  async quarantineAndRemove(runId: string, options: { readonly writersStopped: boolean; readonly signal?: AbortSignal } = { writersStopped: false }): Promise<void> {
    assertSandboxRunId(runId);
    if (!options.writersStopped) throw new BridgeError("bridge writers must be stopped before teardown");
    if (options.signal?.aborted) throw new BridgeError("bridge teardown was aborted");
    await this.#ensureRoots();
    return this.#withRunLock(runId, async () => {
      const record = await this.#readManifest(runId);
      const bridgePath = this.bridgePath(runId);
      const metadataDir = path.dirname(this.metadataPath(runId));
      if (!record) {
        const bridgeState = await kind(bridgePath);
        const metadataDirState = await kind(metadataDir);
        const quarantinePath = path.join(this.#quarantineRoot, this.bridgeName(runId));
        const quarantineState = await kind(quarantinePath);
        if (bridgeState !== "missing" || quarantineState !== "missing") throw new BridgeError("bridge metadata is missing while an exact bridge resource remains");
        if (metadataDirState === "directory") {
          const metadataIdentity = await inspectHostResource(metadataDir, "directory");
          const handle = await openNoFollowWithin(metadataDir, this.#metaRoot, constants.O_RDONLY | constants.O_DIRECTORY);
          try {
            if ((await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true })).length !== 0) throw new BridgeError("bridge metadata is missing while unexpected metadata remains");
          } finally { await handle.close(); }
          await removeTreeNoFollow(metadataDir, metadataIdentity, this.#metaRoot);
        } else if (metadataDirState !== "missing") throw new BridgeError("bridge metadata is missing while an exact metadata resource remains");
        if (await kind(metadataDir) !== "missing") throw new BridgeError("bridge metadata directory removal was not observed");
        return;
      }
      if (!isPathWithin(this.#root, this.#quarantineRoot)) throw new BridgeError("bridge quarantine root must remain under the controller data root");
      await mkdir(this.#quarantineRoot, { recursive: true, mode: 0o700 });
      await this.#assertLocalPrivateDirectory(this.#quarantineRoot);
      // The deterministic quarantine name is part of recovery identity. A
      // random name would make a crash after rename undiscoverable.
      const quarantine = path.join(this.#quarantineRoot, record.name);
      const bridgeState = await kind(bridgePath);
      const quarantineState = await kind(quarantine);
      if (bridgeState !== "missing" && quarantineState !== "missing") throw new BridgeError("bridge and quarantine identities coexist");
      let quarantined = quarantineState !== "missing";
      let quotaReleased = false;
      let quotaReleaseAttempted = false;
      try {
        if (bridgeState !== "missing") {
          const quota = await this.#quota.observe(record.path, record.quota);
          assertQuotaProof(quota, record.path, record.quotaBytes);
          if (quota.path !== record.path || quota.quotaBytes !== record.quotaBytes || quota.digest !== record.quota.digest) throw new BridgeError("bridge quota identity changed before teardown");
          const current = await inspectHostResource(record.path, "directory");
          if (!sameIdentity(current, record.identity)) throw new BridgeError("bridge identity changed before teardown");
          await renameWithIdentity(record.path, quarantine, this.#root, { ...record.identity, path: record.path });
          quarantined = true;
        } else if (quarantineState !== "missing") {
          const moved = await inspectHostResource(quarantine, "directory");
          if (!sameObjectIdentity(moved, record.identity)) throw new BridgeError("bridge identity changed during quarantine recovery");
        }
        if (options.signal?.aborted) throw new BridgeError("bridge teardown was aborted");
        // Release while the exact identity is still quarantined. The quota
        // adapter is required to make this exact release idempotent, allowing
        // restart recovery after a crash at every subsequent boundary.
        quotaReleaseAttempted = true;
        await this.#quota.release(record.path, record.quota);
        quotaReleased = true;
        if (quarantined && await kind(quarantine) !== "missing") {
          const moved = await inspectHostResource(quarantine, "directory");
          if (!sameObjectIdentity(moved, record.identity)) throw new BridgeError("bridge identity changed before quarantine removal");
          await removeTreeNoFollow(quarantine, moved, this.#root, undefined, { ...(options.signal ? { signal: options.signal } : {}), maxEntries: 100_000, maxDepth: 64 });
          quarantined = false;
        }
        // Do not make cancellation interrupt this final metadata phase after
        // quota release; leaving the authenticated manifest is recoverable,
        // while deleting it first would make quota recovery ambiguous.
        const metadataIdentity = await inspectHostResource(metadataDir, "directory").catch(error => { if (isCode(error, "ENOENT")) return undefined; throw error; });
        if (metadataIdentity) {
          const metadata = path.join(metadataDir, "identity.json");
          const metadataFileIdentity = await inspectHostResource(metadata, "file");
          await removeTreeNoFollow(metadata, metadataFileIdentity, this.#metaRoot);
          await removeTreeNoFollow(metadataDir, metadataIdentity, this.#metaRoot);
        }
        if (await kind(bridgePath) !== "missing" || await kind(quarantine) !== "missing" || await kind(metadataDir) !== "missing") throw new BridgeError("bridge removal was not observed at the exact identity boundary");
      } catch (error) {
        // Before the irreversible quota release, restore the exact directory so
        // a failed/aborted teardown remains retryable. Once release succeeded,
        // never recreate a bridge without its quota; the manifest is retained
        // for the next invocation to finish cleanup.
        if (!quotaReleaseAttempted && !quotaReleased && quarantined && await kind(bridgePath) === "missing") {
          const moved = await inspectHostResource(quarantine, "directory").catch(() => undefined);
          if (moved && sameObjectIdentity(moved, record.identity)) await renameWithIdentity(quarantine, bridgePath, this.#root, { ...record.identity, path: quarantine }).catch(() => undefined);
        }
        throw error instanceof BridgeError ? error : new BridgeError(error instanceof Error ? error.message : String(error));
      }
    });
  }

  async #withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.#metaRoot, `${this.bridgeName(runId)}.lock`);
    const deadline = Date.now() + 10_000;
    let lock: BridgeLockHandle | undefined;
    for (;;) {
      try { lock = await acquireBridgeLock(lockPath); break; }
      catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        await reclaimBridgeLock(lockPath);
        if (Date.now() >= deadline) throw new BridgeError("bridge identity lock acquisition timed out");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    let result: T | undefined; let failure: unknown;
    try { result = await operation(); }
    catch (error) { failure = error; }
    try { await releaseBridgeLock(lockPath, lock!); }
    catch (error) { failure = failure ? new AggregateError([failure, error], "bridge identity lock release failed") : error; }
    if (failure) throw failure;
    return result as T;
  }

  async #ensureRoots(): Promise<void> {
    for (const directory of [this.#root, this.#bridgesRoot, this.#metaRoot, this.#quarantineRoot]) {
      await assertNoSymlinkAncestors(directory);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await this.#assertLocalPrivateDirectory(directory);
    }
  }

  async #assertLocalPrivateDirectory(directory: string): Promise<void> {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.nlink < 2) throw new BridgeError(`bridge controller directory is not private: ${directory}`);
    const fs = await statfs(directory);
    // Common remote/cloud filesystem magic values. Unknown types are not
    // accepted when a caller requests an explicit storage policy callback.
    const type = Number(fs.type);
    const localTypes = new Set([0xEF53, 0x58465342, 0x9123683E, 0x01021994, 0x794C7630, 0x62656572]);
    if ([0x6969, 0x517b, 0x65735546, 0xfe534d42].includes(type) || !localTypes.has(type)) throw new BridgeError("bridge storage is not an independently recognized local filesystem");
  }

  async #bestEffortRelease(bridgePath: string, quota: BridgeQuotaProof | undefined, identity?: ResourceIdentity): Promise<boolean> {
    if (!quota) return true;
    if (!identity) return false;
    const current = await inspectHostResource(bridgePath, "directory").catch(() => undefined);
    if (!current || !sameIdentity(current, identity)) return false;
    try { await this.#quota.release(bridgePath, quota); return true; }
    catch { return false; }
  }
}

/** A deliberately non-enforcing default: production code must inject a real
 * quota administrator, while tests can inject a deterministic implementation. */
export class RejectingBridgeQuotaAdministrator implements BridgeQuotaAdministrator {
  async create(): Promise<BridgeQuotaProof> { throw new BridgeError("bridge quota enforcement is unavailable"); }
  async observe(): Promise<BridgeQuotaProof> { throw new BridgeError("bridge quota enforcement is unavailable"); }
  async release(): Promise<void> { throw new BridgeError("bridge quota enforcement is unavailable"); }
}

/** Test/conformance seam. It records the exact tuple but is intentionally not a
 * production proof; release promotion must use host quota evidence instead. */
export class RecordingBridgeQuotaAdministrator implements BridgeQuotaAdministrator {
  readonly records = new Map<string, BridgeQuotaProof>();
  async create(target: string, quotaBytes: number): Promise<BridgeQuotaProof> {
    if (this.records.has(target)) throw new BridgeError("quota already exists");
    const proofWithoutDigest = { path: target, quotaBytes, enforcement: "project-quota" as const, observedAt: new Date().toISOString() };
    const proof: BridgeQuotaProof = { ...proofWithoutDigest, digest: createHash("sha256").update(canonicalJson(proofWithoutDigest), "utf8").digest("hex") };
    this.records.set(target, proof); return proof;
  }
  async observe(target: string, expected: BridgeQuotaProof): Promise<BridgeQuotaProof> { const current = this.records.get(target); if (!current || current.digest !== expected.digest) throw new BridgeError("quota proof changed"); return current; }
  async release(target: string, expected: BridgeQuotaProof): Promise<void> { const current = this.records.get(target); if (!current) return; if (current.digest !== expected.digest) throw new BridgeError("quota proof changed before release"); this.records.delete(target); }
}

function assertControllerRoot(value: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value || value === path.parse(value).root || value.includes("\\") || value.includes("//") || /[\u0000-\u001f\u007f\r\n]/u.test(value) || value.endsWith(path.sep)) throw new BridgeError("controller data root must be a canonical non-root absolute path");
  return value;
}

function isPathWithin(root: string, target: string): boolean {
  const canonicalRoot = path.resolve(root);
  const canonicalTarget = path.resolve(target);
  return canonicalTarget === canonicalRoot || canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`);
}
function pathsOverlap(left: string, right: string): boolean { return isPathWithin(left, right) || isPathWithin(right, left); }

async function inspectHostResource(target: string, expected: "file" | "directory"): Promise<ResourceIdentity> {
  const info = await lstat(target);
  if ((expected === "directory" && (!info.isDirectory() || info.isSymbolicLink())) || (expected === "file" && (!info.isFile() || info.isSymbolicLink()))) throw new BridgeError(`bridge resource is not a trusted ${expected}`);
  if (expected === "file" && (info.nlink !== 1 || (info.mode & 0o777) !== 0o600)) throw new BridgeError("bridge file is not a private single-link file");
  return resourceIdentity(path.resolve(target), expected, info);
}

function assertBridgeRecord(record: BridgeRecord, runId: string, expectedPath: string): void {
  if (!record || !hasExactKeys(record as unknown as Record<string, unknown>, ["createdAt", "identity", "identityReference", "kind", "logicalPath", "name", "path", "quota", "quotaBytes", "runId", "schemaVersion"]) || record.schemaVersion !== 1 || record.kind !== "squire-sandbox-bridge" || record.runId !== runId || record.name !== deriveBridgeName(runId) || !BRIDGE_NAME_PATTERN.test(record.name) || record.path !== expectedPath || record.logicalPath !== "/ticket/bridge" || record.identityReference !== deriveBridgeIdentityReference(runId, record.name) || !record.identity || !hasExactKeys(record.identity as unknown as Record<string, unknown>, ["device", "inode", "kind", "linkCount", "mode", "path"]) || record.identity.path !== expectedPath || record.identity.kind !== "directory" || !safeText(record.identity.device) || !safeText(record.identity.inode) || record.identity.linkCount < 2 || record.identity.mode !== 0o700 || !record.quota || record.quota.path !== expectedPath || !hasExactKeys(record.quota as unknown as Record<string, unknown>, ["digest", "enforcement", "observedAt", "path", "quotaBytes"]) || record.quota.quotaBytes !== record.quotaBytes || !["project-quota", "filesystem-quota"].includes(record.quota.enforcement) || !/^[0-9a-f]{64}$/u.test(record.quota.digest) || !canonicalDate(record.createdAt) || !canonicalDate(record.quota.observedAt)) throw new BridgeError("bridge identity manifest is malformed");
  if (!Number.isSafeInteger(record.quotaBytes) || record.quotaBytes < 4096 || record.quotaBytes > 107_374_182_400 || !Number.isSafeInteger(record.identity.mode) || record.identity.mode !== 0o700 || !Number.isSafeInteger(record.identity.linkCount) || record.identity.linkCount < 2 || !Number.isSafeInteger(record.quota.quotaBytes) || sha256Bytes(Buffer.from(canonicalJson({ path: record.quota.path, quotaBytes: record.quota.quotaBytes, enforcement: record.quota.enforcement, observedAt: record.quota.observedAt }), "utf8")) !== record.quota.digest) throw new BridgeError("bridge identity or quota bounds are invalid");
}

function sameIdentity(left: ResourceIdentity, right: ResourceIdentity): boolean {
  return left.path === right.path && sameObjectIdentity(left, right);
}
function sameObjectIdentity(left: ResourceIdentity, right: ResourceIdentity): boolean {
  return left.kind === right.kind && left.device === right.device && left.inode === right.inode && left.mode === right.mode && left.linkCount === right.linkCount;
}

async function kind(target: string): Promise<"missing" | "file" | "directory" | "other"> {
  try { const info = await lstat(target); if (info.isSymbolicLink()) return "other"; if (info.isFile()) return "file"; if (info.isDirectory()) return "directory"; return "other"; }
  catch (error) { if (isCode(error, "ENOENT")) return "missing"; throw error; }
}

interface BridgeLockOwner { readonly pid: number; readonly startTime: string; readonly token: string }
interface BridgeLockHandle { readonly token: string; readonly ownerPath: string }

async function acquireBridgeLock(lockPath: string): Promise<BridgeLockHandle> {
  await mkdir(lockPath, { recursive: false, mode: 0o700 });
  const ownerPath = path.join(lockPath, "owner.json");
  const owner: BridgeLockOwner = { pid: process.pid, startTime: await processStartTime(process.pid), token: randomUUID() };
  try { await writeExclusiveFile(ownerPath, canonicalBytes(owner), lockPath, 0o600); }
  catch (error) {
    await rmdir(lockPath).catch(removeError => { if (!isCode(removeError, "ENOENT") && !isCode(removeError, "ENOTEMPTY")) throw removeError; });
    throw error;
  }
  return { token: owner.token, ownerPath };
}

async function readBridgeLockOwner(ownerPath: string): Promise<BridgeLockOwner | undefined> {
  try {
    const bytes = await readExactNoFollow(ownerPath, path.dirname(ownerPath), 4_096);
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value as Record<string, unknown>, ["pid", "startTime", "token"])) throw new BridgeError("bridge identity lock owner is malformed");
    const record = value as Record<string, unknown>;
    if (typeof record["pid"] !== "number" || !Number.isSafeInteger(record["pid"]) || (record["pid"] as number) <= 0 || typeof record["startTime"] !== "string" || !/^\d+$/u.test(record["startTime"]) || typeof record["token"] !== "string" || !/^[0-9a-f-]{36}$/iu.test(record["token"]) || !bytes.equals(canonicalBytes(value))) throw new BridgeError("bridge identity lock owner is malformed");
    return { pid: record["pid"], startTime: record["startTime"], token: record["token"] };
  } catch (error) { if (isCode(error, "ENOENT")) return undefined; throw error; }
}

async function reclaimBridgeLock(lockPath: string): Promise<void> {
  const info = await lstat(lockPath).catch(error => { if (isCode(error, "ENOENT")) return undefined; throw error; });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new BridgeError("bridge identity lock is not private");
  const ownerPath = path.join(lockPath, "owner.json");
  const owner = await readBridgeLockOwner(ownerPath);
  if (!owner) {
    if (Date.now() - info.mtimeMs < 5_000) return;
    await rmdir(lockPath).catch(error => { if (!isCode(error, "ENOENT") && !isCode(error, "ENOTEMPTY")) throw error; });
    return;
  }
  let alive = true;
  try {
    const start = await processStartTime(owner.pid);
    if (start !== owner.startTime) alive = false;
    else { try { process.kill(owner.pid, 0); } catch (error) { alive = !isCode(error, "ESRCH"); } }
  } catch (error) { if (isCode(error, "ENOENT")) alive = false; }
  if (alive) return;
  const check = await readBridgeLockOwner(ownerPath);
  if (!check || check.token !== owner.token || check.pid !== owner.pid || check.startTime !== owner.startTime) return;
  await unlink(ownerPath).catch(error => { if (!isCode(error, "ENOENT")) throw error; });
  await rmdir(lockPath).catch(error => { if (!isCode(error, "ENOENT") && !isCode(error, "ENOTEMPTY")) throw error; });
}

async function releaseBridgeLock(lockPath: string, lock: BridgeLockHandle): Promise<void> {
  const owner = await readBridgeLockOwner(lock.ownerPath);
  if (!owner || owner.token !== lock.token || owner.pid !== process.pid) throw new BridgeError("bridge identity lock ownership changed");
  await unlink(lock.ownerPath);
  await rmdir(lockPath);
}

function isCode(error: unknown, code: string, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 3) return false;
  if ("code" in error && (error as { code?: unknown }).code === code) return true;
  if ("cause" in error) return isCode((error as { cause?: unknown }).cause, code, depth + 1);
  return false;
}
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T { if (!value || typeof value !== "object" || seen.has(value as object)) return value; seen.add(value as object); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen); return Object.freeze(value); }
function assertQuotaProof(value: unknown, expectedPath: string, expectedBytes: number): asserts value is BridgeQuotaProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BridgeError("quota administrator returned an untrusted proof");
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ["digest", "enforcement", "observedAt", "path", "quotaBytes"]) || record["path"] !== expectedPath || record["quotaBytes"] !== expectedBytes || !["project-quota", "filesystem-quota"].includes(record["enforcement"] as string) || typeof record["digest"] !== "string" || !/^[0-9a-f]{64}$/u.test(record["digest"] as string) || !canonicalDate(record["observedAt"])) throw new BridgeError("quota administrator returned an untrusted proof");
  const proofWithoutDigest = { path: record["path"], quotaBytes: record["quotaBytes"], enforcement: record["enforcement"], observedAt: record["observedAt"] };
  if (sha256Bytes(Buffer.from(canonicalJson(proofWithoutDigest), "utf8")) !== record["digest"]) throw new BridgeError("quota administrator returned an unbound proof");
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function safeText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f\r\n]/u.test(value); }
function canonicalDate(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
async function assertNoSymlinkAncestors(target: string): Promise<void> {
  const root = path.parse(target).root; let current = root;
  for (const part of target.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const info = await lstat(current).catch(error => { if (isCode(error, "ENOENT")) return undefined; throw error; });
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new BridgeError("bridge controller path has an unsafe ancestor");
  }
}
function canonicalJson(value: unknown): string { if (value === null) return "null"; if (typeof value === "string") return JSON.stringify(value); if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; if (typeof value === "object") { const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`; } throw new BridgeError("unsupported bridge metadata value"); }
void assertSandboxRunId;
void assertBridgeName;
