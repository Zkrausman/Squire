import assert from "node:assert/strict"; import test from "node:test";
import { ACTIVE_STATES } from "../src/control/domain.js"; import { decideTerminalCommand, decideTransition, legalTransitions, type TransitionRequest } from "../src/control/transition-engine.js"; import { headA, ref, run } from "./support/fixtures.js";
const phaseRef = ref("result");
function request(fromState: string, toState: any, trigger: any, phase = false): TransitionRequest { return { schemaVersion: 1, requestId: `transition_${fromState}_${toState}`, runId: "run_example01", orchestratorSessionId: "orch", fromState, toState, trigger, currentHead: headA, phaseResult: phase ? phaseRef : null, requestedAt: "2026-09-01T12:00:00Z" }; }
test("every normal, remediation, and terminal edge is accepted and all other pairs reject", () => {
  const states = [...ACTIVE_STATES];
  for (const from of states) for (const to of [...states, "approved", "failed", "cancelled", "expired"] as const) {
    const normal = legalTransitions.get(`${from}:${to}`); const terminal = to === "failed" ? "system_failure" : to === "cancelled" ? "operator_cancel" : to === "expired" ? "retention_expired" : undefined; const trigger = normal ?? terminal;
    const phase = trigger === "phase_pass" || trigger === "remediation_required";
    const snapshot = run({ state: from, ...(to === "publishing" ? { gates: { review: { phase: "review", head: headA, result: phaseRef, acceptedAt: "1", implementGeneration: 0 }, test: { phase: "test", head: headA, result: phaseRef, acceptedAt: "2", implementGeneration: 0 } } } : {}) });
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
