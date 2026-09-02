import type { ArtifactReference, PhaseAttempt, RunSnapshot } from "./domain.js";
import { operationKey } from "./domain.js";
export interface RemediationLimits { reviewAttempts: number; testAttempts: number; totalAttempts: number }

export function createImplementRemediation(run: RunSnapshot, origin: "review" | "test", handoffId: string, inputPath: { path: string; sha256: string; schemaId: string }, feedback: readonly ArtifactReference[], limits: RemediationLimits): RunSnapshot {
  const session = run.sessions.implement; if (!session) throw new Error("Implement session is not registered");
  const nextCount = run.remediation[origin] + 1; const total = run.remediation.total + 1;
  if (nextCount > (origin === "review" ? limits.reviewAttempts : limits.testAttempts) || total > limits.totalAttempts) throw new Error("remediation budget exhausted");
  if (feedback.length === 0) throw new Error("remediation requires immutable feedback");
  const attempt = Math.max(0, ...run.attempts.filter(a => a.phase === "implement").map(a => a.attempt)) + 1;
  const op = operationKey(run.runId, handoffId, session.sessionId);
  const next: PhaseAttempt = { phase: "implement", attempt, handoffId, targetSessionId: session.sessionId, inputHead: run.currentHead, input: inputPath, feedback, dispatch: { operationKey: op, handoffId, targetSessionId: session.sessionId, marker: `[squire:${op}]`, state: "prepared", generation: 0, cursor: null, recoveryPrompts: 0 } };
  return { ...run, version: run.version + 1, attempts: [...run.attempts, next], remediation: { ...run.remediation, [origin]: nextCount, total }, gates: {} };
}
