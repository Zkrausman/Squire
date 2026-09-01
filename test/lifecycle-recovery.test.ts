import assert from "node:assert/strict";
import test from "node:test";
import { AttemptCoordinator, SimulatedCrash, type AttemptRuntime } from "../src/control/attempt-coordinator.js";
import type { Clock, ContractReference, PhaseAttempt } from "../src/control/domain.js";
import { InMemoryWorkflowStore } from "./support/in-memory-workflow-store.js";
import { headA, ref, run } from "./support/fixtures.js";

const resultRef = ref("implement-result");
function attempt(overrides: Partial<PhaseAttempt> = {}): PhaseAttempt { return { phase: "implement", attempt: 1, handoffId: "handoff_impl", targetSessionId: "impl", inputHead: headA, input: { path: "artifacts/handoff/input.json", sha256: "2".repeat(64), schemaId: "urn:squire:contracts:v1:phase-input" }, feedback: [], dispatch: { operationKey: "run:h:s", handoffId: "handoff_impl", targetSessionId: "impl", marker: "[squire:marker]", state: "prepared", generation: 0, cursor: null, recoveryPrompts: 0 }, ...overrides }; }
class FakeRuntime implements AttemptRuntime {
  entries: unknown[] = []; prompts: string[] = []; settled = false; ensureCalls = 0; abortCalls = 0;
  constructor(readonly timeoutMs = 10_000) {}
  roleTimeoutMs(): number { return this.timeoutMs; }
  async ensureProcess(): Promise<void> { this.ensureCalls += 1; }
  async getEntries(): Promise<{ entries: readonly unknown[]; cursor: string | null }> { return { entries: this.entries, cursor: this.entries.length ? "leaf" : null }; }
  async prompt(message: string): Promise<void> { this.prompts.push(message); this.entries.push({ type: "message", message }); }
  async waitForSettled(): Promise<void> { this.settled = true; }
  async abort(): Promise<void> { this.abortCalls += 1; }
}
async function fixture(clock: Clock = { now: () => 1_000, sleep: () => new Promise<void>(() => {}) }, timeoutMs = 10_000) {
  const store = new InMemoryWorkflowStore();
  await store.create(run({ state: "implementing", attempts: [attempt()] }));
  const runtime = new FakeRuntime(timeoutMs);
  const results = {
    discover: async (): Promise<ContractReference | undefined> => runtime.settled ? resultRef : undefined,
    accept: async (runId: string, handoffId: string, reference: ContractReference): Promise<void> => {
      for (;;) {
        const current = await store.read(runId); if (!current) throw new Error("missing");
        const index = current.attempts.findIndex(value => value.handoffId === handoffId); if (current.attempts[index]?.accepted) return;
        try {
          await store.compareAndSet(runId, { version: current.version }, snapshot => {
            const attempts = [...snapshot.attempts]; const value = attempts[index]!;
            attempts[index] = { ...value, acceptedResult: reference, accepted: { reference, phase: "implement", handoffId, attempt: value.attempt, sessionId: value.targetSessionId, status: "pass", inputHead: headA, outputHead: "b".repeat(40), completedAt: "2026-09-01T12:00:00Z", acceptedAt: "2026-09-01T12:01:00Z", implementGeneration: 1 }, dispatch: { ...value.dispatch, state: "result_accepted" } };
            return { ...snapshot, version: snapshot.version + 1, attempts, acceptedResultPaths: [...snapshot.acceptedResultPaths, reference.path] };
          });
          return;
        } catch { continue; }
      }
    }
  };
  return { store, runtime, coordinator: new AttemptCoordinator(store, runtime, results, clock) };
}
const points = ["before_spawn", "after_spawn", "send_intent", "prompt_write", "acceptance", "tool_work", "result_write", "result_acceptance"] as const;

test("all crash points converge to one trigger, one accepted result, and bounded launches", async () => {
  for (const point of points) {
    const { store, runtime, coordinator } = await fixture();
    await assert.rejects(coordinator.execute({ runId: "run_example01", handoffId: "handoff_impl", triggerPath: "/ticket/artifacts/handoffs/implement/1/trigger.json", owner: "first", crashAfter: point }), SimulatedCrash);
    await coordinator.execute({ runId: "run_example01", handoffId: "handoff_impl", triggerPath: "/ticket/artifacts/handoffs/implement/1/trigger.json", owner: "second" });
    const final = await store.read("run_example01"); const persisted = final!.attempts[0]!;
    assert.equal(persisted.dispatch.state, "result_accepted", point); assert.equal(final!.acceptedResultPaths.filter(path => path === resultRef.path).length, 1, point);
    assert.ok((persisted.dispatch.launchCount ?? 0) <= 2, point);
    assert.ok(runtime.prompts.filter(message => message.includes("Execute the controller-validated")).length <= 1, point);
  }
});

test("timeout and cancellation abort and terminalize exactly once; late retry cannot reopen", async () => {
  const timeoutClock: Clock = { now: () => 1_000, sleep: async () => {} }; const timed = await fixture(timeoutClock, 10); timed.runtime.waitForSettled = () => new Promise<void>(() => {});
  await assert.rejects(timed.coordinator.execute({ runId: "run_example01", handoffId: "handoff_impl", triggerPath: "/ticket/artifacts/handoffs/implement/1/trigger.json", owner: "timeout" }), /deadline/);
  assert.equal((await timed.store.read("run_example01"))?.state, "failed"); assert.equal(timed.runtime.abortCalls, 1);
  timed.runtime.settled = true; // a result becomes discoverable only after the terminal CAS won
  await assert.rejects(timed.coordinator.execute({ runId: "run_example01", handoffId: "handoff_impl", triggerPath: "/ticket/artifacts/handoffs/implement/1/trigger.json", owner: "late" }), /terminal/);
  assert.equal((await timed.store.read("run_example01"))?.state, "failed"); assert.equal((await timed.store.read("run_example01"))?.attempts[0]?.accepted, undefined);

  const cancelled = await fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(cancelled.coordinator.execute({ runId: "run_example01", handoffId: "handoff_impl", triggerPath: "/ticket/artifacts/handoffs/implement/1/trigger.json", owner: "cancel", signal: controller.signal }), /cancelled/);
  assert.equal((await cancelled.store.read("run_example01"))?.state, "cancelled");
});

test("process exit during work aborts and terminalizes the run", async () => { const exited = await fixture(); exited.runtime.waitForSettled = async () => { throw new Error("Pi process exited"); }; await assert.rejects(exited.coordinator.execute({ runId: "run_example01", handoffId: "handoff_impl", triggerPath: "/ticket/artifacts/handoffs/implement/1/trigger.json", owner: "exit" }), /process exited/); assert.equal((await exited.store.read("run_example01"))?.state, "failed"); assert.equal(exited.runtime.abortCalls, 1); });

test("persisted two-launch budget is enforced by production coordinator", async () => { const { store, coordinator } = await fixture(); await store.compareAndSet("run_example01", { version: 0 }, snapshot => ({ ...snapshot, version: 1, attempts: [{ ...snapshot.attempts[0]!, dispatch: { ...snapshot.attempts[0]!.dispatch, launchCount: 2 } }] })); await assert.rejects(coordinator.execute({ runId: "run_example01", handoffId: "handoff_impl", triggerPath: "/ticket/artifacts/handoffs/implement/1/trigger.json", owner: "budget" }), /budget/); assert.equal((await store.read("run_example01"))?.state, "failed"); });
