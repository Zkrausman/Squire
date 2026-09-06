import { createHash, randomUUID } from "node:crypto";
import { StoreConflictError } from "../control/workflow-store.js";
import { isTerminal, type DeliveryIdentifiers, type ExternalResourceBinding, type OperatorErrorRecord, type ReconciliationStatus, type RunSnapshot, type TerminalError, type TerminalState } from "../control/domain.js";
import { decodeJson, decodeSnapshot, encodeJson, encodeSnapshot, sha256Text } from "./row-codec.js";
import { SqliteDatabase } from "./sqlite-database.js";
import { SqliteWorkflowStore } from "./sqlite-workflow-store.js";
import { ActiveRunConflictError, IntakeArtifactConflictError, IntakeIdempotencyConflictError, type IntakeResult } from "../intake/domain.js";

export interface IntakeIntent { readonly runId: string; readonly linearIssueId: string; readonly idempotencyKey: string; readonly artifactPath: string; readonly artifact: { readonly path: string; readonly sha256: string; readonly schemaId: string }; readonly snapshot: RunSnapshot; readonly status: "intent" | "published" | "committed" | "quarantined"; }
export interface IntakeCommitInput { readonly snapshot: RunSnapshot; readonly artifact: { readonly path: string; readonly sha256: string; readonly schemaId: string }; readonly linearIssueId: string; readonly idempotencyKey: string; readonly occurredAt: string; }
export interface WebhookClaim { readonly provider: string; readonly deliveryId: string; readonly payloadSha256: string; readonly owner: string; readonly fencingToken: number; readonly duplicate: boolean; readonly status?: string; readonly runId?: string; }
export interface ControllerLease { readonly owner: string; readonly fencingToken: number; readonly expiresAt: number; readonly generation: number; }
export interface ReconciliationObservationRecord { readonly provider: string; readonly observationToken?: string; readonly digest?: string; readonly complete: boolean; readonly observedAt: string; readonly errorId?: string; readonly payload: unknown; }
export interface ResourceBindingInput extends Omit<ExternalResourceBinding, "role" | "metadata"> { readonly runId: string; readonly role?: string; readonly metadata?: Readonly<Record<string, unknown>>; }
export interface CleanupJournalEntry { readonly runId: string; readonly resourceKey: string; readonly operation: string; readonly state: "planned" | "running" | "completed" | "failed"; readonly generation: number; readonly owner: string; readonly fencingToken: number; readonly startedAt: string; readonly completedAt?: string; readonly errorMessage?: string; }

export interface SqliteIntakeStoreOptions { readonly database: SqliteDatabase | SqliteWorkflowStore | string; readonly workflow?: SqliteWorkflowStore; }

