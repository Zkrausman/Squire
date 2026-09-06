import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HmacLinearWebhookVerifier, LinearWebhookHandler, SqliteIntakeStore } from "../src/index.js";

test("webhook authenticates raw bytes before parsing and deduplicates exact deliveries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "squire-webhook-")); await chmod(root, 0o700);
  const store = new SqliteIntakeStore(path.join(root, "controller.db")); const secret = "secret-value"; const raw = Buffer.from(JSON.stringify({ action: "update", data: { id: "11111111-1111-4111-8111-111111111111", identifier: "AIDEV-215" } })); const timestamp = String(Date.now()); const signature = createHmac("sha256", secret).update(raw).digest("hex"); let calls = 0;
  const handler = new LinearWebhookHandler({ verifier: new HmacLinearWebhookVerifier(secret), store, intake: { accept: async (request: any) => { calls += 1; assert.equal(request.issueId, "11111111-1111-4111-8111-111111111111"); return { runId: "run_webhook", snapshot: {} as any, artifact: {} as any, created: true }; } } as any, requestForIssue: (issueId, identifier, deliveryId) => ({ issueId, expectedIdentifier: identifier ?? "AIDEV-215", workflowConfig: {} as any, idempotencyKey: "stable-webhook-key" }), owner: "webhook-test" });
  try {
    const first = await handler.handle(raw, { "linear-delivery": "delivery-1", "linear-signature": signature, "linear-timestamp": timestamp }); assert.equal(first.status, "applied");
    const second = await handler.handle(raw, { deliveryId: "delivery-1", signature, timestamp }); assert.equal(second.duplicate, true); assert.equal(calls, 1);
    await assert.rejects(handler.handle(Buffer.from("not-json"), { deliveryId: "delivery-2", signature, timestamp }), /signature/iu);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
