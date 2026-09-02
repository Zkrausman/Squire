import assert from "node:assert/strict";
import test from "node:test";
import { AttemptCoordinator, FencedLeaseError, SimulatedCrash, type AttemptRuntime } from "../src/control/attempt-coordinator.js";
import type { Clock, ContractReference, LeaseGuard, PhaseAttempt } from "../src/control/domain.js";
import { triggerPrompt } from "../src/control/handoff-dispatcher.js";
import { InMemoryWorkflowStore } from "./support/in-memory-workflow-store.js";
import { headA, ref, run } from "./support/fixtures.js";

const resultRef = ref("implement-result");
const triggerPath = "/ticket/artifacts/handoffs/implement/1/trigger.json";
function attempt(overrides: Partial<PhaseAttempt> = {}): PhaseAttempt { return { phase: "implement", attempt: 1, handoffId: "handoff_impl", targetSessionId: "impl", inputHead: headA, input: { path: "artifacts/handoff/input.json", sha256: "2".repeat(64), schemaId: "urn:squire:contracts:v1:phase-input" }, feedback: [], dispatch: { operationKey: "run:h:s", handoffId: "handoff_impl", targetSessionId: "impl", marker: "[squire:marker]", state: "prepared", generation: 0, cursor: null, recoveryPrompts: 0 }, ...overrides }; }
class FakeRuntime implements AttemptRuntime {
  entries: unknown[] = []; prompts: string[] = []; settled = false; ensureCalls = 0; launches = 0; abortCalls = 0; processLive = false; completeHistory = true;
  constructor(readonly timeoutMs = 10_000) {}
  roleTimeoutMs(): number { return this.timeoutMs; }
  async ensureProcess(_runId: string, _role: string, launchAllowed: boolean): Promise<{ launched: boolean }> { this.ensureCalls += 1; if (this.processLive) return { launched: false }; if (!launchAllowed) throw new Error("process launch budget exhausted"); this.processLive = true; this.launches += 1; return { launched: true }; }
  async getEntries(): Promise<{ entries: readonly unknown[]; cursor: string | null; complete: boolean }> { return { entries: this.entries, cursor: this.entries.length ? "leaf" : null, complete: this.completeHistory }; }
  async prompt(message: string): Promise<void> { this.prompts.push(message); this.entries.push({ type: "message", message }); }
  async waitForSettled(): Promise<void> { this.settled = true; }
  async abort(): Promise<void> { this.abortCalls += 1; }
}
async function fixture(clock: Clock = { now: () => 1_000, sleep: () => new Promise<void>(() => {}) }, timeoutMs = 10_000) {
  const store = new InMemoryWorkflowStore(); await store.create(run({ state: "implementing", attempts: [attempt()] })); const runtime = new FakeRuntime(timeoutMs);
  const results = {
    discover: async (): Promise<ContractReference | undefined> => runtime.settled ? resultRef : undefined,
    accept: async (runId: string, handoffId: string, reference: ContractReference, lease: LeaseGuard): Promise<void> => {
      const current = await store.read(runId); if (!current) throw new Error("missing"); const index = current.attempts.findIndex(value => value.handoffId === handoffId); if (current.attempts[index]?.accepted) return;
      await store.compareAndSetFenced(runId, { version: current.version }, lease, snapshot => { const attempts = [...snapshot.attempts]; const value = attempts[index]!; attempts[index] = { ...value, acceptedResult: reference, accepted: { reference, phase: "implement", handoffId, attempt: value.attempt, sessionId: value.targetSessionId, status: "pass", inputHead: headA, outputHead: "b".repeat(40), completedAt: "2026-09-01T12:00:00Z", acceptedAt: "2026-09-01T12:01:00Z", implementGeneration: 1 }, dispatch: { ...value.dispatch, state: "result_accepted" } }; return { ...snapshot, version: snapshot.version + 1, attempts, acceptedResultPaths: [...snapshot.acceptedResultPaths, reference.path] }; });
    }
  };
  return { store, runtime, coordinator: new AttemptCoordinator(store, runtime, results, clock) };
}
const points = ["before_spawn", "after_spawn", "send_intent", "prompt_write", "acceptance", "tool_work", "result_write", "result_acceptance"] as const;

test("every crash point converges with one exact original trigger, one launch, and one result", async () => {
  for (const point of points) {
    const { store, runtime, coordinator } = await fixture();
    await assert.rejects(coordinator.execute({ runId: "run_example01", handoffId: "handoff_impl", triggerPath, owner: "first", crashAfter: point }), SimulatedCrash);
    await coordinator.execute({ runId: "run_example01", handoffId: "handoff_impl", triggerPath, owner: "second" });
    const persisted = (await store.read("run_example01"))!.attempts[0]!; const original = triggerPrompt(triggerPath, persisted.dispatch.marker);
    assert.equal(persisted.dispatch.state, "result_accepted", point); assert.equal((await store.read("run_example01"))!.acceptedResultPaths.filter(path => path === resultRef.path).length, 1, point);
    assert.equal(persisted.dispatch.launchCount, 1, point); assert.equal(runtime.launches, 1, point); assert.equal(runtime.prompts.filter(message => message === original).length, 1, point);
    assert.equal(runtime.prompts.filter(message => message.includes("Continue the already-recorded handoff")).length, point === "prompt_write" ? 1 : 0, point);
  }
});

