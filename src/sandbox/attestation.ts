import type { SandboxAttestationDocument, SandboxObservedIdentity, SandboxSpecDocument } from "./domain.js";
import { isResolvedSandboxRelease, type ResolvedSandboxRelease } from "./release-resolver.js";
import type { SbxObservedSandbox } from "./sbx-command.js";
import type { BridgeRecord } from "./bridge-manager.js";
import { assertAttestationSemantics, assertReleaseSemantics, assertSpecSemantics, buildAttestationFingerprint } from "./contracts.js";
import { GuestIsolationCanarySuite, type GuestIsolationObservation, type IsolationCanaryEvidence } from "./isolation-probes.js";
import { SandboxResourceVerifier, type CgroupResourceObservation } from "./resource-verifier.js";
import { validateNetworkAuditResult, type SandboxNetworkAuditResult } from "./network-audit.js";
import { assertDigestReference, assertReleaseId, assertSandboxName, assertSandboxRunId, assertSha256, canonicalJson, deriveBridgeIdentityReference, deriveBridgeName, deriveSandboxName, isSandboxEvidenceSchemaId, sha256Bytes } from "./identity.js";
import type { ContractReference } from "../control/domain.js";

export interface SandboxNetworkCanaryEvidence {
  readonly profileDigest: string;
  readonly allowedHttpsCorrelationDigest: string;
  readonly deniedProbeDigest: string;
  readonly hostObservation: ContractReference;
  /** Independently authenticated host result; guest curl output is never enough. */
  readonly audit: SandboxNetworkAuditResult;
}
export interface SandboxCredentialEvidence {
  readonly canaryHmacDigest: string;
  readonly canaryValues: readonly string[];
}
export interface MeasuredSandboxEvidence {
  readonly resources: CgroupResourceObservation;
  readonly isolation: GuestIsolationObservation;
  readonly network: SandboxNetworkCanaryEvidence;
  readonly credentials: SandboxCredentialEvidence;
}
export interface SandboxAttestationInput {
  readonly runId: string;
  readonly spec: SandboxSpecDocument;
  readonly release: ResolvedSandboxRelease;
  readonly observed: SbxObservedSandbox;
  readonly bridge: BridgeRecord;
  readonly creationGeneration: number;
  readonly evidence: MeasuredSandboxEvidence;
}
export interface SandboxAttestorPort { attest(input: SandboxAttestationInput, signal?: AbortSignal): Promise<SandboxAttestationDocument> }

export class SandboxAttestationError extends Error {
  constructor(message: string) { super(message); this.name = "SandboxAttestationError"; }
}

/** Converts measured guest and independent host observations into the closed
 * attestation contract. It has no "trusted" override and never treats a guest
 * claim as the independent host proof. */
