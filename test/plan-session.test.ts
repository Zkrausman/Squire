import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { V1ArtifactValidator } from "../src/contracts/v1-artifact-validator.js";
import type { SessionRegistration } from "../src/control/domain.js";
import { SafeArtifactReader } from "../src/control/safe-artifact-reader.js";
import type { GitWorkspaceStatus, ReadyGitWorkspace } from "../src/git/domain.js";
import { PlanArtifactPublisher } from "../src/plan/plan-artifact-publisher.js";
import { PlanInputValidator } from "../src/plan/plan-input-validator.js";
import { PlanSessionError, PlanSessionService } from "../src/plan/plan-session.js";
import type { PlanSubmission } from "../src/plan/domain.js";
import type { PiRunner } from "../src/pi/pi-runner.js";
import { validateSessionRegistration } from "../src/pi/session-registry.js";
import { InMemoryWorkflowStore } from "./support/in-memory-workflow-store.js";
import { createPlanFixture } from "./support/plan-fixtures.js";

const clock = { now: () => Date.parse("2026-09-01T12:14:00.000Z"), sleep: async () => undefined };

function submission(): PlanSubmission {
  return {
    disposition: "pass",
    plan: {
      schemaVersion: 1,
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
}

async function setup() {
  const fixture = await createPlanFixture();
  const store = new InMemoryWorkflowStore();
  await store.create(fixture.snapshot);
  const artifactValidator = await V1ArtifactValidator.create(new SafeArtifactReader(fixture.ticketRoot), "contracts/v1");
  const inputValidator = PlanInputValidator.fromValidator(artifactValidator);
  const pi = fixture.configurationDocument["pi"] as Record<string, unknown>;
  const planRole = pi["roles"] as Record<string, Record<string, unknown>>;
  const planProfile = planRole["plan"]!;
  const runner = { config: { roles: { plan: planProfile } }, validateRegistration: async (registration: SessionRegistration) => validateSessionRegistration(registration, path.join(fixture.root, "sessions")) } as unknown as PiRunner;
  let verifyCalls = 0;
  let statusCalls = 0;
  let dirty = false;
  let changedAtVerify: number | undefined;
  const workspace = {
    verify: async (runId: string, expectedHead?: string): Promise<ReadyGitWorkspace> => {
      verifyCalls += 1;
      if (changedAtVerify !== undefined && verifyCalls >= changedAtVerify) return { ...fixture.ready, headSha: "b".repeat(40) };
      if (expectedHead !== undefined && expectedHead !== fixture.ready.headSha) throw new Error("unexpected expected head");
      return { ...fixture.ready };
    },
    status: async (runId: string): Promise<GitWorkspaceStatus> => {
      statusCalls += 1;
      return { runId, headSha: fixture.ready.headSha, porcelain: dirty ? "1 M source.ts" : "" };
    },
  };
  const service = new PlanSessionService({ store, runner, workspace, inputValidator, artifactValidator, clock, ticketRoot: fixture.ticketRoot, maxLaunches: 2, maxRecoveryPrompts: 1 });
  return { fixture, store, artifactValidator, service, workspaceState: { get verifyCalls() { return verifyCalls; }, get statusCalls() { return statusCalls; }, set dirty(value: boolean) { dirty = value; }, set changedAtVerify(value: number | undefined) { changedAtVerify = value; } } };
}

test("Plan session accepts only the exact persisted result through existing acceptance authority", async () => {
  const setupResult = await setup();
  try {
    const { fixture, store, artifactValidator, service, workspaceState } = setupResult;
    await new PlanArtifactPublisher({ ticketRoot: fixture.ticketRoot, validator: artifactValidator }).publish(submission(), fixture.publicationContext);
    const outcome = await service.execute(fixture.snapshot.runId, fixture.snapshot.attempts[0]!.handoffId, fixture.triggerPath, "plan-controller");
    assert.equal(outcome, "result_accepted");
    const persisted = await store.read(fixture.snapshot.runId);
    assert.equal(persisted?.currentHead, fixture.snapshot.currentHead);
    assert.equal(persisted?.implementGeneration, fixture.snapshot.implementGeneration);
    assert.equal(persisted?.attempts[0]?.accepted?.status, "pass");
    assert.deepEqual(persisted?.acceptedResultPaths, ["artifacts/plan/1/result.json"]);
    assert.equal(workspaceState.statusCalls > 0, true);
  } finally { await rm(setupResult.fixture.root, { recursive: true, force: true }); }
});

test("Plan session preserves blocked context as an accepted v1 failed result", async () => {
  const setupResult = await setup();
  try {
    const { fixture, store, artifactValidator, service } = setupResult;
    const blocked: PlanSubmission = {
      disposition: "blocked",
      plan: { ...submission().plan, summary: "Blocked: implementation must not start until the base identity is repaired.", assumptions: ["The base reference is unknown."] },
      questions: ["Which exact base SHA should the controller bind?"],
    };
    await new PlanArtifactPublisher({ ticketRoot: fixture.ticketRoot, validator: artifactValidator }).publish(blocked, fixture.publicationContext);
    assert.equal(await service.execute(fixture.snapshot.runId, fixture.snapshot.attempts[0]!.handoffId, fixture.triggerPath, "plan-controller"), "result_accepted");
    const persisted = await store.read(fixture.snapshot.runId);
    assert.equal(persisted?.attempts[0]?.accepted?.status, "failed");
    assert.equal(persisted?.attempts[0]?.accepted?.outputHead, fixture.snapshot.currentHead);
    assert.equal(persisted?.state, "planning");
  } finally { await rm(setupResult.fixture.root, { recursive: true, force: true }); }
});

test("Plan session refuses a dirty workspace before a Pi process or result acceptance", async () => {
  const setupResult = await setup();
  try {
    const { fixture, store, artifactValidator, service, workspaceState } = setupResult;
    await new PlanArtifactPublisher({ ticketRoot: fixture.ticketRoot, validator: artifactValidator }).publish(submission(), fixture.publicationContext);
    workspaceState.dirty = true;
    await assert.rejects(service.execute(fixture.snapshot.runId, fixture.snapshot.attempts[0]!.handoffId, fixture.triggerPath, "plan-controller"), PlanSessionError);
    const persisted = await store.read(fixture.snapshot.runId);
    assert.equal(persisted?.attempts[0]?.accepted, undefined);
    assert.deepEqual(persisted?.acceptedResultPaths, []);
  } finally { await rm(setupResult.fixture.root, { recursive: true, force: true }); }
});

test("Plan result fencing catches a head change between independent observations", async () => {
  const setupResult = await setup();
  try {
    const { fixture, store, artifactValidator, service, workspaceState } = setupResult;
    await new PlanArtifactPublisher({ ticketRoot: fixture.ticketRoot, validator: artifactValidator }).publish(submission(), fixture.publicationContext);
    workspaceState.changedAtVerify = 5;
    await assert.rejects(service.execute(fixture.snapshot.runId, fixture.snapshot.attempts[0]!.handoffId, fixture.triggerPath, "plan-controller"), /Git head changed|workspace readiness/iu);
    const persisted = await store.read(fixture.snapshot.runId);
    assert.equal(persisted?.attempts[0]?.accepted, undefined);
    assert.deepEqual(persisted?.acceptedResultPaths, []);
  } finally { await rm(setupResult.fixture.root, { recursive: true, force: true }); }
});
