import { isTerminal, type Clock, type ContractReference, type DispatchRecord, type Lease, type LeaseGuard, type PhaseAttempt, type Role, type RunSnapshot } from "./domain.js";
import type { WorkflowStore } from "./workflow-store.js";
import { StoreConflictError } from "./workflow-store.js";
import { triggerPrompt } from "./handoff-dispatcher.js";

export interface SessionEntryPage { entries: readonly unknown[]; cursor: string | null; complete: boolean }
export interface ProcessEnsureResult { launched: boolean }
export interface AttemptRuntime {
  roleTimeoutMs(role: Role): number;
  ensureProcess(runId: string, role: Role, launchAllowed: boolean): Promise<ProcessEnsureResult>;
  getEntries(cursor: string | null): Promise<SessionEntryPage>;
  prompt(message: string): Promise<void>;
  waitForSettled(timeoutMs: number): Promise<void>;
  abort(): Promise<void>;
}
export interface AttemptResultPort {
  discover(attempt: PhaseAttempt): Promise<ContractReference | undefined>;
  accept(runId: string, handoffId: string, reference: ContractReference, lease: LeaseGuard): Promise<void>;
}
export interface AttemptExecution {
  runId: string;
  handoffId: string;
  triggerPath: string;
  owner: string;
  signal?: AbortSignal;
  crashAfter?: "before_spawn" | "after_spawn" | "send_intent" | "prompt_write" | "acceptance" | "tool_work" | "result_write" | "result_acceptance";
}
interface LeaseContext { runId: string; key: string; owner: string; fencingToken: number; ttlMs: number }
export class SimulatedCrash extends Error { constructor(readonly point: NonNullable<AttemptExecution["crashAfter"]>) { super(`simulated crash: ${point}`); } }
export class AttemptTimeoutError extends Error { constructor() { super("phase attempt deadline exceeded"); } }
export class FencedLeaseError extends Error { constructor() { super("dispatch lease ownership was lost or expired"); } }

/** Integrated persisted dispatch/recovery/lifecycle coordinator. */
export class AttemptCoordinator {
  constructor(readonly store: WorkflowStore, readonly runtime: AttemptRuntime, readonly results: AttemptResultPort, readonly clock: Clock, readonly maxLaunches = 2, readonly leaseMs = 30_000, readonly maxRecoveryPrompts = 1) {}

