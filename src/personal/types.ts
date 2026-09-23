import type { LaunchRetryPolicy, LaunchRecord, LaunchGeneration } from "./launch-retry.js";
import type { CorrectionLedger, SessionCustody } from "./correction.js";
import type { ReportCapture } from "./report-capture.js";
import type { ReportEvidencePort } from "./report-evidence.js";
import type { PersonalModelPolicy, PhaseProfile, ResolvedPhaseProfiles } from "./model-policy.js";
import type { LaunchEvidence } from "./launch-material.js";
import type { RunEvent } from "./run-events.js";

export type { PersonalModelPolicy, PhaseProfile, ResolvedPhaseProfiles } from "./model-policy.js";

export const PERSONAL_PHASES = ["implement", "verify"] as const;
export type PersonalPhase = (typeof PERSONAL_PHASES)[number];
export type PhaseStatus = "passed" | "failed";
export type RunStatus = "running" | "completed" | "failed" | "interrupted";
/** The coarse lifecycle shown by `squire status`. */
export type RunLifecycle = "launching" | "preparing" | "running" | "publishing" | "completed" | "failed" | "interrupted";
/** A detached launch is reserved before the child has been handed ownership. */
export type RunLaunchState = "reserved" | "started" | "failed";
export type RunPreparationState = "pending" | "started" | "ready" | "failed";
export type RunExecutionMode = "foreground" | "background";
export type RunStep = "launching" | "preparing" | PersonalPhase | "publishing" | "complete";
export interface Ticket {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly url?: string;
}

interface PhaseResultBase {
  readonly runId: string;
  readonly attempt: number;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly inputHead: string;
  readonly outputHead: string;
  readonly status: PhaseStatus;
  readonly summary: string;
  /** Resolved profile evidence added by the controller/runner for new runs. */
  readonly profile?: PhaseProfile;
}

export type ProjectWikiDisposition =
  | {
      readonly status: "updated";
      /** Canonical repository-relative paths changed between the run base and Implement HEAD. */
      readonly paths: readonly string[];
      readonly summary: string;
    }
  | {
      readonly status: "not_required";
      readonly reason: string;
    };

export interface ImplementPhaseResult extends PhaseResultBase {
  readonly phase: "implement";
  readonly details: {
    readonly changes: readonly string[];
    readonly projectWiki: ProjectWikiDisposition;
  };
}

export interface TestCommandEvidence {
  readonly command: string;
  readonly exitCode: number;
  readonly summary: string;
}
/** Host-observed deterministic command output, distinct from model attestation. */
export interface HostCommandEvidence {
  readonly command: string;
  readonly exitCode: number;
  readonly output: import("./report-evidence.js").ReportEvidence;
}

export interface VerifyPhaseResult extends PhaseResultBase {
  readonly phase: "verify";
  readonly details: { readonly findings: readonly string[]; readonly commands: readonly TestCommandEvidence[] };
}
export type PhaseResult = ImplementPhaseResult | VerifyPhaseResult;

export interface PhaseInput {
  readonly launchGeneration?: LaunchGeneration;
  /** Controller-owned accounting attribution; never selected by the model. */
  readonly telemetryAttribution?: { readonly trigger: "initial" | "retry" };
  /** Controller monotonic deadline, never reset by a launch generation. */
  readonly deadline?: number;
  readonly reportSession?: { readonly sessionId: string; readonly sessionFile: string };
  readonly runId: string;
  readonly ticket: Ticket;
  readonly repository: string;
  readonly baseBranch: string;
  readonly sandbox: string;
  readonly branch: string;
  readonly phase: PersonalPhase;
  readonly attempt: number;
  readonly expectedHead: string;
  /** Immutable ticket baseline used to evaluate cumulative wiki disposition. */
  readonly originalTicketBaseSha: string;
  /** The controller-resolved profile used for this phase's Pi process. */
  readonly profile: PhaseProfile;
  readonly contractDigest: string;
  readonly implementationEvidence?: ImplementPhaseResult["details"];
  /** Failed Verify feedback is untrusted task data, never an approval. */
  readonly correctionFeedback?: { readonly candidate: string; readonly findings: readonly string[]; readonly digest: string };
  readonly testCommands: readonly string[];
}

export interface PreparedWorkspace {
  readonly sandbox: string;
  readonly baseSha: string;
  readonly head: string;
}

export interface CandidateBundle {
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly baseSha: string;
  readonly head: string;
  readonly branch: string;
}

