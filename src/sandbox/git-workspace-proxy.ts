import { ROLES, type ContractReference, type Role } from "../control/domain.js";
import type { GitObjectFormat, ReadyGitWorkspace } from "../git/domain.js";
import type { GuestOperationClient } from "./guest-protocol.js";
import { assertCanonicalSandboxPath, assertSandboxName, assertSandboxRunId, assertSha256, deriveSandboxName } from "./identity.js";

export interface SandboxImmutableBundleImportDescriptor {
  readonly runId: string;
  readonly sandboxName: string;
  readonly spec: ContractReference;
  readonly importPath: "/ticket/import/repository-seed.bundle";
  readonly byteLength: number;
  readonly sha256: string;
  readonly objectFormat: GitObjectFormat;
  readonly baseSha: string;
  readonly repository: "/ticket/git/repo.git";
  readonly baseBranch: string;
  readonly controllerOnly: true;
  readonly localTransport: false;
}
export interface SandboxGitWorkspaceProxyPort {
  importImmutableBundle(descriptor: SandboxImmutableBundleImportDescriptor, signal?: AbortSignal): Promise<ReadyGitWorkspace>;
  readonly role: Role;
}
export class SandboxGitWorkspaceProxyError extends Error {
  constructor(message: string) { super(message); this.name = "SandboxGitWorkspaceProxyError"; }
}

/** Guest-side adapter seam for AIDEV-222. The actual GitWorkspaceService is
 * constructed by the measured guest worker; this object only sends a closed
 * descriptor and validates the normal ReadyGitWorkspace result before it can
 * cross the trust boundary. */
export class SandboxGitWorkspaceProxy implements SandboxGitWorkspaceProxyPort {
  readonly #channel: GuestOperationClient;
  readonly role: Role;
  constructor(channel: GuestOperationClient, role: Role = "orchestrator") {
    if (!channel || typeof channel.invoke !== "function" || !ROLES.includes(role)) throw new SandboxGitWorkspaceProxyError("sandbox Git proxy requires a closed guest channel and role");
    this.#channel = channel;
    this.role = role;
  }

  async importImmutableBundle(descriptor: SandboxImmutableBundleImportDescriptor, signal?: AbortSignal): Promise<ReadyGitWorkspace> {
    validateDescriptor(descriptor);
    if (signal?.aborted) throw new SandboxGitWorkspaceProxyError("sandbox Git import was aborted");
    const result = await this.#channel.invoke("import", { kind: "aidev-222-immutable-bundle", descriptor }, signal);
    return validateReadyGitWorkspace(result, descriptor.runId);
  }
}

export function createSandboxGitWorkspaceProxy(channel: GuestOperationClient, role?: Role): SandboxGitWorkspaceProxy {
  return new SandboxGitWorkspaceProxy(channel, role);
}

