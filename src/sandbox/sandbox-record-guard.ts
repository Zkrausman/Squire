import path from "node:path";
import { SANDBOX_LIFECYCLE_STATES, type SandboxOperation, type SandboxRecord } from "./domain.js";
import { SandboxContractError } from "./contracts.js";
import { assertBridgeName, assertCanonicalSandboxPath, assertDigestReference, assertSandboxName, assertSandboxRunId, assertSha256, canonicalJson, deriveBridgeName, deriveSandboxName } from "./identity.js";

const ALLOWED: Record<SandboxRecord["lifecycle"], readonly SandboxRecord["lifecycle"][]> = {
  reserving: ["reserving", "creating", "blocked"],
  creating: ["creating", "created", "starting", "blocked"],
  created: ["created", "starting", "stopping", "retained", "removing", "blocked"],
  starting: ["starting", "attesting", "stopped", "blocked"],
  attesting: ["attesting", "ready", "stopped", "blocked"],
  ready: ["ready", "starting", "stopping", "retained", "removing", "blocked"],
  stopping: ["stopping", "stopped", "blocked"],
  stopped: ["stopped", "starting", "retained", "removing", "blocked"],
  retained: ["retained", "starting", "removing", "blocked"],
  removing: ["removing", "removed", "blocked"],
  removed: ["removed"],
  blocked: ["blocked"],
};

const ACTIVE_OPERATION_STATES = new Set<SandboxRecord["lifecycle"]>(["creating", "starting", "attesting", "stopping", "removing"]);
const OPERATION_INTENTS: Record<SandboxOperation["kind"], readonly SandboxOperation["intent"][]> = {
  reserve: ["create"],
  create: ["create"],
  start: ["start"],
  stop: ["stop"],
  reconcile: ["inspect", "attest", "start", "stop", "remove"],
  remove: ["remove"],
  transfer: ["cp-import", "cp-export"],
  attest: ["attest"],
};

/** Validates every sandbox record mutation, not just the lifecycle edge. The
 * workflow store calls this on both normal and fenced CAS so a stale or
 * foreign record cannot be smuggled through the additive snapshot fields. */
