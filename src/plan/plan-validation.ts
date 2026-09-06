import {
  PLAN_TOOL_MAX,
  type ImplementationPlanDocument,
  type PlanAttemptContext,
  type PlanSubmission,
  type PlanToolInput,
} from "./domain.js";

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanValidationError";
  }
}

export interface ImplementationPlanValidationOptions {
  readonly expectedRunId?: string | undefined;
  readonly expectedTicketIdentifier?: string | undefined;
  readonly expectedInputHead?: string | undefined;
  readonly allowedValidationCommandIds?: readonly string[] | undefined;
  readonly requiredValidationCommandIds?: readonly string[] | undefined;
  readonly allowBlockedMarker?: boolean | undefined;
}

function fail(message: string): never {
  throw new PlanValidationError(message);
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${field} must be a non-empty string`);
  if (value.length > max) fail(`${field} exceeds its maximum length`);
  if (/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail(`${field} contains a control character`);
  return value;
}

function boundedArray(value: unknown, field: string, max: number): readonly unknown[] {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  if (value.length > max) fail(`${field} has too many entries`);
  return value;
}

function relativeRepositoryPath(value: unknown, field: string): string {
  const path = boundedString(value, field, PLAN_TOOL_MAX.path);
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/u.test(path) || path.includes("\\") || path.split("/").some(part => part === ".." || part.length === 0 || part === "." && path !== ".")) {
    fail(`${field} must be a normalized repository-relative path`);
  }
  if (path === "." || path.includes("//")) fail(`${field} must be a normalized repository-relative path`);
  return path;
}

function actionable(value: unknown, field: string, max: number): string {
  const text = boundedString(value, field, max);
  if (/\b(?:todo|tbd|unknown|unsure|unresolved|figure\s+out|later)\b/iu.test(text)) fail(`${field} is not an actionable acceptance criterion`);
  return text;
}

function unique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) fail(`${field} contains duplicates`);
}

export function validateImplementationPlanDocument(
  value: unknown,
  options: ImplementationPlanValidationOptions = {},
): ImplementationPlanDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("implementation plan must be an object");
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  const allowed = new Set(["schemaVersion", "runId", "ticketIdentifier", "inputHead", "summary", "assumptions", "steps", "risks", "validationCommandIds"]);
  if (keys.some(key => !allowed.has(key))) fail("implementation plan contains an unknown field");
  if (candidate["schemaVersion"] !== 1) fail("implementation plan schemaVersion must be 1");
  const runId = boundedString(candidate["runId"], "runId", 128);
  const ticketIdentifier = boundedString(candidate["ticketIdentifier"], "ticketIdentifier", 64);
  const inputHead = boundedString(candidate["inputHead"], "inputHead", 128);
  if (options.expectedRunId !== undefined && runId !== options.expectedRunId) fail("implementation plan run identity mismatch");
  if (options.expectedTicketIdentifier !== undefined && ticketIdentifier !== options.expectedTicketIdentifier) fail("implementation plan ticket identity mismatch");
  if (options.expectedInputHead !== undefined && inputHead !== options.expectedInputHead) fail("implementation plan input head mismatch");

  const summary = boundedString(candidate["summary"], "summary", PLAN_TOOL_MAX.summary);
  const assumptionsRaw = boundedArray(candidate["assumptions"], "assumptions", PLAN_TOOL_MAX.assumptions);
  const assumptions = assumptionsRaw.map((item, index) => boundedString(item, `assumptions[${index}]`, PLAN_TOOL_MAX.assumption));
  const stepsRaw = boundedArray(candidate["steps"], "steps", PLAN_TOOL_MAX.steps);
  if (stepsRaw.length === 0) fail("implementation plan must contain at least one step");
  const steps = stepsRaw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(`steps[${index}] must be an object`);
    const step = item as Record<string, unknown>;
    const stepKeys = Object.keys(step);
    const stepAllowed = new Set(["id", "description", "affectedPaths", "acceptanceCriteria"]);
    if (stepKeys.some(key => !stepAllowed.has(key))) fail(`steps[${index}] contains an unknown field`);
    const id = boundedString(step["id"], `steps[${index}].id`, 128);
    const description = boundedString(step["description"], `steps[${index}].description`, PLAN_TOOL_MAX.stepDescription);
    const pathsRaw = boundedArray(step["affectedPaths"], `steps[${index}].affectedPaths`, PLAN_TOOL_MAX.pathsPerStep);
    const affectedPaths = pathsRaw.map((path, pathIndex) => relativeRepositoryPath(path, `steps[${index}].affectedPaths[${pathIndex}]`));
    const criteriaRaw = boundedArray(step["acceptanceCriteria"], `steps[${index}].acceptanceCriteria`, PLAN_TOOL_MAX.criteriaPerStep);
    if (criteriaRaw.length === 0) fail(`steps[${index}] must contain actionable acceptance criteria`);
    const acceptanceCriteria = criteriaRaw.map((criterion, criterionIndex) => actionable(criterion, `steps[${index}].acceptanceCriteria[${criterionIndex}]`, PLAN_TOOL_MAX.criterion));
    return { id, description, affectedPaths, acceptanceCriteria };
  });
  const stepIds = steps.map(step => step["id"]);
  unique(stepIds, "step ids");
  const numbered = stepIds.every(id => /^step-[0-9]+$/u.test(id));
  if (numbered && stepIds.some((id, index) => id !== `step-${index + 1}`)) fail("numbered plan steps must be ordered and contiguous");

  const risksRaw = boundedArray(candidate["risks"], "risks", PLAN_TOOL_MAX.risks);
  const risks = risksRaw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(`risks[${index}] must be an object`);
    const risk = item as Record<string, unknown>;
    const riskKeys = Object.keys(risk);
    if (riskKeys.some(key => key !== "risk" && key !== "mitigation")) fail(`risks[${index}] contains an unknown field`);
    return {
      risk: boundedString(risk["risk"], `risks[${index}].risk`, PLAN_TOOL_MAX.risk),
      mitigation: boundedString(risk["mitigation"], `risks[${index}].mitigation`, PLAN_TOOL_MAX.mitigation),
    };
  });
  const commandIdsRaw = boundedArray(candidate["validationCommandIds"], "validationCommandIds", PLAN_TOOL_MAX.validationIds);
  if (commandIdsRaw.length === 0) fail("implementation plan must reference a validation command");
  const validationCommandIds = commandIdsRaw.map((id, index) => boundedString(id, `validationCommandIds[${index}]`, 128));
  unique(validationCommandIds, "validationCommandIds");
  if (options.allowedValidationCommandIds !== undefined) {
    const allowedIds = new Set(options.allowedValidationCommandIds);
    if (validationCommandIds.some(id => !allowedIds.has(id))) fail("implementation plan references an unknown validation command");
  }
  if (options.requiredValidationCommandIds !== undefined) {
    const selected = new Set(validationCommandIds);
    if (options.requiredValidationCommandIds.some(id => !selected.has(id))) fail("implementation plan omits a required validation command");
  }
  if (!options.allowBlockedMarker && /\b(?:blocked|must not start|cannot proceed)\b/iu.test(summary)) fail("pass implementation plan contains a blocked disposition");

  return { schemaVersion: 1, runId, ticketIdentifier, inputHead, summary, assumptions, steps, risks, validationCommandIds };
}

export interface PlanSubmissionContext {
  readonly runId: string;
  readonly ticketIdentifier: string;
  readonly inputHead: string;
  readonly allowedValidationCommandIds?: readonly string[] | undefined;
  readonly requiredValidationCommandIds?: readonly string[] | undefined;
}

export function validatePlanSubmission(value: unknown, context: PlanSubmissionContext): PlanSubmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("plan submission must be an object");
  const candidate = value as Record<string, unknown>;
  const allowed = new Set([
    "disposition", "schemaVersion", "runId", "ticketIdentifier", "inputHead", "summary", "assumptions", "steps", "risks", "validationCommandIds", "questions",
  ]);
  if (Object.keys(candidate).some(key => !allowed.has(key))) fail("plan submission contains an unknown field");
  if (candidate["disposition"] !== "pass" && candidate["disposition"] !== "blocked") fail("plan disposition must be pass or blocked");
  const plan = validateImplementationPlanDocument(candidate, {
    expectedRunId: context.runId,
    expectedTicketIdentifier: context.ticketIdentifier,
    expectedInputHead: context.inputHead,
    allowedValidationCommandIds: context.allowedValidationCommandIds,
    requiredValidationCommandIds: candidate["disposition"] === "pass" ? context.requiredValidationCommandIds : undefined,
    allowBlockedMarker: candidate["disposition"] === "blocked",
  });
  const questionsRaw = candidate["questions"] === undefined ? [] : boundedArray(candidate["questions"], "questions", PLAN_TOOL_MAX.questions);
  const questions = questionsRaw.map((question, index) => boundedString(question, `questions[${index}]`, PLAN_TOOL_MAX.question));
  if (candidate["disposition"] === "blocked" && questions.length === 0) fail("blocked plan requires at least one actionable question");
  if (candidate["disposition"] === "pass" && questions.length > 0) fail("pass plan cannot contain blocking questions");
  return { disposition: candidate["disposition"], plan, questions };
}

export function validatePlanDocumentForContext(plan: ImplementationPlanDocument, context: PlanAttemptContext, allowedValidationCommandIds?: readonly string[], requiredValidationCommandIds?: readonly string[]): ImplementationPlanDocument {
  return validateImplementationPlanDocument(plan, {
    expectedRunId: context.runId,
    expectedTicketIdentifier: context.ticketIdentifier,
    expectedInputHead: context.inputHead,
    allowedValidationCommandIds,
    requiredValidationCommandIds,
    allowBlockedMarker: true,
  });
}
