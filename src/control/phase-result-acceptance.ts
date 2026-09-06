import type { JsonObject, PhaseResultDocument, V1ArtifactValidator } from "../contracts/v1-artifact-validator.js";
import { isTerminal, type AcceptedPhaseResult, type Clock, type ContractReference, type GitHeadObserver, type LeaseGuard, type RunSnapshot } from "./domain.js";
import type { AttemptResultPort } from "./attempt-coordinator.js";
import type { WorkflowStore } from "./workflow-store.js";
import { validateImplementationPlanDocument } from "../plan/plan-validation.js";

export type TransitiveSemantics = Readonly<Record<string, (document: JsonObject) => readonly string[]>>;
export type TransitiveSemanticPolicy = (context: { run: RunSnapshot; attempt: RunSnapshot["attempts"][number]; observedOutputHead: string; result: PhaseResultDocument }) => TransitiveSemantics;
export interface AcceptanceFenceContext { readonly runId: string; readonly handoffId: string; readonly attempt: RunSnapshot["attempts"][number]; readonly expectedHead: string; readonly result: PhaseResultDocument }
export type AcceptanceFence = (context: AcceptanceFenceContext) => Promise<void>;

/** The only production path from an immutable phase-result artifact to persisted acceptance. */
export class PhaseResultAcceptanceService {
  constructor(readonly store: WorkflowStore, readonly git: GitHeadObserver, readonly validator: V1ArtifactValidator, readonly clock: Clock, readonly semanticPolicy: TransitiveSemanticPolicy, readonly acceptanceFence?: AcceptanceFence) {}

  async accept(runId: string, handoffId: string, reference: ContractReference, lease: LeaseGuard): Promise<{ run: RunSnapshot; accepted: AcceptedPhaseResult; result: PhaseResultDocument }> {
    let current = await this.store.read(runId);
    if (!current) throw new Error("run not found");
    const initial = current;
    if (isTerminal(current.state)) throw new Error("terminal run retains late result as audit-only");
    const index = current.attempts.findIndex(attempt => attempt.handoffId === handoffId);
    const attempt = current.attempts[index];
    if (!attempt) throw new Error("result does not bind a persisted attempt");
    const latestAttempt = [...current.attempts].reverse().find(candidate => candidate.phase === attempt.phase);
    if (latestAttempt?.handoffId !== handoffId) throw new Error("result belongs to a superseded phase attempt");
    if (attempt.accepted || attempt.acceptedResult || current.acceptedResultPaths.includes(reference.path)) throw new Error("phase result already accepted");
    if (attempt.inputHead !== current.currentHead) throw new Error("attempt input head is stale");
    const observedOutputHead = await this.git.observeHead(runId);
    const validated = await this.validator.acceptPhaseResult(reference, {
      runId,
      handoffId,
      phase: attempt.phase,
      sessionId: attempt.targetSessionId,
      inputHead: attempt.inputHead,
      observedOutputHead,
      inputArtifact: attempt.input
    }, result => this.semanticPolicy({ run: initial, attempt, observedOutputHead, result }), new Set(initial.acceptedResultPaths));
    const observedAgain = await this.git.observeHead(runId);
    if (observedAgain !== observedOutputHead) throw new Error("Git head changed during result acceptance");
    const refreshed = await this.store.read(runId);
    if (!refreshed || refreshed.state !== initial.state || refreshed.currentHead !== initial.currentHead || refreshed.attempts[index]?.handoffId !== handoffId || refreshed.attempts[index]?.accepted) throw new Error("run changed during result acceptance");
    current = refreshed;
    const result = validated.result;
    await this.acceptanceFence?.({ runId, handoffId, attempt, expectedHead: current.currentHead, result });
    const nextGeneration = result.phase === "implement" && result.status === "pass" ? current.implementGeneration + 1 : current.implementGeneration;
    const accepted: AcceptedPhaseResult = {
      reference,
      phase: result.phase,
      handoffId,
      attempt: attempt.attempt,
      sessionId: result.sessionId,
      status: result.status,
      inputHead: result.inputHead,
      outputHead: result.outputHead,
      completedAt: String(result["completedAt"]),
      acceptedAt: new Date(this.clock.now()).toISOString(),
      implementGeneration: nextGeneration
    };
    const precondition = { version: current.version, state: current.state, currentHead: current.currentHead };
    const mutate = (snapshot: RunSnapshot): RunSnapshot => {
      if (isTerminal(snapshot.state)) throw new Error("terminal run retains late result as audit-only");
      const persisted = snapshot.attempts[index];
      if (!persisted || persisted.handoffId !== handoffId || persisted.accepted) throw new Error("attempt changed before result acceptance");
      const attempts = [...snapshot.attempts];
      attempts[index] = { ...persisted, acceptedResult: reference, accepted, dispatch: { ...persisted.dispatch, state: "result_accepted" } };
      const acceptedResultPaths = [...snapshot.acceptedResultPaths, reference.path];
      const implement = result.phase === "implement" && result.status === "pass";
      return { ...snapshot, version: snapshot.version + 1, attempts, acceptedResultPaths, ...(implement ? { currentHead: result.outputHead, implementGeneration: nextGeneration, implementCompletedAt: result.completedAt, gates: {} } : {}) };
    };
    const committed = await this.store.compareAndSetFenced(runId, precondition, { ...lease, now: this.clock.now() }, mutate);
    return { run: committed, accepted, result };
  }
}