export function assertSandboxRecordMutation(previous: SandboxRecord | undefined, next: SandboxRecord | undefined, runId: string): void {
  assertSandboxRunId(runId);
  if (!previous && !next) return;
  if (previous !== undefined && !isRecord(previous)) throw new SandboxContractError("previous sandbox record is not a closed object");
  if (next !== undefined && !isRecord(next)) throw new SandboxContractError("sandbox record is not a closed object");
  if (!next) throw new SandboxContractError("sandbox record cannot be removed by an arbitrary CAS mutation");
  if (next.runId !== runId) throw new SandboxContractError("sandbox record run identity changed");
  const requiredKeys = ["bridgeName", "lifecycle", "operationGeneration", "releaseId", "runId", "sandboxName", "spec", "specFingerprint", "templateDigest", "transferGeneration"];
  const optionalKeys = ["attestation", "attestationDigest", "bootId", "error", "identity", "operation", "retention"];
  if (Object.keys(next).some(key => !requiredKeys.includes(key) && !optionalKeys.includes(key)) || requiredKeys.some(key => !Object.hasOwn(next, key)) || Object.values(next).some(value => value === undefined)) throw new SandboxContractError("sandbox record fields are not closed");
  assertSandboxName(next.sandboxName); assertBridgeName(next.bridgeName);
  if (next.sandboxName !== deriveSandboxName(runId) || next.bridgeName !== deriveBridgeName(runId)) throw new SandboxContractError("sandbox record names are not derived from the run identity");
  if (!isReference(next.spec) || next.spec.path !== `artifacts/sandbox/${runId}/spec.json` || next.spec.schemaId !== "urn:squire:sandbox:v1:sandbox-spec") throw new SandboxContractError("sandbox record spec reference is not canonical");
  if (!/^[a-z][a-z0-9._-]{0,127}$/u.test(next.releaseId)) throw new SandboxContractError("sandbox record release identity is invalid");
  assertSha256(next.specFingerprint, "sandbox spec fingerprint");
  assertDigestReference(next.templateDigest, "sandbox record template identity");
  if (!Number.isSafeInteger(next.operationGeneration) || next.operationGeneration < 1 || !Number.isSafeInteger(next.transferGeneration) || next.transferGeneration < 0) throw new SandboxContractError("sandbox record generation is invalid");
  if (next.error !== undefined) assertError(next.error);
  if (next.identity !== undefined) assertIdentity(next);
  if (next.attestation !== undefined) {
    if (!isReference(next.attestation) || next.attestation.schemaId !== "urn:squire:sandbox:v1:sandbox-attestation" || next.attestationDigest !== next.attestation.sha256) throw new SandboxContractError("sandbox record attestation reference is not canonical");
    if (!next.attestationDigest) throw new SandboxContractError("sandbox record attestation digest is missing");
  }
  if (next.attestationDigest !== undefined) assertSha256(next.attestationDigest, "sandbox record attestation digest");
  if (next.attestationDigest !== undefined && next.attestation === undefined) throw new SandboxContractError("sandbox record attestation digest lacks its immutable reference");
  if (next.bootId !== undefined) { assertSafeText(next.bootId, 512, "sandbox record boot identity"); if (!next.identity) throw new SandboxContractError("sandbox record boot identity lacks its physical identity manifest"); }
  if (next.retention !== undefined) assertRetention(next.retention);
  if (next.retention !== undefined && !["retained", "removing", "removed", "blocked"].includes(next.lifecycle)) throw new SandboxContractError("sandbox retention was published outside a retention state");
  if (next.operation !== undefined) assertOperation(next.operation, next.operationGeneration);
  if (ACTIVE_OPERATION_STATES.has(next.lifecycle) && !next.operation) throw new SandboxContractError(`sandbox ${next.lifecycle} state lacks an active operation`);
  if (!SANDBOX_LIFECYCLE_STATES.includes(next.lifecycle)) throw new SandboxContractError("sandbox lifecycle state is invalid");
  if (next.lifecycle === "ready" && (!next.identity || !next.attestation || !next.attestationDigest || !next.bootId || next.operation)) throw new SandboxContractError("ready sandbox lacks complete immutable attestation identity");
  if (next.lifecycle === "retained" && !next.retention) throw new SandboxContractError("retained sandbox lacks its immutable retention deadline");
  if (next.lifecycle === "removed" && next.operation) throw new SandboxContractError("removed sandbox retains an active operation");
  if (!ACTIVE_OPERATION_STATES.has(next.lifecycle) && next.operation) throw new SandboxContractError(`sandbox ${next.lifecycle} state retains an active operation`);
  if (ACTIVE_OPERATION_STATES.has(next.lifecycle) && next.operation) {
    const allowedKinds: Record<SandboxRecord["lifecycle"], readonly SandboxOperation["kind"][]> = { reserving: [], creating: ["create"], created: [], starting: ["start"], attesting: ["attest"], ready: [], stopping: ["stop"], stopped: [], retained: [], removing: ["remove"], removed: [], blocked: [] };
    if (!allowedKinds[next.lifecycle]?.includes(next.operation.kind)) throw new SandboxContractError(`sandbox ${next.lifecycle} state has an incompatible operation`);
  }
  if (!previous) {
    if (next.lifecycle !== "reserving" || next.operationGeneration !== 1 || next.operation || next.identity || next.attestation || next.retention) throw new SandboxContractError("sandbox record must begin at reserving generation one");
    return;
  }
  assertSandboxRecordIdentity(previous, next);
  if (!previous.attestation && next.attestation && next.lifecycle !== "ready") throw new SandboxContractError("sandbox attestation was published outside an attestation transition");
  if (previous.identity && !next.identity) throw new SandboxContractError("sandbox physical identity cannot be erased");
  if (previous.attestation && !next.attestation) throw new SandboxContractError("sandbox attestation reference cannot be erased");
  if (previous.attestationDigest && !next.attestationDigest) throw new SandboxContractError("sandbox attestation digest cannot be erased");
  if (previous.attestation && next.attestation && canonicalJson(previous.attestation) !== canonicalJson(next.attestation) && !["starting", "attesting"].includes(previous.lifecycle)) throw new SandboxContractError("sandbox attestation reference changed outside a start or attestation transition");
  if (previous.attestationDigest && next.attestationDigest && previous.attestationDigest !== next.attestationDigest && !["starting", "attesting"].includes(previous.lifecycle)) throw new SandboxContractError("sandbox attestation digest changed outside a start or attestation transition");
  if (previous.retention && next.retention && canonicalJson(previous.retention) !== canonicalJson(next.retention)) throw new SandboxContractError("sandbox retention identity changed");
  if (previous.error && next.error && canonicalJson(previous.error) !== canonicalJson(next.error)) throw new SandboxContractError("sandbox failure identity changed");
  if (previous.identity && next.identity && !sameImmutableIdentity(previous.identity, next.identity)) throw new SandboxContractError("sandbox physical identity changed across a record mutation");
  if (previous.bootId !== undefined && next.bootId === undefined) throw new SandboxContractError("sandbox boot identity cannot be erased");
  if (previous.bootId !== undefined && next.bootId !== previous.bootId && (!["starting", "attesting", "ready"].includes(next.lifecycle) || !["ready", "starting", "attesting"].includes(previous.lifecycle))) throw new SandboxContractError("sandbox boot identity changed outside a start or attestation transition");
  if (next.identity?.bootId !== next.bootId) throw new SandboxContractError("sandbox physical identity boot binding changed");
  if (next.operationGeneration < previous.operationGeneration || next.operationGeneration > previous.operationGeneration + 1) throw new SandboxContractError("sandbox operation generation is not monotonic");
  if (next.transferGeneration < previous.transferGeneration) throw new SandboxContractError("sandbox transfer generation regressed");
  if (!ALLOWED[previous.lifecycle]?.includes(next.lifecycle)) throw new SandboxContractError(`illegal sandbox lifecycle transition ${previous.lifecycle}->${next.lifecycle}`);
  if (previous.lifecycle === next.lifecycle && next.operationGeneration !== previous.operationGeneration) throw new SandboxContractError("sandbox generation changed without a lifecycle transition");
  if (previous.lifecycle !== next.lifecycle && next.operationGeneration !== previous.operationGeneration + 1) throw new SandboxContractError("sandbox lifecycle transition did not allocate one operation generation");
  if (next.lifecycle === "blocked" && !next.error) throw new SandboxContractError("blocked sandbox lacks a bounded failure record");
}

