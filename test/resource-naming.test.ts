import assert from "node:assert/strict";
import test from "node:test";
import { deriveContractFeatureBranch, derivePhysicalFeatureBranch, deriveRunId, deriveSandboxName, deriveHerdrWorkspaceName, assertMatchingBranches } from "../src/index.js";

test("resource naming is deterministic, bounded, and independent of free-text titles", () => {
  const issue = "11111111-1111-4111-8111-111111111111"; const repository = { owner: "example", name: "service" };
  const run = deriveRunId(issue, repository, "key");
  assert.equal(run, deriveRunId(issue, repository, "key"));
  assert.notEqual(run, deriveRunId(issue, repository, "other-key"));
  const contract = deriveContractFeatureBranch("AIDEV-215", run); const physical = derivePhysicalFeatureBranch("AIDEV-215", run);
  assertMatchingBranches("AIDEV-215", run, contract, physical); assert.notEqual(contract, physical);
  assert.ok(deriveSandboxName({ ticketIdentifier: "AIDEV-215", runId: run }).length <= 63);
  assert.ok(deriveHerdrWorkspaceName({ ticketIdentifier: "AIDEV-215", runId: run }).length <= 63);
});
