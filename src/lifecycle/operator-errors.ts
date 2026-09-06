import { createHash } from "node:crypto";
import type { ArtifactReference, OperatorErrorRecord } from "../control/domain.js";
import { IntakeError } from "../intake/domain.js";

export interface OperatorErrorInput { readonly code: string; readonly message: string; readonly component: string; readonly retryable: boolean; readonly operatorActionRequired: boolean; readonly evidence?: readonly ArtifactReference[]; readonly runId?: string; readonly now?: string; }
export function sanitizeOperatorMessage(message: unknown, max = 4_096): string { const text = typeof message === "string" ? message : "unspecified operator error"; return text.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/((?:authorization|cookie|x-api-key|api-key|token|password|secret))\s*[:=]\s*[^\s,;]+/giu, "$1=<redacted>").replace(/\s+/gu, " ").trim().slice(0, max) || "unspecified operator error"; }
export function fingerprintOperatorError(input: Pick<OperatorErrorInput, "code" | "component" | "message">): string { return createHash("sha256").update(`${input.code}\0${input.component}\0${sanitizeOperatorMessage(input.message)}`, "utf8").digest("hex"); }
export function validateOperatorErrorInput(input: OperatorErrorInput): void {
  if (!/^[a-z][a-z0-9_.-]{1,63}$/u.test(input.code) || !/^[a-z][a-z0-9_.-]{1,63}$/u.test(input.component)) throw new IntakeError("operator error identity is invalid");
  if (sanitizeOperatorMessage(input.message).length > 4_096) throw new IntakeError("operator error message is too long");
  if (input.evidence && input.evidence.length > 32) throw new IntakeError("operator error evidence is too large");
}
export interface OperatorErrorQuery { readonly errorId: string; readonly runId?: string; readonly code: string; readonly message: string; readonly component: string; readonly retryable: boolean; readonly operatorActionRequired: boolean; readonly occurrenceCount: number; readonly resolvedAt?: string; }
export function queryModel(record: OperatorErrorRecord): OperatorErrorQuery { return { errorId: record.errorId, ...(record.runId ? { runId: record.runId } : {}), code: record.code, message: record.message, component: record.component, retryable: record.retryable, operatorActionRequired: record.operatorActionRequired, occurrenceCount: record.occurrenceCount, ...(record.resolvedAt ? { resolvedAt: record.resolvedAt } : {}) }; }
