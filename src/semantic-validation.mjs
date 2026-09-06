import path from "node:path";
import { readFileSync } from "node:fs";

const PROFILE_DEFAULTS = JSON.parse(readFileSync(new URL("./pi/pi-profile-defaults.json", import.meta.url), "utf8"));
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PI_ROLES = ["orchestrator", "plan", "implement", "review", "test"];

/**
 * Compatibility normalization for v1 documents written before AIDEV-228.
 * It fills only additive profile fields; provider/model and operational fields
 * are never guessed. The controller must use the returned copy before schema
 * validation or launch and must not mutate the persisted artifact.
 */
export function normalizeWorkflowConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) || !config.pi || typeof config.pi !== "object") return config;
  const roles = config.pi.roles && typeof config.pi.roles === "object" && !Array.isArray(config.pi.roles)
    ? Object.fromEntries(Object.entries(config.pi.roles).map(([role, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value) || !PI_ROLES.includes(role)) return [role, value];
      return [role, { ...value, thinking: value.thinking ?? PROFILE_DEFAULTS.roles[role].thinking }];
    }))
    : config.pi.roles;
  const wiki = config.pi.wiki ?? { ...PROFILE_DEFAULTS.wiki };
  return { ...config, pi: { ...config.pi, roles, wiki } };
}

const NORMAL_TRANSITIONS = new Map([
  ["accepted:preparing", "run_accepted"],
  ["preparing:planning", "preparation_complete"],
  ["planning:implementing", "phase_pass"],
  ["implementing:reviewing", "phase_pass"],
  ["reviewing:testing", "phase_pass"],
  ["reviewing:implementing", "remediation_required"],
  ["testing:publishing", "phase_pass"],
  ["testing:implementing", "remediation_required"],
  ["publishing:awaiting_approval", "publication_complete"],
  ["awaiting_approval:approved", "approval_observed"]
]);

const RESULT_EXPECTATIONS = {
  plan: {
    pass: ["implementing", "phase_pass"],
    failed: ["failed", "phase_failed"]
  },
  implement: {
    pass: ["reviewing", "phase_pass"],
    failed: ["failed", "phase_failed"]
  },
  review: {
    pass: ["testing", "phase_pass"],
    remediation_required: ["implementing", "remediation_required"],
    failed: ["failed", "phase_failed"]
  },
  test: {
    pass: ["publishing", "phase_pass"],
    remediation_required: ["implementing", "remediation_required"],
    failed: ["failed", "phase_failed"]
  }
};

function mismatch(errors, actual, expected, label) {
  if (expected !== undefined && actual !== expected) errors.push(`${label} does not match trusted context`);
}

function sameReference(left, right) {
  return left && right && left.path === right.path && left.sha256 === right.sha256 && left.schemaId === right.schemaId;
}

function isCanonicalTicketPath(value) {
  return typeof value === "string"
    && (value === "/ticket" || value.startsWith("/ticket/"))
    && path.posix.normalize(value) === value;
}

export function validateWorkflowConfig(config) {
  const errors = [];
  const normalized = normalizeWorkflowConfig(config);
  // pi.version is a legacy v1 advisory only. Runtime selection is resolved once per run
  // and recorded as runtime-resolution evidence; no exact repository-wide pin is enforced.
  if (!normalized?.pi?.roles || !normalized?.validation?.commands) return ["workflow config is missing required Pi or validation sections"];
  const commandIds = normalized.validation.commands.map(({ id }) => id);
  if (new Set(commandIds).size !== commandIds.length) errors.push("validation command IDs must be unique");
  if (config.github.deliveryIdentity.appSlug === config.github.reviewerIdentity.appSlug) {
    errors.push("delivery and reviewer GitHub identities must be distinct");
  }
  for (const [role, settings] of Object.entries(normalized.pi.roles)) {
    if (!isCanonicalTicketPath(settings.instructionsPath)) errors.push(`${role} instructionsPath must be a canonical path beneath /ticket`);
    if (!PI_THINKING_LEVELS.includes(settings.thinking)) errors.push(`${role} thinking must be a valid Pi thinking level`);
    if (!safeProfilePart(settings.provider) || !safeProfilePart(settings.model)) errors.push(`${role} provider/model must be non-empty and free of control characters`);
  }
  if (!normalized.pi.wiki || !PI_THINKING_LEVELS.includes(normalized.pi.wiki.thinking)) errors.push("project-wiki thinking must be a valid Pi thinking level");
  if (!normalized.pi.wiki?.provider || !normalized.pi.wiki?.model) errors.push("project-wiki profile must specify provider and model");
  else if (!safeProfilePart(normalized.pi.wiki.provider) || !safeProfilePart(normalized.pi.wiki.model)) errors.push("project-wiki provider/model must be free of control characters");
  for (const command of normalized.validation.commands) {
    if (!isCanonicalTicketPath(command.cwd)) errors.push(`validation command ${command.id} cwd must be a canonical path beneath /ticket`);
  }
  return errors;
}

