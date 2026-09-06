import {
  PLAN_ALLOWED_BUILTIN_TOOLS,
  PLAN_ALLOWED_WIKI_TOOLS,
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
  let submitted = false;
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
      if (submitted) throw new Error("Plan submission tool may be called only once per session");
      submitted = true;
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
 * The materialized source is deliberately self-contained. It imports only
 * Node primitives, so a generated extension in a run-scoped temporary agent
 * directory does not resolve code or dependencies from the workspace. The
 * controller supplies every identity and destination through trusted env.
 */
export function buildTrustedPlanExtensionSource(): string {
  return String.raw`import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, lstat, realpath } from "node:fs/promises";
import path from "node:path";

const TOOL = ${JSON.stringify(PLAN_TOOL_NAME)};
const MAX = ${JSON.stringify(PLAN_TOOL_MAX)};
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const PLAN_SCHEMA = "urn:squire:contracts:v1:implementation-plan";
const RESULT_SCHEMA = "urn:squire:contracts:v1:phase-result";
const INPUT_SCHEMA = "urn:squire:contracts:v1:phase-input";
const CONTROL = /[\u0000-\u001f\u007f]/u;
const RUN_ID = /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HANDOFF_ID = /^handoff_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TICKET_ID = /^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const STEP_ID = /^step-[1-9][0-9]*$/u;
const COMMAND_ID = /^[a-z][a-z0-9_-]{0,63}$/u;
const UNRESOLVED = /\b(?:todo|tbd|unknown|unsure|unresolved|figure\s+out|later|not\s+known|pending)\b/iu;

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0 || CONTROL.test(value)) throw new Error("missing or unsafe trusted Plan environment: " + name);
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
  if (!Array.isArray(value) || value.length > MAX.validationIds || value.some(item => typeof item !== "string" || !COMMAND_ID.test(item))) throw new Error("invalid trusted Plan array: " + name);
  if (new Set(value).size !== value.length) throw new Error("duplicate trusted Plan command id: " + name);
  return value;
}
function text(value, field, max) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max || CONTROL.test(value)) throw new Error(field + " is invalid or unbounded");
  return value;
}
function identifier(value, field, pattern, max) {
  const result = text(value, field, max);
  if (!pattern.test(result)) throw new Error(field + " has an invalid identity");
  return result;
}
function array(value, field, max) {
  if (!Array.isArray(value) || value.length > max) throw new Error(field + " is invalid or unbounded");
  return value;
}
function pathValue(value, field) {
  const result = text(value, field, MAX.path);
  if (result.startsWith("/") || result.startsWith("\\") || /^[A-Za-z]:/u.test(result) || result.includes("\\") || result.includes("//") || result === "." || result.split("/").some(part => part === ".." || part === "." || part.length === 0)) throw new Error(field + " is not repository-relative");
  return result;
}
function actionable(value, field, max) {
  const result = text(value, field, max);
  if (UNRESOLVED.test(result)) throw new Error(field + " is not actionable");
  return result;
}
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
function bytes(value) { return Buffer.from(canonical(value) + "\n", "utf8"); }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function isCode(error, code) { return !!error && typeof error === "object" && error.code === code; }

const phaseInput = {
  path: requiredEnv("SQUIRE_PLAN_INPUT_PATH"),
  sha256: requiredEnv("SQUIRE_PLAN_INPUT_SHA256"),
  schemaId: INPUT_SCHEMA,
};
if (!/^(?:artifacts|evidence)\/(?!.*(?:^|\/)\.\.?\/)[^\u0000\s]+$/u.test(phaseInput.path) || phaseInput.path.length > 1024 || path.posix.normalize(phaseInput.path) !== phaseInput.path || phaseInput.path.includes("\\") || !/^[0-9a-f]{64}$/u.test(phaseInput.sha256)) throw new Error("trusted Plan input artifact is invalid");
const context = {
  runId: identifier(requiredEnv("SQUIRE_PLAN_RUN_ID"), "runId", RUN_ID, 128),
  handoffId: identifier(requiredEnv("SQUIRE_PLAN_HANDOFF_ID"), "handoffId", HANDOFF_ID, 128),
  attempt: integerEnv("SQUIRE_PLAN_ATTEMPT"),
  targetSessionId: identifier(requiredEnv("SQUIRE_PLAN_SESSION_ID"), "targetSessionId", SESSION_ID, 200),
  inputHead: identifier(requiredEnv("SQUIRE_PLAN_INPUT_HEAD"), "inputHead", HEAD, 64),
  ticketIdentifier: identifier(requiredEnv("SQUIRE_PLAN_TICKET_IDENTIFIER"), "ticketIdentifier", TICKET_ID, 64),
  completedAt: requiredEnv("SQUIRE_PLAN_COMPLETED_AT"),
  allowedValidationCommandIds: jsonArrayEnv("SQUIRE_PLAN_ALLOWED_VALIDATION_COMMAND_IDS"),
  requiredValidationCommandIds: jsonArrayEnv("SQUIRE_PLAN_REQUIRED_VALIDATION_COMMAND_IDS"),
  ticketRoot: requiredEnv("SQUIRE_TICKET_ROOT"),
};
if (!Number.isFinite(Date.parse(context.completedAt)) || new Date(context.completedAt).toISOString() !== context.completedAt) throw new Error("trusted Plan completion time is invalid");
if (!path.isAbsolute(context.ticketRoot) || path.resolve(context.ticketRoot) !== context.ticketRoot || path.parse(context.ticketRoot).root === context.ticketRoot || context.ticketRoot.includes("\\") || context.ticketRoot.includes("..")) throw new Error("trusted Plan ticket root is unsafe");
if (context.requiredValidationCommandIds.some(id => !context.allowedValidationCommandIds.includes(id))) throw new Error("trusted Plan required command is not allowed");

function outputPaths() {
  const directory = "artifacts/plan/" + context.attempt;
  const evidenceDirectory = "evidence/plan/" + context.attempt;
  return new Set([directory + "/plan.json", directory + "/result.json", evidenceDirectory + "/verification.md"]);
}
function assertOutputPath(relative) {
  if (!outputPaths().has(relative) || relative.includes("\\") || relative.includes("\u0000")) throw new Error("Plan output path is not fixed");
}
function descriptorPath(directory, name) {
  if (process.platform !== "linux" || constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) throw new Error("secure descriptor Plan output operations are unsupported on this platform");
  if (!Number.isSafeInteger(directory.fd) || directory.fd < 0 || !name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || CONTROL.test(name)) throw new Error("Plan output path component is unsafe");
  return "/proc/self/fd/" + directory.fd + "/" + name;
}
async function openOutputDirectory(root, directory) {
  if (process.platform !== "linux" || constants.O_NOFOLLOW === undefined || constants.O_DIRECTORY === undefined) throw new Error("secure descriptor Plan output operations are unsupported on this platform");
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== root) throw new Error("Plan ticket root has a symbolic-link ancestor");
  const rootPathInfo = await lstat(root);
  const rootHandle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let current = rootHandle;
  try {
    const openedRoot = await rootHandle.stat();
    if (!sameStat(openedRoot, rootPathInfo)) throw new Error("Plan ticket root changed during descriptor open");
    const relative = path.relative(root, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Plan output escaped ticket root");
    for (const part of relative.split(path.sep).filter(Boolean)) {
      if (part === "." || part === ".." || CONTROL.test(part)) throw new Error("Plan output directory is unsafe");
      let next;
      try { next = await open(descriptorPath(current, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
      catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
        try { await mkdir(descriptorPath(current, part), { mode: 0o700 }); }
        catch (mkdirError) { if (!isCode(mkdirError, "EEXIST")) throw mkdirError; }
        await current.sync();
        next = await open(descriptorPath(current, part), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      }
      try {
        const info = await next.stat();
        if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || String(info.dev) !== String(openedRoot.dev)) throw new Error("Plan output directory is not a private same-filesystem directory");
      } catch (error) {
        await next.close();
        throw error;
      }
      if (current !== rootHandle) await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}
async function readExisting(parent, name, expected) {
  const target = descriptorPath(parent, name);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size > MAX_OUTPUT_BYTES) throw new Error("existing Plan output is not a bounded private file");
    const result = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < result.length) {
      const read = await handle.read(result, offset, result.length - offset, offset);
      if (read.bytesRead <= 0) throw new Error("existing Plan output ended during read");
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (!sameStat(before, after)) throw new Error("existing Plan output changed during read");
    const canonicalRoot = await realpath(path.resolve(context.ticketRoot));
    const canonicalTarget = await realpath(target);
    if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(canonicalRoot + path.sep)) throw new Error("existing Plan output escaped ticket root");
    const targetAfter = await lstat(target);
    if (!sameStat(after, targetAfter)) throw new Error("existing Plan output identity changed");
    if (!result.equals(expected)) throw new Error("immutable Plan output conflict");
    return result;
  } finally { await handle.close(); }
}
async function writeImmutable(relative, value) {
  assertOutputPath(relative);
  const root = path.resolve(context.ticketRoot);
  const parts = relative.split("/");
  const directory = path.join(root, ...parts.slice(0, -1));
  const name = parts[parts.length - 1];
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (buffer.length > MAX_OUTPUT_BYTES) throw new Error("Plan output exceeds its size bound");
  const parent = await openOutputDirectory(root, directory);
  try {
    const target = descriptorPath(parent, name);
    try {
      const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        let offset = 0;
        while (offset < buffer.length) {
          const written = await handle.write(buffer, offset, buffer.length - offset, offset);
          if (written.bytesWritten <= 0) throw new Error("Plan output write made no progress");
          offset += written.bytesWritten;
        }
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size !== buffer.length) throw new Error("new Plan output is not a private regular file");
        await handle.sync();
      } finally { await handle.close(); }
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      await readExisting(parent, name, buffer);
    }
    await parent.sync();
    return { path: relative, sha256: digest(buffer) };
  } finally { await parent.close(); }
}
function validateSubmission(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Plan submission must be an object");
  const allowed = new Set(["disposition", "schemaVersion", "runId", "ticketIdentifier", "inputHead", "summary", "assumptions", "steps", "risks", "validationCommandIds", "questions"]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new Error("Plan submission contains an unknown field");
  if (input.disposition !== "pass" && input.disposition !== "blocked") throw new Error("Plan disposition is invalid");
  const disposition = input.disposition;
  if (input.schemaVersion !== 1 || input.runId !== context.runId || input.ticketIdentifier !== context.ticketIdentifier || input.inputHead !== context.inputHead) throw new Error("Plan identity is not controller-bound");
  const summary = text(input.summary, "summary", MAX.summary);
  const assumptions = array(input.assumptions, "assumptions", MAX.assumptions).map((item, index) => {
    const assumption = text(item, "assumptions[" + index + "]", MAX.assumption);
    if (disposition === "pass" && UNRESOLVED.test(assumption)) throw new Error("Plan pass contains an unresolved assumption");
    return assumption;
  });
  const steps = array(input.steps, "steps", MAX.steps);
  if (steps.length === 0) throw new Error("Plan requires a step");
  const normalizedSteps = steps.map((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step) || Object.keys(step).some(key => !["id", "description", "affectedPaths", "acceptanceCriteria"].includes(key))) throw new Error("invalid Plan step");
    const id = identifier(step.id, "steps[" + index + "].id", STEP_ID, 128);
    if (id !== "step-" + (index + 1)) throw new Error("Plan steps must be ordered and contiguous");
    const description = text(step.description, "steps[" + index + "].description", MAX.stepDescription);
    const affectedPaths = array(step.affectedPaths, "steps[" + index + "].affectedPaths", MAX.pathsPerStep).map((item, pathIndex) => pathValue(item, "steps[" + index + "].affectedPaths[" + pathIndex + "]"));
    if (affectedPaths.length === 0 || new Set(affectedPaths).size !== affectedPaths.length) throw new Error("Plan affected paths are invalid");
    const acceptanceCriteria = array(step.acceptanceCriteria, "steps[" + index + "].acceptanceCriteria", MAX.criteriaPerStep).map((item, criterionIndex) => actionable(item, "steps[" + index + "].acceptanceCriteria[" + criterionIndex + "]", MAX.criterion));
    if (acceptanceCriteria.length === 0) throw new Error("Plan steps require acceptance criteria");
    return { id, description, affectedPaths, acceptanceCriteria };
  });
  const risks = array(input.risks, "risks", MAX.risks).map((risk, index) => {
    if (!risk || typeof risk !== "object" || Array.isArray(risk) || Object.keys(risk).some(key => !["risk", "mitigation"].includes(key))) throw new Error("invalid Plan risk");
    return { risk: text(risk.risk, "risks[" + index + "].risk", MAX.risk), mitigation: text(risk.mitigation, "risks[" + index + "].mitigation", MAX.mitigation) };
  });
  const validationCommandIds = array(input.validationCommandIds, "validationCommandIds", MAX.validationIds).map((id, index) => identifier(id, "validationCommandIds[" + index + "]", COMMAND_ID, 64));
  if (validationCommandIds.length === 0 || new Set(validationCommandIds).size !== validationCommandIds.length || validationCommandIds.some(id => !context.allowedValidationCommandIds.includes(id))) throw new Error("Plan validation command ids are invalid or not allowed");
  if (disposition === "pass" && context.requiredValidationCommandIds.some(id => !validationCommandIds.includes(id))) throw new Error("Plan omits a required validation command");
  const questions = input.questions === undefined ? [] : array(input.questions, "questions", MAX.questions).map((question, index) => actionable(question, "questions[" + index + "]", MAX.question));
  if (disposition === "blocked" && questions.length === 0) throw new Error("blocked Plan requires actionable questions");
  if (disposition === "blocked" && !/\b(?:blocked|must not start|cannot proceed)\b/iu.test(summary)) throw new Error("blocked Plan must state that implementation must not start");
  if (disposition === "pass" && questions.length > 0) throw new Error("pass Plan cannot contain blocking questions");
  return { disposition, summary, assumptions, steps: normalizedSteps, risks, validationCommandIds, questions };
}
async function publish(input) {
  const submission = validateSubmission(input);
  const plan = { schemaVersion: 1, runId: context.runId, ticketIdentifier: context.ticketIdentifier, inputHead: context.inputHead, summary: submission.summary, assumptions: submission.assumptions, steps: submission.steps, risks: submission.risks, validationCommandIds: submission.validationCommandIds };
  const planFile = await writeImmutable("artifacts/plan/" + context.attempt + "/plan.json", bytes(plan));
  const questionText = submission.questions.length === 0 ? "none" : submission.questions.map((question, index) => (index + 1) + ". " + question).join("\n");
  const report = ["# Plan verification", "", "- runId: " + context.runId, "- handoffId: " + context.handoffId, "- attempt: " + context.attempt, "- inputHead: " + context.inputHead, "- inputArtifact: " + phaseInput.path + " (sha256:" + phaseInput.sha256 + ")", "- planArtifact: " + planFile.path + " (sha256:" + planFile.sha256 + ")", "- disposition: " + submission.disposition, "- questions: " + questionText, ""].join("\n");
  const reportFile = await writeImmutable("evidence/plan/" + context.attempt + "/verification.md", Buffer.from(report, "utf8"));
  const result = {
    schemaVersion: 1,
    handoffId: context.handoffId,
    inputArtifact: phaseInput,
    runId: context.runId,
    phase: "plan",
    sessionId: context.targetSessionId,
    inputHead: context.inputHead,
    outputHead: context.inputHead,
    status: submission.disposition === "pass" ? "pass" : "failed",
    artifacts: [{ path: planFile.path, sha256: planFile.sha256, mediaType: "application/json", schemaId: PLAN_SCHEMA }],
    evidence: [{ path: reportFile.path, sha256: reportFile.sha256, mediaType: "text/markdown", kind: "report" }],
    findings: [],
    failures: submission.disposition === "pass" ? [] : [{ id: "PLAN_CONTEXT_BLOCKED", category: "policy", blocking: true, summary: "Plan blocked: " + submission.questions.join(" | ") }],
    requestedTransition: submission.disposition === "pass" ? { toState: "implementing", reason: "phase_pass" } : { toState: "failed", reason: "phase_failed" },
    completedAt: context.completedAt,
  };
  const resultFile = await writeImmutable("artifacts/plan/" + context.attempt + "/result.json", bytes(result));
  return { plan: planFile, report: reportFile, result: { path: resultFile.path, sha256: resultFile.sha256, schemaId: RESULT_SCHEMA } };
}
const parameters = ${JSON.stringify({
    type: "object",
    additionalProperties: false,
    required: ["disposition", "schemaVersion", "runId", "ticketIdentifier", "inputHead", "summary", "assumptions", "steps", "risks", "validationCommandIds"],
    properties: {
      disposition: { enum: ["pass", "blocked"] },
      schemaVersion: { const: 1 },
      runId: { type: "string", pattern: "^run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", maxLength: 128 },
      ticketIdentifier: { type: "string", pattern: "^[A-Z][A-Z0-9]+-[1-9][0-9]*$", maxLength: 64 },
      inputHead: { type: "string", pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" },
      summary: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.summary },
      assumptions: { type: "array", maxItems: PLAN_TOOL_MAX.assumptions, items: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.assumption } },
      steps: { type: "array", minItems: 1, maxItems: PLAN_TOOL_MAX.steps, items: { type: "object", additionalProperties: false, required: ["id", "description", "affectedPaths", "acceptanceCriteria"], properties: { id: { type: "string", pattern: "^step-[1-9][0-9]*$", maxLength: 128 }, description: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.stepDescription }, affectedPaths: { type: "array", minItems: 1, maxItems: PLAN_TOOL_MAX.pathsPerStep, items: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.path } }, acceptanceCriteria: { type: "array", minItems: 1, maxItems: PLAN_TOOL_MAX.criteriaPerStep, items: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.criterion } } } } },
      risks: { type: "array", maxItems: PLAN_TOOL_MAX.risks, items: { type: "object", additionalProperties: false, required: ["risk", "mitigation"], properties: { risk: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.risk }, mitigation: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.mitigation } } } },
      validationCommandIds: { type: "array", minItems: 1, maxItems: PLAN_TOOL_MAX.validationIds, items: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" } },
      questions: { type: "array", maxItems: PLAN_TOOL_MAX.questions, items: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.question } },
    },
  }, null, 2)};
let submitted = false;
const planTool = {
  name: TOOL,
  label: "Submit implementation plan",
  description: "Publish one immutable controller-bound Plan outcome and terminate the session.",
  promptSnippet: "Submit exactly one pass or blocked implementation plan",
  promptGuidelines: ["Call exactly once after inspection.", "Use blocked with actionable questions when context is insufficient.", "Do not provide paths or substitute controller identities."],
  parameters,
  async execute(_toolCallId, params) {
    if (submitted) throw new Error("Plan submission tool may be called only once per session");
    submitted = true;
    const published = await publish(params);
    return { content: [{ type: "text", text: params.disposition === "pass" ? "Plan published; the session is complete." : "Plan blocked; implementation must not start." }], details: published, terminate: true };
  },
};
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
    runId: { type: "string", pattern: "^run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", minLength: 1, maxLength: 128 },
    ticketIdentifier: { type: "string", pattern: "^[A-Z][A-Z0-9]+-[1-9][0-9]*$", minLength: 1, maxLength: 64 },
    inputHead: { type: "string", pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" },
    summary: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.summary },
    assumptions: { type: "array", maxItems: PLAN_TOOL_MAX.assumptions, items: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.assumption } },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: PLAN_TOOL_MAX.steps,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description", "affectedPaths", "acceptanceCriteria"],
        properties: {
          id: { type: "string", pattern: "^step-[1-9][0-9]*$", minLength: 1, maxLength: 128 },
          description: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.stepDescription },
          affectedPaths: { type: "array", minItems: 1, maxItems: PLAN_TOOL_MAX.pathsPerStep, items: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.path } },
          acceptanceCriteria: { type: "array", minItems: 1, maxItems: PLAN_TOOL_MAX.criteriaPerStep, items: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.criterion } },
        },
      },
    },
    risks: {
      type: "array",
      maxItems: PLAN_TOOL_MAX.risks,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["risk", "mitigation"],
        properties: {
          risk: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.risk },
          mitigation: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.mitigation },
        },
      },
    },
    validationCommandIds: { type: "array", minItems: 1, maxItems: PLAN_TOOL_MAX.validationIds, items: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" } },
    questions: { type: "array", maxItems: PLAN_TOOL_MAX.questions, items: { type: "string", minLength: 1, maxLength: PLAN_TOOL_MAX.question } },
  },
});
