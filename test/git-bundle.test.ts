import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, readFile, writeFile } from "node:fs/promises";
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
  await appendFile(path.join(fixture.ticketRoot, bundle.bundlePath), Buffer.from("tampered\n"));
  await assert.rejects(() => fixture.service.verify(fixture.input.runId), /digest|bundle/u);
});