function safeProfilePart(value) {
  return typeof value === "string" && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}

const PLAN_LIMITS = Object.freeze({ summary: 16384, assumption: 2048, assumptions: 32, stepDescription: 8192, steps: 64, path: 1024, pathsPerStep: 128, criterion: 4096, criteriaPerStep: 64, risks: 64, risk: 4096, mitigation: 4096, validationIds: 128 });
const PLAN_CONTROL = /[\u0000-\u001f\u007f]/u;
const PLAN_RUN_ID = /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PLAN_TICKET_ID = /^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u;
const PLAN_HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const PLAN_STEP_ID = /^step-[1-9][0-9]*$/u;
const PLAN_COMMAND_ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const PLAN_UNRESOLVED = /\b(?:todo|tbd|unknown|unsure|unresolved|figure\s+out|later|not\s+known|pending)\b/iu;

function boundedPlanString(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !PLAN_CONTROL.test(value);
}

function safePlanPath(value) {
  return boundedPlanString(value, PLAN_LIMITS.path)
    && !value.startsWith("/")
    && !value.startsWith("\\")
    && !/^[A-Za-z]:/u.test(value)
    && !value.includes("\\")
    && !value.includes("//")
    && value !== "."
    && value.split("/").every(part => part !== ".." && part !== "." && part.length > 0);
}

