import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PersonalMvpController } from "../src/personal/controller.js";
import { JsonRunStateStore, validateState } from "../src/personal/json-run-state.js";
import { captureLaunchMaterial, composeSystemPrompt } from "../src/personal/launch-material.js";
import { digestArtifact, type PlanProgress } from "../src/personal/plan-artifacts.js";
import { formatRunStatus } from "../src/personal/status.js";
import type { PhaseInput, PhasePort, PlanPhaseResult, WorkspacePort } from "../src/personal/types.js";
import { TEST_CONFIG_DIGEST, TEST_MATERIAL } from "./helpers/personal-launch.js";

const material = await captureLaunchMaterial({ config: { ...TEST_MATERIAL.config, promptPolicy: { version: 1, id: "default", plan: ["requirements", "implementation-design"] } }, digest: TEST_CONFIG_DIGEST, rawConfig: TEST_MATERIAL.rawConfig });
const head = "a".repeat(40);
const request = { ticketId: "AIDEV-1", repository: material.config.repository.slug, repositoryPath: material.config.repository.path, sourceRef: "HEAD", baseBranch: "main" };
function clarification(input: PhaseInput): PlanPhaseResult {
  const supervisorId = "11111111-1111-4111-8111-111111111111";
  const artifact = { version: 1 as const, inputHead: head, problem: "missing intent", acceptanceCriteria: ["target selected"], assumptions: [], dependencies: [], nonGoals: [], openQuestions: ["Which target?"], readiness: "needs_clarification" as const };
  return { runId: input.runId, phase: "plan", attempt: input.attempt, sessionId: supervisorId, sessionFile: `/ticket/sessions/plan/${input.attempt}.jsonl`, inputHead: head, outputHead: head, profile: input.profile, status: "failed", summary: "Plan needs clarification: Which target?", details: { steps: ["Resolve clarification"], supervision: { version: 1, supervisorId, launchDigest: material.digest, outcome: "needs_clarification", children: [{ subphase: "requirements", sessionId: "22222222-2222-4222-8222-222222222222", sessionFile: `/ticket/sessions/plan/${input.attempt}/requirements.jsonl`, inputHead: head, profile: input.profile, launchDigest: material.digest, promptDigest: createHash("sha256").update(composeSystemPrompt(material, "plan", "requirements")).digest("hex"), outcome: "passed", diagnostic: null, artifact: { path: `/run/squire-plan-${supervisorId}/artifacts/requirements.json`, content: artifact, digest: digestArtifact(artifact) } }] } } };
}
async function fixture(fn: (states: JsonRunStateStore, controller: (phases: PhasePort) => PersonalMvpController) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-plan-state-"));
  const states = new JsonRunStateStore(root);
  const workspace: WorkspacePort = { async prepare(input) { return { sandbox: input.sandbox, baseSha: head, head }; }, async currentHead() { return head; }, async assertClean() {}, async exportBundle() { throw new Error("publication must not run"); } };
  try { await fn(states, phases => new PersonalMvpController({ launchMaterial: material, states, phases, workspaces: workspace, tickets: { async get(id) { return { id, title: "clarify", description: "clarify" }; } }, publication: { async publish() { throw new Error("must not publish"); } } })); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("controller alone persists nested Plan progress and clarification, blocking Implement visibly", async () => fixture(async (states, create) => {
  let callback: ((event: PlanProgress) => Promise<void>) | undefined;
  let event: PlanProgress | undefined;
  const calls: string[] = [];
  const controller = create({ async run(input, _signal, onProgress) {
    calls.push(input.phase); callback = onProgress;
    event = { runId: input.runId, attempt: input.attempt, subphase: "requirements" };
    await onProgress!(event);
    const state = await states.read(input.runId);
    assert.equal(state!.step, "plan");
    assert.match(formatRunStatus(state!), /Plan \/ Requirements/);
    assert.match(formatRunStatus({ ...state!, planProgress: { ...event, subphase: "implementation-design" } }), /Plan \/ Implementation Design/);
    assert.equal(state!.attempts.plan, 1);
    return clarification(input);
  } });
  await assert.rejects(controller.run(request), /Which target/);
  const [state] = await states.findByTicket(request.ticketId);
  assert.deepEqual(calls, ["plan"]);
  assert.equal(state!.status, "failed");
  assert.equal(state!.step, "plan");
  assert.equal(state!.planExecution, "supervised-v1");
  assert.equal(state!.attempts.implement, 0);
  assert.equal(state!.results.plan?.status, "failed");
  assert.match(formatRunStatus(state!), /Plan blocked:.*Which target/);
  await assert.rejects(callback!({ ...event!, subphase: "implementation-design" }), /stale/);
  assert.equal((await states.read(state!.runId))!.version, state!.version);
  const invalid = structuredClone(state!);
  (invalid as any).planProgress.attempt++;
  assert.throws(() => validateState(invalid), /progress identity/);
  const legacy = JSON.parse(JSON.stringify(state));
  delete legacy.planExecution; delete legacy.planProgress; delete legacy.results.plan.details.supervision;
  validateState(legacy); // Published captured records remain readable.
  (legacy as any).planExecution = "supervised-v1";
  assert.throws(() => validateState(legacy), /supervised Plan evidence/);
  await assert.rejects(states.save({ ...state!, version: state!.version + 1, planExecution: undefined, planProgress: null } as never), /immutable/);
}));

test("new supervised controller rejects legacy Plan result bypass", async () => fixture(async (_states, create) => {
  const controller = create({ async run(input) { const result = clarification(input); return { ...result, status: "passed", details: { steps: ["bypass Requirements"] } }; } });
  await assert.rejects(controller.run(request), /supervised Plan evidence required/);
}));

test("controller rejects stale attempt/identity and reversed nested progress", async t => {
  for (const patch of [{ attempt: 2 }, { runId: "another-run" }, { subphase: "implementation-design" as const }]) await t.test(JSON.stringify(patch), () => fixture(async (_states, create) => {
    const controller = create({ async run(input, _signal, progress) { await progress!({ runId: input.runId, attempt: input.attempt, subphase: "requirements", ...patch }); return clarification(input); } });
    await assert.rejects(controller.run(request), /stale or unordered/);
  }));
});