test("original trigger resend requires two complete stable history scans proving marker absence", async () => {
  const unstable = await fixture(); unstable.runtime.completeHistory = false;
  await assert.rejects(unstable.coordinator.execute({ runId: "run_example01", handoffId: "handoff_impl", triggerPath, owner: "unstable" }), /could not prove/); assert.deepEqual(unstable.runtime.prompts, []);
  const sent = await fixture(); await sent.store.compareAndSet("run_example01", { version: 0 }, snapshot => ({ ...snapshot, version: 1, attempts: [{ ...snapshot.attempts[0]!, dispatch: { ...snapshot.attempts[0]!.dispatch, state: "sent" } }] }));
  await sent.coordinator.execute({ runId: "run_example01", handoffId: "handoff_impl", triggerPath, owner: "retry" });
  assert.equal(sent.runtime.prompts[0], triggerPrompt(triggerPath, "[squire:marker]"));
});

test("expired owner is fenced from prompts, acceptance, terminalization, and budgets", async () => {
  let now = 1_000; const clock: Clock = { now: () => now, sleep: () => new Promise<void>(() => {}) }; const value = await fixture(clock, 100_000);
  let settle!: () => void; value.runtime.waitForSettled = () => new Promise<void>(resolve => { settle = () => { value.runtime.settled = false; resolve(); }; });
  const first = value.coordinator.execute({ runId: "run_example01", handoffId: "handoff_impl", triggerPath, owner: "one" });
  while (!settle) await new Promise(resolve => setImmediate(resolve));
  const fullKey = "run_example01:dispatch:handoff_impl"; const old = value.store.leases.get(fullKey)!; value.store.leases.set(fullKey, { ...old, expiresAt: now });
  const second = await value.store.acquireLease("run_example01", "dispatch:handoff_impl", "two", now, 100_000); assert.ok(second); assert.ok(second!.fencingToken > old.fencingToken);
  settle(); await assert.rejects(first, FencedLeaseError);
  const persisted = (await value.store.read("run_example01"))!; assert.equal(persisted.state, "implementing"); assert.equal(persisted.attempts[0]?.dispatch.recoveryPrompts, 0); assert.equal(persisted.attempts[0]?.dispatch.launchCount, 1); assert.equal(persisted.attempts[0]?.accepted, undefined); assert.equal(value.runtime.abortCalls, 0); assert.equal(value.runtime.prompts.length, 1);
});

test("lease horizon covers the role deadline and blocks a second owner while active", async () => {
  let now = 1_000; const clock: Clock = { now: () => now, sleep: () => new Promise<void>(() => {}) }; const value = await fixture(clock, 100_000);
  let settle!: () => void; value.runtime.waitForSettled = () => new Promise<void>(resolve => { settle = resolve; }); const first = value.coordinator.execute({ runId: "run_example01", handoffId: "handoff_impl", triggerPath, owner: "one" }); while (!settle) await new Promise(resolve => setImmediate(resolve));
  now += 31_000; assert.equal(await value.store.acquireLease("run_example01", "dispatch:handoff_impl", "two", now, 10_000), undefined); value.runtime.settled = true; settle(); await first;
});

test("timeout, cancellation, process exit, and launch exhaustion terminalize once", async () => {
  const timeoutClock: Clock = { now: () => 1_000, sleep: async () => {} }; const timed = await fixture(timeoutClock, 10); timed.runtime.waitForSettled = () => new Promise<void>(() => {});
  await assert.rejects(timed.coordinator.execute({ runId: "run_example01", handoffId: "handoff_impl", triggerPath, owner: "timeout" }), /deadline/); assert.equal((await timed.store.read("run_example01"))?.state, "failed"); assert.equal(timed.runtime.abortCalls, 1);
  timed.runtime.settled = true; await assert.rejects(timed.coordinator.execute({ runId: "run_example01", handoffId: "handoff_impl", triggerPath, owner: "late" }), /terminal/); assert.equal((await timed.store.read("run_example01"))?.attempts[0]?.accepted, undefined);
  const cancelled = await fixture(); const controller = new AbortController(); controller.abort(); await assert.rejects(cancelled.coordinator.execute({ runId: "run_example01", handoffId: "handoff_impl", triggerPath, owner: "cancel", signal: controller.signal }), /cancelled/); assert.equal((await cancelled.store.read("run_example01"))?.state, "cancelled");
  const exited = await fixture(); exited.runtime.waitForSettled = async () => { throw new Error("Pi process exited"); }; await assert.rejects(exited.coordinator.execute({ runId: "run_example01", handoffId: "handoff_impl", triggerPath, owner: "exit" }), /process exited/); assert.equal((await exited.store.read("run_example01"))?.state, "failed");
  const budget = await fixture(); await budget.store.compareAndSet("run_example01", { version: 0 }, snapshot => ({ ...snapshot, version: 1, attempts: [{ ...snapshot.attempts[0]!, dispatch: { ...snapshot.attempts[0]!.dispatch, launchCount: 2 } }] })); await assert.rejects(budget.coordinator.execute({ runId: "run_example01", handoffId: "handoff_impl", triggerPath, owner: "budget" }), /budget/); assert.equal((await budget.store.read("run_example01"))?.state, "failed");
});