/** Trusted semantic checks for the domain artifact emitted by Plan. */
export function validateImplementationPlan(plan, context = {}) {
  const errors = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return ["implementation plan must be an object"];
  const allowed = new Set(["schemaVersion", "runId", "ticketIdentifier", "inputHead", "summary", "assumptions", "steps", "risks", "validationCommandIds"]);
  for (const key of Object.keys(plan)) if (!allowed.has(key)) errors.push(`implementation plan contains unknown field: ${key}`);
  if (plan.schemaVersion !== 1) errors.push("implementation plan schemaVersion must be 1");
  if (!PLAN_RUN_ID.test(plan.runId ?? "")) errors.push("implementation plan runId is invalid");
  if (!PLAN_TICKET_ID.test(plan.ticketIdentifier ?? "")) errors.push("implementation plan ticketIdentifier is invalid");
  if (!PLAN_HEAD.test(plan.inputHead ?? "")) errors.push("implementation plan inputHead is invalid");
  mismatch(errors, plan.runId, context.runId, "plan runId");
  mismatch(errors, plan.ticketIdentifier, context.ticketIdentifier, "plan ticketIdentifier");
  mismatch(errors, plan.inputHead, context.inputHead, "plan inputHead");
  if (!boundedPlanString(plan.summary, PLAN_LIMITS.summary)) errors.push("implementation plan summary is empty or unbounded");
  if (!Array.isArray(plan.assumptions) || plan.assumptions.length > PLAN_LIMITS.assumptions || plan.assumptions.some(value => !boundedPlanString(value, PLAN_LIMITS.assumption) || (!context.allowBlocked && PLAN_UNRESOLVED.test(value)))) errors.push("implementation plan assumptions are invalid, unresolved, or unbounded");
  if (!Array.isArray(plan.steps) || plan.steps.length === 0 || plan.steps.length > PLAN_LIMITS.steps) errors.push("implementation plan steps are invalid or unbounded");
  else {
    const ids = plan.steps.map(step => step?.id);
    if (ids.some(id => typeof id !== "string" || !PLAN_STEP_ID.test(id))) errors.push("implementation plan step ids are invalid");
    if (new Set(ids).size !== ids.length) errors.push("implementation plan step ids must be unique");
    if (ids.some((id, index) => id !== `step-${index + 1}`)) errors.push("implementation plan steps must be ordered");
    for (const [index, step] of plan.steps.entries()) {
      if (!step || typeof step !== "object" || Array.isArray(step)) { errors.push(`implementation plan step ${index} is invalid`); continue; }
      const stepKeys = Object.keys(step);
      if (stepKeys.some(key => !["id", "description", "affectedPaths", "acceptanceCriteria"].includes(key))) errors.push(`implementation plan step ${index} contains an unknown field`);
      if (!boundedPlanString(step.id, 128) || !PLAN_STEP_ID.test(step.id ?? "")) errors.push(`implementation plan step ${index} has an invalid id`);
      if (!boundedPlanString(step.description, PLAN_LIMITS.stepDescription)) errors.push(`implementation plan step ${index} has no bounded description`);
      if (!Array.isArray(step.affectedPaths) || step.affectedPaths.length === 0 || step.affectedPaths.length > PLAN_LIMITS.pathsPerStep || step.affectedPaths.some(value => !safePlanPath(value))) errors.push(`implementation plan step ${index} has an unsafe affected path`);
      else if (new Set(step.affectedPaths).size !== step.affectedPaths.length) errors.push(`implementation plan step ${index} has duplicate affected paths`);
      if (!Array.isArray(step.acceptanceCriteria) || step.acceptanceCriteria.length === 0 || step.acceptanceCriteria.length > PLAN_LIMITS.criteriaPerStep || step.acceptanceCriteria.some(value => !boundedPlanString(value, PLAN_LIMITS.criterion) || PLAN_UNRESOLVED.test(value))) errors.push(`implementation plan step ${index} lacks actionable acceptance criteria`);
    }
  }
  if (!Array.isArray(plan.risks) || plan.risks.length > PLAN_LIMITS.risks || plan.risks.some(risk => !risk || typeof risk !== "object" || Array.isArray(risk) || Object.keys(risk).some(key => !["risk", "mitigation"].includes(key)) || !boundedPlanString(risk.risk, PLAN_LIMITS.risk) || !boundedPlanString(risk.mitigation, PLAN_LIMITS.mitigation))) errors.push("implementation plan risks are invalid or unbounded");
  if (!Array.isArray(plan.validationCommandIds) || plan.validationCommandIds.length === 0 || plan.validationCommandIds.length > PLAN_LIMITS.validationIds || plan.validationCommandIds.some(id => typeof id !== "string" || !PLAN_COMMAND_ID.test(id)) || new Set(plan.validationCommandIds).size !== plan.validationCommandIds.length) errors.push("implementation plan validation command ids are invalid");
  else {
    const allowedCommands = context.allowedValidationCommandIds;
    if (Array.isArray(allowedCommands) && plan.validationCommandIds.some(id => !allowedCommands.includes(id))) errors.push("implementation plan references an unknown validation command");
    const requiredCommands = context.requiredValidationCommandIds ?? [];
    if (!context.allowBlocked && requiredCommands.some(id => !plan.validationCommandIds.includes(id))) errors.push("implementation plan omits a required validation command");
  }
  if (!context.allowBlocked && typeof plan.summary === "string" && /\b(?:blocked|must not start|cannot proceed)\b/iu.test(plan.summary)) errors.push("pass implementation plan contains a blocked disposition");
  return errors;
}

