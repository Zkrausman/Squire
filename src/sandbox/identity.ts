import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { ContractReference } from "../control/domain.js";
import { assertRunId, assertTicketIdentifier } from "../git/identity.js";
import type { SandboxBridgeSpec, SandboxDiskBudget, SandboxNetworkSpec, SandboxResourceSpec, SandboxRetentionSpec, SandboxSpecDocument } from "./domain.js";

export const SANDBOX_NAME_PATTERN = /^squire-v1-[a-z2-7]{26}$/u;
export const BRIDGE_NAME_PATTERN = /^squire-bridge-v1-[a-z2-7]{26}$/u;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
export const DIGEST_REFERENCE_PATTERN = /^sha256:[0-9a-f]{64}$/u;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const RELEASE_ID_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/u;
export const PLATFORM_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
export const ARCHITECTURE_PATTERN = /^[a-z][a-z0-9._-]{0,31}$/u;
export const SANDBOX_DISK_PROOF_SCHEMA_ID = "urn:squire:sandbox:v1:disk-proof" as const;
export const SANDBOX_RESOURCE_EVIDENCE_SCHEMA_ID = "urn:squire:sandbox:v1:resource" as const;
export const SANDBOX_HOST_EVIDENCE_SCHEMA_ID = "urn:squire:sandbox:v1:host-evidence" as const;

export class SandboxIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxIdentityError";
  }
}

export function assertSandboxRunId(runId: string): string {
  try { return assertRunId(runId); }
  catch (error) { throw new SandboxIdentityError(error instanceof Error ? error.message : "invalid sandbox run ID"); }
}

export function assertSandboxName(name: string): string {
  if (typeof name !== "string" || !SANDBOX_NAME_PATTERN.test(name)) throw new SandboxIdentityError("sandbox name is not the deterministic v1 identity");
  return name;
}

export function assertBridgeName(name: string): string {
  if (typeof name !== "string" || !BRIDGE_NAME_PATTERN.test(name)) throw new SandboxIdentityError("bridge name is not the deterministic v1 identity");
  return name;
}

export function deriveSandboxName(runId: string): string {
  assertSandboxRunId(runId);
  return `squire-v1-${base32(createHash("sha256").update(Buffer.from(`sandbox\0${runId}`, "utf8")).digest()).slice(0, 26)}`;
}

export function deriveBridgeName(runId: string): string {
  assertSandboxRunId(runId);
  return `squire-bridge-v1-${base32(createHash("sha256").update(Buffer.from(`bridge\0${runId}`, "utf8")).digest()).slice(0, 26)}`;
}

export function deriveBridgeIdentityReference(runId: string, bridgeName = deriveBridgeName(runId)): string {
  assertSandboxRunId(runId);
  assertBridgeName(bridgeName);
  return `bridge-meta-${sha256Bytes(Buffer.from(`${runId}\0${bridgeName}`, "utf8"))}`;
}

export function assertSha256(value: string, label = "SHA-256 digest"): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) throw new SandboxIdentityError(`${label} is not a lowercase SHA-256 digest`);
  return value;
}

export function assertDigestReference(value: string, label = "digest reference"): string {
  if (typeof value !== "string" || !DIGEST_REFERENCE_PATTERN.test(value)) throw new SandboxIdentityError(`${label} is not an immutable sha256 digest reference`);
  return value;
}

export function digestReference(value: Uint8Array | string): string {
  return `sha256:${sha256Bytes(typeof value === "string" ? Buffer.from(value, "utf8") : value)}`;
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Text(value: string): string {
  if (/\u0000/u.test(value)) throw new SandboxIdentityError("text contains NUL");
  return sha256Bytes(Buffer.from(value, "utf8"));
}

export function assertCanonicalSandboxPath(value: string, label = "sandbox path"): string {
  if (typeof value !== "string" || value.length < 6 || value.length > 1024 || !path.posix.isAbsolute(value)) throw new SandboxIdentityError(`${label} must be an absolute bounded path`);
  if (/[\u0000-\u001f\u007f\\]/u.test(value) || value.includes("//") || path.posix.normalize(value) !== value || (value !== "/ticket" && !value.startsWith("/ticket/"))) throw new SandboxIdentityError(`${label} must be canonical beneath /ticket`);
  if (value.split("/").some(part => part === "." || part === "..")) throw new SandboxIdentityError(`${label} contains traversal`);
  return value;
}

export function isCanonicalSandboxPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { assertCanonicalSandboxPath(value); return true; }
  catch { return false; }
}

