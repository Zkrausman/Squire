import path from "node:path";
import type { ContractReference, SessionRegistration } from "../control/domain.js";
import { V1ArtifactValidator, type JsonObject } from "../contracts/v1-artifact-validator.js";
import type { ImmutableArtifactReader } from "../control/safe-artifact-reader.js";
import { normalizeWorkflowConfig } from "../pi/pi-configuration.js";
import {
  NORMALIZED_TICKET_SCHEMA_ID,
  PHASE_INPUT_SCHEMA_ID,
  WORKFLOW_CONFIG_SCHEMA_ID,
  type NormalizedTicketDocument,
  type PhaseInputDocument,
  type PlanAttemptContext,
  type PlanReadinessIdentity,
  type ValidatedPlanInput,
  type WorkflowConfigDocument,
  sameContractReference,
} from "./domain.js";

export class PlanInputValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlanInputValidationError";
  }
}

const CONTRACT_REFERENCE_KEYS = ["path", "schemaId", "sha256"] as const;
const ARTIFACT_PATH = /^(?:artifacts|evidence)\/(?!.*(?:^|\/)\.\.?\/)[^\u0000\s]+$/u;
const SCHEMA_ID = /^urn:squire:contracts:v1:[a-z-]+$/u;
const RUN_ID = /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const COMMAND_ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

function fail(message: string): never {
  throw new PlanInputValidationError(message);
}

function referenceKey(reference: ContractReference): string {
  return `${reference.path}\u0000${reference.sha256}\u0000${reference.schemaId}`;
}

function pathDigestKey(reference: ContractReference): string {
  return `${reference.path}\u0000${reference.sha256}`;
}

function assertReference(reference: unknown, field: string, schemaId?: string): asserts reference is ContractReference {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) fail(`${field} is not a contract reference`);
  const candidate = reference as Record<string, unknown>;
  if (JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify([...CONTRACT_REFERENCE_KEYS].sort())) fail(`${field} has unexpected reference fields`);
  if (typeof candidate["path"] !== "string" || candidate["path"].length > 1024 || !ARTIFACT_PATH.test(candidate["path"]) || path.posix.normalize(candidate["path"]) !== candidate["path"] || candidate["path"].includes("\\")) fail(`${field} has an unsafe path`);
  if (typeof candidate["sha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(candidate["sha256"])) fail(`${field} has an invalid digest`);
  if (typeof candidate["schemaId"] !== "string" || !SCHEMA_ID.test(candidate["schemaId"])) fail(`${field} has an invalid schema identity`);
  if (schemaId !== undefined && candidate["schemaId"] !== schemaId) fail(`${field} has the wrong schema identity`);
}

function assertSameReference(actual: ContractReference, expected: ContractReference, field: string): void {
  if (!sameContractReference(actual, expected)) fail(`${field} was substituted`);
}

function assertRunIdentity(value: unknown, expected: string, field: string): void {
  if (typeof value !== "string" || !RUN_ID.test(value) || value !== expected) fail(`${field} run identity mismatch`);
}

function sameRegistration(left: SessionRegistration, right: SessionRegistration): boolean {
  return left.runId === right.runId
    && left.role === right.role
    && left.sessionId === right.sessionId
    && left.sessionFile === right.sessionFile
    && left.processGeneration === right.processGeneration
    && left.processState === right.processState
    && left.processIdentity === right.processIdentity
    && left.registeredAt === right.registeredAt;
}

function registrationAliases(context: PlanAttemptContext): SessionRegistration | undefined {
  const values = [context.registration, context.planRegistration, context.sessionRegistration].filter((value): value is SessionRegistration => value !== undefined);
  if (values.some((value, index) => index > 0 && !sameRegistration(values[0]!, value))) fail("Plan session registration aliases are ambiguous");
  return values[0];
}

interface ReadinessFingerprint {
  runId: unknown;
  headSha: unknown;
  featureBranch: unknown;
  baseSha: unknown;
  repository: unknown;
  baseBranch: unknown;
  spec: unknown;
  manifest: unknown;
  objectFormat: unknown;
  workspace: unknown;
  identity: unknown;
}

function readinessFingerprint(value: PlanReadinessIdentity | undefined): ReadinessFingerprint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as unknown as Record<string, unknown>;
  const paths = candidate["paths"] && typeof candidate["paths"] === "object" && !Array.isArray(candidate["paths"])
    ? candidate["paths"] as Record<string, unknown>
    : undefined;
  const repository = candidate["repository"] && typeof candidate["repository"] === "object" && !Array.isArray(candidate["repository"])
    ? candidate["repository"] as Record<string, unknown>
    : undefined;
  return {
    runId: candidate["runId"],
    headSha: candidate["headSha"],
    featureBranch: candidate["featureBranch"],
    baseSha: candidate["baseSha"],
    repository: repository ? { owner: repository["owner"], name: repository["name"] } : undefined,
    baseBranch: candidate["baseBranch"],
    spec: candidate["spec"],
    manifest: candidate["manifest"],
    objectFormat: candidate["objectFormat"],
    workspace: candidate["workspace"] ?? paths?.["worktree"],
    identity: candidate["identity"],
  };
}

