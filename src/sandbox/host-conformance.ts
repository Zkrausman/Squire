import { randomUUID } from "node:crypto";
import path from "node:path";
import { assertArchitecture, assertPlatform, assertReleaseId, assertSandboxName, assertSandboxRunId, canonicalBytes, canonicalJson, deriveSandboxName, isSandboxEvidenceSchemaId, sha256Bytes, SHA256_PATTERN } from "./identity.js";
import type { HostProbeName } from "./host-acceptance.js";

export const HOST_CONFORMANCE_SCHEMA_ID = "urn:squire:sandbox:v1:host-conformance" as const;
export const HOST_OBSERVER_REQUEST_KIND = "squire-sandbox-host-observer-request" as const;
export const HOST_OBSERVER_RESULT_KIND = "squire-sandbox-host-observer-result" as const;
export const HOST_CONFORMANCE_EVIDENCE_KIND = "squire-sandbox-host-conformance-evidence" as const;
export const HOST_OBSERVER_PHASES = ["created", "running", "restarted", "removed"] as const;
export type HostObserverPhase = (typeof HOST_OBSERVER_PHASES)[number];

export interface HostObserverIdentity {
  readonly sandboxId: string;
  readonly vmId: string;
  readonly bootId: string;
  readonly templateDigest: string;
}

export interface HostObserverPaths {
  readonly stateRoot: string;
  readonly bridgePath: string;
  readonly evidenceRoot: string;
}

export interface HostObserverRequest {
  readonly schemaVersion: 1;
  readonly kind: typeof HOST_OBSERVER_REQUEST_KIND;
  readonly requestId: string;
  readonly parentRequestId: string;
  readonly runId: string;
  readonly sandboxName: string;
  readonly releaseId: string;
  readonly platform: string;
  readonly architecture: string;
  readonly probe: HostProbeName;
  readonly phase: HostObserverPhase;
  readonly identity: HostObserverIdentity;
  readonly paths: HostObserverPaths;
  readonly requestedAt: string;
}

export interface HostObserverInput {
  readonly schemaVersion: 1;
  readonly kind: "squire-sandbox-host-observer-input";
  readonly requestId: string;
  readonly parentRequestId: string;
  readonly runId: string;
  readonly sandboxName: string;
  readonly releaseId: string;
  readonly platform: string;
  readonly architecture: string;
  readonly probe: HostProbeName;
  readonly phase: HostObserverPhase;
  readonly identity: HostObserverIdentity;
  readonly context: {
    readonly releaseId: string;
    readonly templateDigest: string;
    readonly networkProfileDigest: string;
    readonly resourceTupleId: string;
    readonly bridgeQuotaBytes: number;
  };
  readonly observations: Readonly<Record<string, unknown>>;
  readonly evidence: { readonly path: string; readonly sha256: string };
  readonly completedAt: string;
}

export interface HostObserverResult {
  readonly schemaVersion: 1;
  readonly kind: typeof HOST_OBSERVER_RESULT_KIND;
  readonly requestId: string;
  readonly parentRequestId: string;
  readonly runId: string;
  readonly sandboxName: string;
  readonly releaseId: string;
  readonly platform: string;
  readonly architecture: string;
  readonly probe: HostProbeName;
  readonly phase: HostObserverPhase;
  readonly identity: HostObserverIdentity;
  readonly status: "pass" | "fail";
  readonly hostOnly: true;
  readonly observations: Readonly<Record<string, unknown>>;
  readonly completedAt: string;
}

export interface HostConformanceEvidence {
  readonly schemaVersion: 1;
  readonly kind: typeof HOST_CONFORMANCE_EVIDENCE_KIND;
  readonly requestId: string;
  readonly parentRequestId: string;
  readonly runId: string;
  readonly sandboxName: string;
  readonly releaseId: string;
  readonly platform: string;
  readonly architecture: string;
  readonly probe: HostProbeName;
  readonly phase: HostObserverPhase;
  readonly identity: HostObserverIdentity;
  readonly status: "pass";
  readonly hostOnly: true;
  readonly observations: Readonly<Record<string, unknown>>;
  readonly observedAt: string;
}

export class HostConformanceError extends Error {
  constructor(message: string) { super(message); this.name = "HostConformanceError"; }
}