/** Transactional extensions used by intake, webhook, and reconciliation. */
export class SqliteIntakeStore {
  readonly database: SqliteDatabase;
  readonly workflow: SqliteWorkflowStore;
  readonly #ownsDatabase: boolean;
  constructor(database: SqliteDatabase | SqliteWorkflowStore | string | SqliteIntakeStoreOptions) {
    const options = !(database instanceof SqliteWorkflowStore) && typeof database === "object" && "database" in database ? database as SqliteIntakeStoreOptions : undefined;
    const configured: SqliteDatabase | SqliteWorkflowStore | string = options ? options.database : database as SqliteDatabase | SqliteWorkflowStore | string;
    this.#ownsDatabase = typeof configured === "string";
    if (options?.workflow) { this.workflow = options.workflow; this.database = options.workflow.database; }
    else if (configured instanceof SqliteWorkflowStore) { this.workflow = configured; this.database = configured.database; }
    else { this.database = typeof configured === "string" ? new SqliteDatabase(configured) : configured; this.workflow = new SqliteWorkflowStore(this.database); }
  }
  close(): void { if (this.#ownsDatabase) this.database.close(); }

  beginIntakeIntent(intent: IntakeIntent): IntakeIntent {
    assertIntakeIntent(intent);
    try { return this.database.transactionImmediate(() => {
      const activeLock = this.database.prepare("SELECT l.run_id, r.state FROM ticket_run_locks l JOIN workflow_runs r ON r.run_id = l.run_id WHERE l.linear_issue_id = ?").get(intent.linearIssueId) as { run_id: string; state: string } | undefined;
      if (activeLock && activeLock.run_id !== intent.runId) { if (isActiveState(activeLock.state)) throw new ActiveRunConflictError(intent.linearIssueId, activeLock.run_id); throw new IntakeIdempotencyConflictError("ticket lock points at a terminal run and has not been released"); }
      const pending = this.database.prepare("SELECT run_id FROM intake_artifact_intents WHERE linear_issue_id = ? AND status IN ('intent','published') AND run_id <> ? ORDER BY created_at LIMIT 1").get(intent.linearIssueId, intent.runId) as { run_id: string } | undefined;
      if (pending) throw new ActiveRunConflictError(intent.linearIssueId, pending.run_id);
      const existing = this.database.prepare("SELECT run_id, linear_issue_id, idempotency_key, artifact_path, artifact_sha256, artifact_schema_id, snapshot_json, created_at, status FROM intake_artifact_intents WHERE run_id = ?").get(intent.runId) as IntentRow | undefined;
      if (existing) {
        if (existing.linear_issue_id !== intent.linearIssueId || existing.idempotency_key !== intent.idempotencyKey || existing.artifact_path !== intent.artifact.path || existing.artifact_sha256 !== intent.artifact.sha256 || existing.artifact_schema_id !== intent.artifact.schemaId) throw new IntakeIdempotencyConflictError();
        if (existing.status === "quarantined") throw new IntakeArtifactConflictError("intake artifact intent is quarantined and requires operator repair");
        return rowToIntent(existing);
      }
      this.database.prepare("INSERT INTO intake_artifact_intents(run_id, linear_issue_id, idempotency_key, artifact_path, artifact_sha256, artifact_schema_id, snapshot_json, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'intent')").run(intent.runId, intent.linearIssueId, intent.idempotencyKey, intent.artifact.path, intent.artifact.sha256, intent.artifact.schemaId, encodeSnapshot(intent.snapshot), new Date().toISOString());
      return intent;
    }); } catch (error) { throw translateIntakeError(error); }
  }
  markArtifactPublished(runId: string, artifact: IntakeIntent["artifact"]): void {
    try { this.database.transactionImmediate(() => {
      const row = this.database.prepare("SELECT artifact_path, artifact_sha256, artifact_schema_id, status FROM intake_artifact_intents WHERE run_id = ?").get(runId) as Pick<IntentRow, "artifact_path" | "artifact_sha256" | "artifact_schema_id" | "status"> | undefined;
      if (!row) throw new IntakeIdempotencyConflictError("intake artifact intent is missing");
      if (row.artifact_path !== artifact.path || row.artifact_sha256 !== artifact.sha256 || row.artifact_schema_id !== artifact.schemaId) throw new IntakeArtifactConflictError();
      this.database.prepare("UPDATE intake_artifact_intents SET status = 'published' WHERE run_id = ? AND status IN ('intent','published')").run(runId);
    }); } catch (error) { throw translateIntakeError(error); }
  }
  commitIntake(input: IntakeCommitInput): IntakeResult {
    try { return this.database.transactionImmediate(() => {
      const current = this.workflow.readInTransaction(input.snapshot.runId);
      if (current) {
        if (!sameIntakeIdentity(current, input.snapshot, input.artifact)) throw new IntakeIdempotencyConflictError("existing run does not match the immutable intake artifact or identity");
        const ownIntent = this.database.prepare("SELECT status FROM intake_artifact_intents WHERE run_id = ?").get(input.snapshot.runId) as { status: IntakeIntent["status"] } | undefined;
        if (isTerminal(current.state)) {
          if (ownIntent?.status !== "committed") throw new IntakeIdempotencyConflictError("terminal run has no settled intake intent");
          return { runId: current.runId, snapshot: structuredClone(current), artifact: input.artifact, created: false };
        }
        this.#assertExactLock(input.linearIssueId, input.snapshot.runId);
        this.database.prepare("UPDATE intake_artifact_intents SET status = 'committed' WHERE run_id = ?").run(input.snapshot.runId);
        return { runId: current.runId, snapshot: structuredClone(current), artifact: input.artifact, created: false };
      }
      const pending = this.database.prepare("SELECT run_id FROM intake_artifact_intents WHERE linear_issue_id = ? AND status IN ('intent','published') AND run_id <> ? LIMIT 1").get(input.linearIssueId, input.snapshot.runId) as { run_id: string } | undefined;
      if (pending) throw new ActiveRunConflictError(input.linearIssueId, pending.run_id);
      const ownIntent = this.database.prepare("SELECT status FROM intake_artifact_intents WHERE run_id = ?").get(input.snapshot.runId) as { status: IntakeIntent["status"] } | undefined;
      if (ownIntent?.status === "committed" || ownIntent?.status === "quarantined") throw new IntakeArtifactConflictError("intake intent is settled without a matching workflow run");
      const lock = this.database.prepare("SELECT run_id FROM ticket_run_locks WHERE linear_issue_id = ?").get(input.linearIssueId) as { run_id: string } | undefined;
      if (lock) {
        const locked = this.workflow.readInTransaction(lock.run_id);
        if (locked && isActiveState(locked.state)) throw new ActiveRunConflictError(input.linearIssueId, lock.run_id);
        throw new IntakeIdempotencyConflictError("ticket lock points at an unexpected terminal or corrupt run");
      }
      this.workflow.persistInTransaction(input.snapshot);
      this.database.prepare("INSERT INTO ticket_run_locks(linear_issue_id, run_id, acquired_at) VALUES (?, ?, ?)").run(input.linearIssueId, input.snapshot.runId, input.occurredAt);
      this.database.prepare("INSERT INTO workflow_events(run_id, sequence, from_state, to_state, trigger, request_id, head, occurred_at, details_json) VALUES (?, 0, NULL, 'accepted', 'run_accepted', ?, ?, ?, ?)").run(input.snapshot.runId, input.idempotencyKey, input.snapshot.currentHead, input.occurredAt, encodeJson({ intakeIdempotencyKey: input.idempotencyKey, artifact: input.artifact }));
      this.database.prepare("UPDATE intake_artifact_intents SET status = 'committed' WHERE run_id = ?").run(input.snapshot.runId);
      return { runId: input.snapshot.runId, snapshot: structuredClone(input.snapshot), artifact: input.artifact, created: true };
    }); } catch (error) { throw translateIntakeError(error); }
  }
  terminalize(input: { readonly runId: string; readonly commandId: string; readonly toState: Extract<TerminalState, "failed" | "cancelled" | "expired">; readonly expectedHead: string; readonly terminalError: TerminalError; readonly now: string; readonly successRetentionUntil?: string; readonly failureRetentionUntil?: string }): RunSnapshot {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(input.commandId) || !["failed", "cancelled", "expired"].includes(input.toState) || typeof input.expectedHead !== "string" || input.expectedHead.length > 128 || !/^[0-9a-f]+$/u.test(input.expectedHead) || !validTimestamp(input.now) || input.successRetentionUntil !== undefined && !validTimestamp(input.successRetentionUntil) || input.failureRetentionUntil !== undefined && !validTimestamp(input.failureRetentionUntil)) throw new StoreConflictError("terminal command identity or deadline is invalid");
    if (!input.terminalError || typeof input.terminalError !== "object" || !/^[a-z][a-z0-9_.-]{1,63}$/u.test(input.terminalError.code) || !Array.isArray(input.terminalError.evidence)) throw new StoreConflictError("terminal error is invalid");
    const terminalError: TerminalError = { code: input.terminalError.code, message: sanitizeError(input.terminalError.message), at: validTimestamp(input.terminalError.at) ? input.terminalError.at : input.now, evidence: sanitizeEvidence(input.terminalError.evidence) };
    return this.database.transactionImmediate(() => {
      const current = this.workflow.readInTransaction(input.runId);
      if (!current) throw new StoreConflictError("run not found");
      if (isTerminal(current.state)) {
        if (current.committedRequestIds.includes(input.commandId)) return structuredClone(current);
        throw new StoreConflictError("terminal race already decided");
      }
      if (current.currentHead !== input.expectedHead) throw new StoreConflictError("stale Git head for terminal command");
      const timestamps = current.timestamps ? { ...current.timestamps, updatedAt: input.now, terminalAt: input.now, ...(input.successRetentionUntil ? { successRetentionUntil: input.successRetentionUntil } : {}), ...(input.failureRetentionUntil ? { failureRetentionUntil: input.failureRetentionUntil } : {}) } : { createdAt: input.now, updatedAt: input.now, terminalAt: input.now, ...(input.successRetentionUntil ? { successRetentionUntil: input.successRetentionUntil } : {}), ...(input.failureRetentionUntil ? { failureRetentionUntil: input.failureRetentionUntil } : {}) };
      const next: RunSnapshot = { ...current, version: current.version + 1, state: input.toState, committedRequestIds: [...current.committedRequestIds, input.commandId], terminalError, timestamps };
      this.workflow.persistInTransaction(next, current);
      if (current.identity) this.#assertExactLock(current.identity.linearIssueId, current.runId), this.database.prepare("DELETE FROM ticket_run_locks WHERE linear_issue_id = ? AND run_id = ?").run(current.identity.linearIssueId, current.runId);
      return structuredClone(next);
    });
  }
  markApproved(input: { readonly runId: string; readonly commandId: string; readonly expectedHead: string; readonly now: string; readonly successRetentionUntil: string }): RunSnapshot {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(input.commandId)) throw new StoreConflictError("approval observation command ID is invalid");
    return this.database.transactionImmediate(() => {
      const current = this.workflow.readInTransaction(input.runId); if (!current) throw new StoreConflictError("run not found");
      if (current.state === "approved" && current.committedRequestIds.includes(input.commandId)) return structuredClone(current);
      if (isTerminal(current.state)) throw new StoreConflictError("terminal run cannot observe approval");
      if (current.state !== "awaiting_approval" || current.currentHead !== input.expectedHead) throw new StoreConflictError("approval observation is stale or out of order");
      const timestamps = current.timestamps ? { ...current.timestamps, updatedAt: input.now, terminalAt: input.now, successRetentionUntil: input.successRetentionUntil } : { createdAt: input.now, updatedAt: input.now, terminalAt: input.now, successRetentionUntil: input.successRetentionUntil };
      const next = { ...current, version: current.version + 1, state: "approved" as const, committedRequestIds: [...current.committedRequestIds, input.commandId], timestamps };
      this.workflow.persistInTransaction(next, current);
      if (current.identity) { this.#assertExactLock(current.identity.linearIssueId, current.runId); this.database.prepare("DELETE FROM ticket_run_locks WHERE linear_issue_id = ? AND run_id = ?").run(current.identity.linearIssueId, current.runId); }
      return structuredClone(next);
    });
  }
  beginCleanup(runId: string, resourceKey: string, operation: string, owner: string, fencingToken: number, now: string): CleanupJournalEntry {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(resourceKey) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(operation) || !owner || owner.length > 256 || !Number.isSafeInteger(fencingToken) || fencingToken < 0) throw new StoreConflictError("cleanup journal identity is invalid");
    return this.database.transactionImmediate(() => {
      const fence = this.database.prepare("SELECT owner, fencing_token, state FROM terminal_fences WHERE run_id = ?").get(runId) as { owner: string; fencing_token: number; state: string } | undefined;
      if (!fence || fence.state !== "held" || fence.owner !== owner || fence.fencing_token !== fencingToken) throw new StoreConflictError("cleanup journal lacks the exact terminal fence");
      const existing = this.database.prepare("SELECT run_id, resource_key, operation, state, generation, owner, fencing_token, started_at, completed_at, error_message FROM cleanup_journal WHERE run_id = ? AND resource_key = ? AND operation = ?").get(runId, resourceKey, operation) as CleanupJournalRow | undefined;
      if (existing?.state === "completed") return cleanupRow(existing);
      if (existing?.state === "running" && (existing.owner !== owner || existing.fencing_token !== fencingToken)) throw new StoreConflictError("cleanup journal is owned by another fence");
      const generation = (existing?.generation ?? 0) + 1;
      this.database.prepare("INSERT INTO cleanup_journal(run_id, resource_key, operation, state, generation, owner, fencing_token, started_at) VALUES (?, ?, ?, 'running', ?, ?, ?, ?) ON CONFLICT(run_id, resource_key, operation) DO UPDATE SET state = 'running', generation = excluded.generation, owner = excluded.owner, fencing_token = excluded.fencing_token, started_at = excluded.started_at, completed_at = NULL, error_message = NULL").run(runId, resourceKey, operation, generation, owner, fencingToken, now);
      return { runId, resourceKey, operation, state: "running" as const, generation, owner, fencingToken, startedAt: now };
    });
  }
  finishCleanup(entry: CleanupJournalEntry, success: boolean, now: string, errorMessage?: string): CleanupJournalEntry {
    return this.database.transactionImmediate(() => {
      const fence = this.database.prepare("SELECT owner, fencing_token, state FROM terminal_fences WHERE run_id = ?").get(entry.runId) as { owner: string; fencing_token: number; state: string } | undefined;
      if (!fence || fence.state !== "held" || fence.owner !== entry.owner || fence.fencing_token !== entry.fencingToken) throw new StoreConflictError("cleanup journal fence was fenced");
      const result = this.database.prepare("UPDATE cleanup_journal SET state = ?, completed_at = ?, error_message = ? WHERE run_id = ? AND resource_key = ? AND operation = ? AND generation = ? AND owner = ? AND fencing_token = ? AND state = 'running'").run(success ? "completed" : "failed", now, success ? null : sanitizeError(errorMessage ?? "cleanup failed"), entry.runId, entry.resourceKey, entry.operation, entry.generation, entry.owner, entry.fencingToken);
      if (result.changes !== 1) { const current = this.database.prepare("SELECT run_id, resource_key, operation, state, generation, owner, fencing_token, started_at, completed_at, error_message FROM cleanup_journal WHERE run_id = ? AND resource_key = ? AND operation = ?").get(entry.runId, entry.resourceKey, entry.operation) as CleanupJournalRow | undefined; if (current?.state === "completed" && success) return cleanupRow(current); throw new StoreConflictError("cleanup journal ownership was fenced"); }
      const current = this.database.prepare("SELECT run_id, resource_key, operation, state, generation, owner, fencing_token, started_at, completed_at, error_message FROM cleanup_journal WHERE run_id = ? AND resource_key = ? AND operation = ?").get(entry.runId, entry.resourceKey, entry.operation) as CleanupJournalRow;
      return cleanupRow(current);
    });
  }
  listCleanupJournal(runId?: string): readonly CleanupJournalEntry[] { const rows = (runId === undefined ? this.database.prepare("SELECT run_id, resource_key, operation, state, generation, owner, fencing_token, started_at, completed_at, error_message FROM cleanup_journal ORDER BY started_at, resource_key, operation").all() : this.database.prepare("SELECT run_id, resource_key, operation, state, generation, owner, fencing_token, started_at, completed_at, error_message FROM cleanup_journal WHERE run_id = ? ORDER BY started_at, resource_key, operation").all(runId)) as CleanupJournalRow[]; return rows.map(cleanupRow); }
  resolveOperatorError(input: { readonly errorId: string; readonly runId?: string; readonly expectedVersion: number; readonly actionId: string; readonly resourceIdentity?: string; readonly now: string }): void;
  resolveOperatorError(errorId: string, actionId: string, now: string): void;
  resolveOperatorError(inputOrErrorId: { readonly errorId: string; readonly runId?: string; readonly expectedVersion: number; readonly actionId: string; readonly resourceIdentity?: string; readonly now: string } | string, actionId?: string, now?: string): void {
    const input = typeof inputOrErrorId === "string" ? { errorId: inputOrErrorId, actionId: actionId ?? "", expectedVersion: -1, now: now ?? "" } : inputOrErrorId;
    if (!/^err_[A-Za-z0-9-]{8,128}$/u.test(input.errorId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(input.actionId) || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0 || typeof input.now !== "string" || !Number.isFinite(Date.parse(input.now)) || (input.resourceIdentity !== undefined && (input.resourceIdentity.length < 1 || input.resourceIdentity.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(input.resourceIdentity)))) throw new StoreConflictError("operator resolution identity is invalid");
    if (typeof inputOrErrorId === "string") throw new StoreConflictError("operator resolution requires the expected run version");
    this.database.transactionImmediate(() => {
      const error = this.database.prepare("SELECT error_id, run_id, resolved_at FROM operator_errors WHERE error_id = ?").get(input.errorId) as { error_id: string; run_id: string | null; resolved_at: string | null } | undefined;
      if (!error || (input.runId ?? null) !== error.run_id) throw new StoreConflictError("operator error is missing or bound to another run");
      const current = input.runId ? this.workflow.readInTransaction(input.runId) : undefined;
      if (input.runId && (!current || current.version !== input.expectedVersion || current.lastError?.errorId !== input.errorId)) throw new StoreConflictError("operator resolution expected version or error projection is stale");
      if (input.resourceIdentity) {
        const resource = this.database.prepare("SELECT 1 FROM resource_bindings WHERE run_id = ? AND (external_id = ? OR deterministic_key = ? OR deterministic_name = ?) LIMIT 1").get(input.runId ?? null, input.resourceIdentity, input.resourceIdentity, input.resourceIdentity);
        if (!resource) throw new StoreConflictError("operator resource identity is not bound to the run");
      }
      const prior = this.database.prepare("SELECT action_id FROM operator_resolutions WHERE error_id = ?").get(input.errorId) as { action_id: string } | undefined;
      if (prior) { if (prior.action_id !== input.actionId) throw new StoreConflictError("operator error was resolved by another action"); return; }
      if (error.resolved_at) throw new StoreConflictError("operator error is already resolved");
      this.database.prepare("INSERT INTO operator_resolutions(error_id, action_id, run_id, expected_version, resource_identity, resolved_at) VALUES (?, ?, ?, ?, ?, ?)").run(input.errorId, input.actionId, input.runId ?? null, input.expectedVersion, input.resourceIdentity ?? null, input.now);
      this.database.prepare("UPDATE operator_errors SET resolved_at = ? WHERE error_id = ? AND resolved_at IS NULL").run(input.now, input.errorId);
    });
  }
  listOperatorErrors(runId?: string): readonly OperatorErrorRecord[] {
    const rows = (runId === undefined ? this.database.prepare("SELECT error_id, run_id, code, message, component, retryable, operator_action_required, evidence_json, fingerprint, first_occurred_at, last_occurred_at, occurrence_count, resolved_at FROM operator_errors ORDER BY first_occurred_at, error_id").all() : this.database.prepare("SELECT error_id, run_id, code, message, component, retryable, operator_action_required, evidence_json, fingerprint, first_occurred_at, last_occurred_at, occurrence_count, resolved_at FROM operator_errors WHERE run_id = ? ORDER BY first_occurred_at, error_id").all(runId)) as ErrorRow[];
    if (rows.length > 100_000) throw new StoreConflictError("operator error history exceeds its bound");
    return rows.map(rowToError).map(error => structuredClone(error));
  }
  getOperatorError(errorId: string): OperatorErrorRecord | undefined { const row = this.database.prepare("SELECT error_id, run_id, code, message, component, retryable, operator_action_required, evidence_json, fingerprint, first_occurred_at, last_occurred_at, occurrence_count, resolved_at FROM operator_errors WHERE error_id = ?").get(errorId) as ErrorRow | undefined; return row ? rowToError(row) : undefined; }
  getIntent(runId: string): IntakeIntent | undefined {
    const row = this.database.prepare("SELECT run_id, linear_issue_id, idempotency_key, artifact_path, artifact_sha256, artifact_schema_id, snapshot_json, created_at, status FROM intake_artifact_intents WHERE run_id = ?").get(runId) as IntentRow | undefined;
    return row ? rowToIntent(row) : undefined;
  }
  findPendingIntake(linearIssueId: string): IntakeIntent | undefined { const row = this.database.prepare("SELECT run_id, linear_issue_id, idempotency_key, artifact_path, artifact_sha256, artifact_schema_id, snapshot_json, created_at, status FROM intake_artifact_intents WHERE linear_issue_id = ? AND status IN ('intent','published') ORDER BY created_at LIMIT 1").get(linearIssueId) as IntentRow | undefined; return row ? rowToIntent(row) : undefined; }
  findActiveRun(linearIssueId: string): RunSnapshot | undefined {
    const row = this.database.prepare("SELECT run_id FROM ticket_run_locks WHERE linear_issue_id = ?").get(linearIssueId) as { run_id: string } | undefined;
    if (!row) return undefined;
    const run = this.workflow.readInTransaction(row.run_id);
    if (!run) throw new IntakeIdempotencyConflictError("ticket lock points at a missing run");
    if (!isActiveState(run.state)) throw new IntakeIdempotencyConflictError("terminal run retains an active ticket lock");
    return run;
  }
  releaseTicketLock(linearIssueId: string, runId: string): void {
    this.database.transactionImmediate(() => { const current = this.workflow.readInTransaction(runId); if (!current || !isTerminal(current.state)) throw new StoreConflictError("ticket lock may be released only for a terminal run"); this.#assertExactLock(linearIssueId, runId); this.database.prepare("DELETE FROM ticket_run_locks WHERE linear_issue_id = ? AND run_id = ?").run(linearIssueId, runId); });
  }
  #recordWebhookConflict(receipt: WebhookRow, occurredAt: string): string {
    const fingerprint = sha256Text(`webhook_delivery_reuse\\0${receipt.provider}\\0${receipt.delivery_id}`);
    const errorId = `err_${randomUUID()}`;
    const current = receipt.run_id ? this.workflow.readInTransaction(receipt.run_id) : undefined;
    if (receipt.run_id && !current) throw new StoreConflictError("webhook receipt points at a missing run");
    const errorRunId = current && !isTerminal(current.state) && !current.terminalFence ? receipt.run_id : null;
    this.database.prepare("INSERT INTO operator_errors(error_id, run_id, code, message, component, retryable, operator_action_required, evidence_json, fingerprint, first_occurred_at, last_occurred_at, occurrence_count) VALUES (?, ?, 'webhook_delivery_reuse', 'webhook delivery identity was reused with different bytes', 'linear-webhook', 0, 1, ?, ?, ?, ?, 1)").run(errorId, errorRunId, encodeJson([]), fingerprint, occurredAt, occurredAt);
    if (current && errorRunId) {
      const updated = { ...current, version: current.version + 1, operatorBlocked: true, lastError: { errorId, code: "webhook_delivery_reuse", message: "webhook delivery identity was reused with different bytes", component: "linear-webhook", retryable: false, operatorActionRequired: true, occurrenceCount: 1, lastOccurredAt: occurredAt }, ...(current.timestamps ? { timestamps: { ...current.timestamps, updatedAt: occurredAt } } : {}) };
      this.workflow.persistInTransaction(updated, current);
    }
    return errorId;
  }
  #assertExactLock(linearIssueId: string, runId: string): void {
    const lock = this.database.prepare("SELECT run_id FROM ticket_run_locks WHERE linear_issue_id = ?").get(linearIssueId) as { run_id: string } | undefined;
    if (!lock || lock.run_id !== runId) throw new IntakeIdempotencyConflictError("active ticket lock is missing or points at another run");
  }

  bindResource(binding: ResourceBindingInput): ExternalResourceBinding {
    assertResourceBindingInput(binding);
    try { return this.database.transactionImmediate(() => {
      const current = this.workflow.readInTransaction(binding.runId);
      if (!current) throw new StoreConflictError("run not found");
      if (current.terminalFence) throw new StoreConflictError("run has a permanent terminal fence");
      const roleKey = binding.role ?? "";
      const existing = this.database.prepare("SELECT run_id, kind, scope, role_key, deterministic_key, deterministic_name, external_id, generation, state, metadata_json, observed_at FROM resource_bindings WHERE run_id = ? AND kind = ? AND role_key = ?").get(binding.runId, binding.kind, roleKey) as ResourceRow | undefined;
      if (existing) {
        if (existing.scope !== binding.scope || existing.deterministic_key !== binding.deterministicKey || existing.deterministic_name !== binding.deterministicName || (existing.external_id !== null && binding.externalId !== undefined && existing.external_id !== binding.externalId)) throw new StoreConflictError("resource binding identity changed");
        if (binding.generation < existing.generation) throw new StoreConflictError("resource binding generation decreased");
        if (!isResourceStateTransition(existing.state, binding.state)) throw new StoreConflictError("resource binding lifecycle regressed");
        if (binding.metadata !== undefined && encodeJson(decodeJson(existing.metadata_json, "resource metadata")) !== encodeJson(binding.metadata)) throw new StoreConflictError("resource immutable metadata changed");
      }
      const existingMetadata = existing ? decodeJson<Readonly<Record<string, unknown>>>(existing.metadata_json, "resource metadata") : {};
      const result = toResourceBinding({ ...binding, ...(existing?.external_id && binding.externalId === undefined ? { externalId: existing.external_id } : {}), ...(binding.metadata === undefined && Object.keys(existingMetadata).length ? { metadata: existingMetadata } : {}) });
      const rows = this.database.prepare("SELECT run_id, kind, scope, role_key, deterministic_key, deterministic_name, external_id, generation, state, metadata_json, observed_at FROM resource_bindings WHERE run_id = ?").all(binding.runId) as ResourceRow[];
      const resources = rows.filter(row => !(row.kind === binding.kind && row.role_key === roleKey)).map(rowToResource);
      const next: RunSnapshot = { ...current, version: current.version + 1, resources: [...resources, result].sort((a, b) => `${a.kind}:${a.role ?? ""}` < `${b.kind}:${b.role ?? ""}` ? -1 : 1) };
      this.workflow.persistInTransaction(next, current);
      return structuredClone(result);
    }); } catch (error) { throw translateIntakeError(error); }
  }
  bindDelivery(runId: string, delivery: DeliveryIdentifiers): DeliveryIdentifiers {
    return this.database.transactionImmediate(() => {
      const current = this.workflow.readInTransaction(runId); if (!current) throw new StoreConflictError("run not found");
      if (current.delivery) { if (encodeJson(current.delivery) !== encodeJson(delivery)) throw new StoreConflictError("delivery identity changed"); return structuredClone(current.delivery); }
      if (current.terminalFence) throw new StoreConflictError("run has a permanent terminal fence");
      const next = { ...current, version: current.version + 1, delivery: structuredClone(delivery) };
      this.workflow.persistInTransaction(next, current);
      return structuredClone(delivery);
    });
  }
  listResources(runId?: string): ExternalResourceBinding[] {
    const rows = (runId ? this.database.prepare("SELECT run_id, kind, scope, role_key, deterministic_key, deterministic_name, external_id, generation, state, metadata_json, observed_at FROM resource_bindings WHERE run_id = ?").all(runId) : this.database.prepare("SELECT run_id, kind, scope, role_key, deterministic_key, deterministic_name, external_id, generation, state, metadata_json, observed_at FROM resource_bindings").all()) as ResourceRow[];
    return rows.map(rowToResource);
  }

  claimWebhook(provider: string, deliveryId: string, payloadSha256: string, eventType: string, linearIssueId: string | undefined, owner: string, now: number, leaseMs: number): WebhookClaim {
    for (const [label, value, max] of [["webhook provider", provider, 64], ["webhook delivery ID", deliveryId, 256], ["webhook event type", eventType, 128], ["webhook owner", owner, 256]] as const) if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f\u007f\r\n]/u.test(value)) throw new StoreConflictError(`${label} is invalid`);
    if (!/^[0-9a-f]{64}$/u.test(payloadSha256) || (linearIssueId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(linearIssueId)) || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new StoreConflictError("webhook receipt identity or timing is invalid");
    try { return this.database.transactionImmediate(() => {
      const existing = this.database.prepare("SELECT provider, delivery_id, payload_sha256, event_type, linear_issue_id, received_at, status, owner, fencing_token, attempts, run_id, last_error_id FROM webhook_receipts WHERE provider = ? AND delivery_id = ?").get(provider, deliveryId) as WebhookRow | undefined;
      if (existing) {
        if (existing.payload_sha256 !== payloadSha256) {
          const errorId = this.#recordWebhookConflict(existing, new Date(now).toISOString());
          this.database.prepare("UPDATE webhook_receipts SET status = 'blocked', last_error_id = ? WHERE provider = ? AND delivery_id = ?").run(errorId, provider, deliveryId);
          throw new WebhookConflictError("delivery ID was reused with different exact bytes");
        }
        if (["applied", "ignored", "failed", "blocked"].includes(existing.status)) return { provider, deliveryId, payloadSha256, owner: existing.owner ?? owner, fencingToken: existing.fencing_token, duplicate: true, status: existing.status, ...(existing.run_id ? { runId: existing.run_id } : {}) };
        if (existing.status === "processing" && Number(existing.received_at) + leaseMs > now && existing.owner !== owner) return { provider, deliveryId, payloadSha256, owner: existing.owner ?? owner, fencingToken: existing.fencing_token, duplicate: true, status: existing.status, ...(existing.run_id ? { runId: existing.run_id } : {}) };
        const token = existing.fencing_token + 1;
        this.database.prepare("UPDATE webhook_receipts SET status = 'processing', owner = ?, fencing_token = ?, attempts = attempts + 1 WHERE provider = ? AND delivery_id = ?").run(owner, token, provider, deliveryId);
        return { provider, deliveryId, payloadSha256, owner, fencingToken: token, duplicate: false, status: "processing", ...(existing.run_id ? { runId: existing.run_id } : {}) };
      }
      this.database.prepare("INSERT INTO webhook_receipts(provider, delivery_id, payload_sha256, event_type, linear_issue_id, received_at, status, owner, fencing_token, attempts) VALUES (?, ?, ?, ?, ?, ?, 'processing', ?, 1, 1)").run(provider, deliveryId, payloadSha256, eventType, linearIssueId ?? null, String(now), owner);
      return { provider, deliveryId, payloadSha256, owner, fencingToken: 1, duplicate: false, status: "processing" };
    }); } catch (error) { throw translateIntakeError(error); }
  }
  finishWebhook(claim: WebhookClaim, status: "applied" | "ignored" | "failed" | "blocked", runId?: string, errorId?: string): void {
    this.database.transactionImmediate(() => {
      const result = this.database.prepare("UPDATE webhook_receipts SET status = ?, run_id = ?, last_error_id = ? WHERE provider = ? AND delivery_id = ? AND owner = ? AND fencing_token = ?").run(status, runId ?? null, errorId ?? null, claim.provider, claim.deliveryId, claim.owner, claim.fencingToken);
      if (result.changes !== 1) throw new StoreConflictError("webhook receipt ownership was fenced");
    });
  }

