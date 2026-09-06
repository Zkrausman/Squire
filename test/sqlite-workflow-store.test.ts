import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SqliteDatabase, SqliteWorkflowStore, StoreConflictError } from "../src/index.js";
import { run, runtime } from "./support/fixtures.js";

const execFileAsync = promisify(execFile);
async function tempDb(): Promise<{ root: string; file: string }> { const root = await mkdtemp(path.join(tmpdir(), "squire-ledger-")); await chmod(root, 0o700); return { root, file: path.join(root, "workflow.db") }; }

test("SQLite WorkflowStore round-trips lossless snapshot state across a real file restart", async () => {
  const { root, file } = await tempDb();
  try {
    const firstDb = new SqliteDatabase(file);
    const first = new SqliteWorkflowStore(firstDb);
    const initial = run({ runtimeResolution: runtime, sessions: { plan: { runId: "run_example01", role: "plan", sessionId: "plan-1", sessionFile: "/ticket/sessions/plan/one_plan-1.jsonl", processGeneration: 1, processState: "exited", processIdentity: "proc-1", registeredAt: "2026-09-01T00:00:00Z" } } });
    await first.create(initial);
    const lease = await first.acquireLease(initial.runId, "dispatch", "owner-a", 10, 100);
    assert.equal(lease?.fencingToken, 1);
    const changed = await first.compareAndSet(initial.runId, { version: 0 }, current => ({ ...current, version: current.version + 1, processLaunches: 1, committedRequestIds: ["request-1"] }));
    assert.equal(changed.version, 1);
    await assert.rejects(first.compareAndSet(initial.runId, { version: 0 }, current => ({ ...current, version: current.version + 1 })), StoreConflictError);
    firstDb.close();
    const child = await execFileAsync(process.execPath, ["--input-type=module", "-e", `import { SqliteDatabase, SqliteWorkflowStore } from './dist/src/index.js'; const db = new SqliteDatabase(${JSON.stringify(file)}); const store = new SqliteWorkflowStore(db); const value = await store.read('run_example01'); if (value?.runId !== 'run_example01' || value.processLaunches !== 1) process.exit(7); db.close();`], { cwd: process.cwd(), maxBuffer: 1024 * 1024 });
    assert.equal(child.stderr, "");

    const restartedDb = new SqliteDatabase(file);
    const restarted = new SqliteWorkflowStore(restartedDb);
    const restored = await restarted.read(initial.runId);
    assert.deepEqual(restored?.runtimeResolution, runtime);
    assert.equal(restored?.sessions.plan?.sessionFile, initial.sessions.plan?.sessionFile);
    assert.equal(restored?.processLaunches, 1);
    assert.deepEqual(restored?.committedRequestIds, ["request-1"]);
    const takeover = await restarted.acquireLease(initial.runId, "dispatch", "owner-b", 111, 100);
    assert.equal(takeover?.fencingToken, 2);
    restartedDb.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SQLite fencing and terminal quiescence preserve exact ownership and monotonic tokens", async () => {
  const { root, file } = await tempDb();
  try {
    const db = new SqliteDatabase(file); const store = new SqliteWorkflowStore(db); await store.create(run());
    const first = await store.acquireLease("run_example01", "work", "one", 0, 10); assert.ok(first);
    assert.equal(await store.acquireLease("run_example01", "work", "two", 1, 10), undefined);
    const second = await store.acquireLease("run_example01", "work", "two", 11, 10); assert.equal(second?.fencingToken, 2);
    await assert.rejects(store.compareAndSetFenced("run_example01", { version: 0 }, { key: "work", owner: "one", fencingToken: first!.fencingToken, now: 11 }, current => ({ ...current, version: current.version + 1 })), /fencing/iu);
    await store.releaseLease("run_example01", "work", "two", second!.fencingToken);
    const preparation = await store.acquireRunPreparationLease("run_example01", "prep", 20);
    await assert.rejects(store.acquireRunTerminalFence("run_example01", "fence", 21), /preparation lease/iu);
    await store.releaseRunPreparationLease("run_example01", preparation, 22);
    const fence = await store.acquireRunTerminalFence("run_example01", "fence", 23);
    await store.assertRunTeardownQuiescent("run_example01", fence, 24);
    await store.completeRunTeardown("run_example01", fence, 25);
    await assert.rejects(store.assertRunStartAllowed("run_example01"), /removed|terminal fence/iu);
    db.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
