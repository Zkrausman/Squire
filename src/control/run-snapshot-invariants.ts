import type { GitWorkspaceRecord } from "../git/domain.js";
import { StoreConflictError } from "./workflow-store.js";
import { isTerminal, type PhaseAttempt, type RunSnapshot, type WorkflowState } from "./domain.js";

/**
 * The in-memory adapter used by the AIDEV-216 tests and the durable adapter
 * must reject the same mutations.  Keeping this validator free of persistence
 * concerns prevents a JSON projection in SQLite from accidentally becoming a
 * second, weaker workflow authority.
 */
export function assertRunSnapshotShape(snapshot: RunSnapshot): void {
  if (!snapshot || typeof snapshot !== "object") fail("snapshot is not an object");
  const allowed = new Set(["runId", "version", "state", "currentHead", "implementGeneration", "implementCompletedAt", "sessions", "processAllocations", "attempts", "acceptedResultPaths", "committedRequestIds", "gates", "remediation", "processLaunches", "terminalError", "runtimeResolution", "terminalFence", "preparationLeases", "gitWorkspace", "identity", "timestamps", "resources", "delivery", "lastError", "operatorBlocked", "reconciliation"]);
  if (Object.keys(snapshot as object).some(key => !allowed.has(key))) fail("snapshot contains an unknown field");
  if (!/^run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(snapshot.runId)) fail("invalid run ID");
  if (!(typeof snapshot.state === "string" && ["accepted", "preparing", "planning", "implementing", "reviewing", "testing", "publishing", "awaiting_approval", "approved", "failed", "cancelled", "expired"].includes(snapshot.state))) fail("invalid workflow state");
  if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 0) fail("invalid snapshot version");
  if (!Number.isSafeInteger(snapshot.implementGeneration) || snapshot.implementGeneration < 0) fail("invalid Implement generation");
  if (!Number.isSafeInteger(snapshot.processLaunches) || snapshot.processLaunches < 0) fail("invalid process launch counter");
  if (!snapshot.sessions || typeof snapshot.sessions !== "object" || Array.isArray(snapshot.sessions) || !snapshot.gates || typeof snapshot.gates !== "object" || Array.isArray(snapshot.gates) || !snapshot.remediation || typeof snapshot.remediation !== "object" || Array.isArray(snapshot.remediation)) fail("snapshot child projections are malformed");
  if (!Array.isArray(snapshot.attempts) || !Array.isArray(snapshot.acceptedResultPaths) || !Array.isArray(snapshot.committedRequestIds)) fail("snapshot child collections are not arrays");
  if (!Number.isSafeInteger(snapshot.remediation.review) || snapshot.remediation.review < 0 || !Number.isSafeInteger(snapshot.remediation.test) || snapshot.remediation.test < 0 || !Number.isSafeInteger(snapshot.remediation.total) || snapshot.remediation.total < 0) fail("invalid remediation counters");
  const attemptKeys = snapshot.attempts.map(attempt => `${attempt.phase}:${attempt.attempt}`);
  const handoffs = snapshot.attempts.map(attempt => attempt.handoffId);
  const operations = snapshot.attempts.map(attempt => attempt.dispatch.operationKey);
  assertUnique(attemptKeys, "attempt");
  assertUnique(handoffs, "handoff");
  assertUnique(operations, "dispatch operation");
  assertUnique(snapshot.acceptedResultPaths, "accepted result");
  assertUnique(snapshot.committedRequestIds, "transition request");
  for (const attempt of snapshot.attempts) assertAttempt(attempt);
  if (Object.keys(snapshot.sessions).some(role => !["orchestrator", "plan", "implement", "review", "test"].includes(role)) || Object.keys(snapshot.gates).some(phase => !["review", "test"].includes(phase))) fail("snapshot contains an unknown session or gate role");
  for (const [role, session] of Object.entries(snapshot.sessions)) {
    if (!session) continue;
    if (session.runId !== snapshot.runId || session.role !== role) fail("session is bound to the wrong run or role");
    if (session.processState !== undefined && !["registered", "launching", "live", "exited", "failed"].includes(session.processState)) fail("invalid session process state");
    if (!Number.isSafeInteger(session.processGeneration) || session.processGeneration < 1) fail("invalid session generation");
  }
  const sessionIds = Object.values(snapshot.sessions).filter(Boolean).map(session => session!.sessionId);
  const sessionFiles = Object.values(snapshot.sessions).filter(Boolean).map(session => session!.sessionFile);
  assertUnique(sessionIds, "session ID");
  assertUnique(sessionFiles, "session file");
  if (Object.keys(snapshot.processAllocations ?? {}).some(role => !["orchestrator", "plan", "implement", "review", "test"].includes(role))) fail("snapshot contains an unknown process role");
  for (const [role, allocation] of Object.entries(snapshot.processAllocations ?? {})) {
    if (!allocation) continue;
    if (allocation.role !== role || !["reserved", "spawning", "spawned", "termination_failed", "failed"].includes(allocation.state) || allocation.generation < 1 || !Number.isSafeInteger(allocation.generation) || !Number.isSafeInteger(allocation.fencingToken) || allocation.fencingToken < 0) fail("invalid process allocation identity");
    if (!allocation.owner || /[\u0000-\u001f\u007f\r\n]/u.test(allocation.owner)) fail("invalid process allocation owner");
  }
  if (snapshot.identity) assertIdentity(snapshot.identity, snapshot.runId);
  if (snapshot.timestamps) assertTimestamps(snapshot.timestamps);
  if (snapshot.delivery) assertDelivery(snapshot.delivery);
  if (snapshot.resources) assertResources(snapshot.resources);
  if (snapshot.terminalFence && (snapshot.terminalFence.runId !== snapshot.runId || !["held", "removed"].includes(snapshot.terminalFence.state) || !Number.isSafeInteger(snapshot.terminalFence.fencingToken) || snapshot.terminalFence.fencingToken < 0)) fail("invalid terminal fence");
  if (snapshot.preparationLeases?.some(lease => lease.runId !== snapshot.runId || lease.state !== "held" || !Number.isSafeInteger(lease.fencingToken) || lease.fencingToken < 0)) fail("invalid preparation lease");
  if (snapshot.reconciliation && (!Number.isSafeInteger(snapshot.reconciliation.generation) || snapshot.reconciliation.generation < 0 || !Number.isSafeInteger(snapshot.reconciliation.fencingToken) || snapshot.reconciliation.fencingToken < 0 || !["observing", "recovering", "ready", "blocked"].includes(snapshot.reconciliation.status))) fail("invalid reconciliation fence");
  if (snapshot.lastError && (!snapshot.lastError.errorId || !snapshot.lastError.code || snapshot.lastError.message.length > 4_096)) fail("invalid last error projection");
  if (snapshot.terminalError && snapshot.state !== "failed" && snapshot.state !== "cancelled" && snapshot.state !== "expired") fail("terminal error on a non-terminal run");
  if (snapshot.state === "approved" && snapshot.terminalError) fail("approved run has a terminal error");
  assertGitWorkspaceShape(snapshot.gitWorkspace);
}

