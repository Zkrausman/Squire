import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { ArtifactReference, ContractReference } from "../control/domain.js";
import { validatePhaseResultTrusted, type JsonObject, type PhaseResultDocument } from "../contracts/v1-artifact-validator.js";
import { V1ArtifactValidator } from "../contracts/v1-artifact-validator.js";
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
import { validateImplementationPlanDocument, validatePlanSubmission } from "./plan-validation.js";

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

function assertSafeRoot(ticketRoot: string): string {
  if (!path.isAbsolute(ticketRoot) || ticketRoot.includes("\u0000")) fail("Plan ticket root is unsafe");
  return path.resolve(ticketRoot);
}

function assertRelativeOutput(relativePath: string): void {
  if (!relativePath || path.posix.normalize(relativePath) !== relativePath || relativePath.startsWith("/") || relativePath.includes("\\") || relativePath.includes("\u0000") || relativePath.split("/").some(part => part === ".." || part.length === 0)) fail("Plan output path is not fixed and relative");
  if (!relativePath.startsWith("artifacts/plan/") && !relativePath.startsWith("evidence/plan/")) fail("Plan output path is outside the Plan output roots");
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) fail(`Plan output directory is not private: ${directory}`);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeCreateOnly(ticketRoot: string, relativePath: string, bytes: Buffer): Promise<ContractReference> {
  assertRelativeOutput(relativePath);
  const root = assertSafeRoot(ticketRoot);
  const target = path.resolve(root, ...relativePath.split("/"));
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) fail("Plan output escaped ticket root");
  await ensurePrivateDirectory(path.dirname(target));
  const sha256 = digest(bytes);
  try {
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.write(bytes, 0, bytes.length, 0);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "EEXIST")) throw error;
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) fail("existing Plan output is not a regular private file");
    const existing = await readFile(target);
    if (!existing.equals(bytes)) fail("immutable Plan output conflict");
  }
  await syncDirectory(path.dirname(target));
  return { path: relativePath, sha256, schemaId: relativePath.endsWith("plan.json") ? IMPLEMENTATION_PLAN_SCHEMA_ID : relativePath.endsWith("result.json") ? PHASE_RESULT_SCHEMA_ID : "urn:squire:contracts:v1:plan-evidence" };
}

function assertContext(context: PlanPublicationContext): void {
  if (!Number.isSafeInteger(context.attempt) || context.attempt < 1) fail("Plan publication attempt is invalid");
  if (context.inputArtifact.schemaId !== PHASE_INPUT_SCHEMA_ID || !/^[0-9a-f]{64}$/u.test(context.inputArtifact.sha256)) fail("Plan publication input artifact is not an exact phase-input reference");
  if (context.phaseInputDigest !== undefined && context.phaseInputDigest !== context.inputArtifact.sha256) fail("Plan publication input digest was substituted");
  if (!Number.isFinite(Date.parse(context.completedAt))) fail("Plan publication completion time is invalid");
  if ([context.runId, context.handoffId, context.targetSessionId, context.inputHead, context.ticketIdentifier].some(value => value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value))) fail("Plan publication identity is malformed");
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
    if (normalizedSubmission.disposition === "blocked" && normalizedSubmission.questions.length === 0) fail("blocked Plan publication requires actionable questions");
    if (normalizedSubmission.disposition === "pass" && normalizedSubmission.questions.length !== 0) fail("pass Plan publication cannot contain questions");
    if (this.#validator) this.#validator.validateDocument<JsonObject>(IMPLEMENTATION_PLAN_SCHEMA_ID, plan as unknown as JsonObject);
    const planBytes = serializeCanonical(plan);
    const planPath = `artifacts/plan/${context.attempt}/plan.json`;
    const planReference = await writeCreateOnly(this.#ticketRoot, planPath, planBytes);
    const evidenceBytes = reportText(context, normalizedSubmission, planReference);
    const evidencePath = `evidence/plan/${context.attempt}/verification.md`;
    const evidenceReferenceRaw = await writeCreateOnly(this.#ticketRoot, evidencePath, evidenceBytes);
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
    const resultReference = await writeCreateOnly(this.#ticketRoot, `artifacts/plan/${context.attempt}/result.json`, resultBytes);
    await syncDirectory(path.join(this.#ticketRoot, "artifacts", "plan", String(context.attempt)));
    return { planReference, resultReference, evidenceReference, result: resultDocument };
  }
}

export async function publishPlanArtifact(submission: PlanSubmission, context: PlanPublicationContext, options: PlanArtifactPublisherOptions = {}): Promise<PlanPublicationResult> {
  return new PlanArtifactPublisher(options).publish(submission, context);
}
