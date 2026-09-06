import type { ContractReference } from "../control/domain.js";
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

function fail(message: string): never {
  throw new PlanInputValidationError(message);
}

function referenceKey(reference: ContractReference): string {
  return `${reference.path}\u0000${reference.sha256}\u0000${reference.schemaId}`;
}

function assertReference(reference: unknown, field: string, schemaId: string): asserts reference is ContractReference {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) fail(`${field} is not a contract reference`);
  const candidate = reference as Record<string, unknown>;
  if (candidate["schemaId"] !== schemaId) fail(`${field} has the wrong schema identity`);
  if (typeof candidate["path"] !== "string" || candidate["path"].length === 0 || candidate["path"].includes("\u0000") || candidate["path"].includes("..") || candidate["path"].startsWith("/")) fail(`${field} has an unsafe path`);
  if (typeof candidate["sha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(candidate["sha256"])) fail(`${field} has an invalid digest`);
}

function assertSameReference(actual: ContractReference, expected: ContractReference, field: string): void {
  if (!sameContractReference(actual, expected)) fail(`${field} was substituted`);
}

function assertRunIdentity(value: string, expected: string, field: string): void {
  if (value !== expected) fail(`${field} run identity mismatch`);
}

function getRegistration(context: PlanAttemptContext) {
  return context.registration ?? context.planRegistration ?? context.sessionRegistration;
}

function getReadiness(context: PlanAttemptContext): PlanReadinessIdentity | undefined {
  return (context.readiness ?? context.workspaceReadiness ?? context.aidev222) as PlanReadinessIdentity | undefined;
}

function assertConfigSemantics(config: WorkflowConfigDocument, context: PlanAttemptContext, ticket: NormalizedTicketDocument): void {
  if (config.ticket.identifier !== ticket.ticket.identifier) fail("workflow configuration ticket identity mismatch");
  if (config.repository.owner !== ticket.repository.owner || config.repository.name !== ticket.repository.name || config.repository.baseBranch !== ticket.repository.baseBranch) fail("workflow configuration repository identity mismatch");
  const plan = config.pi.roles["plan"];
  if (!plan || typeof plan !== "object") fail("workflow configuration has no Plan profile");
  if (!plan.instructionsPath.startsWith("/ticket/") || plan.instructionsPath.includes("..") || plan.instructionsPath.includes("\u0000")) fail("Plan instructions path is not a trusted ticket path");
  if (!Number.isSafeInteger(plan.timeoutSeconds) || plan.timeoutSeconds < 1) fail("Plan timeout is invalid");
  if (!Array.isArray(config.validation.commands) || config.validation.commands.length === 0) fail("workflow configuration has no validation commands");
  const ids = config.validation.commands.map(command => command.id);
  if (new Set(ids).size !== ids.length) fail("workflow configuration validation command ids are not unique");
  for (const command of config.validation.commands) {
    if (!command.id || !Array.isArray(command.command) || command.command.length === 0 || !command.cwd.startsWith("/ticket/") || command.cwd.includes("..")) fail("workflow configuration contains an unsafe validation command");
  }
  if (context.validationCommandIds && context.validationCommandIds.some(id => !ids.includes(id))) fail("trusted Plan command identity is not configured");
}

function assertReadiness(context: PlanAttemptContext, ticket: NormalizedTicketDocument): void {
  const readiness = getReadiness(context);
  if (!readiness) fail("AIDEV-222 workspace readiness identity is missing");
  if (readiness.runId !== context.runId) fail("workspace readiness run identity mismatch");
  if (readiness.headSha !== context.inputHead) fail("workspace readiness head is stale");
  if (context.currentHead !== undefined && readiness.headSha !== context.currentHead) fail("workspace readiness does not match current head");
  if (readiness.featureBranch !== ticket.repository.featureBranch) fail("workspace readiness feature branch mismatch");
  if (context.baseSha !== undefined && readiness.baseSha !== undefined && readiness.baseSha !== context.baseSha) fail("workspace readiness base SHA mismatch");
  if (readiness.repository && (readiness.repository.owner !== ticket.repository.owner || readiness.repository.name !== ticket.repository.name)) fail("workspace readiness repository mismatch");
  if (readiness.baseBranch !== undefined && readiness.baseBranch !== ticket.repository.baseBranch) fail("workspace readiness base branch mismatch");
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
    if (!Number.isSafeInteger(context.attempt) || context.attempt < 1) fail("Plan attempt is invalid");
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
        if (document.artifacts.some(item => item.schemaId === NORMALIZED_TICKET_SCHEMA_ID || item.schemaId === WORKFLOW_CONFIG_SCHEMA_ID) || document.feedback.some(item => item.schemaId === NORMALIZED_TICKET_SCHEMA_ID || item.schemaId === WORKFLOW_CONFIG_SCHEMA_ID)) errors.push("phase input hides a duplicate ticket or configuration reference");
        return errors;
      },
    });
    const input = phaseResult.document as unknown as PhaseInputDocument;
    const allNested = [input.ticket, input.configuration, ...input.artifacts, ...input.feedback];
    const keys = new Set<string>();
    for (const nested of allNested) {
      const key = referenceKey(nested);
      if (keys.has(key)) fail("phase input contains duplicate contract references");
      keys.add(key);
    }
    assertReference(input.ticket, "normalized ticket", NORMALIZED_TICKET_SCHEMA_ID);
    assertReference(input.configuration, "workflow configuration", WORKFLOW_CONFIG_SCHEMA_ID);
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
        if (normalized.ticket.identifier !== normalizedTicket.ticket.identifier) errors.push("workflow configuration ticket identity mismatch");
        return errors;
      },
    });
    const ticket = ticketResult.document as unknown as NormalizedTicketDocument;
    const configuration = normalizeWorkflowConfig(configResult.document as never) as unknown as WorkflowConfigDocument;

    assertRunIdentity(input.runId, context.runId, "phase input");
    if (input.inputHead !== context.inputHead || (context.currentHead !== undefined && context.currentHead !== context.inputHead)) fail("Plan input is stale relative to the trusted current head");
    const phaseInputReference = context.phaseInput ?? context.phaseInputReference ?? context.inputArtifact;
    if (phaseInputReference) assertSameReference(reference, phaseInputReference, "phase input reference");
    const ticketReference = context.normalizedTicket;
    if (ticketReference) assertSameReference(input.ticket, ticketReference, "normalized ticket reference");
    const configurationReference = context.configuration;
    if (configurationReference) assertSameReference(input.configuration, configurationReference, "workflow configuration reference");
    const registration = getRegistration(context);
    if (!registration) fail("persisted Plan session registration is missing");
    if (registration.runId !== context.runId || registration.role !== "plan" || registration.sessionId !== context.targetSessionId || registration.sessionFile.length === 0 || !Number.isSafeInteger(registration.processGeneration) || registration.processGeneration < 1) fail("persisted Plan session registration is not exact");
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
