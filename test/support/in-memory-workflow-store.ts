import { assertPrecondition, StoreConflictError, type WorkflowStore } from "../../src/control/workflow-store.js";
import type { Lease, LeaseGuard, ProcessAllocationRecovery, ProcessAllocationRetention, Role, RunPreparationLease, RunPrecondition, RunSnapshot, RunTerminalFence, RuntimeResolution, SessionRegistration } from "../../src/control/domain.js";
import type { RunTeardownRecord } from "../../src/sandbox/domain.js";
import { assertSandboxRecordMutation } from "../../src/sandbox/sandbox-record-guard.js";
import type { GitWorkspaceRecord } from "../../src/git/domain.js";

const copy = <T>(value: T): T => structuredClone(value);

/** Deliberately test-only; production must inject durable persistence. */
export class InMemoryWorkflowStore implements WorkflowStore {
  readonly runs = new Map<string, RunSnapshot>();
  readonly leases = new Map<string, Lease>();
  readonly leaseTokens = new Map<string, number>();
  async create(snapshot: RunSnapshot): Promise<void> {
    if (this.runs.has(snapshot.runId)) throw new StoreConflictError("run already exists");
    this.runs.set(snapshot.runId, copy(snapshot));
  }
  async read(runId: string): Promise<RunSnapshot | undefined> { const found = this.runs.get(runId); return found && copy(found); }
  async assertRunStartAllowed(runId: string): Promise<void> {
    const current = this.runs.get(runId);
    if (!current) throw new StoreConflictError("run not found");
    if (current.terminalFence || current.teardown) throw new StoreConflictError(current.terminalFence?.state === "removed" || current.teardown?.state === "completed" ? "run has been removed" : "run has a permanent terminal fence (teardown drain)");
  }
  async acquireRunPreparationLease(runId: string, owner: string, now = Date.now()): Promise<RunPreparationLease> {
    const current = this.runs.get(runId);
    if (!current) throw new StoreConflictError("run not found");
    if (current.terminalFence || current.teardown) throw new StoreConflictError("run has a permanent terminal fence (teardown drain)");
    const lease: RunPreparationLease = { runId, owner, fencingToken: current.version + 1, acquiredAt: new Date(now).toISOString(), state: "held" };
    this.runs.set(runId, copy({ ...current, version: current.version + 1, preparationLeases: [...(current.preparationLeases ?? []), lease] }));
    return copy(lease);
  }
  async releaseRunPreparationLease(runId: string, lease: RunPreparationLease, _now = Date.now()): Promise<void> {
    const current = this.runs.get(runId);
    if (!current) throw new StoreConflictError("run not found");
    const leases = current.preparationLeases ?? [];
    const owned = leases.find(candidate => candidate.owner === lease.owner && candidate.fencingToken === lease.fencingToken);
    if (!owned) return;
    if (owned.runId !== runId || lease.runId !== runId || owned.state !== "held") throw new StoreConflictError("preparation lease identity changed");
    this.runs.set(runId, copy({ ...current, version: current.version + 1, preparationLeases: leases.filter(candidate => candidate !== owned) }));
  }
  async beginRunTeardown(runId: string, owner: string, reason: RunTeardownRecord["reason"] = "retention", now = Date.now()): Promise<RunTeardownRecord> {
    const current = this.runs.get(runId);
    if (!current) throw new StoreConflictError("run not found");
    if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(owner) || !["retention", "terminal", "operator"].includes(reason) || !Number.isSafeInteger(now)) throw new StoreConflictError("teardown request identity is invalid");
    if (current.teardown) {
      if (current.teardown.reason !== reason) throw new StoreConflictError("teardown reason changed for the durable drain");
      return copy(current.teardown);
    }
    if (current.terminalFence?.state === "removed") throw new StoreConflictError("run has been removed");
    const teardown: RunTeardownRecord = { runId, owner, generation: 1, state: "draining", reason, requestedAt: new Date(now).toISOString() };
    this.runs.set(runId, copy({ ...current, version: current.version + 1, teardown }));
    return copy(teardown);
  }
  async acquireRunTeardownLease(runId: string, owner: string, now = Date.now(), ttlMs = 30_000): Promise<Lease | undefined> {
    const snapshot = this.runs.get(runId);
    if (!snapshot || !snapshot.teardown || snapshot.teardown.state === "blocked" || snapshot.teardown.state === "completed" || snapshot.terminalFence?.state === "removed") return undefined;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 300_000 || !/^[A-Za-z0-9._:-]{1,256}$/u.test(owner)) return undefined;
    const full = `${runId}:teardown`; const current = this.leases.get(full);
    if (current && current.expiresAt > now) return current.owner === owner ? copy(current) : undefined;
    const fencingToken = (this.leaseTokens.get(full) ?? 0) + 1; this.leaseTokens.set(full, fencingToken);
    const lease: Lease = { key: "teardown", owner, fencingToken, expiresAt: now + ttlMs }; this.leases.set(full, lease); return copy(lease);
  }
  async renewRunTeardownLease(runId: string, owner: string, fencingToken: number, now = Date.now(), ttlMs = 30_000): Promise<Lease | undefined> {
    const snapshot = this.runs.get(runId); const full = `${runId}:teardown`; const current = this.leases.get(full);
    if (!snapshot?.teardown || snapshot.teardown.state === "blocked" || snapshot.teardown.state === "completed" || snapshot.terminalFence?.state === "removed" || !current || current.owner !== owner || current.fencingToken !== fencingToken || current.expiresAt <= now || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 300_000) return undefined;
    const renewed = { ...current, expiresAt: now + ttlMs }; this.leases.set(full, renewed); return copy(renewed);
  }
  async releaseRunTeardownLease(runId: string, owner: string, fencingToken: number): Promise<void> {
    const full = `${runId}:teardown`; const current = this.leases.get(full); if (current?.owner === owner && current.fencingToken === fencingToken) this.leases.delete(full);
  }
  async blockRunTeardown(runId: string, owner: string, error: { readonly code: string; readonly message: string }, now = Date.now()): Promise<RunTeardownRecord> {
    const current = this.runs.get(runId); if (!current?.teardown) throw new StoreConflictError("teardown intent is absent");
    if (current.teardown.state === "blocked") return copy(current.teardown);
    if (current.teardown.state === "completed" || current.teardown.owner !== owner || !error || typeof error.code !== "string" || typeof error.message !== "string" || error.code.length === 0 || error.code.length > 128 || error.message.length === 0 || error.message.length > 1_000 || /[\u0000-\u001f\u007f\r\n]/u.test(`${error.code}${error.message}`)) throw new StoreConflictError("teardown block ownership or error is invalid");
    const teardown: RunTeardownRecord = { ...current.teardown, state: "blocked", error: { code: error.code, message: error.message, at: new Date(now).toISOString() } };
    this.runs.set(runId, copy({ ...current, version: current.version + 1, teardown })); return copy(teardown);
  }
  async acquireRunTerminalFence(runId: string, owner: string, now = Date.now()): Promise<RunTerminalFence> {
    const current = this.runs.get(runId);
    if (!current) throw new StoreConflictError("run not found");
    if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(owner) || !Number.isSafeInteger(now)) throw new StoreConflictError("terminal fence owner or time is invalid");
    if (current.terminalFence?.state === "removed") throw new StoreConflictError("run has been removed");
    if (current.teardown?.state === "blocked" || current.teardown?.state === "completed") throw new StoreConflictError("teardown is durably blocked or completed");
    this.assertDurablyQuiescent(runId, now, current);
    if (current.terminalFence) return copy(current.terminalFence);
    const fence: RunTerminalFence = { runId, owner, fencingToken: current.version + 1, acquiredAt: new Date(now).toISOString(), state: "held" };
    const teardown = current.teardown ?? { runId, owner, generation: 1, state: "draining" as const, reason: "terminal" as const, requestedAt: new Date(now).toISOString() };
    this.runs.set(runId, copy({ ...current, version: current.version + 1, terminalFence: fence, teardown: { ...teardown, state: "fenced" as const, fence } }));
    return copy(fence);
  }
  async assertRunTeardownQuiescent(runId: string, fence: RunTerminalFence, now = Date.now()): Promise<void> {
    const current = this.runs.get(runId);
    if (!current) throw new StoreConflictError("run not found");
    const persisted = current.terminalFence;
    if (current.teardown?.state === "blocked" || current.teardown?.state === "completed") throw new StoreConflictError("teardown is durably blocked or completed");
    if (fence.runId !== runId || fence.state !== "held" || !persisted || persisted.state !== "held" || persisted.runId !== fence.runId || persisted.owner !== fence.owner || persisted.fencingToken !== fence.fencingToken) throw new StoreConflictError("terminal fence ownership changed");
    this.assertDurablyQuiescent(runId, now, current);
  }
  async completeRunTeardown(runId: string, fence: RunTerminalFence, now = Date.now()): Promise<void> {
    const current = this.runs.get(runId);
    if (!current) throw new StoreConflictError("run not found");
    const persisted = current.terminalFence;
    if (!persisted || persisted.runId !== fence.runId || persisted.owner !== fence.owner || persisted.fencingToken !== fence.fencingToken) throw new StoreConflictError("terminal fence ownership changed");
    if (persisted.state === "removed") return;
    await this.assertRunTeardownQuiescent(runId, fence, now);
    const removed: RunTerminalFence = { ...persisted, state: "removed" };
    const teardown = current.teardown ? { ...current.teardown, state: "completed" as const, fence: removed } : undefined;
    this.runs.set(runId, copy({ ...current, version: current.version + 1, terminalFence: removed, ...(teardown ? { teardown } : {}) }));
  }
  private assertDurablyQuiescent(runId: string, now: number, current: RunSnapshot): void {
    if (Object.values(current.processAllocations ?? {}).some(Boolean)) throw new StoreConflictError("workflow is not durably quiescent: process allocation remains");
    if (Object.values(current.sessions).some(session => session?.processState === "live" || session?.processState === "launching")) throw new StoreConflictError("workflow is not durably quiescent: role process remains");
    if (current.sandbox?.operation) throw new StoreConflictError("workflow is not durably quiescent: sandbox operation remains");
    if ([...this.leases.entries()].some(([key, lease]) => key.startsWith(`${runId}:`) && key !== `${runId}:teardown` && lease.expiresAt > now)) throw new StoreConflictError("workflow is not durably quiescent: lease remains");
    if ((current.preparationLeases ?? []).some(lease => lease.state === "held")) throw new StoreConflictError("workflow is not durably quiescent: preparation lease remains");
  }
  async compareAndSet(runId: string, expected: RunPrecondition, mutate: (current: RunSnapshot) => RunSnapshot): Promise<RunSnapshot> {
    const current = this.runs.get(runId);
    if (!current) throw new StoreConflictError("run not found");
    if (current.terminalFence) throw new StoreConflictError("run has a permanent terminal fence (teardown drain)");
    assertPrecondition(current, expected);
    const next = mutate(copy(current));
    if (next.runId !== runId || next.version !== current.version + 1) throw new StoreConflictError("mutation must preserve run and increment version exactly once");
    if (current.teardown && !isQuiescenceCleanupMutation(current, next)) throw new StoreConflictError("only exact process quiescence cleanup may mutate a drained run");
    const attemptKeys = next.attempts.map(a => `${a.phase}:${a.attempt}`);
    const handoffs = next.attempts.map(a => a.handoffId);
    const operations = next.attempts.map(a => a.dispatch.operationKey);
    if (new Set(attemptKeys).size !== attemptKeys.length || new Set(handoffs).size !== handoffs.length || new Set(operations).size !== operations.length) throw new StoreConflictError("duplicate attempt, handoff, or operation");
    if (new Set(next.acceptedResultPaths).size !== next.acceptedResultPaths.length || new Set(next.committedRequestIds).size !== next.committedRequestIds.length) throw new StoreConflictError("duplicate result acceptance or transition request");
    assertGitWorkspaceMutation(current.gitWorkspace, next.gitWorkspace);
    assertSandboxRecordMutation(current.sandbox, next.sandbox, runId);
    this.runs.set(runId, copy(next));
    return copy(next);
  }
  async compareAndSetFenced(runId: string, expected: RunPrecondition, guard: LeaseGuard, mutate: (current: RunSnapshot) => RunSnapshot): Promise<RunSnapshot> {
    const lease = this.leases.get(`${runId}:${guard.key}`);
    if (!lease || lease.owner !== guard.owner || lease.fencingToken !== guard.fencingToken || lease.expiresAt <= guard.now) throw new StoreConflictError("stale or expired lease fencing token");
    return this.compareAndSet(runId, expected, mutate);
  }
  async compareAndSetTeardown(runId: string, expected: RunPrecondition, fence: RunTerminalFence, mutate: (current: RunSnapshot) => RunSnapshot): Promise<RunSnapshot> {
    const current = this.runs.get(runId); if (!current) throw new StoreConflictError("run not found");
    const persisted = current.terminalFence;
    if (!persisted || persisted.state !== "held" || current.teardown?.state !== "fenced" || current.teardown.fence?.owner !== fence.owner || current.teardown.fence?.fencingToken !== fence.fencingToken || fence.state !== "held" || fence.runId !== runId || persisted.owner !== fence.owner || persisted.fencingToken !== fence.fencingToken || persisted.runId !== runId) throw new StoreConflictError("teardown CAS lacks the current terminal fence");
    assertPrecondition(current, expected);
    const next = mutate(copy(current));
    if (next.runId !== runId || next.version !== current.version + 1) throw new StoreConflictError("teardown mutation must preserve run and increment version exactly once");
    if (!isTeardownMutation(current, next)) throw new StoreConflictError("teardown CAS attempted an unrelated workflow mutation");
    assertGitWorkspaceMutation(current.gitWorkspace, next.gitWorkspace);
    assertSandboxRecordMutation(current.sandbox, next.sandbox, runId);
    this.runs.set(runId, copy(next)); return copy(next);
  }
  async registerSession(runId: string, expected: RunPrecondition, registration: SessionRegistration): Promise<RunSnapshot> {
    return this.compareAndSet(runId, expected, current => this.registrationMutation(current, registration));
  }
  async registerSessionFenced(runId: string, expected: RunPrecondition, guard: LeaseGuard, registration: SessionRegistration): Promise<RunSnapshot> {
    return this.compareAndSetFenced(runId, expected, guard, current => {
      const allocation = current.processAllocations?.[registration.role];
      if (!allocation || allocation.owner !== guard.owner || allocation.fencingToken !== guard.fencingToken || allocation.generation !== registration.processGeneration || allocation.sessionId || allocation.state !== "spawned" || allocation.processIdentity !== registration.processIdentity) throw new StoreConflictError("session registration lacks current first-session spawned allocation");
      const next = this.registrationMutation(current, registration); const processAllocations = { ...next.processAllocations }; delete processAllocations[registration.role];
      return { ...next, processAllocations };
    });
  }
  private registrationMutation(current: RunSnapshot, registration: SessionRegistration): RunSnapshot {
    const existingRole = current.sessions[registration.role];
    const existingIdentity = Object.values(current.sessions).find(s => s?.sessionId === registration.sessionId || s?.sessionFile === registration.sessionFile);
    if (existingRole || existingIdentity) throw new StoreConflictError("role or session identity already registered");
    return { ...current, version: current.version + 1, sessions: { ...current.sessions, [registration.role]: copy(registration) } };
  }
  async getSession(runId: string, role: Role): Promise<SessionRegistration | undefined> { return (await this.read(runId))?.sessions[role]; }
  async recordRuntime(runId: string, expected: RunPrecondition, resolution: RuntimeResolution): Promise<RunSnapshot> {
    return this.compareAndSet(runId, expected, current => this.runtimeMutation(current, resolution));
  }
  async recordRuntimeFenced(runId: string, expected: RunPrecondition, guard: LeaseGuard, resolution: RuntimeResolution): Promise<RunSnapshot> {
    return this.compareAndSetFenced(runId, expected, guard, current => this.runtimeMutation(current, resolution));
  }
  private runtimeMutation(current: RunSnapshot, resolution: RuntimeResolution): RunSnapshot {
    if (current.runtimeResolution) throw new StoreConflictError("runtime already resolved for run");
    if (resolution.runId !== current.runId) throw new StoreConflictError("runtime resolution belongs to another run");
    return { ...current, version: current.version + 1, runtimeResolution: copy(resolution) };
  }
  async retainProcessAllocation(runId: string, expected: RunPrecondition, retention: ProcessAllocationRetention): Promise<RunSnapshot> {
    const current = this.runs.get(runId); if (!current) throw new StoreConflictError("run not found"); assertPrecondition(current, expected);
    const allocation = current.processAllocations?.[retention.role];
    const owned = allocation?.owner === retention.failedOwner && allocation.fencingToken === retention.failedFencingToken && allocation.generation === retention.generation;
    if (!owned) return copy(current);
    if (allocation.state === "reserved" || allocation.state === "failed") throw new StoreConflictError("allocation has no retainable process intent");
    if (allocation.processIdentity && allocation.processIdentity !== retention.processIdentity) throw new StoreConflictError("process retention identity mismatch");
    if (allocation.state === "termination_failed" && allocation.processIdentity === retention.processIdentity) return copy(current);
    return this.compareAndSet(runId, expected, snapshot => ({ ...snapshot, version: snapshot.version + 1, processAllocations: { ...snapshot.processAllocations, [retention.role]: { ...allocation, state: "termination_failed", processIdentity: retention.processIdentity } } }));
  }
  async recoverProcessAllocation(runId: string, expected: RunPrecondition, recovery: ProcessAllocationRecovery): Promise<RunSnapshot> {
    const current = this.runs.get(runId); if (!current) throw new StoreConflictError("run not found"); assertPrecondition(current, expected);
    if (recovery.processIdentity && !recovery.processExited) throw new StoreConflictError("process cleanup requires observed exit");
    const allocation = current.processAllocations?.[recovery.role];
    const ownedByToken = allocation?.owner === recovery.failedOwner && allocation.fencingToken === recovery.failedFencingToken && (recovery.generation === undefined || allocation.generation === recovery.generation);
    if (ownedByToken && allocation.processIdentity && (!recovery.processExited || allocation.processIdentity !== recovery.processIdentity)) throw new StoreConflictError("process cleanup identity or exit observation mismatch");
    const owned = ownedByToken;
    const sessions = { ...current.sessions }; const processAllocations = { ...current.processAllocations }; let changed = false;
    if (owned) {
      const session = sessions[recovery.role];
      if (allocation.sessionId) {
        if (session?.sessionId === allocation.sessionId && session.processGeneration === allocation.generation && (session.processState === "launching" || session.processState === "live")) sessions[recovery.role] = { ...session, processState: "failed", ...(recovery.processIdentity ? { processIdentity: recovery.processIdentity } : {}) };
        delete processAllocations[recovery.role];
      } else if (recovery.processIdentity) processAllocations[recovery.role] = { ...allocation, state: "failed", processIdentity: recovery.processIdentity };
      else delete processAllocations[recovery.role];
      changed = true;
    } else if (!allocation && recovery.processIdentity && recovery.generation !== undefined) {
      const session = sessions[recovery.role];
      if (session?.processGeneration === recovery.generation && session.processIdentity === recovery.processIdentity && (session.processState === "launching" || session.processState === "live")) { sessions[recovery.role] = { ...session, processState: "failed" }; changed = true; }
    }
    if (!changed) return copy(current);
    return this.compareAndSet(runId, expected, snapshot => ({ ...snapshot, version: snapshot.version + 1, sessions, processAllocations }));
  }
  async acquireLease(runId: string, key: string, owner: string, now: number, ttlMs: number): Promise<Lease | undefined> {
    const snapshot = this.runs.get(runId);
    if (!snapshot || snapshot.terminalFence || snapshot.teardown) return undefined;
    const full = `${runId}:${key}`; const current = this.leases.get(full);
    if (current && current.expiresAt > now) return current.owner === owner ? copy(current) : undefined;
    const fencingToken = (this.leaseTokens.get(full) ?? 0) + 1; this.leaseTokens.set(full, fencingToken);
    const lease = { key, owner, fencingToken, expiresAt: now + ttlMs }; this.leases.set(full, lease); return copy(lease);
  }
  async renewLease(runId: string, key: string, owner: string, fencingToken: number, now: number, ttlMs: number): Promise<Lease | undefined> {
    const snapshot = this.runs.get(runId);
    if (!snapshot || snapshot.terminalFence || snapshot.teardown?.state === "blocked" || snapshot.teardown?.state === "completed") return undefined;
    const full = `${runId}:${key}`; const current = this.leases.get(full);
    if (!current || current.owner !== owner || current.fencingToken !== fencingToken || current.expiresAt <= now) return undefined;
    const renewed = { ...current, expiresAt: now + ttlMs }; this.leases.set(full, renewed); return copy(renewed);
  }
  async releaseLease(runId: string, key: string, owner: string, fencingToken: number): Promise<void> {
    const full = `${runId}:${key}`; const current = this.leases.get(full); if (current?.owner === owner && current.fencingToken === fencingToken) this.leases.delete(full);
  }
}

