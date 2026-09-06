import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { V1ArtifactValidator } from "../src/contracts/v1-artifact-validator.js";
import { SafeArtifactReader } from "../src/control/safe-artifact-reader.js";
import type { GitWorkspaceStatus, ReadyGitWorkspace } from "../src/git/domain.js";
import { PlanArtifactPublisher } from "../src/plan/plan-artifact-publisher.js";
import { PlanInputValidator } from "../src/plan/plan-input-validator.js";
import { PlanSessionService } from "../src/plan/plan-session.js";
import type { PiRunner } from "../src/pi/pi-runner.js";
import { InMemoryWorkflowStore } from "./support/in-memory-workflow-store.js";
import { createPlanFixture } from "./support/plan-fixtures.js";

const planSubmission = {
  disposition: "pass" as const,
  plan: {
    schemaVersion: 1 as const,
    runId: "run_planfixture01",
    ticketIdentifier: "AIDEV-218",
    inputHead: "a".repeat(40),
    summary: "Implement the generic Plan protocol.",
    assumptions: ["The controller owns the workspace identity."],
    steps: [{ id: "step-1", description: "Add the Plan protocol.", affectedPaths: ["src/plan/plan-session.ts"], acceptanceCriteria: ["The Plan validation suite passes."] }],
    risks: [{ risk: "A stale head could invalidate the result.", mitigation: "Recheck readiness before acceptance." }],
    validationCommandIds: ["contracts", "tests"],
  },
  questions: [],
};

 test("Plan recovery discovers a complete result before relaunch and accepts it once", async () => {
  const fixture = await createPlanFixture();
  try {
    const store = new InMemoryWorkflowStore();
    await store.create(fixture.snapshot);
    const artifactValidator = await V1ArtifactValidator.create(new SafeArtifactReader(fixture.ticketRoot), "contracts/v1");
    await new PlanArtifactPublisher({ ticketRoot: fixture.ticketRoot, validator: artifactValidator }).publish(planSubmission, fixture.publicationContext);
    const inputValidator = PlanInputValidator.fromValidator(artifactValidator);
    let launches = 0;
    const pi = fixture.configurationDocument["pi"] as Record<string, unknown>;
    const roles = pi["roles"] as Record<string, Record<string, unknown>>;
    const runner = {
      config: { roles: { plan: roles["plan"] } },
      validateRegistration: async () => undefined,
      live: new Map(),
      launch: async () => { launches += 1; throw new Error("recovery must not relaunch after complete result"); },
    } as unknown as PiRunner;
    const workspace = {
      verify: async (runId: string, expectedHead?: string): Promise<ReadyGitWorkspace> => ({ ...fixture.ready, runId, headSha: expectedHead ?? fixture.ready.headSha }),
      status: async (runId: string): Promise<GitWorkspaceStatus> => ({ runId, headSha: fixture.ready.headSha, porcelain: "" }),
    };
    const service = new PlanSessionService({ store, runner, workspace, inputValidator, artifactValidator, clock: { now: () => Date.parse("2026-09-01T12:14:00.000Z"), sleep: async () => undefined }, ticketRoot: fixture.ticketRoot });
    assert.equal(await service.execute(fixture.snapshot.runId, fixture.snapshot.attempts[0]!.handoffId, fixture.triggerPath, "recovery-controller"), "result_accepted");
    assert.equal(launches, 0);
    const after = await store.read(fixture.snapshot.runId);
    assert.equal(after?.attempts[0]?.dispatch.state, "result_accepted");
    assert.deepEqual(after?.acceptedResultPaths, ["artifacts/plan/1/result.json"]);
    assert.equal(after?.attempts[0]?.accepted?.implementGeneration, 0);
    assert.equal(after?.state, "planning");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});