function assertSandboxRecordIdentity(previous: SandboxRecord, next: SandboxRecord): void {
  if (previous.runId !== next.runId || previous.spec.path !== next.spec.path || previous.spec.sha256 !== next.spec.sha256 || previous.spec.schemaId !== next.spec.schemaId || previous.specFingerprint !== next.specFingerprint || previous.sandboxName !== next.sandboxName || previous.bridgeName !== next.bridgeName || previous.templateDigest !== next.templateDigest || previous.releaseId !== next.releaseId) throw new SandboxContractError("sandbox immutable identity changed");
}

function assertIdentity(record: SandboxRecord): void {
  const identity = record.identity!;
  const hasBoot = hasExactKeys(identity as unknown as Record<string, unknown>, ["bootId", "bridge", "generation", "kind", "releaseId", "runId", "sandboxId", "sandboxName", "schemaVersion", "specFingerprint", "templateDigest", "vmId"]);
  if (!hasBoot && !hasExactKeys(identity as unknown as Record<string, unknown>, ["bridge", "generation", "kind", "releaseId", "runId", "sandboxId", "sandboxName", "schemaVersion", "specFingerprint", "templateDigest", "vmId"])) throw new SandboxContractError("sandbox record identity fields are not closed");
  if (!isRecord(identity.bridge) || identity.schemaVersion !== 1 || identity.kind !== "squire-sandbox-identity-manifest" || identity.runId !== record.runId || identity.sandboxName !== record.sandboxName || identity.bridge.name !== record.bridgeName || identity.bridge.logicalPath !== "/ticket/bridge" || identity.specFingerprint !== record.specFingerprint || identity.templateDigest !== record.templateDigest || identity.releaseId !== record.releaseId || !Number.isSafeInteger(identity.generation) || identity.generation < 1 || identity.generation > record.operationGeneration) throw new SandboxContractError("sandbox record identity manifest is not bound to the record");
  assertSafeText(identity.sandboxId, 256, "sandbox record ID"); assertSafeText(identity.vmId, 256, "sandbox record VM ID"); assertDigestReference(identity.templateDigest, "sandbox record identity template digest");
  if (hasBoot) assertSafeText(identity.bootId, 256, "sandbox record boot ID");
  if (record.bootId !== undefined && (!hasBoot || identity.bootId !== record.bootId)) throw new SandboxContractError("sandbox record boot identity is not bound to its physical identity");
  if (!hasExactKeys(identity.bridge as unknown as Record<string, unknown>, ["device", "hostPath", "inode", "linkCount", "logicalPath", "mode", "name", "quotaBytes"]) || !pathIsAbsoluteClean(identity.bridge.hostPath) || identity.bridge.hostPath.split("/").pop() !== record.bridgeName || !safeValue(identity.bridge.device, 256) || !safeValue(identity.bridge.inode, 256) || !Number.isSafeInteger(identity.bridge.mode) || identity.bridge.mode !== 0o700 || !Number.isSafeInteger(identity.bridge.linkCount) || identity.bridge.linkCount < 2 || !Number.isSafeInteger(identity.bridge.quotaBytes) || identity.bridge.quotaBytes < 4096 || !Number.isSafeInteger(identity.generation) || identity.generation < 1) throw new SandboxContractError("sandbox record physical identity is invalid");
}

