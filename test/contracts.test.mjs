import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  validatePhaseResult,
  validatePhaseTrigger,
  validatePullRequestDeliveryState,
  validateRevisedHandoff,
  validateTestEvidence,
  validateTransitionRequest,
  validateWorkflowConfig
} from "../src/semantic-validation.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const fixture = async relative => JSON.parse(await readFile(path.join(root, "fixtures/contracts", relative), "utf8"));

const headA = "a".repeat(40);
const headB = "b".repeat(40);

test("all schemas and positive/negative fixtures satisfy their expected outcome", async () => {
  const { stdout } = await execFileAsync(process.execPath, ["scripts/validate-contracts.mjs"], { cwd: root });
  assert.match(stdout, /Validated 11 schemas/);
});

test("phase results fail closed on wrong identity, stale SHA, and contradictory pass", async () => {
  const inputArtifact = {
    path: "artifacts/handoffs/implement-1.json",
    sha256: "905873e37073bc4dacc3d747ce7aa22bf99b016f4147b345a07627accd30df9c",
    schemaId: "urn:squire:contracts:v1:phase-input"
  };
  const context = { runId: "run_example01", phase: "implement", sessionId: "session-implement-01", inputHead: headA, outputHead: headB, handoffId: "handoff_implement_1", inputArtifact };
  const wrong = await fixture("invalid/semantic/phase-result/wrong-identities.json");
  assert.match(validatePhaseResult(wrong, context).join(" "), /runId.*sessionId/);

  const stale = await fixture("invalid/semantic/phase-result/stale-sha.json");
  assert.match(validatePhaseResult(stale, { ...context, phase: "review", sessionId: "session-review-01", inputHead: headB, handoffId: "handoff_review_1", inputArtifact: stale.inputArtifact }).join(" "), /inputHead.*outputHead/);

  const contradictory = await fixture("invalid/semantic/phase-result/contradictory-pass.json");
  assert.match(validatePhaseResult(contradictory, { ...context, phase: "review", sessionId: "session-review-01", inputHead: headB, outputHead: headB, handoffId: "handoff_review_1", inputArtifact: contradictory.inputArtifact }).join(" "), /pass result contains unresolved/);
});

test("short trigger is bound to the immutable input artifact digest", async () => {
  const input = await fixture("valid/phase-input/implement.json");
  const valid = await fixture("valid/phase-trigger/implement.json");
  const invalid = await fixture("invalid/semantic/phase-trigger/digest-mismatch.json");
  assert.deepEqual(validatePhaseTrigger(valid, input, valid.inputArtifact), []);
  assert.match(validatePhaseTrigger(invalid, input, valid.inputArtifact).join(" "), /digest/);
});

test("scope-changing steering requires a monotonic, identity-preserving, newly allocated handoff", async () => {
  const previous = await fixture("valid/phase-input/implement.json");
  const previousArtifact = { path: "artifacts/handoffs/implement-1.json", sha256: "1".repeat(64), schemaId: "urn:squire:contracts:v1:phase-input" };
  const revisedArtifact = { path: "artifacts/handoffs/implement-2.json", sha256: "2".repeat(64), schemaId: "urn:squire:contracts:v1:phase-input" };
  const silentlyMutated = { ...previous, feedback: [{ path: "artifacts/review/findings.json", sha256: "3".repeat(64), schemaId: "urn:squire:contracts:v1:review-findings" }] };
  assert.match(validateRevisedHandoff(previous, silentlyMutated, { previousArtifact, revisedArtifact: previousArtifact }).join(" "), /new handoffId.*increment attempt.*creation time.*new artifact path and digest/);

  const revised = { ...silentlyMutated, handoffId: "handoff_implement_2", attempt: 2, createdAt: "2026-09-01T12:40:00Z" };
  assert.deepEqual(validateRevisedHandoff(previous, revised, { previousArtifact, revisedArtifact }), []);

  const substituted = await fixture("invalid/semantic/phase-input/revision-identity-substitution.json");
  const errors = validateRevisedHandoff(previous, substituted, { previousArtifact, revisedArtifact }).join(" ");
  assert.match(errors, /runId.*phase.*targetSessionId.*inputHead.*creation time/);
});

