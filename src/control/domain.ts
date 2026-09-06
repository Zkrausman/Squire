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
  /** Optional in published v1 observations; materialization requires exact evidence at its boundary. */
  modelCapabilities?: readonly RuntimeModelCapability[];
  resolvedAt: string;
}

export interface RunTerminalFence {
  runId: string;
  owner: string;
  fencingToken: number;
  acquiredAt: string;
  state: "held" | "removed";
}
/** Durable controller preparation ownership held for the complete filesystem operation. */
export interface RunPreparationLease {
  runId: string;
  owner: string;
  fencingToken: number;
  acquiredAt: string;
  state: "held";
}

/** Durable identity projections owned by the intake/ledger boundary.  These
 * values are observations of immutable external authority; they do not
 * replace the immutable artifact they reference. */
export interface RunIdentity {
  linearIssueId: string;
  linearIdentifier: string;
  linearTeamId: string;
  linearStateId: string;
  repositoryOwner: string;
  repositoryName: string;
  baseBranch: string;
  baseSha: string;
  objectFormat: "sha1" | "sha256";
  normalizedTicket: ContractReference;
  normalizedTicketDigest: string;
  /** The spelling published by normalized-ticket v1. */
  contractFeatureBranch: string;
  /** The spelling accepted by AIDEV-222 for physical Git operations. */
  physicalFeatureBranch: string;
  intakeIdempotencyKey: string;
}

export interface RunTimestamps {
  createdAt: string;
  updatedAt: string;
  terminalAt?: string;
  expiresAt?: string;
  successRetentionUntil?: string;
  failureRetentionUntil?: string;
}

export type ExternalResourceKind =
  | "linear_issue" | "sandbox" | "herdr_workspace" | "herdr_tab"
  | "herdr_root_pane" | "herdr_runner" | "git_branch" | "git_workspace"
  | "git_bundle" | "pi_session" | "github_pr";
export type ExternalResourceLifecycle = "planned" | "creating" | "bound" | "retained" | "deleted" | "blocked";
export interface ExternalResourceBinding {
  kind: ExternalResourceKind;
  scope: string;
  role?: Role;
  deterministicKey: string;
  deterministicName: string;
  externalId?: string;
  generation: number;
  state: ExternalResourceLifecycle;
  metadata?: Readonly<Record<string, unknown>>;
  observedAt: string;
}

export interface DeliveryIdentifiers {
  repositoryOwner?: string;
  repositoryName?: string;
  featureBranch?: string;
  bundlePath?: string;
  bundleDigest?: string;
  githubRepositoryId?: string;
  githubNodeId?: string;
  pullRequestNumber?: number;
  pullRequestNodeId?: string;
  pullRequestUrl?: string;
  observedHead?: string;
  approvalObservationId?: string;
  checksObservationId?: string;
}

export interface OperatorErrorRecord {
  errorId: string;
  runId?: string;
  code: string;
  message: string;
  component: string;
  retryable: boolean;
  operatorActionRequired: boolean;
  evidence: readonly ArtifactReference[];
  fingerprint: string;
  firstOccurredAt: string;
  lastOccurredAt: string;
  occurrenceCount: number;
  resolvedAt?: string;
}
export type OperatorErrorSummary = Pick<OperatorErrorRecord, "errorId" | "code" | "message" | "component" | "retryable" | "operatorActionRequired" | "occurrenceCount" | "lastOccurredAt">;

export interface ReconciliationStatus {
  generation: number;
  status: "observing" | "recovering" | "ready" | "blocked";
  controllerOwner: string;
  fencingToken: number;
  startedAt: string;
  completedAt?: string;
  blockingErrorId?: string;
}

/** A permit is intentionally a branded, non-serializable value.  External
 * adapters must receive a permit from the reconciled gate immediately before
 * a side effect; a database row or a caller-supplied object is not enough. */
export interface SideEffectPermit {
  readonly runId: string;
  readonly databaseIdentity: string;
  readonly reconciliationGeneration: number;
  readonly controllerOwner: string;
  readonly fencingToken: number;
  readonly issuedAt: number;
  readonly [SIDE_EFFECT_PERMIT_BRAND]: true;
}
export const SIDE_EFFECT_PERMIT_BRAND: unique symbol = Symbol("squire.side-effect-permit");
export interface RunSideEffectGuard {
  require(runId: string): SideEffectPermit;
  assertValid(runId: string, permit: SideEffectPermit): void;
  invalidate(): void;
}

import type { GitWorkspaceRecord } from "../git/domain.js";

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
  /** Durable terminal lifecycle fence; held until sandbox/run removal. */
  terminalFence?: RunTerminalFence;
  /** Every materialize/verify operation must release its exact lease before teardown. */
  preparationLeases?: readonly RunPreparationLease[];
  /** AIDEV-222's operation state; RunQuiescenceAuthority remains the only lifecycle authority. */
  gitWorkspace?: GitWorkspaceRecord;
  /** Additive AIDEV-224 projections. Existing AIDEV-216 callers may omit them. */
  identity?: RunIdentity;
  timestamps?: RunTimestamps;
  resources?: readonly ExternalResourceBinding[];
  delivery?: DeliveryIdentifiers;
  lastError?: OperatorErrorSummary;
  operatorBlocked?: boolean;
  reconciliation?: ReconciliationStatus;
}
export interface RunPrecondition { version: number; state?: WorkflowState; currentHead?: string }
export interface Lease { key: string; owner: string; fencingToken: number; expiresAt: number }
export interface LeaseGuard { key: string; owner: string; fencingToken: number; now: number }
export interface Clock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }
export interface GitHeadObserver { observeHead(runId?: string): Promise<string> }

export function isTerminal(state: WorkflowState): state is TerminalState {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

export function operationKey(runId: string, handoffId: string, targetSessionId: string): string {
  return `${runId}:${handoffId}:${targetSessionId}`;
}
