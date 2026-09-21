import { isDeepStrictEqual } from "node:util";
import { escalationDigest, validateEscalationPolicy, type PhaseProfile } from "./model-policy.js";
import { EXECUTION_FAILURES, type ExecutionFailure } from "./execution-failure.js";
import { validatePhaseResultShape } from "./phase-result.js";
import { PERSONAL_PHASES, type PersonalPhase, type PersonalRunState, type PhaseResult } from "./types.js";

export const STAGED_CLASSIFICATIONS = ["passed", "eligible_failure", "remediation_required", "needs_clarification", ...EXECUTION_FAILURES] as const;
export type StagedClassification = typeof STAGED_CLASSIFICATIONS[number];
export const STAGED_REASONS = ["initial", "retry", "stage_advanced", "remediation", "result", "execution_failure"] as const;
export interface StagedSelection {
  readonly phase: PersonalPhase;
  readonly attempt: number;
  readonly stageIndex: number;
  readonly stageAttempt: number;
  readonly stageMaximum: number;
  readonly consumed: number;
  readonly remaining: number;
  readonly profile: PhaseProfile;
  readonly policyDigest: string;
}
export interface StagedTransition extends StagedSelection {
  readonly kind: "reserved" | "closed";
  readonly reason: typeof STAGED_REASONS[number];
  readonly classification?: StagedClassification;
  readonly result?: PhaseResult;
}
export function stagedSelection(state: PersonalRunState, phase: PersonalPhase, attempt: number): StagedSelection | undefined {
  const stages = state.escalationPolicy?.[phase]?.stages;
  if (!stages) return undefined;
  const total = stages.reduce((n, s) => n + s.maxAttempts, 0);
  let preceding = 0;
  for (const [stageIndex, stage] of stages.entries()) {
    if (attempt > preceding && attempt <= preceding + stage.maxAttempts) {
      const { maxAttempts, ...profile } = stage;
      return { phase, attempt, stageIndex, stageAttempt: attempt - preceding, stageMaximum: maxAttempts, consumed: attempt, remaining: total - attempt, profile, policyDigest: state.escalationDigest! };
    }
    preceding += stage.maxAttempts;
  }
  return undefined;
}
export function requireStagedSlot(state: PersonalRunState, phase: PersonalPhase, trigger: string): StagedSelection | undefined {
  if (!state.escalationPolicy?.[phase]) return undefined;
  const selection = stagedSelection(state, phase, state.attempts[phase] + 1);
  if (!selection) {
    const stages = state.escalationPolicy[phase]!.stages;
    throw new Error(`Escalation exhausted: phase=${phase} policy=${state.escalationDigest} stage=${stages.length - 1} consumed=${state.attempts[phase]} configured=${stages.reduce((n, s) => n + s.maxAttempts, 0)} trigger=${trigger}; start a new run with an adequate policy after resolving the failure (no resume)`);
  }
  return selection;
}
export function reservation(state: PersonalRunState, slot: StagedSelection): StagedTransition {
  const prior = [...(state.stagedTransitions ?? [])].reverse().find(t => t.phase === slot.phase && t.kind === "closed");
  return { ...slot, kind: "reserved", reason: !prior ? "initial" : prior.stageIndex !== slot.stageIndex ? "stage_advanced" : prior.classification === "eligible_failure" ? "retry" : "remediation" };
}
export function validateStagedState(state: PersonalRunState): void {
  if (state.escalationPolicy === undefined) {
    if (state.escalationDigest !== undefined || state.stagedTransitions !== undefined) throw new Error("incomplete staged state");
    return;
  }
  validateEscalationPolicy(state.escalationPolicy);
  if (state.escalationDigest !== escalationDigest(state.escalationPolicy) || !Array.isArray(state.stagedTransitions) || state.stagedTransitions.length > 320) throw new Error("invalid staged policy evidence");
  const counts = Object.fromEntries(PERSONAL_PHASES.map(p => [p, 0])) as Record<PersonalPhase, number>;
  let open: StagedTransition | undefined;
  const prior: StagedTransition[] = [];
  const sessions = new Set<string>();
  for (const transition of state.stagedTransitions as readonly StagedTransition[]) {
    const { kind, reason, classification, result, ...selection } = transition;
    if (!STAGED_REASONS.includes(reason) || !isDeepStrictEqual(selection, stagedSelection(state, selection.phase, selection.attempt))) throw new Error("invalid staged selection");
    if (kind === "reserved") {
      if (open || classification !== undefined || result !== undefined || selection.attempt !== counts[selection.phase] + 1) throw new Error("unordered staged reservation");
      if (!isDeepStrictEqual(transition, reservation({ ...state, stagedTransitions: prior }, selection))) throw new Error("invalid staged reservation reason");
      const last = [...prior].reverse().find(t => t.phase === selection.phase && t.kind === "closed");
      if (last && last.classification !== "passed" && last.classification !== "remediation_required" && last.classification !== "eligible_failure") throw new Error("terminal staged outcome cannot retry");
      counts[selection.phase]++;
      open = transition;
    } else if (kind === "closed") {
      if (!open || !isDeepStrictEqual(selection, stagedSelection(state, open.phase, open.attempt)) || !classification || !STAGED_CLASSIFICATIONS.includes(classification)) throw new Error("unordered staged closure");
      if (reason !== (result ? "result" : "execution_failure")) throw new Error("invalid staged closure reason");
      if (result) {
        validatePhaseResultShape(result, selection.phase);
        if (result.runId !== state.runId || result.sessionFile !== (state.launchJournal?.find(t => t.sessionId === result.sessionId)?.sessionFile ?? `/ticket/sessions/${selection.phase}/${selection.attempt}.jsonl`) || result.attempt !== selection.attempt || !isDeepStrictEqual(result.profile, selection.profile) || sessions.has(result.sessionId)) throw new Error("staged result provenance mismatch");
        const expected = result.status === "failed" ? (result.phase === "plan" && result.details.supervision?.outcome === "needs_clarification" ? "needs_clarification" : "eligible_failure") : result.status;
        if (classification !== expected || (result.phase !== "implement" && result.inputHead !== result.outputHead)) throw new Error("staged result classification/HEAD mismatch");
        sessions.add(result.sessionId);
      } else if (!(EXECUTION_FAILURES as readonly string[]).includes(classification as ExecutionFailure)) throw new Error("staged closure requires a validated result");
      open = undefined;
    } else throw new Error("invalid staged transition kind");
    prior.push(transition);
  }
  for (const phase of PERSONAL_PHASES) {
    if (!state.escalationPolicy[phase]) continue;
    if (state.attempts[phase] !== counts[phase]) throw new Error("staged attempt counter mismatch");
    const result = state.results[phase];
    const closure = state.stagedTransitions.find(t => t.phase === phase && t.kind === "closed" && t.attempt === result?.attempt);
    if (closure && !isDeepStrictEqual(result, closure.result)) throw new Error("staged result does not match closure evidence");
  }
}
export function assertStagedUnchanged(current: PersonalRunState, next: PersonalRunState): void {
  if (!isDeepStrictEqual(current.escalationPolicy, next.escalationPolicy) || current.escalationDigest !== next.escalationDigest) throw new Error("staged schedule is immutable");
  const before = current.stagedTransitions ?? [];
  const after = next.stagedTransitions ?? [];
  if (after.length < before.length || after.length > before.length + 1 || !isDeepStrictEqual(before, after.slice(0, before.length))) throw new Error("staged journal is append-only");
}