export class PersistedPhaseResultPort implements AttemptResultPort {
  constructor(readonly acceptance: PhaseResultAcceptanceService, readonly discoverResult: (attempt: RunSnapshot["attempts"][number]) => Promise<ContractReference | undefined>) {}
  discover(attempt: RunSnapshot["attempts"][number]): Promise<ContractReference | undefined> { return this.discoverResult(attempt); }
  async accept(runId: string, handoffId: string, reference: ContractReference, lease: LeaseGuard): Promise<void> { await this.acceptance.accept(runId, handoffId, reference, lease); }
}

export interface PlanSemanticPolicyOptions {
  readonly ticketIdentifier?: string;
  readonly allowedCommandIds?: readonly string[];
  readonly requiredCommandIds?: readonly string[];
}

export function createPhaseSemanticPolicy(requiredCommandIds: readonly string[] = [], planOptions?: PlanSemanticPolicyOptions): TransitiveSemanticPolicy {
  return ({ run, attempt, observedOutputHead, result }) => ({
    "urn:squire:contracts:v1:implementation-plan": document => {
      const errors: string[] = [];
      if (document["runId"] !== run.runId) errors.push("plan runId mismatch");
      if (document["inputHead"] !== attempt.inputHead) errors.push("plan inputHead mismatch");
      if (result.phase === "plan" && result.status === "pass" && (result.findings.length > 0 || result.failures.length > 0)) errors.push("passing Plan result must contain no findings or failures");
      if (result.phase === "plan") {
        const expectedPlanPath = `artifacts/plan/${attempt.attempt}/plan.json`;
        const expectedEvidencePath = `evidence/plan/${attempt.attempt}/verification.md`;
        const planArtifacts = result.artifacts.filter(artifact => artifact.schemaId === "urn:squire:contracts:v1:implementation-plan");
        const reports = result.evidence.filter(evidence => evidence.path === expectedEvidencePath && evidence.mediaType === "text/markdown" && evidence.kind === "report");
        if (result.artifacts.length !== 1 || planArtifacts.length !== 1 || planArtifacts[0]?.path !== expectedPlanPath || planArtifacts[0]?.mediaType !== "application/json") errors.push("Plan result does not reference exactly its fixed plan artifact");
        if (reports.length !== 1 || result.evidence.length !== 1) errors.push("Plan result does not reference exactly its fixed verification report");
        if (result.status === "failed" && (result.findings.length !== 0 || result.failures.length !== 1 || result.failures[0]?.["id"] !== "PLAN_CONTEXT_BLOCKED" || result.failures[0]?.blocking !== true)) errors.push("failed Plan result must contain exactly one blocking PLAN_CONTEXT_BLOCKED failure");
        if (result.status === "failed" && (typeof document["summary"] !== "string" || !/\b(?:blocked|must not start|cannot proceed)\b/iu.test(document["summary"]))) errors.push("failed Plan artifact lacks an explicit blocked marker");
      }
      if (result.phase === "plan") {
        try {
          validateImplementationPlanDocument(document, {
            expectedRunId: run.runId,
            ...(planOptions?.ticketIdentifier !== undefined ? { expectedTicketIdentifier: planOptions.ticketIdentifier } : {}),
            expectedInputHead: attempt.inputHead,
            ...(planOptions?.allowedCommandIds !== undefined ? { allowedValidationCommandIds: planOptions.allowedCommandIds } : {}),
            ...(result.status === "pass" ? { requiredValidationCommandIds: planOptions?.requiredCommandIds ?? requiredCommandIds } : {}),
            allowUnresolvedAssumptions: result.status === "failed",
            allowBlockedMarker: result.status === "failed",
          });
        } catch (error) {
          errors.push(error instanceof Error ? error.message : "Plan document failed trusted validation");
        }
      }
      return errors;
    },
    "urn:squire:contracts:v1:review-findings": document => {
      const errors: string[] = [];
      if (document["runId"] !== run.runId || document["sessionId"] !== attempt.targetSessionId) errors.push("review identity mismatch");
      if (document["reviewedHead"] !== observedOutputHead) errors.push("review head mismatch");
      if (document["status"] !== result.status) errors.push("review status contradicts phase result");
      const findings = Array.isArray(document["findings"]) ? document["findings"] as Array<{ blocking?: unknown }> : [];
      if (result.status === "pass" && findings.some(finding => finding.blocking === true)) errors.push("passing review has blocking findings");
      if (result.status === "remediation_required" && !findings.some(finding => finding.blocking === true)) errors.push("review remediation lacks blocking findings");
      return errors;
    },
    "urn:squire:contracts:v1:test-evidence": document => {
      const errors: string[] = [];
      if (document["runId"] !== run.runId || document["sessionId"] !== attempt.targetSessionId) errors.push("test identity mismatch");
      if (document["testedHead"] !== observedOutputHead) errors.push("test head mismatch");
      if (document["status"] !== result.status) errors.push("test status contradicts phase result");
      const commands = Array.isArray(document["commands"]) ? document["commands"] as Array<{ commandId?: unknown; exitCode?: unknown; timedOut?: unknown }> : [];
      const commandIds = commands.map(command => command.commandId);
      if (new Set(commandIds).size !== commandIds.length) errors.push("test evidence command IDs must be unique");
      for (const id of new Set(requiredCommandIds)) {
        const matching = commands.filter(candidate => candidate.commandId === id);
        if (matching.length === 0) errors.push(`missing required command: ${id}`);
        else if (matching.length !== 1) errors.push(`required command must appear exactly once: ${id}`);
        else if (result.status === "pass" && (matching[0]?.exitCode !== 0 || matching[0]?.timedOut !== false)) errors.push(`required command did not pass: ${id}`);
      }
      const failures = Array.isArray(document["failures"]) ? document["failures"] as Array<{ blocking?: unknown }> : [];
      if (result.status === "pass" && failures.length > 0) errors.push("passing test evidence contains failures");
      if (result.status === "remediation_required" && !failures.some(failure => failure.blocking === true)) errors.push("remediation test evidence has no blocking failure");
      return errors;
    },
    "urn:squire:contracts:v1:runtime-resolution": document => document["runId"] === run.runId ? [] : ["runtime resolution runId mismatch"]
  });
}
