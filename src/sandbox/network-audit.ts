import type { ContractReference } from "../control/domain.js";
import type { SandboxNetworkMode } from "./domain.js";
import { assertSandboxName, assertSandboxRunId, assertSha256, canonicalJson, deriveSandboxName, isSafeSandboxNetworkHost, isSandboxEvidenceSchemaId, sha256Bytes } from "./identity.js";

export interface SandboxNetworkAuditRequest {
  readonly runId: string;
  readonly sandboxName: string;
  readonly sandboxId: string;
  readonly correlationId: string;
  readonly profileDigest: string;
  readonly mode: SandboxNetworkMode;
  readonly allowedHosts: readonly string[];
}
export interface SandboxNetworkAuditResult {
  readonly request: SandboxNetworkAuditRequest;
  readonly allowedHttps: { readonly correlationId: string; readonly succeeded: boolean; readonly attributedSandbox: string };
  readonly denied: readonly { readonly target: string; readonly protocol: "udp" | "icmp" | "tcp"; readonly denied: boolean; readonly attributedSandbox: string }[];
  readonly hostObservation: ContractReference;
  readonly hostOnly: true;
}
export interface SandboxNetworkAuditPort { audit(request: SandboxNetworkAuditRequest, signal?: AbortSignal): Promise<SandboxNetworkAuditResult> }

export class SandboxNetworkAuditError extends Error {
  constructor(message: string) { super(message); this.name = "SandboxNetworkAuditError"; }
}

/** Host-only network evidence port. The role/guest may request a correlation
 * probe but cannot produce the authenticated policy/log observation. */
export function validateNetworkAuditResult(result: SandboxNetworkAuditResult): void {
  if (!result || typeof result !== "object" || !hasExactKeys(result as unknown as Record<string, unknown>, ["allowedHttps", "denied", "hostObservation", "hostOnly", "request"]) || !result.request || !result.allowedHttps || !Array.isArray(result.denied) || !result.hostObservation || result.hostOnly !== true) throw new SandboxNetworkAuditError("host network audit result is not a closed object");
  const request = result.request;
  if (!hasExactKeys(request as unknown as Record<string, unknown>, ["allowedHosts", "correlationId", "mode", "profileDigest", "runId", "sandboxId", "sandboxName"]) || !hasExactKeys(result.allowedHttps as unknown as Record<string, unknown>, ["attributedSandbox", "correlationId", "succeeded"]) || !hasExactKeys(result.hostObservation as unknown as Record<string, unknown>, ["path", "schemaId", "sha256"])) throw new SandboxNetworkAuditError("host network audit result contains unknown fields");
  assertSandboxRunId(request.runId); assertSandboxName(request.sandboxName);
  if (request.sandboxName !== deriveSandboxName(request.runId) || typeof request.sandboxId !== "string" || request.sandboxId.length === 0 || request.sandboxId.length > 512 || /[\u0000-\u001f\u007f\r\n:]/u.test(request.sandboxId) || typeof request.correlationId !== "string" || !/^[A-Za-z0-9._-]{8,128}$/u.test(request.correlationId) || !["allow-all", "allowlist", "deny-all"].includes(request.mode) || !Array.isArray(request.allowedHosts) || request.allowedHosts.length > 128 || new Set(request.allowedHosts).size !== request.allowedHosts.length || request.allowedHosts.some(host => typeof host !== "string" || !isSafeSandboxNetworkHost(host)) || (request.mode !== "allowlist" && request.allowedHosts.length !== 0)) throw new SandboxNetworkAuditError("network audit request is not the closed effective policy");
  assertSha256(request.profileDigest, "network audit profile digest");
  if (request.profileDigest !== sha256Bytes(Buffer.from(canonicalJson({ mode: request.mode, allowedHosts: request.allowedHosts }), "utf8"))) throw new SandboxNetworkAuditError("network audit profile digest does not match its effective policy");
  if (typeof result.allowedHttps.correlationId !== "string" || result.allowedHttps.correlationId !== request.correlationId || result.allowedHttps.succeeded !== true || result.allowedHttps.attributedSandbox !== request.sandboxName) throw new SandboxNetworkAuditError("host network audit allowed HTTPS event is not attributed");
  const deniedProtocols = new Set(result.denied.map(item => item?.protocol));
  if (result.denied.length < 3 || result.denied.length > 64 || deniedProtocols.size !== 3 || !["udp", "icmp", "tcp"].every(protocol => deniedProtocols.has(protocol)) || new Set(result.denied.map(item => `${item?.protocol}:${item?.target}`)).size !== result.denied.length || result.denied.some(item => !item || !hasExactKeys(item as unknown as Record<string, unknown>, ["attributedSandbox", "denied", "protocol", "target"]) || typeof item.target !== "string" || item.target.length === 0 || item.target.length > 256 || /[\u0000-\u001f\u007f\r\n\s]/u.test(item.target) || !["udp", "icmp", "tcp"].includes(item.protocol) || item.denied !== true || item.attributedSandbox !== request.sandboxName)) throw new SandboxNetworkAuditError("host network audit result does not prove attributed denied events");
  if (typeof result.hostObservation.path !== "string" || result.hostObservation.path.startsWith("/") || !/^(?:artifacts|evidence)(?:\/[A-Za-z0-9._-]+)+$/u.test(result.hostObservation.path) || result.hostObservation.path.length > 1_024 || result.hostObservation.path.split("/").some(part => part === "." || part === "..") || !isSandboxEvidenceSchemaId(result.hostObservation.schemaId, "host evidence")) throw new SandboxNetworkAuditError("host network audit observation reference is not canonical");
  assertSha256(result.hostObservation.sha256, "host network audit evidence digest");
}
export function networkAuditDigest(result: SandboxNetworkAuditResult): string { validateNetworkAuditResult(result); return sha256Bytes(Buffer.from(canonicalJson(result), "utf8")); }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