export function assertRelativeArtifactPath(value: string, label = "artifact path"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || /[\u0000-\u001f\u007f\\]/u.test(value) || path.posix.normalize(value) !== value || value.startsWith("/") || value.split("/").some(part => part === "." || part === ".." || part.length === 0)) throw new SandboxIdentityError(`${label} is not a canonical relative path`);
  if (!value.startsWith("artifacts/") && !value.startsWith("evidence/") && !value.startsWith("import/")) throw new SandboxIdentityError(`${label} is outside the protected transfer roots`);
  return value;
}

export function assertReleaseId(value: string): string {
  if (typeof value !== "string" || !RELEASE_ID_PATTERN.test(value)) throw new SandboxIdentityError("release ID is invalid");
  return value;
}

export function assertPlatform(value: string): string {
  if (typeof value !== "string" || !PLATFORM_PATTERN.test(value)) throw new SandboxIdentityError("platform identity is invalid");
  return value;
}

export function assertArchitecture(value: string): string {
  if (typeof value !== "string" || !ARCHITECTURE_PATTERN.test(value)) throw new SandboxIdentityError("architecture identity is invalid");
  return value;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new SandboxIdentityError("canonical JSON contains a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint" || typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") throw new SandboxIdentityError("canonical JSON contains an unsupported value");
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

export function fingerprintWithoutField<T extends object>(value: T, field: keyof T = "fingerprint" as keyof T): string {
  const copy = { ...value } as Record<string, unknown>;
  delete copy[String(field)];
  return sha256Bytes(Buffer.from(canonicalJson(copy), "utf8"));
}

export interface SandboxSpecInput {
  readonly runId: string;
  readonly ticketIdentifier: string;
  readonly template: { readonly name: string; readonly digest: string; readonly reference?: string };
  readonly resources: SandboxResourceSpec;
  readonly network: Omit<SandboxNetworkSpec, "profileDigest"> & { readonly profileDigest?: string };
  readonly bridgeQuotaBytes: number;
  readonly retention: SandboxRetentionSpec;
  readonly creationNonce?: string;
  readonly bridgeName?: string;
}

export function buildSandboxSpec(input: SandboxSpecInput): SandboxSpecDocument {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SandboxIdentityError("sandbox spec input is required");
  const runId = assertSandboxRunId(input.runId);
  assertTicketIdentifier(input.ticketIdentifier);
  const sandboxName = deriveSandboxName(runId);
  if (!input.template || typeof input.template !== "object" || Array.isArray(input.template) || typeof input.template.name !== "string" || !/^[a-z0-9.-]+(?:\/[a-z0-9._-]+)?$/u.test(input.template.name)) throw new SandboxIdentityError("sandbox template name is invalid");
  const bridgeName = input.bridgeName ?? deriveBridgeName(runId);
  if (bridgeName !== deriveBridgeName(runId)) throw new SandboxIdentityError("bridge name is not bound to the run");
  assertBridgeName(bridgeName);
  assertDigestReference(input.template.digest, "sandbox template digest");
  const templateReference = input.template.reference ?? `${input.template.name}@${input.template.digest}`;
  assertTemplateReference(templateReference);
  if (templateReference !== `${input.template.name}@${input.template.digest}`) throw new SandboxIdentityError("sandbox template reference and digest do not match template name");
  const network = normalizeNetwork(input.network);
  const bridge: SandboxBridgeSpec = {
    name: bridgeName,
    logicalPath: "/ticket/bridge",
    quotaBytes: positiveBytes(input.bridgeQuotaBytes, "bridge quota"),
    identityReference: deriveBridgeIdentityReference(runId, bridgeName),
  };
  const resources = normalizeResources(input.resources, bridge.quotaBytes);
  const retention = normalizeRetention(input.retention);
  const documentWithoutFingerprint = {
    schemaVersion: 1 as const,
    kind: "squire-sandbox-spec" as const,
    runId,
    ticketIdentifier: input.ticketIdentifier,
    sandboxName,
    template: { name: input.template.name, digest: input.template.digest, reference: templateReference },
    resources,
    network,
    bridge,
    retention,
    creationNonce: input.creationNonce ?? randomUUID(),
  };
  if (!UUID_PATTERN.test(documentWithoutFingerprint.creationNonce)) throw new SandboxIdentityError("sandbox creation nonce is invalid");
  return deepFreeze({ ...documentWithoutFingerprint, fingerprint: sha256Bytes(Buffer.from(canonicalJson(documentWithoutFingerprint), "utf8")) });
}

export function assertTemplateReference(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 || /[\u0000-\u001f\u007f\s]/u.test(value) || !/^([a-z0-9.-]+\/)?[a-z0-9._-]+\/[a-z0-9._-]+@sha256:[0-9a-f]{64}$/u.test(value)) throw new SandboxIdentityError("template reference must be a qualified immutable OCI digest reference");
  if (value.includes(":latest") || !value.includes("@sha256:")) throw new SandboxIdentityError("mutable template references are forbidden");
  return value;
}

export function assertVersionRange(value: string, label = "version range"): string {
  if (typeof value !== "string" || value.length < 5 || value.length > 32 || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value) || value.split(/[.+-]/u).slice(0, 3).some(part => !Number.isSafeInteger(Number(part)) || Number(part) > 1_000_000)) throw new SandboxIdentityError(`${label} is invalid`);
  return value;
}

