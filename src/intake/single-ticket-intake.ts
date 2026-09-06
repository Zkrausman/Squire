import { createHash } from "node:crypto";
import { assertBaseBranch, assertCredentialFreeHttpsCloneUrl, assertFullObjectId, assertRepositoryPart, assertTicketIdentifier } from "../git/identity.js";
import type { ContractReference, RunIdentity, RunSnapshot } from "../control/domain.js";
import { V1ArtifactValidator } from "../contracts/v1-artifact-validator.js";
import { SqliteIntakeStore } from "../sqlite/sqlite-intake-store.js";
import { IntakeArtifactConflictError, IntakeError, IntakeValidationError, type BaseRefResolver, type IntakeResult, type LinearIssueClient, type LinearIssueObservation, type SingleTicketIntakeRequest, type WorkflowConfig } from "./domain.js";
import { deriveContractFeatureBranch, derivePhysicalFeatureBranch, deriveRunId } from "./naming.js";
import { FileNormalizedTicketArtifactWriter, NORMALIZED_TICKET_SCHEMA_ID, normalizedTicketDigest, normalizedTicketPath, serializeNormalizedTicket, type NormalizedTicketDocument, validateNormalizedTicketDocument, validatePublishedNormalizedTicket } from "./normalized-ticket-artifact.js";

const MAX_TITLE = 4_096;
const MAX_DESCRIPTION = 1_000_000;
const MAX_CRITERIA = 200;
const MAX_LABELS = 100;
const MAX_LABEL = 256;

export interface SingleTicketIntakeOptions {
  readonly linear: LinearIssueClient;
  readonly baseResolver: BaseRefResolver;
  readonly store: SqliteIntakeStore;
  readonly artifactWriter?: FileNormalizedTicketArtifactWriter | import("./domain.js").NormalizedTicketArtifactWriter;
  readonly artifactRoot?: string;
  readonly validator?: V1ArtifactValidator;
  readonly clock?: { now(): number };
}

/** Exactly-one, authoritative Linear intake.  It intentionally has no batch or
 * webhook-server method; webhook transport calls this scalar operation. */