  recordOperatorError(input: Omit<OperatorErrorRecord, "errorId" | "fingerprint" | "firstOccurredAt" | "lastOccurredAt" | "occurrenceCount"> & { readonly runId?: string; readonly now: string }): OperatorErrorRecord {
    if (!/^[a-z][a-z0-9_.-]{1,63}$/u.test(input.code) || !/^[a-z][a-z0-9_.-]{1,63}$/u.test(input.component) || typeof input.now !== "string" || !Number.isFinite(Date.parse(input.now))) throw new StoreConflictError("operator error identity or timestamp is invalid");
    const evidence = sanitizeEvidence(input.evidence);
    const message = sanitizeError(input.message);
    const fingerprint = sha256Text(`${input.code}\0${input.component}\0${message}`);
    try { return this.database.transactionImmediate(() => {
      const existing = this.database.prepare("SELECT error_id, run_id, code, message, component, retryable, operator_action_required, evidence_json, fingerprint, first_occurred_at, last_occurred_at, occurrence_count, resolved_at FROM operator_errors WHERE run_id IS ? AND fingerprint = ? AND resolved_at IS NULL").get(input.runId ?? null, fingerprint) as ErrorRow | undefined;
      if (existing) {
        const count = existing.occurrence_count + 1;
        this.database.prepare("UPDATE operator_errors SET last_occurred_at = ?, occurrence_count = ? WHERE error_id = ?").run(input.now, count, existing.error_id);
        if (input.runId) {
          const current = this.workflow.readInTransaction(input.runId);
          if (current && !current.terminalFence) {
            const updated = { ...current, version: current.version + 1, lastError: { ...current.lastError, errorId: existing.error_id, code: existing.code, message: existing.message, component: existing.component, retryable: existing.retryable === 1, operatorActionRequired: existing.operator_action_required === 1, occurrenceCount: count, lastOccurredAt: input.now }, operatorBlocked: current.operatorBlocked || input.operatorActionRequired, ...(current.timestamps ? { timestamps: { ...current.timestamps, updatedAt: input.now } } : {}) };
            this.workflow.persistInTransaction(updated, current);
          }
        }
        return { ...rowToError(existing), lastOccurredAt: input.now, occurrenceCount: count };
      }
      const errorId = `err_${randomUUID()}`;
      this.database.prepare("INSERT INTO operator_errors(error_id, run_id, code, message, component, retryable, operator_action_required, evidence_json, fingerprint, first_occurred_at, last_occurred_at, occurrence_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)").run(errorId, input.runId ?? null, input.code, message, input.component, input.retryable ? 1 : 0, input.operatorActionRequired ? 1 : 0, encodeJson(evidence), fingerprint, input.now, input.now);
      if (input.runId) {
        const current = this.workflow.readInTransaction(input.runId);
        if (current && !current.terminalFence) {
          const projection = { errorId, code: input.code, message, component: input.component, retryable: input.retryable, operatorActionRequired: input.operatorActionRequired, occurrenceCount: 1, lastOccurredAt: input.now } as const;
          const updated = { ...current, version: current.version + 1, lastError: projection, operatorBlocked: current.operatorBlocked || input.operatorActionRequired, ...(current.timestamps ? { timestamps: { ...current.timestamps, updatedAt: input.now } } : {}) };
          this.workflow.persistInTransaction(updated, current);
        }
      }
      return { errorId, ...(input.runId ? { runId: input.runId } : {}), code: input.code, message, component: input.component, retryable: input.retryable, operatorActionRequired: input.operatorActionRequired, evidence, fingerprint, firstOccurredAt: input.now, lastOccurredAt: input.now, occurrenceCount: 1 };
    }); } catch (error) { throw translateIntakeError(error); }
  }