function sameReadiness(left: PlanReadinessIdentity, right: PlanReadinessIdentity): boolean {
  return JSON.stringify(readinessFingerprint(left)) === JSON.stringify(readinessFingerprint(right));
}

function readinessAliases(context: PlanAttemptContext): PlanReadinessIdentity | undefined {
  const values = [context.readiness, context.workspaceReadiness, context.aidev222].filter((value): value is PlanReadinessIdentity => value !== undefined) as PlanReadinessIdentity[];
  if (values.some((value, index) => index > 0 && !sameReadiness(values[0]!, value))) fail("AIDEV-222 readiness aliases are ambiguous");
  return values[0];
}

function phaseInputAliases(context: PlanAttemptContext): ContractReference | undefined {
  const values = [context.phaseInput, context.phaseInputReference, context.inputArtifact].filter((value): value is ContractReference => value !== undefined);
  for (const value of values) assertReference(value, "Plan phase-input context", PHASE_INPUT_SCHEMA_ID);
  if (values.some((value, index) => index > 0 && !sameContractReference(values[0]!, value))) fail("Plan phase-input references are ambiguous");
  return values[0];
}

function assertConfigSemantics(config: WorkflowConfigDocument, context: PlanAttemptContext, ticket: NormalizedTicketDocument): void {
  if (config.ticket.provider !== "linear" || config.ticket.issueId !== ticket.ticket.id || config.ticket.identifier !== ticket.ticket.identifier) fail("workflow configuration ticket identity mismatch");
  if (config.repository.owner !== ticket.repository.owner || config.repository.name !== ticket.repository.name || config.repository.baseBranch !== ticket.repository.baseBranch) fail("workflow configuration repository identity mismatch");
  const plan = config.pi.roles["plan"];
  if (!plan || typeof plan !== "object") fail("workflow configuration has no Plan profile");
  if (typeof plan.instructionsPath !== "string" || !plan.instructionsPath.startsWith("/ticket/") || path.posix.normalize(plan.instructionsPath) !== plan.instructionsPath || plan.instructionsPath.includes("..") || CONTROL_CHARACTER.test(plan.instructionsPath)) fail("Plan instructions path is not a trusted ticket path");
  if (typeof plan.provider !== "string" || typeof plan.model !== "string" || typeof plan.thinking !== "string" || !Number.isSafeInteger(plan.timeoutSeconds) || plan.timeoutSeconds < 1) fail("Plan profile is invalid");
  if (!Array.isArray(config.validation.commands) || config.validation.commands.length === 0) fail("workflow configuration has no validation commands");
  const ids = config.validation.commands.map(command => command.id);
  if (ids.some(id => typeof id !== "string" || !COMMAND_ID.test(id)) || new Set(ids).size !== ids.length) fail("workflow configuration validation command ids are not unique or valid");
  for (const command of config.validation.commands) {
    const argv: readonly unknown[] = command.command;
    if (argv.length === 0 || argv.some((part: unknown) => typeof part !== "string" || part.length === 0 || CONTROL_CHARACTER.test(part)) || typeof command.cwd !== "string" || !command.cwd.startsWith("/ticket/") || path.posix.normalize(command.cwd) !== command.cwd || command.cwd.includes("..") || !Number.isSafeInteger(command.timeoutSeconds) || command.timeoutSeconds < 1 || typeof command.required !== "boolean") fail("workflow configuration contains an unsafe validation command");
  }
  if (context.validationCommandIds !== undefined && (context.validationCommandIds.length !== ids.length || context.validationCommandIds.some((id, index) => id !== ids[index]))) fail("trusted Plan command identity is not configured exactly");
  const required = ids.filter((_, index) => config.validation.commands[index]!.required);
  if (context.requiredValidationCommandIds !== undefined && (context.requiredValidationCommandIds.length !== required.length || context.requiredValidationCommandIds.some((id, index) => id !== required[index]))) fail("trusted required Plan command identity is not configured exactly");
}

