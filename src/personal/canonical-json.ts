import { createHash } from "node:crypto";
import { rejectAmbiguousJson } from "./report-correction.js";

export const MAX_COHORT_JSON = 2 * 1024 * 1024;
export function cohortAssert(value: unknown): asserts value { if (!value) throw new Error("invalid cohort evidence"); }
export function sha256(bytes: string | Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
/** Signed/control JSON never uses floating point. Historical Pi JSON may use
 * canonical JSON.stringify numeric costs; no rounded integer lexemes allowed. */
export function parseBoundedJson(bytes: Buffer, piNumbers = false): unknown {
  cohortAssert(bytes.length <= (piNumbers ? 8 * 1024 * 1024 : MAX_COHORT_JSON));
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  rejectAmbiguousJson(text);
  for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|(-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/gu)) {
    const n = match[1];
    if (n !== undefined) cohortAssert(JSON.stringify(Number(n)) === n && (piNumbers ? Number.isFinite(Number(n)) && (!Number.isInteger(Number(n)) || Number.isSafeInteger(Number(n))) : Number.isSafeInteger(Number(n))));
  }
  return JSON.parse(text);
}
export function canonicalJson(value: unknown): string {
  function encode(v: unknown, depth: number): string {
    cohortAssert(depth <= 100);
    if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number") { cohortAssert(Number.isSafeInteger(v) && !Object.is(v, -0)); return String(v); }
    cohortAssert(v && typeof v === "object" && (Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null));
    if (Array.isArray(v)) {
      cohortAssert(Object.keys(v).length === v.length && Array.from({ length: v.length }, (_, i) => Object.hasOwn(v, i)).every(Boolean));
      return `[${v.map(x => encode(x, depth + 1)).join(",")}]`;
    }
    cohortAssert(Reflect.ownKeys(v).length === Object.keys(v).length);
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${encode((v as Record<string, unknown>)[k], depth + 1)}`).join(",")}}`;
  }
  const text = encode(value, 0); cohortAssert(Buffer.byteLength(text) <= MAX_COHORT_JSON); return text;
}
export function parseCanonicalJson(bytes: Buffer): unknown {
  const value = parseBoundedJson(bytes); cohortAssert(Buffer.from(canonicalJson(value)).equals(bytes)); return value;
}
export function closed(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
  cohortAssert(value && typeof value === "object" && !Array.isArray(value));
  const keys = Object.keys(value); cohortAssert(required.every(k => keys.includes(k)) && keys.every(k => required.includes(k) || optional.includes(k)));
}
export function identity(v: unknown): asserts v is string { cohortAssert(typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u.test(v)); }
export function digest(v: unknown): asserts v is string { cohortAssert(typeof v === "string" && /^[a-f0-9]{64}$/u.test(v)); }
export function head(v: unknown): asserts v is string { cohortAssert(typeof v === "string" && /^[a-f0-9]{40}$/u.test(v)); }
export function time(v: unknown): asserts v is string { cohortAssert(typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v); }
export function list(v: unknown, max: number, min = 0): asserts v is unknown[] { cohortAssert(Array.isArray(v) && v.length >= min && v.length <= max); }
export function unique(v: readonly unknown[]): void { cohortAssert(new Set(v).size === v.length); }
export function safeCount(v: unknown): asserts v is number { cohortAssert(Number.isSafeInteger(v) && (v as number) >= 0); }

export function checkName(v: unknown): asserts v is string { cohortAssert(typeof v === "string" && v.length > 0 && v.length <= 128 && v.trim() === v && !/[\x00-\x1f\x7f-\x9f]/u.test(v)); }
