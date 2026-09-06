import { createHash } from "node:crypto";
import { assertRunId, assertTicketIdentifier, deriveFeatureBranch, assertRepositoryPart } from "../git/identity.js";
import { ROLES } from "../control/domain.js";

export interface RepositoryNamingIdentity { readonly owner: string; readonly name: string; }
export const INTAKE_CONTRACT_BRANCH_PATTERN = /^squire\/[a-z0-9][a-z0-9-]*\/run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const PHYSICAL_BRANCH_PATTERN = /^squire\/[a-z0-9][a-z0-9-]*-run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function deriveRunId(linearIssueId: string, repository: RepositoryNamingIdentity, idempotencyKey: string): string {
  assertUuid(linearIssueId, "Linear issue ID");
  assertRepositoryPart(repository.owner, "owner"); assertRepositoryPart(repository.name, "name");
  assertKey(idempotencyKey);
  const digest = createHash("sha256").update(linearIssueId, "utf8").update("\0").update(repository.owner, "utf8").update("/").update(repository.name, "utf8").update("\0").update(idempotencyKey, "utf8").digest("hex");
  const runId = `run_${digest}`;
  assertRunId(runId);
  return runId;
}
export function deriveContractFeatureBranch(ticketIdentifier: string, runId: string): string {
  assertTicketIdentifier(ticketIdentifier); assertRunId(runId);
  const branch = `squire/${ticketIdentifier.toLowerCase()}/${runId}`;
  if (!INTAKE_CONTRACT_BRANCH_PATTERN.test(branch) || branch.length > 255) throw new NamingError("normalized-ticket branch is invalid");
  return branch;
}
export function derivePhysicalFeatureBranch(ticketIdentifier: string, runId: string): string {
  return deriveFeatureBranch(ticketIdentifier, runId);
}
export function assertMatchingBranches(ticketIdentifier: string, runId: string, contractBranch: string, physicalBranch: string): void {
  if (contractBranch !== deriveContractFeatureBranch(ticketIdentifier, runId) || physicalBranch !== derivePhysicalFeatureBranch(ticketIdentifier, runId)) throw new NamingError("branch projections do not derive from the same ticket and run");
}

export interface ResourceNameInput { readonly ticketIdentifier: string; readonly runId: string; readonly role?: string; readonly provider?: string; }
export function deriveResourceDeterministicKey(kind: string, input: ResourceNameInput): string {
  assertKind(kind); assertTicketIdentifier(input.ticketIdentifier); assertRunId(input.runId);
  if (input.role !== undefined) assertSafeToken(input.role, "role");
  const suffix = createHash("sha256").update(`${kind}\0${input.ticketIdentifier}\0${input.runId}\0${input.role ?? ""}`, "utf8").digest("hex").slice(0, 20);
  return `${kind}:${input.ticketIdentifier.toLowerCase()}:${input.runId}:${input.role ?? ""}:${suffix}`;
}
export function deriveSandboxName(input: ResourceNameInput, maxLength = 63): string { return boundedProviderName(`squire-sandbox-${input.ticketIdentifier.toLowerCase()}-${shortRun(input.runId)}`, input, maxLength); }
export function deriveHerdrWorkspaceName(input: ResourceNameInput, maxLength = 63): string { return boundedProviderName(`squire-herdr-${input.ticketIdentifier.toLowerCase()}-${shortRun(input.runId)}`, input, maxLength); }
export function deriveHerdrTabKey(input: ResourceNameInput): string { assertRole(input.role); return `squire:${input.runId}:${input.role}`; }
export function derivePiSessionId(input: ResourceNameInput): string { assertRole(input.role); return `pi_${shortHash(`${input.runId}:${input.role}`)}`; }
export function deriveResourceName(kind: "sandbox" | "herdr-workspace", input: ResourceNameInput, maxLength = 63): string { return kind === "sandbox" ? deriveSandboxName(input, maxLength) : deriveHerdrWorkspaceName(input, maxLength); }

function boundedProviderName(prefix: string, input: ResourceNameInput, maxLength: number): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 16 || maxLength > 255) throw new NamingError("provider name bound is invalid");
  assertTicketIdentifier(input.ticketIdentifier); assertRunId(input.runId);
  const suffix = `-${shortRun(input.runId)}`;
  const normalized = prefix.toLowerCase().replace(/[^a-z0-9-]/gu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "");
  const result = `${normalized.slice(0, Math.max(1, maxLength - suffix.length))}${suffix}`.slice(0, maxLength).replace(/-$/u, "");
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(result)) throw new NamingError("derived provider name is invalid");
  return result;
}
function shortRun(runId: string): string { assertRunId(runId); return shortHash(runId).slice(0, 20); }
function shortHash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function assertUuid(value: string, label: string): void { if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) throw new NamingError(`${label} is not a UUID`); }
function assertKey(value: string): void { if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(value)) throw new NamingError("idempotency key is invalid"); }
function assertKind(value: string): void { if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{1,31}$/u.test(value)) throw new NamingError("resource kind is invalid"); }
function assertSafeToken(value: string, label: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) throw new NamingError(`${label} is invalid`); }
function assertRole(value: string | undefined): asserts value is typeof ROLES[number] { if (!value || !(ROLES as readonly string[]).includes(value)) throw new NamingError("resource role is not a known Squire role"); }
export class NamingError extends Error { constructor(message: string) { super(message); this.name = "NamingError"; } }