function assertOperation(operation: SandboxOperation, recordGeneration: number): void {
  const value = operation as unknown as Record<string, unknown>;
  const required = ["deadlineAt", "fencingToken", "generation", "intent", "kind", "owner", "startedAt"];
  const optional = ["child", "lastObservedState"];
  if (!isRecord(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new SandboxContractError("sandbox operation fields are not closed");
  if (!OPERATION_INTENTS[operation.kind]?.includes(operation.intent) || operation.generation !== recordGeneration || !Number.isSafeInteger(operation.fencingToken) || operation.fencingToken <= 0 || !Number.isSafeInteger(operation.generation) || !Number.isSafeInteger(operation.deadlineAt) || operation.deadlineAt <= 0 || operation.deadlineAt > 9_007_199_254_740_991 || !canonicalDate(operation.startedAt)) throw new SandboxContractError("sandbox operation identity is invalid");
  assertSafeText(operation.owner, 256, "sandbox operation owner");
  if (operation.child !== undefined) {
    const child = operation.child;
    if (!hasExactKeys(child as unknown as Record<string, unknown>, ["executable", "executableDigest", "identity", "pid", "startTime"]) || !Number.isSafeInteger(child.pid) || child.pid <= 0 || child.pid > 4_194_304 || typeof child.startTime !== "string" || child.startTime.length > 32 || !/^\d+$/u.test(child.startTime) || !pathIsAbsoluteClean(child.executable) || !/^[0-9a-f]{64}$/u.test(child.executableDigest) || child.identity !== `host-child:${child.pid}:${child.startTime}:${child.executableDigest}`) throw new SandboxContractError("sandbox host child identity is invalid");
  }
  if (operation.lastObservedState !== undefined) assertSafeText(operation.lastObservedState, 128, "sandbox observed state");
}

function assertRetention(retention: NonNullable<SandboxRecord["retention"]>): void {
  if (!hasExactKeys(retention as unknown as Record<string, unknown>, ["artifactUntil", "outcome", "retainUntil"]) || !["success", "failure"].includes(retention.outcome) || !canonicalDate(retention.retainUntil) || !canonicalDate(retention.artifactUntil) || Date.parse(retention.artifactUntil) < Date.parse(retention.retainUntil)) throw new SandboxContractError("sandbox retention identity is invalid");
}

function assertError(error: NonNullable<SandboxRecord["error"]>): void {
  if (!hasExactKeys(error as unknown as Record<string, unknown>, ["at", "code", "evidence", "message"]) || typeof error["code"] !== "string" || typeof error["message"] !== "string" || typeof error["at"] !== "string" || !Array.isArray(error["evidence"]) || !/^[A-Za-z0-9._:-]{1,128}$/u.test(error["code"]) || String(error["message"]).length === 0 || String(error["message"]).length > 1_000 || /[\u0000-\u001f\u007f]/u.test(`${error["code"]}${error["message"]}`) || !canonicalDate(error["at"]) || error["evidence"].length > 64 || error["evidence"].some(reference => !isReference(reference))) throw new SandboxContractError("sandbox record error is unbounded or malformed");
}
function isReference(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ["path", "schemaId", "sha256"])) return false;
  return typeof value["path"] === "string" && safeLogicalPath(value["path"]) && typeof value["sha256"] === "string" && /^[0-9a-f]{64}$/u.test(value["sha256"]) && typeof value["schemaId"] === "string" && value["schemaId"].length > 0 && value["schemaId"].length <= 300 && !/[\u0000-\u001f\u007f\r\n]/u.test(value["schemaId"]);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0"); }
function safeValue(value: unknown, maxLength: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f\r\n]/u.test(value); }
function canonicalDate(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function assertSafeText(value: unknown, maxLength: number, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f\r\n]/u.test(value)) throw new SandboxContractError(`${label} is invalid`);
}
function pathIsAbsoluteClean(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { assertCanonicalSandboxPath(value, "sandbox record path"); return true; }
  catch { return value.startsWith("/") && !/[\u0000-\u001f\u007f\r\n]/u.test(value) && pathClean(value); }
}
function pathClean(value: string): boolean { return value.length <= 1024 && value !== "/" && path.posix.normalize(value) === value && !value.endsWith("/") && !value.includes("//") && !value.includes("\\") && !value.split("/").some(part => part === "." || part === ".."); }
function safeLogicalPath(value: string): boolean { return /^(?:artifacts|evidence)(?:\/[A-Za-z0-9._-]+)+$/u.test(value) && !value.split("/").some(part => part === "." || part === ".."); }
function sameImmutableIdentity(left: NonNullable<SandboxRecord["identity"]>, right: NonNullable<SandboxRecord["identity"]>): boolean {
  return left.schemaVersion === right.schemaVersion && left.kind === right.kind && left.runId === right.runId && left.sandboxName === right.sandboxName && left.sandboxId === right.sandboxId && left.vmId === right.vmId && left.releaseId === right.releaseId && left.templateDigest === right.templateDigest && left.specFingerprint === right.specFingerprint && left.generation === right.generation && canonicalJson(left.bridge) === canonicalJson(right.bridge);
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