function isTeardownMutation(previous: RunSnapshot, next: RunSnapshot): boolean {
  const { version: _previousVersion, gitWorkspace: _previousGit, sandbox: _previousSandbox, ...previousWithoutComponents } = previous;
  const { version: _nextVersion, gitWorkspace: _nextGit, sandbox: _nextSandbox, ...nextWithoutComponents } = next;
  const { sessions: _previousSessions, processAllocations: _previousAllocations, ...previousWithoutProcess } = previousWithoutComponents;
  const { sessions: _nextSessions, processAllocations: _nextAllocations, ...nextWithoutProcess } = nextWithoutComponents;
  if (JSON.stringify(previousWithoutProcess) !== JSON.stringify(nextWithoutProcess)) return false;
  const previousProcess = { ...previousWithoutComponents, sessions: _previousSessions, processAllocations: _previousAllocations } as RunSnapshot;
  const nextProcess = { ...nextWithoutComponents, sessions: _nextSessions, processAllocations: _nextAllocations } as RunSnapshot;
  return isQuiescenceCleanupMutation(previousProcess, nextProcess);
}

function isQuiescenceCleanupMutation(previous: RunSnapshot, next: RunSnapshot): boolean {
  const { version: _previousVersion, sessions: previousSessions, processAllocations: previousAllocations, ...previousRest } = previous;
  const { version: _nextVersion, sessions: nextSessions, processAllocations: nextAllocations, ...nextRest } = next;
  if (JSON.stringify(previousRest) !== JSON.stringify(nextRest)) return false;
  const previousRoles = new Set(Object.keys(previousSessions));
  if (Object.keys(nextSessions).some(role => !previousRoles.has(role))) return false;
  for (const role of previousRoles) {
    const before = previousSessions[role as Role];
    const after = nextSessions[role as Role];
    if (!before) { if (after) return false; continue; }
    if (!after) return false;
    const { processState: beforeState, processIdentity: beforeIdentity, ...beforeIdentityFields } = before;
    const { processState: afterState, processIdentity: afterIdentity, ...afterIdentityFields } = after;
    if (JSON.stringify(beforeIdentityFields) !== JSON.stringify(afterIdentityFields) || beforeIdentity !== undefined && afterIdentity !== beforeIdentity || beforeIdentity === undefined && afterIdentity !== undefined && afterState === beforeState || afterState !== beforeState && !(beforeState === "live" || beforeState === "launching") || afterState !== beforeState && afterState !== "failed" && afterState !== "exited") return false;
  }
  const previousAllocationRoles = new Set(Object.keys(previousAllocations ?? {}));
  if (Object.keys(nextAllocations ?? {}).some(role => !previousAllocationRoles.has(role))) return false;
  for (const role of previousAllocationRoles) {
    const before = previousAllocations?.[role as Role];
    const after = nextAllocations?.[role as Role];
    if (!before) { if (after) return false; continue; }
    if (!after) continue;
    const { state: _beforeState, ...beforeFields } = before;
    const { state: afterState, ...afterFields } = after;
    if (JSON.stringify(beforeFields) !== JSON.stringify(afterFields) || afterState !== "failed") return false;
  }
  return true;
}

