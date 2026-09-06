import {
  PLAN_ALLOWED_BUILTIN_TOOLS,
  PLAN_ALLOWED_WIKI_TOOLS,
  PLAN_EXTENSION_RELATIVE_PATH,
  PLAN_TOOL_MAX,
  PLAN_TOOL_NAME,
  type PlanPublicationContext,
  type PlanSubmission,
} from "./domain.js";
import { validatePlanSubmission, type PlanSubmissionContext } from "./plan-validation.js";

export interface PlanExtensionContext extends PlanPublicationContext {
  readonly allowedValidationCommandIds: readonly string[];
  readonly requiredValidationCommandIds: readonly string[];
}

export interface PlanExtensionPublisher {
  publish(submission: PlanSubmission, context: PlanExtensionContext): Promise<unknown>;
}

export interface PlanToolDefinition {
  readonly name: typeof PLAN_TOOL_NAME;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: readonly string[];
  readonly parameters: unknown;
  execute(toolCallId: string, input: unknown): Promise<unknown>;
}

export interface PlanExtensionApi {
  registerTool(tool: PlanToolDefinition): void;
}

export function createPlanSubmissionTool(
  context: PlanExtensionContext,
  publisher: PlanExtensionPublisher,
  parameters: unknown = PLAN_TOOL_PARAMETERS,
): PlanToolDefinition {
  const validationContext: PlanSubmissionContext = {
    runId: context.runId,
    ticketIdentifier: context.ticketIdentifier,
    inputHead: context.inputHead,
    allowedValidationCommandIds: context.allowedValidationCommandIds,
    requiredValidationCommandIds: context.requiredValidationCommandIds,
  };
  return {
    name: PLAN_TOOL_NAME,
    label: "Submit implementation plan",
    description: "Publish the one immutable, controller-bound Plan outcome and end this session.",
    promptSnippet: "Submit exactly one pass or blocked implementation plan",
    promptGuidelines: [
      "Call this tool exactly once after inspection.",
      "Use blocked when trusted context is missing, stale, contradictory, or insufficient.",
      "Never provide a destination path, run identity, session identity, or input artifact: those are controller-bound.",
    ],
    parameters,
    async execute(_toolCallId, input) {
      const submission = validatePlanSubmission(input, validationContext);
      const publication = await publisher.publish(submission, context);
      return {
        content: [{ type: "text", text: submission.disposition === "pass" ? "Plan published; the session is complete." : "Plan blocked; implementation must not start." }],
        details: { disposition: submission.disposition, publication },
        terminate: true,
      };
    },
  };
}

export function registerPlanSubmissionTool(api: PlanExtensionApi, context: PlanExtensionContext, publisher: PlanExtensionPublisher): void {
  api.registerTool(createPlanSubmissionTool(context, publisher));
}

/**
 * The materialized source is deliberately self-contained. It imports only Pi's
 * extension API and Node's crypto/fs primitives; it cannot import workspace
 * modules or receive an output path from model arguments.
 */