export function assertRunSnapshotMutation(previous: RunSnapshot, next: RunSnapshot): void {
  assertRunSnapshotShape(previous);
  assertRunSnapshotShape(next);
  if (next.runId !== previous.runId) fail("mutation changed run identity");
  if (next.version !== previous.version + 1) fail("mutation must increment version exactly once");
  if (next.implementGeneration < previous.implementGeneration || next.processLaunches < previous.processLaunches) fail("monotonic counter decreased");
  if (next.remediation.review < previous.remediation.review || next.remediation.test < previous.remediation.test || next.remediation.total < previous.remediation.total) fail("remediation counter decreased");
  if (next.acceptedResultPaths.length < previous.acceptedResultPaths.length || next.committedRequestIds.length < previous.committedRequestIds.length) fail("append-only history was shortened");
  if (!prefixEqual(previous.acceptedResultPaths, next.acceptedResultPaths) || !prefixEqual(previous.committedRequestIds, next.committedRequestIds)) fail("append-only history was rewritten");
  if (JSON.stringify(previous.identity) !== JSON.stringify(next.identity)) fail("immutable run identity changed");
  assertDeliveryMutation(previous.delivery, next.delivery);
  if (previous.timestamps?.createdAt !== undefined && next.timestamps?.createdAt !== previous.timestamps.createdAt) fail("run creation timestamp changed");
  if (isTerminal(previous.state) && next.state !== previous.state) fail("terminal state was reopened or changed");
  if (previous.terminalFence && JSON.stringify(previous.terminalFence) !== JSON.stringify(next.terminalFence)) {
    // The only permitted terminal-fence mutation is the exact held -> removed
    // teardown record. No unrelated state may be smuggled through that path.
    if (!(previous.terminalFence.state === "held" && next.terminalFence?.state === "removed")) fail("terminal fence identity changed");
    const before = structuredClone(previous) as unknown as { [key: string]: unknown }; const after = structuredClone(next) as unknown as { [key: string]: unknown }; delete before["terminalFence"]; delete after["terminalFence"]; before["version"] = 0; after["version"] = 0;
    if (JSON.stringify(before) !== JSON.stringify(after)) fail("terminal fence teardown changed unrelated workflow state");
  }
  if (previous.runtimeResolution && JSON.stringify(previous.runtimeResolution) !== JSON.stringify(next.runtimeResolution)) fail("runtime resolution changed");
  assertResourceMutation(previous.resources, next.resources);
  assertGitWorkspaceMutation(previous.gitWorkspace, next.gitWorkspace);
  if (previous.state !== next.state && !isLegalStateTransition(previous.state, next.state)) fail(`illegal workflow transition ${previous.state}->${next.state}`);
  if (next.state === "approved" && previous.state !== "awaiting_approval") fail("approved requires awaiting_approval");
  if (next.state === "failed" || next.state === "cancelled" || next.state === "expired") {
    if (!next.timestamps?.terminalAt && !previous.timestamps?.terminalAt) {
      // Legacy AIDEV-216 snapshots predate timestamps; do not make those
      // callers non-source-compatible. Intake-created snapshots always carry it.
    }
  }
}

