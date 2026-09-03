import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import type { GitChildProcess, GitReadable } from "../src/git/git-command.js";
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
  const policy = { outcome: "success" as const, workspaceRetainUntil: new Date(now + 50).toISOString(), bundleRetainUntil: new Date(now + 50).toISOString() };
  await fixture.service.markRetained(fixture.input.runId, policy, "cleanup-missing-retention");
  await new Promise(resolve => setTimeout(resolve, 100));
  await (await import("node:fs/promises")).rm(path.join(fixture.ticketRoot, "workspace"), { recursive: true, force: true });
  const fence = await fixture.store.acquireRunTerminalFence(fixture.input.runId, "cleanup-missing-terminal", Date.now());
  await assert.rejects(() => fixture.service.disposeUnderTerminalFence(fixture.input.runId, fence, { now: now + 1_000, workspaceRetainUntil: policy.workspaceRetainUntil, bundleRetainUntil: policy.bundleRetainUntil }), /neither source|proven/u);
});

test("future caller time cannot bypass a persisted retention deadline", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const trustedNow = Date.now();
  const clock = { now: () => trustedNow, sleep: async () => undefined };
  const trustedService = new GitWorkspaceService({ store: fixture.store, ticketRoot: fixture.ticketRoot, clock, requirePublishingGates: false });
  const spec = await fixture.service.createSpec(fixture.input);
  await fixture.service.provision(fixture.input.runId, spec, "trusted-time-provision");
  const policy = { outcome: "success" as const, workspaceRetainUntil: new Date(trustedNow + 3_600_000).toISOString(), bundleRetainUntil: new Date(trustedNow + 3_600_000).toISOString() };
  await trustedService.markRetained(fixture.input.runId, policy, "trusted-time-retention");
  const fence = await fixture.store.acquireRunTerminalFence(fixture.input.runId, "trusted-time-terminal", trustedNow);
  await assert.rejects(() => trustedService.disposeUnderTerminalFence(fixture.input.runId, fence, { now: trustedNow + 7_200_000, workspaceRetainUntil: policy.workspaceRetainUntil, bundleRetainUntil: policy.bundleRetainUntil }), /retention deadline has not elapsed/u);
  await assert.doesNotReject(() => stat(path.join(fixture.ticketRoot, "workspace")));
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

class RecoveryChild extends EventEmitter implements GitChildProcess {
  readonly stdout = new EventEmitter() as GitChildProcess["stdout"];
  readonly stderr = new EventEmitter() as GitChildProcess["stderr"];
  exitCode: number | null;
  exitSignal: string | null = null;
  constructor(readonly identity: string, exited: boolean) { super(); this.exitCode = exited ? 0 : null; }
  kill(signal: "SIGTERM" | "SIGKILL"): boolean { this.exitSignal = signal; this.exitCode = signal === "SIGTERM" ? 143 : 137; this.emit("exit", null, signal); return true; }
  async waitForExit(): Promise<void> { if (this.exitCode === null) this.kill("SIGKILL"); }
  override on(event: "exit", listener: (code: number | null, signal: string | null) => void): this { return super.on(event, listener); }
}

async function seedUnresolvedGitOperation(fixture: Awaited<ReturnType<typeof createGitFixture>>, child: RecoveryChild): Promise<GitWorkspaceService> {
  const spec = await fixture.service.createSpec(fixture.input);
  await fixture.service.provision(fixture.input.runId, spec, "recovery-provision");
  const current = await fixture.store.read(fixture.input.runId);
  assert.ok(current?.gitWorkspace?.stage === "ready");
  const operationId = "recovery-operation";
  const operation = { operationId, owner: `git-operation-${operationId}`, generation: current.gitWorkspace.operationGeneration, step: "fetch" as const, startedAt: new Date().toISOString(), command: { operationId, step: "fetch" as const, state: "spawned" as const, owner: `git-operation-${operationId}`, fencingToken: 9001, processIdentity: child.identity } };
  await fixture.store.compareAndSet(fixture.input.runId, { version: current.version }, snapshot => ({ ...snapshot, version: snapshot.version + 1, gitWorkspace: { ...snapshot.gitWorkspace!, operation } }));
  await fixture.store.acquireRunPreparationLease(fixture.input.runId, `git-operation-${operationId}`, Date.now());
  return new GitWorkspaceService({ store: fixture.store, ticketRoot: fixture.ticketRoot, requirePublishingGates: false, process: { processResolver: { resolve: async identity => identity === child.identity ? child : undefined } } });
}

test("bundle-only disposal retains an authenticated snapshot for later workspace cleanup", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const spec = await fixture.service.createSpec(fixture.input);
  await fixture.service.provision(fixture.input.runId, spec, "split-disposal-provision");
  const now = Date.now();
  const policy = { outcome: "success" as const, workspaceRetainUntil: new Date(now + 50).toISOString(), bundleRetainUntil: new Date(now + 50).toISOString() };
  await fixture.service.markRetained(fixture.input.runId, policy, "split-disposal-retention");
  await new Promise(resolve => setTimeout(resolve, 100));
  const fence = await fixture.store.acquireRunTerminalFence(fixture.input.runId, "split-disposal-terminal", Date.now());
  const first = await fixture.service.disposeUnderTerminalFence(fixture.input.runId, fence, { now: Date.now(), disposeWorkspace: false, disposeBundle: true, workspaceRetainUntil: policy.workspaceRetainUntil, bundleRetainUntil: policy.bundleRetainUntil });
  assert.deepEqual(first.removed, [path.join(fixture.ticketRoot, "artifacts", "git", fixture.input.runId)]);
  const second = await fixture.service.disposeUnderTerminalFence(fixture.input.runId, fence, { now: Date.now(), disposeWorkspace: true, disposeBundle: true, workspaceRetainUntil: policy.workspaceRetainUntil, bundleRetainUntil: policy.bundleRetainUntil });
  assert.equal(second.removed.length + second.alreadyAbsent.length, 4);
});

