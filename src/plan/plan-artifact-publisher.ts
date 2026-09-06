import { createHash } from "node:crypto";
import path from "node:path";
import type { ArtifactReference, ContractReference } from "../control/domain.js";
import { validatePhaseResultTrusted, type JsonObject, type PhaseResultDocument } from "../contracts/v1-artifact-validator.js";
import { V1ArtifactValidator } from "../contracts/v1-artifact-validator.js";
import { assertTicketRoot, ensurePrivateDirectory, inspectResource, isAlreadyExists, readExactNoFollow, writeExclusiveFile } from "../git/paths.js";
import { serializeCanonical } from "../git/contracts.js";
import {
  IMPLEMENTATION_PLAN_SCHEMA_ID,
  PHASE_INPUT_SCHEMA_ID,
  PHASE_RESULT_SCHEMA_ID,
  type ImplementationPlanDocument,
  type PlanPublicationContext,
  type PlanPublicationResult,
  type PlanSubmission,
} from "./domain.js";
import { validatePlanSubmission } from "./plan-validation.js";

const PLAN_EVIDENCE_SCHEMA_ID = "urn:squire:contracts:v1:plan-evidence";
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const RUN_ID = /^run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const HANDOFF_ID = /^handoff_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TICKET_IDENTIFIER = /^[A-Z][A-Z0-9]+-[1-9][0-9]*$/u;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const COMMAND_ID = /^[a-z][a-z0-9_-]{0,63}$/u;

export class PlanArtifactPublicationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlanArtifactPublicationError";
  }
}

export interface PlanArtifactPublisherOptions {
  readonly ticketRoot?: string;
  readonly validator?: V1ArtifactValidator;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(message: string): never {
  throw new PlanArtifactPublicationError(message);
}

function isCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code;
}

function assertSafeRoot(ticketRoot: string): string {
  if (!path.isAbsolute(ticketRoot) || ticketRoot.includes("\u0000") || CONTROL_CHARACTER.test(ticketRoot)) fail("Plan ticket root is unsafe");
  try { return assertTicketRoot(path.resolve(ticketRoot)); }
  catch (error) { throw new PlanArtifactPublicationError("Plan ticket root is unsafe", { cause: error }); }
}

function assertRelativeOutput(relativePath: string): void {
  if (!relativePath || relativePath.length > 1024 || path.posix.normalize(relativePath) !== relativePath || relativePath.startsWith("/") || relativePath.includes("\\") || CONTROL_CHARACTER.test(relativePath) || relativePath.split("/").some(part => part === ".." || part === "." || part.length === 0)) fail("Plan output path is not fixed and relative");
  if (!relativePath.startsWith("artifacts/plan/") && !relativePath.startsWith("evidence/plan/")) fail("Plan output path is outside the Plan output roots");
}

async function ensureOutputDirectory(root: string, directory: string): Promise<void> {
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail("Plan output directory escaped ticket root");
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    if (part === "." || part === ".." || part.includes("\u0000") || CONTROL_CHARACTER.test(part)) fail("Plan output directory is unsafe");
    current = path.join(current, part);
    try { await ensurePrivateDirectory(current, root); }
    catch (error) { throw new PlanArtifactPublicationError("Plan output directory is not private", { cause: error }); }
  }
}

function isExistingError(error: unknown): boolean {
  if (isCode(error, "EEXIST")) return true;
  return !!error && typeof error === "object" && "cause" in error && isCode((error as { cause?: unknown }).cause, "EEXIST");
}

async function readExistingCreateOnly(target: string, root: string, bytes: Buffer): Promise<void> {
  try {
    const identity = await inspectResource(target, "file", true, root);
    if (identity.mode !== 0o600 || identity.linkCount !== 1) fail("existing Plan output is not a bounded private file");
    const existing = await readExactNoFollow(target, root, MAX_OUTPUT_BYTES);
    if (!existing.equals(bytes)) fail("immutable Plan output conflict");
  } catch (error) {
    if (error instanceof PlanArtifactPublicationError) throw error;
    const detail = error instanceof Error ? error.message : "existing Plan output cannot be opened safely";
    throw new PlanArtifactPublicationError(`${detail}; existing Plan output conflict`, { cause: error });
  }
}