export function isLegalStateTransition(from: WorkflowState, to: WorkflowState): boolean {
  if (from === to) return true;
  if (isTerminal(from)) return false;
  return (
    (from === "accepted" && to === "preparing") ||
    (from === "preparing" && to === "planning") ||
    (from === "planning" && to === "implementing") ||
    (from === "implementing" && to === "reviewing") ||
    (from === "reviewing" && (to === "testing" || to === "implementing")) ||
    (from === "testing" && (to === "publishing" || to === "implementing")) ||
    (from === "publishing" && to === "awaiting_approval") ||
    (from === "awaiting_approval" && to === "approved") ||
    (to === "failed" || to === "cancelled" || to === "expired")
  );
}

function assertAttempt(attempt: PhaseAttempt): void {
  if (!["plan", "implement", "review", "test"].includes(attempt.phase) || !Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1) fail("invalid phase attempt number");
  if (!attempt.handoffId || !attempt.targetSessionId || !attempt.dispatch || !["prepared", "sent", "accepted", "settled", "result_accepted"].includes(attempt.dispatch.state) || attempt.dispatch.operationKey.length > 512) fail("invalid phase attempt identity");
  if (!Number.isSafeInteger(attempt.dispatch.generation) || attempt.dispatch.generation < 0 || !Number.isSafeInteger(attempt.dispatch.recoveryPrompts) || attempt.dispatch.recoveryPrompts < 0) fail("invalid dispatch counters");
  if (attempt.dispatch.launchCount !== undefined && (!Number.isSafeInteger(attempt.dispatch.launchCount) || attempt.dispatch.launchCount < 0)) fail("invalid dispatch launch count");
  if (attempt.dispatch.deadlineAt !== undefined && !Number.isSafeInteger(attempt.dispatch.deadlineAt)) fail("invalid dispatch deadline");
}

