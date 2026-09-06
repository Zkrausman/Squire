import type { RunSnapshot } from "../control/domain.js";
import type { ContractReference } from "../control/domain.js";

export type WorkflowConfig = Readonly<Record<string, unknown>>;
export interface SingleTicketIntakeRequest {
  readonly issueId: string;
  readonly expectedIdentifier: string;
  readonly workflowConfig: WorkflowConfig;
  readonly idempotencyKey: string;
  /** Explicitly rejected when present; useful for transport adapters that must not batch. */
  readonly issues?: never;
  readonly issueIds?: never;
}
export interface LinearLabelObservation { readonly name: string; }
export interface LinearIssueObservation {
  readonly id: string;
  readonly identifier: string;
  readonly teamId: string;
  readonly stateId: string;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly labels: readonly (string | LinearLabelObservation)[];
  readonly url: string;
}
export interface LinearIssueClient { fetchIssue(issueId: string): Promise<LinearIssueObservation>; }
export interface BaseRefObservation { readonly baseSha: string; readonly objectFormat: "sha1" | "sha256"; }
export interface BaseRefResolver {
  resolve(repository: { readonly owner: string; readonly name: string; readonly cloneUrl: string; readonly baseBranch: string; readonly objectFormat: "sha1" | "sha256" }): Promise<BaseRefObservation>;
}
export interface NormalizedTicketArtifactWriter {
  writeCreateOnly(relativePath: string, bytes: Uint8Array): Promise<ContractReference>;
  readExact?(reference: ContractReference): Promise<Buffer>;
}
export interface IntakeResult { readonly runId: string; readonly snapshot: RunSnapshot; readonly artifact: ContractReference; readonly created: boolean; }
export class IntakeError extends Error { constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "IntakeError"; } }
export class IntakeValidationError extends IntakeError { constructor(message: string) { super(message); this.name = "IntakeValidationError"; } }
export class ActiveRunConflictError extends IntakeError { constructor(readonly linearIssueId: string, readonly activeRunId: string) { super(`Linear issue already has an active workflow run: ${activeRunId}`); this.name = "ActiveRunConflictError"; } }
export class IntakeIdempotencyConflictError extends IntakeError { constructor(message = "intake idempotency identity conflicts with the existing run") { super(message); this.name = "IntakeIdempotencyConflictError"; } }
export class IntakeArtifactConflictError extends IntakeError { constructor(message = "immutable normalized-ticket artifact conflicts with the requested intake") { super(message); this.name = "IntakeArtifactConflictError"; } }
