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

test("lease is single owner and expires", async () => { const store = new InMemoryWorkflowStore(); await store.create(run()); assert.ok(await store.acquireLease("run_example01", "dispatch", "one", 0, 10)); assert.equal(await store.acquireLease("run_example01", "dispatch", "two", 5, 10), undefined); assert.ok(await store.acquireLease("run_example01", "dispatch", "two", 11, 10)); });
