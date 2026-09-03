import type { JsonObject, V1ArtifactValidator } from "../contracts/v1-artifact-validator.js";
import type { ContractReference, GitHeadObserver, Phase, RunSnapshot } from "./domain.js";
import type { GitWorkspaceReadiness } from "../git/domain.js";
import type { WorkflowStore } from "./workflow-store.js";
import { recordPassingGate } from "./gate-policy.js";
import { decideTransition, type TransitionDecision, type TransitionRequest } from "./transition-engine.js";

const STATE_PHASE: Partial<Record<RunSnapshot["state"], Phase>> = { planning: "plan", implementing: "implement", reviewing: "review", testing: "test" };

export class OrchestrationService {
  constructor(readonly store: WorkflowStore, readonly git: GitHeadObserver, readonly validator: V1ArtifactValidator, readonly workspaceReadiness?: GitWorkspaceReadiness) {}

  async transition(requestReference: ContractReference): Promise<TransitionDecision> {
    const requestBytes = await this.validator.validate<TransitionRequest & JsonObject>(requestReference, {
      schemaId: "urn:squire:contracts:v1:transition-request",
      semantic: () => []
    });
    const request = requestBytes.document;
    let current = await this.store.read(request.runId);
    if (!current) throw new Error("run not found");
    let orchestrator = current.sessions.orchestrator;
    if (!orchestrator || orchestrator.runId !== current.runId || orchestrator.role !== "orchestrator") throw new Error("run has no trusted registered Orchestrator session");
    if (request.orchestratorSessionId !== orchestrator.sessionId) throw new Error("transition request is not from the registered Orchestrator session");
    if (current.state === "preparing" && request.toState === "planning") {
      if (!this.workspaceReadiness) throw new Error("preparation cannot complete without Git workspace readiness");
      await this.workspaceReadiness.verify(current.runId, current.currentHead);
      const refreshed = await this.store.read(request.runId);
      if (!refreshed || refreshed.state !== current.state || refreshed.currentHead !== current.currentHead) throw new Error("workflow changed during Git workspace readiness verification");
      current = refreshed;
      orchestrator = current.sessions.orchestrator;
      if (!orchestrator || request.orchestratorSessionId !== orchestrator.sessionId) throw new Error("Orchestrator session changed during Git workspace readiness verification");
    }
    if (current.state === "testing" && request.toState === "publishing") {
      if (!this.workspaceReadiness) throw new Error("publishing requires independent Git workspace verification");
      await this.workspaceReadiness.verify(current.runId, current.currentHead);
      const refreshed = await this.store.read(request.runId);
      if (!refreshed || refreshed.state !== current.state || refreshed.currentHead !== current.currentHead) throw new Error("workflow changed during Git workspace readiness verification");
      current = refreshed;
      orchestrator = current.sessions.orchestrator;
      if (!orchestrator || request.orchestratorSessionId !== orchestrator.sessionId) throw new Error("Orchestrator session changed during Git workspace readiness verification");
    }
    const observedHead = await this.git.observeHead(request.runId);
    const expectedPhase = STATE_PHASE[current.state];
    const phaseAttempt = expectedPhase ? [...current.attempts].reverse().find(attempt => attempt.phase === expectedPhase) : undefined;
    const accepted = phaseAttempt?.accepted;
    const phaseTrigger = request.trigger === "phase_pass" || request.trigger === "remediation_required";
    const expectedStatus = request.trigger === "phase_pass" ? "pass" : request.trigger === "remediation_required" ? "remediation_required" : undefined;
    if (phaseTrigger && (!accepted || accepted.status !== expectedStatus || accepted.reference.path !== request.phaseResult?.path || accepted.reference.sha256 !== request.phaseResult.sha256 || accepted.reference.schemaId !== request.phaseResult.schemaId || !current.acceptedResultPaths.includes(accepted.reference.path) || accepted.outputHead !== current.currentHead || accepted.implementGeneration !== current.implementGeneration)) {
      throw new Error("transition is not bound to a persisted controller-accepted current attempt result");
    }
    const snapshotWithGate = accepted?.status === "pass" && ((accepted.phase === "review" && request.toState === "testing") || (accepted.phase === "test" && request.toState === "publishing")) ? recordPassingGate(current, accepted) : current;
    const decision = decideTransition(request, {
      run: snapshotWithGate,
      orchestratorSessionId: orchestrator.sessionId,
      observedHead,
      ...(accepted ? { acceptedPhaseResult: accepted.reference } : {})
    });
    const observedAgain = await this.git.observeHead(request.runId);
    if (observedAgain !== observedHead) throw new Error("Git head changed during transition validation");
    const committed = await this.store.compareAndSet(request.runId, { version: current.version, state: current.state, currentHead: current.currentHead }, () => decision.next);
    return { ...decision, next: committed };
  }
}
