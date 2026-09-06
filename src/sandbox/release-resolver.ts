import { createHmac, createPublicKey, timingSafeEqual, verify as verifySignatureBytes } from "node:crypto";
import type { RuntimeResolution } from "../control/domain.js";
import { REQUIRED_LLM_WIKI_RUNTIME_VERSION, REQUIRED_PI_RUNTIME_VERSION, SandboxContractError, assertReleaseSemantics } from "./contracts.js";
import { assertArchitecture, assertDigestReference, assertPlatform, assertSandboxRunId, assertTemplateReference, assertVersionRange, canonicalJson, sha256Bytes } from "./identity.js";
import type { SandboxReleaseManifestDocument, SandboxResourceSpec, SandboxResourceTuple } from "./domain.js";
import path from "node:path";

export interface SandboxReleaseSelection {
  readonly templateName: string;
  readonly templateDigest: string;
  readonly platform?: string;
  readonly architecture?: string;
  readonly resources?: SandboxResourceSpec;
  readonly networkProfileDigest?: string;
  readonly runtime?: RuntimeResolution;
}

export interface SandboxBinaryObservation {
  readonly path: string;
  readonly versionOutput: string;
  readonly sha256: string;
  readonly helpDigest: string;
}

export interface SandboxReleaseResolverOptions {
  readonly releases: readonly SandboxReleaseManifestDocument[];
  readonly platform?: string;
  readonly architecture?: string;
  /** A trusted host verifier for the release promotion signature. */
  readonly verifySignature?: (release: SandboxReleaseManifestDocument) => boolean | Promise<boolean>;
  /** Exact host observation of the executable and help surface. */
  readonly observeBinary?: (release: SandboxReleaseManifestDocument) => SandboxBinaryObservation | Promise<SandboxBinaryObservation>;
  /** Optional explicit key for the built-in HMAC test/host verifier. */
  readonly hmacKey?: Uint8Array;
  /** PEM/DER Ed25519 public key for built-in promotion verification. */
  readonly ed25519PublicKey?: string | Uint8Array;
}

export const SANDBOX_RELEASE_PROOF: unique symbol = Symbol("squire-resolved-sandbox-release");

export interface ResolvedSandboxRelease {
  readonly release: SandboxReleaseManifestDocument;
  readonly templateReference: string;
  readonly sbxExecutable: string;
  readonly resourceTuple: SandboxResourceTuple;
  /** Non-forgeable-in-JSON proof that the resolver verified promotion/signature. */
  readonly [SANDBOX_RELEASE_PROOF]: true;
}

const RESOLUTION_TOKEN = Symbol("sandbox-release-resolver-private-token");
const RESOLVED_RELEASES = new WeakSet<object>();
function markResolvedSandboxRelease(value: Omit<ResolvedSandboxRelease, typeof SANDBOX_RELEASE_PROOF>, token: symbol): ResolvedSandboxRelease {
  if (token !== RESOLUTION_TOKEN) throw new SandboxContractError("sandbox release proof can only be issued by SandboxReleaseResolver");
  const result = { ...value } as Omit<ResolvedSandboxRelease, typeof SANDBOX_RELEASE_PROOF> & Partial<Pick<ResolvedSandboxRelease, typeof SANDBOX_RELEASE_PROOF>>;
  Object.defineProperty(result, SANDBOX_RELEASE_PROOF, { value: true, enumerable: false, configurable: false, writable: false });
  const frozen = deepFreeze(result) as ResolvedSandboxRelease;
  RESOLVED_RELEASES.add(frozen as object);
  return frozen;
}

export function isResolvedSandboxRelease(value: unknown): value is ResolvedSandboxRelease {
  return Boolean(value && typeof value === "object" && RESOLVED_RELEASES.has(value) && (value as Record<PropertyKey, unknown>)[SANDBOX_RELEASE_PROOF] === true);
}

/** Resolves only promoted, digest-pinned releases. It deliberately does not
 * resolve tags, local image IDs, or a caller supplied "trusted" boolean. */
export class SandboxReleaseResolver {
  readonly #options: SandboxReleaseResolverOptions;
  readonly #releases: readonly SandboxReleaseManifestDocument[];

