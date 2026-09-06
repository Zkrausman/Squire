import assert from "node:assert/strict";
import { readFile, mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FileNormalizedTicketArtifactWriter, SqliteIntakeStore, SingleTicketIntakeService, ActiveRunConflictError, deriveContractFeatureBranch, derivePhysicalFeatureBranch } from "../src/index.js";

async function setup(): Promise<{ root: string; config: any; service: SingleTicketIntakeService; ledger: SqliteIntakeStore; issue: any }> {
  const root = await mkdtemp(path.join(tmpdir(), "squire-intake-")); await chmod(root, 0o700);
  const config = JSON.parse(await readFile("fixtures/contracts/valid/workflow-config/basic.json", "utf8"));
  const issue = { id: config.ticket.issueId, identifier: config.ticket.identifier, teamId: config.linear.teamId, stateId: config.linear.states.accepted, title: "Unicode ✓ title", description: "safe prose", acceptanceCriteria: ["run tests"], labels: [{ name: "z-label" }, { name: "a-label" }], url: "https://linear.app/example/issue/AIDEV-215/title" };
  const ledger = new SqliteIntakeStore(path.join(root, "controller.db"));
  const service = new SingleTicketIntakeService({ linear: { fetchIssue: async id => { assert.equal(id, issue.id); return issue; } }, baseResolver: { resolve: async repository => ({ baseSha: "a".repeat(40), objectFormat: repository.objectFormat }) }, store: ledger, artifactWriter: new FileNormalizedTicketArtifactWriter(root) });
  return { root, config, service, ledger, issue };
}

test("single-ticket intake publishes one immutable artifact, one lock, and both deterministic branch projections", async () => {
  const { root, config, service, ledger, issue } = await setup();
  try {
    const request = { issueId: issue.id, expectedIdentifier: issue.identifier, workflowConfig: config, idempotencyKey: "delivery-1" };
    const [first, replay] = await Promise.all([service.accept(request), service.accept(request)]);
    assert.equal(first.runId, replay.runId); assert.equal(first.created || replay.created, true);
    assert.equal(first.snapshot.identity?.contractFeatureBranch, deriveContractFeatureBranch(issue.identifier, first.runId));
    assert.equal(first.snapshot.identity?.physicalFeatureBranch, derivePhysicalFeatureBranch(issue.identifier, first.runId));
    assert.equal(ledger.listResources(first.runId).length, 0);
    assert.equal((await ledger.workflow.read(first.runId))?.identity?.normalizedTicket.sha256, first.artifact.sha256);
  } finally { ledger.close(); await rm(root, { recursive: true, force: true }); }
});

test("a second idempotency key cannot create a second active run for the same Linear issue", async () => {
  const { root, config, service, ledger, issue } = await setup();
  try {
    await service.accept({ issueId: issue.id, expectedIdentifier: issue.identifier, workflowConfig: config, idempotencyKey: "first" });
    await assert.rejects(service.accept({ issueId: issue.id, expectedIdentifier: issue.identifier, workflowConfig: config, idempotencyKey: "second" }), ActiveRunConflictError);
  } finally { ledger.close(); await rm(root, { recursive: true, force: true }); }
});