function normalizeNetwork(input: SandboxSpecInput["network"]): SandboxNetworkSpec {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input as unknown as Record<string, unknown>).some(key => !["allowedHosts", "mode", "profileDigest"].includes(key)) || !Array.isArray(input.allowedHosts) || !["allow-all", "allowlist", "deny-all"].includes(input.mode)) throw new SandboxIdentityError("network policy fields are not closed");
  const allowedHosts = [...input.allowedHosts];
  if (allowedHosts.length > 128 || new Set(allowedHosts).size !== allowedHosts.length) throw new SandboxIdentityError("network host allowlist is not bounded and unique");
  for (const host of allowedHosts) {
    if (typeof host !== "string" || !isSafeSandboxNetworkHost(host)) throw new SandboxIdentityError("network allowlist host is unsafe");
  }
  if (input.mode !== "allowlist" && allowedHosts.length !== 0) throw new SandboxIdentityError("allow-all and deny-all network profiles cannot carry an allowlist");
  const withoutDigest = { mode: input.mode, allowedHosts };
  const profileDigest = input.profileDigest ?? sha256Bytes(Buffer.from(canonicalJson(withoutDigest), "utf8"));
  assertSha256(profileDigest, "network profile digest");
  if (profileDigest !== sha256Bytes(Buffer.from(canonicalJson(withoutDigest), "utf8"))) throw new SandboxIdentityError("network profile digest does not match its effective rules");
  return { ...withoutDigest, profileDigest };
}

function normalizeResources(input: SandboxResourceSpec, bridgeQuotaBytes: number): SandboxResourceSpec {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SandboxIdentityError("resource tuple is invalid");
  if (!Number.isSafeInteger(input.cpus) || input.cpus < 1 || input.cpus > 256) throw new SandboxIdentityError("CPU resource tuple is invalid");
  if (!Number.isSafeInteger(input.memoryMiB) || input.memoryMiB < 128 || input.memoryMiB > 1_048_576) throw new SandboxIdentityError("memory resource tuple is invalid");
  assertDiskBudget(input.disk, bridgeQuotaBytes);
  return {
    cpus: input.cpus,
    memoryMiB: input.memoryMiB,
    disk: { ...input.disk },
  };
}

