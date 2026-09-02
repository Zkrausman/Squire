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
export type ProcessState = "registered" | "launching" | "live" | "exited" | "failed";
export interface SessionRegistration {
  runId: string;
  role: Role;
  sessionId: string;
  sessionFile: string;
  processGeneration: number;
  processState?: ProcessState;
  processIdentity?: string;
  registeredAt: string;
}
export type ProcessAllocationState = "reserved" | "spawning" | "spawned" | "termination_failed" | "failed";
/** Fenced process ownership. Any state after reserved is fail-closed until exact recovery. */
export interface ProcessAllocation {
  role: Role;
  owner: string;
  fencingToken: number;
  generation: number;
  state: ProcessAllocationState;
  allocatedAt: string;
  sessionId?: string;
  sessionFile?: string;
  processIdentity?: string;
}
/** Exact-token durable retention when a known process could not be observed terminated. */
export interface ProcessAllocationRetention {
  role: Role;
  failedOwner: string;
  failedFencingToken: number;
  generation: number;
  processIdentity: string;
}
/** Exact-token compensating cleanup after the owner's asynchronous side effect settled. */
export interface ProcessAllocationRecovery {
  role: Role;
  failedOwner: string;
  failedFencingToken: number;
  generation?: number;
  processIdentity?: string;
  processExited: boolean;
}
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
  launchCount?: number;
  deadlineAt?: number;
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
  accepted?: AcceptedPhaseResult;
  dispatch: DispatchRecord;
}
export interface AcceptedPhaseResult {
  reference: ContractReference;
  phase: Phase;
  handoffId: string;
  attempt: number;
  sessionId: string;
  status: "pass" | "remediation_required" | "failed";
  inputHead: string;
  outputHead: string;
  completedAt: string;
  acceptedAt: string;
  implementGeneration: number;
}
export interface GateRecord { phase: "review" | "test"; head: string; result: ContractReference; acceptedAt: string; completedAt: string; implementGeneration: number; attempt: number }
export interface RemediationCounters { review: number; test: number; total: number }
export interface TerminalError { code: string; message: string; at: string; evidence: readonly ArtifactReference[] }
export interface ResolvedInstallation {
  version: string;
  installationId: string;
  /** Trusted absolute installation root retained so restart preparation never resolves latest. */
  root?: string;
}
export interface ResolvedPiInstallation extends ResolvedInstallation { executable: string }
/**
 * An authoritative model-registry result. Both installation identities bind the
 * capability to the exact Pi/wiki runtime observation that was persisted for a
 * run; a model name by itself is never sufficient evidence.
 */
export interface RuntimeModelCapability {
  provider: string;
  model: string;
  reasoningCapable: boolean;
  piInstallationId: string;
  wikiInstallationId: string;
}
export interface RuntimeResolution {
  schemaVersion: 1;
  runId: string;
  pi: ResolvedPiInstallation;
  llmWiki: ResolvedInstallation;
  /** Exact capability records are persisted with the runtime observation. */
  modelCapabilities: readonly RuntimeModelCapability[];
  resolvedAt: string;
}

export interface RunSnapshot {
  runId: string;
  version: number;
  state: WorkflowState;
  currentHead: string;
  implementGeneration: number;
  implementCompletedAt?: string;
  sessions: Partial<Record<Role, SessionRegistration>>;
  processAllocations?: Partial<Record<Role, ProcessAllocation>>;
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
export interface Lease { key: string; owner: string; fencingToken: number; expiresAt: number }
export interface LeaseGuard { key: string; owner: string; fencingToken: number; now: number }
export interface Clock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }
export interface GitHeadObserver { observeHead(): Promise<string> }

export function isTerminal(state: WorkflowState): state is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export function operationKey(runId: string, handoffId: string, targetSessionId: string): string {
  return `${runId}:${handoffId}:${targetSessionId}`;
}
