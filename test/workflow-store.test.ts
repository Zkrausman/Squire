import assert from "node:assert/strict"; import test from "node:test";
import { InMemoryWorkflowStore } from "./support/in-memory-workflow-store.js"; import { run, runtime } from "./support/fixtures.js";

test("in-memory test adapter enforces CAS, unique sessions, and one runtime resolution", async () => {
  const store = new InMemoryWorkflowStore(); await store.create(run());
  const resolved = await store.recordRuntime("run_example01", { version: 0, state: "accepted" }, runtime); assert.equal(resolved.version, 1);
  await assert.rejects(store.recordRuntime("run_example01", { version: 1 }, runtime), /already resolved/);
  const registration = { runId: "run_example01", role: "implement" as const, sessionId: "impl", sessionFile: "/ticket/sessions/implement/x_impl.jsonl", processGeneration: 1, registeredAt: "now" };
  const registered = await store.registerSession("run_example01", { version: 1 }, registration); assert.equal(registered.sessions.implement?.sessionId, "impl");
  await assert.rejects(store.registerSession("run_example01", { version: 2 }, { ...registration, role: "review" }), /already registered/);
  await assert.rejects(store.compareAndSet("run_example01", { version: 1 }, current => ({ ...current, version: 2 })), /stale run version/);
});

test("leases renew with monotonic fencing and stale tokens cannot mutate", async () => { const store = new InMemoryWorkflowStore(); await store.create(run()); const first = (await store.acquireLease("run_example01", "dispatch", "one", 0, 10))!; assert.equal(first.fencingToken, 1); assert.equal(await store.acquireLease("run_example01", "dispatch", "two", 5, 10), undefined); assert.equal((await store.renewLease("run_example01", "dispatch", "one", first.fencingToken, 5, 10))?.expiresAt, 15); const second = (await store.acquireLease("run_example01", "dispatch", "two", 16, 10))!; assert.equal(second.fencingToken, 2); await assert.rejects(store.compareAndSetFenced("run_example01", { version: 0 }, { key: "dispatch", owner: "one", fencingToken: first.fencingToken, now: 16 }, snapshot => ({ ...snapshot, version: 1 })), /fencing/); const updated = await store.compareAndSetFenced("run_example01", { version: 0 }, { key: "dispatch", owner: "two", fencingToken: second.fencingToken, now: 16 }, snapshot => ({ ...snapshot, version: 1 })); assert.equal(updated.version, 1); });

test("exact-token retention preserves an unresolved process without authorizing replacement", async () => {
  const store = new InMemoryWorkflowStore(); await store.create(run({ processAllocations: { implement: { role: "implement", owner: "old", fencingToken: 4, generation: 2, state: "spawning", allocatedAt: "now" } } }));
  const stale = await store.retainProcessAllocation("run_example01", { version: 0 }, { role: "implement", failedOwner: "other", failedFencingToken: 5, generation: 2, processIdentity: "p1" }); assert.equal(stale.version, 0); assert.equal(stale.processAllocations?.implement?.processIdentity, undefined);
  const retained = await store.retainProcessAllocation("run_example01", { version: 0 }, { role: "implement", failedOwner: "old", failedFencingToken: 4, generation: 2, processIdentity: "p1" }); assert.equal(retained.processAllocations?.implement?.state, "termination_failed"); assert.equal(retained.processAllocations?.implement?.processIdentity, "p1");
  const idempotent = await store.retainProcessAllocation("run_example01", { version: 1 }, { role: "implement", failedOwner: "old", failedFencingToken: 4, generation: 2, processIdentity: "p1" }); assert.equal(idempotent.version, 1);
  await assert.rejects(store.retainProcessAllocation("run_example01", { version: 1 }, { role: "implement", failedOwner: "old", failedFencingToken: 4, generation: 2, processIdentity: "different" }), /identity/);
});

test("exact-token compensation requires observed exit and cannot clobber a new owner", async () => {
  const store = new InMemoryWorkflowStore(); await store.create(run({ processAllocations: { implement: { role: "implement", owner: "old", fencingToken: 1, generation: 1, state: "spawned", processIdentity: "p1", allocatedAt: "now" } } }));
  await assert.rejects(store.recoverProcessAllocation("run_example01", { version: 0 }, { role: "implement", failedOwner: "old", failedFencingToken: 1, generation: 1, processIdentity: "p1", processExited: false }), /observed exit/);
  await assert.rejects(store.recoverProcessAllocation("run_example01", { version: 0 }, { role: "implement", failedOwner: "old", failedFencingToken: 1, generation: 1, processIdentity: "other-process", processExited: true }), /identity/);
  const untouched = await store.recoverProcessAllocation("run_example01", { version: 0 }, { role: "implement", failedOwner: "other", failedFencingToken: 2, generation: 1, processIdentity: "p1", processExited: true }); assert.equal(untouched.version, 0); assert.equal(untouched.processAllocations?.implement?.state, "spawned");
  const compensated = await store.recoverProcessAllocation("run_example01", { version: 0 }, { role: "implement", failedOwner: "old", failedFencingToken: 1, generation: 1, processIdentity: "p1", processExited: true }); assert.equal(compensated.processAllocations?.implement?.state, "failed");
  const resumed = new InMemoryWorkflowStore(); await resumed.create(run({ sessions: { implement: { runId: "run_example01", role: "implement", sessionId: "impl", sessionFile: "/ticket/sessions/implement/impl.jsonl", processGeneration: 2, processState: "launching", registeredAt: "now" } }, processAllocations: { implement: { role: "implement", owner: "old", fencingToken: 3, generation: 2, state: "reserved", sessionId: "impl", sessionFile: "/ticket/sessions/implement/impl.jsonl", allocatedAt: "now" } } }));
  const recovered = await resumed.recoverProcessAllocation("run_example01", { version: 0 }, { role: "implement", failedOwner: "old", failedFencingToken: 3, generation: 2, processExited: true }); assert.equal(recovered.processAllocations?.implement, undefined); assert.equal(recovered.sessions.implement?.processState, "failed");
});