function assertIdentity(identity: NonNullable<RunSnapshot["identity"]>, runId: string): void {
  if (!identity.linearIssueId || !identity.linearIdentifier || !identity.linearTeamId || !identity.normalizedTicket || !identity.repositoryOwner || !identity.repositoryName || !identity.baseBranch || !identity.baseSha || !identity.intakeIdempotencyKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(identity.linearIssueId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(identity.linearTeamId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(identity.linearStateId) || !/^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u.test(identity.linearIdentifier) || !["sha1", "sha256"].includes(identity.objectFormat)) fail("incomplete or malformed immutable run identity");
  if (identity.normalizedTicket.path !== `artifacts/intake/${runId}/normalized-ticket.json` || identity.normalizedTicket.schemaId !== "urn:squire:contracts:v1:normalized-ticket") fail("normalized ticket reference is not the immutable v1 intake artifact");
  if (identity.contractFeatureBranch !== `squire/${identity.linearIdentifier.toLowerCase()}/${runId}` || identity.physicalFeatureBranch !== `squire/${identity.linearIdentifier.toLowerCase()}-${runId}`) fail("feature branch projections are not derived from ticket/run identity");
  if (!/^[0-9a-f]{40,64}$/u.test(identity.baseSha) || (identity.objectFormat === "sha1" && identity.baseSha.length !== 40) || (identity.objectFormat === "sha256" && identity.baseSha.length !== 64)) fail("base object identity is malformed");
  if (!/^[0-9a-f]{64}$/u.test(identity.normalizedTicketDigest)) fail("normalized ticket digest is malformed");
  if (identity.normalizedTicketDigest !== identity.normalizedTicket.sha256) fail("normalized ticket digest/reference disagreement");
}

function assertTimestamps(value: NonNullable<RunSnapshot["timestamps"]>): void {
  for (const key of ["createdAt", "updatedAt", "terminalAt", "expiresAt", "successRetentionUntil", "failureRetentionUntil"] as const) {
    const timestamp = value[key];
    if (timestamp !== undefined && !Number.isFinite(Date.parse(timestamp))) fail(`invalid ${key}`);
  }
}

function assertDelivery(value: NonNullable<RunSnapshot["delivery"]>): void { const allowed = new Set(["repositoryOwner", "repositoryName", "featureBranch", "bundlePath", "bundleDigest", "githubRepositoryId", "githubNodeId", "pullRequestNumber", "pullRequestNodeId", "pullRequestUrl", "observedHead", "approvalObservationId", "checksObservationId"]); for (const [key, candidate] of Object.entries(value)) { if (!allowed.has(key) || candidate !== undefined && (typeof candidate !== "string" && typeof candidate !== "number" || typeof candidate === "string" && (candidate.length > 2_048 || /[\u0000-\u001f\u007f\r\n]/u.test(candidate)) || typeof candidate === "number" && (!Number.isSafeInteger(candidate) || candidate < 1))) fail(`invalid delivery field ${key}`); } }
function assertDeliveryMutation(previous: RunSnapshot["delivery"], next: RunSnapshot["delivery"]): void { if (previous && !next) fail("delivery identity cannot be cleared"); if (!previous || !next) return; for (const key of Object.keys(previous) as Array<keyof NonNullable<RunSnapshot["delivery"]>>) if (previous[key] !== undefined && next[key] !== previous[key]) fail("delivery identity cannot be rewritten"); }
function assertResources(resources: readonly NonNullable<RunSnapshot["resources"]>[number][]): void {
  const keys = resources.map(resource => `${resource.kind}:${resource.scope}:${resource.role ?? ""}`);
  assertUnique(keys, "resource binding");
  assertUnique(resources.map(resource => `${resource.scope}:${resource.deterministicKey}`), "resource deterministic key");
  assertUnique(resources.map(resource => `${resource.scope}:${resource.deterministicName}`), "resource deterministic name");
  for (const resource of resources) {
    if (!["linear_issue", "sandbox", "herdr_workspace", "herdr_tab", "herdr_root_pane", "herdr_runner", "git_branch", "git_workspace", "git_bundle", "pi_session", "github_pr"].includes(resource.kind) || !["planned", "creating", "bound", "retained", "deleted", "blocked"].includes(resource.state) || !resource.scope || !resource.deterministicKey || !resource.deterministicName || resource.scope.length > 512 || resource.deterministicKey.length > 512 || resource.deterministicName.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(`${resource.scope}${resource.deterministicKey}${resource.deterministicName}`) || !Number.isSafeInteger(resource.generation) || resource.generation < 0 || typeof resource.observedAt !== "string" || !Number.isFinite(Date.parse(resource.observedAt)) || (resource.externalId !== undefined && (resource.externalId.length < 1 || resource.externalId.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(resource.externalId))) || (resource.role !== undefined && !["orchestrator", "plan", "implement", "review", "test"].includes(resource.role))) fail("invalid resource binding");
  }
}
function assertResourceMutation(previous: RunSnapshot["resources"], next: RunSnapshot["resources"]): void {
  if (!previous) return;
  if (!next || next.length < previous.length) fail("resource binding history was shortened");
  for (const before of previous) {
    const after = next.find(candidate => candidate.kind === before.kind && candidate.scope === before.scope && candidate.role === before.role);
    if (!after || after.deterministicKey !== before.deterministicKey || after.deterministicName !== before.deterministicName || after.scope !== before.scope || (before.externalId !== undefined && after.externalId !== before.externalId) || (before.metadata !== undefined && JSON.stringify(before.metadata) !== JSON.stringify(after.metadata)) || after.generation < before.generation || !resourceStateTransition(before.state, after.state)) fail("resource binding identity or lifecycle changed illegally");
  }
}
function resourceStateTransition(from: NonNullable<RunSnapshot["resources"]>[number]["state"], to: NonNullable<RunSnapshot["resources"]>[number]["state"]): boolean { const allowed: Record<typeof from, readonly typeof to[]> = { planned: ["planned", "creating", "bound", "blocked"], creating: ["creating", "bound", "blocked"], bound: ["bound", "retained", "blocked"], retained: ["retained", "deleted", "blocked"], deleted: ["deleted"], blocked: ["blocked"] }; return allowed[from].includes(to); }

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) fail(`duplicate ${label}`);
}
function prefixEqual<T>(prefix: readonly T[], value: readonly T[]): boolean { return prefix.every((entry, index) => JSON.stringify(entry) === JSON.stringify(value[index])); }
function fail(message: string): never { throw new StoreConflictError(message); }