export function validatePhaseInput(input, context = {}) {
  const errors = [];
  mismatch(errors, input.runId, context.runId, "runId");
  mismatch(errors, input.phase, context.phase, "phase");
  mismatch(errors, input.targetSessionId, context.targetSessionId, "targetSessionId");
  mismatch(errors, input.attempt, context.attempt, "attempt");
  mismatch(errors, input.inputHead, context.inputHead, "inputHead");
  mismatch(errors, input.handoffId, context.handoffId, "handoffId");

  if (input.ticket.schemaId !== "urn:squire:contracts:v1:normalized-ticket") errors.push("ticket must reference a normalized-ticket v1 artifact");
  if (input.configuration.schemaId !== "urn:squire:contracts:v1:workflow-config") errors.push("configuration must reference a workflow-config v1 artifact");
  if ([...(input.artifacts ?? []), ...(input.feedback ?? [])].some(reference => reference.schemaId === "urn:squire:contracts:v1:normalized-ticket" || reference.schemaId === "urn:squire:contracts:v1:workflow-config")) errors.push("phase input hides a duplicate ticket or configuration reference");
  const nestedKeys = [input.ticket, input.configuration, ...(input.artifacts ?? []), ...(input.feedback ?? [])].map(reference => `${reference.path}:${reference.sha256}:${reference.schemaId}`);
  if (new Set(nestedKeys).size !== nestedKeys.length) errors.push("phase input contains duplicate contract references");
  if (input.phase === "implement" && !input.artifacts.some(({ schemaId }) => schemaId === "urn:squire:contracts:v1:implementation-plan")) {
    errors.push("implement input requires an implementation-plan artifact");
  }
  if (input.phase === "review" && !input.artifacts.some(({ schemaId }) => schemaId === "urn:squire:contracts:v1:phase-result")) {
    errors.push("review input requires an implementation phase-result artifact");
  }
  if (input.phase === "test" && !input.artifacts.some(({ schemaId }) => schemaId === "urn:squire:contracts:v1:review-findings")) {
    errors.push("test input requires a review-findings artifact");
  }
  if (input.attempt > 1 && input.feedback.length === 0) errors.push("a remediation attempt requires immutable feedback artifacts");
  return errors;
}

export function validatePhaseTrigger(trigger, input, recordedArtifact) {
  const errors = [];
  for (const field of ["schemaVersion", "handoffId", "runId", "phase", "attempt", "inputHead"]) {
    mismatch(errors, trigger[field], input[field], `trigger ${field}`);
  }
  mismatch(errors, trigger.targetSessionId, input.targetSessionId, "trigger targetSessionId");
  if (trigger.inputArtifact.schemaId !== "urn:squire:contracts:v1:phase-input") errors.push("trigger must reference a phase-input v1 artifact");
  if (!sameReference(trigger.inputArtifact, recordedArtifact)) errors.push("trigger input artifact path/digest does not match the controller record");
  return errors;
}

export function validateRevisedHandoff(previousInput, revisedInput, context = {}) {
  const errors = [];
  for (const field of ["runId", "phase", "targetSessionId", "inputHead"]) {
    mismatch(errors, revisedInput[field], previousInput[field], `revised handoff ${field}`);
  }
  if (revisedInput.handoffId === previousInput.handoffId) errors.push("a revised handoff requires a new handoffId");
  if (revisedInput.attempt !== previousInput.attempt + 1) errors.push("a revised handoff must increment attempt exactly once");

  const previousTime = Date.parse(previousInput.createdAt);
  const revisedTime = Date.parse(revisedInput.createdAt);
  if (!Number.isFinite(previousTime) || !Number.isFinite(revisedTime) || revisedTime <= previousTime) {
    errors.push("a revised handoff creation time must be later than the previous handoff");
  }

  const { previousArtifact, revisedArtifact } = context;
  if (!previousArtifact || !revisedArtifact) {
    errors.push("revised handoff validation requires trusted old and new artifact references");
  } else {
    if (previousArtifact.schemaId !== "urn:squire:contracts:v1:phase-input" || revisedArtifact.schemaId !== "urn:squire:contracts:v1:phase-input") {
      errors.push("revised handoff artifacts must use the phase-input v1 schema");
    }
    if (sameReference(previousArtifact, revisedArtifact) || previousArtifact.path === revisedArtifact.path || previousArtifact.sha256 === revisedArtifact.sha256) {
      errors.push("a revised handoff requires a new artifact path and digest");
    }
  }
  return errors;
}

