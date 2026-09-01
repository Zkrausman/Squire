export const ROLES = ["orchestrator", "plan", "implement", "review", "test"] as const;
export type Role = (typeof ROLES)[number];
export type Phase = Exclude<Role, "orchestrator">;

export const ACTIVE_STATES = ["accepted", "preparing", "planning", "implementing", "reviewing", "testing", "publishing", "awaiting_approval"] as const;
export const TERMINAL_STATES = ["approved", "failed", "cancelled", "expired"] as const;
export type ActiveState = (typeof ACTIVE_STATES)[number];
export type TerminalState = (typeof TERMINAL_STATES)[number];
export type WorkflowState = ActiveState | TerminalState;
export type TransitionTrigger = "run_accepted" | "preparation_complete" | "phase_pass" | "remediation_required" | "publication_complete" | "approval_observed" | "system_failure" | "operator_cancel" | "retention_expired";

export interface ContractReference { path: string; sha256: string; schemaId: string }
export interface ArtifactReference { path: string; sha256: string; mediaType: string; schemaId?: string }
export interface SessionRegistration { runId: string; role: Role; sessionId: string; sessionFile: string; processGeneration: number; registeredAt: string }
export type DispatchState = "prepared" | "sent" | "accepted" | "settled" | "result_accepted";
export interface DispatchRecord {
  operationKey: string;
  handoffId: string;
  targetSessionId: string;
  marker: string;
  state: DispatchState;
  generation: number;
  cursor: string | null;
  recoveryPrompts: number;
}
export interface PhaseAttempt {
  phase: Phase;
  attempt: number;
  handoffId: string;
  targetSessionId: string;
  inputHead: string;
  input: ContractReference;
  feedback: readonly ArtifactReference[];
  acceptedResult?: ContractReference;
  dispatch: DispatchRecord;
}
export interface GateRecord { phase: "review" | "test"; head: string; result: ContractReference; acceptedAt: string; implementGeneration: number }
export interface RemediationCounters { review: number; test: number; total: number }
export interface TerminalError { code: string; message: string; at: string; evidence: readonly ArtifactReference[] }
export interface ResolvedInstallation { version: string; installationId: string }
export interface ResolvedPiInstallation extends ResolvedInstallation { executable: string }
export interface RuntimeResolution { schemaVersion: 1; runId: string; pi: ResolvedPiInstallation; llmWiki: ResolvedInstallation; resolvedAt: string }

export interface RunSnapshot {
  runId: string;
  version: number;
  state: WorkflowState;
  currentHead: string;
  implementGeneration: number;
  sessions: Partial<Record<Role, SessionRegistration>>;
  attempts: readonly PhaseAttempt[];
  acceptedResultPaths: readonly string[];
  committedRequestIds: readonly string[];
  gates: Partial<Record<"review" | "test", GateRecord>>;
  remediation: RemediationCounters;
  processLaunches: number;
  terminalError?: TerminalError;
  runtimeResolution?: RuntimeResolution;
}
export interface RunPrecondition { version: number; state?: WorkflowState; currentHead?: string }
export interface Lease { key: string; owner: string; expiresAt: number }
export interface Clock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }
export interface GitHeadObserver { observeHead(): Promise<string> }

export function isTerminal(state: WorkflowState): state is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export function operationKey(runId: string, handoffId: string, targetSessionId: string): string {
  return `${runId}:${handoffId}:${targetSessionId}`;
}