  acquireControllerLease(owner: string, now: number, ttlMs: number): ControllerLease | undefined {
    assertControllerTiming(owner, now, ttlMs);
    return this.database.transactionImmediate(() => {
      const current = this.database.prepare("SELECT owner, fencing_token, expires_at, generation FROM controller_leases WHERE singleton = 1").get() as ControllerLeaseRow | undefined;
      if (current && current.expires_at > now && current.owner !== owner) return undefined;
      const token = (current?.fencing_token ?? 0) + 1;
      const generation = (current?.generation ?? 0) + 1;
      this.database.prepare("INSERT INTO controller_leases(singleton, owner, fencing_token, expires_at, generation) VALUES (1, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET owner = excluded.owner, fencing_token = excluded.fencing_token, expires_at = excluded.expires_at, generation = excluded.generation").run(owner, token, now + ttlMs, generation);
      return { owner, fencingToken: token, expiresAt: now + ttlMs, generation };
    });
  }
  controllerLeaseIsCurrent(owner: string, fencingToken: number, generation: number, now = Date.now()): boolean { if (!Number.isSafeInteger(now) || now < 0) return false;
    const current = this.database.prepare("SELECT owner, fencing_token, expires_at, generation FROM controller_leases WHERE singleton = 1").get() as ControllerLeaseRow | undefined;
    return Boolean(current && current.owner === owner && current.fencing_token === fencingToken && current.generation === generation && current.expires_at > now);
  }
  renewControllerLease(lease: ControllerLease, now: number, ttlMs: number): ControllerLease | undefined {
    assertControllerTiming(lease.owner, now, ttlMs);
    return this.database.transactionImmediate(() => {
      const current = this.database.prepare("SELECT owner, fencing_token, expires_at, generation FROM controller_leases WHERE singleton = 1").get() as ControllerLeaseRow | undefined;
      if (!current || current.owner !== lease.owner || current.fencing_token !== lease.fencingToken || current.expires_at <= now) return undefined;
      this.database.prepare("UPDATE controller_leases SET expires_at = ? WHERE singleton = 1 AND owner = ? AND fencing_token = ?").run(now + ttlMs, lease.owner, lease.fencingToken);
      return { ...lease, expiresAt: now + ttlMs, generation: current.generation };
    });
  }
  beginReconciliation(lease: ControllerLease, startedAt: string): ReconciliationStatus {
    if (!validTimestamp(startedAt)) throw new StoreConflictError("reconciliation start timestamp is invalid");
    return this.database.transactionImmediate(() => { this.assertControllerLease(lease, Date.parse(startedAt));
      const status: ReconciliationStatus = { generation: lease.generation, status: "observing", controllerOwner: lease.owner, fencingToken: lease.fencingToken, startedAt };
      this.database.prepare("INSERT OR REPLACE INTO reconciliation_cycles(generation, controller_owner, fencing_token, status, started_at) VALUES (?, ?, ?, 'observing', ?)").run(status.generation, status.controllerOwner, status.fencingToken, status.startedAt);
      return status;
    });
  }
  recordReconciliationObservation(lease: ControllerLease, observation: ReconciliationObservationRecord, now = Date.now()): void {
    this.database.transactionImmediate(() => {
      this.assertControllerLease(lease, now);
      this.database.prepare("INSERT OR REPLACE INTO reconciliation_observations(generation, provider, observation_token, digest, complete, observed_at, error_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(lease.generation, observation.provider, observation.observationToken ?? null, observation.digest ?? null, observation.complete ? 1 : 0, observation.observedAt, observation.errorId ?? null, encodeJson(observation.payload));
    });
  }
  finishReconciliation(lease: ControllerLease, status: "ready" | "blocked", completedAt: string, blockingErrorId?: string, now = Date.now()): ReconciliationStatus {
    if (!validTimestamp(completedAt)) throw new StoreConflictError("reconciliation completion timestamp is invalid");
    return this.database.transactionImmediate(() => {
      this.assertControllerLease(lease, now);
      const current = this.database.prepare("SELECT started_at FROM reconciliation_cycles WHERE generation = ?").get(lease.generation) as { started_at: string } | undefined;
      if (!current) throw new StoreConflictError("reconciliation cycle is missing");
      this.database.prepare("UPDATE reconciliation_cycles SET status = ?, completed_at = ?, blocking_error_id = ? WHERE generation = ? AND controller_owner = ? AND fencing_token = ?").run(status, completedAt, blockingErrorId ?? null, lease.generation, lease.owner, lease.fencingToken);
      return { generation: lease.generation, status, controllerOwner: lease.owner, fencingToken: lease.fencingToken, startedAt: current.started_at, completedAt, ...(blockingErrorId ? { blockingErrorId } : {}) };
    });
  }
  assertControllerLease(lease: ControllerLease, now = Date.now()): void {
    if (!Number.isSafeInteger(now) || now < 0) throw new StoreConflictError("controller lease time is invalid");
    const current = this.database.prepare("SELECT owner, fencing_token, expires_at FROM controller_leases WHERE singleton = 1").get() as { owner: string; fencing_token: number; expires_at: number } | undefined;
    if (!current || current.owner !== lease.owner || current.fencing_token !== lease.fencingToken || current.expires_at <= now) throw new StoreConflictError("controller lease was fenced or expired");
  }
  validateLedgerConsistency(): string | undefined {
    const locks = this.database.prepare("SELECT l.linear_issue_id, l.run_id, r.linear_issue_id AS run_linear_issue_id, r.state FROM ticket_run_locks l LEFT JOIN workflow_runs r ON r.run_id = l.run_id").all() as Array<{ linear_issue_id: string; run_id: string; run_linear_issue_id: string | null; state: string | null }>;
    if (locks.some(lock => !lock.run_linear_issue_id || lock.run_linear_issue_id !== lock.linear_issue_id || !lock.state || !isActiveState(lock.state))) return "ticket lock points to a missing, mismatched, or terminal run";
    const unsettled = this.database.prepare("SELECT run_id FROM intake_artifact_intents WHERE status <> 'committed'").all() as Array<{ run_id: string }>;
    if (unsettled.length > 0) return "an intake artifact publication intent is not durably settled";
    return undefined;
  }
  listNonterminalRuns(): RunSnapshot[] {
    const rows = this.database.prepare("SELECT run_id FROM workflow_runs WHERE state NOT IN ('approved','failed','cancelled','expired')").all() as Array<{ run_id: string }>;
    return rows.map(row => this.workflow.readInTransaction(row.run_id)).filter((run): run is RunSnapshot => Boolean(run));
  }
  listRunsForReconciliation(): RunSnapshot[] {
    const rows = this.database.prepare("SELECT DISTINCT r.run_id FROM workflow_runs r LEFT JOIN resource_bindings b ON b.run_id = r.run_id LEFT JOIN operator_errors e ON e.run_id = r.run_id AND e.resolved_at IS NULL LEFT JOIN terminal_fences f ON f.run_id = r.run_id AND f.state = 'held' LEFT JOIN cleanup_journal j ON j.run_id = r.run_id AND j.state <> 'completed' WHERE r.state NOT IN ('approved','failed','cancelled','expired') OR b.run_id IS NOT NULL OR e.run_id IS NOT NULL OR f.run_id IS NOT NULL OR j.run_id IS NOT NULL").all() as Array<{ run_id: string }>;
    return rows.map(row => this.workflow.readInTransaction(row.run_id)).filter((run): run is RunSnapshot => Boolean(run));
  }
  hasUnresolvedGlobalOperatorErrors(): boolean { return Boolean(this.database.prepare("SELECT 1 FROM operator_errors WHERE run_id IS NULL AND resolved_at IS NULL LIMIT 1").get()); }
  hasUnresolvedGlobalSecurityErrors(): boolean { return Boolean(this.database.prepare("SELECT 1 FROM operator_errors WHERE run_id IS NULL AND resolved_at IS NULL AND code <> 'reconciliation_blocked' LIMIT 1").get()); }
  resolveReconciliationBlockErrors(now: string): void { this.database.transactionImmediate(() => { this.database.prepare("UPDATE operator_errors SET resolved_at = ? WHERE run_id IS NULL AND code = 'reconciliation_blocked' AND resolved_at IS NULL").run(now); }); }
  hasUnresolvedOperatorErrors(runId: string): boolean { return Boolean(this.database.prepare("SELECT 1 FROM operator_errors WHERE run_id = ? AND resolved_at IS NULL LIMIT 1").get(runId)); }
  clearOperatorBlockAfterReconciliation(runId: string, updatedAt = new Date().toISOString()): RunSnapshot | undefined {
    if (this.hasUnresolvedOperatorErrors(runId)) return this.workflow.readInTransaction(runId);
    return this.database.transactionImmediate(() => {
      const current = this.workflow.readInTransaction(runId); if (!current || !current.operatorBlocked || current.terminalFence) return current;
      const next = { ...current, version: current.version + 1, operatorBlocked: false, ...(current.timestamps ? { timestamps: { ...current.timestamps, updatedAt } } : {}) };
      this.workflow.persistInTransaction(next, current); return next;
    });
  }
}

export const SQLiteIntakeStore = SqliteIntakeStore;

interface IntentRow { run_id: string; linear_issue_id: string; idempotency_key: string; artifact_path: string; artifact_sha256: string; artifact_schema_id: string; snapshot_json: string; created_at: string; status: IntakeIntent["status"]; }
interface ResourceRow { run_id: string; kind: ExternalResourceBinding["kind"]; scope: string; role_key: string; deterministic_key: string; deterministic_name: string; external_id: string | null; generation: number; state: ExternalResourceBinding["state"]; metadata_json: string; observed_at: string; }
interface WebhookRow { provider: string; delivery_id: string; payload_sha256: string; event_type: string; linear_issue_id: string | null; received_at: string; status: string; owner: string | null; fencing_token: number; attempts: number; run_id: string | null; last_error_id: string | null; }
interface CleanupJournalRow { run_id: string; resource_key: string; operation: string; state: CleanupJournalEntry["state"]; generation: number; owner: string; fencing_token: number; started_at: string; completed_at: string | null; error_message: string | null; }
interface ErrorRow { error_id: string; run_id: string | null; code: string; message: string; component: string; retryable: number; operator_action_required: number; evidence_json: string; fingerprint: string; first_occurred_at: string; last_occurred_at: string; occurrence_count: number; resolved_at: string | null; }
interface ControllerLeaseRow { owner: string; fencing_token: number; expires_at: number; generation: number; }
export class WebhookConflictError extends IntakeIdempotencyConflictError { constructor(message: string) { super(message); this.name = "WebhookConflictError"; } }
function cleanupRow(row: CleanupJournalRow): CleanupJournalEntry { return { runId: row.run_id, resourceKey: row.resource_key, operation: row.operation, state: row.state, generation: row.generation, owner: row.owner, fencingToken: row.fencing_token, startedAt: row.started_at, ...(row.completed_at ? { completedAt: row.completed_at } : {}), ...(row.error_message ? { errorMessage: row.error_message } : {}) }; }
function rowToIntent(row: IntentRow): IntakeIntent { return { runId: row.run_id, linearIssueId: row.linear_issue_id, idempotencyKey: row.idempotency_key, artifactPath: row.artifact_path, artifact: { path: row.artifact_path, sha256: row.artifact_sha256, schemaId: row.artifact_schema_id }, snapshot: decodeSnapshot(row.snapshot_json), status: row.status }; }
function rowToResource(row: ResourceRow): ExternalResourceBinding { const metadata = decodeJson<Readonly<Record<string, unknown>>>(row.metadata_json, "resource metadata"); return { kind: row.kind, scope: row.scope, ...(row.role_key ? { role: row.role_key as any } : {}), deterministicKey: row.deterministic_key, deterministicName: row.deterministic_name, ...(row.external_id ? { externalId: row.external_id } : {}), generation: row.generation, state: row.state, ...(Object.keys(metadata).length ? { metadata } : {}), observedAt: row.observed_at }; }
function toResourceBinding(binding: ResourceBindingInput): ExternalResourceBinding { const result: ExternalResourceBinding = { kind: binding.kind, scope: binding.scope, deterministicKey: binding.deterministicKey, deterministicName: binding.deterministicName, generation: binding.generation, state: binding.state, observedAt: binding.observedAt }; if (binding.role) result.role = binding.role as NonNullable<ExternalResourceBinding["role"]>; if (binding.externalId) result.externalId = binding.externalId; if (binding.metadata && Object.keys(binding.metadata).length) result.metadata = structuredClone(binding.metadata); return result; }
function rowToError(row: ErrorRow): OperatorErrorRecord { return { errorId: row.error_id, ...(row.run_id ? { runId: row.run_id } : {}), code: row.code, message: row.message, component: row.component, retryable: row.retryable === 1, operatorActionRequired: row.operator_action_required === 1, evidence: decodeJson<OperatorErrorRecord["evidence"]>(row.evidence_json, "operator error evidence"), fingerprint: row.fingerprint, firstOccurredAt: row.first_occurred_at, lastOccurredAt: row.last_occurred_at, occurrenceCount: row.occurrence_count, ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}) }; }
function sameIntakeIdentity(a: RunSnapshot, b: RunSnapshot, artifact: IntakeCommitInput["artifact"]): boolean { return Boolean(a.identity && b.identity) && a.runId === b.runId && encodeJson(a.identity) === encodeJson(b.identity) && a.identity!.normalizedTicket.path === artifact.path && a.identity!.normalizedTicket.sha256 === artifact.sha256 && a.identity!.normalizedTicket.schemaId === artifact.schemaId; }
function isActiveState(state: string): boolean { return !["approved", "failed", "cancelled", "expired"].includes(state); }
function sanitizeEvidence(value: OperatorErrorRecord["evidence"]): OperatorErrorRecord["evidence"] {
  if (!Array.isArray(value) || value.length > 32) throw new StoreConflictError("operator error evidence exceeds its bound");
  const result = value.map(reference => {
    if (!reference || typeof reference !== "object" || Array.isArray(reference) || Object.getPrototypeOf(reference) !== Object.prototype || Object.keys(reference).some(key => !["path", "sha256", "mediaType", "schemaId"].includes(key)) || typeof reference.path !== "string" || !/^(?:artifacts|evidence)\/(?!\.{1,2}(?:\/|$))[^\u0000\r\n]+$/u.test(reference.path) || reference.path.length > 1_024 || typeof reference.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(reference.sha256) || typeof reference.mediaType !== "string" || reference.mediaType.length < 1 || reference.mediaType.length > 200 || (reference.schemaId !== undefined && (typeof reference.schemaId !== "string" || !/^urn:squire:contracts:v[0-9]+:[a-z-]+$/u.test(reference.schemaId)))) throw new StoreConflictError("operator error evidence reference is invalid");
    return structuredClone(reference);
  });
  if (new Set(result.map(reference => JSON.stringify(reference))).size !== result.length) throw new StoreConflictError("operator error evidence contains duplicates");
  return result;
}
function assertIntakeIntent(intent: IntakeIntent): void { if (!intent || typeof intent !== "object" || !intent.snapshot || !intent.artifact || !/^run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(intent.runId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(intent.linearIssueId) || typeof intent.idempotencyKey !== "string" || intent.idempotencyKey.length < 1 || intent.idempotencyKey.length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(intent.idempotencyKey) || !intent.snapshot.identity || intent.snapshot.runId !== intent.runId || intent.snapshot.identity.linearIssueId !== intent.linearIssueId || intent.snapshot.identity.intakeIdempotencyKey !== intent.idempotencyKey || intent.artifactPath !== intent.artifact.path || intent.artifact.path !== intent.snapshot.identity.normalizedTicket.path || intent.artifact.sha256 !== intent.snapshot.identity.normalizedTicket.sha256 || intent.artifact.schemaId !== intent.snapshot.identity.normalizedTicket.schemaId || !["intent", "published", "committed", "quarantined"].includes(intent.status)) throw new StoreConflictError("intake intent identity is invalid"); }
function isResourceStateTransition(from: ExternalResourceBinding["state"], to: ExternalResourceBinding["state"]): boolean { const allowed: Record<ExternalResourceBinding["state"], readonly ExternalResourceBinding["state"][]> = { planned: ["planned", "creating", "bound", "blocked"], creating: ["creating", "bound", "blocked"], bound: ["bound", "retained", "blocked"], retained: ["retained", "deleted", "blocked"], deleted: ["deleted"], blocked: ["blocked"] }; return allowed[from].includes(to); }
function assertResourceBindingInput(binding: ResourceBindingInput): void {
  const kinds = ["linear_issue", "sandbox", "herdr_workspace", "herdr_tab", "herdr_root_pane", "herdr_runner", "git_branch", "git_workspace", "git_bundle", "pi_session", "github_pr"];
  const states = ["planned", "creating", "bound", "retained", "deleted", "blocked"];
  if (!binding || !kinds.includes(binding.kind) || !states.includes(binding.state) || typeof binding.runId !== "string" || typeof binding.scope !== "string" || typeof binding.deterministicKey !== "string" || typeof binding.deterministicName !== "string" || !Number.isSafeInteger(binding.generation) || binding.generation < 0 || typeof binding.observedAt !== "string" || !Number.isFinite(Date.parse(binding.observedAt))) throw new StoreConflictError("resource binding shape is invalid");
  for (const [label, value] of [["resource scope", binding.scope], ["resource key", binding.deterministicKey], ["resource name", binding.deterministicName], ["resource external ID", binding.externalId]] as const) if (value !== undefined && (value.length < 1 || value.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(value))) throw new StoreConflictError(`${label} is invalid`);
  if (binding.role !== undefined && !["orchestrator", "plan", "implement", "review", "test"].includes(binding.role)) throw new StoreConflictError("resource role is invalid");
}
function assertControllerTiming(owner: string, now: number, ttlMs: number): void { if (typeof owner !== "string" || owner.length < 1 || owner.length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(owner) || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000) throw new StoreConflictError("controller lease timing is invalid"); }
function validTimestamp(value: string): boolean { return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value)); }
function sanitizeError(value: string): string { if (typeof value !== "string") return "unspecified operator error"; return value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/((?:authorization|cookie|x-api-key|api-key|token|password|secret))\s*[:=]\s*[^\s,;]+/giu, "$1=<redacted>").replace(/\s+/gu, " ").trim().slice(0, 4_096) || "unspecified operator error"; }
function translateIntakeError(error: unknown): Error { if (error instanceof Error && (error.name === "ActiveRunConflictError" || error.name === "IntakeIdempotencyConflictError" || error.name === "IntakeArtifactConflictError" || error.name === "WebhookConflictError" || error.name === "StoreConflictError")) return error; const message = error instanceof Error ? error.message : String(error); if (/UNIQUE constraint|CHECK constraint|SQLITE_CONSTRAINT/iu.test(message)) return new StoreConflictError("durable intake uniqueness conflict"); return error instanceof Error ? error : new Error(message); }
void createHash;