function assertGitWorkspaceMutation(previous: GitWorkspaceRecord | undefined, next: GitWorkspaceRecord | undefined): void {
  if (!previous && !next) return;
  if (!previous && next) {
    if (next.stage !== "provisioning" || next.operationGeneration !== 1) throw new StoreConflictError("Git workspace must begin at provisioning generation one");
    return;
  }
  if (!next) throw new StoreConflictError("Git workspace record cannot be removed by an arbitrary mutation");
  if (!previous) throw new StoreConflictError("Git workspace record creation was not a provisioning mutation");
  if (previous.runId !== next.runId || previous.spec.path !== next.spec.path || previous.spec.sha256 !== next.spec.sha256 || previous.spec.schemaId !== next.spec.schemaId || previous.specFingerprint !== next.specFingerprint || previous.featureBranch !== next.featureBranch || JSON.stringify(previous.paths) !== JSON.stringify(next.paths)) throw new StoreConflictError("Git workspace immutable identity changed");
  if (next.operationGeneration < previous.operationGeneration || next.operationGeneration > previous.operationGeneration + 1) throw new StoreConflictError("Git workspace operation generation is not monotonic");
  const allowed: Record<GitWorkspaceRecord["stage"], readonly GitWorkspaceRecord["stage"][]> = {
    provisioning: ["provisioning", "ready", "blocked"],
    ready: ["ready", "exporting", "retained", "blocked"],
    exporting: ["exporting", "ready", "blocked"],
    retained: ["retained"],
    blocked: ["blocked"],
  };
  if (!allowed[previous.stage].includes(next.stage)) throw new StoreConflictError(`illegal Git workspace stage transition ${previous.stage}->${next.stage}`);
  if (previous.stage === "ready" && next.stage === "exporting" && next.operationGeneration !== previous.operationGeneration + 1) throw new StoreConflictError("bundle export did not allocate a new generation");
  if (!(previous.stage === "ready" && next.stage === "exporting") && next.operationGeneration !== previous.operationGeneration) throw new StoreConflictError("Git workspace generation changed outside export reservation");
}