function assertReadiness(context: PlanAttemptContext, ticket: NormalizedTicketDocument): void {
  const readiness = readinessAliases(context);
  if (!readiness) fail("AIDEV-222 workspace readiness identity is missing");
  const fingerprint = readinessFingerprint(readiness);
  if (!fingerprint || fingerprint.runId !== context.runId) fail("workspace readiness run identity mismatch");
  if (fingerprint.headSha !== context.inputHead) fail("workspace readiness head is stale");
  if (context.currentHead !== undefined && fingerprint.headSha !== context.currentHead) fail("workspace readiness does not match current head");
  if (fingerprint.featureBranch !== ticket.repository.featureBranch) fail("workspace readiness feature branch mismatch");
  if (fingerprint.baseSha !== undefined && context.baseSha !== undefined && fingerprint.baseSha !== context.baseSha) fail("workspace readiness base SHA mismatch");
  if (fingerprint.repository && (fingerprint.repository as { owner?: unknown; name?: unknown }).owner !== ticket.repository.owner || fingerprint.repository && (fingerprint.repository as { owner?: unknown; name?: unknown }).name !== ticket.repository.name) fail("workspace readiness repository mismatch");
  if (fingerprint.baseBranch !== undefined && fingerprint.baseBranch !== ticket.repository.baseBranch) fail("workspace readiness base branch mismatch");
}

export class PlanInputValidator {
  readonly #validator: V1ArtifactValidator;
  constructor(validator: V1ArtifactValidator) {
    this.#validator = validator;
  }

  static async create(reader: ImmutableArtifactReader, schemaDir?: string): Promise<PlanInputValidator> {
    return new PlanInputValidator(await V1ArtifactValidator.create(reader, schemaDir));
  }

  static fromValidator(validator: V1ArtifactValidator): PlanInputValidator {
    return new PlanInputValidator(validator);
  }