export interface PublicationInput {
  readonly contractDigest: string;
  readonly runId: string;
  readonly ticket: Ticket;
  readonly repository: string;
  readonly baseBranch: string;
  readonly branch: string;
  readonly head: string;
  readonly bundle: CandidateBundle;
  readonly phases: Readonly<Record<PersonalPhase, PhaseResult>>;
}

export interface PublicationResult {
  readonly url: string;
  readonly number?: number;
  readonly reused: boolean;
}

export interface PersonalRunState {
  readonly launchRetryPolicy?: LaunchRetryPolicy;
  readonly launchGenerations?: readonly LaunchRecord[];
  readonly correction?: CorrectionLedger;
  readonly verifyCommands?: readonly HostCommandEvidence[];
  readonly reports?: Readonly<Partial<Record<PersonalPhase, import("./report-evidence.js").ReportEvidence>>>;
  readonly schemaVersion: 2;
  readonly contract: { readonly ticket: Ticket; readonly digest: string } | null;
  readonly candidate: string | null;
  readonly verifyDisposition: "not_run" | "passed" | "failed";
  readonly publicationState: "not_started" | "publishing" | "published" | "failed";
  readonly ciDisposition: "pending";
  readonly mergeDisposition: "not_merged";
  readonly terminalReason: string | null;
  readonly version: number;
  readonly runId: string;
  readonly ticketId: string;
  readonly ticketTitle: string;
  readonly status: RunStatus;
  readonly step: RunStep;
  /** Missing on legacy captured runs; immutable for new supervised lifecycles. */
  /** Additive lifecycle evidence. It is absent on published legacy v1 files. */
  readonly lifecycle?: RunLifecycle;
  readonly launchState?: RunLaunchState;
  readonly preparationState?: RunPreparationState;
  readonly executionMode?: RunExecutionMode;
  readonly startedAt?: string;
  readonly endedAt?: string | null;
  readonly controllerPid?: number | null;
  readonly stdoutPath?: string | null;
  readonly stderrPath?: string | null;
  /** Immutable source identity captured before a detached child is spawned. */
  readonly repositoryPath?: string;
  readonly sourceRef?: string;
  /** Exact commit bound for a background launch when the workspace supports it. */
  readonly sourceSha?: string;
  /** Absolute config pathname bound at detached handoff; additive for legacy state. */
  readonly launchConfigPath?: string;
  readonly launchConfigDigest?: string;
  readonly launchEvidence?: LaunchEvidence;
  readonly sandbox: string;
  readonly repository: string;
  readonly baseBranch: string;
  readonly baseSha: string | null;
  readonly branch: string;
  /** Resolved once at run creation and immutable for the life of the run. */
  readonly profiles?: ResolvedPhaseProfiles;
  readonly head: string | null;
  readonly sessions: Readonly<Partial<Record<PersonalPhase, string>>>;
  readonly attempts: Readonly<Record<PersonalPhase, number>>;
  readonly results: Readonly<Partial<Record<PersonalPhase, PhaseResult>>>;
  readonly prUrl: string | null;
  readonly lastError: string | null;
  /** Durable, actionable reservation cleanup outcome when release is blocked or unverifiable. */
  readonly reservationCleanupFailure?: string;
  readonly updatedAt: string;
}

export interface RunRequest {
  readonly ticketId: string;
  readonly repository: string;
  readonly repositoryPath: string;
  readonly sourceRef: string;
  readonly baseBranch: string;
  /** Optional caller-supplied policy; the approved policy is used otherwise. */
  readonly modelPolicy?: PersonalModelPolicy;
}

export interface TicketPort {
  get(ticketId: string, signal?: AbortSignal): Promise<Ticket>;
}

export interface ProjectWikiDiffInput {
  readonly sandbox: string;
  readonly baseSha: string;
  readonly head: string;
}

