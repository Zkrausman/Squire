import type { ArtifactReference, ContractReference, PhaseAttempt, SessionRegistration } from "../control/domain.js";
import type { ReadyGitWorkspace } from "../git/domain.js";

export const PHASE_INPUT_SCHEMA_ID = "urn:squire:contracts:v1:phase-input" as const;
export const PHASE_TRIGGER_SCHEMA_ID = "urn:squire:contracts:v1:phase-trigger" as const;
export const IMPLEMENTATION_PLAN_SCHEMA_ID = "urn:squire:contracts:v1:implementation-plan" as const;
export const PHASE_RESULT_SCHEMA_ID = "urn:squire:contracts:v1:phase-result" as const;
export const NORMALIZED_TICKET_SCHEMA_ID = "urn:squire:contracts:v1:normalized-ticket" as const;
export const WORKFLOW_CONFIG_SCHEMA_ID = "urn:squire:contracts:v1:workflow-config" as const;

export interface PhaseInputDocument {
  readonly schemaVersion: 1;
  readonly handoffId: string;
  readonly runId: string;
  readonly phase: "plan" | "implement" | "review" | "test";
  readonly targetSessionId: string;
  readonly attempt: number;
  readonly inputHead: string;
  readonly ticket: ContractReference;
  readonly configuration: ContractReference;
  readonly artifacts: readonly ContractReference[];
  readonly feedback: readonly ContractReference[];
  readonly createdAt: string;
}

export interface PhaseTriggerDocument {
  readonly schemaVersion: 1;
  readonly handoffId: string;
  readonly runId: string;
  readonly phase: "plan" | "implement" | "review" | "test";
  readonly attempt: number;
  readonly targetSessionId: string;
  readonly inputHead: string;
  readonly inputArtifact: ContractReference;
}

export interface NormalizedTicketDocument {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly source: "linear";
  readonly ticket: {
    readonly id: string;
    readonly identifier: string;
    readonly teamId: string;
    readonly stateId: string;
    readonly title: string;
    readonly description: string;
    readonly acceptanceCriteria: readonly string[];
    readonly labels: readonly string[];
    readonly url: string;
  };
  readonly repository: {
    readonly owner: string;
    readonly name: string;
    readonly baseBranch: string;
    readonly baseSha: string;
    readonly featureBranch: string;
  };
  readonly normalizedAt: string;
}

export interface WorkflowConfigDocument {
  readonly schemaVersion: 1;
  readonly ticket: { readonly provider: "linear"; readonly issueId: string; readonly identifier: string };
  readonly repository: { readonly owner: string; readonly name: string; readonly cloneUrl: string; readonly baseBranch: string; readonly objectFormat: "sha1" | "sha256" };
  readonly pi: {
    readonly roles: Record<string, {
      readonly provider: string;
      readonly model: string;
      readonly thinking: string;
      readonly timeoutSeconds: number;
      readonly instructionsPath: string;
    }>;
    readonly wiki?: { readonly provider: string; readonly model: string; readonly thinking: string };
  };
  readonly validation: { readonly commands: readonly ValidationCommand[] };
  readonly [key: string]: unknown;
}

export interface ValidationCommand {
  readonly id: string;
  readonly command: readonly string[];
  readonly cwd: string;
  readonly timeoutSeconds: number;
  readonly required: boolean;
}

export interface ImplementationPlanStep {
  readonly id: string;
  readonly description: string;
  readonly affectedPaths: readonly string[];
  readonly acceptanceCriteria: readonly string[];
}

export interface ImplementationPlanRisk {
  readonly risk: string;
  readonly mitigation: string;
}

export interface ImplementationPlanDocument {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly ticketIdentifier: string;
  readonly inputHead: string;
  readonly summary: string;
  readonly assumptions: readonly string[];
  readonly steps: readonly ImplementationPlanStep[];
  readonly risks: readonly ImplementationPlanRisk[];
  readonly validationCommandIds: readonly string[];
}

export interface PlanToolInput extends ImplementationPlanDocument {
  readonly disposition: "pass" | "blocked";
  readonly questions?: readonly string[];
}

export interface PlanSubmission {
  readonly disposition: "pass" | "blocked";
  readonly plan: ImplementationPlanDocument;
  readonly questions: readonly string[];
}

/**
 * The controller-owned AIDEV-222 identity used by Plan.  The full
 * ReadyGitWorkspace is accepted as an alias, but Plan never derives branch or
 * repository identities from a string supplied by the Pi session.
 */
export interface PlanReadinessIdentity {
  readonly runId: string;
  readonly headSha: string;
  readonly featureBranch: string;
  readonly baseSha?: string;
  readonly repository?: { readonly owner: string; readonly name: string };
  readonly baseBranch?: string;
  readonly spec?: ContractReference;
  readonly manifest?: ContractReference;
  readonly objectFormat?: "sha1" | "sha256";
  readonly workspace?: string;
  readonly identity?: string;
}

