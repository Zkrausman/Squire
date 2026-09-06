import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteIntakeStore, StartupReconciler } from "../src/index.js";

const providers = (incomplete?: string) => Object.fromEntries(["linear", "sandbox", "herdr", "process", "git", "github"].map(provider => [provider, { provider, observe: async () => incomplete === provider ? { provider, complete: false, observedAt: new Date().toISOString(), error: "provider unavailable" } : { provider, complete: true, observationToken: `${provider}-stable`, observedAt: new Date().toISOString(), digest: "a".repeat(64), items: [] } }])) as any;
async function ledger(): Promise<{ root: string; value: SqliteIntakeStore }> { const root = await mkdtemp(path.join(tmpdir(), "squire-reconcile-")); await chmod(root, 0o700); return { root, value: new SqliteIntakeStore(path.join(root, "controller.db")) }; }

test("startup gate remains closed until all six complete inventories are persisted", async () => {
  const { root, value } = await ledger(); try { const reconciler = new StartupReconciler({ ledger: value, providers: providers("herdr"), controllerOwner: "controller-a" }); const result = await reconciler.reconcile(); assert.equal(result.status, "blocked"); assert.equal(reconciler.gate.ready, false); } finally { value.close(); await rm(root, { recursive: true, force: true }); }
});

test("a transient incomplete inventory does not permanently poison a later complete startup", async () => {
  const { root, value } = await ledger(); let incomplete = true; const p = providers(); const original = p.herdr.observe; p.herdr.observe = async (...args: any[]) => incomplete ? { provider: "herdr", complete: false, observedAt: new Date().toISOString(), error: "temporary outage" } : original(...args);
  try { const reconciler = new StartupReconciler({ ledger: value, providers: p, controllerOwner: "controller-a" }); assert.equal((await reconciler.reconcile()).status, "blocked"); incomplete = false; assert.equal((await reconciler.reconcile()).status, "ready"); } finally { value.close(); await rm(root, { recursive: true, force: true }); }
});

test("complete two-pass startup reconciliation issues an opaque permit and never calls provider recovery early", async () => {
  const { root, value } = await ledger(); let observations = 0; let recovery = 0; const p = providers(); for (const provider of Object.values(p) as any[]) { const observe = provider.observe; provider.observe = async (...args: any[]) => { observations += 1; return observe(...args); }; provider.recover = async () => { recovery += 1; }; }
  try { const reconciler = new StartupReconciler({ ledger: value, providers: p, controllerOwner: "controller-a" }); const result = await reconciler.reconcile(); assert.equal(result.status, "ready"); assert.equal(observations, 12); assert.equal(recovery, 6); assert.equal(result.permits.length, 0); } finally { value.close(); await rm(root, { recursive: true, force: true }); }
});
