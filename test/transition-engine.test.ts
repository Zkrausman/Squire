import assert from "node:assert/strict"; import test from "node:test";
import { ACTIVE_STATES } from "../src/control/domain.js"; import { decideTerminalCommand, decideTransition, legalTransitions, type TransitionRequest } from "../src/control/transition-engine.js"; import { headA, ref, run } from "./support/fixtures.js";
const phaseRef = ref("result");
function request(fromState: string, toState: any, trigger: any, phase = false): TransitionRequest { return { schemaVersion: 1, requestId: `transition_${fromState}_${toState}`, runId: "run_example01", orchestratorSessionId: "orch", fromState, toState, trigger, currentHead: headA, phaseResult: phase ? phaseRef : null, requestedAt: "2026-09-01T12:00:00Z" }; }
test("every normal, remediation, and terminal edge is accepted and all other pairs reject", () => {
  const states = [...ACTIVE_STATES];
  for (const from of states) for (const to of [...states, "approved", "failed", "cancelled", "expired"] as const) {
    const normal = legalTransitions.get(`${from}:${to}`); const terminal = to === "failed" ? "system_failure" : to === "cancelled" ? "operator_cancel" : to === "expired" ? "retention_expired" : undefined; const trigger = normal ?? terminal;
    const phase = trigger === "phase_pass" || trigger === "remediation_required";
    const gateAttempt = (phase: "review" | "test", attempt: number) => ({ phase, attempt, handoffId: `handoff_${phase}`, targetSessionId: phase, inputHead: headA, input: { path: `artifacts/${phase}/input.json`, sha256: "3".repeat(64), schemaId: "urn:squire:contracts:v1:phase-input" }, feedback: [], acceptedResult: phaseRef, accepted: { reference: phaseRef, phase, handoffId: `handoff_${phase}`, attempt, sessionId: phase, status: "pass" as const, inputHead: headA, outputHead: headA, completedAt: `2026-09-01T12:0${attempt}:00Z`, acceptedAt: `2026-09-01T12:0${attempt}:30Z`, implementGeneration: 0 }, dispatch: { operationKey: phase, handoffId: `handoff_${phase}`, targetSessionId: phase, marker: phase, state: "result_accepted" as const, generation: 1, cursor: null, recoveryPrompts: 0 } });
    const snapshot = run({ state: from, ...(to === "publishing" ? { implementCompletedAt: "2026-09-01T12:00:00Z", attempts: [gateAttempt("review", 1), gateAttempt("test", 2)], gates: { review: { phase: "review", head: headA, result: phaseRef, acceptedAt: "2026-09-01T12:01:30Z", completedAt: "2026-09-01T12:01:00Z", implementGeneration: 0, attempt: 1 }, test: { phase: "test", head: headA, result: phaseRef, acceptedAt: "2026-09-01T12:02:30Z", completedAt: "2026-09-01T12:02:00Z", implementGeneration: 0, attempt: 2 } } } : {}) });
    if (trigger) assert.equal(decideTransition(request(from, to, trigger, phase), { run: snapshot, orchestratorSessionId: "orch", observedHead: headA, ...(phase ? { acceptedPhaseResult: phaseRef } : {}) }).next.state, to);
    else assert.throws(() => decideTransition(request(from, to, "phase_pass", true), { run: snapshot, orchestratorSessionId: "orch", observedHead: headA, acceptedPhaseResult: phaseRef }), /illegal/);
  }
});
test("trusted terminal commands retain their own origin instead of impersonating Orchestrator output", () => { const base = run({ state: "testing" }); assert.equal(decideTerminalCommand({ commandId: "operator_1", runId: base.runId, origin: "operator", toState: "cancelled", currentHead: headA }, base, headA).next.state, "cancelled"); assert.throws(() => decideTerminalCommand({ commandId: "bad", runId: base.runId, origin: "operator", toState: "failed", currentHead: headA }, base, headA), /illegal/); });

test("replay, wrong Orchestrator, substituted result, stale head, and terminal outgoing reject", () => {
  const base = request("reviewing", "testing", "phase_pass", true); const snapshot = run({ state: "reviewing" });
  assert.throws(() => decideTransition(base, { run: snapshot, orchestratorSessionId: "other", observedHead: headA, acceptedPhaseResult: phaseRef }), /untrusted/);
  assert.throws(() => decideTransition(base, { run: snapshot, orchestratorSessionId: "orch", observedHead: "b".repeat(40), acceptedPhaseResult: phaseRef }), /stale/);
  assert.throws(() => decideTransition(base, { run: snapshot, orchestratorSessionId: "orch", observedHead: headA, acceptedPhaseResult: { ...phaseRef, sha256: "2".repeat(64) } }), /accepted result/);
  assert.throws(() => decideTransition(base, { run: run({ state: "approved" }), orchestratorSessionId: "orch", observedHead: headA, acceptedPhaseResult: phaseRef }), /terminal/);
});
