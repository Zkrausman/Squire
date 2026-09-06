import { randomUUID } from "node:crypto";
import type { ExternalAcceptanceProbeRequest, ExternalAcceptanceProbeResult } from "./domain.js";
import { assertArchitecture, assertPlatform, assertSandboxName, assertSandboxRunId, assertReleaseId, canonicalBytes, deriveSandboxName, isSandboxEvidenceSchemaId, sha256Bytes } from "./identity.js";

export const HOST_PROBE_NAMES = ["sbx-identity", "resource-enforcement", "disk-quota", "bridge-isolation", "mount-isolation", "principal-separation", "rootless-docker", "persistence", "network-audit", "credential-absence", "process-topology", "herdr-topology", "exact-removal"] as const;
export type HostProbeName = (typeof HOST_PROBE_NAMES)[number];

export class HostAcceptanceError extends Error {
  constructor(message: string) { super(message); this.name = "HostAcceptanceError"; }
}

/** Strict handoff to a trusted external worker. This module never executes a
 * host probe from inside a role sandbox and never turns an unavailable probe
 * into a passing result. */
export function buildHostProbeRequest(input: { readonly runId: string; readonly sandboxName: string; readonly releaseId: string; readonly platform: string; readonly architecture: string; readonly probes?: readonly HostProbeName[]; readonly requestedAt?: string }): ExternalAcceptanceProbeRequest {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input as unknown as Record<string, unknown>).some(key => !["architecture", "platform", "probes", "releaseId", "requestedAt", "runId", "sandboxName"].includes(key))) throw new HostAcceptanceError("host acceptance request input is not closed");
  assertSandboxRunId(input.runId); assertSandboxName(input.sandboxName); if (input.sandboxName !== deriveSandboxName(input.runId)) throw new HostAcceptanceError("host acceptance sandbox name is not derived from the run"); assertReleaseId(input.releaseId);
  if (input.probes !== undefined && !Array.isArray(input.probes)) throw new HostAcceptanceError("host acceptance probe list is not an array");
  const probes = [...(input.probes ?? HOST_PROBE_NAMES)];
  if (probes.length === 0 || probes.length > HOST_PROBE_NAMES.length || new Set(probes).size !== probes.length || probes.some(probe => typeof probe !== "string" || !HOST_PROBE_NAMES.includes(probe as HostProbeName))) throw new HostAcceptanceError("host acceptance probe list is not closed");
  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(input.platform) || !/^[a-z][a-z0-9._-]{0,31}$/u.test(input.architecture)) throw new HostAcceptanceError("host acceptance platform identity is invalid");
  const requestedAt = input.requestedAt ?? new Date().toISOString(); if (!canonicalDate(requestedAt)) throw new HostAcceptanceError("host acceptance request time is invalid");
  return Object.freeze({ schemaVersion: 1, kind: "squire-sandbox-host-probe-request", requestId: randomUUID(), runId: input.runId, sandboxName: input.sandboxName, releaseId: input.releaseId, platform: input.platform, architecture: input.architecture, probes: Object.freeze(probes), requestedAt });
}

export function validateHostProbeRequest(value: unknown): ExternalAcceptanceProbeRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostAcceptanceError("host acceptance request is not an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== ["architecture", "kind", "platform", "probes", "releaseId", "requestId", "requestedAt", "runId", "sandboxName", "schemaVersion"].join("\0") || record["schemaVersion"] !== 1 || record["kind"] !== "squire-sandbox-host-probe-request" || typeof record["requestId"] !== "string" || !Array.isArray(record["probes"]) || typeof record["runId"] !== "string" || typeof record["sandboxName"] !== "string" || typeof record["releaseId"] !== "string" || typeof record["platform"] !== "string" || typeof record["architecture"] !== "string" || typeof record["requestedAt"] !== "string") throw new HostAcceptanceError("host acceptance request is not closed");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(String(record["requestId"]))) throw new HostAcceptanceError("host acceptance request ID is invalid");
  assertPlatform(String(record["platform"])); assertArchitecture(String(record["architecture"]));
  const request = buildHostProbeRequest({ runId: String(record["runId"]), sandboxName: String(record["sandboxName"]), releaseId: String(record["releaseId"]), platform: String(record["platform"]), architecture: String(record["architecture"]), probes: record["probes"] as HostProbeName[], requestedAt: String(record["requestedAt"]) });
  return Object.freeze({ ...request, requestId: record["requestId"] as string });
}

export function validateHostProbeResult(value: unknown, request: ExternalAcceptanceProbeRequest): ExternalAcceptanceProbeResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HostAcceptanceError("host acceptance result is not an object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== ["architecture", "completedAt", "evidence", "hostOnly", "kind", "platform", "releaseId", "requestId", "runId", "sandboxName", "schemaVersion", "status"].sort().join("\0") || record["schemaVersion"] !== 1 || record["kind"] !== "squire-sandbox-host-probe-result" || record["requestId"] !== request.requestId || record["runId"] !== request.runId || record["sandboxName"] !== request.sandboxName || record["releaseId"] !== request.releaseId || record["platform"] !== request.platform || record["architecture"] !== request.architecture || typeof record["requestId"] !== "string" || typeof record["runId"] !== "string" || typeof record["sandboxName"] !== "string" || typeof record["releaseId"] !== "string" || typeof record["platform"] !== "string" || typeof record["architecture"] !== "string" || record["hostOnly"] !== true || !["pass", "fail"].includes(String(record["status"])) || !Array.isArray(record["evidence"]) || record["evidence"].length > 128 || record["evidence"].some(item => !isReference(item))) throw new HostAcceptanceError("host acceptance result is not a strict request-bound artifact");
  if (record["status"] === "pass" && !request.probes.length) throw new HostAcceptanceError("a passing host acceptance result cannot have an empty request");
  const evidence = record["evidence"] as unknown[];
  if (new Set(evidence.map(item => (item as Record<string, unknown>)["path"])).size !== evidence.length) throw new HostAcceptanceError("host acceptance evidence references are not unique");
  if (record["status"] === "pass" && evidence.length !== request.probes.length) throw new HostAcceptanceError("passing host acceptance must contain exactly one evidence reference per requested probe");
  if (typeof record["completedAt"] !== "string" || !canonicalDate(record["completedAt"]) || Date.parse(record["completedAt"]) < Date.parse(request.requestedAt)) throw new HostAcceptanceError("host acceptance completion time is invalid");
  return record as unknown as ExternalAcceptanceProbeResult;
}

export function hostProbeArtifactDigest(result: ExternalAcceptanceProbeResult): string { return sha256Bytes(canonicalBytes(result)); }
function isReference(value: unknown): boolean { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const item = value as Record<string, unknown>; const pathValue = item["path"]; return Object.keys(item).sort().join("\0") === ["path", "schemaId", "sha256"].join("\0") && typeof pathValue === "string" && pathValue.length <= 1_024 && /^(?:artifacts|evidence)(?:\/[A-Za-z0-9._-]+)+$/u.test(pathValue) && pathValue.split("/").every(part => part !== "." && part !== "..") && typeof item["sha256"] === "string" && /^[0-9a-f]{64}$/u.test(item["sha256"]) && isSandboxEvidenceSchemaId(item["schemaId"], "host evidence"); }
function canonicalDate(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
void validateHostProbeResult;