  async execute(options: AttemptExecution): Promise<"result_accepted"> {
    const initial = await this.#attempt(options.runId, options.handoffId);
    const roleTimeoutMs = this.runtime.roleTimeoutMs(initial.attempt.phase);
    const key = `dispatch:${options.handoffId}`;
    const ttlMs = Math.max(this.leaseMs, roleTimeoutMs + this.leaseMs);
    const acquired = await this.store.acquireLease(options.runId, key, options.owner, this.clock.now(), ttlMs);
    if (!acquired) throw new Error("dispatch lease is held by another coordinator");
    const lease: LeaseContext = { runId: options.runId, key, owner: options.owner, fencingToken: acquired.fencingToken, ttlMs };
    try {
      await this.#fence(lease);
      let attempt = await this.#attempt(options.runId, options.handoffId);
      this.#assertActive(attempt.run, options.signal);
      if (attempt.attempt.accepted || attempt.attempt.dispatch.state === "result_accepted") return "result_accepted";
      const existingResult = await this.results.discover(attempt.attempt);
      if (existingResult) {
        this.#crash(options, "result_write");
        await this.#acceptResult(lease, options, existingResult);
        this.#crash(options, "result_acceptance");
        return "result_accepted";
      }
      this.#crash(options, "before_spawn");
      attempt = await this.#prepareAttempt(lease, options, attempt, roleTimeoutMs);
      const launches = attempt.attempt.dispatch.launchCount ?? 0;
      await this.#fence(lease);
      const ensured = await this.runtime.ensureProcess(options.runId, attempt.attempt.phase, launches < this.maxLaunches);
      await this.#fence(lease);
      if (ensured.launched) attempt = await this.#updateDispatch(lease, options.handoffId, dispatch => ({ ...dispatch, launchCount: launches + 1, generation: dispatch.generation + 1 }));
      this.#crash(options, "after_spawn");

      const history = await this.#stableHistory(lease, attempt.attempt.dispatch.marker);
      attempt = await this.#updateDispatch(lease, options.handoffId, dispatch => ({ ...dispatch, cursor: history.cursor }));
      if (!history.markerObserved && !history.stableAbsence) throw new Error("session history could not prove trigger marker absence");
      if (!history.markerObserved && (attempt.attempt.dispatch.state === "prepared" || attempt.attempt.dispatch.state === "sent")) {
        attempt = await this.#updateDispatch(lease, options.handoffId, dispatch => ({ ...dispatch, state: "sent" }));
        this.#crash(options, "send_intent");
        await this.#prompt(lease, triggerPrompt(options.triggerPath, attempt.attempt.dispatch.marker));
        this.#crash(options, "prompt_write");
      } else if (history.markerObserved && attempt.attempt.dispatch.state !== "accepted" && attempt.attempt.dispatch.state !== "settled") {
        if (attempt.attempt.dispatch.recoveryPrompts >= this.maxRecoveryPrompts) throw new Error("recovery prompt budget exhausted");
        await this.#prompt(lease, `${attempt.attempt.dispatch.marker} Continue the already-recorded handoff without replaying its trigger.`);
        attempt = await this.#updateDispatch(lease, options.handoffId, dispatch => ({ ...dispatch, recoveryPrompts: dispatch.recoveryPrompts + 1 }));
      }
      attempt = await this.#updateDispatch(lease, options.handoffId, dispatch => ({ ...dispatch, state: "accepted" }));
      this.#crash(options, "acceptance");
      const deadlineAt = attempt.attempt.dispatch.deadlineAt!;
      await this.#waitForSettled(lease, deadlineAt, options.signal);
      this.#crash(options, "tool_work");
      attempt = await this.#updateDispatch(lease, options.handoffId, dispatch => ({ ...dispatch, state: "settled" }));
      let result = await this.results.discover(attempt.attempt);
      if (!result && attempt.attempt.dispatch.recoveryPrompts < this.maxRecoveryPrompts) {
        await this.#prompt(lease, `${attempt.attempt.dispatch.marker} Write or identify the immutable result for this settled handoff; do not repeat completed work.`);
        attempt = await this.#updateDispatch(lease, options.handoffId, dispatch => ({ ...dispatch, recoveryPrompts: dispatch.recoveryPrompts + 1 }));
        await this.#waitForSettled(lease, deadlineAt, options.signal);
        result = await this.results.discover(attempt.attempt);
      }
      if (!result) throw new Error("bounded recovery ended without a valid immutable result");
      this.#crash(options, "result_write");
      await this.#acceptResult(lease, options, result);
      this.#crash(options, "result_acceptance");
      return "result_accepted";
    } catch (error) {
      if (error instanceof SimulatedCrash || error instanceof FencedLeaseError) throw error;
      try {
        await this.#fence(lease);
        await this.runtime.abort().catch(() => undefined);
        await this.#fence(lease);
        const cancelled = options.signal?.aborted === true;
        await this.#terminalize(lease, cancelled ? "cancelled" : "failed", cancelled ? "operator_cancel" : error instanceof AttemptTimeoutError ? "timeout" : "attempt_failure", error instanceof Error ? error.message : String(error));
      } catch (fenceError) { if (!(fenceError instanceof FencedLeaseError)) throw fenceError; }
      throw error;
    } finally { await this.store.releaseLease(options.runId, key, options.owner, acquired.fencingToken); }
  }

