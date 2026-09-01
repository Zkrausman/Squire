import type { ContractReference, RunSnapshot } from "./domain.js";

export function recordPassingGate(run: RunSnapshot, phase: "review" | "test", head: string, result: ContractReference, acceptedAt: string): RunSnapshot {
  if (head !== run.currentHead) throw new Error("stale gate head");
  if (phase === "test") {
    const review = run.gates.review;
    if (!review || review.head !== head || review.implementGeneration !== run.implementGeneration) throw new Error("Test requires fresh Review at same head");
  }
  return { ...run, version: run.version + 1, gates: { ...run.gates, [phase]: { phase, head, result, acceptedAt, implementGeneration: run.implementGeneration } } };
}
export function recordImplementHead(run: RunSnapshot, head: string): RunSnapshot {
  if (head === run.currentHead) throw new Error("remediating Implement must change observed head");
  return { ...run, version: run.version + 1, currentHead: head, implementGeneration: run.implementGeneration + 1, gates: {} };
}
