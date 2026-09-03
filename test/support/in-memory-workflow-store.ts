import { assertPrecondition, StoreConflictError, type WorkflowStore } from "../../src/control/workflow-store.js";
import type { Lease, LeaseGuard, ProcessAllocationRecovery, ProcessAllocationRetention, Role, RunPrecondition, RunSnapshot, RunTerminalFence, RuntimeResolution, SessionRegistration } from "../../src/control/domain.js";

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
    if (current.terminalFence) throw new StoreConflictError(current.terminalFence.state === "removed" ? "run has been removed" : "run has a permanent terminal fence");
  }
  async acquireRunTerminalFence(runId: string, owner: string, now = Date.now()): Promise<RunTerminalFence> {
    const current = this.runs.get(runId);
    if (!current) throw new StoreConflictError("run not found");
    if (current.terminalFence?.state === "removed") throw new StoreConflictError("run has been removed");
    this.assertDurablyQuiescent(runId, now, current);
    if (current.terminalFence) return copy(current.terminalFence);
    const fence: RunTerminalFence = { runId, owner, fencingToken: current.version + 1, acquiredAt: new Date(now).toISOString(), state: "held" };
    this.runs.set(runId, copy({ ...current, version: current.version + 1, terminalFence: fence }));
    return copy(fence);
  }
  async completeRunTeardown(runId: string, fence: RunTerminalFence, now = Date.now()): Promise<void> {
    const current = this.runs.get(runId);
    if (!current) throw new StoreConflictError("run not found");
    const persisted = current.terminalFence;
    if (!persisted || persisted.runId !== fence.runId || persisted.owner !== fence.owner || persisted.fencingToken !== fence.fencingToken) throw new StoreConflictError("terminal fence ownership changed");
    if (persisted.state === "removed") return;
    this.assertDurablyQuiescent(runId, now, current);
    const removed: RunTerminalFence = { ...persisted, state: "removed" };
    this.runs.set(runId, copy({ ...current, version: current.version + 1, terminalFence: removed }));
  }
  private assertDurablyQuiescent(runId: string, now: number, current: RunSnapshot): void {
    if (Object.values(current.processAllocations ?? {}).some(Boolean)) throw new StoreConflictError("workflow is not durably quiescent: process allocation remains");
    if (Object.values(current.sessions).some(session => session?.processState === "live" || session?.processState === "launching")) throw new StoreConflictError("workflow is not durably quiescent: role process remains");
    if ([...this.leases.entries()].some(([key, lease]) => key.startsWith(`${runId}:`) && lease.expiresAt > now)) throw new StoreConflictError("workflow is not durably quiescent: lease remains");
  }
  async compareAndSet(runId: string, expected: RunPrecondition, mutate: (current: RunSnapshot) => RunSnapshot): Promise<RunSnapshot> {
    const current = this.runs.get(runId);
    if (!current) throw new StoreConflictError("run not found");
    if (current.terminalFence) throw new StoreConflictError("run has a permanent terminal fence");
    assertPrecondition(current, expected);
    const next = mutate(copy(current));
    if (next.runId !== runId || next.version !== current.version + 1) throw new StoreConflictError("mutation must preserve run and increment version exactly once");
    const attemptKeys = next.attempts.map(a => `${a.phase}:${a.attempt}`);
    const handoffs = next.attempts.map(a => a.handoffId);
    const operations = next.attempts.map(a => a.dispatch.operationKey);
    if (new Set(attemptKeys).size !== attemptKeys.length || new Set(handoffs).size !== handoffs.length || new Set(operations).size !== operations.length) throw new StoreConflictError("duplicate attempt, handoff, or operation");
    if (new Set(next.acceptedResultPaths).size !== next.acceptedResultPaths.length || new Set(next.committedRequestIds).size !== next.committedRequestIds.length) throw new StoreConflictError("duplicate result acceptance or transition request");
    this.runs.set(runId, copy(next));
    return copy(next);
  }
  async compareAndSetFenced(runId: string, expected: RunPrecondition, guard: LeaseGuard, mutate: (current: RunSnapshot) => RunSnapshot): Promise<RunSnapshot> {
    const lease = this.leases.get(`${runId}:${guard.key}`);
    if (!lease || lease.owner !== guard.owner || lease.fencingToken !== guard.fencingToken || lease.expiresAt <= guard.now) throw new StoreConflictError("stale or expired lease fencing token");
    return this.compareAndSet(runId, expected, mutate);
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
    if (!snapshot || snapshot.terminalFence) return undefined;
    const full = `${runId}:${key}`; const current = this.leases.get(full);
    if (current && current.expiresAt > now) return current.owner === owner ? copy(current) : undefined;
    const fencingToken = (this.leaseTokens.get(full) ?? 0) + 1; this.leaseTokens.set(full, fencingToken);
    const lease = { key, owner, fencingToken, expiresAt: now + ttlMs }; this.leases.set(full, lease); return copy(lease);
  }
  async renewLease(runId: string, key: string, owner: string, fencingToken: number, now: number, ttlMs: number): Promise<Lease | undefined> {
    const snapshot = this.runs.get(runId);
    if (!snapshot || snapshot.terminalFence) return undefined;
    const full = `${runId}:${key}`; const current = this.leases.get(full);
    if (!current || current.owner !== owner || current.fencingToken !== fencingToken || current.expiresAt <= now) return undefined;
    const renewed = { ...current, expiresAt: now + ttlMs }; this.leases.set(full, renewed); return copy(renewed);
  }
  async releaseLease(runId: string, key: string, owner: string, fencingToken: number): Promise<void> {
    const full = `${runId}:${key}`; const current = this.leases.get(full); if (current?.owner === owner && current.fencingToken === fencingToken) this.leases.delete(full);
  }
}
