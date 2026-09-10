export const PERSONAL_PHASES = ["plan", "implement", "review", "test"] as const;
export type PersonalPhase = (typeof PERSONAL_PHASES)[number];
export type PhaseStatus = "passed" | "remediation_required" | "failed";
export type RunStatus = "running" | "completed" | "failed" | "interrupted";
export type RunStep = "preparing" | PersonalPhase | "publishing" | "complete";

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

export type PhaseResult = PlanPhaseResult | ImplementPhaseResult | ReviewPhaseResult | TestPhaseResult;

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
  readonly sandbox: string;
  readonly repository: string;
  readonly baseBranch: string;
  readonly baseSha: string | null;
  readonly branch: string;
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
}
