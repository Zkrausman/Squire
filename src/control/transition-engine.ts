import { isTerminal, type ContractReference, type RunSnapshot, type TransitionTrigger, type WorkflowState } from "./domain.js";

export interface TransitionRequest { schemaVersion: 1; requestId: string; runId: string; orchestratorSessionId: string; fromState: string; toState: WorkflowState; trigger: TransitionTrigger; currentHead: string; phaseResult: ContractReference | null; requestedAt: string }
export interface TransitionContext { run: RunSnapshot; orchestratorSessionId: string; observedHead: string; acceptedPhaseResult?: ContractReference }
export interface TransitionDirective { kind: "prepare" | "dispatch_phase" | "remediate" | "publish" | "await_human" | "terminal"; state: WorkflowState }
export interface TransitionDecision { next: RunSnapshot; directives: readonly TransitionDirective[] }
export interface TerminalCommand { commandId: string; runId: string; origin: "system" | "operator" | "retention"; toState: "failed" | "cancelled" | "expired"; currentHead: string }

const NORMAL = new Map<string, TransitionTrigger>([
  ["accepted:preparing", "run_accepted"], ["preparing:planning", "preparation_complete"], ["planning:implementing", "phase_pass"],
  ["implementing:reviewing", "phase_pass"], ["reviewing:testing", "phase_pass"], ["reviewing:implementing", "remediation_required"],
  ["testing:publishing", "phase_pass"], ["testing:implementing", "remediation_required"], ["publishing:awaiting_approval", "publication_complete"],
  ["awaiting_approval:approved", "approval_observed"]
]);
const PHASE_TRIGGERS = new Set<TransitionTrigger>(["phase_pass", "remediation_required"]);

export function decideTransition(request: TransitionRequest, context: TransitionContext): TransitionDecision {
  const { run } = context;
  if (isTerminal(run.state)) throw new Error("terminal state has no outgoing transitions");
  if (request.runId !== run.runId || request.orchestratorSessionId !== context.orchestratorSessionId) throw new Error("untrusted run or Orchestrator session");
  if (request.fromState !== run.state || request.currentHead !== run.currentHead || context.observedHead !== run.currentHead) throw new Error("stale state or Git head");
  if (run.committedRequestIds.includes(request.requestId)) throw new Error("transition request replay");
  let expected = NORMAL.get(`${run.state}:${request.toState}`);
  if (request.toState === "failed") expected = "system_failure";
  if (request.toState === "cancelled") expected = "operator_cancel";
  if (request.toState === "expired") expected = "retention_expired";
  if (!expected || request.trigger !== expected) throw new Error("illegal transition or trigger");
  const phase = PHASE_TRIGGERS.has(request.trigger);
  if (phase) {
    if (!request.phaseResult || !context.acceptedPhaseResult || !sameRef(request.phaseResult, context.acceptedPhaseResult)) throw new Error("phase transition is not bound to accepted result");
  } else if (request.phaseResult !== null) throw new Error("non-phase transition attached a phase result");
  if (request.toState === "publishing") assertFreshGates(run);
  const kind = request.toState === "preparing" ? "prepare" : request.toState === "implementing" && request.trigger === "remediation_required" ? "remediate" : request.toState === "publishing" ? "publish" : request.toState === "awaiting_approval" ? "await_human" : isTerminal(request.toState) ? "terminal" : "dispatch_phase";
  return { next: { ...run, version: run.version + 1, state: request.toState, committedRequestIds: [...run.committedRequestIds, request.requestId] }, directives: [{ kind, state: request.toState }] };
}
function sameRef(a: ContractReference, b: ContractReference): boolean { return a.path === b.path && a.sha256 === b.sha256 && a.schemaId === b.schemaId; }
function assertFreshGates(run: RunSnapshot): void {
  const review = run.gates.review; const test = run.gates.test; const implementTime = Date.parse(run.implementCompletedAt ?? "");
  if (!review || !test || !Number.isFinite(implementTime) || review.head !== run.currentHead || test.head !== run.currentHead || review.implementGeneration !== run.implementGeneration || test.implementGeneration !== run.implementGeneration || Date.parse(review.completedAt) <= implementTime || Date.parse(test.completedAt) <= implementTime) throw new Error("publishing requires fresh Review and Test gates at current head");
  for (const gate of [review, test]) {
    const accepted = run.attempts.find(candidate => candidate.phase === gate.phase && candidate.attempt === gate.attempt)?.accepted;
    if (!accepted || accepted.status !== "pass" || accepted.outputHead !== gate.head || accepted.implementGeneration !== gate.implementGeneration || accepted.completedAt !== gate.completedAt || accepted.acceptedAt !== gate.acceptedAt || !sameRef(accepted.reference, gate.result)) throw new Error("publishing gate is not backed by persisted accepted pass result");
  }
}

export function decideTerminalCommand(command: TerminalCommand, run: RunSnapshot, observedHead: string): TransitionDecision {
  if (isTerminal(run.state)) throw new Error("terminal state has no outgoing transitions");
  if (command.runId !== run.runId || command.currentHead !== run.currentHead || observedHead !== run.currentHead) throw new Error("stale terminal command context");
  const expected = command.origin === "system" ? "failed" : command.origin === "operator" ? "cancelled" : "expired";
  if (command.toState !== expected || run.committedRequestIds.includes(command.commandId)) throw new Error("illegal or replayed terminal command");
  return { next: { ...run, version: run.version + 1, state: command.toState, committedRequestIds: [...run.committedRequestIds, command.commandId] }, directives: [{ kind: "terminal", state: command.toState }] };
}

export const legalTransitions = NORMAL;