export function buildHostObserverRequest(input: {
  readonly parentRequestId: string;
  readonly runId: string;
  readonly sandboxName: string;
  readonly releaseId: string;
  readonly platform: string;
  readonly architecture: string;
  readonly probe: HostProbeName;
  readonly phase: HostObserverPhase;
  readonly identity: HostObserverIdentity;
  readonly paths: HostObserverPaths;
  readonly requestedAt?: string;
}): HostObserverRequest {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input as Record<string, unknown>).some(key => !["architecture", "identity", "parentRequestId", "paths", "phase", "platform", "probe", "releaseId", "requestedAt", "runId", "sandboxName"].includes(key))) throw new HostConformanceError("host observer request input is not closed");
  assertSandboxRunId(input.runId); assertSandboxName(input.sandboxName); assertReleaseId(input.releaseId); assertPlatform(input.platform); assertArchitecture(input.architecture);
  if (input.sandboxName !== deriveSandboxName(input.runId)) throw new HostConformanceError("host observer request sandbox identity is not derived from the run");
  assertRequestId(input.parentRequestId, "parent request ID");
  assertProbe(input.probe); assertPhase(input.phase);
  const identity = validateIdentity(input.identity);
  const paths = validatePaths(input.paths);
  const requestedAt = input.requestedAt ?? new Date().toISOString();
  assertCanonicalDate(requestedAt, "host observer request time");
  return Object.freeze({ schemaVersion: 1, kind: HOST_OBSERVER_REQUEST_KIND, requestId: randomUUID(), parentRequestId: input.parentRequestId, runId: input.runId, sandboxName: input.sandboxName, releaseId: input.releaseId, platform: input.platform, architecture: input.architecture, probe: input.probe, phase: input.phase, identity, paths, requestedAt });
}

export function validateHostObserverRequest(value: unknown): HostObserverRequest {
  const record = asRecord(value, "host observer request");
  assertExactKeys(record, ["architecture", "identity", "kind", "parentRequestId", "paths", "phase", "platform", "probe", "requestId", "requestedAt", "releaseId", "runId", "sandboxName", "schemaVersion"], "host observer request");
  if (record["schemaVersion"] !== 1 || record["kind"] !== HOST_OBSERVER_REQUEST_KIND) throw new HostConformanceError("host observer request kind/version is invalid");
  assertRequestId(record["requestId"], "request ID");
  const request = buildHostObserverRequest({ parentRequestId: String(record["parentRequestId"]), runId: String(record["runId"]), sandboxName: String(record["sandboxName"]), releaseId: String(record["releaseId"]), platform: String(record["platform"]), architecture: String(record["architecture"]), probe: record["probe"] as HostProbeName, phase: record["phase"] as HostObserverPhase, identity: record["identity"] as HostObserverIdentity, paths: record["paths"] as HostObserverPaths, requestedAt: String(record["requestedAt"]) });
  return Object.freeze({ ...request, requestId: String(record["requestId"]) });
}

export function validateHostObserverInput(value: unknown): HostObserverInput {
  const record = asRecord(value, "host observer input");
  assertExactKeys(record, ["architecture", "completedAt", "context", "evidence", "identity", "kind", "observations", "parentRequestId", "phase", "platform", "probe", "releaseId", "requestId", "runId", "sandboxName", "schemaVersion"], "host observer input");
  if (record["schemaVersion"] !== 1 || record["kind"] !== "squire-sandbox-host-observer-input" || !isRecord(record["observations"]) || !isRecord(record["evidence"])) throw new HostConformanceError("host observer input kind or shape is invalid");
  assertRequestId(record["requestId"], "host observer input request ID"); assertRequestId(record["parentRequestId"], "host observer input parent request ID"); assertSandboxRunId(String(record["runId"])); assertSandboxName(String(record["sandboxName"])); assertReleaseId(String(record["releaseId"])); assertPlatform(String(record["platform"])); assertArchitecture(String(record["architecture"])); if (String(record["sandboxName"]) !== deriveSandboxName(String(record["runId"]))) throw new HostConformanceError("host observer input sandbox identity is not derived from the run");
  assertProbe(record["probe"]); assertPhase(record["phase"]); validateIdentity(record["identity"]); const context = asRecord(record["context"], "host observer input context"); assertExactKeys(context, ["bridgeQuotaBytes", "networkProfileDigest", "releaseId", "resourceTupleId", "templateDigest"], "host observer input context"); if (context["releaseId"] !== record["releaseId"] || typeof context["templateDigest"] !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(context["templateDigest"]) || context["templateDigest"] !== (record["identity"] as Record<string, unknown>)["templateDigest"] || typeof context["networkProfileDigest"] !== "string" || !SHA256_PATTERN.test(context["networkProfileDigest"]) || typeof context["resourceTupleId"] !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/u.test(context["resourceTupleId"]) || !Number.isSafeInteger(context["bridgeQuotaBytes"]) || context["bridgeQuotaBytes"] < 4096 || context["bridgeQuotaBytes"] > 107_374_182_400) throw new HostConformanceError("host observer input context is not exact"); assertBoundedJson(record["observations"]); if ((record["observations"] as Record<string, unknown>)["verified"] !== true || (record["observations"] as Record<string, unknown>)["authentication"] !== "trusted-host") throw new HostConformanceError("host observer input lacks authenticated trusted-host observations"); assertCanonicalDate(record["completedAt"], "host observer input completion time");
  const evidence = record["evidence"] as Record<string, unknown>; assertExactKeys(evidence, ["path", "sha256"], "host observer input evidence"); if (typeof evidence["path"] !== "string" || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u.test(evidence["path"]) || evidence["path"].includes("..") || typeof evidence["sha256"] !== "string" || !SHA256_PATTERN.test(evidence["sha256"])) throw new HostConformanceError("host observer input evidence is invalid");
  return record as unknown as HostObserverInput;
}

