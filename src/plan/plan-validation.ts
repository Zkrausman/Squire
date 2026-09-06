import {
  PLAN_TOOL_MAX,
  type ImplementationPlanDocument,
  type PlanAttemptContext,
  type PlanSubmission,
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
  /** A failed/blocked result may explain unresolved assumptions. */
  readonly allowUnresolvedAssumptions?: boolean | undefined;
  /** A failed/blocked result may use a blocked summary marker. */
  readonly allowBlockedMarker?: boolean | undefined;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const RUN_ID = /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TICKET_IDENTIFIER = /^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u;
const INPUT_HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const STEP_ID = /^step-[1-9][0-9]*$/u;
const COMMAND_ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const UNRESOLVED = /\b(?:todo|tbd|unknown|unsure|unresolved|figure\s+out|later|not\s+known|pending)\b/iu;

function fail(message: string): never {
  throw new PlanValidationError(message);
}

function boundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${field} must be a non-empty string`);
  if (value.length > max) fail(`${field} exceeds its maximum length`);
  if (CONTROL_CHARACTER.test(value)) fail(`${field} contains a control character`);
  return value;
}

function boundedArray(value: unknown, field: string, max: number): readonly unknown[] {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  if (value.length > max) fail(`${field} has too many entries`);
  return value;
}

function identifier(value: unknown, field: string, pattern: RegExp, max: number): string {
  const text = boundedString(value, field, max);
  if (!pattern.test(text)) fail(`${field} has an invalid identity`);
  return text;
}

function relativeRepositoryPath(value: unknown, field: string): string {
  const repositoryPath = boundedString(value, field, PLAN_TOOL_MAX.path);
  if (
    repositoryPath.startsWith("/")
    || repositoryPath.startsWith("\\")
    || /^[A-Za-z]:/u.test(repositoryPath)
    || repositoryPath.includes("\\")
    || repositoryPath.includes("//")
    || repositoryPath === "."
    || repositoryPath.split("/").some(part => part === ".." || part === "." || part.length === 0)
  ) {
    fail(`${field} must be a normalized repository-relative path`);
  }
  return repositoryPath;
}

function actionable(value: unknown, field: string, max: number): string {
  const text = boundedString(value, field, max);
  if (UNRESOLVED.test(text)) fail(`${field} is not actionable`);
  return text;
}

function unique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) fail(`${field} contains duplicates`);
}

function validateCommandList(
  value: unknown,
  options: ImplementationPlanValidationOptions,
): readonly string[] {
  const commandIdsRaw = boundedArray(value, "validationCommandIds", PLAN_TOOL_MAX.validationIds);
  if (commandIdsRaw.length === 0) fail("implementation plan must reference a validation command");
  const commandIds = commandIdsRaw.map((id, index) => identifier(id, `validationCommandIds[${index}]`, COMMAND_ID, 64));
  unique(commandIds, "validationCommandIds");
  if (options.allowedValidationCommandIds !== undefined) {
    const allowed = new Set(options.allowedValidationCommandIds);
    if (commandIds.some(id => !allowed.has(id))) fail("implementation plan references an unknown validation command");
  }
  if (options.requiredValidationCommandIds !== undefined) {
    const selected = new Set(commandIds);
    if (options.requiredValidationCommandIds.some(id => !selected.has(id))) fail("implementation plan omits a required validation command");
  }
  return commandIds;
}

export function validateImplementationPlanDocument(
  value: unknown,
  options: ImplementationPlanValidationOptions = {},
): ImplementationPlanDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("implementation plan must be an object");
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "runId", "ticketIdentifier", "inputHead", "summary", "assumptions", "steps", "risks", "validationCommandIds"]);
  if (Object.keys(candidate).some(key => !allowed.has(key))) fail("implementation plan contains an unknown field");
  if (candidate["schemaVersion"] !== 1) fail("implementation plan schemaVersion must be 1");

  const runId = identifier(candidate["runId"], "runId", RUN_ID, 128);
  const ticketIdentifier = identifier(candidate["ticketIdentifier"], "ticketIdentifier", TICKET_IDENTIFIER, 64);
  const inputHead = identifier(candidate["inputHead"], "inputHead", INPUT_HEAD, 64);
  if (options.expectedRunId !== undefined && runId !== options.expectedRunId) fail("implementation plan run identity mismatch");
  if (options.expectedTicketIdentifier !== undefined && ticketIdentifier !== options.expectedTicketIdentifier) fail("implementation plan ticket identity mismatch");
  if (options.expectedInputHead !== undefined && inputHead !== options.expectedInputHead) fail("implementation plan input head mismatch");

  const summary = boundedString(candidate["summary"], "summary", PLAN_TOOL_MAX.summary);
  const assumptionsRaw = boundedArray(candidate["assumptions"], "assumptions", PLAN_TOOL_MAX.assumptions);
  const assumptions = assumptionsRaw.map((item, index) => {
    const assumption = boundedString(item, `assumptions[${index}]`, PLAN_TOOL_MAX.assumption);
    if (!options.allowUnresolvedAssumptions && UNRESOLVED.test(assumption)) fail(`assumptions[${index}] is unresolved`);
    return assumption;
  });

  const stepsRaw = boundedArray(candidate["steps"], "steps", PLAN_TOOL_MAX.steps);
  if (stepsRaw.length === 0) fail("implementation plan must contain at least one step");
  const steps = stepsRaw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(`steps[${index}] must be an object`);
    const step = item as Record<string, unknown>;
    const stepAllowed = new Set(["id", "description", "affectedPaths", "acceptanceCriteria"]);
    if (Object.keys(step).some(key => !stepAllowed.has(key))) fail(`steps[${index}] contains an unknown field`);
    const id = identifier(step["id"], `steps[${index}].id`, STEP_ID, 128);
    const description = boundedString(step["description"], `steps[${index}].description`, PLAN_TOOL_MAX.stepDescription);
    const pathsRaw = boundedArray(step["affectedPaths"], `steps[${index}].affectedPaths`, PLAN_TOOL_MAX.pathsPerStep);
    if (pathsRaw.length === 0) fail(`steps[${index}] must identify an affected path`);
    const affectedPaths = pathsRaw.map((item, pathIndex) => relativeRepositoryPath(item, `steps[${index}].affectedPaths[${pathIndex}]`));
    unique(affectedPaths, `steps[${index}].affectedPaths`);
    const criteriaRaw = boundedArray(step["acceptanceCriteria"], `steps[${index}].acceptanceCriteria`, PLAN_TOOL_MAX.criteriaPerStep);
    if (criteriaRaw.length === 0) fail(`steps[${index}] must contain actionable acceptance criteria`);
    const acceptanceCriteria = criteriaRaw.map((criterion, criterionIndex) => actionable(criterion, `steps[${index}].acceptanceCriteria[${criterionIndex}]`, PLAN_TOOL_MAX.criterion));
    return { id, description, affectedPaths, acceptanceCriteria };
  });
  const stepIds = steps.map(step => step.id);
  unique(stepIds, "step ids");
  if (stepIds.some((id, index) => id !== `step-${index + 1}`)) fail("plan steps must be ordered and contiguous");

  const risksRaw = boundedArray(candidate["risks"], "risks", PLAN_TOOL_MAX.risks);
  const risks = risksRaw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(`risks[${index}] must be an object`);
    const risk = item as Record<string, unknown>;
    if (Object.keys(risk).some(key => key !== "risk" && key !== "mitigation")) fail(`risks[${index}] contains an unknown field`);
    return {
      risk: boundedString(risk["risk"], `risks[${index}].risk`, PLAN_TOOL_MAX.risk),
      mitigation: boundedString(risk["mitigation"], `risks[${index}].mitigation`, PLAN_TOOL_MAX.mitigation),
    };
  });

  const validationCommandIds = validateCommandList(candidate["validationCommandIds"], options);
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
  const disposition = candidate["disposition"] as "pass" | "blocked";
  const { disposition: _disposition, questions: questionsValue, ...document } = candidate;
  const plan = validateImplementationPlanDocument(document, {
    expectedRunId: context.runId,
    expectedTicketIdentifier: context.ticketIdentifier,
    expectedInputHead: context.inputHead,
    allowedValidationCommandIds: context.allowedValidationCommandIds,
    requiredValidationCommandIds: disposition === "pass" ? context.requiredValidationCommandIds : undefined,
    allowUnresolvedAssumptions: disposition === "blocked",
    allowBlockedMarker: disposition === "blocked",
  });
  const questionsRaw = questionsValue === undefined ? [] : boundedArray(questionsValue, "questions", PLAN_TOOL_MAX.questions);
  const questions = questionsRaw.map((question, index) => actionable(question, `questions[${index}]`, PLAN_TOOL_MAX.question));
  if (disposition === "blocked" && questions.length === 0) fail("blocked plan requires at least one actionable question");
  if (disposition === "blocked" && !/\b(?:blocked|must not start|cannot proceed)\b/iu.test(plan.summary)) fail("blocked plan must state that implementation must not start");
  if (disposition === "pass" && questions.length > 0) fail("pass plan cannot contain blocking questions");
  return { disposition, plan, questions };
}

export function validatePlanDocumentForContext(
  plan: ImplementationPlanDocument,
  context: PlanAttemptContext,
  allowedValidationCommandIds?: readonly string[],
  requiredValidationCommandIds?: readonly string[],
): ImplementationPlanDocument {
  return validateImplementationPlanDocument(plan, {
    expectedRunId: context.runId,
    expectedTicketIdentifier: context.ticketIdentifier,
    expectedInputHead: context.inputHead,
    allowedValidationCommandIds,
    requiredValidationCommandIds,
    allowBlockedMarker: true,
  });
}
