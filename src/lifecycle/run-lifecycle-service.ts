import { randomUUID } from "node:crypto";
import type { Clock, GitHeadObserver, RunSnapshot, TerminalState, WorkflowState } from "../control/domain.js";
import { isTerminal } from "../control/domain.js";
import { StoreConflictError, type WorkflowStore } from "../control/workflow-store.js";
import type { SqliteIntakeStore } from "../sqlite/sqlite-intake-store.js";
import { sanitizeOperatorMessage, validateOperatorErrorInput } from "./operator-errors.js";
import type { LinearMutationPort } from "../reconciliation/ports.js";
import type { ReconciledSideEffectGate } from "../reconciliation/side-effect-gate.js";

export interface LinearStateIds { readonly accepted: string; readonly inProgress: string; readonly awaitingHuman: string; readonly completed: string; readonly failed: string; readonly cancelled: string; }
export interface RetentionPolicy { readonly successHours: number; readonly failureHours: number; }
export interface LifecycleCleanupPort { readonly name: string; cleanup(runId: string, permit: { readonly owner: string; readonly fencingToken: number }, signal?: AbortSignal): Promise<void>; }
export interface RunLifecycleServiceOptions { readonly store: WorkflowStore; readonly ledger?: SqliteIntakeStore; readonly headObserver: GitHeadObserver; readonly linear?: LinearMutationPort; readonly stateIds: LinearStateIds; readonly retention?: RetentionPolicy; readonly clock?: Clock; readonly sideEffectGate?: ReconciledSideEffectGate; readonly cleanup?: readonly LifecycleCleanupPort[]; readonly controllerOwner?: string; }
export interface CancelRequest { readonly runId: string; readonly commandId: string; }
export interface FailureRequest { readonly runId: string; readonly commandId?: string; readonly code: string; readonly message: string; readonly retryable?: boolean; readonly operatorActionRequired?: boolean; }
export interface ExpiryRequest { readonly runId: string; readonly commandId: string; readonly callerNow?: number; }
export interface OperatorResolutionRequest { readonly runId: string; readonly errorId: string; readonly expectedVersion: number; readonly actionId: string; readonly resourceIdentity?: string; }

/** Lifecycle coordinator around AIDEV-216 terminal CAS and AIDEV-222
 * quiescence.  It does not publish, approve, merge, or run an operator UI. */
