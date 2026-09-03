import assert from "node:assert/strict";
import test from "node:test";
import { stat } from "node:fs/promises";
import path from "node:path";
import { GitWorkspaceService } from "../src/git/workspace-service.js";
import { createGitFixture } from "./support/git-fixture.js";

test("concurrent controllers serialize provisioning and converge on one immutable manifest", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const spec = await fixture.service.createSpec(fixture.input);
  const results = await Promise.allSettled([
    fixture.service.provision(fixture.input.runId, spec, "controller-a"),
    fixture.service.provision(fixture.input.runId, spec, "controller-b"),
  ]);
  const successes = results.filter(result => result.status === "fulfilled");
  const failures = results.filter(result => result.status === "rejected");
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  const retry = await fixture.service.provision(fixture.input.runId, spec, "controller-retry");
  assert.equal(retry.manifest.path, "artifacts/git/run_example01/workspace-manifest.json");
  assert.equal((await fixture.store.read(fixture.input.runId))?.preparationLeases?.length, 0);
});

test("cleanup does not bless an unexplained missing resource", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const spec = await fixture.service.createSpec(fixture.input);
  await fixture.service.provision(fixture.input.runId, spec, "cleanup-missing");
  const now = Date.now();
  const policy = { outcome: "success" as const, workspaceRetainUntil: new Date(now + 500).toISOString(), bundleRetainUntil: new Date(now + 500).toISOString() };
  await fixture.service.markRetained(fixture.input.runId, policy, "cleanup-missing-retention");
  await (await import("node:fs/promises")).rm(path.join(fixture.ticketRoot, "workspace"), { recursive: true, force: true });
  const fence = await fixture.store.acquireRunTerminalFence(fixture.input.runId, "cleanup-missing-terminal", Date.now());
  await assert.rejects(() => fixture.service.disposeUnderTerminalFence(fixture.input.runId, fence, { now: now + 1_000, workspaceRetainUntil: policy.workspaceRetainUntil, bundleRetainUntil: policy.bundleRetainUntil }), /neither source|proven/u);
});

test("retention is immutable and fenced disposal is idempotent without completing global teardown", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const spec = await fixture.service.createSpec(fixture.input);
  await fixture.service.provision(fixture.input.runId, spec, "retention");
  const now = Date.now();
  const policy = { outcome: "success" as const, workspaceRetainUntil: new Date(now + 500).toISOString(), bundleRetainUntil: new Date(now + 500).toISOString() };
  await fixture.service.markRetained(fixture.input.runId, policy, "retention");
  assert.deepEqual(await fixture.service.markRetained(fixture.input.runId, policy, "retention-retry"), await fixture.store.read(fixture.input.runId).then(snapshot => snapshot!.gitWorkspace));
  await new Promise(resolve => setTimeout(resolve, 600));
  const fence = await fixture.store.acquireRunTerminalFence(fixture.input.runId, "terminal-owner", Date.now());
  await assert.rejects(() => fixture.service.disposeUnderTerminalFence(fixture.input.runId, { ...fence, fencingToken: fence.fencingToken + 1 }, { now: Date.now() }), /fence/u);
  const disposals = await Promise.all([
    fixture.service.disposeUnderTerminalFence(fixture.input.runId, fence, { now: Date.now(), workspaceRetainUntil: policy.workspaceRetainUntil, bundleRetainUntil: policy.bundleRetainUntil }),
    fixture.service.disposeUnderTerminalFence(fixture.input.runId, fence, { now: Date.now(), workspaceRetainUntil: policy.workspaceRetainUntil, bundleRetainUntil: policy.bundleRetainUntil }),
  ]);
  assert.equal(disposals[0]!.removed.length + disposals[0]!.alreadyAbsent.length, 4);
  assert.equal(disposals[1]!.removed.length + disposals[1]!.alreadyAbsent.length, 4);
  const restarted = new GitWorkspaceService({ store: fixture.store, ticketRoot: fixture.ticketRoot, requirePublishingGates: false });
  const repeated = await restarted.disposeUnderTerminalFence(fixture.input.runId, fence, { now: Date.now(), workspaceRetainUntil: policy.workspaceRetainUntil, bundleRetainUntil: policy.bundleRetainUntil });
  assert.equal(repeated.alreadyAbsent.length, 4);
  assert.equal((await fixture.store.read(fixture.input.runId))?.terminalFence?.state, "held");
  await assert.rejects(() => stat(path.join(fixture.ticketRoot, "workspace")));
});
