import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { createGitFixture } from "./support/git-fixture.js";

const exec = promisify(execFile);

test("pre-existing unowned Git paths are never adopted", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const spec = await fixture.service.createSpec(fixture.input);
  await mkdir(path.join(fixture.ticketRoot, "git"), { recursive: true, mode: 0o700 });
  await mkdir(path.join(fixture.ticketRoot, "git", "repo.git"), { mode: 0o700 });
  await assert.rejects(() => fixture.service.provision(fixture.input.runId, spec, "unowned"), /unowned Git workspace path/u);
});

test("provisioning creates one isolated bare repository and one linked worktree", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const spec = await fixture.service.createSpec(fixture.input);
  const ready = await fixture.service.provision(fixture.input.runId, spec, "workspace-test");
  assert.equal(ready.featureBranch, "squire/aidev-222-run_example01");
  assert.equal(ready.headSha, fixture.input.baseSha);
  assert.equal(ready.objectFormat, "sha1");
  assert.equal(ready.paths.worktree, "/ticket/workspace");
  const list = await exec("git", ["--git-dir", path.join(fixture.ticketRoot, "git/repo.git"), "worktree", "list", "--porcelain"], { env: fixture.sourceEnv });
  assert.equal((list.stdout.match(/^worktree /gmu) ?? []).length, 2); // bare entry plus the one linked worktree
  assert.match(list.stdout, /branch refs\/heads\/squire\/aidev-222-run_example01/u);
  const manifest = JSON.parse(await readFile(path.join(fixture.ticketRoot, ready.manifest.path), "utf8")) as { objectDirectory: string; alternates: null; worktreeCount: number };
  assert.equal(manifest.objectDirectory, "/ticket/git/repo.git/objects");
  assert.equal(manifest.alternates, null);
  assert.equal(manifest.worktreeCount, 1);
  const second = await fixture.service.provision(fixture.input.runId, spec, "workspace-test-retry");
  assert.deepEqual(second.manifest, ready.manifest);
});

test("provisioning preserves the declared SHA-1 or SHA-256 object format", async t => {
  for (const objectFormat of ["sha1", "sha256"] as const) {
    const fixture = await createGitFixture({ objectFormat });
    t.after(fixture.cleanup);
    const spec = await fixture.service.createSpec(fixture.input);
    const ready = await fixture.service.provision(fixture.input.runId, spec, `format-${objectFormat}`);
    assert.equal(ready.objectFormat, objectFormat);
    assert.equal(ready.headSha.length, objectFormat === "sha1" ? 40 : 64);
  }
});

test("status and commit remain offline and advance only the feature branch", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const spec = await fixture.service.createSpec(fixture.input);
  await fixture.service.provision(fixture.input.runId, spec, "offline");
  await rename(fixture.source, `${fixture.source}.offline`);
  await writeFile(path.join(fixture.ticketRoot, "workspace", "offline.txt"), "offline\n");
  const dirty = await fixture.service.offlineStatus(fixture.input.runId);
  assert.match(dirty.porcelain, /offline\.txt/u);
  const committed = await fixture.service.commit(fixture.input.runId, "offline commit");
  assert.equal(committed.headSha.length, 40);
  assert.match(committed.output, /offline commit/u);
  const clean = await fixture.service.status(fixture.input.runId);
  assert.equal(clean.porcelain, "");
  assert.equal((await fixture.service.verify(fixture.input.runId, committed.headSha)).headSha, committed.headSha);
  assert.equal((await fixture.store.read(fixture.input.runId))?.gitWorkspace?.operation, undefined);
  assert.equal((await fixture.store.read(fixture.input.runId))?.preparationLeases?.length, 0);
});

test("source hooks, attributes, and submodules remain untrusted data", async t => {
  const hookSentinel = "/tmp/squire-source-hook-sentinel";
  const filterSentinel = "/tmp/squire-filter-sentinel";
  await rm(hookSentinel, { force: true });
  await rm(filterSentinel, { force: true });
  const fixture = await createGitFixture({ maliciousSourceMetadata: true });
  t.after(async () => { await fixture.cleanup(); await rm(hookSentinel, { force: true }); await rm(filterSentinel, { force: true }); });
  const spec = await fixture.service.createSpec(fixture.input);
  await fixture.service.provision(fixture.input.runId, spec, "untrusted-source");
  await writeFile(path.join(fixture.ticketRoot, "workspace", "filtered.txt"), "untrusted\n");
  await fixture.service.commit(fixture.input.runId, "untrusted data commit");
  await assert.rejects(() => import("node:fs/promises").then(fs => fs.access(hookSentinel)));
  await assert.rejects(() => import("node:fs/promises").then(fs => fs.access(filterSentinel)));
  const status = await fixture.service.status(fixture.input.runId);
  assert.equal(status.porcelain, "");
});

test("branch switching, extra worktrees, and hardlinked config are not adopted", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const spec = await fixture.service.createSpec(fixture.input);
  await fixture.service.provision(fixture.input.runId, spec, "substitution");
  const config = path.join(fixture.ticketRoot, "git/repo.git/config");
  await link(config, `${config}.hardlink`);
  await assert.rejects(() => fixture.service.verify(fixture.input.runId), /hardlinked|link/u);
  const second = await createGitFixture();
  t.after(second.cleanup);
  const secondSpec = await second.service.createSpec(second.input);
  await second.service.provision(second.input.runId, secondSpec, "extra-worktree");
  await exec("git", ["--git-dir", path.join(second.ticketRoot, "git/repo.git"), "worktree", "add", "--detach", path.join(second.root, "extra-worktree"), second.input.baseSha], { env: second.sourceEnv });
  await assert.rejects(() => second.service.verify(second.input.runId), /exactly one linked worktree/u);
});

test("config and worktree substitutions fail closed", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const spec = await fixture.service.createSpec(fixture.input);
  await fixture.service.provision(fixture.input.runId, spec, "tamper");
  await exec("git", ["--git-dir", path.join(fixture.ticketRoot, "git/repo.git"), "config", "--file", path.join(fixture.ticketRoot, "git/repo.git/config"), "--replace-all", "alias.evil", "!touch /tmp/squire-sentinel"], { env: fixture.sourceEnv });
  await assert.rejects(() => fixture.service.verify(fixture.input.runId), /config/u);
});