export class RunLifecycleService {
  readonly #store: WorkflowStore;
  readonly #ledger: SqliteIntakeStore | undefined;
  readonly #head: GitHeadObserver;
  readonly #linear: LinearMutationPort | undefined;
  readonly #stateIds: LinearStateIds;
  readonly #retention: RetentionPolicy;
  readonly #clock: Clock;
  readonly #gate: ReconciledSideEffectGate | undefined;
  readonly #cleanup: readonly LifecycleCleanupPort[];
  readonly #owner: string;
  constructor(options: RunLifecycleServiceOptions) {
    this.#store = options.store; this.#ledger = options.ledger; this.#head = options.headObserver; this.#linear = options.linear; this.#stateIds = validateStateIds(options.stateIds); this.#retention = validateRetention(options.retention ?? { successHours: 24, failureHours: 168 }); this.#clock = options.clock ?? { now: () => Date.now(), sleep: async ms => { await new Promise<void>(resolve => setTimeout(resolve, ms)); } }; this.#gate = options.sideEffectGate; this.#cleanup = options.cleanup ?? []; this.#owner = options.controllerOwner ?? `lifecycle-${randomUUID()}`;
    if (!this.#store || !this.#head) throw new StoreConflictError("lifecycle requires durable store and trusted Git head observation");
    if (this.#linear && !this.#gate) throw new StoreConflictError("Linear lifecycle mutation requires a reconciled side-effect gate");
  }
  async cancel(request: CancelRequest): Promise<RunSnapshot> {
    assertCommandId(request.commandId);
    return this.#terminal(request.runId, request.commandId, "cancelled", "operator_cancelled", "operator cancellation", true);
  }
  async fail(request: FailureRequest): Promise<RunSnapshot> {
    const retryable = request.retryable === true;
    validateOperatorErrorInput({ code: request.code, message: request.message, component: "lifecycle", retryable, operatorActionRequired: request.operatorActionRequired !== false });
    const message = sanitizeOperatorMessage(request.message);
    if (retryable) {
      const current = await this.#store.read(request.runId); if (!current) throw new StoreConflictError("run not found");
      if (isTerminal(current.state)) return current;
      await this.#recordError(request.runId, request.code, message, true, true);
      return this.#setBlocked(request.runId);
    }
    return this.#terminal(request.runId, request.commandId ?? `system:${request.code}:${randomUUID()}`, "failed", request.code, message, request.operatorActionRequired !== false);
  }
  async observeApproval(request: { readonly runId: string; readonly commandId: string }): Promise<RunSnapshot> {
    assertCommandId(request.commandId);
    const current = await this.#store.read(request.runId); if (!current) throw new StoreConflictError("run not found");
    if (current.state === "approved" && current.committedRequestIds.includes(request.commandId)) return current;
    if (current.state !== "awaiting_approval") throw new StoreConflictError("approval observation is out of order");
    const observedHead = await this.#head.observeHead(request.runId); if (observedHead !== current.currentHead) throw new StoreConflictError("Git head changed before approval observation");
    const now = new Date(this.#clock.now()).toISOString(); const until = new Date(this.#clock.now() + this.#retention.successHours * 3_600_000).toISOString();
    if (this.#ledger) return this.#ledger.markApproved({ runId: request.runId, commandId: request.commandId, expectedHead: observedHead, now, successRetentionUntil: until });
    const next = await this.#store.compareAndSet(request.runId, { version: current.version, state: current.state, currentHead: current.currentHead }, snapshot => ({ ...snapshot, version: snapshot.version + 1, state: "approved", committedRequestIds: [...snapshot.committedRequestIds, request.commandId], timestamps: snapshot.timestamps ? { ...snapshot.timestamps, updatedAt: now, terminalAt: now, successRetentionUntil: until } : { createdAt: now, updatedAt: now, terminalAt: now, successRetentionUntil: until } }));
    return next;
  }
  async recordApproval(request: { readonly runId: string; readonly commandId: string }): Promise<RunSnapshot> { return this.observeApproval(request); }
  async observeApproved(request: { readonly runId: string; readonly commandId: string }): Promise<RunSnapshot> { return this.observeApproval(request); }
  async expire(request: ExpiryRequest): Promise<RunSnapshot> {
    assertCommandId(request.commandId);
    const current = await this.#store.read(request.runId); if (!current) throw new StoreConflictError("run not found");
    if (isTerminal(current.state)) return current;
    const deadline = current.timestamps?.expiresAt; if (!deadline || !Number.isFinite(Date.parse(deadline))) throw new StoreConflictError("run has no trusted expiry deadline");
    if (this.#clock.now() < Date.parse(deadline)) throw new StoreConflictError("retention expiry deadline has not elapsed");
    // callerNow is intentionally ignored; only the injected trusted clock may
    // cross the persisted deadline.
    void request.callerNow;
    return this.#terminal(request.runId, request.commandId, "expired", "retention_expired", "workflow retention expired", true);
  }
  async resolveOperatorError(request: OperatorResolutionRequest): Promise<void> {
    assertCommandId(request.actionId);
    const current = await this.#store.read(request.runId); if (!current) throw new StoreConflictError("run not found");
    if (current.version !== request.expectedVersion) throw new StoreConflictError("operator resolution expected version is stale");
    if (!current.lastError || current.lastError.errorId !== request.errorId) throw new StoreConflictError("operator error is not the current run error");
    if (request.resourceIdentity && /[\u0000-\u001f\u007f\r\n]/u.test(request.resourceIdentity)) throw new StoreConflictError("operator resource identity is invalid");
    if (!request.resourceIdentity && /(?:resource|sandbox|herdr|github|git|process)/iu.test(current.lastError.code) && (current.resources ?? []).length > 0) throw new StoreConflictError("operator resolution requires the exact resource identity");
    if (!this.#ledger) throw new StoreConflictError("operator resolution requires the durable intake ledger");
    this.#ledger.resolveOperatorError({ errorId: request.errorId, runId: request.runId, expectedVersion: request.expectedVersion, actionId: request.actionId, ...(request.resourceIdentity ? { resourceIdentity: request.resourceIdentity } : {}), now: new Date(this.#clock.now()).toISOString() });
    // Resolution never clears operator_blocked and never issues a side-effect
    // permit. A fresh complete startup reconciliation is required.
  }
  async cleanupRun(runId: string, signal?: AbortSignal): Promise<{ readonly runId: string; readonly removed: readonly string[] }> {
    const current = await this.#store.read(runId); if (!current) throw new StoreConflictError("run not found");
    if (!isTerminal(current.state)) throw new StoreConflictError("cleanup requires a terminal run");
    if ((current.resources ?? []).some(resource => ["planned", "creating", "bound", "retained", "blocked"].includes(resource.state)) && this.#cleanup.length === 0) throw new StoreConflictError("cleanup requires an explicit port for retained resources");
    const until = retentionDeadline(current); if (!until || !Number.isFinite(Date.parse(until))) throw new StoreConflictError("terminal run has no trusted retention deadline"); if (this.#clock.now() < Date.parse(until)) throw new StoreConflictError("retention deadline has not elapsed");
    const fence = await this.#store.acquireRunTerminalFence(runId, this.#owner, this.#clock.now());
    const removed: string[] = [];
    try {
      for (const port of this.#cleanup) {
        const journal = this.#ledger?.beginCleanup(runId, port.name, "cleanup", fence.owner, fence.fencingToken, new Date(this.#clock.now()).toISOString());
        if (journal?.state === "completed") { removed.push(port.name); await this.#store.assertRunTeardownQuiescent(runId, fence, this.#clock.now()); continue; }
        try { await port.cleanup(runId, { owner: fence.owner, fencingToken: fence.fencingToken }, signal); if (journal) this.#ledger!.finishCleanup(journal, true, new Date(this.#clock.now()).toISOString()); removed.push(port.name); }
        catch (error) { if (journal) this.#ledger!.finishCleanup(journal, false, new Date(this.#clock.now()).toISOString(), error instanceof Error ? error.message : String(error)); throw error; }
        await this.#store.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
      }
      await this.#store.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
      await this.#store.completeRunTeardown(runId, fence, this.#clock.now());
      return { runId, removed };
    } catch (error) { throw error; }
  }
  mapLinearState(state: WorkflowState): string { return mapWorkflowStateToLinearStateId(state, this.#stateIds); }
  static mapLinearState(state: WorkflowState, ids: LinearStateIds): string { return mapWorkflowStateToLinearStateId(state, validateStateIds(ids)); }

  async #terminal(runId: string, commandId: string, state: Extract<TerminalState, "failed" | "cancelled" | "expired">, code: string, message: string, actionRequired: boolean): Promise<RunSnapshot> {
    assertCommandId(commandId);
    const current = await this.#store.read(runId); if (!current) throw new StoreConflictError("run not found");
    if (isTerminal(current.state)) { if (current.committedRequestIds.includes(commandId)) return current; throw new StoreConflictError("terminal race already decided"); }
    const observedHead = await this.#head.observeHead(runId);
    if (observedHead !== current.currentHead) throw new StoreConflictError("Git head changed before terminal command");
    const now = new Date(this.#clock.now()).toISOString();
    const terminalError = { code, message: sanitizeOperatorMessage(message), at: now, evidence: [] as const };
    if (this.#ledger) {
      await this.#recordError(runId, code, terminalError.message, false, actionRequired);
      const refreshed = await this.#store.read(runId); if (!refreshed) throw new StoreConflictError("run disappeared during terminal error recording");
      const result = this.#ledger.terminalize({ runId, commandId, toState: state, expectedHead: observedHead, terminalError, now, failureRetentionUntil: new Date(this.#clock.now() + this.#retention.failureHours * 3_600_000).toISOString() });
      await this.#synchronizeLinear(result, state);
      return result;
    }
    const result = await this.#store.compareAndSet(runId, { version: current.version, state: current.state, currentHead: current.currentHead }, snapshot => ({ ...snapshot, version: snapshot.version + 1, state, committedRequestIds: [...snapshot.committedRequestIds, commandId], terminalError, timestamps: snapshot.timestamps ? { ...snapshot.timestamps, updatedAt: now, terminalAt: now, failureRetentionUntil: new Date(this.#clock.now() + this.#retention.failureHours * 3_600_000).toISOString() } : { createdAt: now, updatedAt: now, terminalAt: now, failureRetentionUntil: new Date(this.#clock.now() + this.#retention.failureHours * 3_600_000).toISOString() } }));
    await this.#synchronizeLinear(result, state); return result;
  }
  async #recordError(runId: string, code: string, message: string, retryable: boolean, operatorActionRequired: boolean): Promise<void> {
    if (!this.#ledger) return;
    this.#ledger.recordOperatorError({ runId, code: normalizeCode(code), message, component: "lifecycle", retryable, operatorActionRequired, evidence: [], now: new Date(this.#clock.now()).toISOString() });
  }
  async #setBlocked(runId: string): Promise<RunSnapshot> {
    for (;;) {
      const current = await this.#store.read(runId); if (!current) throw new StoreConflictError("run not found");
      if (current.operatorBlocked) return current;
      try { return await this.#store.compareAndSet(runId, { version: current.version, state: current.state, currentHead: current.currentHead }, snapshot => ({ ...snapshot, version: snapshot.version + 1, operatorBlocked: true })); }
      catch (error) { if (!(error instanceof StoreConflictError)) throw error; }
    }
  }
  async #synchronizeLinear(run: RunSnapshot, state: Extract<TerminalState, "failed" | "cancelled" | "expired">): Promise<void> {
    if (!this.#linear || !run.identity) return;
    const permit = this.#gate?.require(run.runId);
    if (!permit && this.#gate) throw new StoreConflictError("Linear lifecycle mutation lacks a reconciled permit");
    try {
      await this.#linear.setState(run.identity.linearIssueId, mapWorkflowStateToLinearStateId(state, this.#stateIds), permit!);
      if (this.#gate && permit) this.#gate.assertValid(run.runId, permit);
    } catch (error) {
      if (this.#ledger) await this.#recordError(run.runId, "linear_sync_failed", error instanceof Error ? error.message : String(error), true, true);
      throw error;
    }
  }
}

export function mapWorkflowStateToLinearStateId(state: WorkflowState, ids: LinearStateIds): string {
  switch (state) {
    case "accepted": case "preparing": case "planning": return ids.accepted;
    case "implementing": case "reviewing": case "testing": case "publishing": return ids.inProgress;
    case "awaiting_approval": case "approved": return ids.awaitingHuman;
    case "failed": case "expired": return ids.failed;
    case "cancelled": return ids.cancelled;
  }
}
function validateStateIds(ids: LinearStateIds): LinearStateIds { const values = Object.values(ids); if (values.some(value => typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) || new Set(values).size !== values.length) throw new StoreConflictError("Linear state IDs are invalid"); return ids; }
function validateRetention(value: RetentionPolicy): RetentionPolicy { if (!Number.isSafeInteger(value.successHours) || value.successHours < 0 || !Number.isSafeInteger(value.failureHours) || value.failureHours < 1 || value.failureHours > 24 * 365 * 10) throw new StoreConflictError("retention policy is invalid"); return value; }
function assertCommandId(value: string): void { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value)) throw new StoreConflictError("command ID is invalid or missing"); }
function normalizeCode(value: string): string { const code = value.toLowerCase().replace(/[^a-z0-9_.-]/gu, "_").slice(0, 64); return /^[a-z]/u.test(code) ? code : `error_${code}`; }
function retentionDeadline(run: RunSnapshot): string | undefined { return run.state === "approved" ? run.timestamps?.successRetentionUntil : run.timestamps?.failureRetentionUntil; }