export function buildTrustedPlanExtensionSource(): string {
  return String.raw`import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { mkdir, open, lstat, readFile, stat } from "node:fs/promises";
import path from "node:path";

const TOOL = ${JSON.stringify(PLAN_TOOL_NAME)};
const MAX = ${JSON.stringify(PLAN_TOOL_MAX)};
const PLAN_SCHEMA = "urn:squire:contracts:v1:implementation-plan";
const RESULT_SCHEMA = "urn:squire:contracts:v1:phase-result";
const INPUT_SCHEMA = "urn:squire:contracts:v1:phase-input";
const phaseInput = {
  path: requiredEnv("SQUIRE_PLAN_INPUT_PATH"),
  sha256: requiredEnv("SQUIRE_PLAN_INPUT_SHA256"),
  schemaId: INPUT_SCHEMA,
};
const context = {
  runId: requiredEnv("SQUIRE_PLAN_RUN_ID"),
  handoffId: requiredEnv("SQUIRE_PLAN_HANDOFF_ID"),
  attempt: integerEnv("SQUIRE_PLAN_ATTEMPT"),
  targetSessionId: requiredEnv("SQUIRE_PLAN_SESSION_ID"),
  inputHead: requiredEnv("SQUIRE_PLAN_INPUT_HEAD"),
  ticketIdentifier: requiredEnv("SQUIRE_PLAN_TICKET_IDENTIFIER"),
  completedAt: requiredEnv("SQUIRE_PLAN_COMPLETED_AT"),
  allowedValidationCommandIds: jsonArrayEnv("SQUIRE_PLAN_ALLOWED_VALIDATION_COMMAND_IDS"),
  requiredValidationCommandIds: jsonArrayEnv("SQUIRE_PLAN_REQUIRED_VALIDATION_COMMAND_IDS"),
  ticketRoot: requiredEnv("SQUIRE_TICKET_ROOT"),
};

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0 || /[\\u0000-\\u001f\\u007f]/u.test(value)) throw new Error("missing trusted Plan environment: " + name);
  return value;
}
function integerEnv(name) {
  const value = Number(requiredEnv(name));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("invalid trusted Plan integer: " + name);
  return value;
}
function jsonArrayEnv(name) {
  let value;
  try { value = JSON.parse(requiredEnv(name)); } catch { throw new Error("invalid trusted Plan array: " + name); }
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error("invalid trusted Plan array: " + name);
  return value;
}
function text(value, field, max) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || /[\\u0000-\\u001f\\u007f]/u.test(value)) throw new Error(field + " is invalid or unbounded");
  return value;
}
function array(value, field, max) {
  if (!Array.isArray(value) || value.length > max) throw new Error(field + " is invalid or unbounded");
  return value;
}
function pathValue(value, field) {
  const result = text(value, field, MAX.path);
  if (result.startsWith("/") || result.startsWith("\\\\") || /^[A-Za-z]:/u.test(result) || result.includes("\\\\") || result.includes("//") || result.split("/").some(part => part === ".." || part === "." || part.length === 0)) throw new Error(field + " is not repository-relative");
  return result;
}
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
function bytes(value) { return Buffer.from(canonical(value) + "\\n", "utf8"); }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function ref(relative, value, schemaId) { return { path: relative, sha256: digest(value), schemaId }; }
function evidenceRef(relative, value) { return { path: relative, sha256: digest(value), mediaType: "text/markdown", kind: "report" }; }
async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) throw new Error("Plan output directory is not a private directory");
}
async function writeImmutable(relative, value) {
  if (!relative.startsWith("artifacts/plan/") && !relative.startsWith("evidence/plan/")) throw new Error("Plan output path is not fixed");
  if (relative.includes("..") || relative.includes("\\\\") || relative.includes("\\u0000")) throw new Error("Plan output path is unsafe");
  const root = path.resolve(context.ticketRoot);
  const target = path.resolve(root, ...relative.split("/"));
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("Plan output escaped ticket root");
  await ensureDirectory(path.dirname(target));
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  try {
    const handle = await open(target, "wx", 0o600);
    try { await handle.write(buffer); await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw new Error("Plan output conflict is not a regular private file");
    const existing = await readFile(target);
    if (!existing.equals(buffer)) throw new Error("immutable Plan output conflict");
  }
  const directory = await lstat(path.dirname(target));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Plan output parent changed");
  return { path: relative, sha256: digest(buffer) };
}
function validateSubmission(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Plan submission must be an object");
  const keys = Object.keys(input);
  const allowed = new Set(["disposition", "schemaVersion", "runId", "ticketIdentifier", "inputHead", "summary", "assumptions", "steps", "risks", "validationCommandIds", "questions"]);
  if (keys.some(key => !allowed.has(key))) throw new Error("Plan submission contains an unknown field");
  if (input.disposition !== "pass" && input.disposition !== "blocked") throw new Error("Plan disposition is invalid");
  if (input.schemaVersion !== 1 || input.runId !== context.runId || input.ticketIdentifier !== context.ticketIdentifier || input.inputHead !== context.inputHead) throw new Error("Plan identity is not controller-bound");
  text(input.summary, "summary", MAX.summary);
  const assumptions = array(input.assumptions, "assumptions", MAX.assumptions);
  assumptions.forEach((item, index) => text(item, "assumptions[" + index + "]", MAX.assumption));
  const steps = array(input.steps, "steps", MAX.steps);
  if (steps.length === 0) throw new Error("Plan requires a step");
  const ids = [];
  steps.forEach((step, index) => {
    if (!step || typeof step !== "object" || Object.keys(step).some(key => !["id", "description", "affectedPaths", "acceptanceCriteria"].includes(key))) throw new Error("invalid Plan step");
    const id = text(step.id, "steps[" + index + "].id", 128); ids.push(id);
    text(step.description, "steps[" + index + "].description", MAX.stepDescription);
    array(step.affectedPaths, "steps[" + index + "].affectedPaths", MAX.pathsPerStep).forEach((item, pathIndex) => pathValue(item, "steps[" + index + "].affectedPaths[" + pathIndex + "]"));
    const criteria = array(step.acceptanceCriteria, "steps[" + index + "].acceptanceCriteria", MAX.criteriaPerStep);
    if (criteria.length === 0) throw new Error("Plan steps require acceptance criteria");
    criteria.forEach((item, criterionIndex) => { const criterion = text(item, "steps[" + index + "].acceptanceCriteria[" + criterionIndex + "]", MAX.criterion); if (/\\b(?:todo|tbd|unknown|unsure|unresolved|later)\\b/iu.test(criterion)) throw new Error("Plan acceptance criteria must be actionable"); });
  });
  if (new Set(ids).size !== ids.length) throw new Error("Plan step ids must be unique");
  if (ids.every(id => /^step-[0-9]+$/u.test(id)) && ids.some((id, index) => id !== "step-" + (index + 1))) throw new Error("Plan steps must be ordered");
  array(input.risks, "risks", MAX.risks).forEach((risk, index) => { if (!risk || typeof risk !== "object" || Object.keys(risk).some(key => !["risk", "mitigation"].includes(key))) throw new Error("invalid Plan risk"); text(risk.risk, "risks[" + index + "].risk", MAX.risk); text(risk.mitigation, "risks[" + index + "].mitigation", MAX.mitigation); });
  const idsToRun = array(input.validationCommandIds, "validationCommandIds", MAX.validationIds).map((id, index) => text(id, "validationCommandIds[" + index + "]", 128));
  if (idsToRun.length === 0 || new Set(idsToRun).size !== idsToRun.length) throw new Error("Plan validation command ids are invalid");
  if (idsToRun.some(id => !context.allowedValidationCommandIds.includes(id))) throw new Error("Plan references an unknown validation command");
  if (input.disposition === "pass" && context.requiredValidationCommandIds.some(id => !idsToRun.includes(id))) throw new Error("Plan omits a required validation command");
  const questions = input.questions === undefined ? [] : array(input.questions, "questions", MAX.questions).map((question, index) => text(question, "questions[" + index + "]", MAX.question));
  if (input.disposition === "blocked" && questions.length === 0) throw new Error("blocked Plan requires actionable questions");
  if (input.disposition === "blocked" && !/\\b(?:blocked|must not start|cannot proceed)\\b/iu.test(input.summary)) throw new Error("blocked Plan must state that implementation must not start");
  if (input.disposition === "pass" && questions.length > 0) throw new Error("pass Plan cannot contain blocking questions");
  return { ...input, assumptions, steps, risks: input.risks, validationCommandIds: idsToRun, questions };
}
async function publish(input) {
  const submission = validateSubmission(input);
  const plan = { schemaVersion: 1, runId: context.runId, ticketIdentifier: context.ticketIdentifier, inputHead: context.inputHead, summary: submission.summary, assumptions: submission.assumptions, steps: submission.steps, risks: submission.risks, validationCommandIds: submission.validationCommandIds };
  const planBytes = bytes(plan);
  const planRelative = "artifacts/plan/" + context.attempt + "/plan.json";
  const planFile = await writeImmutable(planRelative, planBytes);
  const reportRelative = "evidence/plan/" + context.attempt + "/verification.md";
  const questionText = submission.questions.length === 0 ? "none" : submission.questions.map((question, index) => (index + 1) + ". " + question).join("\\n");
  const report = "# Plan verification\\n\\n" +
    "- runId: " + context.runId + "\\n" +
    "- handoffId: " + context.handoffId + "\\n" +
    "- attempt: " + context.attempt + "\\n" +
    "- inputHead: " + context.inputHead + "\\n" +
    "- inputArtifact: " + phaseInput.path + " (sha256:" + phaseInput.sha256 + ")\\n" +
    "- disposition: " + submission.disposition + "\\n" +
    "- questions: " + questionText + "\\n";
  const reportBytes = Buffer.from(report, "utf8");
  const reportFile = await writeImmutable(reportRelative, reportBytes);
  const result = {
    schemaVersion: 1, handoffId: context.handoffId, inputArtifact: phaseInput, runId: context.runId, phase: "plan", sessionId: context.targetSessionId,
    inputHead: context.inputHead, outputHead: context.inputHead, status: submission.disposition === "pass" ? "pass" : "failed",
    artifacts: [{ path: planFile.path, sha256: planFile.sha256, mediaType: "application/json", schemaId: PLAN_SCHEMA }],
    evidence: [{ path: reportFile.path, sha256: reportFile.sha256, mediaType: "text/markdown", kind: "report" }],
    findings: [],
    failures: submission.disposition === "pass" ? [] : [{ id: "PLAN_CONTEXT_BLOCKED", category: "policy", blocking: true, summary: "Plan blocked: " + submission.questions.join(" | ") }],
    requestedTransition: submission.disposition === "pass" ? { toState: "implementing", reason: "phase_pass" } : { toState: "failed", reason: "phase_failed" },
    completedAt: context.completedAt,
  };
  const resultBytes = bytes(result);
  const resultRelative = "artifacts/plan/" + context.attempt + "/result.json";
  const resultFile = await writeImmutable(resultRelative, resultBytes);
  return { plan: planFile, report: reportFile, result: { path: resultFile.path, sha256: resultFile.sha256, schemaId: RESULT_SCHEMA } };
}
const parameters = Type.Object({
  disposition: Type.Union([Type.Literal("pass"), Type.Literal("blocked")]),
  schemaVersion: Type.Literal(1),
  runId: Type.String({ minLength: 1, maxLength: 128 }),
  ticketIdentifier: Type.String({ minLength: 1, maxLength: 64 }),
  inputHead: Type.String({ minLength: 1, maxLength: 128 }),
  summary: Type.String({ minLength: 1, maxLength: MAX.summary }),
  assumptions: Type.Array(Type.String({ minLength: 1, maxLength: MAX.assumption }), { maxItems: MAX.assumptions }),
  steps: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 128 }),
    description: Type.String({ minLength: 1, maxLength: MAX.stepDescription }),
    affectedPaths: Type.Array(Type.String({ minLength: 1, maxLength: MAX.path }), { maxItems: MAX.pathsPerStep }),
    acceptanceCriteria: Type.Array(Type.String({ minLength: 1, maxLength: MAX.criterion }), { minItems: 1, maxItems: MAX.criteriaPerStep }),
  }), { minItems: 1, maxItems: MAX.steps }),
  risks: Type.Array(Type.Object({ risk: Type.String({ minLength: 1, maxLength: MAX.risk }), mitigation: Type.String({ minLength: 1, maxLength: MAX.mitigation }) }), { maxItems: MAX.risks }),
  validationCommandIds: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: MAX.validationIds }),
  questions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: MAX.question }), { maxItems: MAX.questions })),
});
const planTool = defineTool({
  name: TOOL,
  label: "Submit implementation plan",
  description: "Publish one immutable controller-bound Plan outcome and terminate the session.",
  promptSnippet: "Submit exactly one pass or blocked implementation plan",
  promptGuidelines: ["Call exactly once after inspection.", "Use blocked with actionable questions when context is insufficient.", "Do not provide paths or substitute controller identities."],
  parameters,
  async execute(_toolCallId, params) {
    const published = await publish(params);
    return { content: [{ type: "text", text: params.disposition === "pass" ? "Plan published; the session is complete." : "Plan blocked; implementation must not start." }], details: published, terminate: true };
  },
});
export default function (pi) { pi.registerTool(planTool); }
`;
}

export const PLAN_TOOL_PARAMETERS = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["disposition", "schemaVersion", "runId", "ticketIdentifier", "inputHead", "summary", "assumptions", "steps", "risks", "validationCommandIds"],
  properties: {
    disposition: { enum: ["pass", "blocked"] },
    schemaVersion: { const: 1 },
    runId: { type: "string", minLength: 1, maxLength: 128 },
    ticketIdentifier: { type: "string", minLength: 1, maxLength: 64 },
    inputHead: { type: "string", minLength: 1, maxLength: 128 },
    summary: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.summary },
    assumptions: { type: "array", maxItems: PLAN_TOOL_MAX.assumptions },
    steps: { type: "array", minItems: 1, maxItems: PLAN_TOOL_MAX.steps },
    risks: { type: "array", maxItems: PLAN_TOOL_MAX.risks },
    validationCommandIds: { type: "array", minItems: 1, maxItems: PLAN_TOOL_MAX.validationIds },
    questions: { type: "array", maxItems: PLAN_TOOL_MAX.questions },
  },
});

