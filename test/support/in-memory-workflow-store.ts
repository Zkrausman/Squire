import { assertPrecondition, StoreConflictError, type WorkflowStore } from "../../src/control/workflow-store.js";
import type { Lease, LeaseGuard, Role, RunPrecondition, RunSnapshot, RuntimeResolution, SessionRegistration } from "../../src/control/domain.js";

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
  async compareAndSet(runId: string, expected: RunPrecondition, mutate: (current: RunSnapshot) => RunSnapshot): Promise<RunSnapshot> {
    const current = this.runs.get(runId);
    if (!current) throw new StoreConflictError("run not found");
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
    return this.compareAndSet(runId, expected, current => {
      const existingRole = current.sessions[registration.role];
      const existingIdentity = Object.values(current.sessions).find(s => s?.sessionId === registration.sessionId || s?.sessionFile === registration.sessionFile);
      if (existingRole || existingIdentity) throw new StoreConflictError("role or session identity already registered");
      return { ...current, version: current.version + 1, sessions: { ...current.sessions, [registration.role]: copy(registration) } };
    });
  }
  async getSession(runId: string, role: Role): Promise<SessionRegistration | undefined> { return (await this.read(runId))?.sessions[role]; }
  async recordRuntime(runId: string, expected: RunPrecondition, resolution: RuntimeResolution): Promise<RunSnapshot> {
    return this.compareAndSet(runId, expected, current => {
      if (current.runtimeResolution) throw new StoreConflictError("runtime already resolved for run");
      if (resolution.runId !== runId) throw new StoreConflictError("runtime resolution belongs to another run");
      return { ...current, version: current.version + 1, runtimeResolution: copy(resolution) };
    });
  }
  async acquireLease(runId: string, key: string, owner: string, now: number, ttlMs: number): Promise<Lease | undefined> {
    const full = `${runId}:${key}`; const current = this.leases.get(full);
    if (current && current.expiresAt > now) return current.owner === owner ? copy(current) : undefined;
    const fencingToken = (this.leaseTokens.get(full) ?? 0) + 1; this.leaseTokens.set(full, fencingToken);
    const lease = { key, owner, fencingToken, expiresAt: now + ttlMs }; this.leases.set(full, lease); return copy(lease);
  }
  async renewLease(runId: string, key: string, owner: string, fencingToken: number, now: number, ttlMs: number): Promise<Lease | undefined> {
    const full = `${runId}:${key}`; const current = this.leases.get(full);
    if (!current || current.owner !== owner || current.fencingToken !== fencingToken || current.expiresAt <= now) return undefined;
    const renewed = { ...current, expiresAt: now + ttlMs }; this.leases.set(full, renewed); return copy(renewed);
  }
  async releaseLease(runId: string, key: string, owner: string, fencingToken: number): Promise<void> {
    const full = `${runId}:${key}`; const current = this.leases.get(full); if (current?.owner === owner && current.fencingToken === fencingToken) this.leases.delete(full);
  }
}
