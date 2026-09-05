import type { Lease, LeaseGuard, ProcessAllocationRecovery, ProcessAllocationRetention, Role, RunPreparationLease, RunPrecondition, RunSnapshot, RunTerminalFence, RuntimeResolution, SessionRegistration } from "./domain.js";
import type { RunTeardownRecord } from "../sandbox/domain.js";

export class StoreConflictError extends Error {
  constructor(message: string) { super(message); this.name = "StoreConflictError"; }
}

/** Persistence port only. AIDEV-224 supplies SQLite, migrations, intake, and startup reconciliation. */
export interface RunQuiescenceAuthority {
  /** Atomically rejects new run work once the durable terminal fence is held. */
  assertRunStartAllowed(runId: string, now?: number): Promise<void>;
  /**
   * Acquire durable preparation ownership before any run filesystem
   * observation. The store must perform this atomically with its terminal-fence
   * check, and must reject a run whose permanent fence is already held.
   */
  acquireRunPreparationLease(runId: string, owner: string, now?: number): Promise<RunPreparationLease>;
  /** Release only the exact preparation lease that this operation acquired. */
  releaseRunPreparationLease(runId: string, lease: RunPreparationLease, now?: number): Promise<void>;
  /** Permanently drain the run before any component attempts terminal cleanup. */
  beginRunTeardown(runId: string, owner: string, reason?: RunTeardownRecord["reason"], now?: number): Promise<RunTeardownRecord>;
  /** Acquire a short-lived aggregate cleanup lease after the permanent drain. This is a lease, not a second lifecycle fence. */
  acquireRunTeardownLease?(runId: string, owner: string, now?: number, ttlMs?: number): Promise<Lease | undefined>;
  renewRunTeardownLease?(runId: string, owner: string, fencingToken: number, now?: number, ttlMs?: number): Promise<Lease | undefined>;
  releaseRunTeardownLease?(runId: string, owner: string, fencingToken: number): Promise<void>;
  /** Record a durable cleanup failure while preserving the drain/fence for a later exact retry. */
  blockRunTeardown?(runId: string, owner: string, error: { readonly code: string; readonly message: string }, now?: number): Promise<RunTeardownRecord>;
  /** Acquire or resume the permanent terminal fence after durable quiescence. */
  acquireRunTerminalFence(runId: string, owner: string, now?: number): Promise<RunTerminalFence>;
  /**
   * Re-prove the persisted teardown invariant immediately before destructive
   * disposal: this exact workflow fence is held and no allocation, live role,
   * termination-failed role, or preparation lease remains.
   */
  assertRunTeardownQuiescent(runId: string, fence: RunTerminalFence, now?: number): Promise<void>;
  /** Mark the durable run removed; the terminal fence is never released. */
  completeRunTeardown(runId: string, fence: RunTerminalFence, now?: number): Promise<void>;
}

/**
 * Git workspace operations use this existing generic lease/CAS surface. The
 * RunQuiescenceAuthority preparation leases and terminal fence remain the
 * single lifecycle authority: acquireRunTerminalFence must continue to see
 * generic leases and preparationLeases, ordinary mutation is forbidden after
 * the fence, and a crashed Git operation may release only its exact persisted
 * preparation owner after command-supervisor proof that no child is live or
 * unknown. No Git-specific lifecycle or SQL method belongs here.
 */
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
  /** Controlled CAS surface for component disposal after the permanent fence is held. */
  compareAndSetTeardown(runId: string, precondition: RunPrecondition, fence: RunTerminalFence, mutate: (current: RunSnapshot) => RunSnapshot): Promise<RunSnapshot>;
  acquireLease(runId: string, key: string, owner: string, now: number, ttlMs: number): Promise<Lease | undefined>;
  renewLease(runId: string, key: string, owner: string, fencingToken: number, now: number, ttlMs: number): Promise<Lease | undefined>;
  releaseLease(runId: string, key: string, owner: string, fencingToken: number): Promise<void>;
}

export function assertPrecondition(current: RunSnapshot, expected: RunPrecondition): void {
  if (current.version !== expected.version) throw new StoreConflictError("stale run version");
  if (expected.state !== undefined && current.state !== expected.state) throw new StoreConflictError("stale workflow state");
  if (expected.currentHead !== undefined && current.currentHead !== expected.currentHead) throw new StoreConflictError("stale Git head");
}