async function writeCreateOnly(ticketRoot: string, relativePath: string, bytes: Buffer, schemaId: string): Promise<ContractReference> {
  assertRelativeOutput(relativePath);
  if (bytes.length > MAX_OUTPUT_BYTES) fail("Plan output exceeds its size bound");
  const root = assertSafeRoot(ticketRoot);
  const target = path.resolve(root, ...relativePath.split("/"));
  if (target === root || !target.startsWith(`${root}${path.sep}`)) fail("Plan output escaped ticket root");
  const parent = path.dirname(target);
  await ensureOutputDirectory(root, parent);
  let created = false;
  try {
    await writeExclusiveFile(target, bytes, root, 0o600);
    created = true;
  } catch (error) {
    if (created || !isExistingError(error)) throw error;
    await readExistingCreateOnly(target, root, bytes);
  }
  return { path: relativePath, sha256: digest(bytes), schemaId };
}

function assertContractReference(reference: ContractReference, field: string, schemaId?: string): void {
  const keys = Object.keys(reference).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["path", "schemaId", "sha256"]) || typeof reference.path !== "string" || reference.path.length > 1024 || !/^(?:artifacts|evidence)\/(?!.*(?:^|\/)\.\.?\/)[^\u0000\s]+$/u.test(reference.path) || path.posix.normalize(reference.path) !== reference.path || reference.path.includes("\\") || !/^[0-9a-f]{64}$/u.test(reference.sha256) || !/^urn:squire:contracts:v1:[a-z-]+$/u.test(reference.schemaId) || (schemaId !== undefined && reference.schemaId !== schemaId)) fail(`${field} is not an exact contract reference`);
}

function assertBoundedIdentity(value: unknown, field: string, pattern: RegExp, max: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || CONTROL_CHARACTER.test(value) || !pattern.test(value)) fail(`Plan publication ${field} is malformed`);
}

function assertCommandIds(value: readonly string[] | undefined, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 128 || value.some(id => typeof id !== "string" || !COMMAND_ID.test(id)) || new Set(value).size !== value.length) fail(`Plan publication ${field} is malformed`);
}

function assertContext(context: PlanPublicationContext): void {
  assertBoundedIdentity(context.runId, "run identity", RUN_ID, 128);
  assertBoundedIdentity(context.handoffId, "handoff identity", HANDOFF_ID, 128);
  assertBoundedIdentity(context.targetSessionId, "session identity", SESSION_ID, 200);
  assertBoundedIdentity(context.inputHead, "input head", /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u, 64);
  assertBoundedIdentity(context.ticketIdentifier, "ticket identity", TICKET_IDENTIFIER, 64);
  if (!Number.isSafeInteger(context.attempt) || context.attempt < 1) fail("Plan publication attempt is invalid");
  if (new Date(context.completedAt).toISOString() !== context.completedAt) fail("Plan publication completion time is invalid");
  assertContractReference(context.inputArtifact, "Plan publication input artifact", PHASE_INPUT_SCHEMA_ID);
  if (context.phaseInputDigest !== undefined && context.phaseInputDigest !== context.inputArtifact.sha256) fail("Plan publication input digest was substituted");
  assertCommandIds(context.allowedValidationCommandIds, "allowed validation commands");
  assertCommandIds(context.requiredValidationCommandIds, "required validation commands");
  if (context.allowedValidationCommandIds !== undefined && context.requiredValidationCommandIds !== undefined && context.requiredValidationCommandIds.some(id => !context.allowedValidationCommandIds!.includes(id))) fail("Plan publication required command is not allowed");
  if (context.ticketRoot !== undefined) assertSafeRoot(context.ticketRoot);
}

function reportText(context: PlanPublicationContext, submission: PlanSubmission, planReference: ContractReference): Buffer {
  const questions = submission.questions.length === 0 ? "none" : submission.questions.map((question, index) => `${index + 1}. ${question}`).join("\n");
  return Buffer.from([
    "# Plan verification",
    "",
    `- runId: ${context.runId}`,
    `- handoffId: ${context.handoffId}`,
    `- attempt: ${context.attempt}`,
    `- inputHead: ${context.inputHead}`,
    `- inputArtifact: ${context.inputArtifact.path} (sha256:${context.inputArtifact.sha256})`,
    `- planArtifact: ${planReference.path} (sha256:${planReference.sha256})`,
    `- disposition: ${submission.disposition}`,
    `- questions: ${questions}`,
    "",
  ].join("\n"), "utf8");
}

export class PlanArtifactPublisher {
  readonly #ticketRoot: string;
  readonly #validator: V1ArtifactValidator | undefined;

  constructor(options: PlanArtifactPublisherOptions = {}) {
    this.#ticketRoot = assertSafeRoot(options.ticketRoot ?? "/ticket");
    this.#validator = options.validator;
  }