export function validatePhaseResult(result, context = {}) {
  const errors = [];
  mismatch(errors, result.runId, context.runId, "runId");
  mismatch(errors, result.phase, context.phase, "phase");
  mismatch(errors, result.sessionId, context.sessionId, "sessionId");
  mismatch(errors, result.inputHead, context.inputHead, "inputHead");
  mismatch(errors, result.outputHead, context.outputHead, "outputHead");
  mismatch(errors, result.handoffId, context.handoffId, "handoffId");
  if (context.inputArtifact && !sameReference(result.inputArtifact, context.inputArtifact)) {
    errors.push("result input artifact does not match the validated handoff");
  }

  if ((result.phase === "plan" || result.phase === "review" || result.phase === "test") && result.inputHead !== result.outputHead) {
    errors.push(`${result.phase} must not change head SHA`);
  }
  const requiredArtifactSchema = {
    plan: "urn:squire:contracts:v1:implementation-plan",
    review: "urn:squire:contracts:v1:review-findings",
    test: "urn:squire:contracts:v1:test-evidence"
  }[result.phase];
  if (requiredArtifactSchema && !result.artifacts.some(({ schemaId }) => schemaId === requiredArtifactSchema)) {
    errors.push(`${result.phase} result is missing its schema-identified domain artifact`);
  }
  const expected = RESULT_EXPECTATIONS[result.phase]?.[result.status];
  if (!expected) {
    errors.push(`status ${result.status} is not valid for ${result.phase}`);
  } else if (result.requestedTransition.toState !== expected[0] || result.requestedTransition.reason !== expected[1]) {
    errors.push("requested transition contradicts phase/status");
  }

  const blockingFindings = result.findings.filter(({ blocking }) => blocking);
  const blockingFailures = result.failures.filter(({ blocking }) => blocking);
  if (result.status === "pass" && (blockingFindings.length || blockingFailures.length || result.failures.length)) {
    errors.push("pass result contains unresolved findings or failures");
  }
  if (result.phase === "plan" && result.status === "pass" && result.findings.length > 0) errors.push("pass Plan result must contain no findings");
  if (result.status === "remediation_required" && blockingFindings.length + blockingFailures.length === 0) {
    errors.push("remediation_required result needs a blocking finding or failure");
  }
  return errors;
}

export function validateReviewFindings(review, context = {}) {
  const errors = [];
  mismatch(errors, review.runId, context.runId, "runId");
  mismatch(errors, review.sessionId, context.sessionId, "sessionId");
  mismatch(errors, review.reviewedHead, context.headSha, "reviewedHead");
  const blocking = review.findings.filter(({ blocking }) => blocking).length;
  if (review.status === "pass" && blocking) errors.push("passing review contains blocking findings");
  if (review.status === "remediation_required" && !blocking) errors.push("remediation review has no blocking findings");
  return errors;
}

export function validateTestEvidence(evidence, config, context = {}) {
  const errors = [];
  mismatch(errors, evidence.runId, context.runId, "runId");
  mismatch(errors, evidence.sessionId, context.sessionId, "sessionId");
  mismatch(errors, evidence.testedHead, context.headSha, "testedHead");
  const byId = new Map(evidence.commands.map(command => [command.commandId, command]));
  if (byId.size !== evidence.commands.length) errors.push("test evidence command IDs must be unique");

  for (const configured of config.validation.commands.filter(({ required }) => required)) {
    const observed = byId.get(configured.id);
    if (!observed) errors.push(`missing required command evidence: ${configured.id}`);
    else if (evidence.status === "pass" && (observed.exitCode !== 0 || observed.timedOut)) {
      errors.push(`passing test has unsuccessful required command: ${configured.id}`);
    }
  }
  if (evidence.status === "pass" && evidence.failures.length) errors.push("passing test evidence contains failures");
  if (evidence.status === "remediation_required" && !evidence.failures.some(({ blocking }) => blocking)) {
    errors.push("remediation test evidence has no blocking failure");
  }
  return errors;
}