test("transition validator implements the documented graph and rejects skips", () => {
  const edges = [
    ["accepted", "preparing", "run_accepted", false],
    ["preparing", "planning", "preparation_complete", false],
    ["planning", "implementing", "phase_pass", true],
    ["implementing", "reviewing", "phase_pass", true],
    ["reviewing", "testing", "phase_pass", true],
    ["reviewing", "implementing", "remediation_required", true],
    ["testing", "publishing", "phase_pass", true],
    ["testing", "implementing", "remediation_required", true],
    ["publishing", "awaiting_approval", "publication_complete", false],
    ["awaiting_approval", "approved", "approval_observed", false]
  ];
  for (const [fromState, toState, trigger, phase] of edges) {
    const request = { runId: "run_example01", orchestratorSessionId: "orch", fromState, toState, trigger, currentHead: headB, phaseResult: phase ? { path: "artifacts/result.json", sha256: "1".repeat(64), schemaId: "urn:squire:contracts:v1:phase-result" } : null };
    assert.deepEqual(validateTransitionRequest(request, { runId: "run_example01", orchestratorSessionId: "orch", currentState: fromState, currentHead: headB, phaseResult: request.phaseResult ?? undefined }), []);
  }
  const skip = { runId: "run_example01", orchestratorSessionId: "orch", fromState: "planning", toState: "publishing", trigger: "phase_pass", currentHead: headA, phaseResult: { path: "artifacts/result.json", sha256: "1".repeat(64), schemaId: "urn:squire:contracts:v1:phase-result" } };
  assert.match(validateTransitionRequest(skip, { runId: "run_example01", orchestratorSessionId: "orch", currentState: "planning", currentHead: headA, phaseResult: skip.phaseResult }).join(" "), /illegal transition/);

  const accepted = { path: "artifacts/result.json", sha256: "1".repeat(64), schemaId: "urn:squire:contracts:v1:phase-result" };
  const substituted = { runId: "run_example01", orchestratorSessionId: "orch", fromState: "reviewing", toState: "testing", trigger: "phase_pass", currentHead: headB, phaseResult: { ...accepted, sha256: "2".repeat(64) } };
  assert.match(validateTransitionRequest(substituted, { runId: "run_example01", orchestratorSessionId: "orch", currentState: "reviewing", currentHead: headB, phaseResult: accepted }).join(" "), /does not match the controller-accepted result/);
});

test("pass requires complete current-head test and delivery evidence", async () => {
  const config = await fixture("valid/workflow-config/basic.json");
  const incomplete = await fixture("invalid/semantic/test-evidence/missing-required-command.json");
  assert.match(validateTestEvidence(incomplete, config, { runId: "run_example01", sessionId: "session-test-01", headSha: headB }).join(" "), /missing required command evidence: tests/);

  const deliveryContext = { runId: "run_example01", headSha: headB, repository: "example/service", baseBranch: "main", featureBranch: "squire/aidev-215/run_example01", pullRequestNumber: 42, pullRequestUrl: "https://github.com/example/service/pull/42" };
  const stale = await fixture("invalid/semantic/pull-request-delivery-state/stale-approval.json");
  const errors = validatePullRequestDeliveryState(stale, config, deliveryContext).join(" ");
  assert.match(errors, /approval is stale/);
  assert.match(errors, /lacks configured Reviewer identity approval/);

  const wrongTarget = await fixture("invalid/semantic/pull-request-delivery-state/wrong-target.json");
  assert.match(validatePullRequestDeliveryState(wrongTarget, config, deliveryContext).join(" "), /repository.*baseBranch.*featureBranch.*pull request number.*pull request URL/);

  const ready = await fixture("valid/pull-request-delivery-state/ready.json");
  assert.match(validatePullRequestDeliveryState(ready, config).join(" "), /requires trusted runId context.*requires trusted pullRequestUrl context/);
});

test("sandbox configuration paths reject traversal structurally and semantically", async () => {
  const config = await fixture("valid/workflow-config/basic.json");
  config.validation.commands[0].cwd = "/ticket/../../etc";
  config.pi.roles.review.instructionsPath = "/ticket/../attacker-role.md";
  const errors = validateWorkflowConfig(config).join(" ");
  assert.match(errors, /instructionsPath must be a canonical path beneath \/ticket/);
  assert.match(errors, /cwd must be a canonical path beneath \/ticket/);
});