/**
 * Controller observations for one Plan handoff.  Alias fields are retained at
 * this TypeScript boundary so adapters can name the same trusted facts
 * differently; PlanInputValidator requires one unambiguous value for every
 * fact before it will return.
 */
export interface PlanAttemptContext {
  readonly runId: string;
  readonly handoffId: string;
  readonly attempt: number;
  readonly phase?: "plan";
  readonly targetSessionId: string;
  readonly inputHead: string;
  readonly currentHead?: string;
  readonly baseSha?: string;
  readonly repository?: { readonly owner: string; readonly name: string; readonly baseBranch: string; readonly featureBranch: string };
  readonly normalizedTicket?: ContractReference;
  readonly configuration?: ContractReference;
  readonly phaseInput?: ContractReference;
  readonly phaseInputReference?: ContractReference;
  readonly inputArtifact?: ContractReference;
  readonly registration?: SessionRegistration;
  readonly planRegistration?: SessionRegistration;
  readonly sessionRegistration?: SessionRegistration;
  readonly readiness?: PlanReadinessIdentity | ReadyGitWorkspace;
  readonly workspaceReadiness?: PlanReadinessIdentity | ReadyGitWorkspace;
  readonly aidev222?: PlanReadinessIdentity | ReadyGitWorkspace;
  readonly latestAttempt?: Pick<PhaseAttempt, "phase" | "attempt" | "handoffId" | "targetSessionId" | "inputHead">;
  readonly ticketIdentifier?: string;
  readonly validationCommandIds?: readonly string[];
  readonly requiredValidationCommandIds?: readonly string[];
}

export interface ValidatedPlanInput {
  readonly reference: ContractReference;
  readonly input: PhaseInputDocument;
  readonly ticket: NormalizedTicketDocument;
  readonly configuration: WorkflowConfigDocument;
  readonly context: PlanAttemptContext;
}

export interface PlanPublicationContext {
  readonly runId: string;
  readonly handoffId: string;
  readonly attempt: number;
  readonly targetSessionId: string;
  readonly inputHead: string;
  readonly inputArtifact: ContractReference;
  readonly ticketIdentifier: string;
  readonly completedAt: string;
  readonly phaseInputDigest?: string;
  readonly allowedValidationCommandIds?: readonly string[];
  readonly requiredValidationCommandIds?: readonly string[];
  readonly ticketRoot?: string;
}

export interface PlanPublicationResult {
  readonly planReference: ContractReference;
  readonly resultReference: ContractReference;
  readonly evidenceReference: ArtifactReference & { readonly kind: "report" };
  readonly result: Record<string, unknown>;
}

export const PLAN_TOOL_NAME = "squire_submit_plan" as const;
export const PLAN_EXTENSION_RELATIVE_PATH = "extensions/squire-plan.mjs" as const;
/**
 * Pi's stock filesystem tools accept absolute paths. They are deliberately
 * not enabled for Plan; the empty tuple is an explicit compatibility seam for
 * callers that used the old constant name.
 */
export const PLAN_ALLOWED_BUILTIN_TOOLS = [] as const;
/** Controller-owned filesystem tools. Every path is resolved relative to the
 * trusted workspace and checked against the run-bound allowlist. */
export const PLAN_ALLOWED_PATH_TOOLS = ["squire_plan_read", "squire_plan_grep", "squire_plan_find", "squire_plan_ls"] as const;
export const PLAN_FILESYSTEM_POLICY_ID = "squire-plan-filesystem-v1" as const;
export const PLAN_FILESYSTEM_POLICY_SHA256 = "e955c149b9e92a504ddb45676c7046a6271094dbc1e71a465d4e4c0cdc21ae2f" as const;
export const PLAN_ALLOWED_WIKI_TOOLS = ["wiki_recall"] as const;
export const PLAN_ALLOWED_TOOLS = [...PLAN_ALLOWED_PATH_TOOLS, ...PLAN_ALLOWED_WIKI_TOOLS, PLAN_TOOL_NAME] as const;
export const PLAN_TOOL_MAX = Object.freeze({
  summary: 16_384,
  assumption: 2_048,
  assumptions: 32,
  stepDescription: 8_192,
  steps: 64,
  path: 1_024,
  pathsPerStep: 128,
  criterion: 4_096,
  criteriaPerStep: 64,
  risks: 64,
  risk: 4_096,
  mitigation: 4_096,
  validationIds: 128,
  questions: 32,
  question: 4_096,
});

export function sameContractReference(left: ContractReference | undefined, right: ContractReference | undefined): boolean {
  return left !== undefined && right !== undefined && left.path === right.path && left.sha256 === right.sha256 && left.schemaId === right.schemaId;
}

export function readinessIdentity(value: PlanReadinessIdentity | ReadyGitWorkspace | undefined): PlanReadinessIdentity | undefined {
  if (!value) return undefined;
  return value as PlanReadinessIdentity;
}
