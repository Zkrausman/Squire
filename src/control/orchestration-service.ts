import type { GitHeadObserver, RunPrecondition } from "./domain.js";
import type { WorkflowStore } from "./workflow-store.js";
import { decideTransition, type TransitionContext, type TransitionDecision, type TransitionRequest } from "./transition-engine.js";

export class OrchestrationService {
  constructor(readonly store: WorkflowStore, readonly git: GitHeadObserver) {}
  async transition(request: TransitionRequest, expected: RunPrecondition, orchestratorSessionId: string, acceptedPhaseResult?: TransitionContext["acceptedPhaseResult"]): Promise<TransitionDecision> {
    const current = await this.store.read(request.runId); if (!current) throw new Error("run not found");
    const observedHead = await this.git.observeHead();
    const decision = decideTransition(request, { run: current, orchestratorSessionId, observedHead, ...(acceptedPhaseResult ? { acceptedPhaseResult } : {}) });
    const committed = await this.store.compareAndSet(request.runId, expected, () => decision.next);
    return { ...decision, next: committed };
  }
}