export class MeasuredSandboxAttestor implements SandboxAttestorPort {
  readonly #resourceVerifier: SandboxResourceVerifier;
  readonly #isolation: GuestIsolationCanarySuite;
  constructor(options: { readonly resourceVerifier?: SandboxResourceVerifier; readonly isolationSuite?: GuestIsolationCanarySuite } = {}) { if (!options || typeof options !== "object" || Array.isArray(options) || options.resourceVerifier !== undefined && typeof options.resourceVerifier.verify !== "function" || options.isolationSuite !== undefined && typeof options.isolationSuite.verify !== "function") throw new SandboxAttestationError("sandbox attestor options are not closed"); this.#resourceVerifier = options.resourceVerifier ?? new SandboxResourceVerifier(); this.#isolation = options.isolationSuite ?? new GuestIsolationCanarySuite(); }
  async attest(input: SandboxAttestationInput, signal?: AbortSignal): Promise<SandboxAttestationDocument> {
    if (signal?.aborted) throw new SandboxAttestationError("sandbox attestation was aborted");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new SandboxAttestationError("sandbox attestation input is required");
    if (!isResolvedSandboxRelease(input.release)) throw new SandboxAttestationError("sandbox attestation requires a release verified by SandboxReleaseResolver");
    if (Object.keys(input).sort().join("\0") !== ["bridge", "creationGeneration", "evidence", "observed", "release", "runId", "spec"].sort().join("\0") || !input.spec || typeof input.spec !== "object" || Array.isArray(input.spec) || !input.observed || typeof input.observed !== "object" || Array.isArray(input.observed) || !input.bridge || typeof input.bridge !== "object" || Array.isArray(input.bridge) || !input.evidence || typeof input.evidence !== "object" || Array.isArray(input.evidence) || !isRecord(input.evidence.resources) || !isRecord(input.evidence.isolation) || !isRecord(input.evidence.network) || !isRecord(input.evidence.credentials)) throw new SandboxAttestationError("sandbox attestation input is incomplete");
    assertSandboxRunId(input.runId);
    try { assertSpecSemantics(input.spec); } catch (error) { throw new SandboxAttestationError(error instanceof Error ? error.message : "sandbox spec is invalid"); }
    assertSandboxName(input.spec.sandboxName); assertDigestReference(input.spec.template.digest); assertSha256(input.spec.fingerprint, "sandbox spec fingerprint"); assertReleaseId(input.release.release.releaseId); assertBridgeRecord(input.bridge, input.runId);
    try { assertReleaseSemantics(input.release.release); } catch (error) { throw new SandboxAttestationError(error instanceof Error ? error.message : "sandbox release is invalid"); }
    if (input.release.release.promotion.state !== "validated") throw new SandboxAttestationError("sandbox attestation cannot use a blocked release");
    if (input.release.templateReference !== input.release.release.template.reference || input.release.sbxExecutable !== input.release.release.sbxBinary.path || input.release.resourceTuple.cpus !== input.spec.resources.cpus || input.release.resourceTuple.memoryMiB !== input.spec.resources.memoryMiB || canonicalJson(input.release.resourceTuple.disk) !== canonicalJson(input.spec.resources.disk)) throw new SandboxAttestationError("sandbox attestation release/resource tuple is substituted");
    if (!isExactObservedSandbox(input.observed) || input.spec.runId !== input.runId || input.spec.sandboxName !== deriveSandboxName(input.runId) || input.spec.network.profileDigest !== input.release.release.networkProfileDigest || input.release.templateReference !== input.spec.template.reference || input.release.release.template.reference !== input.spec.template.reference || input.observed.name !== input.spec.sandboxName || input.observed.templateDigest !== input.spec.template.digest || input.observed.status !== "running" || !input.observed.bootId || !safeIdentity(input.observed.vmId) || input.bridge.runId !== input.runId || input.bridge.name !== input.spec.bridge.name || input.bridge.quotaBytes !== input.spec.bridge.quotaBytes || input.bridge.identity.linkCount < 2 || input.bridge.identity.mode !== 0o700 || !safeIdentity(input.bridge.identity.device) || !safeIdentity(input.bridge.identity.inode)) throw new SandboxAttestationError("sandbox attestation immutable identity does not match the accepted spec/release");
    const resources = this.#resourceVerifier.verify(input.spec.resources, input.evidence.resources);
    if (resources.observed.diskEnforcement === "unsupported") throw new SandboxAttestationError("sandbox attestation cannot mark an unsupported disk tuple ready");
    const canaries = this.#isolation.verify(input.evidence.isolation, { runId: input.runId });
    if (input.evidence.network.profileDigest !== input.spec.network.profileDigest || !isContractReference(input.evidence.network.hostObservation) || (!input.evidence.network.hostObservation.path.startsWith("artifacts/") && !input.evidence.network.hostObservation.path.startsWith("evidence/"))) throw new SandboxAttestationError("network canary evidence is not bound to the accepted host policy");
    try { validateNetworkAuditResult(input.evidence.network.audit); } catch (error) { throw new SandboxAttestationError(error instanceof Error ? error.message : "host network audit evidence is invalid"); }
    const audit = input.evidence.network.audit;
    if (audit.request.runId !== input.runId || audit.request.sandboxName !== input.spec.sandboxName || audit.request.profileDigest !== input.spec.network.profileDigest || audit.request.mode !== input.spec.network.mode || canonicalJson(audit.request.allowedHosts) !== canonicalJson(input.spec.network.allowedHosts) || canonicalJson(audit.hostObservation) !== canonicalJson(input.evidence.network.hostObservation) || input.evidence.network.allowedHttpsCorrelationDigest !== sha256Bytes(Buffer.from(canonicalJson(audit.allowedHttps), "utf8")) || input.evidence.network.deniedProbeDigest !== sha256Bytes(Buffer.from(canonicalJson(audit.denied), "utf8"))) throw new SandboxAttestationError("host network audit evidence is not bound to the accepted run policy and canaries");
    assertSha256(input.evidence.network.allowedHttpsCorrelationDigest, "allowed network correlation digest"); assertSha256(input.evidence.network.deniedProbeDigest, "denied network probe digest"); assertSha256(input.evidence.credentials.canaryHmacDigest, "credential canary HMAC digest");
    if (!Array.isArray(input.evidence.credentials.canaryValues) || input.evidence.credentials.canaryValues.length === 0 || input.evidence.credentials.canaryValues.some(value => typeof value !== "string" || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(value))) throw new SandboxAttestationError("credential canary evidence is malformed");
    this.#resourceVerifier.assertProductionSupported(resources);
    const observed: SandboxObservedIdentity = { sandboxId: input.observed.id, sandboxName: input.observed.name, vmId: input.observed.vmId, templateDigest: input.observed.templateDigest, bridgeName: input.bridge.name, bridgeIdentity: { device: input.bridge.identity.device, inode: input.bridge.identity.inode, mode: input.bridge.identity.mode & 0o777, linkCount: input.bridge.identity.linkCount, quotaBytes: input.bridge.quotaBytes } };
    const network: SandboxAttestationDocument["network"] = { profileDigest: input.evidence.network.profileDigest, allowedHttpsCorrelationDigest: input.evidence.network.allowedHttpsCorrelationDigest, deniedProbeDigest: input.evidence.network.deniedProbeDigest, hostObservation: { path: input.evidence.network.hostObservation.path, sha256: input.evidence.network.hostObservation.sha256, schemaId: input.evidence.network.hostObservation.schemaId } };
    const withoutFingerprint = {
      schemaVersion: 1 as const, kind: "squire-sandbox-attestation" as const, runId: input.runId, sandboxName: input.spec.sandboxName, specFingerprint: input.spec.fingerprint, releaseId: input.release.release.releaseId, templateDigest: input.spec.template.digest, observed, bootId: input.observed.bootId,
      resources: { requested: structuredClone(input.spec.resources), cpuOnline: input.evidence.resources.cpuOnline, memoryMaxBytes: input.evidence.resources.memoryMaxBytes, disk: { enforcement: input.evidence.resources.diskEnforcement, statfsBytes: input.evidence.resources.ticketStatfsBytes, ...(resources.diskBoundBytes !== undefined ? { quotaBytes: resources.diskBoundBytes } : {}), enospcObserved: input.evidence.resources.enospcObserved, proofDigest: resources.proofDigest } },
      principals: { controllerUid: input.evidence.isolation.principal.controllerUid, controllerGid: input.evidence.isolation.principal.controllerGid, agentUid: input.evidence.isolation.principal.agentUid, agentGid: input.evidence.isolation.principal.agentGid, distinct: true as const, sudoAbsent: true as const, rootfulDockerSocketAbsent: true as const, supervisorSocketProtected: true as const },
      mounts: { namespace: input.evidence.isolation.mount.namespace, ticketDevice: input.evidence.isolation.mount.ticketDevice, ticketInode: input.evidence.isolation.mount.ticketInode, mountInfoDigest: sha256Bytes(Buffer.from(input.evidence.isolation.mount.mountInfo, "utf8")), forbiddenMountsAbsent: true as const, nestedMountsAbsent: true as const },
      sockets: { rootlessDocker: input.evidence.isolation.sockets.rootlessDockerSocket, controllerSocketsAbsent: true as const, hostSocketsAbsent: true as const },
      network,
      credentials: { effectiveEnvironmentDigest: sha256Bytes(Buffer.from(canonicalJson(input.evidence.isolation.environment), "utf8")), forbiddenNamesAbsent: true as const, canaryHmacDigest: input.evidence.credentials.canaryHmacDigest },
      canaries: { principalDigest: canaries.principalDigest, mountDigest: canaries.mountDigest, dockerDigest: canaries.dockerDigest, persistenceDigest: canaries.persistenceDigest, isolationDigest: canaries.isolationDigest },
      creationGeneration: input.creationGeneration, attestedAt: new Date().toISOString(),
    };
    const attestation: SandboxAttestationDocument = { ...withoutFingerprint, fingerprint: buildAttestationFingerprint(withoutFingerprint) };
    assertAttestationSemantics(attestation);
    return deepFreeze(attestation);
  }
}

function assertBridgeRecord(value: BridgeRecord, runId: string): void {
  if (!isRecord(value) || Object.keys(value).sort().join("\0") !== ["createdAt", "identity", "identityReference", "kind", "logicalPath", "name", "path", "quota", "quotaBytes", "runId", "schemaVersion"].sort().join("\0") || value.schemaVersion !== 1 || value.kind !== "squire-sandbox-bridge" || value.runId !== runId || value.name !== deriveBridgeName(runId) || value.logicalPath !== "/ticket/bridge" || value.identityReference !== deriveBridgeIdentityReference(runId, value.name) || typeof value.path !== "string" || !isCanonicalHostPath(value.path) || !isRecord(value.identity) || !isRecord(value.quota) || !Number.isSafeInteger(value.quotaBytes) || value.quotaBytes < 4_096 || value.quotaBytes > 107_374_182_400 || !canonicalDate(value.createdAt)) throw new SandboxAttestationError("sandbox bridge identity record is malformed");
  const identity = value.identity; const quota = value.quota;
  if (Object.keys(identity).sort().join("\0") !== ["device", "inode", "kind", "linkCount", "mode", "path"].sort().join("\0") || identity.kind !== "directory" || identity.path !== value.path || !safeIdentity(identity.device) || !safeIdentity(identity.inode) || identity.mode !== 0o700 || !Number.isSafeInteger(identity.linkCount) || identity.linkCount < 2) throw new SandboxAttestationError("sandbox bridge physical identity is malformed");
  if (Object.keys(quota).sort().join("\0") !== ["digest", "enforcement", "observedAt", "path", "quotaBytes"].sort().join("\0") || quota.path !== value.path || quota.quotaBytes !== value.quotaBytes || !["project-quota", "filesystem-quota"].includes(quota.enforcement as string) || typeof quota.digest !== "string" || !/^[0-9a-f]{64}$/u.test(quota.digest) || !canonicalDate(quota.observedAt) || sha256Bytes(Buffer.from(canonicalJson({ path: quota.path, quotaBytes: quota.quotaBytes, enforcement: quota.enforcement, observedAt: quota.observedAt }), "utf8")) !== quota.digest) throw new SandboxAttestationError("sandbox bridge quota identity is malformed");
}
function isContractReference(value: unknown): value is ContractReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).sort().join("\0") === ["path", "schemaId", "sha256"].sort().join("\0") && typeof record["path"] === "string" && record["path"].length <= 1_024 && /^(?:artifacts|evidence)(?:\/[A-Za-z0-9._-]+)+$/u.test(record["path"]) && !record["path"].split("/").some(part => part === "." || part === "..") && typeof record["sha256"] === "string" && /^[0-9a-f]{64}$/u.test(record["sha256"]) && isSandboxEvidenceSchemaId(record["schemaId"], "host evidence");
}
function isExactObservedSandbox(value: unknown): value is SbxObservedSandbox {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.hasOwn(record, "bootId") ? ["bootId", "id", "name", "status", "templateDigest", "vmId"] : ["id", "name", "status", "templateDigest", "vmId"];
  return Object.keys(record).sort().join("\0") === keys.sort().join("\0") && typeof record["name"] === "string" && typeof record["id"] === "string" && typeof record["vmId"] === "string" && typeof record["templateDigest"] === "string" && typeof record["status"] === "string" && ["created", "running", "stopped", "unknown"].includes(record["status"] as string) && safeIdentity(record["name"]) && safeIdentity(record["id"]) && safeIdentity(record["vmId"]) && assertDigestReferenceSafe(record["templateDigest"]) && (record["bootId"] === undefined || safeIdentity(record["bootId"]));
}
function assertDigestReferenceSafe(value: unknown): boolean { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value); }
function isCanonicalHostPath(value: unknown): value is string { return typeof value === "string" && value.length > 1 && value.length <= 4096 && value.startsWith("/") && value === value.replace(/\/+/gu, "/") && !value.endsWith("/") && !value.includes("\\") && !/[\u0000-\u001f\u007f\r\n]/u.test(value) && !value.split("/").some(part => part === "." || part === ".."); }
function canonicalDate(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function safeIdentity(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f\r\n]/u.test(value); }
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T { if (!value || typeof value !== "object" || seen.has(value as object)) return value; seen.add(value as object); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen); return Object.freeze(value); }
