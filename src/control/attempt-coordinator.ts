import { isTerminal, type Clock, type ContractReference, type DispatchRecord, type PhaseAttempt, type Role, type RunSnapshot } from "./domain.js";
import type { WorkflowStore } from "./workflow-store.js";
import { StoreConflictError } from "./workflow-store.js";
import { triggerPrompt } from "./handoff-dispatcher.js";

export interface SessionEntryPage { entries: readonly unknown[]; cursor: string | null }
export interface AttemptRuntime {
  roleTimeoutMs(role: Role): number;
  ensureProcess(runId: string, role: Role): Promise<void>;
  getEntries(cursor: string | null): Promise<SessionEntryPage>;
  prompt(message: string): Promise<void>;
  waitForSettled(timeoutMs: number): Promise<void>;
  abort(): Promise<void>;
}
export interface AttemptResultPort {
  discover(attempt: PhaseAttempt): Promise<ContractReference | undefined>;
  accept(runId: string, handoffId: string, reference: ContractReference): Promise<void>;
}
export interface AttemptExecution {
  runId: string;
  handoffId: string;
  triggerPath: string;
  owner: string;
  signal?: AbortSignal;
  crashAfter?: "before_spawn" | "after_spawn" | "send_intent" | "prompt_write" | "acceptance" | "tool_work" | "result_write" | "result_acceptance";
}
export class SimulatedCrash extends Error { constructor(readonly point: NonNullable<AttemptExecution["crashAfter"]>) { super(`simulated crash: ${point}`); } }
export class AttemptTimeoutError extends Error { constructor() { super("phase attempt deadline exceeded"); } }

/** Integrated persisted dispatch/recovery/lifecycle coordinator. */
export class AttemptCoordinator {
  constructor(readonly store: WorkflowStore, readonly runtime: AttemptRuntime, readonly results: AttemptResultPort, readonly clock: Clock, readonly maxLaunches = 2, readonly leaseMs = 30_000, readonly maxRecoveryPrompts = 1) {}

  async execute(options: AttemptExecution): Promise<"result_accepted"> {
    const lease = await this.store.acquireLease(options.runId, `dispatch:${options.handoffId}`, options.owner, this.clock.now(), this.leaseMs);
    if (!lease) throw new Error("dispatch lease is held by another coordinator");
    try {
      let attempt = await this.#attempt(options.runId, options.handoffId);
      this.#assertActive(attempt.run, options.signal);
      if (attempt.attempt.accepted || attempt.attempt.dispatch.state === "result_accepted") return "result_accepted";
      const existingResult = await this.results.discover(attempt.attempt);
      if (existingResult) {
        this.#crash(options, "result_write");
        await this.results.accept(options.runId, options.handoffId, existingResult);
        this.#crash(options, "result_acceptance");
        return "result_accepted";
      }
      this.#crash(options, "before_spawn");
      attempt = await this.#prepareLaunch(options, attempt);
      await this.runtime.ensureProcess(options.runId, attempt.attempt.phase);
      this.#crash(options, "after_spawn");
      let page = await this.runtime.getEntries(attempt.attempt.dispatch.cursor);
      attempt = await this.#updateDispatch(options.runId, options.handoffId, dispatch => ({ ...dispatch, cursor: page.cursor }));
      const markerObserved = page.entries.some(entry => JSON.stringify(entry).includes(attempt.attempt.dispatch.marker));
      if (!markerObserved && attempt.attempt.dispatch.state === "prepared") {
        attempt = await this.#updateDispatch(options.runId, options.handoffId, dispatch => ({ ...dispatch, state: "sent" }));
        this.#crash(options, "send_intent");
        await this.runtime.prompt(triggerPrompt(options.triggerPath, attempt.attempt.dispatch.marker));
        this.#crash(options, "prompt_write");
      } else if ((!markerObserved && attempt.attempt.dispatch.state === "sent") || (markerObserved && attempt.attempt.dispatch.state !== "accepted" && attempt.attempt.dispatch.state !== "settled")) {
        if (attempt.attempt.dispatch.recoveryPrompts >= this.maxRecoveryPrompts) throw new Error("recovery prompt budget exhausted");
        await this.runtime.prompt(`${attempt.attempt.dispatch.marker} Continue the handoff at ${options.triggerPath} without replaying the original trigger.`);
        attempt = await this.#updateDispatch(options.runId, options.handoffId, dispatch => ({ ...dispatch, recoveryPrompts: dispatch.recoveryPrompts + 1 }));
      }
      attempt = await this.#updateDispatch(options.runId, options.handoffId, dispatch => ({ ...dispatch, state: "accepted" }));
      this.#crash(options, "acceptance");
      const deadlineAt = attempt.attempt.dispatch.deadlineAt!;
      await this.#withDeadline(this.runtime.waitForSettled(Math.max(0, deadlineAt - this.clock.now())), deadlineAt, options.signal);
      this.#crash(options, "tool_work");
      attempt = await this.#updateDispatch(options.runId, options.handoffId, dispatch => ({ ...dispatch, state: "settled" }));
      let result = await this.results.discover(attempt.attempt);
      if (!result && attempt.attempt.dispatch.recoveryPrompts < this.maxRecoveryPrompts) {
        await this.runtime.prompt(`${attempt.attempt.dispatch.marker} Write or identify the immutable result for this settled handoff; do not repeat completed work.`);
        attempt = await this.#updateDispatch(options.runId, options.handoffId, dispatch => ({ ...dispatch, recoveryPrompts: dispatch.recoveryPrompts + 1 }));
        await this.#withDeadline(this.runtime.waitForSettled(Math.max(0, deadlineAt - this.clock.now())), deadlineAt, options.signal);
        result = await this.results.discover(attempt.attempt);
      }
      if (!result) throw new Error("bounded recovery ended without a valid immutable result");
      this.#crash(options, "result_write");
      await this.results.accept(options.runId, options.handoffId, result);
      this.#crash(options, "result_acceptance");
      return "result_accepted";
    } catch (error) {
      if (error instanceof SimulatedCrash) throw error;
      await this.runtime.abort().catch(() => undefined);
      const cancelled = options.signal?.aborted === true;
      await this.#terminalize(options.runId, cancelled ? "cancelled" : "failed", cancelled ? "operator_cancel" : error instanceof AttemptTimeoutError ? "timeout" : "attempt_failure", error instanceof Error ? error.message : String(error));
      throw error;
    } finally { await this.store.releaseLease(options.runId, `dispatch:${options.handoffId}`, options.owner); }
  }

