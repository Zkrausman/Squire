import assert from "node:assert/strict";
import test from "node:test";
import { RunLifecycleService, mapWorkflowStateToLinearStateId } from "../src/index.js";
import { InMemoryWorkflowStore } from "./support/in-memory-workflow-store.js";
import { run } from "./support/fixtures.js";

const ids = { accepted: "10000000-0000-4000-8000-000000000001", inProgress: "10000000-0000-4000-8000-000000000002", awaitingHuman: "10000000-0000-4000-8000-000000000003", completed: "10000000-0000-4000-8000-000000000004", failed: "10000000-0000-4000-8000-000000000005", cancelled: "10000000-0000-4000-8000-000000000006" };

test("lifecycle cancellation wins one terminal CAS and late replay is idempotent", async () => {
  const store = new InMemoryWorkflowStore(); await store.create(run());
  const service = new RunLifecycleService({ store, headObserver: { observeHead: async () => "a".repeat(40) }, stateIds: ids });
  const first = await service.cancel({ runId: "run_example01", commandId: "cancel-1" }); const second = await service.cancel({ runId: "run_example01", commandId: "cancel-1" });
  assert.equal(first.state, "cancelled"); assert.equal(second.version, first.version);
});

test("Linear state mapping preserves awaiting-human and never maps approved to completed", () => {
  assert.equal(mapWorkflowStateToLinearStateId("approved", ids), ids.awaitingHuman);
  assert.equal(mapWorkflowStateToLinearStateId("failed", ids), ids.failed);
  assert.notEqual(mapWorkflowStateToLinearStateId("approved", ids), ids.completed);
});

test("expiry uses only the injected trusted clock and persisted deadline", async () => {
  const store = new InMemoryWorkflowStore(); await store.create(run({ timestamps: { createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), expiresAt: new Date(10).toISOString() } })); let now = 9;
  const service = new RunLifecycleService({ store, headObserver: { observeHead: async () => "a".repeat(40) }, stateIds: ids, clock: { now: () => now, sleep: async () => undefined } });
  await assert.rejects(service.expire({ runId: "run_example01", commandId: "expire-1", callerNow: 999_999 }), /deadline/iu);
  now = 11; assert.equal((await service.expire({ runId: "run_example01", commandId: "expire-1", callerNow: 0 })).state, "expired");
});
