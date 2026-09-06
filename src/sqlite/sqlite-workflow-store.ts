import { StoreConflictError, assertPrecondition, type WorkflowStore } from "../control/workflow-store.js";
import { assertRunSnapshotMutation, assertRunSnapshotShape } from "../control/run-snapshot-invariants.js";
import { isTerminal, type Clock, type Lease, type LeaseGuard, type ProcessAllocationRecovery, type ProcessAllocationRetention, type Role, type RunPreparationLease, type RunPrecondition, type RunSnapshot, type RunTerminalFence, type RuntimeResolution, type SessionRegistration, type WorkflowState } from "../control/domain.js";
import { decodeJson, decodeSnapshot, encodeJson, encodeSnapshot, RowCorruptionError } from "./row-codec.js";
import { SqliteDatabase, SqliteCorruptionError } from "./sqlite-database.js";

const COPY = <T>(value: T): T => structuredClone(value);
const ACTIVE_STATES = new Set(["accepted", "preparing", "planning", "implementing", "reviewing", "testing", "publishing", "awaiting_approval"]);
const ALL_STATES = new Set([...ACTIVE_STATES, "approved", "failed", "cancelled", "expired"]);

export interface SqliteWorkflowStoreOptions { readonly database: SqliteDatabase | string; readonly clock?: Clock; }

/** Durable implementation of the AIDEV-216 persistence port.  Relational
 * child tables provide uniqueness and inspection; snapshot_json is a lossless
 * projection used only after all row/projection checks pass. */
export class SqliteWorkflowStore implements WorkflowStore {
  readonly database: SqliteDatabase;
  readonly #clock: Clock;
  readonly #ownsDatabase: boolean;

