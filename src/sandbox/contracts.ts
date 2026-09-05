import { readFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020Import, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { ContractReference } from "../control/domain.js";
import {
  assertArchitecture,
  assertBridgeName,
  isSafeSandboxNetworkHost,
  isSandboxEvidenceSchemaId,
  assertCanonicalSandboxPath,
  assertDigestReference,
  assertDiskBudget,
  assertPlatform,
  assertReleaseId,
  assertSandboxName,
  assertSandboxRunId,
  assertSha256,
  assertTemplateReference,
  canonicalBytes,
  canonicalJson,
  deriveBridgeIdentityReference,
  deriveBridgeName,
  deriveSandboxName,
  fingerprintWithoutField,
  sameContractReference,
  SHA256_PATTERN,
  sha256Bytes,
} from "./identity.js";
import type {
  SandboxAttestationDocument,
  SandboxBridgeSpec,
  SandboxDiskBudget,
  SandboxNetworkSpec,
  SandboxReleaseManifestDocument,
  SandboxResourceSpec,
  SandboxResourceTuple,
  SandboxSpecDocument,
  SandboxTransferManifestDocument,
} from "./domain.js";

export const SANDBOX_SCHEMA_NAMES = ["sandbox-spec", "sandbox-release-manifest", "sandbox-attestation", "sandbox-transfer-manifest"] as const;
export type SandboxSchemaName = (typeof SANDBOX_SCHEMA_NAMES)[number];
export type SandboxSchemaId = `urn:squire:sandbox:v1:${SandboxSchemaName}`;
export const SANDBOX_SCHEMA_IDS = new Set<SandboxSchemaId>(SANDBOX_SCHEMA_NAMES.map(name => `urn:squire:sandbox:v1:${name}` as SandboxSchemaId));

export class SandboxContractError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxContractError";
  }
}

export interface ValidatedSandboxDocument<T> {
  readonly document: T;
  readonly bytes?: Buffer;
  readonly schemaId: SandboxSchemaId;
}

export class SandboxContractValidator {
  readonly #validators: Map<SandboxSchemaId, ValidateFunction>;
  private constructor(validators: Map<SandboxSchemaId, ValidateFunction>) {
    this.#validators = validators;
  }

  static async create(schemaDir = path.resolve("contracts/sandbox/v1")): Promise<SandboxContractValidator> {
    type AjvLike = { addSchema(schema: unknown): unknown; getSchema(id: string): ValidateFunction | undefined };
    const Ajv2020 = Ajv2020Import as unknown as new (options: Record<string, unknown>) => AjvLike;
    const addFormats = addFormatsImport as unknown as (ajv: AjvLike) => AjvLike;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    for (const name of SANDBOX_SCHEMA_NAMES) ajv.addSchema(JSON.parse(await readFile(path.join(schemaDir, `${name}.schema.json`), "utf8")));
    const validators = new Map<SandboxSchemaId, ValidateFunction>();
    for (const schemaId of SANDBOX_SCHEMA_IDS) {
      const validator = ajv.getSchema(schemaId);
      if (!validator) throw new SandboxContractError(`sandbox schema did not compile: ${schemaId}`);
      validators.set(schemaId, validator);
    }
    return new SandboxContractValidator(validators);
  }

  static async forRepository(schemaDir = path.resolve("contracts/sandbox/v1")): Promise<SandboxContractValidator> {
    return SandboxContractValidator.create(schemaDir);
  }

  validateDocument<T extends SandboxDocument>(schemaId: SandboxSchemaId, document: unknown): T {
    if (!SANDBOX_SCHEMA_IDS.has(schemaId)) throw new SandboxContractError("unsupported sandbox schema identity");
    const validator = this.#validators.get(schemaId);
    if (!validator || !validator(document)) throw new SandboxContractError(`sandbox structural validation failed: ${formatErrors(validator?.errors)}`);
    const typed = document as T;
    assertSandboxSemantics(schemaId, typed);
    return typed;
  }