export class SingleTicketIntakeService {
  readonly #linear: LinearIssueClient;
  readonly #baseResolver: BaseRefResolver;
  readonly #store: SqliteIntakeStore;
  readonly #writer: NonNullable<SingleTicketIntakeOptions["artifactWriter"]>;
  readonly #validator: V1ArtifactValidator | undefined;
  readonly #clock: { now(): number };
  constructor(options: SingleTicketIntakeOptions) {
    if (!options.linear || typeof options.linear.fetchIssue !== "function") throw new IntakeValidationError("Linear issue client is required");
    if (!options.baseResolver || typeof options.baseResolver.resolve !== "function") throw new IntakeValidationError("trusted base resolver is required");
    this.#linear = options.linear; this.#baseResolver = options.baseResolver; this.#store = options.store;
    if (!this.#store) throw new IntakeValidationError("durable intake store is required");
    if (options.artifactWriter) this.#writer = options.artifactWriter;
    else if (options.artifactRoot) this.#writer = new FileNormalizedTicketArtifactWriter(options.artifactRoot);
    else throw new IntakeValidationError("immutable artifact root or writer is required");
    this.#validator = options.validator;
    this.#clock = options.clock ?? { now: () => Date.now() };
  }

  async accept(request: SingleTicketIntakeRequest): Promise<IntakeResult> {
    const input = validateRequest(request);
    const config = validateWorkflowConfig(input.workflowConfig);
    // Network and database side effects begin only after the scalar request and
    // complete config have passed structural and semantic validation.
    let issue: LinearIssueObservation;
    try { issue = await this.#linear.fetchIssue(input.issueId); } catch (error) { if (error instanceof IntakeValidationError) throw error; throw new IntakeValidationError("authoritative Linear issue lookup failed"); }
    validateIssue(issue, input, config);
    const repository = config.repository;
    let base: Awaited<ReturnType<BaseRefResolver["resolve"]>>;
    try { base = await this.#baseResolver.resolve(repository); } catch (error) { if (error instanceof IntakeValidationError) throw error; throw new IntakeValidationError("trusted repository base lookup failed"); }
    if (base.objectFormat !== repository.objectFormat) throw new IntakeValidationError("trusted base resolver object format disagrees with workflow config");
    assertFullObjectId(base.baseSha, base.objectFormat);
    const runId = deriveRunId(issue.id, { owner: repository.owner, name: repository.name }, input.idempotencyKey);
    const existingIntent = this.#store.getIntent(runId);
    if (existingIntent && (existingIntent.linearIssueId !== issue.id || existingIntent.idempotencyKey !== input.idempotencyKey)) throw new IntakeArtifactConflictError("deterministic run identity is already bound to another intake");
    const contractBranch = deriveContractFeatureBranch(issue.identifier, runId);
    const physicalBranch = derivePhysicalFeatureBranch(issue.identifier, runId);
    // Replays reuse the first trusted creation timestamp so the immutable
    // normalized-ticket bytes, and therefore its digest, remain identical.
    const normalizedAt = existingIntent?.snapshot.timestamps?.createdAt ?? new Date(this.#clock.now()).toISOString();
    const document: NormalizedTicketDocument = {
      schemaVersion: 1,
      runId,
      source: "linear",
      ticket: { id: issue.id, identifier: issue.identifier, teamId: issue.teamId, stateId: issue.stateId, title: issue.title.normalize("NFC"), description: issue.description.normalize("NFC"), acceptanceCriteria: normalizeCriteria(issue.acceptanceCriteria), labels: normalizeLabels(issue.labels), url: issue.url },
      repository: { owner: repository.owner, name: repository.name, baseBranch: repository.baseBranch, baseSha: base.baseSha, featureBranch: contractBranch },
      normalizedAt,
    };
    const validated = this.#validator ? this.#validator.validateDocument<NormalizedTicketDocument & Record<string, unknown>>(NORMALIZED_TICKET_SCHEMA_ID, document) as NormalizedTicketDocument : validateNormalizedDocument(document);
    const bytes = serializeNormalizedTicket(validated);
    const artifact: ContractReference = { path: normalizedTicketPath(runId), sha256: normalizedTicketDigest(bytes), schemaId: NORMALIZED_TICKET_SCHEMA_ID };
    const identity: RunIdentity = { linearIssueId: issue.id, linearIdentifier: issue.identifier, linearTeamId: issue.teamId, linearStateId: issue.stateId, repositoryOwner: repository.owner, repositoryName: repository.name, baseBranch: repository.baseBranch, baseSha: base.baseSha, objectFormat: base.objectFormat, normalizedTicket: artifact, normalizedTicketDigest: artifact.sha256, contractFeatureBranch: contractBranch, physicalFeatureBranch: physicalBranch, intakeIdempotencyKey: input.idempotencyKey };
    const snapshot: RunSnapshot = { runId, version: 0, state: "accepted", currentHead: base.baseSha, implementGeneration: 0, sessions: {}, attempts: [], acceptedResultPaths: [], committedRequestIds: [], gates: {}, remediation: { review: 0, test: 0, total: 0 }, processLaunches: 0, identity, timestamps: { createdAt: normalizedAt, updatedAt: normalizedAt } };
    const intent = this.#store.beginIntakeIntent({ runId, linearIssueId: issue.id, idempotencyKey: input.idempotencyKey, artifactPath: artifact.path, artifact, snapshot, status: "intent" });
    // A create-once writer may return the existing file only when its exact
    // bytes match.  It must never overwrite a path after a crash.
    const published = await this.#writer.writeCreateOnly(artifact.path, bytes);
    if (published.path !== artifact.path || published.sha256 !== artifact.sha256 || published.schemaId !== artifact.schemaId) throw new IntakeArtifactConflictError("artifact writer returned a substituted reference");
    const verified = await validatePublishedNormalizedTicket(published, this.#writer, this.#validator);
    if (!verified.bytes.equals(bytes) || verified.document.runId !== runId) throw new IntakeArtifactConflictError("published normalized-ticket bytes do not match the immutable intake");
    if (intent.status !== "committed") this.#store.markArtifactPublished(runId, artifact);
    return this.#store.commitIntake({ snapshot, artifact, linearIssueId: issue.id, idempotencyKey: input.idempotencyKey, occurredAt: normalizedAt });
  }
  intake(request: SingleTicketIntakeRequest): Promise<IntakeResult> { return this.accept(request); }
}
export const SingleTicketIntake = SingleTicketIntakeService;

function validateRequest(request: SingleTicketIntakeRequest): SingleTicketIntakeRequest {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new IntakeValidationError("intake accepts exactly one scalar request");
  const value = request as unknown as Record<string, unknown>;
  const allowed = new Set(["issueId", "expectedIdentifier", "workflowConfig", "idempotencyKey"]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new IntakeValidationError("intake request contains an unknown or batch selector");
  if (typeof value["issueId"] !== "string" || !isUuid(value["issueId"])) throw new IntakeValidationError("issueId must be one UUID");
  if (typeof value["expectedIdentifier"] !== "string") throw new IntakeValidationError("expectedIdentifier is required");
  if (typeof value["idempotencyKey"] !== "string" || (value["idempotencyKey"] as string).length < 1 || (value["idempotencyKey"] as string).length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(value["idempotencyKey"] as string)) throw new IntakeValidationError("idempotencyKey is invalid");
  if (!value["workflowConfig"] || typeof value["workflowConfig"] !== "object" || Array.isArray(value["workflowConfig"])) throw new IntakeValidationError("workflowConfig is required");
  return request;
}

interface ValidatedConfig {
  readonly ticket: { readonly provider: "linear"; readonly issueId: string; readonly identifier: string };
  readonly repository: { readonly owner: string; readonly name: string; readonly cloneUrl: string; readonly baseBranch: string; readonly objectFormat: "sha1" | "sha256" };
  readonly linear: { readonly teamId: string; readonly states: { readonly accepted: string; readonly inProgress: string; readonly awaitingHuman: string; readonly completed: string; readonly failed: string; readonly cancelled: string } };
  readonly sandbox: Readonly<Record<string, unknown>>;
}
function validateWorkflowConfig(raw: WorkflowConfig): ValidatedConfig {
  const value = object(raw, "workflow config");
  exact(value, ["schemaVersion", "ticket", "repository", "linear", "sandbox", "pi", "validation", "remediation", "artifactRetention", "github"], ["schemaVersion", "ticket", "repository", "linear", "sandbox", "pi", "validation", "remediation", "artifactRetention", "github"], "workflow config");
  if (value.schemaVersion !== 1) throw new IntakeValidationError("workflow config schemaVersion is unsupported");
  const ticket = object(value.ticket, "ticket"); exact(ticket, ["provider", "issueId", "identifier"], ["provider", "issueId", "identifier"], "ticket");
  const repository = object(value.repository, "repository"); exact(repository, ["owner", "name", "cloneUrl", "baseBranch", "objectFormat"], ["owner", "name", "cloneUrl", "baseBranch", "objectFormat"], "repository");
  const linear = object(value.linear, "linear"); exact(linear, ["teamId", "states"], ["teamId", "states"], "linear");
  const states = object(linear.states, "linear.states"); exact(states, ["accepted", "inProgress", "awaitingHuman", "completed", "failed", "cancelled"], ["accepted", "inProgress", "awaitingHuman", "completed", "failed", "cancelled"], "linear.states");
  if (ticket.provider !== "linear" || typeof ticket.issueId !== "string" || !isUuid(ticket.issueId) || typeof ticket.identifier !== "string") throw new IntakeValidationError("workflow ticket config is invalid");
  assertTicketIdentifier(ticket.identifier);
  if (typeof repository.owner !== "string" || typeof repository.name !== "string" || typeof repository.cloneUrl !== "string" || typeof repository.baseBranch !== "string" || (repository.objectFormat !== "sha1" && repository.objectFormat !== "sha256")) throw new IntakeValidationError("workflow repository config is invalid");
  assertRepositoryPart(repository.owner, "owner"); assertRepositoryPart(repository.name, "name");
  if (!/^https:\/\//u.test(repository.cloneUrl) || repository.cloneUrl.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(repository.cloneUrl)) throw new IntakeValidationError("repository clone URL is invalid");
  try { assertCredentialFreeHttpsCloneUrl(repository.cloneUrl, repository.owner, repository.name); } catch (error) { throw new IntakeValidationError(error instanceof Error ? error.message : "repository clone URL is not trusted"); }
  try { assertBaseBranch(repository.baseBranch); } catch (error) { throw new IntakeValidationError(error instanceof Error ? error.message : "repository base branch is invalid"); }
  const stateValues = ["accepted", "inProgress", "awaitingHuman", "completed", "failed", "cancelled"].map(key => states[key]);
  if (stateValues.some(state => typeof state !== "string" || !isUuid(state)) || new Set(stateValues).size !== stateValues.length) throw new IntakeValidationError("workflow Linear state IDs are invalid or duplicated");
  if (typeof linear.teamId !== "string" || !isUuid(linear.teamId)) throw new IntakeValidationError("workflow Linear team ID is invalid");

  const sandbox = object(value.sandbox, "sandbox"); exact(sandbox, ["template", "resources", "network", "retention"], ["template", "resources", "network", "retention"], "sandbox");
  const template = object(sandbox.template, "sandbox.template"); exact(template, ["name", "digest"], ["name", "digest"], "sandbox.template"); nonempty(template.name, "sandbox.template.name"); if (typeof template.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(template.digest)) throw new IntakeValidationError("sandbox template digest is invalid");
  const resources = object(sandbox.resources, "sandbox.resources"); exact(resources, ["cpus", "memoryMiB", "diskGiB"], ["cpus", "memoryMiB", "diskGiB"], "sandbox.resources"); integerAtLeast(resources.cpus, 1, "sandbox cpus"); integerAtLeast(resources.memoryMiB, 1_024, "sandbox memoryMiB"); integerAtLeast(resources.diskGiB, 10, "sandbox diskGiB");
  const network = object(sandbox.network, "sandbox.network"); exact(network, ["mode", "allowedHosts"], ["mode", "allowedHosts"], "sandbox.network"); if (!(["allow-all", "allowlist", "deny-all"] as unknown[]).includes(network.mode)) throw new IntakeValidationError("sandbox network mode is invalid"); if (!Array.isArray(network.allowedHosts) || network.allowedHosts.length > 256 || network.allowedHosts.some((host: unknown) => typeof host !== "string" || host.length < 1 || host.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(host)) || new Set(network.allowedHosts).size !== network.allowedHosts.length || (network.mode === "allowlist" ? network.allowedHosts.length < 1 : network.allowedHosts.length !== 0)) throw new IntakeValidationError("sandbox allowedHosts is invalid");
  const sandboxRetention = object(sandbox.retention, "sandbox.retention"); exact(sandboxRetention, ["onSuccessHours", "onFailureHours"], ["onSuccessHours", "onFailureHours"], "sandbox.retention"); integerAtLeast(sandboxRetention.onSuccessHours, 0, "sandbox success retention"); integerAtLeast(sandboxRetention.onFailureHours, 1, "sandbox failure retention");

  const pi = object(value.pi, "pi"); exact(pi, ["version", "roles", "wiki"], ["roles", "wiki"], "pi"); if (pi.version !== undefined && (typeof pi.version !== "string" || !/^\d+\.\d+\.\d+$/u.test(pi.version))) throw new IntakeValidationError("Pi version is invalid");
  const roles = object(pi.roles, "pi.roles"); const roleNames = ["orchestrator", "plan", "implement", "review", "test"] as const; exact(roles, roleNames, roleNames, "pi.roles"); for (const role of roleNames) { const roleConfig = object(roles[role], `pi.roles.${role}`); exact(roleConfig, ["provider", "model", "thinking", "timeoutSeconds", "instructionsPath"], ["provider", "model", "thinking", "timeoutSeconds", "instructionsPath"], `pi.roles.${role}`); nonempty(roleConfig.provider, `${role}.provider`); nonempty(roleConfig.model, `${role}.model`); if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(roleConfig.thinking as never)) throw new IntakeValidationError(`${role}.thinking is invalid`); integerAtLeast(roleConfig.timeoutSeconds, 1, `${role}.timeoutSeconds`); assertSandboxPath(roleConfig.instructionsPath, `${role}.instructionsPath`); }
  const wiki = object(pi.wiki, "pi.wiki"); exact(wiki, ["provider", "model", "thinking"], ["provider", "model", "thinking"], "pi.wiki"); nonempty(wiki.provider, "pi.wiki.provider"); nonempty(wiki.model, "pi.wiki.model"); if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(wiki.thinking as never)) throw new IntakeValidationError("pi.wiki.thinking is invalid");

  const validation = object(value.validation, "validation"); exact(validation, ["commands"], ["commands"], "validation"); if (!Array.isArray(validation.commands) || validation.commands.length < 1 || validation.commands.length > 256) throw new IntakeValidationError("validation commands are required"); for (const command of validation.commands) { const item = object(command, "validation command"); exact(item, ["id", "command", "cwd", "timeoutSeconds", "required"], ["id", "command", "cwd", "timeoutSeconds", "required"], "validation command"); if (typeof item.id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(item.id) || !Array.isArray(item.command) || item.command.length < 1 || item.command.length > 256 || item.command.some((part: unknown) => typeof part !== "string" || part.length > 4_096 || /[\u0000]/u.test(part))) throw new IntakeValidationError("validation command is invalid"); assertSandboxPath(item.cwd, "validation command cwd"); integerAtLeast(item.timeoutSeconds, 1, "validation command timeout"); if (typeof item.required !== "boolean") throw new IntakeValidationError("validation command required flag is invalid"); }
  const remediation = object(value.remediation, "remediation"); exact(remediation, ["reviewAttempts", "testAttempts", "totalAttempts"], ["reviewAttempts", "testAttempts", "totalAttempts"], "remediation"); integerAtLeast(remediation.reviewAttempts, 0, "review attempts"); integerAtLeast(remediation.testAttempts, 0, "test attempts"); integerAtLeast(remediation.totalAttempts, 0, "total attempts");
  const retention = object(value.artifactRetention, "artifactRetention"); exact(retention, ["trustedExportDays", "sessionDays", "evidenceDays"], ["trustedExportDays", "sessionDays", "evidenceDays"], "artifactRetention"); integerAtLeast(retention.trustedExportDays, 1, "trusted export retention"); integerAtLeast(retention.sessionDays, 1, "session retention"); integerAtLeast(retention.evidenceDays, 1, "evidence retention");
  const github = object(value.github, "github"); exact(github, ["deliveryIdentity", "reviewerIdentity", "requiredChecks", "rules"], ["deliveryIdentity", "reviewerIdentity", "requiredChecks", "rules"], "github"); for (const identityName of ["deliveryIdentity", "reviewerIdentity"]) { const identity = object(github[identityName], `github.${identityName}`); exact(identity, ["appSlug", "installationId"], ["appSlug", "installationId"], `github.${identityName}`); if (typeof identity.appSlug !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(identity.appSlug)) throw new IntakeValidationError("GitHub app identity is invalid"); integerAtLeast(identity.installationId, 1, "GitHub installation ID"); }
  if (!Array.isArray(github.requiredChecks) || github.requiredChecks.length < 1 || github.requiredChecks.length > 256 || github.requiredChecks.some((check: unknown) => typeof check !== "string" || check.length < 1) || new Set(github.requiredChecks).size !== github.requiredChecks.length) throw new IntakeValidationError("GitHub required checks are invalid");
  const rules = object(github.rules, "github.rules"); exact(rules, ["requirePullRequest", "requiredApprovals", "dismissStaleApprovals", "requireApprovalAfterLatestPush", "denySquireMerge", "denySquireBypass", "denySquireBaseUpdate", "humanMergeActors"], ["requirePullRequest", "requiredApprovals", "dismissStaleApprovals", "requireApprovalAfterLatestPush", "denySquireMerge", "denySquireBypass", "denySquireBaseUpdate", "humanMergeActors"], "github.rules"); for (const flag of ["requirePullRequest", "dismissStaleApprovals", "requireApprovalAfterLatestPush", "denySquireMerge", "denySquireBypass", "denySquireBaseUpdate"]) if (rules[flag] !== true) throw new IntakeValidationError(`github rule ${flag} must be true`); integerAtLeast(rules.requiredApprovals, 1, "required approvals"); if (!Array.isArray(rules.humanMergeActors) || rules.humanMergeActors.length < 1 || rules.humanMergeActors.length > 256 || rules.humanMergeActors.some((actor: unknown) => typeof actor !== "string" || actor.length < 1) || new Set(rules.humanMergeActors).size !== rules.humanMergeActors.length) throw new IntakeValidationError("human merge actors are invalid");
  return { ticket: { provider: "linear", issueId: ticket.issueId, identifier: ticket.identifier }, repository: { owner: repository.owner, name: repository.name, cloneUrl: repository.cloneUrl, baseBranch: repository.baseBranch, objectFormat: repository.objectFormat }, linear: { teamId: linear.teamId, states: { accepted: states.accepted as string, inProgress: states.inProgress as string, awaitingHuman: states.awaitingHuman as string, completed: states.completed as string, failed: states.failed as string, cancelled: states.cancelled as string } }, sandbox: sandbox };
}
function validateIssue(issue: LinearIssueObservation, request: SingleTicketIntakeRequest, config: ValidatedConfig): void {
  if (!issue || typeof issue !== "object" || config.ticket.issueId !== request.issueId || issue.id !== request.issueId || issue.identifier !== request.expectedIdentifier || issue.identifier !== config.ticket.identifier || issue.teamId !== config.linear.teamId || issue.stateId !== config.linear.states.accepted) throw new IntakeValidationError("authoritative Linear issue identity or accepted state does not match configuration");
  assertTicketIdentifier(issue.identifier);
  if (!isUuid(issue.id) || !isUuid(issue.teamId) || !isUuid(issue.stateId)) throw new IntakeValidationError("Linear issue IDs are invalid");
  if (typeof issue.title !== "string" || issue.title.length < 1 || issue.title.length > MAX_TITLE || /\0/u.test(issue.title)) throw new IntakeValidationError("Linear title is outside its bound");
  if (typeof issue.description !== "string" || issue.description.length > MAX_DESCRIPTION || /\0/u.test(issue.description)) throw new IntakeValidationError("Linear description is outside its bound");
  assertLinearUrl(issue.url);
  if (!Array.isArray(issue.acceptanceCriteria) || issue.acceptanceCriteria.length > MAX_CRITERIA || issue.acceptanceCriteria.some(item => typeof item !== "string" || item.length < 1 || item.length > 8_192 || /\0/u.test(item))) throw new IntakeValidationError("Linear acceptance criteria is invalid");
  if (!Array.isArray(issue.labels) || issue.labels.length > MAX_LABELS) throw new IntakeValidationError("Linear labels are invalid");
}
function normalizeCriteria(criteria: readonly string[]): string[] { return criteria.map(item => item.normalize("NFC")); }
function normalizeLabels(labels: readonly (string | { readonly name: string })[]): string[] {
  const names = labels.map(label => typeof label === "string" ? label : label && typeof label.name === "string" ? label.name : "");
  if (names.some(name => !name || name.length > MAX_LABEL || /[\u0000-\u001f\u007f]/u.test(name))) throw new IntakeValidationError("Linear label is invalid");
  const unique = [...new Set(names.map(name => name.normalize("NFC")))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  if (unique.length !== names.length) throw new IntakeValidationError("Linear labels must not contain duplicates");
  return unique;
}
function validateNormalizedDocument(document: NormalizedTicketDocument): NormalizedTicketDocument { return validateNormalizedTicketDocument(document); }
function object(value: unknown, label: string): any { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new IntakeValidationError(`${label} must be an object`); return value; }
function exact(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], label: string): void { const keys = Object.keys(value); if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) throw new IntakeValidationError(`${label} is not a closed object`); }
function nonempty(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || value.length < 1 || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) throw new IntakeValidationError(`${label} is invalid`); }
function integerAtLeast(value: unknown, minimum: number, label: string): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > 1_000_000_000) throw new IntakeValidationError(`${label} is invalid`); }
function assertSandboxPath(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || value.length < 1 || value.length > 512 || !(value === "/ticket" || value.startsWith("/ticket/")) || value.includes("\0") || /(?:^|\/)\.\.?(?:\/|$)/u.test(value)) throw new IntakeValidationError(`${label} is invalid`); }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value); }
function assertLinearUrl(value: string): void { let url: URL; try { url = new URL(value); } catch { throw new IntakeValidationError("Linear URL is invalid"); } if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "linear.app" || url.username || url.password || url.search || url.hash || url.pathname.length < 2 || /[\u0000-\u001f\u007f]/u.test(value)) throw new IntakeValidationError("Linear URL is not canonical HTTPS"); }
void createHash;
