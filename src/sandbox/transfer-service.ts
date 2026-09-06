import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { ContractReference } from "../control/domain.js";
import type { SandboxDriver } from "./sbx-v039-driver.js";
import type { SbxCommandResult } from "./host-process-supervisor.js";
import { isResolvedSandboxRelease } from "./release-resolver.js";
import { buildTransferFingerprint, assertTransferSemantics } from "./contracts.js";
import type { SandboxTransferManifestDocument } from "./domain.js";
import { assertCanonicalSandboxPath, assertDigestReference, assertSandboxName, assertSandboxRunId, assertSha256, canonicalBytes, deriveSandboxName, sha256Bytes } from "./identity.js";
import type { GuestOperationClient } from "./guest-protocol.js";
import type { SandboxLifecyclePort, SandboxTransferReservation } from "./lifecycle-service.js";
import { ensurePrivateDirectory, openNoFollowWithin, readExactNoFollow, removeTreeNoFollow, renameWithIdentity, resourceIdentity, sameResourceIdentity, writeExclusiveFile } from "../git/paths.js";

export const MAX_TRANSFER_BYTES = 512 * 1024 * 1024;

export interface RepositorySeedArtifact {
  readonly logicalName: string;
  readonly bytes: Uint8Array;
  readonly expectedGit?: SandboxTransferManifestDocument["expectedGit"];
}
export interface RepositorySeedArtifactPort { readSeed(runId: string, signal?: AbortSignal): Promise<RepositorySeedArtifact> }
export interface TrustedRetentionStore {
  put(runId: string, name: string, bytes: Uint8Array, manifest: SandboxTransferManifestDocument, signal?: AbortSignal): Promise<ContractReference>;
  acknowledge(reference: ContractReference, signal?: AbortSignal): Promise<void>;
}
export interface SandboxTransferContext {
  readonly runId: string;
  readonly sandboxName: string;
  readonly sandboxId: string;
  readonly templateDigest: string;
  readonly specFingerprint: string;
  readonly bootId: string;
  readonly transferGeneration: number;
}
export interface TransferResult {
  readonly manifest: SandboxTransferManifestDocument;
  readonly hostPath: string;
  readonly command: SbxCommandResult;
  readonly retentionReference?: ContractReference;
}
export interface SandboxTransferServiceOptions {
  readonly controllerDataRoot: string;
  readonly driver: SandboxDriver;
  readonly guest: GuestOperationClient;
  readonly maxBytes?: number;
  readonly retention?: TrustedRetentionStore;
  /** Source acquisition remains a trusted controller port. */
  readonly seed?: RepositorySeedArtifactPort;
  /** Every transfer call allocates its durable reservation before touching
   * staging, sbx, or the guest. */
  readonly lifecycle: SandboxLifecyclePort;
}

export class SandboxTransferError extends Error {
  constructor(message: string) { super(message); this.name = "SandboxTransferError"; }
}

/** Copies only digest-bound files through private controller staging. The
 * bridge is intentionally not accepted by any method in this service. */
