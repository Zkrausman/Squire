import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createGitFixture } from "./support/git-fixture.js";


test("Git workspace lifecycle leaves AIDEV-228 runtime/footer state untouched", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const runtimeRoot = path.join(fixture.ticketRoot, "runtime", fixture.input.runId);
  const footer = path.join(runtimeRoot, "pi-agent", "trusted-footer.js");
  const homeMarker = path.join(runtimeRoot, "home", "marker");
  await mkdir(path.dirname(footer), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(homeMarker), { recursive: true, mode: 0o700 });
  await writeFile(footer, "footer-v1\n");
  await writeFile(homeMarker, "home-v1\n");
  await writeFile(path.join(fixture.source, ".pi-project-settings"), "AIDEV-228 project state\n");
  const spec = await fixture.service.createSpec(fixture.input);
  await fixture.service.provision(fixture.input.runId, spec, "integration");
  assert.equal(await readFile(footer, "utf8"), "footer-v1\n");
  assert.equal(await readFile(homeMarker, "utf8"), "home-v1\n");
  assert.equal(await readFile(path.join(fixture.source, ".pi-project-settings"), "utf8"), "AIDEV-228 project state\n");
  const policy = { outcome: "success" as const, workspaceRetainUntil: new Date(Date.now() + 500).toISOString(), bundleRetainUntil: new Date(Date.now() + 500).toISOString() };
  await fixture.service.markRetained(fixture.input.runId, policy, "integration-retention");
  await new Promise(resolve => setTimeout(resolve, 600));
  const fence = await fixture.store.acquireRunTerminalFence(fixture.input.runId, "integration-terminal", Date.now());
  await fixture.service.disposeUnderTerminalFence(fixture.input.runId, fence, { now: Date.now(), workspaceRetainUntil: policy.workspaceRetainUntil, bundleRetainUntil: policy.bundleRetainUntil });
  assert.equal(await readFile(footer, "utf8"), "footer-v1\n");
  assert.equal(await readFile(homeMarker, "utf8"), "home-v1\n");
});
