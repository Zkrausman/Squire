import assert from "node:assert/strict";
import test from "node:test";
import { recordPassingGate } from "../src/control/gate-policy.js";
import { createImplementRemediation } from "../src/control/remediation-policy.js";
import type { AcceptedPhaseResult, PhaseAttempt } from "../src/control/domain.js";
import { headB, ref, run } from "./support/fixtures.js";

const feedback = [{ path: "artifacts/review/findings.json", sha256: "2".repeat(64), mediaType: "application/json", schemaId: "urn:squire:contracts:v1:review-findings" }];
function accepted(phase: "review" | "test", attempt: number, status: AcceptedPhaseResult["status"] = "pass", completedAt = "2026-09-01T12:01:00Z"): AcceptedPhaseResult {
  return { reference: ref(`${phase}-${attempt}`), phase, handoffId: `handoff_${phase}_${attempt}`, attempt, sessionId: phase, status, inputHead: headB, outputHead: headB, completedAt, acceptedAt: "2026-09-01T12:02:00Z", implementGeneration: 1 };
}
function persisted(value: AcceptedPhaseResult): PhaseAttempt {
  return { phase: value.phase, attempt: value.attempt, handoffId: value.handoffId, targetSessionId: value.sessionId, inputHead: headB, input: { path: `artifacts/${value.handoffId}/input.json`, sha256: "3".repeat(64), schemaId: "urn:squire:contracts:v1:phase-input" }, feedback: [], acceptedResult: value.reference, accepted: value, dispatch: { operationKey: value.handoffId, handoffId: value.handoffId, targetSessionId: value.sessionId, marker: value.handoffId, state: "result_accepted", generation: 1, cursor: null, recoveryPrompts: 0 } };
}

test("gates derive only from persisted current-generation passes after latest Implement", () => {
  const review = accepted("review", 1); const testResult = accepted("test", 1, "pass", "2026-09-01T12:03:00Z");
  const base = run({ currentHead: headB, implementGeneration: 1, implementCompletedAt: "2026-09-01T12:00:00Z", state: "reviewing", attempts: [persisted(review), persisted(testResult)], acceptedResultPaths: [review.reference.path, testResult.reference.path] });
  const reviewed = recordPassingGate(base, review);
  const tested = recordPassingGate({ ...reviewed, state: "testing" }, testResult);
  assert.equal(tested.gates.test?.head, headB);
  assert.equal(tested.gates.review?.attempt, 1);
});

test("generic, failing, stale, and pre-Implement results cannot create gates", () => {
  const valid = accepted("review", 1); const base = run({ currentHead: headB, implementGeneration: 1, implementCompletedAt: "2026-09-01T12:00:00Z", attempts: [], acceptedResultPaths: [] });
  assert.throws(() => recordPassingGate(base, valid), /persisted/);
  const failing = accepted("review", 1, "remediation_required");
  assert.throws(() => recordPassingGate({ ...base, attempts: [persisted(failing)], acceptedResultPaths: [failing.reference.path] }, failing), /pass/);
  const old = accepted("review", 1, "pass", "1970-01-01T00:00:00Z");
  assert.throws(() => recordPassingGate({ ...base, attempts: [persisted(old)], acceptedResultPaths: [old.reference.path] }, old), /postdate/);
});

test("remediation reuses Implement session, increments attempt, and enforces budgets", () => {
  const base = run({ sessions: { implement: { runId: "run_example01", role: "implement", sessionId: "impl", sessionFile: "/ticket/sessions/implement/x_impl.jsonl", processGeneration: 1, registeredAt: "now" } } });
  const remediated = createImplementRemediation(base, "review", "handoff_impl_review", { path: "artifacts/handoffs/implement/2/input.json", sha256: "3".repeat(64), schemaId: "urn:squire:contracts:v1:phase-input" }, feedback, { reviewAttempts: 2, testAttempts: 2, totalAttempts: 3 });
  assert.equal(remediated.attempts[0]?.targetSessionId, "impl");
  assert.deepEqual(remediated.gates, {});
  assert.throws(() => createImplementRemediation({ ...base, remediation: { review: 2, test: 0, total: 2 } }, "review", "handoff_x", { path: "artifacts/x", sha256: "3".repeat(64), schemaId: "urn:squire:contracts:v1:phase-input" }, feedback, { reviewAttempts: 2, testAttempts: 2, totalAttempts: 3 }), /budget/);
});