  validateBytes<T extends SandboxDocument>(schemaId: SandboxSchemaId, bytes: Uint8Array): T {
    const buffer = Buffer.from(bytes);
    let parsed: unknown;
    try { parsed = JSON.parse(buffer.toString("utf8")); }
    catch (error) { throw new SandboxContractError("sandbox contract is not valid JSON", { cause: error }); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SandboxContractError("sandbox contract must be a JSON object");
    if (!buffer.equals(canonicalBytes(parsed))) throw new SandboxContractError("sandbox contract is not deterministically serialized");
    return this.validateDocument<T>(schemaId, parsed);
  }

  validateSpec(document: unknown): SandboxSpecDocument { return this.validateDocument("urn:squire:sandbox:v1:sandbox-spec", document); }
  validateRelease(document: unknown): SandboxReleaseManifestDocument { return this.validateDocument("urn:squire:sandbox:v1:sandbox-release-manifest", document); }
  validateAttestation(document: unknown): SandboxAttestationDocument { return this.validateDocument("urn:squire:sandbox:v1:sandbox-attestation", document); }
  validateTransfer(document: unknown): SandboxTransferManifestDocument { return this.validateDocument("urn:squire:sandbox:v1:sandbox-transfer-manifest", document); }
}

export type SandboxDocument = SandboxSpecDocument | SandboxReleaseManifestDocument | SandboxAttestationDocument | SandboxTransferManifestDocument;

export function assertSandboxSemantics(schemaId: SandboxSchemaId, document: SandboxDocument): void {
  const errors = sandboxSemanticErrors(schemaId, document);
  if (errors.length > 0) throw new SandboxContractError(`${schemaId}: ${errors.join("; ")}`);
}

export function sandboxSemanticErrors(schemaId: SandboxSchemaId, document: unknown): string[] {
  try {
    switch (schemaId) {
      case "urn:squire:sandbox:v1:sandbox-spec": assertSpecSemantics(document as SandboxSpecDocument); break;
      case "urn:squire:sandbox:v1:sandbox-release-manifest": assertReleaseSemantics(document as SandboxReleaseManifestDocument); break;
      case "urn:squire:sandbox:v1:sandbox-attestation": assertAttestationSemantics(document as SandboxAttestationDocument); break;
      case "urn:squire:sandbox:v1:sandbox-transfer-manifest": assertTransferSemantics(document as SandboxTransferManifestDocument); break;
      default: return ["unsupported sandbox schema identity"];
    }
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export function assertSpecSemantics(document: SandboxSpecDocument): void {
  if (!isRecord(document) || !hasExactKeys(document, ["bridge", "creationNonce", "fingerprint", "kind", "network", "resources", "retention", "runId", "sandboxName", "schemaVersion", "template", "ticketIdentifier"]) || document.schemaVersion !== 1 || document.kind !== "squire-sandbox-spec" || !isRecord(document.template) || !hasExactKeys(document.template, ["digest", "name", "reference"]) || !isRecord(document.resources) || !hasExactKeys(document.resources, ["cpus", "disk", "memoryMiB"]) || !isRecord(document.network) || !isRecord(document.bridge) || !hasExactKeys(document.bridge, ["identityReference", "logicalPath", "name", "quotaBytes"]) || !isRecord(document.retention)) throw new SandboxContractError("sandbox spec fields are not closed");
  assertSandboxRunId(document.runId);
  assertSandboxName(document.sandboxName);
  if (document.sandboxName !== deriveSandboxName(document.runId)) throw new SandboxContractError("sandbox name is not derived from the complete run ID");
  if (!/^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u.test(document.ticketIdentifier)) throw new SandboxContractError("ticket identifier is invalid");
  assertDigestReference(document.template.digest, "sandbox template digest");
  assertTemplateReference(document.template.reference);
  if (document.template.reference !== `${document.template.name}@${document.template.digest}`) throw new SandboxContractError("sandbox template reference and digest do not match");
  if (!/^[a-z0-9.-]+(?:\/[a-z0-9._-]+)?$/u.test(document.template.name) || /[\u0000-\u001f\u007f\s]/u.test(document.template.name)) throw new SandboxContractError("sandbox template name is unsafe");
  assertResourceSemantics(document.resources, document.bridge.quotaBytes);
  assertNetworkSemantics(document.network);
  assertBridgeSemantics(document.runId, document.bridge);
  assertRetentionSemantics(document.retention);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(document.creationNonce)) throw new SandboxContractError("sandbox creation nonce is invalid");
  if (!SHA256_PATTERN.test(document.fingerprint) || fingerprintWithoutField(document) !== document.fingerprint) throw new SandboxContractError("sandbox spec fingerprint mismatch");
}

export function assertReleaseSemantics(document: SandboxReleaseManifestDocument): void {
  if (!isRecord(document) || !hasExactKeys(document, ["architecture", "bridgeQuotaBytes", "conformanceEvidence", "kind", "networkProfileDigest", "platform", "promotion", "provenance", "releaseId", "runtimeCompatibility", "sbxBinary", "sbxVersion", "schemaVersion", "supportedResources", "template"]) || document.schemaVersion !== 1 || document.kind !== "squire-sandbox-release-manifest" || !isRecord(document.sbxBinary) || !hasExactKeys(document.sbxBinary, ["helpDigest", "path", "sha256", "versionOutput"]) || !isRecord(document.template) || !hasExactKeys(document.template, ["configDigest", "digest", "helperDigests", "reference"]) || !Array.isArray(document.template.helperDigests) || !isRecord(document.runtimeCompatibility) || !hasExactKeys(document.runtimeCompatibility, ["llmWiki", "pi"]) || !isRecord(document.runtimeCompatibility.pi) || !hasExactKeys(document.runtimeCompatibility.pi, ["maximum", "minimum"]) || !isRecord(document.runtimeCompatibility.llmWiki) || !hasExactKeys(document.runtimeCompatibility.llmWiki, ["maximum", "minimum"]) || !isRecord(document.provenance) || !hasExactKeys(document.provenance, ["buildReference", "sbomReference"]) || !isRecord(document.promotion) || !hasExactKeys(document.promotion, ["algorithm", "keyId", "signature", "state"])) throw new SandboxContractError("sandbox release fields are not closed");
  assertReleaseId(document.releaseId);
  if (document.sbxVersion !== "0.39.0") throw new SandboxContractError("only sbx v0.39.0 is supported");
  assertPlatform(document.platform);
  assertArchitecture(document.architecture);
  if (!isCanonicalHostPath(document.sbxBinary.path)) throw new SandboxContractError("sbx binary path is not an absolute clean path");
  assertSha256(document.sbxBinary.sha256, "sbx binary digest");
  assertSha256(document.sbxBinary.helpDigest, "sbx help digest");
  if (document.sbxBinary.versionOutput !== "sbx version 0.39.0" && document.sbxBinary.versionOutput !== "0.39.0") throw new SandboxContractError("sbx version output is not exact v0.39.0 evidence");
  assertTemplateReference(document.template.reference);
  assertDigestReference(document.template.digest, "release template digest");
  if (!document.template.reference.endsWith(`@${document.template.digest}`) || document.template.digest !== document.template.reference.slice(document.template.reference.lastIndexOf("@") + 1)) throw new SandboxContractError("release template reference and digest do not match");
  assertSha256(document.template.configDigest, "template config digest");
  if (typeof document.provenance.buildReference !== "string" || typeof document.provenance.sbomReference !== "string" || document.provenance.buildReference.length === 0 || document.provenance.buildReference.length > 1024 || document.provenance.sbomReference.length === 0 || document.provenance.sbomReference.length > 1024 || /[\u0000-\u001f\u007f\r\n]/u.test(`${document.provenance.buildReference}${document.provenance.sbomReference}`)) throw new SandboxContractError("release provenance identity is invalid");
  if (document.template.helperDigests.length === 0 || new Set(document.template.helperDigests).size !== document.template.helperDigests.length || document.template.helperDigests.some(value => !SHA256_PATTERN.test(value))) throw new SandboxContractError("template helper digest inventory is invalid");
  assertVersionRange(document.runtimeCompatibility.pi.minimum, "Pi minimum version");
  assertVersionRange(document.runtimeCompatibility.pi.maximum, "Pi maximum version");
  assertVersionRange(document.runtimeCompatibility.llmWiki.minimum, "pi-llm-wiki minimum version");
  assertVersionRange(document.runtimeCompatibility.llmWiki.maximum, "pi-llm-wiki maximum version");
  if (compareVersions(document.runtimeCompatibility.pi.minimum, document.runtimeCompatibility.pi.maximum) > 0 || compareVersions(document.runtimeCompatibility.llmWiki.minimum, document.runtimeCompatibility.llmWiki.maximum) > 0) throw new SandboxContractError("runtime compatibility range is inverted");
  if (!Array.isArray(document.supportedResources) || document.supportedResources.length === 0 || document.supportedResources.length > 64) throw new SandboxContractError("release must contain at least one supported resource tuple");
  if (!Number.isSafeInteger(document.bridgeQuotaBytes) || document.bridgeQuotaBytes < 4096 || document.bridgeQuotaBytes > 107_374_182_400) throw new SandboxContractError("release bridge quota is invalid");
  const ids = new Set<string>();
  for (const tuple of document.supportedResources) {
    if (!isRecord(tuple)) throw new SandboxContractError("supported resource tuple is not a closed object");
    const tupleValue = tuple as unknown as SandboxResourceTuple;
    assertResourceSemantics(tupleValue, document.bridgeQuotaBytes);
    if (ids.has(tupleValue.tupleId)) throw new SandboxContractError("supported resource tuple IDs must be unique");
    ids.add(tupleValue.tupleId);
    if (tupleValue.disk.enforcement === "unsupported" && document.promotion.state === "validated") throw new SandboxContractError("unsupported disk tuples cannot be promoted");
  }
  assertSha256(document.networkProfileDigest, "release network profile digest");
  if (!Array.isArray(document.conformanceEvidence) || document.conformanceEvidence.length === 0 || document.conformanceEvidence.some(evidence => !isRecord(evidence)) || !document.conformanceEvidence.some(evidence => evidence.kind === "host-conformance")) throw new SandboxContractError("release requires host conformance evidence");
  const evidenceKeys = new Set<string>();
  for (const evidence of document.conformanceEvidence) {
    if (!isRecord(evidence) || !hasExactKeys(evidence, ["architecture", "hostOnly", "kind", "path", "platform", "sha256"]) || evidence["hostOnly"] !== true || evidence["platform"] !== document.platform || evidence["architecture"] !== document.architecture || typeof evidence["kind"] !== "string" || !["host-conformance", "resource", "network", "identity", "removal", "provenance"].includes(evidence["kind"]) || typeof evidence["sha256"] !== "string" || !SHA256_PATTERN.test(evidence["sha256"])) throw new SandboxContractError("release evidence is not exact host-only evidence for this platform");
    assertEvidencePath(evidence["path"], "release evidence path");
    const key = `${evidence["kind"]}\0${evidence["platform"]}\0${evidence["architecture"]}\0${evidence["path"]}\0${evidence["sha256"]}`;
    if (evidenceKeys.has(key)) throw new SandboxContractError("release conformance evidence contains a duplicate identity");
    evidenceKeys.add(key);
  }
  if (/latest|:latest|\bunknown\b/iu.test(document.template.reference) || document.template.reference.includes("://")) throw new SandboxContractError("release contains mutable or non-OCI template identity");
  if (!["validated", "blocked"].includes(document.promotion.state) || !["sha256-hmac", "ed25519"].includes(document.promotion.algorithm) || typeof document.promotion.keyId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(document.promotion.keyId) || typeof document.promotion.signature !== "string" || document.promotion.signature.length < 1 || document.promotion.signature.length > 1024 || !/^[A-Za-z0-9+/=_-]+$/u.test(document.promotion.signature)) throw new SandboxContractError("release promotion identity is invalid");
  if (document.promotion.state === "validated" && document.promotion.signature.length < 16) throw new SandboxContractError("validated release has no meaningful promotion signature");
}

export function assertAttestationSemantics(document: SandboxAttestationDocument): void {
  if (!isRecord(document) || !hasExactKeys(document, ["attestedAt", "bootId", "canaries", "credentials", "creationGeneration", "fingerprint", "kind", "mounts", "network", "observed", "principals", "releaseId", "resources", "runId", "sandboxName", "schemaVersion", "specFingerprint", "sockets", "templateDigest"]) || document.schemaVersion !== 1 || document.kind !== "squire-sandbox-attestation" || !isRecord(document.observed) || !hasExactKeys(document.observed, ["bridgeIdentity", "bridgeName", "sandboxId", "sandboxName", "templateDigest", "vmId"]) || !isRecord(document.observed.bridgeIdentity) || !isRecord(document.resources) || !hasExactKeys(document.resources, ["cpuOnline", "disk", "memoryMaxBytes", "requested"]) || !isRecord(document.resources.requested) || !hasExactKeys(document.resources.requested, ["cpus", "disk", "memoryMiB"]) || !isRecord(document.resources.requested.disk) || !isRecord(document.resources.disk) || !isRecord(document.principals) || !hasExactKeys(document.principals, ["agentGid", "agentUid", "controllerGid", "controllerUid", "distinct", "rootfulDockerSocketAbsent", "sudoAbsent", "supervisorSocketProtected"]) || !isRecord(document.mounts) || !hasExactKeys(document.mounts, ["forbiddenMountsAbsent", "mountInfoDigest", "namespace", "nestedMountsAbsent", "ticketDevice", "ticketInode"]) || !isRecord(document.sockets) || !hasExactKeys(document.sockets, ["controllerSocketsAbsent", "hostSocketsAbsent", "rootlessDocker"]) || !isRecord(document.network) || !hasExactKeys(document.network, ["allowedHttpsCorrelationDigest", "deniedProbeDigest", "hostObservation", "profileDigest"]) || !isRecord(document.network.hostObservation) || !isRecord(document.credentials) || !hasExactKeys(document.credentials, ["canaryHmacDigest", "effectiveEnvironmentDigest", "forbiddenNamesAbsent"]) || !isRecord(document.canaries) || !hasExactKeys(document.canaries, ["dockerDigest", "isolationDigest", "mountDigest", "persistenceDigest", "principalDigest"])) throw new SandboxContractError("sandbox attestation fields are not closed");
  assertSandboxRunId(document.runId);
  assertSandboxName(document.sandboxName);
  assertReleaseId(document.releaseId);
  if (document.sandboxName !== deriveSandboxName(document.runId) || document.observed.sandboxName !== document.sandboxName || document.observed.bridgeName !== deriveBridgeName(document.runId) || !safeIdentity(document.observed.sandboxId) || !safeIdentity(document.observed.vmId) || !safeIdentity(document.bootId)) throw new SandboxContractError("attestation sandbox identity is not deterministic");
  assertSha256(document.specFingerprint, "attestation spec fingerprint");
  assertDigestReference(document.templateDigest, "attestation template digest");
  assertDigestReference(document.observed.templateDigest, "observed template digest");
  if (document.observed.templateDigest !== document.templateDigest || document.observed.bridgeName !== deriveBridgeName(document.runId)) throw new SandboxContractError("attestation observed immutable identity differs from requested identity");
  assertBridgeIdentity(document.observed.bridgeIdentity);
  assertResourceSemantics(document.resources.requested, document.observed.bridgeIdentity.quotaBytes);
  if (!Number.isSafeInteger(document.principals.controllerUid) || document.principals.controllerUid !== 1000 || !Number.isSafeInteger(document.principals.controllerGid) || document.principals.controllerGid !== 1000 || !Number.isSafeInteger(document.principals.agentUid) || document.principals.agentUid !== 1001 || !Number.isSafeInteger(document.principals.agentGid) || document.principals.agentGid !== 1001 || document.principals.distinct !== true || document.principals.sudoAbsent !== true || document.principals.rootfulDockerSocketAbsent !== true || document.principals.supervisorSocketProtected !== true) throw new SandboxContractError("attestation does not prove the exact distinct unprivileged role principal");
  if (document.sockets.rootlessDocker !== "/ticket/docker/run/docker.sock" || document.sockets.controllerSocketsAbsent !== true || document.sockets.hostSocketsAbsent !== true) throw new SandboxContractError("attestation socket isolation is incomplete");
  if (document.mounts.forbiddenMountsAbsent !== true || document.mounts.nestedMountsAbsent !== true || !safeIdentity(document.mounts.namespace) || !safeIdentity(document.mounts.ticketDevice) || !safeIdentity(document.mounts.ticketInode)) throw new SandboxContractError("attestation mount isolation is incomplete");
  assertSha256(document.mounts.mountInfoDigest, "mount evidence digest");
  assertSha256(document.network.profileDigest, "attested network profile digest");
  assertSha256(document.network.allowedHttpsCorrelationDigest, "network allow evidence digest");
  assertSha256(document.network.deniedProbeDigest, "network deny evidence digest");
  if (!hasExactKeys(document.network.hostObservation, ["path", "schemaId", "sha256"]) || typeof document.network.hostObservation.sha256 !== "string" || typeof document.network.hostObservation.schemaId !== "string" || typeof document.network.hostObservation.path !== "string") throw new SandboxContractError("attestation host observation reference is not closed");
  assertSha256(document.network.hostObservation.sha256, "host network observation digest");
  assertEvidencePath(document.network.hostObservation.path, "attestation host observation path");
  if (!isSandboxEvidenceSchemaId(document.network.hostObservation.schemaId, "host evidence")) throw new SandboxContractError("attestation host observation reference is invalid");
  assertSha256(document.credentials.effectiveEnvironmentDigest, "credential environment digest");
  assertSha256(document.credentials.canaryHmacDigest, "credential canary digest");
  if (document.credentials.forbiddenNamesAbsent !== true) throw new SandboxContractError("attestation credential isolation is incomplete");
  for (const digest of Object.values(document.canaries)) assertSha256(digest, "canary digest");
  if (!Number.isSafeInteger(document.creationGeneration) || document.creationGeneration < 1) throw new SandboxContractError("attestation generation is invalid");
  if (!Number.isSafeInteger(document.resources.cpuOnline) || document.resources.cpuOnline < 1 || document.resources.cpuOnline > 256 || document.resources.cpuOnline !== document.resources.requested.cpus) throw new SandboxContractError("attested CPU observation does not match the requested tuple");
  if (!Number.isSafeInteger(document.resources.memoryMaxBytes) || document.resources.memoryMaxBytes <= 0 || document.resources.memoryMaxBytes !== document.resources.requested.memoryMiB * 1024 * 1024) throw new SandboxContractError("attested memory limit does not match the requested tuple");
  assertAttestedDisk(document.resources.disk, document.resources.requested.disk);
  if (!canonicalDate(document.attestedAt) || !SHA256_PATTERN.test(document.fingerprint) || fingerprintWithoutField(document) !== document.fingerprint) throw new SandboxContractError("sandbox attestation timestamp or fingerprint is invalid");
}

export function assertTransferSemantics(document: SandboxTransferManifestDocument): void {
  if (!isRecord(document) || !hasExactKeys(document, ["bootId", "bridgeUsed", "byteLength", "createdAt", "destination", "direction", "fingerprint", "kind", "runId", "sandboxName", "schemaVersion", "sha256", "source", "sourceVerified", "specFingerprint", "transferGeneration", "destinationVerified", ...(isRecord(document) && Object.hasOwn(document, "expectedGit") ? ["expectedGit"] : [])]) || document.schemaVersion !== 1 || document.kind !== "squire-sandbox-transfer-manifest" || !isRecord(document.source) || !hasExactKeys(document.source, ["logicalPath", "side"]) || !isRecord(document.destination) || !hasExactKeys(document.destination, ["logicalPath", "side"])) throw new SandboxContractError("sandbox transfer fields are not closed");
  assertSandboxRunId(document.runId);
  assertSandboxName(document.sandboxName);
  if (document.direction !== "import" && document.direction !== "export") throw new SandboxContractError("transfer direction is invalid");
  if (document.sandboxName !== deriveSandboxName(document.runId)) throw new SandboxContractError("transfer sandbox name is not derived from run");
  assertSha256(document.specFingerprint, "transfer spec fingerprint");
  if (!document.bootId || document.bootId.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(document.bootId)) throw new SandboxContractError("transfer boot identity is invalid");
  assertTransferLocation(document.source.logicalPath, document.source.side);
  assertTransferLocation(document.destination.logicalPath, document.destination.side);
  if (document.direction === "import" && (document.source.side !== "host" || document.destination.side !== "sandbox")) throw new SandboxContractError("import transfer must be host to sandbox");
  if (document.direction === "export" && (document.source.side !== "sandbox" || document.destination.side !== "host")) throw new SandboxContractError("export transfer must be sandbox to host");
  if (!Number.isSafeInteger(document.byteLength) || document.byteLength <= 0 || document.byteLength > 1_099_511_627_776) throw new SandboxContractError("transfer byte length is invalid");
  assertSha256(document.sha256, "transfer digest");
  if (document.bridgeUsed !== false || document.source.logicalPath.includes("/bridge") || document.destination.logicalPath.includes("/bridge")) throw new SandboxContractError("sandbox bridge is not a trusted transfer path");
  if (document.sourceVerified !== true || document.destinationVerified !== true) throw new SandboxContractError("transfer lacks both-side verification");
  if (!Number.isSafeInteger(document.transferGeneration) || document.transferGeneration < 1) throw new SandboxContractError("transfer generation is invalid");
  if (Object.hasOwn(document, "expectedGit") && !isRecord(document.expectedGit)) throw new SandboxContractError("transfer Git binding is not closed");
  if (document.expectedGit !== undefined) {
    const git = document.expectedGit; const expectedKeys = git.objectFormat === "sha1" || git.objectFormat === "sha256" ? ["baseSha", "objectFormat", ...(git.repository !== undefined ? ["repository"] : []), ...(git.bundle !== undefined ? ["bundle"] : [])] : [];
    if (!hasExactKeys(git as unknown as Record<string, unknown>, expectedKeys) || !["sha1", "sha256"].includes(git.objectFormat)) throw new SandboxContractError("transfer Git binding is not closed");
    const length = git.objectFormat === "sha1" ? 40 : 64;
    if (typeof git.baseSha !== "string" || git.baseSha.length !== length || !new RegExp(`^[0-9a-f]{${length}}$`, "u").test(git.baseSha)) throw new SandboxContractError("transfer Git base identity is invalid");
    if (git.repository !== undefined && git.repository !== "/ticket/git/repo.git") throw new SandboxContractError("transfer Git repository identity is not fixed");
    if (git.bundle !== undefined && !new RegExp(`^artifacts/git/${document.runId}/[0-9a-f]{${length}}\\.bundle$`, "u").test(git.bundle)) throw new SandboxContractError("transfer Git bundle path is not bound to the transfer run");
  }
  if (!canonicalDate(document.createdAt) || !SHA256_PATTERN.test(document.fingerprint) || fingerprintWithoutField(document) !== document.fingerprint) throw new SandboxContractError("sandbox transfer timestamp or fingerprint is invalid");
}

export function buildAttestationFingerprint(document: Omit<SandboxAttestationDocument, "fingerprint">): string {
  return sha256Bytes(Buffer.from(canonicalJson(document), "utf8"));
}

export function buildTransferFingerprint(document: Omit<SandboxTransferManifestDocument, "fingerprint">): string {
  return sha256Bytes(Buffer.from(canonicalJson(document), "utf8"));
}

function assertResourceSemantics(resources: SandboxResourceSpec, bridgeQuotaBytes?: number): void {
  if (!isRecord(resources) || !hasExactKeys(resources, Object.hasOwn(resources, "tupleId") ? ["cpus", "disk", "memoryMiB", "tupleId"] : ["cpus", "disk", "memoryMiB"]) || Object.hasOwn(resources, "tupleId") && (typeof resources["tupleId"] !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/u.test(resources["tupleId"] as string)) || !Number.isSafeInteger(resources.cpus) || resources.cpus < 1 || resources.cpus > 256) throw new SandboxContractError("resource CPU value is invalid");
  if (!Number.isSafeInteger(resources.memoryMiB) || resources.memoryMiB < 128 || resources.memoryMiB > 1_048_576) throw new SandboxContractError("resource memory value is invalid");
  try { assertDiskBudget(resources.disk as unknown as SandboxDiskBudget, bridgeQuotaBytes); }
  catch (error) { throw new SandboxContractError(error instanceof Error ? error.message : "resource disk value is invalid"); }
}

function assertNetworkSemantics(network: SandboxNetworkSpec): void {
  if (!network || typeof network !== "object" || !hasExactKeys(network as unknown as Record<string, unknown>, ["allowedHosts", "mode", "profileDigest"]) || !["allow-all", "allowlist", "deny-all"].includes(network.mode) || !Array.isArray(network.allowedHosts) || network.allowedHosts.length > 128 || network.allowedHosts.some(host => typeof host !== "string" || !isSafeSandboxNetworkHost(host))) throw new SandboxContractError("network host list contains an unsafe host");
  if (network.mode !== "allowlist" && network.allowedHosts.length !== 0) throw new SandboxContractError("network host list is only valid for allowlist mode");
  if (new Set(network.allowedHosts).size !== network.allowedHosts.length) throw new SandboxContractError("network host list is not unique");
  const expected = sha256Bytes(Buffer.from(canonicalJson({ mode: network.mode, allowedHosts: network.allowedHosts }), "utf8"));
  if (network.profileDigest !== expected) throw new SandboxContractError("network profile digest does not match effective policy");
}

function assertBridgeSemantics(runId: string, bridge: SandboxBridgeSpec): void {
  assertBridgeName(bridge.name);
  if (bridge.name !== deriveBridgeName(runId) || bridge.logicalPath !== "/ticket/bridge") throw new SandboxContractError("bridge identity is not deterministic or fixed");
  if (!Number.isSafeInteger(bridge.quotaBytes) || bridge.quotaBytes < 4096 || bridge.quotaBytes > 107_374_182_400) throw new SandboxContractError("bridge quota is invalid");
  if (bridge.identityReference !== deriveBridgeIdentityReference(runId, bridge.name)) throw new SandboxContractError("bridge identity reference is not run-bound");
}

function assertRetentionSemantics(retention: SandboxSpecDocument["retention"]): void {
  if (!retention || !hasExactKeys(retention as unknown as Record<string, unknown>, ["artifactUntil", "failureUntil", "successUntil"]) || Object.values(retention).some(value => typeof value !== "string")) throw new SandboxContractError("retention fields are not closed");
  const dates = [Date.parse(retention.successUntil), Date.parse(retention.failureUntil), Date.parse(retention.artifactUntil)];
  if (dates.some(value => !Number.isFinite(value)) || [retention.successUntil, retention.failureUntil, retention.artifactUntil].some(value => new Date(value).toISOString() !== value) || dates[0]! > dates[1]! || dates[1]! > dates[2]!) throw new SandboxContractError("retention deadlines are invalid or not monotonic");
}

function assertAttestedDisk(observed: SandboxAttestationDocument["resources"]["disk"], requested: SandboxDiskBudget): void {
  if (!isRecord(observed) || !hasExactKeys(observed, Object.hasOwn(observed, "quotaBytes") ? ["enforcement", "enospcObserved", "proofDigest", "quotaBytes", "statfsBytes"] : ["enforcement", "enospcObserved", "proofDigest", "statfsBytes"]) || !["native", "quota-composed", "unsupported"].includes(observed.enforcement as string) || typeof observed.enospcObserved !== "boolean" || !Number.isSafeInteger(observed.statfsBytes) || observed.statfsBytes < 0 || typeof observed.proofDigest !== "string" || !SHA256_PATTERN.test(observed.proofDigest)) throw new SandboxContractError("disk observation is malformed");
  if (observed.enforcement !== requested.enforcement) throw new SandboxContractError("disk observation enforcement differs from requested tuple");
  if (requested.enforcement === "unsupported") {
    if (observed.quotaBytes !== undefined || observed.enospcObserved) throw new SandboxContractError("unsupported disk tuple contains an enforcement claim");
    return;
  }
  if (observed.quotaBytes === undefined || !Number.isSafeInteger(observed.quotaBytes) || observed.quotaBytes <= 0 || !observed.enospcObserved) throw new SandboxContractError("disk attestation lacks bounded enforcement and ENOSPC proof");
  if (requested.enforcement === "native" && (requested.nativeLimitBytes === undefined || observed.quotaBytes !== requested.nativeLimitBytes)) throw new SandboxContractError("native disk observation differs from the requested bound");
  if (requested.enforcement === "quota-composed" && (requested.ticketQuotaBytes === undefined || requested.bridgeQuotaBytes === undefined || requested.writableTmpfsBytes === undefined || observed.quotaBytes !== requested.ticketQuotaBytes + requested.bridgeQuotaBytes + requested.writableTmpfsBytes)) throw new SandboxContractError("quota-composed disk observation differs from every requested writable surface");
}

function safeIdentity(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f\r\n]/u.test(value); }

function assertBridgeIdentity(identity: SandboxAttestationDocument["observed"]["bridgeIdentity"]): void {
  if (!hasExactKeys(identity as unknown as Record<string, unknown>, ["device", "inode", "linkCount", "mode", "quotaBytes"]) || !safeIdentity(identity.device) || !safeIdentity(identity.inode) || !Number.isSafeInteger(identity.linkCount) || identity.linkCount < 2 || !Number.isSafeInteger(identity.mode) || identity.mode !== 0o700 || !Number.isSafeInteger(identity.quotaBytes) || identity.quotaBytes < 4096 || identity.quotaBytes > 107_374_182_400) throw new SandboxContractError("bridge physical identity is invalid");
}

function assertTransferLocation(logicalPath: string, side: "host" | "sandbox"): void {
  if ((side !== "host" && side !== "sandbox") || typeof logicalPath !== "string" || logicalPath.length === 0 || logicalPath.length > 1_024 || /[\u0000-\u001f\u007f\\\s]/u.test(logicalPath) || logicalPath.includes("..") || logicalPath.includes("//") || logicalPath.includes("/bridge")) throw new SandboxContractError("transfer path is unsafe or uses the bridge");
  if (side === "sandbox") {
    assertCanonicalSandboxPath(logicalPath, "sandbox transfer path");
    if (!logicalPath.startsWith("/ticket/import/") && !logicalPath.startsWith("/ticket/artifacts/") && !logicalPath.startsWith("/ticket/evidence/") && !logicalPath.startsWith("/ticket/sessions/")) throw new SandboxContractError("sandbox transfer path is outside the closed import/export roots");
  } else if (logicalPath.startsWith("/") || !/^(?:artifacts|evidence|import)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(logicalPath)) {
    throw new SandboxContractError("host transfer path must be a protected logical staging path, not an ambient path");
  }
}

function assertVersionRange(value: string, label: string): void {
  if (typeof value !== "string" || value.length < 5 || value.length > 32 || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value) || value.split(/[.+-]/u).slice(0, 3).some(part => !Number.isSafeInteger(Number(part)) || Number(part) > 1_000_000)) throw new SandboxContractError(`${label} is invalid`);
}

function isCanonicalHostPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 2 || value.length > 1_024 || /[\u0000-\u001f\u007f\r\n]/u.test(value)) return false;
  const windows = /^[A-Za-z]:[\\/]/u.test(value);
  const implementation = windows ? path.win32 : path.posix;
  return implementation.isAbsolute(value) && implementation.normalize(value) === value && !value.endsWith("/") && !value.endsWith("\\") && !value.includes("//") && !value.includes("\\\\") && !value.split(windows ? /[\\/]/u : "/").some(part => part === "." || part === "..");
}

function isEvidencePath(value: unknown): value is string {
  return typeof value === "string" && /^(?:artifacts|evidence)(?:\/[A-Za-z0-9._-]+)+$/u.test(value) && value.split("/").every(part => part !== "." && part !== "..");
}
function assertEvidencePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length > 1_024 || !isEvidencePath(value)) throw new SandboxContractError(`${label} is not canonical`);
}
function canonicalDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => value.split(/[.+-]/u).slice(0, 3).map(part => Number.parseInt(part, 10));
  const a = parse(left); const b = parse(right);
  for (let index = 0; index < 3; index += 1) if (a[index]! !== b[index]!) return a[index]! - b[index]!;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return isRecord(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }

function formatErrors(errors: ValidateFunction["errors"]): string {
  return errors?.map(error => `${error.instancePath || "/"} ${error.message ?? "invalid"}`).join(", ") ?? "unknown";
}

// Keep the imports above explicit: these checks are part of the public contract
// boundary even when callers only use the semantic helper.
void sameContractReference;
void canonicalBytes;
void assertCanonicalSandboxPath;
void assertPlatform;
void assertArchitecture;
void assertReleaseId;
void assertSha256;
void assertTemplateReference;
void assertDigestReference;
void canonicalJson;
void assertResourceSemantics;
void buildAttestationFingerprint;
void buildTransferFingerprint;
void sha256Bytes;