  constructor(options: SandboxReleaseResolverOptions | readonly SandboxReleaseManifestDocument[]) {
    if (!options || (typeof options !== "object")) throw new SandboxContractError("sandbox release resolver options are required");
    const supplied = Array.isArray(options) ? { releases: Array.from(options) as SandboxReleaseManifestDocument[] } : options as SandboxReleaseResolverOptions;
    if (!supplied || !Array.isArray(supplied.releases) || supplied.releases.length === 0 || supplied.releases.length > 64 || (supplied.verifySignature !== undefined && typeof supplied.verifySignature !== "function") || typeof supplied.observeBinary !== "function" || (supplied.hmacKey !== undefined && !(supplied.hmacKey instanceof Uint8Array)) || (supplied.ed25519PublicKey !== undefined && typeof supplied.ed25519PublicKey !== "string" && !(supplied.ed25519PublicKey instanceof Uint8Array))) throw new SandboxContractError("sandbox release resolver requires a trusted exact binary observation port");
    this.#options = supplied;
    if (!this.#options || !Array.isArray(this.#options.releases) || this.#options.releases.length === 0 || this.#options.releases.length > 64) throw new SandboxContractError("at least one bounded promoted sandbox release is required");
    if (this.#options.platform !== undefined) assertPlatform(this.#options.platform);
    if (this.#options.architecture !== undefined) assertArchitecture(this.#options.architecture);
    try {
      this.#releases = Object.freeze(this.#options.releases.map(release => deepFreeze(structuredClone(release))));
      this.#options = Object.freeze({ ...this.#options, releases: this.#releases, ...(this.#options.hmacKey ? { hmacKey: new Uint8Array(this.#options.hmacKey) } : {}), ...(this.#options.ed25519PublicKey instanceof Uint8Array ? { ed25519PublicKey: new Uint8Array(this.#options.ed25519PublicKey) } : {}) });
    }
    catch (error) { throw new SandboxContractError(`sandbox release manifest cannot be isolated: ${error instanceof Error ? error.message : String(error)}`); }
  }

  async resolve(selection: SandboxReleaseSelection): Promise<ResolvedSandboxRelease> {
    if (!selection || typeof selection !== "object" || Array.isArray(selection) || Object.keys(selection as unknown as Record<string, unknown>).some(key => !["architecture", "networkProfileDigest", "platform", "resources", "runtime", "templateDigest", "templateName"].includes(key))) throw new SandboxContractError("sandbox release selection is not closed");
    const templateReference = canonicalTemplateReference(selection.templateName, selection.templateDigest);
    const platform = selection.platform ?? this.#options.platform;
    const architecture = selection.architecture ?? this.#options.architecture;
    if (!platform || !architecture) throw new SandboxContractError("sandbox release platform and architecture are required");
    assertPlatform(platform); assertArchitecture(architecture);
    const candidates = this.#releases.filter(release => release.platform === platform && release.architecture === architecture && release.template.reference === templateReference);
    if (candidates.length !== 1) throw new SandboxContractError(candidates.length === 0 ? "no promoted release matches the exact sandbox template/platform identity" : "multiple promoted releases match the exact sandbox identity");
    const release = candidates[0]!;
    assertReleaseSemantics(release);
    if (release.promotion.state !== "validated") throw new SandboxContractError("sandbox release is blocked until host conformance and promotion validation complete");
    await this.#verifySignature(release);
    if (selection.runtime) assertRuntimeCompatibility(release, selection.runtime);
    const tuple = selectResourceTuple(release.supportedResources, selection.resources);
    if (selection.networkProfileDigest !== undefined && selection.networkProfileDigest !== release.networkProfileDigest) throw new SandboxContractError("requested network policy is not the release-pinned policy");
    const observeBinary = this.#options.observeBinary;
    if (!observeBinary) throw new SandboxContractError("trusted exact binary observation port is unavailable");
    const observed = await observeBinary(release);
    assertBinaryObservation(release, observed);
    return markResolvedSandboxRelease({ release, templateReference, sbxExecutable: release.sbxBinary.path, resourceTuple: tuple }, RESOLUTION_TOKEN);
  }

  /** Synchronous identity check for a release already verified by resolve(). */
  assertResolved(value: ResolvedSandboxRelease, selection: SandboxReleaseSelection): void {
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw new SandboxContractError("sandbox release selection is required");
    const expected = canonicalTemplateReference(selection.templateName, selection.templateDigest);
    if (!isResolvedSandboxRelease(value)) throw new SandboxContractError("resolved sandbox release lacks resolver proof");
    assertReleaseSemantics(value.release);
    if (value.templateReference !== expected || value.release.template.reference !== expected || value.release.promotion.state !== "validated" || value.release.sbxVersion !== "0.39.0" || value.sbxExecutable !== value.release.sbxBinary.path || value.resourceTuple.tupleId.length === 0 || !value.release.supportedResources.some(tuple => tuple.tupleId === value.resourceTuple.tupleId && canonicalJson(tuple) === canonicalJson(value.resourceTuple)) || !sameResourceTuple(value.resourceTuple, selection.resources ?? value.resourceTuple)) throw new SandboxContractError("resolved release identity was substituted");
    if (selection.platform && value.release.platform !== selection.platform) throw new SandboxContractError("resolved release platform changed");
    if (selection.architecture && value.release.architecture !== selection.architecture) throw new SandboxContractError("resolved release architecture changed");
    if (selection.networkProfileDigest && value.release.networkProfileDigest !== selection.networkProfileDigest) throw new SandboxContractError("resolved release network identity changed");
    if (selection.runtime) assertRuntimeCompatibility(value.release, selection.runtime);
  }

  async #verifySignature(release: SandboxReleaseManifestDocument): Promise<void> {
    if (this.#options.verifySignature) {
      if (!await this.#options.verifySignature(release)) throw new SandboxContractError("sandbox release promotion signature verification failed");
      return;
    }
    if (release.promotion.algorithm === "sha256-hmac" && this.#options.hmacKey) {
      if (this.#options.hmacKey.length < 16 || !verifyHmacSignature(release, this.#options.hmacKey)) throw new SandboxContractError("sandbox release HMAC signature verification failed");
      return;
    }
    if (release.promotion.algorithm === "ed25519" && this.#options.ed25519PublicKey) {
      if (!verifyEd25519Signature(release, this.#options.ed25519PublicKey)) throw new SandboxContractError("sandbox release Ed25519 signature verification failed");
      return;
    }
    throw new SandboxContractError("a cryptographic release signature verifier is required before create");
  }
}

export function canonicalTemplateReference(name: string, digest: string): string {
  if (typeof name !== "string" || name.length === 0 || name.includes("@") || /[\u0000-\u001f\u007f\s]/u.test(name)) throw new SandboxContractError("sandbox template name is unsafe");
  assertDigestReference(digest, "sandbox template digest");
  const reference = `${name}@${digest}`;
  assertTemplateReference(reference);
  return reference;
}

export function selectResourceTuple(tuples: readonly SandboxResourceTuple[], requested?: SandboxResourceSpec): SandboxResourceTuple {
  if (!Array.isArray(tuples) || tuples.length === 0 || tuples.length > 64) throw new SandboxContractError("release resource tuple inventory is invalid");
  if (!requested) {
    if (tuples.length !== 1) throw new SandboxContractError("resource tuple must be selected explicitly when a release has multiple supported tuples");
    return tuples[0]!;
  }
  const matching = tuples.filter(tuple => sameResourceTuple(tuple, requested));
  if (matching.length !== 1) throw new SandboxContractError("requested resource tuple has no unique externally-proven release match");
  return matching[0]!;
}

export function sameResourceTuple(left: SandboxResourceSpec, right: SandboxResourceSpec): boolean {
  if (!left || typeof left !== "object" || Array.isArray(left) || !right || typeof right !== "object" || Array.isArray(right) || !left.disk || typeof left.disk !== "object" || !right.disk || typeof right.disk !== "object") return false;
  return canonicalJson({ cpus: left.cpus, memoryMiB: left.memoryMiB, disk: left.disk }) === canonicalJson({ cpus: right.cpus, memoryMiB: right.memoryMiB, disk: right.disk });
}

export function assertBinaryObservation(release: SandboxReleaseManifestDocument, observed: SandboxBinaryObservation): void {
  assertReleaseSemantics(release);
  if (!observed || typeof observed !== "object" || Array.isArray(observed) || Object.keys(observed as unknown as Record<string, unknown>).sort().join("\0") !== "helpDigest\0path\0sha256\0versionOutput" || typeof observed.path !== "string" || typeof observed.versionOutput !== "string" || typeof observed.sha256 !== "string" || typeof observed.helpDigest !== "string" || observed.versionOutput.length === 0 || observed.versionOutput.length > 64 * 1024 || observed.helpDigest.length !== 64 || !/^[0-9a-f]{64}$/u.test(observed.helpDigest) || observed.sha256.length !== 64 || !/^[0-9a-f]{64}$/u.test(observed.sha256) || !isCanonicalHostPath(observed.path) || observed.path !== release.sbxBinary.path || observed.versionOutput !== release.sbxBinary.versionOutput || observed.sha256 !== release.sbxBinary.sha256 || observed.helpDigest !== release.sbxBinary.helpDigest) throw new SandboxContractError("sbx executable/version/help identity differs from promoted release");
}

export function assertRuntimeCompatibility(release: SandboxReleaseManifestDocument, runtime: RuntimeResolution): void {
  assertRuntimeShape(runtime);
  assertVersionRange(runtime.pi.version, "resolved Pi version");
  assertVersionRange(runtime.llmWiki.version, "resolved pi-llm-wiki version");
  if (runtime.pi.version !== REQUIRED_PI_RUNTIME_VERSION || runtime.llmWiki.version !== REQUIRED_LLM_WIKI_RUNTIME_VERSION) throw new SandboxContractError(`run runtime must resolve Pi ${REQUIRED_PI_RUNTIME_VERSION} and pi-llm-wiki ${REQUIRED_LLM_WIKI_RUNTIME_VERSION} exactly`);
  if (!versionInRange(runtime.pi.version, release.runtimeCompatibility.pi.minimum, release.runtimeCompatibility.pi.maximum)) throw new SandboxContractError(`resolved Pi ${runtime.pi.version} is outside the promoted release compatibility range`);
  if (!versionInRange(runtime.llmWiki.version, release.runtimeCompatibility.llmWiki.minimum, release.runtimeCompatibility.llmWiki.maximum)) throw new SandboxContractError(`resolved pi-llm-wiki ${runtime.llmWiki.version} is outside the promoted release compatibility range`);
}

export function versionInRange(value: string, minimum: string, maximum: string): boolean {
  return compareVersions(value, minimum) >= 0 && compareVersions(value, maximum) <= 0;
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => {
    const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
    if (!match) throw new SandboxContractError("runtime version is not semantic version data");
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const a = parse(left); const b = parse(right);
  for (let index = 0; index < 3; index += 1) if (a[index]! !== b[index]!) return a[index]! - b[index]!;
  return 0;
}

export function releaseSignaturePayload(release: SandboxReleaseManifestDocument): string {
  const promotion = { ...release.promotion, signature: "" };
  return canonicalJson({ ...release, promotion });
}

export function verifyHmacSignature(release: SandboxReleaseManifestDocument, key: Uint8Array): boolean {
  if (release.promotion.algorithm !== "sha256-hmac" || !(key instanceof Uint8Array) || key.length < 16 || !/^[0-9a-f]{64}$/u.test(release.promotion.signature)) return false;
  const expected = createHmac("sha256", key).update(releaseSignaturePayload(release), "utf8").digest("hex");
  const actual = Buffer.from(release.promotion.signature, "hex");
  const desired = Buffer.from(expected, "hex");
  return actual.length === desired.length && timingSafeEqual(actual, desired);
}

export function verifyEd25519Signature(release: SandboxReleaseManifestDocument, publicKey: string | Uint8Array): boolean {
  if (release.promotion.algorithm !== "ed25519" || typeof publicKey !== "string" && !(publicKey instanceof Uint8Array)) return false;
  const signature = decodeSignature(release.promotion.signature);
  if (!signature) return false;
  try {
    const key = createPublicKey(typeof publicKey === "string" ? publicKey : Buffer.from(publicKey));
    return verifySignatureBytes(null, Buffer.from(releaseSignaturePayload(release), "utf8"), key, signature);
  } catch { return false; }
}

export function digestReleaseIdentity(release: SandboxReleaseManifestDocument): string {
  return sha256Bytes(Buffer.from(canonicalJson(release), "utf8"));
}

function assertRuntimeShape(runtime: RuntimeResolution): void {
  if (!isRecord(runtime) || Object.keys(runtime).some(key => !["llmWiki", "modelCapabilities", "pi", "resolvedAt", "runId", "schemaVersion"].includes(key)) || !Object.hasOwn(runtime, "schemaVersion") || !Object.hasOwn(runtime, "runId") || !Object.hasOwn(runtime, "pi") || !Object.hasOwn(runtime, "llmWiki") || !Object.hasOwn(runtime, "resolvedAt") || runtime.schemaVersion !== 1 || typeof runtime.runId !== "string" || runtime.runId.length === 0 || runtime.runId.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(runtime.runId) || !isRecord(runtime.pi) || !isRecord(runtime.llmWiki) || !hasExactKeys(runtime.pi as unknown as Record<string, unknown>, ["executable", "installationId", "version"]) || (Object.keys(runtime.llmWiki).sort().join("\0") !== "installationId\0root\0version" && Object.keys(runtime.llmWiki).sort().join("\0") !== "installationId\0version") || typeof runtime.pi.version !== "string" || typeof runtime.pi.installationId !== "string" || typeof runtime.pi.executable !== "string" || typeof runtime.llmWiki.version !== "string" || typeof runtime.llmWiki.installationId !== "string" || (runtime.llmWiki.root !== undefined && typeof runtime.llmWiki.root !== "string") || !canonicalDate(runtime.resolvedAt)) throw new SandboxContractError("resolved runtime identity is not closed");
  assertSandboxRunId(runtime.runId);
  if (!isCanonicalHostPath(runtime.pi.executable) || !runtime.pi.executable.startsWith("/ticket/runtime/") || runtime.llmWiki.root !== undefined && (!isCanonicalHostPath(runtime.llmWiki.root) || !runtime.llmWiki.root.startsWith("/ticket/runtime/"))) throw new SandboxContractError("resolved runtime executable or root is outside the fixed runtime root");
  for (const identity of [runtime.pi.installationId, runtime.pi.executable, runtime.llmWiki.installationId, ...(runtime.llmWiki.root ? [runtime.llmWiki.root] : [])]) if (identity.length === 0 || identity.length > 4096 || /[\u0000-\u001f\u007f\r\n]/u.test(identity)) throw new SandboxContractError("resolved runtime identity is unsafe");
  if (runtime.modelCapabilities !== undefined) {
    if (!Array.isArray(runtime.modelCapabilities) || runtime.modelCapabilities.length > 128 || runtime.modelCapabilities.some(capability => !isRecord(capability) || !hasExactKeys(capability, ["model", "piInstallationId", "provider", "reasoningCapable", "wikiInstallationId"]) || typeof capability["model"] !== "string" || typeof capability["provider"] !== "string" || typeof capability["piInstallationId"] !== "string" || typeof capability["wikiInstallationId"] !== "string" || typeof capability["reasoningCapable"] !== "boolean" || (capability["model"] as string).length === 0 || (capability["model"] as string).length > 512 || (capability["provider"] as string).length === 0 || (capability["provider"] as string).length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(capability["model"] as string) || /[\u0000-\u001f\u007f\r\n]/u.test(capability["provider"] as string) || (capability["piInstallationId"] as string).length === 0 || (capability["piInstallationId"] as string).length > 4096 || (capability["wikiInstallationId"] as string).length === 0 || (capability["wikiInstallationId"] as string).length > 4096 || capability["piInstallationId"] !== runtime.pi.installationId || capability["wikiInstallationId"] !== runtime.llmWiki.installationId)) throw new SandboxContractError("resolved runtime model capability identity is invalid");
  }
}
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function canonicalDate(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function decodeSignature(value: string): Buffer | undefined {
  if (/^[0-9a-f]{128}$/u.test(value)) return Buffer.from(value, "hex");
  if (!/^[A-Za-z0-9+/]{86}==$/u.test(value) && !/^[A-Za-z0-9_-]{86}==$/u.test(value)) return undefined;
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const decoded = Buffer.from(normalized, "base64");
  return decoded.length === 64 ? decoded : undefined;
}

function isCanonicalHostPath(value: unknown): value is string {
  return typeof value === "string" && value.length >= 2 && value.length <= 4_096 && path.isAbsolute(value) && path.resolve(value) === value && value !== path.parse(value).root && !value.endsWith(path.sep) && !value.includes("//") && !value.includes("\\") && !value.split(path.sep).some(part => part === "." || part === "..") && !/[\u0000-\u001f\u007f\r\n]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function deepFreeze<T>(value: T, seen = new WeakSet<object>): T {
  if (!value || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}
