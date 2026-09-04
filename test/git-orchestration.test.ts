import assert from "node:assert/strict";
import test from "node:test";
import { OrchestrationService } from "../src/control/orchestration-service.js";
import { InMemoryWorkflowStore } from "./support/in-memory-workflow-store.js";
import { run, headA } from "./support/fixtures.js";

test("orchestration requires independent Git readiness before preparation and publishing gates", async () => {
  const store = new InMemoryWorkflowStore();
  await store.create(run({ state: "preparing", sessions: { orchestrator: { runId: "run_example01", role: "orchestrator", sessionId: "orch-1", sessionFile: "/ticket/runtime/orch.jsonl", processGeneration: 1, processState: "live", registeredAt: "2026-09-01T00:00:00.000Z" } } }));
  const request = { runId: "run_example01", orchestratorSessionId: "orch-1", fromState: "preparing", toState: "planning", trigger: "preparation_complete", currentHead: headA, phaseResult: null };
  const validator = { validate: async () => ({ document: request }) };
  let calls = 0;
  const readiness = { verify: async (runId: string, expectedHead?: string) => { calls += 1; assert.equal(runId, "run_example01"); assert.equal(expectedHead, headA); return { runId, spec: { path: "artifacts/git/run_example01/workspace-spec.json", sha256: "a".repeat(64), schemaId: "urn:squire:git-workspace:v1:workspace-spec" }, manifest: { path: "artifacts/git/run_example01/workspace-manifest.json", sha256: "b".repeat(64), schemaId: "urn:squire:git-workspace:v1:workspace-manifest" }, featureBranch: "squire/aidev-222-run_example01", headSha: headA, objectFormat: "sha1", paths: { repository: "/ticket/git/repo.git", worktree: "/ticket/workspace", artifactRoot: "artifacts/git/run_example01", controlRoot: "control/git/run_example01" } as const } as const; } };
  const git = { observeHead: async (runId?: string) => { assert.equal(runId, "run_example01"); return headA; } };
  const service = new OrchestrationService(store, git, validator as never, readiness);
  const decision = await service.transition({ path: "artifacts/request.json", sha256: "c".repeat(64), schemaId: "urn:squire:contracts:v1:transition-request" });
  assert.equal(decision.next.state, "planning");
  assert.equal(calls, 1);
});

test("preparation transition fails closed when production composition omits Git readiness", async () => {
  const store = new InMemoryWorkflowStore();
  await store.create(run({ state: "preparing", sessions: { orchestrator: { runId: "run_example01", role: "orchestrator", sessionId: "orch-1", sessionFile: "/ticket/runtime/orch.jsonl", processGeneration: 1, processState: "live", registeredAt: "2026-09-01T00:00:00.000Z" } } }));
  const validator = { validate: async () => ({ document: { runId: "run_example01", orchestratorSessionId: "orch-1", fromState: "preparing", toState: "planning", trigger: "preparation_complete", currentHead: headA, phaseResult: null } }) };
  const service = new OrchestrationService(store, { observeHead: async () => headA }, validator as never);
  await assert.rejects(() => service.transition({ path: "artifacts/request.json", sha256: "c".repeat(64), schemaId: "urn:squire:contracts:v1:transition-request" }), /readiness/u);
});
