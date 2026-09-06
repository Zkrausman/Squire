import assert from "node:assert/strict";
import test from "node:test";
import { validateImplementationPlanDocument, validatePlanSubmission, PlanValidationError } from "../src/plan/plan-validation.js";

const head = "a".repeat(40);
const valid = {
  disposition: "pass",
  schemaVersion: 1,
  runId: "run_plan01",
  ticketIdentifier: "AIDEV-218",
  inputHead: head,
  summary: "Implement the bounded Plan protocol.",
  assumptions: ["The controller supplies the validated workspace."],
  steps: [{ id: "step-1", description: "Add the Plan protocol.", affectedPaths: ["src/plan/plan-session.ts"], acceptanceCriteria: ["The focused Plan tests pass."] }],
  risks: [{ risk: "A stale workspace could invalidate the result.", mitigation: "Fence readiness immediately before acceptance." }],
  validationCommandIds: ["contracts", "tests"],
};
const context = { runId: "run_plan01", ticketIdentifier: "AIDEV-218", inputHead: head, allowedValidationCommandIds: ["contracts", "tests"], requiredValidationCommandIds: ["contracts", "tests"] };

function clone(): Record<string, unknown> { return structuredClone(valid) as Record<string, unknown>; }

 test("Plan submission validates the implementation-plan shape and controller identities", () => {
  const submission = validatePlanSubmission(valid, context);
  assert.equal(submission.disposition, "pass");
  assert.deepEqual(submission.questions, []);
  assert.equal(submission.plan.runId, context.runId);
  assert.throws(() => validatePlanSubmission({ ...valid, runId: "run_other01" }, context), PlanValidationError);
  assert.throws(() => validatePlanSubmission({ ...valid, unexpected: true }, context), /unknown field/iu);
});

test("Plan pass rejects unresolved assumptions, unsafe paths, missing criteria, and required commands", () => {
  const unresolved = clone();
  (unresolved["assumptions"] as string[]).push("The repository is unknown and will be figured out later.");
  assert.throws(() => validatePlanSubmission(unresolved, context), /unresolved/iu);
  const unsafe = clone();
  (unsafe["steps"] as Array<Record<string, unknown>>)[0]!["affectedPaths"] = ["../outside.ts"];
  assert.throws(() => validatePlanSubmission(unsafe, context), /repository-relative/iu);
  const missing = clone();
  missing["validationCommandIds"] = ["contracts"];
  assert.throws(() => validatePlanSubmission(missing, context), /required validation/iu);
  const noCriteria = clone();
  (noCriteria["steps"] as Array<Record<string, unknown>>)[0]!["acceptanceCriteria"] = [];
  assert.throws(() => validatePlanSubmission(noCriteria, context), /acceptance criteria/iu);
});

test("blocked Plan output keeps bounded questions and explicitly prevents implementation", () => {
  const blocked = { ...clone(), disposition: "blocked", summary: "Blocked: implementation must not start until the workspace identity is repaired.", assumptions: ["The base reference is unknown."], questions: ["Which exact base SHA should the controller bind?"] };
  const submission = validatePlanSubmission(blocked, context);
  assert.equal(submission["disposition"], "blocked");
  assert.equal(submission["questions"].length, 1);
  assert.throws(() => validatePlanSubmission({ ...blocked, summary: "Context is insufficient." }, context), /must state/iu);
  assert.throws(() => validatePlanSubmission({ ...blocked, questions: ["TBD"] }, context), /actionable/iu);
});

test("trusted implementation-plan validation requires contiguous step IDs and unique paths", () => {
  const document = clone();
  delete document["disposition"];
  delete document["questions"];
  const validated = validateImplementationPlanDocument(document, context);
  assert.equal(validated.steps[0]!.id, "step-1");
  const duplicate = structuredClone(document) as typeof document;
  (duplicate["steps"] as Array<Record<string, unknown>>)[0]!["affectedPaths"] = ["src/plan/plan-session.ts", "src/plan/plan-session.ts"];
  assert.throws(() => validateImplementationPlanDocument(duplicate, context), /duplicates/iu);
});