  async #attempt(runId: string, handoffId: string): Promise<{ run: RunSnapshot; attempt: PhaseAttempt; index: number }> {
    const run = await this.store.read(runId); if (!run) throw new Error("run not found");
    const index = run.attempts.findIndex(candidate => candidate.handoffId === handoffId); const attempt = run.attempts[index];
    if (!attempt) throw new Error("handoff attempt not found"); return { run, attempt, index };
  }
  #assertActive(run: RunSnapshot, signal: AbortSignal | undefined): void { if (isTerminal(run.state)) throw new Error("terminal run cannot execute an attempt"); if (signal?.aborted) throw new Error("attempt cancelled"); }
  async #prepareAttempt(lease: LeaseContext, options: AttemptExecution, current: { run: RunSnapshot; attempt: PhaseAttempt; index: number }, roleTimeoutMs: number): Promise<typeof current> {
    return this.#updateDispatch(lease, options.handoffId, dispatch => ({ ...dispatch, deadlineAt: dispatch.deadlineAt ?? this.clock.now() + roleTimeoutMs }));
  }
  async #updateDispatch(lease: LeaseContext, handoffId: string, update: (dispatch: DispatchRecord) => DispatchRecord): Promise<{ run: RunSnapshot; attempt: PhaseAttempt; index: number }> {
    for (;;) {
      const current = await this.#attempt(lease.runId, handoffId); this.#assertActive(current.run, undefined);
      try {
        const run = await this.store.compareAndSetFenced(lease.runId, { version: current.run.version, state: current.run.state, currentHead: current.run.currentHead }, this.#guard(lease), snapshot => { const attempts = [...snapshot.attempts]; attempts[current.index] = { ...current.attempt, dispatch: update(current.attempt.dispatch) }; return { ...snapshot, version: snapshot.version + 1, attempts }; });
        return { run, attempt: run.attempts[current.index]!, index: current.index };
      } catch (error) {
        if (!(error instanceof StoreConflictError)) throw error;
        await this.#fence(lease);
      }
    }
  }
  async #stableHistory(lease: LeaseContext, marker: string): Promise<{ markerObserved: boolean; stableAbsence: boolean; cursor: string | null }> {
    await this.#fence(lease); const first = await this.runtime.getEntries(null); await this.#fence(lease);
    if (first.entries.some(entry => JSON.stringify(entry).includes(marker))) return { markerObserved: true, stableAbsence: false, cursor: first.cursor };
    const second = await this.runtime.getEntries(null); await this.#fence(lease);
    const markerObserved = second.entries.some(entry => JSON.stringify(entry).includes(marker));
    return { markerObserved, stableAbsence: !markerObserved && first.complete && second.complete && first.cursor === second.cursor && JSON.stringify(first.entries) === JSON.stringify(second.entries), cursor: second.cursor };
  }
  async #prompt(lease: LeaseContext, message: string): Promise<void> { await this.#fence(lease); await this.runtime.prompt(message); await this.#fence(lease); }
  async #waitForSettled(lease: LeaseContext, deadlineAt: number, signal: AbortSignal | undefined): Promise<void> {
    await this.#fence(lease); await this.#withDeadline(this.runtime.waitForSettled(Math.max(0, deadlineAt - this.clock.now())), deadlineAt, signal); await this.#fence(lease);
  }
  async #acceptResult(lease: LeaseContext, options: AttemptExecution, result: ContractReference): Promise<void> { await this.#fence(lease); await this.results.accept(options.runId, options.handoffId, result, this.#guard(lease)); await this.#fence(lease); }
  async #withDeadline<T>(operation: Promise<T>, deadlineAt: number, signal: AbortSignal | undefined): Promise<T> {
    if (signal?.aborted) throw new Error("attempt cancelled");
    const remaining = deadlineAt - this.clock.now(); if (remaining <= 0) throw new AttemptTimeoutError();
    const timeout = this.clock.sleep(remaining, signal).then(() => { throw new AttemptTimeoutError(); });
    return Promise.race([operation, timeout]);
  }
  async #terminalize(lease: LeaseContext, state: "failed" | "cancelled", code: string, message: string): Promise<void> {
    for (;;) {
      const current = await this.store.read(lease.runId); if (!current || isTerminal(current.state)) return;
      try { await this.store.compareAndSetFenced(lease.runId, { version: current.version, state: current.state, currentHead: current.currentHead }, this.#guard(lease), snapshot => ({ ...snapshot, version: snapshot.version + 1, state, terminalError: { code, message, at: new Date(this.clock.now()).toISOString(), evidence: [] } })); return; }
      catch (error) { if (!(error instanceof StoreConflictError)) throw error; await this.#fence(lease); }
    }
  }
  async #fence(lease: LeaseContext): Promise<Lease> { const renewed = await this.store.renewLease(lease.runId, lease.key, lease.owner, lease.fencingToken, this.clock.now(), lease.ttlMs); if (!renewed) throw new FencedLeaseError(); return renewed; }
  #guard(lease: LeaseContext): LeaseGuard { return { key: lease.key, owner: lease.owner, fencingToken: lease.fencingToken, now: this.clock.now() }; }
  #crash(options: AttemptExecution, point: NonNullable<AttemptExecution["crashAfter"]>): void { if (options.crashAfter === point) throw new SimulatedCrash(point); }
}
