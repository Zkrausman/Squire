import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import type { ContractReference } from "../control/domain.js";
import { V1ArtifactValidator, type JsonObject } from "../contracts/v1-artifact-validator.js";
import { SafeArtifactReader } from "../control/safe-artifact-reader.js";
import { PHASE_INPUT_SCHEMA_ID, PHASE_TRIGGER_SCHEMA_ID, type PhaseTriggerDocument } from "./domain.js";

export class PlanTriggerValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlanTriggerValidationError";
  }
}

function fail(message: string): never { throw new PlanTriggerValidationError(message); }

async function readTriggerBytes(ticketRoot: string, relativePath: string): Promise<Buffer> {
  if (!path.isAbsolute(ticketRoot) || !/^artifacts\/handoffs\/plan\/[1-9][0-9]*\/trigger\.json$/u.test(relativePath) || path.posix.normalize(relativePath) !== relativePath || relativePath.includes("\u0000")) fail("Plan trigger path is not canonical");
  const target = path.resolve(ticketRoot, ...relativePath.split("/"));
  const root = path.resolve(ticketRoot);
  if (!target.startsWith(`${root}${path.sep}`)) fail("Plan trigger escaped ticket root");
  let handle;
  try { handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { throw new PlanTriggerValidationError("Plan trigger is missing or cannot be opened", { cause: error }); }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 1024 * 1024) fail("Plan trigger is not a bounded regular file");
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead <= 0) fail("Plan trigger ended during read");
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("Plan trigger changed during read");
    return bytes;
  } finally { await handle.close(); }
}

export class PlanTriggerValidator {
  readonly #validator: V1ArtifactValidator;
  readonly #ticketRoot: string;
  constructor(validator: V1ArtifactValidator, ticketRoot = "/ticket") {
    if (!path.isAbsolute(ticketRoot) || ticketRoot.includes("\u0000")) fail("Plan ticket root is unsafe");
    this.#validator = validator;
    this.#ticketRoot = path.resolve(ticketRoot);
  }

  async validate(triggerPath: string, context: { readonly runId: string; readonly handoffId: string; readonly attempt: number; readonly targetSessionId: string; readonly inputHead: string; readonly inputArtifact: ContractReference }): Promise<{ readonly reference: ContractReference; readonly trigger: PhaseTriggerDocument }> {
    const expectedAbsolute = `/ticket/artifacts/handoffs/plan/${context.attempt}/trigger.json`;
    if (triggerPath !== expectedAbsolute) fail("Plan trigger path does not match the trusted attempt");
    const relativePath = `artifacts/handoffs/plan/${context.attempt}/trigger.json`;
    const bytes = await readTriggerBytes(this.#ticketRoot, relativePath);
    const reference: ContractReference = { path: relativePath, sha256: createHash("sha256").update(bytes).digest("hex"), schemaId: PHASE_TRIGGER_SCHEMA_ID };
    // V1ArtifactValidator re-opens the exact digest-bound bytes through the
    // existing SafeArtifactReader boundary; it is not a second artifact reader.
    const validated = await this.#validator.validate<JsonObject>(reference, {
      schemaId: PHASE_TRIGGER_SCHEMA_ID,
      semantic: raw => {
        const trigger = raw as unknown as PhaseTriggerDocument;
        const errors: string[] = [];
        if (trigger.runId !== context.runId) errors.push("Plan trigger run identity mismatch");
        if (trigger.handoffId !== context.handoffId) errors.push("Plan trigger handoff identity mismatch");
        if (trigger.phase !== "plan") errors.push("Plan trigger phase mismatch");
        if (trigger.attempt !== context.attempt) errors.push("Plan trigger attempt mismatch");
        if (trigger.targetSessionId !== context.targetSessionId) errors.push("Plan trigger session mismatch");
        if (trigger.inputHead !== context.inputHead) errors.push("Plan trigger head mismatch");
        if (trigger.inputArtifact.schemaId !== PHASE_INPUT_SCHEMA_ID || trigger.inputArtifact.path !== context.inputArtifact.path || trigger.inputArtifact.sha256 !== context.inputArtifact.sha256 || trigger.inputArtifact.schemaId !== context.inputArtifact.schemaId) errors.push("Plan trigger input artifact substitution");
        return errors;
      },
    });
    return { reference, trigger: validated.document as unknown as PhaseTriggerDocument };
  }
}

export async function validatePlanTrigger(triggerPath: string, context: { readonly runId: string; readonly handoffId: string; readonly attempt: number; readonly targetSessionId: string; readonly inputHead: string; readonly inputArtifact: ContractReference }, validator: V1ArtifactValidator, ticketRoot = "/ticket"): Promise<{ readonly reference: ContractReference; readonly trigger: PhaseTriggerDocument }> {
  return new PlanTriggerValidator(validator, ticketRoot).validate(triggerPath, context);
}
