import { createHash } from "node:crypto";
import type { RunSnapshot } from "../control/domain.js";
import { assertRunSnapshotShape } from "../control/run-snapshot-invariants.js";

export const MAX_JSON_BYTES = 8 * 1024 * 1024;

export class RowCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "RowCorruptionError"; }
}

/** Deterministic JSON used for database projections and digest comparisons. */
export function canonicalRowJson(value: unknown): string {
  return canonicalValue(value);
}
export function encodeJson(value: unknown, maxBytes = MAX_JSON_BYTES): string {
  rejectPrototypeKeys(value, "JSON");
  const encoded = canonicalRowJson(value);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new RowCorruptionError("JSON value exceeds the bounded database limit");
  return encoded;
}
export function decodeJson<T>(value: unknown, label: string, maxBytes = MAX_JSON_BYTES): T {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) throw new RowCorruptionError(`${label} is not bounded JSON`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (error) { throw new RowCorruptionError(`${label} is not valid JSON`, { cause: error }); }
  rejectPrototypeKeys(parsed, label);
  try { canonicalRowJson(parsed); } catch (error) { throw new RowCorruptionError(`${label} is not canonicalizable JSON`, { cause: error }); }
  return parsed as T;
}
export function encodeSnapshot(snapshot: RunSnapshot): string {
  assertRunSnapshotShape(snapshot);
  return encodeJson(snapshot);
}
export function decodeSnapshot(value: unknown): RunSnapshot {
  const snapshot = decodeJson<RunSnapshot>(value, "workflow snapshot");
  const allowed = new Set(["runId", "version", "state", "currentHead", "implementGeneration", "implementCompletedAt", "sessions", "processAllocations", "attempts", "acceptedResultPaths", "committedRequestIds", "gates", "remediation", "processLaunches", "terminalError", "runtimeResolution", "terminalFence", "preparationLeases", "gitWorkspace", "identity", "timestamps", "resources", "delivery", "lastError", "operatorBlocked", "reconciliation"]);
  if (Object.keys(snapshot as object).some(key => !allowed.has(key))) throw new RowCorruptionError("workflow snapshot contains an unknown field");
  try { assertRunSnapshotShape(snapshot); } catch (error) { throw new RowCorruptionError("workflow snapshot failed closed validation", { cause: error }); }
  return snapshot;
}
export function sha256Text(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

function rejectPrototypeKeys(value: unknown, label: string, depth = 0): void {
  if (depth > 64) throw new RowCorruptionError(`${label} exceeds JSON nesting bound`);
  if (Array.isArray(value)) { if (value.length > 100_000) throw new RowCorruptionError(`${label} array exceeds bound`); for (const item of value) rejectPrototypeKeys(item, label, depth + 1); return; }
  if (!value || typeof value !== "object") return;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new RowCorruptionError(`${label} contains a non-plain object`);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") throw new RowCorruptionError(`${label} contains a prototype-bearing key`);
    rejectPrototypeKeys(child, label, depth + 1);
  }
}
function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new RowCorruptionError("canonical JSON contains an unsafe number");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") throw new RowCorruptionError("canonical JSON cannot contain bigint");
  if (Array.isArray(value)) return `[${value.map(item => canonicalValue(item)).join(",")}]`;
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new RowCorruptionError("canonical JSON contains a non-plain object");
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalValue(object[key])}`).join(",")}}`;
  }
  throw new RowCorruptionError("canonical JSON contains an unsupported value");
}