function validateDescriptor(value: SandboxImmutableBundleImportDescriptor): void {
  const record = asRecord(value);
  const keys = ["baseBranch", "baseSha", "byteLength", "controllerOnly", "importPath", "localTransport", "objectFormat", "repository", "runId", "sandboxName", "sha256", "spec"];
  const spec = record ? asRecord(record["spec"]) : undefined;
  if (!record || !hasExactKeys(record, keys) || !spec) throw new SandboxGitWorkspaceProxyError("Git import descriptor is not a closed object");
  const runId = record["runId"];
  const sandboxName = record["sandboxName"];
  const importPath = record["importPath"];
  assertSandboxRunId(String(runId));
  assertSandboxName(String(sandboxName));
  assertCanonicalSandboxPath(String(importPath), "Git import path");
  if (sandboxName !== deriveSandboxName(String(runId)) || importPath !== "/ticket/import/repository-seed.bundle" || record["repository"] !== "/ticket/git/repo.git" || record["controllerOnly"] !== true || record["localTransport"] !== false || !hasExactKeys(spec, ["path", "schemaId", "sha256"]) || spec["path"] !== `artifacts/git/${runId}/workspace-spec.json` || typeof spec["sha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(spec["sha256"]) || spec["schemaId"] !== "urn:squire:git-workspace:v1:workspace-spec") throw new SandboxGitWorkspaceProxyError("Git import descriptor is not controller-only and fixed");
  if (!Number.isSafeInteger(record["byteLength"]) || Number(record["byteLength"]) <= 0 || Number(record["byteLength"]) > 536_870_912) throw new SandboxGitWorkspaceProxyError("Git import length is invalid");
  if (typeof record["sha256"] !== "string") throw new SandboxGitWorkspaceProxyError("Git import digest is malformed");
  assertSha256(record["sha256"], "Git import digest");
  const objectFormat = record["objectFormat"];
  const oidLength = objectFormat === "sha1" ? 40 : objectFormat === "sha256" ? 64 : 0;
  if (!oidLength || typeof record["baseSha"] !== "string" || !new RegExp(`^[0-9a-f]{${oidLength}}$`, "u").test(record["baseSha"]) || typeof record["baseBranch"] !== "string" || !/^[A-Za-z0-9._/-]{1,255}$/u.test(record["baseBranch"]) || record["baseBranch"].includes("..")) throw new SandboxGitWorkspaceProxyError("Git import base identity is invalid");
}

function validateReadyGitWorkspace(value: unknown, runId: string): ReadyGitWorkspace {
  const record = asRecord(value);
  const keys = ["featureBranch", "headSha", "manifest", "objectFormat", "paths", "runId", "spec"];
  if (record && Object.hasOwn(record, "bundle")) keys.push("bundle");
  const spec = record ? asRecord(record["spec"]) : undefined;
  const manifest = record ? asRecord(record["manifest"]) : undefined;
  const paths = record ? asRecord(record["paths"]) : undefined;
  if (!record || !hasExactKeys(record, keys) || record["runId"] !== runId || !spec || !manifest || !paths) throw new SandboxGitWorkspaceProxyError("guest Git workspace result is not a closed object");
  const expectedSpecPath = `artifacts/git/${runId}/workspace-spec.json`;
  const expectedManifestPath = `artifacts/git/${runId}/workspace-manifest.json`;
  assertReference(spec, expectedSpecPath, "urn:squire:git-workspace:v1:workspace-spec");
  assertReference(manifest, expectedManifestPath, "urn:squire:git-workspace:v1:workspace-manifest");
  const objectFormat = record["objectFormat"];
  if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new SandboxGitWorkspaceProxyError("guest Git workspace object format is invalid");
  const oidLength = objectFormat === "sha1" ? 40 : 64;
  if (typeof record["headSha"] !== "string" || !new RegExp(`^[0-9a-f]{${oidLength}}$`, "u").test(record["headSha"]) || typeof record["featureBranch"] !== "string" || !new RegExp(`^squire/[a-z][a-z0-9]+-[1-9][0-9]*-${runId}$`, "u").test(record["featureBranch"]) || !hasExactKeys(paths, ["artifactRoot", "controlRoot", "repository", "worktree"]) || paths["repository"] !== "/ticket/git/repo.git" || paths["worktree"] !== "/ticket/workspace" || paths["artifactRoot"] !== `artifacts/git/${runId}` || paths["controlRoot"] !== `control/git/${runId}`) throw new SandboxGitWorkspaceProxyError("guest Git workspace paths or head identity is not fixed");
  if (Object.hasOwn(record, "bundle")) assertBundle(record["bundle"], runId, objectFormat, record["featureBranch"], record["headSha"]);
  return deepFreeze(structuredClone(record)) as unknown as ReadyGitWorkspace;
}

function assertReference(value: Record<string, unknown>, pathValue: string, schemaId: string): void {
  if (!hasExactKeys(value, ["path", "schemaId", "sha256"]) || value["path"] !== pathValue || value["schemaId"] !== schemaId || typeof value["sha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(value["sha256"])) throw new SandboxGitWorkspaceProxyError("guest Git contract reference is malformed");
}

function assertBundle(value: unknown, runId: string, objectFormat: GitObjectFormat, branch: unknown, headSha: unknown): void {
  const record = asRecord(value);
  const keys = ["baseSha", "bundlePath", "byteLength", "exportGeneration", "featureBranch", "headSha", "manifest", "objectFormat", "resource", "sha256"];
  const manifest = record ? asRecord(record["manifest"]) : undefined;
  const resource = record ? asRecord(record["resource"]) : undefined;
  if (!record || !hasExactKeys(record, keys) || record["featureBranch"] !== branch || record["headSha"] !== headSha || record["objectFormat"] !== objectFormat || record["bundlePath"] !== `artifacts/git/${runId}/${headSha}.bundle` || !Number.isSafeInteger(record["byteLength"]) || Number(record["byteLength"]) <= 0 || Number(record["byteLength"]) > 536_870_912 || !Number.isSafeInteger(record["exportGeneration"]) || Number(record["exportGeneration"]) < 1 || typeof record["baseSha"] !== "string" || !new RegExp(`^[0-9a-f]{${objectFormat === "sha1" ? 40 : 64}}$`, "u").test(record["baseSha"]) || typeof record["sha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(record["sha256"]) || !manifest || !resource) throw new SandboxGitWorkspaceProxyError("guest Git bundle result is malformed");
  assertReference(manifest, `artifacts/git/${runId}/bundle-manifest.json`, "urn:squire:git-workspace:v1:bundle-manifest");
  if (!hasExactKeys(resource, ["device", "inode", "kind", "linkCount", "mode", "path"]) || resource["kind"] !== "file" || resource["path"] !== `/ticket/artifacts/git/${runId}/${headSha}.bundle` || typeof resource["device"] !== "string" || typeof resource["inode"] !== "string" || resource["device"].length === 0 || resource["inode"].length === 0 || !Number.isSafeInteger(resource["mode"]) || Number(resource["mode"]) < 0 || Number(resource["mode"]) > 0o777 || (Number(resource["mode"]) & 0o222) !== 0 || resource["linkCount"] !== 1) throw new SandboxGitWorkspaceProxyError("guest Git bundle resource identity is malformed");
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function asRecord(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T { if (!value || typeof value !== "object" || seen.has(value as object)) return value; seen.add(value as object); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen); return Object.freeze(value); }