export class SandboxTransferService {
  readonly #root: string;
  readonly #driver: SandboxDriver;
  readonly #guest: GuestOperationClient;
  readonly #maxBytes: number;
  readonly #retention: TrustedRetentionStore | undefined;
  readonly #seed: RepositorySeedArtifactPort | undefined;
  readonly #lifecycle: SandboxLifecyclePort;
  get retentionConfigured(): boolean { return this.#retention !== undefined; }
  constructor(options: SandboxTransferServiceOptions) {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new SandboxTransferError("transfer service options are required");
    if (!options.driver || !isResolvedSandboxRelease(options.driver.release) || options.driver.release.release.promotion.state !== "validated") throw new SandboxTransferError("transfer driver requires a release verified by SandboxReleaseResolver");
    if (!path.isAbsolute(options.controllerDataRoot) || options.controllerDataRoot.includes("\0") || path.resolve(options.controllerDataRoot) !== options.controllerDataRoot || path.parse(options.controllerDataRoot).root === options.controllerDataRoot || options.controllerDataRoot.endsWith(path.sep)) throw new SandboxTransferError("transfer root must be canonical absolute host storage");
    if (!options.guest || typeof options.guest.invoke !== "function") throw new SandboxTransferError("transfer guest operation client is required");
    if (options.retention && (typeof options.retention.put !== "function" || typeof options.retention.acknowledge !== "function")) throw new SandboxTransferError("transfer retention store is not closed");
    if (!options.lifecycle || typeof options.lifecycle.withTransfer !== "function") throw new SandboxTransferError("transfer lifecycle reservation authority is required");
    this.#root = options.controllerDataRoot; this.#driver = options.driver; this.#guest = options.guest; this.#maxBytes = options.maxBytes ?? MAX_TRANSFER_BYTES; this.#retention = options.retention; this.#seed = options.seed; this.#lifecycle = options.lifecycle;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes <= 0 || this.#maxBytes > MAX_TRANSFER_BYTES) throw new SandboxTransferError("transfer byte limit is invalid");
  }

  async importSeed(context: SandboxTransferContext, signal?: AbortSignal): Promise<TransferResult> {
    assertContext(context);
    return this.#withReservation(context, "import", signal, (reserved, operationSignal) => this.#importSeed(reserved, operationSignal));
  }

  async #importSeed(context: SandboxTransferContext, signal?: AbortSignal): Promise<TransferResult> {
    throwIfAborted(signal);
    assertDriverContext(this.#driver, context);
    assertGuestContext(this.#guest, context, this.#driver);
    const seed = await this.#requireSeed(context.runId, signal);
    const bytes = boundedBytes(seed.bytes, this.#maxBytes);
    const digest = sha256Bytes(bytes);
    const safeName = safeTransferName(seed.logicalName, "seed");
    if (safeName !== "repository-seed.bundle") throw new SandboxTransferError("repository import is restricted to the fixed repository-seed.bundle artifact");
    assertExpectedGit(seed.expectedGit, context.runId);
    const hostPath = await this.#stage(context, "import", safeName, bytes, digest);
    const sandboxPath = `/ticket/import/${safeName}`;
    const sandboxStagingPath = `/ticket/import/.repository-seed-${context.transferGeneration}-${randomUUID()}.incoming`;
    const command = await this.#driver.cpImport({ sandboxName: context.sandboxName, expectedSandboxId: context.sandboxId, expectedTemplateDigest: context.templateDigest, expectedBootId: context.bootId, hostPath, sandboxPath: sandboxStagingPath }, signal);
    const stagedAfterCopy = await readExactFile(hostPath, this.#maxBytes, this.#root);
    if (stagedAfterCopy.length !== bytes.length || sha256Bytes(stagedAfterCopy) !== digest) throw new SandboxTransferError("import staging bytes changed during controller-mediated copy");
    const guestProof = await this.#guest.invoke("import", { path: sandboxStagingPath, publishPath: sandboxPath, byteLength: bytes.length, sha256: digest, transferGeneration: context.transferGeneration }, signal);
    assertGuestProof(guestProof, bytes.length, digest, sandboxPath, context.transferGeneration);
    const manifest = makeManifest({ context, direction: "import", source: { logicalPath: `import/${safeName}`, side: "host" }, destination: { logicalPath: sandboxPath, side: "sandbox" }, bytes, expectedGit: seed.expectedGit });
    await this.#persistManifest(context, manifest);
    return { manifest, hostPath, command };
  }

  async exportFile(context: SandboxTransferContext, sourcePath: string, name: string, expected: { readonly byteLength: number; readonly sha256: string; readonly expectedGit?: SandboxTransferManifestDocument["expectedGit"] }, signal?: AbortSignal): Promise<TransferResult> {
    assertContext(context);
    return this.#withReservation(context, "export", signal, (reserved, operationSignal) => this.#exportFile(reserved, sourcePath, name, expected, operationSignal));
  }

  async #exportFile(context: SandboxTransferContext, sourcePath: string, name: string, expected: { readonly byteLength: number; readonly sha256: string; readonly expectedGit?: SandboxTransferManifestDocument["expectedGit"] }, signal?: AbortSignal): Promise<TransferResult> {
    assertContext(context);
    throwIfAborted(signal);
    assertDriverContext(this.#driver, context);
    assertGuestContext(this.#guest, context, this.#driver);
    assertCanonicalSandboxPath(sourcePath, "sandbox export source");
    if (!sourcePath.startsWith("/ticket/artifacts/") && !sourcePath.startsWith("/ticket/evidence/") && !sourcePath.startsWith("/ticket/sessions/")) throw new SandboxTransferError("sandbox export source is outside the closed trusted retention roots");
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) throw new SandboxTransferError("expected export proof is not closed");
    const expectedKeys = Object.keys(expected as unknown as Record<string, unknown>).sort().join("\0");
    if (expectedKeys !== "byteLength\0sha256" && expectedKeys !== "byteLength\0expectedGit\0sha256") throw new SandboxTransferError("expected export proof is not closed");
    assertSha256(expected.sha256, "expected export digest");
    if (!Number.isSafeInteger(expected.byteLength) || expected.byteLength <= 0 || expected.byteLength > this.#maxBytes) throw new SandboxTransferError("expected export length is invalid");
    assertExpectedGit(expected.expectedGit, context.runId);
    const safeName = safeTransferName(name, "export");
    const destination = path.join(this.#root, "sandbox-transfer", context.runId, `export-${context.transferGeneration}-${safeName}`);
    const staging = path.join(path.dirname(destination), `.export-${context.transferGeneration}-${safeName}-${randomUUID()}`);
    await assertPrivateRoot(this.#root);
    await ensurePrivateDirectory(path.join(this.#root, "sandbox-transfer"), this.#root);
    await ensurePrivateDirectory(path.dirname(destination), this.#root);
    let stagingIdentity: ReturnType<typeof resourceIdentity> | undefined;
    let publicationIdentity: ReturnType<typeof resourceIdentity> | undefined;
    let command: SbxCommandResult;
    let copied: Buffer;
    try {
      const sourceProof = await this.#guest.invoke("export", { path: sourcePath, byteLength: expected.byteLength, sha256: expected.sha256, transferGeneration: context.transferGeneration }, signal);
      assertGuestProof(sourceProof, expected.byteLength, expected.sha256, sourcePath, context.transferGeneration);
      command = await this.#driver.cpExport({ sandboxName: context.sandboxName, expectedSandboxId: context.sandboxId, expectedTemplateDigest: context.templateDigest, expectedBootId: context.bootId, hostPath: staging, sandboxPath: sourcePath }, signal);
      copied = await readExactFile(staging, this.#maxBytes, this.#root);
      if (copied.length !== expected.byteLength || sha256Bytes(copied) !== expected.sha256) throw new SandboxTransferError("exported bytes do not match the guest-bound digest and length");
      const stagingInfo = await lstat(staging);
      if (!stagingInfo.isFile() || stagingInfo.isSymbolicLink() || stagingInfo.nlink !== 1 || !isPrivateFileMode(stagingInfo.mode)) throw new SandboxTransferError("export staging target is not a private regular file");
      stagingIdentity = resourceIdentity(staging, "file", stagingInfo);
      const stable = await readExactFile(staging, this.#maxBytes, this.#root);
      if (!stable.equals(copied)) throw new SandboxTransferError("export staging bytes changed before publication");
      if (await pathKind(destination) === "present") {
        const existing = await readExactFile(destination, this.#maxBytes, this.#root);
        if (existing.length !== expected.byteLength || sha256Bytes(existing) !== expected.sha256) throw new SandboxTransferError("export destination was pre-created with substituted bytes");
        await removeTreeNoFollow(staging, stagingIdentity, this.#root);
      } else {
        await renameWithIdentity(staging, destination, this.#root, stagingIdentity);
        stagingIdentity = undefined;
      }
      const destinationInfo = await lstat(destination);
      if (!destinationInfo.isFile() || destinationInfo.isSymbolicLink() || destinationInfo.nlink !== 1 || !isPrivateFileMode(destinationInfo.mode)) throw new SandboxTransferError("published export destination is not a private regular file");
      publicationIdentity = resourceIdentity(destination, "file", destinationInfo);
      copied = await readExactFile(destination, this.#maxBytes, this.#root);
      if (copied.length !== expected.byteLength || sha256Bytes(copied) !== expected.sha256) throw new SandboxTransferError("published export bytes do not match the guest-bound digest and length");
    } catch (error) {
      if (stagingIdentity) await removeTreeNoFollow(staging, stagingIdentity, this.#root).catch(() => undefined);
      throw error;
    }
    const manifest = makeManifest({ context, direction: "export", source: { logicalPath: sourcePath, side: "sandbox" }, destination: { logicalPath: `artifacts/sandbox/${context.runId}/${safeName}`, side: "host" }, bytes: copied!, expectedGit: expected.expectedGit });
    let retentionReference: ContractReference | undefined;
    if (this.#retention) {
      retentionReference = await this.#retention.put(context.runId, safeName, copied, manifest, signal);
      assertContractReference(retentionReference);
      await this.#retention.acknowledge(retentionReference, signal);
      await assertPublishedDestination(destination, publicationIdentity, expected, this.#maxBytes, this.#root);
    }
    await assertPublishedDestination(destination, publicationIdentity, expected, this.#maxBytes, this.#root);
    await this.#persistManifest(context, manifest);
    return { manifest, hostPath: destination, command, ...(retentionReference ? { retentionReference } : {}) };
  }

  async cleanupStaging(context: SandboxTransferContext): Promise<void> {
    assertContext(context);
    await assertPrivateRoot(this.#root);
    const root = path.join(this.#root, "sandbox-transfer", context.runId);
    const info = await lstat(root).catch(error => { if (isCode(error, "ENOENT")) return undefined; throw error; });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink() || info.nlink < 2 || (info.mode & 0o777) !== 0o700) throw new SandboxTransferError("transfer staging root was replaced");
    const rootHandle = await openNoFollowWithin(root, this.#root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      const entries = await readdir(`/proc/self/fd/${rootHandle.fd}`, { withFileTypes: true });
      for (const entry of entries) {
        const target = path.join(root, entry.name);
        if (/^manifest-(?:import|export)-[1-9][0-9]*\.json$/u.test(entry.name)) {
          const manifestInfo = await lstat(target);
          if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.nlink !== 1 || !isPrivateFileMode(manifestInfo.mode)) throw new SandboxTransferError("transfer manifest was replaced");
          const manifestBytes = await readExactFile(target, 4 * 1024 * 1024, this.#root);
          let manifest: unknown;
          try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)); } catch (error) { throw new SandboxTransferError(`transfer manifest is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`); }
          if (!manifestBytes.equals(canonicalBytes(manifest))) throw new SandboxTransferError("transfer manifest is not canonically serialized");
          const manifestMatch = /^manifest-(import|export)-([1-9][0-9]*)\.json$/u.exec(entry.name);
          if (!isRecord(manifest) || !manifestMatch || manifest["runId"] !== context.runId || manifest["sandboxName"] !== context.sandboxName || manifest["sandboxId"] !== context.sandboxId || manifest["specFingerprint"] !== context.specFingerprint || manifest["bootId"] !== context.bootId || manifest["transferGeneration"] !== Number(manifestMatch[2]) || (manifest["transferGeneration"] as number) < 1 || (manifest["transferGeneration"] as number) > context.transferGeneration || manifest["direction"] !== manifestMatch[1]) throw new SandboxTransferError("transfer manifest is bound to a different context");
          assertTransferSemantics(manifest as unknown as SandboxTransferManifestDocument);
          continue;
        }
        if (!/^(?:import|export)-[1-9][0-9]*-[A-Za-z0-9._-]{1,128}$/u.test(entry.name)) throw new SandboxTransferError("transfer staging contains an unexpected entry");
        const targetInfo = await lstat(target);
        if (!targetInfo.isFile() || targetInfo.isSymbolicLink() || targetInfo.nlink !== 1 || !isPrivateFileMode(targetInfo.mode)) throw new SandboxTransferError("transfer staging contains a non-private temporary");
        await removeTreeNoFollow(target, resourceIdentity(target, "file", targetInfo), root);
      }
      const remaining = await readdir(`/proc/self/fd/${rootHandle.fd}`, { withFileTypes: true });
      if (remaining.length === 0) {
        const rootInfo = await lstat(root);
        await removeTreeNoFollow(root, resourceIdentity(root, "directory", rootInfo), this.#root);
      }
    } finally { await rootHandle.close(); }
  }

  async #withReservation<T>(context: SandboxTransferContext, direction: "import" | "export", callerSignal: AbortSignal | undefined, action: (context: SandboxTransferContext, signal?: AbortSignal) => Promise<T>): Promise<T> {
    return this.#lifecycle.withTransfer(context.runId, direction, async (reservation: SandboxTransferReservation, operationSignal) => {
      assertReservationContext(context, reservation);
      if (this.#guest.binding.operationGeneration !== reservation.operationGeneration) throw new SandboxTransferError("transfer guest channel is bound to a different lifecycle operation generation");
      const reservedContext: SandboxTransferContext = { ...context, sandboxName: reservation.sandboxName, sandboxId: reservation.sandboxId, bootId: reservation.bootId, templateDigest: reservation.templateDigest, specFingerprint: reservation.specFingerprint, transferGeneration: reservation.transferGeneration };
      return action(reservedContext, operationSignal);
    }, callerSignal, context.transferGeneration);
  }

  async #requireSeed(runId: string, signal?: AbortSignal): Promise<RepositorySeedArtifact> {
    throwIfAborted(signal);
    if (!this.#seed) throw new SandboxTransferError(`repository seed provider is not configured for ${runId}`);
    const seed = await this.#seed.readSeed(runId, signal);
    if (!seed || typeof seed !== "object" || Array.isArray(seed) || (Object.keys(seed).sort().join("\0") !== "bytes\0logicalName" && Object.keys(seed).sort().join("\0") !== "bytes\0expectedGit\0logicalName") || typeof seed.logicalName !== "string" || !(seed.bytes instanceof Uint8Array)) throw new SandboxTransferError("repository seed provider returned malformed bytes");
    try { return structuredClone(seed); }
    catch (error) { throw new SandboxTransferError(`repository seed provider returned uncloneable bytes: ${error instanceof Error ? error.message : String(error)}`); }
  }
  async #persistManifest(context: SandboxTransferContext, manifest: SandboxTransferManifestDocument): Promise<void> {
    await assertPrivateRoot(this.#root);
    const transferRoot = path.join(this.#root, "sandbox-transfer");
    await ensurePrivateDirectory(transferRoot, this.#root);
    const directory = path.join(transferRoot, context.runId);
    await ensurePrivateDirectory(directory, this.#root);
    const target = path.join(directory, `manifest-${manifest.direction}-${manifest.transferGeneration}.json`);
    const bytes = canonicalBytes(manifest);
    try { await writeExclusiveFile(target, bytes, this.#root, 0o600); }
    catch (error) {
      const actual = await readExactFile(target, this.#maxBytes, this.#root).catch(() => { throw new SandboxTransferError(`transfer manifest could not be created: ${error instanceof Error ? error.message : String(error)}`); });
      if (!actual.equals(bytes)) throw new SandboxTransferError("transfer manifest identity was substituted");
      return;
    }
    const actual = await readExactFile(target, this.#maxBytes, this.#root);
    if (!actual.equals(bytes)) throw new SandboxTransferError("transfer manifest identity was substituted");
  }

  async #stage(context: SandboxTransferContext, direction: "import" | "export", name: string, bytes: Buffer, digest: string): Promise<string> {
    await assertPrivateRoot(this.#root);
    const transferRoot = path.join(this.#root, "sandbox-transfer");
    await ensurePrivateDirectory(transferRoot, this.#root);
    const directory = path.join(transferRoot, context.runId);
    await ensurePrivateDirectory(directory, this.#root);
    const target = path.join(directory, `${direction}-${context.transferGeneration}-${name}`);
    try { await writeExclusiveFile(target, bytes, this.#root, 0o600); }
    catch (error) {
      if (!isCode(error, "EEXIST")) throw new SandboxTransferError(`transfer staging identity could not be created: ${error instanceof Error ? error.message : String(error)}`);
      const existing = await readExactFile(target, this.#maxBytes, this.#root).catch(cause => { throw new SandboxTransferError(`existing transfer staging identity cannot be adopted: ${cause instanceof Error ? cause.message : String(cause)}`); });
      if (existing.length !== bytes.length || sha256Bytes(existing) !== digest) throw new SandboxTransferError("transfer staging identity was substituted");
    }
    const copied = await readExactFile(target, this.#maxBytes, this.#root);
    if (copied.length !== bytes.length || sha256Bytes(copied) !== digest) throw new SandboxTransferError("host transfer staging digest verification failed");
    return target;
  }
}

export function createSandboxTransferService(options: SandboxTransferServiceOptions): SandboxTransferService { return new SandboxTransferService(options); }

function makeManifest(input: { readonly context: SandboxTransferContext; readonly direction: "import" | "export"; readonly source: SandboxTransferManifestDocument["source"]; readonly destination: SandboxTransferManifestDocument["destination"]; readonly bytes: Uint8Array; readonly expectedGit?: SandboxTransferManifestDocument["expectedGit"] }): SandboxTransferManifestDocument {
  const withoutFingerprint = { schemaVersion: 1 as const, kind: "squire-sandbox-transfer-manifest" as const, direction: input.direction, runId: input.context.runId, sandboxName: input.context.sandboxName, sandboxId: input.context.sandboxId, specFingerprint: input.context.specFingerprint, bootId: input.context.bootId, source: input.source, destination: input.destination, byteLength: input.bytes.byteLength, sha256: sha256Bytes(input.bytes), ...(input.expectedGit ? { expectedGit: input.expectedGit } : {}), transferGeneration: input.context.transferGeneration, sourceVerified: true as const, destinationVerified: true as const, bridgeUsed: false as const, createdAt: new Date().toISOString() };
  const manifest: SandboxTransferManifestDocument = { ...withoutFingerprint, fingerprint: buildTransferFingerprint(withoutFingerprint) };
  assertTransferSemantics(manifest);
  return deepFreeze(manifest);
}

function assertContext(context: SandboxTransferContext): void { if (!context || typeof context !== "object" || Array.isArray(context) || Object.keys(context as unknown as Record<string, unknown>).sort().join("\0") !== ["bootId", "runId", "sandboxId", "sandboxName", "specFingerprint", "templateDigest", "transferGeneration"].sort().join("\0")) throw new SandboxTransferError("transfer context is not closed"); assertSandboxRunId(context.runId); assertSandboxName(context.sandboxName); if (context.sandboxName !== deriveSandboxName(context.runId)) throw new SandboxTransferError("transfer sandbox name is not derived from the run"); if (!context.sandboxId || context.sandboxId.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(context.sandboxId)) throw new SandboxTransferError("transfer sandbox ID is invalid"); assertDigestReference(context.templateDigest, "transfer template digest"); assertSha256(context.specFingerprint, "transfer spec fingerprint"); if (!context.bootId || context.bootId.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(context.bootId) || !Number.isSafeInteger(context.transferGeneration) || context.transferGeneration < 0 || context.transferGeneration > 2_147_483_647) throw new SandboxTransferError("transfer context is invalid"); }
function assertGuestContext(guest: GuestOperationClient, context: SandboxTransferContext, driver: SandboxDriver): void { const binding = guest.binding; const runtimeHelperDigest = driver.release.release.template.helperDigests.at(-1); if (!binding || !runtimeHelperDigest || binding.runId !== context.runId || binding.sandboxName !== context.sandboxName || binding.sandboxId !== context.sandboxId || binding.bootId !== context.bootId || binding.releaseId !== driver.release.release.releaseId || binding.helperDigest !== runtimeHelperDigest) throw new SandboxTransferError("transfer guest channel is bound to a different sandbox, run, boot, helper, or release"); }
function assertReservationContext(context: SandboxTransferContext, reservation: SandboxTransferReservation): void { if (!reservation || reservation.runId !== context.runId || reservation.direction !== "import" && reservation.direction !== "export" || reservation.sandboxName !== context.sandboxName || reservation.sandboxId !== context.sandboxId || reservation.bootId !== context.bootId || reservation.templateDigest !== context.templateDigest || reservation.specFingerprint !== context.specFingerprint || !Number.isSafeInteger(context.transferGeneration) || !Number.isSafeInteger(reservation.transferGeneration) || reservation.transferGeneration < 1 || context.transferGeneration !== reservation.transferGeneration - 1 || !Number.isSafeInteger(reservation.operationGeneration) || reservation.operationGeneration < 1) throw new SandboxTransferError("sandbox transfer reservation is bound to a different lifecycle identity"); }
function assertDriverContext(driver: SandboxDriver, context: SandboxTransferContext): void { if (!isResolvedSandboxRelease(driver.release)) throw new SandboxTransferError("transfer driver release is not resolver-verified"); const at = driver.release.release.template.reference.lastIndexOf("@"); const expectedReference = at > 0 ? `${driver.release.release.template.reference.slice(0, at)}@${context.templateDigest}` : ""; if (driver.release.release.template.digest !== context.templateDigest || driver.release.templateReference !== expectedReference || driver.release.release.template.reference !== expectedReference) throw new SandboxTransferError("transfer driver is bound to a different template identity"); }
function safeTransferName(name: string, prefix: string): string { if (typeof name !== "string" || name.length < 1 || name.length > 128 || !/^[A-Za-z0-9._-]+$/u.test(name) || name === "." || name === ".." || name.startsWith(".")) throw new SandboxTransferError(`${prefix} transfer name is unsafe`); return name; }
function assertExpectedGit(value: SandboxTransferManifestDocument["expectedGit"] | undefined, runId: string): void { if (value === undefined) return; if (!isRecord(value)) throw new SandboxTransferError("transfer Git binding is not closed"); const keys = Object.keys(value).sort().join("\0"); if (!["baseSha\0objectFormat", "baseSha\0bundle\0objectFormat", "baseSha\0objectFormat\0repository", "baseSha\0bundle\0objectFormat\0repository"].includes(keys)) throw new SandboxTransferError("transfer Git binding is not closed"); if (value.objectFormat !== "sha1" && value.objectFormat !== "sha256") throw new SandboxTransferError("transfer Git object format is invalid"); const length = value.objectFormat === "sha1" ? 40 : 64; if (typeof value.baseSha !== "string" || !new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value.baseSha)) throw new SandboxTransferError("transfer Git base identity is invalid"); if (value.repository !== undefined && value.repository !== "/ticket/git/repo.git") throw new SandboxTransferError("transfer Git repository identity is not fixed"); if (value.bundle !== undefined && (!value.bundle.startsWith(`artifacts/git/${runId}/`) || !new RegExp(`^[0-9a-f]{${length}}\\.bundle$`, "u").test(value.bundle.slice(`artifacts/git/${runId}/`.length)))) throw new SandboxTransferError("transfer Git bundle path is not bound to the run"); }
function boundedBytes(bytes: Uint8Array, max: number): Buffer { const result = Buffer.from(bytes); if (result.length === 0 || result.length > max) throw new SandboxTransferError("transfer bytes are outside the bounded range"); return result; }
async function readExactFile(target: string, max: number, root: string): Promise<Buffer> { const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !isPrivateFileMode(info.mode) || info.size > max) throw new SandboxTransferError("transfer staging target is not a bounded private regular file"); try { return await readExactNoFollow(target, root, max); } catch (error) { throw new SandboxTransferError(error instanceof Error ? error.message : String(error)); } }
async function assertPrivateRoot(target: string): Promise<void> {
  if (!path.isAbsolute(target) || target.endsWith(path.sep) || target.includes("\0") || path.resolve(target) !== target || path.parse(target).root === target) throw new SandboxTransferError("transfer staging root is not canonical");
  const root = path.parse(target).root; let current = root;
  for (const part of target.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const ancestor = await lstat(current).catch(error => { if (isCode(error, "ENOENT")) return undefined; throw error; });
    if (!ancestor || ancestor.isSymbolicLink() || !ancestor.isDirectory()) throw new SandboxTransferError("transfer staging root has an unsafe ancestor");
  }
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || info.nlink < 2 || (info.mode & 0o777) !== 0o700) throw new SandboxTransferError("transfer staging root is not a private directory");
}
async function pathKind(target: string): Promise<"missing" | "present"> { try { const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new SandboxTransferError("transfer destination is not a private regular file"); return "present"; } catch (error) { if (isCode(error, "ENOENT")) return "missing"; throw error; } }
function assertGuestProof(value: unknown, length: number, digest: string, expectedPath: string, generation: number): void { if (!value || typeof value !== "object" || Array.isArray(value)) throw new SandboxTransferError("guest transfer proof is malformed"); const record = value as Record<string, unknown>; if (Object.keys(record).sort().join("\0") !== ["bridgeUsed", "byteLength", "path", "sha256", "transferGeneration"].join("\0") || record["byteLength"] !== length || record["sha256"] !== digest || record["bridgeUsed"] !== false || record["path"] !== expectedPath || record["transferGeneration"] !== generation) throw new SandboxTransferError("guest transfer proof does not match the controller digest and operation"); }
function assertContractReference(value: unknown): asserts value is ContractReference { if (!isRecord(value) || Object.keys(value).sort().join("\0") !== ["path", "schemaId", "sha256"].join("\0") || typeof value["path"] !== "string" || !/^(?:artifacts|evidence)(?:\/[A-Za-z0-9._-]+)+$/u.test(value["path"]) || typeof value["sha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(value["sha256"]) || typeof value["schemaId"] !== "string" || value["schemaId"].length === 0 || value["schemaId"].length > 300 || /[\u0000-\u001f\u007f\r\n]/u.test(value["schemaId"])) throw new SandboxTransferError("retention store returned an invalid contract reference"); }
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T { if (!value || typeof value !== "object" || seen.has(value as object)) return value; seen.add(value as object); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen); return Object.freeze(value); }
function throwIfAborted(signal?: AbortSignal): void { if (signal?.aborted) throw new SandboxTransferError("sandbox transfer was aborted"); }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isCode(value: unknown, code: string): boolean { return isRecord(value) && value["code"] === code; }
function isPrivateFileMode(mode: number): boolean { return Number.isSafeInteger(mode) && (mode & 0o077) === 0 && (mode & 0o111) === 0 && (mode & 0o600) !== 0; }
async function assertPublishedDestination(target: string, expectedIdentity: ReturnType<typeof resourceIdentity> | undefined, expected: { readonly byteLength: number; readonly sha256: string }, maxBytes: number, root: string): Promise<void> {
  if (!expectedIdentity) throw new SandboxTransferError("published export identity was not captured");
  const info = await lstat(target).catch(error => { throw new SandboxTransferError(`published export destination disappeared: ${error instanceof Error ? error.message : String(error)}`); });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !isPrivateFileMode(info.mode)) throw new SandboxTransferError("published export destination identity changed");
  const current = resourceIdentity(target, "file", info);
  if (!sameResourceIdentity(current, expectedIdentity)) throw new SandboxTransferError("published export destination was replaced before publication");
  const bytes = await readExactFile(target, maxBytes, root);
  if (bytes.length !== expected.byteLength || sha256Bytes(bytes) !== expected.sha256) throw new SandboxTransferError("published export destination changed before publication");
}