export interface WorkspacePort {
  /** Resolve a mutable source ref before detached handoff when supported. */
  resolveSource?(input: { readonly repositoryPath: string; readonly sourceRef: string }, signal?: AbortSignal): Promise<string>;
  prepare(input: { readonly runId: string; readonly ticketId: string; readonly sandbox: string; readonly branch: string; readonly repositoryPath: string; readonly sourceRef: string; readonly expectedBaseSha?: string }, signal?: AbortSignal): Promise<PreparedWorkspace>;
  assertRuntimeParity?(sandbox: string, signal?: AbortSignal): Promise<void>;
  assertDescendant?(sandbox: string, base: string, head: string, signal?: AbortSignal): Promise<void>;
  currentHead(sandbox: string, signal?: AbortSignal): Promise<string>;
  assertClean(sandbox: string, signal?: AbortSignal): Promise<void>;
  /** Trusted, single-use transition from a sealed Verify workspace to an editable next attempt. */
  prepareCorrection?(input: { readonly sandbox: string; readonly baseSha: string; readonly candidate: string }, signal?: AbortSignal): Promise<void>;
  /** Remove ignored build products between corrective Implement and its fresh Verify. */
  isolateVerifyOutputs?(sandbox: string, head: string, signal?: AbortSignal): Promise<void>;
  /**
   * Return the committed `.llm-wiki` files changed from the run base to a
   * candidate HEAD. Implementations must inspect only the target worktree.
   * This is optional for old embedders, but the personal controller fails
   * closed when it is unavailable for a new run.
   */
  committedProjectWikiPaths?(input: ProjectWikiDiffInput, signal?: AbortSignal): Promise<readonly string[]>;
  /** Compatibility spelling for adapters that expose the operation as a diff. */
  projectWikiDiff?(input: ProjectWikiDiffInput, signal?: AbortSignal): Promise<readonly string[]>;
  exportBundle(input: { readonly runId: string; readonly sandbox: string; readonly branch: string; readonly baseSha: string; readonly head: string }, signal?: AbortSignal): Promise<CandidateBundle>;
}

export interface PhasePort {
  telemetryTerminal?(state: PersonalRunState): Promise<void | { readonly complete: boolean }>;
  telemetrySettled?(result: PhaseResult): Promise<void>;
  readonly reportEvidence?: ReportEvidencePort;
  /** Internal transport envelope, never a model-authored result field. */
  reportCapture?(result: PhaseResult): ReportCapture | undefined;
  commandEvidence?(result: PhaseResult): readonly HostCommandEvidence[] | undefined;
  /** Move both model-writable sessions into bounded, private host custody before unsealing. */
  archiveCorrectionSessions?(input: { readonly runId: string; readonly sandbox: string; readonly implement: ImplementPhaseResult; readonly verify: VerifyPhaseResult }, signal?: AbortSignal): Promise<{ readonly implement: SessionCustody; readonly verify: SessionCustody }>;
  run(input: PhaseInput, signal?: AbortSignal): Promise<PhaseResult>;
}

export interface PublicationPort {
  publish(input: PublicationInput, signal?: AbortSignal): Promise<PublicationResult>;
}

export type ReservationObservation =
  | { readonly kind: "absent"; readonly snapshot: string }
  | { readonly kind: "owner"; readonly runId: string; readonly pid: number; readonly stage: "reserve" | "claim"; readonly transition: boolean; readonly snapshot: string }
  | { readonly kind: "ambiguous"; readonly reason: string };

export interface RunStatePort {
  create(state: PersonalRunState): Promise<void>;
  save(state: PersonalRunState): Promise<void>;
  findActive(ticketId: string): Promise<PersonalRunState | undefined>;
  /** Optional atomic ticket reservation implemented by the JSON store. */
  reserve?(state: PersonalRunState): Promise<void>;
  /**
   * Atomically claim a reserved background state and its ticket reservation.
   * Implementations must reject without changing state when another owner has
   * won the reserved-to-started transition.
   */
  claimReserved?(state: PersonalRunState): Promise<void>;
  /**
   * Atomically terminalize an unclaimed background reservation and release it.
   * This is used for pre-handoff/bootstrap failures so a losing claimant
   * cannot overwrite a started child.
   */
  failReserved?(state: PersonalRunState): Promise<void>;
  /** Bind the exact source commit while a background reservation is unclaimed. */
  bindSource?(state: PersonalRunState): Promise<void>;
  /** Release only the reservation owned by this run after terminal persistence. */
  release?(ticketId: string, runId: string): Promise<void>;
  /** Read/query methods are optional for in-memory foreground embedders. */
  read?(runId: string): Promise<PersonalRunState | undefined>;
  findByTicket?(ticketId: string): Promise<readonly PersonalRunState[]>;
  observeReservation?(ticketId: string): Promise<ReservationObservation>;
  reservationOwner?(ticketId: string): Promise<string | undefined>;
  /** Optional durable event outbox read surface used by non-LLM consumers. */
  readEvents?(runId: string): Promise<readonly RunEvent[]>;
  /** The directory watched by consumers; state and event files are replaced atomically. */
  readonly eventDirectory?: string;
}