export function validateTransitionRequest(request, context = {}) {
  const errors = [];
  mismatch(errors, request.runId, context.runId, "runId");
  mismatch(errors, request.orchestratorSessionId, context.orchestratorSessionId, "orchestratorSessionId");
  mismatch(errors, request.fromState, context.currentState, "fromState");
  mismatch(errors, request.currentHead, context.currentHead, "currentHead");

  const terminalTrigger = request.toState === "failed" ? "system_failure"
    : request.toState === "cancelled" ? "operator_cancel"
      : request.toState === "expired" ? "retention_expired" : undefined;
  const expectedTrigger = NORMAL_TRANSITIONS.get(`${request.fromState}:${request.toState}`) ?? terminalTrigger;
  if (!expectedTrigger || request.trigger !== expectedTrigger) errors.push("illegal transition or trigger");

  const needsPhaseResult = request.trigger === "phase_pass" || request.trigger === "remediation_required";
  if (needsPhaseResult && request.phaseResult === null) errors.push("phase transition requires a validated phase result reference");
  if (request.phaseResult && request.phaseResult.schemaId !== "urn:squire:contracts:v1:phase-result") {
    errors.push("transition must reference a phase-result v1 artifact");
  }
  if (needsPhaseResult && !context.phaseResult) {
    errors.push("phase transition requires the controller-accepted phase result in trusted context");
  } else if (needsPhaseResult && !sameReference(request.phaseResult, context.phaseResult)) {
    errors.push("transition phase result does not match the controller-accepted result");
  }
  if (!needsPhaseResult && request.phaseResult !== null) errors.push("non-phase transition must not attach a phase result");
  return errors;
}

export function validatePullRequestDeliveryState(delivery, config, context = {}) {
  const errors = [];
  mismatch(errors, delivery.runId, context.runId, "runId");
  mismatch(errors, delivery.headSha, context.headSha, "headSha");
  mismatch(errors, delivery.repository, context.repository, "repository");
  mismatch(errors, delivery.baseBranch, context.baseBranch, "baseBranch");
  mismatch(errors, delivery.featureBranch, context.featureBranch, "featureBranch");
  if (delivery.pullRequest) {
    mismatch(errors, delivery.pullRequest.number, context.pullRequestNumber, "pull request number");
    mismatch(errors, delivery.pullRequest.url, context.pullRequestUrl, "pull request URL");
  }
  if (delivery.pullRequest && delivery.pullRequest.headSha !== delivery.headSha) errors.push("pull request head is stale");
  for (const check of delivery.checks) if (check.headSha !== delivery.headSha) errors.push(`check is stale: ${check.name}`);
  for (const approval of delivery.approvals) if (approval.headSha !== delivery.headSha) errors.push(`approval is stale: ${approval.appSlug}`);

  if (delivery.status === "ready_for_human_merge") {
    const requiredContext = ["runId", "headSha", "repository", "baseBranch", "featureBranch", "pullRequestNumber", "pullRequestUrl"];
    for (const field of requiredContext) {
      if (context[field] === undefined) errors.push(`ready delivery requires trusted ${field} context`);
    }
    if (!delivery.pullRequest) errors.push("ready delivery requires a pull request");
    if (!delivery.mergeable) errors.push("ready delivery must be mergeable");
    if (delivery.pullRequest?.authorAppSlug !== config.github.deliveryIdentity.appSlug) errors.push("pull request author is not the configured Delivery identity");
    for (const required of config.github.requiredChecks) {
      if (!delivery.checks.some(check => check.name === required && check.status === "success" && check.headSha === delivery.headSha)) {
        errors.push(`required check has not succeeded at current head: ${required}`);
      }
    }
    const currentApprovals = delivery.approvals.filter(approval => approval.headSha === delivery.headSha);
    const currentApprovers = new Set(currentApprovals.map(({ appSlug }) => appSlug));
    if (currentApprovers.size < config.github.rules.requiredApprovals) {
      errors.push("current head lacks the configured number of approvals");
    }
    if (!currentApprovers.has(config.github.reviewerIdentity.appSlug)) {
      errors.push("current head lacks configured Reviewer identity approval");
    }
  }
  return errors;
}

export function assertSemantic(errors, label = "contract") {
  if (errors.length) throw new Error(`${label}: ${errors.join("; ")}`);
}
