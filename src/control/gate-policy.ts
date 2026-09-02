import type { AcceptedPhaseResult, RunSnapshot } from "./domain.js";

function persistedAcceptance(run: RunSnapshot, candidate: AcceptedPhaseResult): AcceptedPhaseResult {
  const attempt = run.attempts.find(value => value.handoffId === candidate.handoffId && value.attempt === candidate.attempt && value.phase === candidate.phase);
  const accepted = attempt?.accepted;
  if (!accepted || accepted.reference.path !== candidate.reference.path || accepted.reference.sha256 !== candidate.reference.sha256 || accepted.reference.schemaId !== candidate.reference.schemaId) throw new Error("gate result is not the persisted accepted attempt result");
  if (!run.acceptedResultPaths.includes(accepted.reference.path)) throw new Error("gate result identity is not controller-accepted");
  return accepted;
}

/** Projects a gate only from the authoritative persisted Review/Test acceptance. */
export function recordPassingGate(run: RunSnapshot, candidate: AcceptedPhaseResult): RunSnapshot {
  const accepted = persistedAcceptance(run, candidate);
  if (accepted.phase !== "review" && accepted.phase !== "test") throw new Error("only Review or Test can create a gate");
  if (accepted.status !== "pass") throw new Error("gate requires an accepted pass result");
  if (accepted.outputHead !== run.currentHead || accepted.inputHead !== run.currentHead) throw new Error("stale gate head");
  if (accepted.implementGeneration !== run.implementGeneration) throw new Error("stale Implement generation");
  const implementTime = Date.parse(run.implementCompletedAt ?? ""); const completedTime = Date.parse(accepted.completedAt); const acceptedTime = Date.parse(accepted.acceptedAt);
  if (![implementTime, completedTime, acceptedTime].every(Number.isFinite) || completedTime <= implementTime || acceptedTime <= implementTime) throw new Error("gate must postdate latest Implement output");
  if (accepted.phase === "test") {
    const review = run.gates.review;
    if (!review || review.head !== run.currentHead || review.implementGeneration !== run.implementGeneration || Date.parse(review.completedAt) <= implementTime) throw new Error("Test requires fresh Review at same head");
  }
  return {
    ...run,
    gates: {
      ...run.gates,
      [accepted.phase]: {
        phase: accepted.phase,
        head: accepted.outputHead,
        result: accepted.reference,
        acceptedAt: accepted.acceptedAt,
        completedAt: accepted.completedAt,
        implementGeneration: accepted.implementGeneration,
        attempt: accepted.attempt
      }
    }
  };
}