  /**
   * Reads and validates the phase input, then its two authoritative nested
   * documents. No value from the Pi prompt is involved in this operation.
   */
  async validate(reference: ContractReference, context: PlanAttemptContext): Promise<ValidatedPlanInput> {
    assertReference(reference, "phase input", PHASE_INPUT_SCHEMA_ID);
    if (context.phase !== undefined && context.phase !== "plan") fail("Plan context phase is not plan");
    if (typeof context.runId !== "string" || !RUN_ID.test(context.runId)) fail("Plan context run identity is invalid");
    if (!Number.isSafeInteger(context.attempt) || context.attempt < 1) fail("Plan attempt is invalid");
    const phaseInputContext = phaseInputAliases(context);
    if (!phaseInputContext) fail("Plan context phase-input reference is missing");
    assertSameReference(reference, phaseInputContext, "phase input reference");

    const registration = registrationAliases(context);
    if (!registration) fail("persisted Plan session registration is missing");
    if (registration.runId !== context.runId || registration.role !== "plan" || typeof registration.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(registration.sessionId) || registration.sessionId !== context.targetSessionId || typeof registration.sessionFile !== "string" || !path.isAbsolute(registration.sessionFile) || CONTROL_CHARACTER.test(registration.sessionFile) || !registration.sessionFile.endsWith(`_${registration.sessionId}.jsonl`) || !Number.isSafeInteger(registration.processGeneration) || registration.processGeneration < 1) fail("persisted Plan session registration is not exact");

    const phaseResult = await this.#validator.validate<JsonObject>(reference, {
      schemaId: PHASE_INPUT_SCHEMA_ID,
      semantic: rawDocument => {
        const document = rawDocument as unknown as PhaseInputDocument;
        const errors: string[] = [];
        if (document.phase !== "plan") errors.push("phase input is not for Plan");
        if (document.runId !== context.runId) errors.push("phase input run identity mismatch");
        if (document.handoffId !== context.handoffId) errors.push("phase input handoff identity mismatch");
        if (document.attempt !== context.attempt) errors.push("phase input attempt is not the latest trusted attempt");
        if (document.targetSessionId !== context.targetSessionId) errors.push("phase input session identity mismatch");
        if (document.inputHead !== context.inputHead) errors.push("phase input head mismatch");
        return errors;
      },
    });
    const input = phaseResult.document as unknown as PhaseInputDocument;
    const allNested = [input.ticket, input.configuration, ...input.artifacts, ...input.feedback];
    const keys = new Set<string>();
    const authoritative = new Map<string, string>([[pathDigestKey(input.ticket), NORMALIZED_TICKET_SCHEMA_ID], [pathDigestKey(input.configuration), WORKFLOW_CONFIG_SCHEMA_ID]]);
    for (const [index, nested] of allNested.entries()) {
      assertReference(nested, `phase input reference ${index}`);
      const key = referenceKey(nested);
      if (keys.has(key)) fail("phase input contains duplicate contract references");
      keys.add(key);
      const expectedSchema = authoritative.get(pathDigestKey(nested));
      if (expectedSchema !== undefined && nested !== input.ticket && nested !== input.configuration) fail("phase input hides a duplicate ticket or configuration reference");
    }
    assertReference(input.ticket, "normalized ticket", NORMALIZED_TICKET_SCHEMA_ID);
    assertReference(input.configuration, "workflow configuration", WORKFLOW_CONFIG_SCHEMA_ID);
    if (input.artifacts.some(item => item.schemaId === NORMALIZED_TICKET_SCHEMA_ID || item.schemaId === WORKFLOW_CONFIG_SCHEMA_ID) || input.feedback.some(item => item.schemaId === NORMALIZED_TICKET_SCHEMA_ID || item.schemaId === WORKFLOW_CONFIG_SCHEMA_ID)) fail("phase input hides a duplicate ticket or configuration reference");

    const ticketReference = context.normalizedTicket;
    if (ticketReference) {
      assertReference(ticketReference, "trusted normalized ticket", NORMALIZED_TICKET_SCHEMA_ID);
      assertSameReference(input.ticket, ticketReference, "normalized ticket reference");
    }
    const configurationReference = context.configuration;
    if (configurationReference) {
      assertReference(configurationReference, "trusted workflow configuration", WORKFLOW_CONFIG_SCHEMA_ID);
      assertSameReference(input.configuration, configurationReference, "workflow configuration reference");
    }

    const ticketResult = await this.#validator.validate<JsonObject>(input.ticket, {
      schemaId: NORMALIZED_TICKET_SCHEMA_ID,
      semantic: rawDocument => {
        const document = rawDocument as unknown as NormalizedTicketDocument;
        const errors: string[] = [];
        if (document.runId !== context.runId) errors.push("normalized ticket run identity mismatch");
        if (context.ticketIdentifier !== undefined && document.ticket.identifier !== context.ticketIdentifier) errors.push("normalized ticket identifier mismatch");
        if (context.baseSha !== undefined && document.repository.baseSha !== context.baseSha) errors.push("normalized ticket base SHA mismatch");
        if (context.repository && (document.repository.owner !== context.repository.owner || document.repository.name !== context.repository.name || document.repository.baseBranch !== context.repository.baseBranch || document.repository.featureBranch !== context.repository.featureBranch)) errors.push("normalized ticket repository identity mismatch");
        return errors;
      },
    });
    const configResult = await this.#validator.validate<WorkflowConfigDocument>(input.configuration, {
      schemaId: WORKFLOW_CONFIG_SCHEMA_ID,
      semantic: document => {
        const errors: string[] = [];
        const normalized = normalizeWorkflowConfig(document as never) as unknown as WorkflowConfigDocument;
        const normalizedTicket = ticketResult.document as unknown as NormalizedTicketDocument;
        if (normalized.ticket.issueId !== normalizedTicket.ticket.id || normalized.ticket.identifier !== normalizedTicket.ticket.identifier || normalized.repository.owner !== normalizedTicket.repository.owner || normalized.repository.name !== normalizedTicket.repository.name || normalized.repository.baseBranch !== normalizedTicket.repository.baseBranch) errors.push("workflow configuration identity mismatch");
        return errors;
      },
    });
    const ticket = ticketResult.document as unknown as NormalizedTicketDocument;
    const configuration = normalizeWorkflowConfig(configResult.document as never) as unknown as WorkflowConfigDocument;

    if (input.inputHead !== context.inputHead || (context.currentHead !== undefined && context.currentHead !== context.inputHead)) fail("Plan input is stale relative to the trusted current head");
    if (context.latestAttempt && (context.latestAttempt.phase !== "plan" || context.latestAttempt.attempt !== context.attempt || context.latestAttempt.handoffId !== context.handoffId || context.latestAttempt.targetSessionId !== context.targetSessionId || context.latestAttempt.inputHead !== context.inputHead)) fail("Plan context is not the latest persisted attempt");
    if (context.baseSha !== undefined && ticket.repository.baseSha !== context.baseSha) fail("normalized ticket base SHA mismatch");
    assertConfigSemantics(configuration, context, ticket);
    assertReadiness(context, ticket);
    return { reference, input, ticket, configuration, context };
  }
}

export async function validatePlanInput(reference: ContractReference, context: PlanAttemptContext, validator: PlanInputValidator): Promise<ValidatedPlanInput> {
  return validator.validate(reference, context);
}