export function assertDiskBudget(input: SandboxDiskBudget, bridgeQuotaBytes?: number): void {
  if (!input || !["native", "quota-composed", "unsupported"].includes(input.enforcement)) throw new SandboxIdentityError("disk enforcement mode is invalid");
  const expectedKeys = input.enforcement === "unsupported" ? ["enforcement", "unsupportedReason"] : input.enforcement === "native" ? ["enforcement", "nativeLimitBytes", "proof", "writableTmpfsBytes"] : ["bridgeQuotaBytes", "enforcement", "proof", "ticketQuotaBytes", "writableTmpfsBytes"];
  if (Object.keys(input as unknown as Record<string, unknown>).sort().join("\0") !== expectedKeys.sort().join("\0")) throw new SandboxIdentityError("disk budget quota fields are not closed");
  const values = [input.ticketQuotaBytes, input.bridgeQuotaBytes, input.writableTmpfsBytes, input.nativeLimitBytes];
  if (values.some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 4096 || value > 1_099_511_627_776))) throw new SandboxIdentityError("disk quota values are invalid");
  if (input.enforcement === "unsupported") {
    if (typeof input.unsupportedReason !== "string" || input.unsupportedReason.length === 0 || input.unsupportedReason.length > 500 || /[\u0000-\u001f\u007f]/u.test(input.unsupportedReason)) throw new SandboxIdentityError("unsupported disk tuple requires a bounded reason");
    if (values.some(value => value !== undefined) || input.proof) throw new SandboxIdentityError("unsupported disk tuple must not claim a quota or proof");
    return;
  }
  if (!input.proof || typeof input.proof !== "object" || Array.isArray(input.proof) || Object.keys(input.proof as unknown as Record<string, unknown>).sort().join("\0") !== "path\0schemaId\0sha256" || typeof input.proof.path !== "string" || !isEvidencePath(input.proof.path) || typeof input.proof.schemaId !== "string" || !isSandboxEvidenceSchemaId(input.proof.schemaId, "disk proof") || typeof input.proof.sha256 !== "string" || !SHA256_PATTERN.test(input.proof.sha256)) throw new SandboxIdentityError("enforced disk tuple requires immutable proof evidence");
  if (input.enforcement === "native") {
    if (input.nativeLimitBytes === undefined || input.writableTmpfsBytes === undefined || input.ticketQuotaBytes !== undefined || input.bridgeQuotaBytes !== undefined) throw new SandboxIdentityError("native disk tuple must contain only its proven native limit and writable tmpfs bound");
  } else {
    if (input.ticketQuotaBytes === undefined || input.bridgeQuotaBytes === undefined || input.writableTmpfsBytes === undefined) throw new SandboxIdentityError("quota-composed disk tuple requires all writable-surface quotas");
    if (bridgeQuotaBytes !== undefined && input.bridgeQuotaBytes !== bridgeQuotaBytes) throw new SandboxIdentityError("disk bridge quota does not match bridge identity");
    if (input.nativeLimitBytes !== undefined) throw new SandboxIdentityError("quota-composed tuple cannot claim a native disk limit");
  }
}

function normalizeRetention(input: SandboxRetentionSpec): SandboxRetentionSpec {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input as unknown as Record<string, unknown>).sort().join("\0") !== "artifactUntil\0failureUntil\0successUntil") throw new SandboxIdentityError("retention fields are not closed");
  for (const [label, value] of Object.entries(input)) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new SandboxIdentityError(`${label} retention deadline is invalid`);
  }
  if (Date.parse(input.failureUntil) < Date.parse(input.successUntil) || Date.parse(input.artifactUntil) < Date.parse(input.failureUntil)) throw new SandboxIdentityError("retention deadlines are not monotonic");
  return { successUntil: input.successUntil, failureUntil: input.failureUntil, artifactUntil: input.artifactUntil };
}

function isEvidencePath(value: unknown): value is string { return typeof value === "string" && value.length <= 1_024 && /^(?:artifacts|evidence)(?:\/[A-Za-z0-9._-]+)+$/u.test(value) && value.split("/").every(part => part !== "." && part !== ".."); }

export function isSandboxEvidenceSchemaId(value: unknown, kind: "disk proof" | "resource" | "host evidence" = "host evidence"): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 300 || !/^urn:squire:sandbox:v1:[a-z][a-z0-9-]{0,63}$/u.test(value)) return false;
  if (kind === "disk proof") return value === SANDBOX_DISK_PROOF_SCHEMA_ID || value === SANDBOX_RESOURCE_EVIDENCE_SCHEMA_ID;
  if (kind === "resource") return value === SANDBOX_RESOURCE_EVIDENCE_SCHEMA_ID;
  return value === SANDBOX_HOST_EVIDENCE_SCHEMA_ID;
}

function positiveBytes(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 4096 || value > 107_374_182_400) throw new SandboxIdentityError(`${label} must be a bounded positive byte count`);
  return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function base32(bytes: Uint8Array): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

export function sameContractReference(left: ContractReference, right: ContractReference): boolean {
  return left.path === right.path && left.sha256 === right.sha256 && left.schemaId === right.schemaId;
}

export function isSafeSandboxNetworkHost(value: string): boolean {
  if (value.length < 1 || value.length > 255 || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(value) || value.includes("..")) return false;
  const labels = value.split(".");
  if (labels.some(label => label.length === 0 || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) return false;
  const lower = value.toLowerCase();
  // A policy hostname is not a loopback/private-link selector. Those routes
  // must remain denied even when a caller tries to smuggle them into an
  // allowlist; resolving DNS here would introduce a TOCTOU dependency.
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal") || lower === "host.docker.internal" || lower === "gateway.docker.internal" || lower === "metadata.google.internal") return false;
  if (labels.every(label => /^\d+$/u.test(label))) return false;
  return true;
}