export function validateHostObserverResult(value: unknown, request?: HostObserverRequest): HostObserverResult {
  assertObserverResultShape(value);
  const record = value as unknown as HostObserverResult;
  if (request) {
    if (record.requestId !== request.requestId || record.parentRequestId !== request.parentRequestId || record.runId !== request.runId || record.sandboxName !== request.sandboxName || record.releaseId !== request.releaseId || record.platform !== request.platform || record.architecture !== request.architecture || record.probe !== request.probe || record.phase !== request.phase || canonicalJson(record.identity) !== canonicalJson(request.identity)) throw new HostConformanceError("host observer result identity does not match its request");
    if (Date.parse(record.completedAt) < Date.parse(request.requestedAt)) throw new HostConformanceError("host observer completion precedes its request");
  }
  return record;
}

export function buildHostConformanceEvidence(result: HostObserverResult, observedAt = new Date().toISOString()): HostConformanceEvidence {
  assertObserverResultShape(result);
  assertCanonicalDate(observedAt, "host evidence observation time");
  return Object.freeze({ schemaVersion: 1, kind: HOST_CONFORMANCE_EVIDENCE_KIND, requestId: result.requestId, parentRequestId: result.parentRequestId, runId: result.runId, sandboxName: result.sandboxName, releaseId: result.releaseId, platform: result.platform, architecture: result.architecture, probe: result.probe, phase: result.phase, identity: result.identity, status: "pass", hostOnly: true, observations: result.observations, observedAt });
}

export function hostConformanceEvidenceDigest(value: HostConformanceEvidence): string {
  validateHostConformanceEvidence(value);
  return sha256Bytes(canonicalBytes(value));
}

export function validateHostConformanceEvidence(value: unknown): HostConformanceEvidence {
  const record = asRecord(value, "host conformance evidence");
  assertExactKeys(record, ["architecture", "identity", "kind", "observations", "observedAt", "parentRequestId", "phase", "platform", "probe", "releaseId", "requestId", "runId", "sandboxName", "schemaVersion", "status", "hostOnly"], "host conformance evidence");
  if (record["schemaVersion"] !== 1 || record["kind"] !== HOST_CONFORMANCE_EVIDENCE_KIND || record["status"] !== "pass" || record["hostOnly"] !== true || !isRecord(record["observations"])) throw new HostConformanceError("host conformance evidence is not a passing host-only record");
  assertRequestId(record["requestId"], "evidence request ID"); assertRequestId(record["parentRequestId"], "evidence parent request ID"); assertSandboxRunId(String(record["runId"])); assertSandboxName(String(record["sandboxName"])); assertReleaseId(String(record["releaseId"])); assertPlatform(String(record["platform"])); assertArchitecture(String(record["architecture"])); assertProbe(record["probe"]); assertPhase(record["phase"]); validateIdentity(record["identity"]); assertCanonicalDate(record["observedAt"], "host evidence time"); assertBoundedJson(record["observations"]); if ((record["observations"] as Record<string, unknown>)["verified"] !== true || (record["observations"] as Record<string, unknown>)["authentication"] !== "trusted-host") throw new HostConformanceError("host conformance evidence lacks authenticated trusted-host observations");
  return record as unknown as HostConformanceEvidence;
}

function assertObserverResultShape(value: unknown): asserts value is HostObserverResult {
  const record = asRecord(value, "host observer result");
  assertExactKeys(record, ["architecture", "completedAt", "hostOnly", "identity", "kind", "observations", "parentRequestId", "phase", "platform", "probe", "releaseId", "requestId", "runId", "sandboxName", "schemaVersion", "status"], "host observer result");
  if (record["schemaVersion"] !== 1 || record["kind"] !== HOST_OBSERVER_RESULT_KIND || record["hostOnly"] !== true || record["status"] !== "pass" || !isRecord(record["observations"])) throw new HostConformanceError("host observer result is not a passing host-only result");
  assertRequestId(record["requestId"], "observer result request ID"); assertRequestId(record["parentRequestId"], "observer result parent request ID"); assertSandboxRunId(String(record["runId"])); assertSandboxName(String(record["sandboxName"])); assertReleaseId(String(record["releaseId"])); assertPlatform(String(record["platform"])); assertArchitecture(String(record["architecture"])); assertProbe(record["probe"]); assertPhase(record["phase"]); validateIdentity(record["identity"]); assertCanonicalDate(record["completedAt"], "host observer completion time"); assertBoundedJson(record["observations"]); if ((record["observations"] as Record<string, unknown>)["verified"] !== true || (record["observations"] as Record<string, unknown>)["authentication"] !== "trusted-host") throw new HostConformanceError("host observer result lacks authenticated trusted-host observations");
}

