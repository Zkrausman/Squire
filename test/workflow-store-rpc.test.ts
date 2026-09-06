import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { InMemoryWorkflowStore } from "./support/in-memory-workflow-store.js";
import { createWorkflowStoreRpcMediator, WorkflowStoreRpcError, WorkflowStoreRpcServer } from "../src/sandbox/workflow-store-rpc.js";
import { encodeGuestFrame, makeGuestRequest, parseGuestMessage, type GuestBinding, type GuestOperationResponse } from "../src/sandbox/guest-protocol.js";
import { deriveSandboxName } from "../src/sandbox/identity.js";
import { run } from "./support/fixtures.js";

const binding: GuestBinding = {
  runId: "run_example01",
  sandboxName: deriveSandboxName("run_example01"),
  sandboxId: "sandbox-1",
  bootId: "boot-1",
  operationGeneration: 1,
  releaseId: "fixture-release",
  helperDigest: "f".repeat(64),
};

/** A deterministic worker seam that models the guest helper issuing a reverse
 * workflow-store request while it is servicing the controller request. */
class ReverseWorkflowWorker extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly exitCode: number | null = null;
  readonly stdin = { write: (frame: Uint8Array | string): boolean => this.receive(frame) };
  readonly identity = "host-child:1:1:" + "a".repeat(64);
  readonly pid = 1;
  readonly startTime = "1";
  readonly executable = "/ticket/runtime/sbx";
  readonly executableDigest = "a".repeat(64);
  #pending = new Map<string, { readonly requestId: string; readonly binding: GuestBinding; readonly operation: "workflow-store" }>();

  kill(): boolean { return true; }
  waitForExit(): Promise<void> { return Promise.resolve(); }

  private receive(frame: Uint8Array | string): boolean {
    const message = parseGuestMessage(Buffer.from(frame).subarray(4));
    if (message.kind === "squire-guest-operation-request") {
      assert.equal(message.operation, "workflow-store");
      const nested = makeGuestRequest(binding, "workflow-store", message.payload);
      this.#pending.set(nested.requestId, { requestId: message.requestId, binding: message.binding, operation: message.operation });
      queueMicrotask(() => this.stdout.emit("data", encodeGuestFrame(nested)));
      return true;
    }
    const pending = this.#pending.get(message.requestId);
    if (!pending) throw new Error("fake guest received an unknown reverse response");
    this.#pending.delete(message.requestId);
    const response: GuestOperationResponse = message.success
      ? { schemaVersion: 1, kind: "squire-guest-operation-response", requestId: pending.requestId, binding: pending.binding, operation: pending.operation, success: true, ...(Object.hasOwn(message, "data") ? { data: message.data } : {}) }
      : { schemaVersion: 1, kind: "squire-guest-operation-response", requestId: pending.requestId, binding: pending.binding, operation: pending.operation, success: false, error: message.error! };
    queueMicrotask(() => this.stdout.emit("data", encodeGuestFrame(response)));
    return true;
  }
}

test("workflow-store mediator routes only a bound reverse request to the narrow host authority", async () => {
  const store = new InMemoryWorkflowStore();
  await store.create(run());
  const worker = new ReverseWorkflowWorker();
  const mediator = createWorkflowStoreRpcMediator(worker, store, binding, { operationTimeoutMs: 500 });
  assert.deepEqual(await mediator.client.read(), { runId: "run_example01", version: 0, state: "accepted", currentHead: "a".repeat(40), implementGeneration: 0 });
  await mediator.client.assertRunStartAllowed(123);
  mediator.close();
});

test("workflow-store RPC rejects generic methods, malformed arguments, and substituted bindings", async () => {
  const store = new InMemoryWorkflowStore();
  await store.create(run());
  const server = new WorkflowStoreRpcServer(store, binding);
  const request = makeGuestRequest(binding, "workflow-store", { method: "read", args: {} });
  assert.deepEqual(await server.handle(request), { runId: "run_example01", version: 0, state: "accepted", currentHead: "a".repeat(40), implementGeneration: 0 });
  await assert.rejects(() => server.handle(makeGuestRequest(binding, "workflow-store", { method: "compareAndSet", args: {} })), WorkflowStoreRpcError);
  await assert.rejects(() => server.handle(makeGuestRequest(binding, "workflow-store", { method: "read", args: { now: 1 } })), /arguments are not closed/);
  await assert.rejects(() => server.handle({ ...request, binding: { ...binding, sandboxId: "other-sandbox" } }), /identity or operation binding/);
});
