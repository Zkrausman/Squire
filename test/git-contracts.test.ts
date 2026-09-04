import assert from "node:assert/strict";
import test from "node:test";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { createGitFixture } from "./support/git-fixture.js";
import { GitWorkspaceContractError, GitWorkspaceContractValidator, serializeCanonical } from "../src/git/contracts.js";

test("Git workspace contracts are canonical, closed, and independently digest validated", async t => {
  const fixture = await createGitFixture();
  t.after(fixture.cleanup);
  const specReference = await fixture.service.createSpec(fixture.input);
  const validator = await GitWorkspaceContractValidator.forTicketRoot(fixture.ticketRoot);
  const spec = await validator.validateSpec(specReference, { runId: fixture.input.runId });
  assert.deepEqual(spec.bytes, serializeCanonical(spec.document));
  assert.equal(spec.document.featureBranch, "squire/aidev-222-run_example01");
  assert.throws(() => validator.validateDocument("urn:squire:git-workspace:v1:workspace-spec" as never, { ...spec.document, unexpected: true }), GitWorkspaceContractError);
  const ready = await fixture.service.provision(fixture.input.runId, specReference, "contracts");
  const manifest = await validator.validateManifest(ready.manifest, { spec: specReference, runId: fixture.input.runId, specFingerprint: spec.document.fingerprint });
  assert.equal(manifest.document.resources.alternates, null);
  assert.equal(manifest.document.worktreeCount, 1);
  const manifestPath = `${fixture.ticketRoot}/${ready.manifest.path}`;
  await link(manifestPath, `${manifestPath}.hardlink`);
  await assert.rejects(() => validator.validateManifest(ready.manifest), /hardlinked/u);
  const original = await readFile(manifestPath);
  await unlink(`${manifestPath}.hardlink`);
  await writeFile(manifestPath, Buffer.from(original.toString("utf8").replace("\"worktreeCount\":1", "\"worktreeCount\":2")));
  await assert.rejects(() => validator.validateManifest(ready.manifest), /digest mismatch/);
});

test("workspace spec creation never changes the published normalized-ticket contract", async () => {
  const source = await readFile("contracts/v1/normalized-ticket.schema.json", "utf8");
  const fixture = await createGitFixture();
  try {
    await fixture.service.createSpec(fixture.input);
    assert.equal(await readFile("contracts/v1/normalized-ticket.schema.json", "utf8"), source);
  } finally { await fixture.cleanup(); }
});
