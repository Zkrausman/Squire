import type { Lease, LeaseGuard, ProcessAllocationRecovery, ProcessAllocationRetention, Role, RunPrecondition, RunSnapshot, RunTerminalFence, RuntimeResolution, SessionRegistration } from "./domain.js";

export class StoreConflictError extends Error {
  constructor(message: string) { super(message); this.name = "StoreConflictError"; }
}

/** Persistence port only. AIDEV-224 supplies SQLite, migrations, intake, and startup reconciliation. */
export interface RunQuiescenceAuthority {
  /** Atomically rejects new run work once the durable terminal fence is held. */
  assertRunStartAllowed(runId: string, now?: number): Promise<void>;
  /** Acquire or resume the permanent terminal fence after durable quiescence. */
  acquireRunTerminalFence(runId: string, owner: string, now?: number): Promise<RunTerminalFence>;
  /** Mark the durable run removed; the terminal fence is never released. */
  completeRunTeardown(runId: string, fence: RunTerminalFence, now?: number): Promise<void>;
}

export interface WorkflowStore extends RunQuiescenceAuthority {
  create(snapshot: RunSnapshot): Promise<void>;
  read(runId: string): Promise<RunSnapshot | undefined>;
  compareAndSet(runId: string, precondition: RunPrecondition, mutate: (current: RunSnapshot) => RunSnapshot): Promise<RunSnapshot>;
  compareAndSetFenced(runId: string, precondition: RunPrecondition, lease: LeaseGuard, mutate: (current: RunSnapshot) => RunSnapshot): Promise<RunSnapshot>;
  registerSession(runId: string, precondition: RunPrecondition, registration: SessionRegistration): Promise<RunSnapshot>;
  /** Atomically verifies the current spawned allocation identity/token, registers, and clears it. */
  registerSessionFenced(runId: string, precondition: RunPrecondition, lease: LeaseGuard, registration: SessionRegistration): Promise<RunSnapshot>;
  getSession(runId: string, role: Role): Promise<SessionRegistration | undefined>;
  recordRuntime(runId: string, precondition: RunPrecondition, resolution: RuntimeResolution): Promise<RunSnapshot>;
  recordRuntimeFenced(runId: string, precondition: RunPrecondition, lease: LeaseGuard, resolution: RuntimeResolution): Promise<RunSnapshot>;
  /** Idempotently persists a known live identity without clearing exact allocation ownership. */
  retainProcessAllocation(runId: string, precondition: RunPrecondition, retention: ProcessAllocationRetention): Promise<RunSnapshot>;
  /** Idempotent exact-owner/token compensation; valid only after any returned process is observed exited. */
  recoverProcessAllocation(runId: string, precondition: RunPrecondition, recovery: ProcessAllocationRecovery): Promise<RunSnapshot>;
  acquireLease(runId: string, key: string, owner: string, now: number, ttlMs: number): Promise<Lease | undefined>;
  renewLease(runId: string, key: string, owner: string, fencingToken: number, now: number, ttlMs: number): Promise<Lease | undefined>;
  releaseLease(runId: string, key: string, owner: string, fencingToken: number): Promise<void>;
}

export function assertPrecondition(current: RunSnapshot, expected: RunPrecondition): void {
  if (current.version !== expected.version) throw new StoreConflictError("stale run version");
  if (expected.state !== undefined && current.state !== expected.state) throw new StoreConflictError("stale workflow state");
  if (expected.currentHead !== undefined && current.currentHead !== expected.currentHead) throw new StoreConflictError("stale Git head");
}