  constructor(database: SqliteDatabase | string | SqliteWorkflowStoreOptions) {
    const options: SqliteWorkflowStoreOptions = typeof database === "string" ? { database } : "database" in database ? database : { database };
    this.#ownsDatabase = typeof options.database === "string";
    this.database = typeof options.database === "string" ? new SqliteDatabase(options.database) : options.database;
    this.#clock = options.clock ?? { now: () => Date.now(), sleep: async ms => { await new Promise<void>(resolve => setTimeout(resolve, ms)); } };
  }
  close(): void { if (this.#ownsDatabase) this.database.close(); }

  async create(snapshot: RunSnapshot): Promise<void> {
    assertRunSnapshotShape(snapshot);
    try {
      this.database.transactionImmediate(() => {
        if (this.#load(snapshot.runId)) throw new StoreConflictError("run already exists");
        this.#insertSnapshot(snapshot);
        this.#syncChildren(snapshot);
        if (snapshot.identity && ACTIVE_STATES.has(snapshot.state)) {
          this.database.prepare("INSERT INTO ticket_run_locks(linear_issue_id, run_id, acquired_at) VALUES (?, ?, ?)").run(snapshot.identity.linearIssueId, snapshot.runId, snapshot.timestamps?.createdAt ?? new Date(this.#clock.now()).toISOString());
          if (snapshot.state === "accepted") this.database.prepare("INSERT INTO workflow_events(run_id, sequence, from_state, to_state, trigger, request_id, head, occurred_at, details_json) VALUES (?, 0, NULL, 'accepted', 'run_accepted', ?, ?, ?, ?)").run(snapshot.runId, snapshot.identity.intakeIdempotencyKey, snapshot.currentHead, snapshot.timestamps?.createdAt ?? new Date(this.#clock.now()).toISOString(), encodeJson({ intakeIdempotencyKey: snapshot.identity.intakeIdempotencyKey }));
        }
      });
    } catch (error) { throw translateStoreError(error); }
  }

  async read(runId: string): Promise<RunSnapshot | undefined> {
    try { return this.database.transaction("BEGIN", () => { const snapshot = this.#load(runId); return snapshot ? COPY(snapshot) : undefined; }); }
    catch (error) { throw translateStoreError(error); }
  }

  async compareAndSet(runId: string, expected: RunPrecondition, mutate: (current: RunSnapshot) => RunSnapshot): Promise<RunSnapshot> {
    try {
      return this.database.transactionImmediate(() => this.#mutate(runId, expected, undefined, mutate));
    } catch (error) { throw translateStoreError(error); }
  }

  async compareAndSetFenced(runId: string, expected: RunPrecondition, lease: LeaseGuard, mutate: (current: RunSnapshot) => RunSnapshot): Promise<RunSnapshot> {
    try {
      return this.database.transactionImmediate(() => {
        this.#assertLease(runId, lease);
        return this.#mutate(runId, expected, lease, mutate);
      });
    } catch (error) { throw translateStoreError(error); }
  }

  async registerSession(runId: string, expected: RunPrecondition, registration: SessionRegistration): Promise<RunSnapshot> {
    return this.compareAndSet(runId, expected, current => this.#registrationMutation(current, registration));
  }
  async registerSessionFenced(runId: string, expected: RunPrecondition, lease: LeaseGuard, registration: SessionRegistration): Promise<RunSnapshot> {
    return this.compareAndSetFenced(runId, expected, lease, current => {
      const allocation = current.processAllocations?.[registration.role];
      if (!allocation || allocation.owner !== lease.owner || allocation.fencingToken !== lease.fencingToken || allocation.generation !== registration.processGeneration || allocation.sessionId || allocation.state !== "spawned" || allocation.processIdentity !== registration.processIdentity) throw new StoreConflictError("session registration lacks current first-session spawned allocation");
      const next = this.#registrationMutation(current, registration);
      const processAllocations = { ...next.processAllocations }; delete processAllocations[registration.role];
      return { ...next, version: next.version, processAllocations };
    });
  }
  async getSession(runId: string, role: Role): Promise<SessionRegistration | undefined> { return (await this.read(runId))?.sessions[role]; }

  async recordRuntime(runId: string, expected: RunPrecondition, resolution: RuntimeResolution): Promise<RunSnapshot> {
    return this.compareAndSet(runId, expected, current => this.#runtimeMutation(current, resolution));
  }
  async recordRuntimeFenced(runId: string, expected: RunPrecondition, lease: LeaseGuard, resolution: RuntimeResolution): Promise<RunSnapshot> {
    return this.compareAndSetFenced(runId, expected, lease, current => this.#runtimeMutation(current, resolution));
  }

  async retainProcessAllocation(runId: string, expected: RunPrecondition, retention: ProcessAllocationRetention): Promise<RunSnapshot> {
    try {
      return this.database.transactionImmediate(() => {
        const current = this.#loadRequired(runId); assertPrecondition(current, expected);
        const allocation = current.processAllocations?.[retention.role];
        const owned = allocation?.owner === retention.failedOwner && allocation.fencingToken === retention.failedFencingToken && allocation.generation === retention.generation;
        if (!owned) return COPY(current);
        if (allocation.state === "reserved" || allocation.state === "failed") throw new StoreConflictError("allocation has no retainable process intent");
        if (allocation.processIdentity && allocation.processIdentity !== retention.processIdentity) throw new StoreConflictError("process retention identity mismatch");
        if (allocation.state === "termination_failed" && allocation.processIdentity === retention.processIdentity) return COPY(current);
        return this.#mutate(runId, expected, undefined, snapshot => ({ ...snapshot, version: snapshot.version + 1, processAllocations: { ...snapshot.processAllocations, [retention.role]: { ...allocation, state: "termination_failed", processIdentity: retention.processIdentity } } }));
      });
    } catch (error) { throw translateStoreError(error); }
  }

  async recoverProcessAllocation(runId: string, expected: RunPrecondition, recovery: ProcessAllocationRecovery): Promise<RunSnapshot> {
    try {
      return this.database.transactionImmediate(() => {
        const current = this.#loadRequired(runId); assertPrecondition(current, expected);
        if (recovery.processIdentity && !recovery.processExited) throw new StoreConflictError("process cleanup requires observed exit");
        const allocation = current.processAllocations?.[recovery.role];
        const ownedByToken = allocation?.owner === recovery.failedOwner && allocation.fencingToken === recovery.failedFencingToken && (recovery.generation === undefined || allocation.generation === recovery.generation);
        if (ownedByToken && allocation.processIdentity && (!recovery.processExited || allocation.processIdentity !== recovery.processIdentity)) throw new StoreConflictError("process cleanup identity or exit observation mismatch");
        const sessions = { ...current.sessions }; const processAllocations = { ...current.processAllocations }; let changed = false;
        if (ownedByToken) {
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
        if (!changed) return COPY(current);
        return this.#mutate(runId, expected, undefined, snapshot => ({ ...snapshot, version: snapshot.version + 1, sessions, processAllocations }));
      });
    } catch (error) { throw translateStoreError(error); }
  }

  async acquireLease(runId: string, key: string, owner: string, now: number, ttlMs: number): Promise<Lease | undefined> {
    assertFiniteTimestamp(now, "lease now"); assertPositiveInteger(ttlMs, "lease TTL"); assertBoundedText(key, "lease key", 256); assertBoundedText(owner, "lease owner", 256);
    try {
      return this.database.transactionImmediate(() => {
        const current = this.#loadRequired(runId);
        if (current.terminalFence) return undefined;
        const row = this.database.prepare("SELECT owner, fencing_token, expires_at FROM leases WHERE run_id = ? AND lease_key = ?").get(runId, key) as { owner: string; fencing_token: number; expires_at: number } | undefined;
        if (row && row.expires_at > now) return row.owner === owner ? { key, owner: row.owner, fencingToken: row.fencing_token, expiresAt: row.expires_at } : undefined;
        const tokenRow = this.database.prepare("SELECT last_token FROM lease_token_counters WHERE run_id = ? AND lease_key = ?").get(runId, key) as { last_token: number } | undefined;
        const fencingToken = (tokenRow?.last_token ?? 0) + 1;
        if (!Number.isSafeInteger(fencingToken)) throw new StoreConflictError("lease fencing token exhausted");
        this.database.prepare("INSERT INTO lease_token_counters(run_id, lease_key, last_token, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(run_id, lease_key) DO UPDATE SET last_token = excluded.last_token, updated_at = excluded.updated_at").run(runId, key, fencingToken, now);
        this.database.prepare("INSERT INTO leases(run_id, lease_key, owner, fencing_token, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id, lease_key) DO UPDATE SET owner = excluded.owner, fencing_token = excluded.fencing_token, expires_at = excluded.expires_at").run(runId, key, owner, fencingToken, now + ttlMs);
        return { key, owner, fencingToken, expiresAt: now + ttlMs };
      });
    } catch (error) { throw translateStoreError(error); }
  }
  async renewLease(runId: string, key: string, owner: string, fencingToken: number, now: number, ttlMs: number): Promise<Lease | undefined> {
    assertFiniteTimestamp(now, "lease now"); assertPositiveInteger(ttlMs, "lease TTL");
    try {
      return this.database.transactionImmediate(() => {
        const current = this.#loadRequired(runId); if (current.terminalFence) return undefined;
        const row = this.database.prepare("SELECT owner, fencing_token, expires_at FROM leases WHERE run_id = ? AND lease_key = ?").get(runId, key) as { owner: string; fencing_token: number; expires_at: number } | undefined;
        if (!row || row.owner !== owner || row.fencing_token !== fencingToken || row.expires_at <= now) return undefined;
        const expiresAt = now + ttlMs;
        this.database.prepare("UPDATE leases SET expires_at = ? WHERE run_id = ? AND lease_key = ? AND owner = ? AND fencing_token = ? AND expires_at > ?").run(expiresAt, runId, key, owner, fencingToken, now);
        return { key, owner, fencingToken, expiresAt };
      });
    } catch (error) { throw translateStoreError(error); }
  }
  async releaseLease(runId: string, key: string, owner: string, fencingToken: number): Promise<void> {
    try {
      this.database.transactionImmediate(() => { this.database.prepare("DELETE FROM leases WHERE run_id = ? AND lease_key = ? AND owner = ? AND fencing_token = ?").run(runId, key, owner, fencingToken); });
    } catch (error) { throw translateStoreError(error); }
  }

  async assertRunStartAllowed(runId: string): Promise<void> {
    const current = await this.read(runId); if (!current) throw new StoreConflictError("run not found");
    if (current.terminalFence?.state === "removed") throw new StoreConflictError("run has been removed");
    if (current.terminalFence) throw new StoreConflictError("run has a permanent terminal fence");
    if (current.operatorBlocked) throw new StoreConflictError("run is operator blocked pending reconciliation");
  }
  async acquireRunPreparationLease(runId: string, owner: string, now = this.#clock.now()): Promise<RunPreparationLease> {
    assertBoundedText(owner, "preparation owner", 256); assertFiniteTimestamp(now, "preparation time");
    try { return this.database.transactionImmediate(() => {
      const current = this.#loadRequired(runId); if (current.terminalFence) throw new StoreConflictError("run has a permanent terminal fence");
      if ((current.preparationLeases ?? []).some(lease => lease.state === "held" && lease.owner === owner)) throw new StoreConflictError("preparation lease is already held by this owner");
      const lease: RunPreparationLease = { runId, owner, fencingToken: current.version + 1, acquiredAt: new Date(now).toISOString(), state: "held" };
      const next = this.#mutate(runId, { version: current.version }, undefined, snapshot => ({ ...snapshot, version: snapshot.version + 1, preparationLeases: [...(snapshot.preparationLeases ?? []), lease] }));
      return COPY(next.preparationLeases!.find(candidate => candidate.owner === owner && candidate.fencingToken === lease.fencingToken)!);
    }); } catch (error) { throw translateStoreError(error); }
  }
  async releaseRunPreparationLease(runId: string, lease: RunPreparationLease, _now = this.#clock.now()): Promise<void> {
    try { this.database.transactionImmediate(() => {
      const current = this.#loadRequired(runId); const existing = (current.preparationLeases ?? []).find(candidate => candidate.owner === lease.owner && candidate.fencingToken === lease.fencingToken);
      if (!existing) return;
      if (existing.runId !== runId || lease.runId !== runId || existing.state !== "held" || lease.state !== "held") throw new StoreConflictError("preparation lease identity changed");
      this.#mutate(runId, { version: current.version }, undefined, snapshot => ({ ...snapshot, version: snapshot.version + 1, preparationLeases: (snapshot.preparationLeases ?? []).filter(candidate => candidate.owner !== lease.owner || candidate.fencingToken !== lease.fencingToken) }));
    }); } catch (error) { throw translateStoreError(error); }
  }
  async acquireRunTerminalFence(runId: string, owner: string, now = this.#clock.now()): Promise<RunTerminalFence> {
    assertBoundedText(owner, "terminal fence owner", 256); assertFiniteTimestamp(now, "terminal fence time");
    try { return this.database.transactionImmediate(() => {
      const current = this.#loadRequired(runId);
      if (current.terminalFence?.state === "removed") throw new StoreConflictError("run has been removed");
      if (current.terminalFence) return COPY(current.terminalFence);
      this.#assertDurablyQuiescent(runId, current, now);
      const fence: RunTerminalFence = { runId, owner, fencingToken: current.version + 1, acquiredAt: new Date(now).toISOString(), state: "held" };
      const next = this.#mutate(runId, { version: current.version }, undefined, snapshot => ({ ...snapshot, version: snapshot.version + 1, terminalFence: fence }));
      return COPY(next.terminalFence!);
    }); } catch (error) { throw translateStoreError(error); }
  }
  async assertRunTeardownQuiescent(runId: string, fence: RunTerminalFence, now = this.#clock.now()): Promise<void> {
    try { this.database.transaction("BEGIN", () => { const current = this.#loadRequired(runId); this.#assertFence(current, fence); this.#assertDurablyQuiescent(runId, current, now); }); } catch (error) { throw translateStoreError(error); }
  }
  async completeRunTeardown(runId: string, fence: RunTerminalFence, now = this.#clock.now()): Promise<void> {
    try { this.database.transactionImmediate(() => {
      const current = this.#loadRequired(runId); this.#assertFence(current, fence);
      if (current.terminalFence!.state === "removed") return;
      this.#assertDurablyQuiescent(runId, current, now);
      this.#mutate(runId, { version: current.version }, undefined, snapshot => ({ ...snapshot, version: snapshot.version + 1, terminalFence: { ...snapshot.terminalFence!, state: "removed" } }), true);
    }); } catch (error) { throw translateStoreError(error); }
  }

  /** Internal projection used by intake/reconciliation without exposing SQL. */
  readInTransaction(runId: string): RunSnapshot | undefined { return this.#load(runId); }
  persistInTransaction(snapshot: RunSnapshot, previous?: RunSnapshot): void {
    if (previous) { if (previous.terminalFence) throw new StoreConflictError("ordinary persistence is forbidden after a permanent terminal fence"); assertRunSnapshotMutation(previous, snapshot); } else assertRunSnapshotShape(snapshot);
    if (previous) this.#updateSnapshot(snapshot, previous.version); else this.#insertSnapshot(snapshot);
    this.#syncChildren(snapshot);
    if (previous && previous.state !== snapshot.state) this.#appendStateEvent(previous, snapshot);
  }
  releaseTicketLockInTransaction(linearIssueId: string, runId: string): void {
    this.database.prepare("DELETE FROM ticket_run_locks WHERE linear_issue_id = ? AND run_id = ?").run(linearIssueId, runId);
  }

  #mutate(runId: string, expected: RunPrecondition, lease: LeaseGuard | undefined, mutate: (current: RunSnapshot) => RunSnapshot, allowTerminalFence = false): RunSnapshot {
    if (lease) this.#assertLease(runId, lease);
    const current = this.#loadRequired(runId);
    if (current.terminalFence && !allowTerminalFence) throw new StoreConflictError("run has a permanent terminal fence");
    assertPrecondition(current, expected);
    const next = mutate(COPY(current));
    assertRunSnapshotMutation(current, next);
    this.#updateSnapshot(next, current.version);
    this.#syncChildren(next);
    if (current.state !== next.state) this.#appendStateEvent(current, next);
    return COPY(next);
  }
  #registrationMutation(current: RunSnapshot, registration: SessionRegistration): RunSnapshot {
    if (registration.runId !== current.runId) throw new StoreConflictError("session belongs to another run");
    const existingRole = current.sessions[registration.role];
    const existingIdentity = Object.values(current.sessions).find(session => session?.sessionId === registration.sessionId || session?.sessionFile === registration.sessionFile);
    if (existingRole || existingIdentity) throw new StoreConflictError("role or session identity already registered");
    return { ...current, version: current.version + 1, sessions: { ...current.sessions, [registration.role]: COPY(registration) } };
  }
  #runtimeMutation(current: RunSnapshot, resolution: RuntimeResolution): RunSnapshot {
    if (current.runtimeResolution) throw new StoreConflictError("runtime already resolved for run");
    if (resolution.runId !== current.runId) throw new StoreConflictError("runtime resolution belongs to another run");
    return { ...current, version: current.version + 1, runtimeResolution: COPY(resolution) };
  }

  #loadRequired(runId: string): RunSnapshot { const snapshot = this.#load(runId); if (!snapshot) throw new StoreConflictError("run not found"); return snapshot; }
  #load(runId: string): RunSnapshot | undefined {
    try { return this.#loadUnchecked(runId); }
    catch (error) { if (error instanceof RowCorruptionError) this.database.markUnhealthy(); throw error; }
  }
  #loadUnchecked(runId: string): RunSnapshot | undefined {
    if (!runId || runId.length > 200) throw new StoreConflictError("invalid run ID lookup");
    const row = this.database.prepare("SELECT run_id, state, version, implement_generation, process_launches, current_head, remediation_review, remediation_test, remediation_total, created_at, updated_at, terminal_at, expires_at, success_retention_until, failure_retention_until, last_error_id, operator_blocked, reconciliation_generation, snapshot_json, linear_issue_id, linear_identifier, linear_team_id, linear_state_id, repository_owner, repository_name, base_branch, base_sha, object_format, normalized_ticket_path, normalized_ticket_sha256, normalized_ticket_schema_id, contract_feature_branch, physical_feature_branch, intake_idempotency_key FROM workflow_runs WHERE run_id = ?").get(runId) as WorkflowRow | undefined;
    if (!row) return undefined;
    let snapshot: RunSnapshot;
    try { snapshot = decodeSnapshot(row.snapshot_json); assertRunSnapshotShape(snapshot); } catch (error) { this.database.markUnhealthy(); throw error instanceof RowCorruptionError ? error : new RowCorruptionError(error instanceof Error ? error.message : "workflow snapshot shape is invalid"); }
    if (snapshot.runId !== row.run_id || snapshot.state !== row.state || snapshot.version !== row.version || snapshot.implementGeneration !== row.implement_generation || snapshot.processLaunches !== row.process_launches || snapshot.currentHead !== row.current_head || snapshot.remediation.review !== row.remediation_review || snapshot.remediation.test !== row.remediation_test || snapshot.remediation.total !== row.remediation_total || (snapshot.timestamps?.createdAt ?? null) !== row.created_at || (snapshot.timestamps?.updatedAt ?? null) !== row.updated_at || (snapshot.timestamps?.terminalAt ?? null) !== row.terminal_at || (snapshot.timestamps?.expiresAt ?? null) !== row.expires_at || (snapshot.timestamps?.successRetentionUntil ?? null) !== row.success_retention_until || (snapshot.timestamps?.failureRetentionUntil ?? null) !== row.failure_retention_until || (snapshot.lastError?.errorId ?? null) !== row.last_error_id || (snapshot.operatorBlocked ? 1 : 0) !== row.operator_blocked || (snapshot.reconciliation?.generation ?? null) !== row.reconciliation_generation) throw new RowCorruptionError("workflow relational projection disagrees with snapshot");
    if (encodeSnapshot(snapshot) !== row.snapshot_json) throw new RowCorruptionError("workflow snapshot is not canonical JSON");
    this.#assertIdentityProjection(snapshot, row);
    this.#assertChildProjection(snapshot);
    if (snapshot.identity && ACTIVE_STATES.has(snapshot.state)) {
      const lock = this.database.prepare("SELECT run_id FROM ticket_run_locks WHERE linear_issue_id = ?").get(snapshot.identity.linearIssueId) as { run_id: string } | undefined;
      if (!lock || lock.run_id !== runId) throw new RowCorruptionError("active intake run is missing its exact ticket lock");
    }
    return snapshot;
  }
  #assertIdentityProjection(snapshot: RunSnapshot, row: WorkflowRow): void {
    const identity = snapshot.identity;
    if (!identity) {
      const identityColumns = [row.linear_issue_id, row.linear_identifier, row.linear_team_id, row.linear_state_id, row.repository_owner, row.repository_name, row.base_branch, row.base_sha, row.object_format, row.normalized_ticket_path, row.normalized_ticket_sha256, row.normalized_ticket_schema_id, row.contract_feature_branch, row.physical_feature_branch, row.intake_idempotency_key];
      if (identityColumns.some(value => value !== null)) throw new RowCorruptionError("unexpected immutable identity projection on a legacy run");
      return;
    }
    const pairs: Array<[unknown, unknown]> = [[identity.linearIssueId, row.linear_issue_id], [identity.linearIdentifier, row.linear_identifier], [identity.linearTeamId, row.linear_team_id], [identity.linearStateId, row.linear_state_id], [identity.repositoryOwner, row.repository_owner], [identity.repositoryName, row.repository_name], [identity.baseBranch, row.base_branch], [identity.baseSha, row.base_sha], [identity.objectFormat, row.object_format], [identity.normalizedTicket.path, row.normalized_ticket_path], [identity.normalizedTicket.sha256, row.normalized_ticket_sha256], [identity.normalizedTicket.schemaId, row.normalized_ticket_schema_id], [identity.contractFeatureBranch, row.contract_feature_branch], [identity.physicalFeatureBranch, row.physical_feature_branch], [identity.intakeIdempotencyKey, row.intake_idempotency_key]];
    if (pairs.some(([left, right]) => left !== right)) throw new RowCorruptionError("immutable run identity projection disagrees with snapshot");
  }
  #assertChildProjection(snapshot: RunSnapshot): void {
    const eventRows = this.database.prepare("SELECT sequence, from_state, to_state, head FROM workflow_events WHERE run_id = ? ORDER BY sequence").all(snapshot.runId) as EventChildRow[];
    if (eventRows.length > 100_000 || eventRows.some(event => !Number.isSafeInteger(event.sequence) || event.sequence < 0 || event.sequence > snapshot.version || !ALL_STATES.has(event.to_state) || (event.from_state !== null && !ALL_STATES.has(event.from_state)) || (event.from_state !== null && !ACTIVE_STATES.has(event.from_state) && event.from_state !== event.to_state) || (event.head !== snapshot.currentHead && event.sequence === snapshot.version))) throw new RowCorruptionError("workflow event projection is malformed");
    if (eventRows.some((event, index) => index > 0 && event.sequence <= eventRows[index - 1]!.sequence)) throw new RowCorruptionError("workflow event sequence is not strictly increasing");
    const latestStateEvent = eventRows[eventRows.length - 1]; if (latestStateEvent && latestStateEvent.sequence === snapshot.version && latestStateEvent.to_state !== snapshot.state) throw new RowCorruptionError("latest workflow event does not match the snapshot state");
    const sessionRows = this.database.prepare("SELECT role, session_id, session_file, process_generation, process_state, process_identity, registered_at FROM sessions WHERE run_id = ?").all(snapshot.runId) as SessionChildRow[];
    if (sessionRows.length !== Object.values(snapshot.sessions).filter(Boolean).length) throw new RowCorruptionError("session child projection count mismatch");
    for (const row of sessionRows) {
      const session = snapshot.sessions[row.role as Role];
      if (!session || session.sessionId !== row.session_id || session.sessionFile !== row.session_file || session.processGeneration !== row.process_generation || (session.processState ?? null) !== row.process_state || (session.processIdentity ?? null) !== row.process_identity || session.registeredAt !== row.registered_at) throw new RowCorruptionError("session child projection mismatch");
    }
    const allocationRows = this.database.prepare("SELECT role, owner, fencing_token, generation, state, session_id, session_file, process_identity, allocated_at FROM process_allocations WHERE run_id = ?").all(snapshot.runId) as AllocationChildRow[];
    if (allocationRows.length !== Object.values(snapshot.processAllocations ?? {}).filter(Boolean).length) throw new RowCorruptionError("process allocation projection count mismatch");
    for (const row of allocationRows) {
      const allocation = snapshot.processAllocations?.[row.role as Role];
      if (!allocation || allocation.owner !== row.owner || allocation.fencingToken !== row.fencing_token || allocation.generation !== row.generation || allocation.state !== row.state || (allocation.sessionId ?? null) !== row.session_id || (allocation.sessionFile ?? null) !== row.session_file || (allocation.processIdentity ?? null) !== row.process_identity || allocation.allocatedAt !== row.allocated_at) throw new RowCorruptionError("process allocation child projection mismatch");
    }
    const attemptRows = this.database.prepare("SELECT phase, attempt, handoff_id, operation_key, target_session_id, input_head, input_json, feedback_json, accepted_result_json, accepted_status, accepted_output_head, accepted_at, completed_at, accepted_generation, dispatch_json FROM phase_attempts WHERE run_id = ?").all(snapshot.runId) as AttemptChildRow[];
    const attempts = snapshot.attempts;
    if (attemptRows.length !== attempts.length) throw new RowCorruptionError("phase attempt projection count mismatch");
    for (const row of attemptRows) {
      const attempt = attempts.find(candidate => candidate.phase === row.phase && candidate.attempt === row.attempt);
      if (!attempt || attempt.handoffId !== row.handoff_id || attempt.dispatch.operationKey !== row.operation_key || attempt.targetSessionId !== row.target_session_id || attempt.inputHead !== row.input_head || encodeJson(attempt.input) !== row.input_json || encodeJson(attempt.feedback) !== row.feedback_json || (attempt.accepted ? encodeJson(attempt.accepted.reference) : null) !== row.accepted_result_json || (attempt.accepted?.status ?? null) !== row.accepted_status || (attempt.accepted?.outputHead ?? null) !== row.accepted_output_head || (attempt.accepted?.acceptedAt ?? null) !== row.accepted_at || (attempt.accepted?.completedAt ?? null) !== row.completed_at || (attempt.accepted?.implementGeneration ?? null) !== row.accepted_generation || encodeJson(attempt.dispatch) !== row.dispatch_json) throw new RowCorruptionError("phase attempt child projection mismatch");
    }
    const gateRows = this.database.prepare("SELECT phase, head, result_json, accepted_at, completed_at, implement_generation, attempt FROM gates WHERE run_id = ?").all(snapshot.runId) as GateChildRow[];
    const gates = Object.values(snapshot.gates).filter(Boolean);
    if (gateRows.length !== gates.length) throw new RowCorruptionError("gate projection count mismatch");
    for (const row of gateRows) {
      const gate = snapshot.gates[row.phase as "review" | "test"];
      if (!gate || gate.head !== row.head || encodeJson(gate.result) !== row.result_json || gate.acceptedAt !== row.accepted_at || gate.completedAt !== row.completed_at || gate.implementGeneration !== row.implement_generation || gate.attempt !== row.attempt) throw new RowCorruptionError("gate child projection mismatch");
    }
    const prepRows = this.database.prepare("SELECT owner, fencing_token, acquired_at, state FROM preparation_leases WHERE run_id = ?").all(snapshot.runId) as PreparationChildRow[];
    if (prepRows.length !== (snapshot.preparationLeases ?? []).length) throw new RowCorruptionError("preparation lease projection count mismatch");
    for (const row of prepRows) if (!(snapshot.preparationLeases ?? []).some(lease => lease.owner === row.owner && lease.fencingToken === row.fencing_token && lease.acquiredAt === row.acquired_at && lease.state === row.state)) throw new RowCorruptionError("preparation lease child projection mismatch");
    const resourceRows = this.database.prepare("SELECT kind, scope, role_key, deterministic_key, deterministic_name, external_id, generation, state, metadata_json, observed_at FROM resource_bindings WHERE run_id = ? ORDER BY kind, scope, role_key").all(snapshot.runId) as ResourceProjectionRow[];
    const resources = [...(snapshot.resources ?? [])].sort((a, b) => `${a.kind}:${a.scope}:${a.role ?? ""}`.localeCompare(`${b.kind}:${b.scope}:${b.role ?? ""}`));
    if (resourceRows.length !== resources.length) throw new RowCorruptionError("resource binding projection count mismatch");
    for (const row of resourceRows) { const resource = resources.find(candidate => candidate.kind === row.kind && candidate.scope === row.scope && (candidate.role ?? "") === row.role_key); if (!resource || resource.deterministicKey !== row.deterministic_key || resource.deterministicName !== row.deterministic_name || (resource.externalId ?? null) !== row.external_id || resource.generation !== row.generation || resource.state !== row.state || encodeJson(resource.metadata ?? {}) !== row.metadata_json || resource.observedAt !== row.observed_at) throw new RowCorruptionError("resource binding projection mismatch"); }
    const delivery = this.database.prepare("SELECT repository_scope, feature_branch, bundle_path, bundle_digest, github_repository_id, github_node_id, pr_number, pr_node_id, pr_url, observed_head, approval_observation_id, checks_observation_id FROM delivery_bindings WHERE run_id = ?").get(snapshot.runId) as DeliveryChildRow | undefined;
    if (Boolean(delivery) !== Boolean(snapshot.delivery)) throw new RowCorruptionError("delivery projection mismatch");
    if (delivery && snapshot.delivery && (delivery.repository_scope !== (snapshot.delivery.repositoryOwner && snapshot.delivery.repositoryName ? `${snapshot.delivery.repositoryOwner}/${snapshot.delivery.repositoryName}` : null) || delivery.feature_branch !== (snapshot.delivery.featureBranch ?? null) || (delivery.bundle_path ?? undefined) !== snapshot.delivery.bundlePath || (delivery.bundle_digest ?? undefined) !== snapshot.delivery.bundleDigest || (delivery.github_repository_id ?? undefined) !== snapshot.delivery.githubRepositoryId || (delivery.github_node_id ?? undefined) !== snapshot.delivery.githubNodeId || (delivery.pr_number ?? undefined) !== snapshot.delivery.pullRequestNumber || (delivery.pr_node_id ?? undefined) !== snapshot.delivery.pullRequestNodeId || (delivery.pr_url ?? undefined) !== snapshot.delivery.pullRequestUrl || (delivery.observed_head ?? undefined) !== snapshot.delivery.observedHead || (delivery.approval_observation_id ?? undefined) !== snapshot.delivery.approvalObservationId || (delivery.checks_observation_id ?? undefined) !== snapshot.delivery.checksObservationId)) throw new RowCorruptionError("delivery child projection mismatch");
    const fence = this.database.prepare("SELECT owner, fencing_token, acquired_at, state FROM terminal_fences WHERE run_id = ?").get(snapshot.runId) as FenceChildRow | undefined;
    if (Boolean(fence) !== Boolean(snapshot.terminalFence)) throw new RowCorruptionError("terminal fence projection mismatch");
    if (fence && snapshot.terminalFence && (fence.owner !== snapshot.terminalFence.owner || fence.fencing_token !== snapshot.terminalFence.fencingToken || fence.acquired_at !== snapshot.terminalFence.acquiredAt || fence.state !== snapshot.terminalFence.state)) throw new RowCorruptionError("terminal fence identity mismatch");
  }

  #insertSnapshot(snapshot: RunSnapshot): void {
    const identity = snapshot.identity;
    this.database.prepare(`INSERT INTO workflow_runs(run_id, linear_issue_id, linear_identifier, linear_team_id, linear_state_id, repository_owner, repository_name, base_branch, base_sha, object_format, normalized_ticket_path, normalized_ticket_sha256, normalized_ticket_schema_id, contract_feature_branch, physical_feature_branch, intake_idempotency_key, state, version, implement_generation, process_launches, current_head, remediation_review, remediation_test, remediation_total, created_at, updated_at, terminal_at, expires_at, success_retention_until, failure_retention_until, last_error_id, operator_blocked, reconciliation_generation, snapshot_json) VALUES (@runId,@linearIssueId,@linearIdentifier,@linearTeamId,@linearStateId,@repositoryOwner,@repositoryName,@baseBranch,@baseSha,@objectFormat,@normalizedTicketPath,@normalizedTicketSha256,@normalizedTicketSchemaId,@contractFeatureBranch,@physicalFeatureBranch,@intakeIdempotencyKey,@state,@version,@implementGeneration,@processLaunches,@currentHead,@remediationReview,@remediationTest,@remediationTotal,@createdAt,@updatedAt,@terminalAt,@expiresAt,@successRetentionUntil,@failureRetentionUntil,@lastErrorId,@operatorBlocked,@reconciliationGeneration,@snapshotJson)`).run(this.projectionParams(snapshot, identity));
  }
  #updateSnapshot(snapshot: RunSnapshot, expectedVersion: number): void {
    const identity = snapshot.identity;
    const result = this.database.prepare(`UPDATE workflow_runs SET linear_issue_id=@linearIssueId, linear_identifier=@linearIdentifier, linear_team_id=@linearTeamId, linear_state_id=@linearStateId, repository_owner=@repositoryOwner, repository_name=@repositoryName, base_branch=@baseBranch, base_sha=@baseSha, object_format=@objectFormat, normalized_ticket_path=@normalizedTicketPath, normalized_ticket_sha256=@normalizedTicketSha256, normalized_ticket_schema_id=@normalizedTicketSchemaId, contract_feature_branch=@contractFeatureBranch, physical_feature_branch=@physicalFeatureBranch, intake_idempotency_key=@intakeIdempotencyKey, state=@state, version=@version, implement_generation=@implementGeneration, process_launches=@processLaunches, current_head=@currentHead, remediation_review=@remediationReview, remediation_test=@remediationTest, remediation_total=@remediationTotal, created_at=@createdAt, updated_at=@updatedAt, terminal_at=@terminalAt, expires_at=@expiresAt, success_retention_until=@successRetentionUntil, failure_retention_until=@failureRetentionUntil, last_error_id=@lastErrorId, operator_blocked=@operatorBlocked, reconciliation_generation=@reconciliationGeneration, snapshot_json=@snapshotJson WHERE run_id=@runId AND version=@expectedVersion`).run({ ...this.projectionParams(snapshot, identity), expectedVersion });
    if (result.changes !== 1) throw new StoreConflictError("stale run version");
  }
  projectionParams(snapshot: RunSnapshot, identity = snapshot.identity): Record<string, string | number | null> {
    const timestamps = snapshot.timestamps;
    return {
      runId: snapshot.runId, linearIssueId: identity?.linearIssueId ?? null, linearIdentifier: identity?.linearIdentifier ?? null, linearTeamId: identity?.linearTeamId ?? null, linearStateId: identity?.linearStateId ?? null, repositoryOwner: identity?.repositoryOwner ?? null, repositoryName: identity?.repositoryName ?? null, baseBranch: identity?.baseBranch ?? null, baseSha: identity?.baseSha ?? null, objectFormat: identity?.objectFormat ?? null, normalizedTicketPath: identity?.normalizedTicket.path ?? null, normalizedTicketSha256: identity?.normalizedTicket.sha256 ?? null, normalizedTicketSchemaId: identity?.normalizedTicket.schemaId ?? null, contractFeatureBranch: identity?.contractFeatureBranch ?? null, physicalFeatureBranch: identity?.physicalFeatureBranch ?? null, intakeIdempotencyKey: identity?.intakeIdempotencyKey ?? null, state: snapshot.state, version: snapshot.version, implementGeneration: snapshot.implementGeneration, processLaunches: snapshot.processLaunches, currentHead: snapshot.currentHead, remediationReview: snapshot.remediation.review, remediationTest: snapshot.remediation.test, remediationTotal: snapshot.remediation.total, createdAt: timestamps?.createdAt ?? null, updatedAt: timestamps?.updatedAt ?? null, terminalAt: timestamps?.terminalAt ?? null, expiresAt: timestamps?.expiresAt ?? null, successRetentionUntil: timestamps?.successRetentionUntil ?? null, failureRetentionUntil: timestamps?.failureRetentionUntil ?? null, lastErrorId: snapshot.lastError?.errorId ?? null, operatorBlocked: snapshot.operatorBlocked ? 1 : 0, reconciliationGeneration: snapshot.reconciliation?.generation ?? null, snapshotJson: encodeSnapshot(snapshot),
    };
  }

  #syncChildren(snapshot: RunSnapshot): void {
    const runId = snapshot.runId;
    this.database.prepare("DELETE FROM sessions WHERE run_id = ?").run(runId);
    for (const session of Object.values(snapshot.sessions).filter(Boolean)) {
      this.database.prepare("INSERT INTO sessions(run_id, role, session_id, session_file, process_generation, process_state, process_identity, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(runId, session!.role, session!.sessionId, session!.sessionFile, session!.processGeneration, session!.processState ?? null, session!.processIdentity ?? null, session!.registeredAt);
    }
    this.database.prepare("DELETE FROM process_allocations WHERE run_id = ?").run(runId);
    for (const allocation of Object.values(snapshot.processAllocations ?? {}).filter(Boolean)) this.database.prepare("INSERT INTO process_allocations(run_id, role, owner, fencing_token, generation, state, session_id, session_file, process_identity, allocated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(runId, allocation!.role, allocation!.owner, allocation!.fencingToken, allocation!.generation, allocation!.state, allocation!.sessionId ?? null, allocation!.sessionFile ?? null, allocation!.processIdentity ?? null, allocation!.allocatedAt);
    this.database.prepare("DELETE FROM preparation_leases WHERE run_id = ?").run(runId);
    for (const lease of snapshot.preparationLeases ?? []) this.database.prepare("INSERT INTO preparation_leases(run_id, owner, fencing_token, acquired_at, state) VALUES (?, ?, ?, ?, ?)").run(runId, lease.owner, lease.fencingToken, lease.acquiredAt, lease.state);
    this.database.prepare("DELETE FROM terminal_fences WHERE run_id = ?").run(runId);
    if (snapshot.terminalFence) this.database.prepare("INSERT INTO terminal_fences(run_id, owner, fencing_token, acquired_at, state) VALUES (?, ?, ?, ?, ?)").run(runId, snapshot.terminalFence.owner, snapshot.terminalFence.fencingToken, snapshot.terminalFence.acquiredAt, snapshot.terminalFence.state);
    this.database.prepare("DELETE FROM phase_attempts WHERE run_id = ?").run(runId);
    for (const attempt of snapshot.attempts) this.database.prepare("INSERT INTO phase_attempts(run_id, phase, attempt, handoff_id, operation_key, target_session_id, input_head, input_json, feedback_json, accepted_result_json, accepted_status, accepted_output_head, accepted_at, completed_at, accepted_generation, dispatch_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(runId, attempt.phase, attempt.attempt, attempt.handoffId, attempt.dispatch.operationKey, attempt.dispatch.targetSessionId, attempt.inputHead, encodeJson(attempt.input), encodeJson(attempt.feedback), attempt.accepted ? encodeJson(attempt.accepted.reference) : null, attempt.accepted?.status ?? null, attempt.accepted?.outputHead ?? null, attempt.accepted?.acceptedAt ?? null, attempt.accepted?.completedAt ?? null, attempt.accepted?.implementGeneration ?? null, encodeJson(attempt.dispatch));
    this.database.prepare("DELETE FROM gates WHERE run_id = ?").run(runId);
    for (const gate of Object.values(snapshot.gates).filter(Boolean)) this.database.prepare("INSERT INTO gates(run_id, phase, head, result_json, accepted_at, completed_at, implement_generation, attempt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(runId, gate!.phase, gate!.head, encodeJson(gate.result), gate!.acceptedAt, gate!.completedAt, gate!.implementGeneration, gate!.attempt);
    if (snapshot.delivery) {
      this.database.prepare("DELETE FROM delivery_bindings WHERE run_id = ?").run(runId);
      this.database.prepare("INSERT INTO delivery_bindings(run_id, repository_scope, feature_branch, bundle_path, bundle_digest, github_repository_id, github_node_id, pr_number, pr_node_id, pr_url, observed_head, approval_observation_id, checks_observation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(runId, snapshot.delivery.repositoryOwner && snapshot.delivery.repositoryName ? `${snapshot.delivery.repositoryOwner}/${snapshot.delivery.repositoryName}` : null, snapshot.delivery.featureBranch ?? null, snapshot.delivery.bundlePath ?? null, snapshot.delivery.bundleDigest ?? null, snapshot.delivery.githubRepositoryId ?? null, snapshot.delivery.githubNodeId ?? null, snapshot.delivery.pullRequestNumber ?? null, snapshot.delivery.pullRequestNodeId ?? null, snapshot.delivery.pullRequestUrl ?? null, snapshot.delivery.observedHead ?? null, snapshot.delivery.approvalObservationId ?? null, snapshot.delivery.checksObservationId ?? null);
    }
    if (snapshot.resources) {
      this.database.prepare("DELETE FROM resource_bindings WHERE run_id = ?").run(runId);
      for (const resource of snapshot.resources) this.database.prepare("INSERT INTO resource_bindings(run_id, kind, scope, role_key, deterministic_key, deterministic_name, external_id, generation, state, metadata_json, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(runId, resource.kind, resource.scope, resource.role ?? "", resource.deterministicKey, resource.deterministicName, resource.externalId ?? null, resource.generation, resource.state, encodeJson(resource.metadata ?? {}), resource.observedAt);
    }
  }
  #appendStateEvent(previous: RunSnapshot, next: RunSnapshot): void {
    const requestId = next.committedRequestIds.length > previous.committedRequestIds.length ? next.committedRequestIds[next.committedRequestIds.length - 1] : null;
    this.database.prepare("INSERT INTO workflow_events(run_id, sequence, from_state, to_state, trigger, request_id, head, occurred_at, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(next.runId, next.version, previous.state, next.state, transitionTrigger(previous.state, next.state), requestId, next.currentHead, next.timestamps?.updatedAt ?? new Date(this.#clock.now()).toISOString(), encodeJson({ requestId }));
  }
  #assertLease(runId: string, lease: LeaseGuard): void {
    if (!runId || lease.key.length > 256) throw new StoreConflictError("invalid lease guard");
    const row = this.database.prepare("SELECT owner, fencing_token, expires_at FROM leases WHERE run_id = ? AND lease_key = ?").get(runId, lease.key) as { owner: string; fencing_token: number; expires_at: number } | undefined;
    if (!row || row.owner !== lease.owner || row.fencing_token !== lease.fencingToken || row.expires_at <= lease.now) throw new StoreConflictError("stale or expired lease fencing token");
  }
  #assertFence(current: RunSnapshot, fence: RunTerminalFence): void {
    const persisted = current.terminalFence;
    if (fence.state !== "held" || !persisted || persisted.state !== "held" || persisted.runId !== fence.runId || persisted.owner !== fence.owner || persisted.fencingToken !== fence.fencingToken) throw new StoreConflictError("terminal fence ownership changed");
  }
  #assertDurablyQuiescent(runId: string, current: RunSnapshot, now: number): void {
    if (Object.values(current.processAllocations ?? {}).some(Boolean)) throw new StoreConflictError("workflow is not durably quiescent: process allocation remains");
    if (Object.values(current.sessions).some(session => session?.processState === "live" || session?.processState === "launching")) throw new StoreConflictError("workflow is not durably quiescent: role process remains");
    if (this.database.prepare("SELECT 1 FROM leases WHERE run_id = ? AND expires_at > ? LIMIT 1").get(runId, now)) throw new StoreConflictError("workflow is not durably quiescent: lease remains");
    if ((current.preparationLeases ?? []).some(lease => lease.state === "held")) throw new StoreConflictError("workflow is not durably quiescent: preparation lease remains");
  }
}

export const SQLiteWorkflowStore = SqliteWorkflowStore;
export const DurableWorkflowStore = SqliteWorkflowStore;
export const DurableSQLiteWorkflowStore = SqliteWorkflowStore;

interface SessionChildRow { role: string; session_id: string; session_file: string; process_generation: number; process_state: string | null; process_identity: string | null; registered_at: string; }
interface AllocationChildRow { role: string; owner: string; fencing_token: number; generation: number; state: string; session_id: string | null; session_file: string | null; process_identity: string | null; allocated_at: string; }
interface AttemptChildRow { phase: string; attempt: number; handoff_id: string; operation_key: string; target_session_id: string; input_head: string; input_json: string; feedback_json: string; accepted_result_json: string | null; accepted_status: string | null; accepted_output_head: string | null; accepted_at: string | null; completed_at: string | null; accepted_generation: number | null; dispatch_json: string; }
interface GateChildRow { phase: string; head: string; result_json: string; accepted_at: string; completed_at: string; implement_generation: number; attempt: number; }
interface PreparationChildRow { owner: string; fencing_token: number; acquired_at: string; state: string; }
interface FenceChildRow { owner: string; fencing_token: number; acquired_at: string; state: string; }
interface EventChildRow { sequence: number; from_state: string | null; to_state: string; head: string; }
interface DeliveryChildRow { repository_scope: string | null; bundle_path: string | null; feature_branch: string | null; bundle_digest: string | null; github_repository_id: string | null; github_node_id: string | null; pr_number: number | null; pr_node_id: string | null; pr_url: string | null; observed_head: string | null; approval_observation_id: string | null; checks_observation_id: string | null; }
interface ResourceProjectionRow { kind: string; scope: string; role_key: string; deterministic_key: string; deterministic_name: string; external_id: string | null; generation: number; state: string; metadata_json: string; observed_at: string; }
interface WorkflowRow {
  run_id: string; state: WorkflowState; version: number; implement_generation: number; process_launches: number; current_head: string; remediation_review: number; remediation_test: number; remediation_total: number; created_at: string | null; updated_at: string | null; terminal_at: string | null; expires_at: string | null; success_retention_until: string | null; failure_retention_until: string | null; last_error_id: string | null; operator_blocked: number; reconciliation_generation: number | null; snapshot_json: string;
  linear_issue_id: string | null; linear_identifier: string | null; linear_team_id: string | null; linear_state_id: string | null; repository_owner: string | null; repository_name: string | null; base_branch: string | null; base_sha: string | null; object_format: string | null; normalized_ticket_path: string | null; normalized_ticket_sha256: string | null; normalized_ticket_schema_id: string | null; contract_feature_branch: string | null; physical_feature_branch: string | null; intake_idempotency_key: string | null;
}
function transitionTrigger(from: WorkflowState, to: WorkflowState): string {
  if (to === "failed") return "system_failure";
  if (to === "cancelled") return "operator_cancel";
  if (to === "expired") return "retention_expired";
  if (from === "accepted" && to === "preparing") return "run_accepted";
  if (from === "preparing" && to === "planning") return "preparation_complete";
  if (from === "reviewing" && to === "implementing") return "remediation_required";
  if (from === "testing" && to === "implementing") return "remediation_required";
  if (from === "publishing" && to === "awaiting_approval") return "publication_complete";
  if (from === "awaiting_approval" && to === "approved") return "approval_observed";
  return "phase_pass";
}
function translateStoreError(error: unknown): Error {
  if (error instanceof StoreConflictError || error instanceof RowCorruptionError || error instanceof SqliteCorruptionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/SQLITE_CONSTRAINT|UNIQUE constraint|CHECK constraint|FOREIGN KEY constraint/iu.test(message)) return new StoreConflictError("durable workflow uniqueness or invariant conflict");
  return error instanceof Error ? error : new Error(message);
}
function assertBoundedText(value: string, label: string, max: number): void { if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f\r\n]/u.test(value)) throw new StoreConflictError(`${label} is invalid`); }
function assertFiniteTimestamp(value: number, label: string): void { if (!Number.isSafeInteger(value) || value < 0) throw new StoreConflictError(`${label} is invalid`); }
function assertPositiveInteger(value: number, label: string): void { if (!Number.isSafeInteger(value) || value <= 0) throw new StoreConflictError(`${label} is invalid`); }