  async #attempt(runId: string, handoffId: string): Promise<{ run: RunSnapshot; attempt: PhaseAttempt; index: number }> {
    const run = await this.store.read(runId); if (!run) throw new Error("run not found");
    const index = run.attempts.findIndex(candidate => candidate.handoffId === handoffId); const attempt = run.attempts[index];
    if (!attempt) throw new Error("handoff attempt not found"); return { run, attempt, index };
  }
  #assertActive(run: RunSnapshot, signal: AbortSignal | undefined): void { if (isTerminal(run.state)) throw new Error("terminal run cannot execute an attempt"); if (signal?.aborted) throw new Error("attempt cancelled"); }
  async #prepareLaunch(options: AttemptExecution, current: { run: RunSnapshot; attempt: PhaseAttempt; index: number }): Promise<typeof current> {
    const launches = current.attempt.dispatch.launchCount ?? 0;
    if (launches >= this.maxLaunches) throw new Error("process launch budget exhausted");
    return this.#updateDispatch(options.runId, options.handoffId, dispatch => ({ ...dispatch, launchCount: launches + 1, deadlineAt: dispatch.deadlineAt ?? this.clock.now() + this.runtime.roleTimeoutMs(current.attempt.phase), generation: dispatch.generation + 1 }));
  }
  async #updateDispatch(runId: string, handoffId: string, update: (dispatch: DispatchRecord) => DispatchRecord): Promise<{ run: RunSnapshot; attempt: PhaseAttempt; index: number }> {
    for (;;) {
      const current = await this.#attempt(runId, handoffId); this.#assertActive(current.run, undefined);
      try {
        const run = await this.store.compareAndSet(runId, { version: current.run.version, state: current.run.state, currentHead: current.run.currentHead }, snapshot => { const attempts = [...snapshot.attempts]; attempts[current.index] = { ...current.attempt, dispatch: update(current.attempt.dispatch) }; return { ...snapshot, version: snapshot.version + 1, attempts }; });
        return { run, attempt: run.attempts[current.index]!, index: current.index };
      } catch (error) { if (!(error instanceof StoreConflictError)) throw error; }
    }
  }
  async #withDeadline<T>(operation: Promise<T>, deadlineAt: number, signal: AbortSignal | undefined): Promise<T> {
    if (signal?.aborted) throw new Error("attempt cancelled");
    const remaining = deadlineAt - this.clock.now(); if (remaining <= 0) throw new AttemptTimeoutError();
    const timeout = this.clock.sleep(remaining, signal).then(() => { throw new AttemptTimeoutError(); });
    return Promise.race([operation, timeout]);
  }
  async #terminalize(runId: string, state: "failed" | "cancelled", code: string, message: string): Promise<void> {
    for (;;) {
      const current = await this.store.read(runId); if (!current || isTerminal(current.state)) return;
      try { await this.store.compareAndSet(runId, { version: current.version, state: current.state, currentHead: current.currentHead }, snapshot => ({ ...snapshot, version: snapshot.version + 1, state, terminalError: { code, message, at: new Date(this.clock.now()).toISOString(), evidence: [] } })); return; }
      catch (error) { if (!(error instanceof StoreConflictError)) throw error; }
    }
  }
  #crash(options: AttemptExecution, point: NonNullable<AttemptExecution["crashAfter"]>): void { if (options.crashAfter === point) throw new SimulatedCrash(point); }
}
