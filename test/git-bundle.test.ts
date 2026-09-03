import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGitFixture } from "./support/git-fixture.js";

test("bundle export is single-ref, digest-bound, offline-verified, and idempotent", async t => {
  const fixture = await createGitFixture({ workflowState: "publishing" });
  t.after(fixture.cleanup);
  const spec = await fixture.service.createSpec(fixture.input);
  await fixture.service.provision(fixture.input.runId, spec, "bundle");
  await writeFile(path.join(fixture.ticketRoot, "workspace", "bundle.txt"), "bundle\n");
  const commit = await fixture.service.commit(fixture.input.runId, "bundle head");
  const bundle = await fixture.service.exportBundle(fixture.input.runId, commit.headSha, "publisher");
  const bytes = await readFile(path.join(fixture.ticketRoot, bundle.bundlePath));
  assert.ok(bytes.length > 0);
  const heads = await import("node:child_process").then(({ execFile }) => new Promise<string>((resolve, reject) => execFile("git", ["bundle", "list-heads", path.join(fixture.ticketRoot, bundle.bundlePath)], { env: fixture.sourceEnv }, (error, stdout) => error ? reject(error) : resolve(stdout))));
  assert.equal(heads.trim(), `${commit.headSha} refs/heads/${bundle.featureBranch}`);
  const again = await fixture.service.exportBundle(fixture.input.runId, commit.headSha, "publisher-retry");
  assert.deepEqual(again, bundle);
  const retainedPath = path.join(fixture.ticketRoot, bundle.bundlePath);
  await chmod(retainedPath, 0o600);
  await appendFile(retainedPath, Buffer.from("tampered\n"));
  await chmod(retainedPath, 0o400);
  await assert.rejects(() => fixture.service.verify(fixture.input.runId), /digest|bundle|writable/u);
});

test("terminal disposal preserves a substituted retained bundle", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const spec = await fixture.service.createSpec(fixture.input);
  await fixture.service.provision(fixture.input.runId, spec, "bundle-disposal");
  await writeFile(path.join(fixture.ticketRoot, "workspace", "bundle.txt"), "bundle\n");
  const commit = await fixture.service.commit(fixture.input.runId, "bundle disposal head");
  const bundle = await fixture.service.exportBundle(fixture.input.runId, commit.headSha, "bundle-disposal-export");
  const retainedPath = path.join(fixture.ticketRoot, bundle.bundlePath);
  const originalBytes = await readFile(retainedPath);
  await rename(retainedPath, path.join(fixture.root, "moved-original.bundle"));
  await writeFile(retainedPath, originalBytes, { mode: 0o400 });
  const policy = { outcome: "success" as const, workspaceRetainUntil: new Date(Date.now() + 50).toISOString(), bundleRetainUntil: new Date(Date.now() + 50).toISOString() };
  await fixture.service.markRetained(fixture.input.runId, policy, "bundle-disposal-retention");
  await new Promise(resolve => setTimeout(resolve, 100));
  const fence = await fixture.store.acquireRunTerminalFence(fixture.input.runId, "bundle-disposal-terminal", Date.now());
  await assert.rejects(() => fixture.service.disposeUnderTerminalFence(fixture.input.runId, fence, { now: Date.now(), workspaceRetainUntil: policy.workspaceRetainUntil, bundleRetainUntil: policy.bundleRetainUntil }), /digest|bundle|retained/u);
  await assert.doesNotReject(() => import("node:fs/promises").then(({ stat }) => stat(path.join(fixture.ticketRoot, "workspace"))));
});