function validateIdentity(value: unknown): HostObserverIdentity {
  const record = asRecord(value, "host observer identity");
  assertExactKeys(record, ["bootId", "sandboxId", "templateDigest", "vmId"], "host observer identity");
  for (const key of ["sandboxId", "vmId", "bootId"] as const) if (typeof record[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(record[key])) throw new HostConformanceError(`host observer ${key} is invalid`);
  if (typeof record["templateDigest"] !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(record["templateDigest"])) throw new HostConformanceError("host observer template digest is invalid");
  return { sandboxId: record["sandboxId"], vmId: record["vmId"], bootId: record["bootId"], templateDigest: record["templateDigest"] };
}

function validatePaths(value: unknown): HostObserverPaths {
  const record = asRecord(value, "host observer paths");
  assertExactKeys(record, ["bridgePath", "evidenceRoot", "stateRoot"], "host observer paths");
  for (const key of ["stateRoot", "bridgePath", "evidenceRoot"] as const) if (!isCanonicalHostPath(record[key])) throw new HostConformanceError(`host observer ${key} is not a canonical host path`);
  return { stateRoot: record["stateRoot"], bridgePath: record["bridgePath"], evidenceRoot: record["evidenceRoot"] };
}

function assertProbe(value: unknown): asserts value is HostProbeName { if (typeof value !== "string" || !["sbx-identity", "resource-enforcement", "disk-quota", "bridge-isolation", "mount-isolation", "principal-separation", "rootless-docker", "persistence", "network-audit", "credential-absence", "process-topology", "herdr-topology", "exact-removal"].includes(value)) throw new HostConformanceError("host observer probe is not allowlisted"); }
function assertPhase(value: unknown): asserts value is HostObserverPhase { if (typeof value !== "string" || !HOST_OBSERVER_PHASES.includes(value as HostObserverPhase)) throw new HostConformanceError("host observer phase is not allowlisted"); }
function assertRequestId(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) throw new HostConformanceError(`${label} is invalid`); }
function assertCanonicalDate(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new HostConformanceError(`${label} is invalid`); }
function assertExactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void { if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) throw new HostConformanceError(`${label} fields are not closed`); }
function asRecord(value: unknown, label: string): Record<string, any> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostConformanceError(`${label} is not an object`); return value as Record<string, any>; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function isCanonicalHostPath(value: unknown): value is string { return typeof value === "string" && value.length > 1 && value.length <= 4_096 && path.isAbsolute(value) && path.resolve(value) === value && value !== path.parse(value).root && !value.endsWith(path.sep) && !value.includes("//") && !value.includes("\\") && !value.split(path.sep).some(part => part === "." || part === "..") && !/[\u0000-\u001f\u007f\r\n]/u.test(value); }
function assertBoundedJson(value: unknown, depth = 0, nodes = { count: 0 }): void {
  if (depth > 24 || ++nodes.count > 10_000) throw new HostConformanceError("host observations exceed their structural bound");
  if (value === null || typeof value === "string" || typeof value === "boolean") { if (typeof value === "string" && value.length > 64 * 1024) throw new HostConformanceError("host observation string exceeds its bound"); return; }
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new HostConformanceError("host observation number is not finite"); return; }
  if (!value || typeof value !== "object") throw new HostConformanceError("host observations contain an unsupported value");
  if (Array.isArray(value)) { if (value.length > 4_096) throw new HostConformanceError("host observation array exceeds its bound"); for (const item of value) assertBoundedJson(item, depth + 1, nodes); return; }
  const record = value as Record<string, unknown>; if (Object.keys(record).length > 512) throw new HostConformanceError("host observation object exceeds its bound"); for (const [key, item] of Object.entries(record)) { if (key.length > 256 || /[\u0000-\u001f\u007f]/u.test(key)) throw new HostConformanceError("host observation key is invalid"); assertBoundedJson(item, depth + 1, nodes); }
}

void SHA256_PATTERN; void canonicalJson; void isSandboxEvidenceSchemaId;