function assertGitWorkspaceShape(previous: GitWorkspaceRecord | undefined): void {
  if (!previous) return;
  if (!Number.isSafeInteger(previous.operationGeneration) || previous.operationGeneration < 1) fail("invalid Git workspace operation generation");
}

/** Shared AIDEV-222 mutation rules. */
export function assertGitWorkspaceMutation(previous: GitWorkspaceRecord | undefined, next: GitWorkspaceRecord | undefined): void {
  if (!previous && !next) return;
  if (!previous && next) {
    if (next.stage !== "provisioning" || next.operationGeneration !== 1) fail("Git workspace must begin at provisioning generation one");
    return;
  }
  if (!next || !previous) fail("Git workspace record cannot be removed by an arbitrary mutation");
  if (previous.runId !== next.runId || previous.spec.path !== next.spec.path || previous.spec.sha256 !== next.spec.sha256 || previous.spec.schemaId !== next.spec.schemaId || previous.specFingerprint !== next.specFingerprint || previous.featureBranch !== next.featureBranch || JSON.stringify(previous.paths) !== JSON.stringify(next.paths)) fail("Git workspace immutable identity changed");
  if (next.operationGeneration < previous.operationGeneration || next.operationGeneration > previous.operationGeneration + 1) fail("Git workspace operation generation is not monotonic");
  const allowed: Record<GitWorkspaceRecord["stage"], readonly GitWorkspaceRecord["stage"][]> = {
    provisioning: ["provisioning", "ready", "blocked"], ready: ["ready", "exporting", "retained", "blocked"], exporting: ["exporting", "ready", "blocked"], retained: ["retained"], blocked: ["blocked"],
  };
  if (!allowed[previous.stage].includes(next.stage)) fail(`illegal Git workspace stage transition ${previous.stage}->${next.stage}`);
  if (previous.stage === "ready" && next.stage === "exporting" && next.operationGeneration !== previous.operationGeneration + 1) fail("bundle export did not allocate a new generation");
  if (!(previous.stage === "ready" && next.stage === "exporting") && next.operationGeneration !== previous.operationGeneration) fail("Git workspace generation changed outside export reservation");
}