test("disposal resumes an exact root that was moved before the next controller started", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const spec = await fixture.service.createSpec(fixture.input);
  await fixture.service.provision(fixture.input.runId, spec, "partial-disposal-provision");
  const now = Date.now();
  const policy = { outcome: "success" as const, workspaceRetainUntil: new Date(now + 50).toISOString(), bundleRetainUntil: new Date(now + 50).toISOString() };
  await fixture.service.markRetained(fixture.input.runId, policy, "partial-disposal-retention");
  await new Promise(resolve => setTimeout(resolve, 100));
  const fence = await fixture.store.acquireRunTerminalFence(fixture.input.runId, "partial-disposal-terminal", Date.now());
  const disposal = path.join(fixture.ticketRoot, "control", "git-workspace-disposal", `.git-workspace-disposal-${fixture.input.runId}-${fence.fencingToken}`);
  await mkdir(disposal, { recursive: true, mode: 0o700 });
  await rename(path.join(fixture.ticketRoot, "workspace"), path.join(disposal, "workspace"));
  const result = await fixture.service.disposeUnderTerminalFence(fixture.input.runId, fence, { now: Date.now(), workspaceRetainUntil: policy.workspaceRetainUntil, bundleRetainUntil: policy.bundleRetainUntil });
  assert.equal(result.removed.length + result.alreadyAbsent.length, 4);
  await assert.rejects(() => stat(path.join(fixture.ticketRoot, "workspace")));
});

test("recovery refuses a live or unknown Git child and resumes only after exact observed exit", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const child = new RecoveryChild("git-recovery-child", false);
  const restarted = await seedUnresolvedGitOperation(fixture, child);
  await assert.rejects(() => restarted.recover(fixture.input.runId, "recovery-live"), /live or unknown|unresolved/);
  assert.equal((await fixture.store.read(fixture.input.runId))?.gitWorkspace?.operation?.command?.state, "spawned");
  child.exitCode = 0;
  child.emit("exit", 0, null);
  const recovered = await restarted.recover(fixture.input.runId, "recovery-observed");
  assert.equal(recovered.operation?.command, undefined);
  assert.equal((await fixture.store.read(fixture.input.runId))?.preparationLeases?.length, 0);
});

test("recovery does not release a Git preparation lease when the identity resolver is unknown", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const child = new RecoveryChild("git-unknown-child", true);
  const restarted = await seedUnresolvedGitOperation(fixture, child);
  const unknown = new GitWorkspaceService({ store: fixture.store, ticketRoot: fixture.ticketRoot, requirePublishingGates: false, process: { processResolver: { resolve: async () => undefined } } });
  await assert.rejects(() => unknown.recover(fixture.input.runId, "recovery-unknown"), /live or unknown|unresolved/);
  assert.equal((await fixture.store.read(fixture.input.runId))?.preparationLeases?.length, 1);
  void restarted;
});
