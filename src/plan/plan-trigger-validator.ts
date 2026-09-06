import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { ContractReference } from "../control/domain.js";
import { V1ArtifactValidator, type JsonObject } from "../contracts/v1-artifact-validator.js";
import { PHASE_INPUT_SCHEMA_ID, PHASE_TRIGGER_SCHEMA_ID, type PhaseTriggerDocument } from "./domain.js";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const MAX_TRIGGER_BYTES = 1 * 1024 * 1024;

export class PlanTriggerValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PlanTriggerValidationError";
  }
}

function fail(message: string): never { throw new PlanTriggerValidationError(message); }
function isCode(error: unknown, code: string): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code; }

async function assertDirectoryChain(root: string, targetDirectory: string): Promise<void> {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail("Plan trigger root is not a real directory");
  const relative = path.relative(root, targetDirectory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail("Plan trigger escaped ticket root");
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    if (!part || part === "." || part === ".." || CONTROL_CHARACTER.test(part)) fail("Plan trigger parent path is unsafe");
    current = path.join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) fail("Plan trigger parent is not a private real directory");
  }
  const canonicalRoot = await realpath(root);
  const canonicalDirectory = await realpath(targetDirectory);
  if (canonicalDirectory !== canonicalRoot && !canonicalDirectory.startsWith(`${canonicalRoot}${path.sep}`)) fail("Plan trigger parent escaped ticket root");
}

function sameStat(left: Awaited<ReturnType<import("node:fs/promises").FileHandle["stat"]>>, right: Awaited<ReturnType<import("node:fs/promises").FileHandle["stat"]>>): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readTriggerBytes(ticketRoot: string, relativePath: string): Promise<Buffer> {
  if (!path.isAbsolute(ticketRoot) || !/^artifacts\/handoffs\/plan\/[1-9][0-9]*\/trigger\.json$/u.test(relativePath) || path.posix.normalize(relativePath) !== relativePath || relativePath.includes("\\") || CONTROL_CHARACTER.test(relativePath)) fail("Plan trigger path is not canonical");
  const root = path.resolve(ticketRoot);
  const target = path.resolve(root, ...relativePath.split("/"));
  if (target === root || !target.startsWith(`${root}${path.sep}`)) fail("Plan trigger escaped ticket root");
  await assertDirectoryChain(root, path.dirname(target));
  if (constants.O_NOFOLLOW === undefined) fail("secure Plan trigger reads are unsupported on this platform");
  let handle;
  try { handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { throw new PlanTriggerValidationError("Plan trigger is missing or cannot be opened safely", { cause: error }); }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600 || before.size > MAX_TRIGGER_BYTES) fail("Plan trigger is not a bounded regular private file");
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead <= 0) fail("Plan trigger ended during read");
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (!sameStat(before, after)) fail("Plan trigger changed during read");
    const canonicalRoot = await realpath(root);
    const canonicalTarget = await realpath(target);
    if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`)) fail("Plan trigger escaped ticket root");
    const targetAfter = await lstat(target);
    if (!sameStat(after, targetAfter)) fail("Plan trigger identity changed during read");
    await assertDirectoryChain(root, path.dirname(target));
    return bytes;
  } finally { await handle.close(); }
}

export class PlanTriggerValidator {
  readonly #validator: V1ArtifactValidator;
  readonly #ticketRoot: string;
  constructor(validator: V1ArtifactValidator, ticketRoot = "/ticket") {
    if (!path.isAbsolute(ticketRoot) || ticketRoot.includes("\u0000") || CONTROL_CHARACTER.test(ticketRoot)) fail("Plan ticket root is unsafe");
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
