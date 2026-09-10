import type { PersonalModelPolicy, PhaseProfile, PlanSelection, ResolvedPhaseProfiles } from "./model-policy.js";

export type { PersonalModelPolicy, PhaseProfile, PlanSelection, ResolvedPhaseProfiles } from "./model-policy.js";

export const PERSONAL_PHASES = ["plan", "implement", "review", "test", "retro"] as const;
export type PersonalPhase = (typeof PERSONAL_PHASES)[number];
export type PhaseStatus = "passed" | "remediation_required" | "failed";
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

export interface PlanPhaseResult extends PhaseResultBase {
  readonly phase: "plan";
  readonly details: { readonly steps: readonly string[] };
}

export interface ImplementPhaseResult extends PhaseResultBase {
  readonly phase: "implement";
  readonly details: { readonly changes: readonly string[] };
}

export interface ReviewPhaseResult extends PhaseResultBase {
  readonly phase: "review";
  readonly details: { readonly findings: readonly string[] };
}

export interface TestCommandEvidence {
  readonly command: string;
  readonly exitCode: number;
  readonly summary: string;
}

export interface TestPhaseResult extends PhaseResultBase {
  readonly phase: "test";
  readonly details: { readonly commands: readonly TestCommandEvidence[] };
}

export interface RetroPhaseResult extends PhaseResultBase {
  readonly phase: "retro";
  readonly details: {
    readonly lessons: readonly string[];
    readonly followUps: readonly string[];
  };
}

export type PhaseResult = PlanPhaseResult | ImplementPhaseResult | ReviewPhaseResult | TestPhaseResult | RetroPhaseResult;

export interface PhaseInput {
  readonly runId: string;
  readonly ticket: Ticket;
  readonly repository: string;
  readonly baseBranch: string;
  readonly sandbox: string;
  readonly branch: string;
  readonly phase: PersonalPhase;
  readonly attempt: number;
  readonly expectedHead: string;
  /** The controller-resolved profile used for this phase's Pi process. */
  readonly profile: PhaseProfile;
  readonly previous: Readonly<Partial<Record<PersonalPhase, PhaseResult>>>;
  readonly feedback: readonly string[];
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
  readonly schemaVersion: 1;
  readonly version: number;
  readonly runId: string;
  readonly ticketId: string;
  readonly ticketTitle: string;
  readonly status: RunStatus;
  readonly step: RunStep;
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
  readonly launchConfigDigest?: string;
  readonly sandbox: string;
  readonly repository: string;
  readonly baseBranch: string;
  readonly baseSha: string | null;
  readonly branch: string;
  /** Resolved once at run creation and immutable for the life of the run. */
  readonly profiles?: ResolvedPhaseProfiles;
  readonly planSelection?: PlanSelection;
  readonly head: string | null;
  readonly sessions: Readonly<Partial<Record<PersonalPhase, string>>>;
  readonly attempts: Readonly<Record<PersonalPhase, number>>;
  readonly results: Readonly<Partial<Record<PersonalPhase, PhaseResult>>>;
  readonly remediations: Readonly<Record<"review" | "test", number>>;
  readonly prUrl: string | null;
  readonly lastError: string | null;
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
  /** Backward-compatible flat profiles input; new callers should use modelPolicy. */
  readonly profiles?: Readonly<Record<PersonalPhase, PhaseProfile>>;
}

export interface TicketPort {
  get(ticketId: string, signal?: AbortSignal): Promise<Ticket>;
}

export interface WorkspacePort {
  prepare(input: { readonly runId: string; readonly ticketId: string; readonly sandbox: string; readonly branch: string; readonly repositoryPath: string; readonly sourceRef: string }, signal?: AbortSignal): Promise<PreparedWorkspace>;
  currentHead(sandbox: string, signal?: AbortSignal): Promise<string>;
  assertClean(sandbox: string, signal?: AbortSignal): Promise<void>;
  exportBundle(input: { readonly runId: string; readonly sandbox: string; readonly branch: string; readonly baseSha: string; readonly head: string }, signal?: AbortSignal): Promise<CandidateBundle>;
}

export interface PhasePort {
  run(input: PhaseInput, signal?: AbortSignal): Promise<PhaseResult>;
}

export interface PublicationPort {
  publish(input: PublicationInput, signal?: AbortSignal): Promise<PublicationResult>;
}

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
  /** Release only the reservation owned by this run after terminal persistence. */
  release?(ticketId: string, runId: string): Promise<void>;
  /** Read/query methods are optional for in-memory foreground embedders. */
  read?(runId: string): Promise<PersonalRunState | undefined>;
  findByTicket?(ticketId: string): Promise<readonly PersonalRunState[]>;
  reservationOwner?(ticketId: string): Promise<string | undefined>;
}