  async publish(submission: PlanSubmission, context: PlanPublicationContext): Promise<PlanPublicationResult> {
    assertContext(context);
    if (context.ticketRoot !== undefined && assertSafeRoot(context.ticketRoot) !== this.#ticketRoot) fail("Plan publication ticket root was substituted");
    const validatedSubmission = validatePlanSubmission({
      disposition: submission.disposition,
      ...submission.plan,
      questions: submission.questions,
    }, {
      runId: context.runId,
      ticketIdentifier: context.ticketIdentifier,
      inputHead: context.inputHead,
      ...(context.allowedValidationCommandIds !== undefined ? { allowedValidationCommandIds: context.allowedValidationCommandIds } : {}),
      ...(context.requiredValidationCommandIds !== undefined ? { requiredValidationCommandIds: context.requiredValidationCommandIds } : {}),
    });
    const normalizedSubmission: PlanSubmission = validatedSubmission;
    const plan = normalizedSubmission.plan;
    if (normalizedSubmission.disposition === "blocked" && !/\b(?:blocked|must not start|cannot proceed)\b/iu.test(plan.summary)) fail("blocked Plan must explicitly state that implementation must not start");
    if (this.#validator) this.#validator.validateDocument<JsonObject>(IMPLEMENTATION_PLAN_SCHEMA_ID, plan as unknown as JsonObject);
    const planBytes = serializeCanonical(plan);
    const planPath = `artifacts/plan/${context.attempt}/plan.json`;
    const planReference = await writeCreateOnly(this.#ticketRoot, planPath, planBytes, IMPLEMENTATION_PLAN_SCHEMA_ID);
    const evidenceBytes = reportText(context, normalizedSubmission, planReference);
    const evidencePath = `evidence/plan/${context.attempt}/verification.md`;
    const evidenceReferenceRaw = await writeCreateOnly(this.#ticketRoot, evidencePath, evidenceBytes, PLAN_EVIDENCE_SCHEMA_ID);
    const evidenceReference: ArtifactReference & { readonly kind: "report" } = { path: evidenceReferenceRaw.path, sha256: evidenceReferenceRaw.sha256, mediaType: "text/markdown", kind: "report" };
    const resultDocument: PhaseResultDocument = {
      schemaVersion: 1,
      handoffId: context.handoffId,
      inputArtifact: context.inputArtifact,
      runId: context.runId,
      phase: "plan",
      sessionId: context.targetSessionId,
      inputHead: context.inputHead,
      outputHead: context.inputHead,
      status: normalizedSubmission.disposition === "pass" ? "pass" : "failed",
      artifacts: [{ path: planReference.path, sha256: planReference.sha256, mediaType: "application/json", schemaId: IMPLEMENTATION_PLAN_SCHEMA_ID }],
      evidence: [evidenceReference],
      findings: [],
      failures: normalizedSubmission.disposition === "pass" ? [] : [{ id: "PLAN_CONTEXT_BLOCKED", category: "policy", blocking: true, summary: `Plan blocked: ${normalizedSubmission.questions.join(" | ")}` }],
      requestedTransition: normalizedSubmission.disposition === "pass" ? { toState: "implementing", reason: "phase_pass" } : { toState: "failed", reason: "phase_failed" },
      completedAt: context.completedAt,
    };
    if (this.#validator) {
      this.#validator.validateDocument<JsonObject>(PHASE_RESULT_SCHEMA_ID, resultDocument as unknown as JsonObject);
      const errors = validatePhaseResultTrusted(resultDocument, {
        runId: context.runId,
        handoffId: context.handoffId,
        phase: "plan",
        sessionId: context.targetSessionId,
        inputHead: context.inputHead,
        observedOutputHead: context.inputHead,
        inputArtifact: context.inputArtifact,
      });
      if (errors.length) fail(`Plan result failed trusted validation: ${errors.join("; ")}`);
    }
    const resultBytes = serializeCanonical(resultDocument);
    const resultReference = await writeCreateOnly(this.#ticketRoot, `artifacts/plan/${context.attempt}/result.json`, resultBytes, PHASE_RESULT_SCHEMA_ID);
    return { planReference, resultReference, evidenceReference, result: resultDocument };
  }
}

export async function publishPlanArtifact(submission: PlanSubmission, context: PlanPublicationContext, options: PlanArtifactPublisherOptions = {}): Promise<PlanPublicationResult> {
  return new PlanArtifactPublisher(options).publish(submission, context);
}
