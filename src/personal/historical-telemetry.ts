import { parseBoundedJson } from "./bounded-json.js";
import { sha256, ARTIFACT_MAX_BYTES } from "./private-artifact-store.js";
import { decimalText, decimalUnits, recordedCostUnits, TOKEN_FIELDS } from "./telemetry-stream.js";
import { validateCohortDocument, type HistoricalSource } from "./cohort-schema.js";
export interface Measure<T> { known: T; expected: number; observed: number; supported: number; unknown: number; excluded: number; complete: boolean; }
export interface Accounting { input: Measure<number>; output: Measure<number>; cacheRead: Measure<number>; cacheWrite: Measure<number>; recordedCost: Measure<string>; messages: Measure<number>; durationMs: Measure<number>; }
export const ACCOUNTING_FIELDS = [...TOKEN_FIELDS, "recordedCost", "messages", "durationMs"] as const;
export const measure = <T>(known: T, expected: number, observed: number, supported: number, excluded = 0): Measure<T> => ({ known, expected, observed, supported, unknown: expected - supported, excluded, complete: expected > 0 && supported === expected && excluded === 0 });
export function unknownAccounting(): Accounting {
  return { input: measure(0, 1, 0, 0), output: measure(0, 1, 0, 0), cacheRead: measure(0, 1, 0, 0), cacheWrite: measure(0, 1, 0, 0), recordedCost: measure("0", 1, 0, 0), messages: measure(0, 1, 0, 0), durationMs: measure(0, 1, 0, 0) };
}
export function sumAccounting(rows: readonly Accounting[]): Accounting {
  const result = unknownAccounting();
  for (const field of ACCOUNTING_FIELDS) {
    const values = rows.map(r => r[field]);
    const known = field === "recordedCost" ? decimalText(values.reduce((s, v) => s + decimalUnits(v.known as string), 0n)) : values.reduce((s, v) => s + (v.known as number), 0);
    if (typeof known === "number" && !Number.isSafeInteger(known)) throw new Error("cohort arithmetic bound exceeded");
    const total = measure(known, values.reduce((s, v) => s + v.expected, 0), values.reduce((s, v) => s + v.observed, 0), values.reduce((s, v) => s + v.supported, 0), values.reduce((s, v) => s + v.excluded, 0));
    Object.assign(result, { [field]: total });
  }
  return result;
}
type Obj = Record<string, unknown>;
function object(v: unknown): v is Obj { return !!v && typeof v === "object" && !Array.isArray(v); }
function keys(v: Obj, names: string[]) { return Object.keys(v).every(k => names.includes(k)); }
const supportedApis: Record<string, string[]> = { "openai-codex": ["openai-codex-responses"], openai: ["openai-responses", "openai-completions"], anthropic: ["anthropic-messages"] };
export interface HistoricalAccounting { authority: "provisional-pi-0.84.4-session-v3"; accounting: Accounting; diagnostic: "unsupported_or_partial" | "invalid_source" | null; recordIdentities: string[]; excludedRecords: number; }
/** Reads only structured assistant usage. Content, summaries, cwd and tool text
 * are opaque and are never copied to output or used to infer classifications. */
export function backfillSession(bytes: Buffer, source: HistoricalSource): HistoricalAccounting {
  const unavailable = (): HistoricalAccounting => ({ authority: "provisional-pi-0.84.4-session-v3", accounting: unknownAccounting(), diagnostic: "invalid_source", recordIdentities: [], excludedRecords: 0 });
  try {
    validateCohortDocument("session", source);
    if (bytes.length > ARTIFACT_MAX_BYTES || sha256(bytes) !== source.source.sha256 || source.format !== "pi-0.84.4-session-v3") return unavailable();
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!text.endsWith("\n")) return unavailable();
    const lines = text.split("\n"); if (lines.length > 200_001 || lines.length < 2) return unavailable();
    const header = parseBoundedJson(lines.shift()!, { canonicalNumbers: true });
    if (!object(header) || !keys(header, ["type", "version", "id", "timestamp", "cwd", "parentSession"]) || header["type"] !== "session" || header["version"] !== 3 || header["id"] !== source.sessionId || typeof header["timestamp"] !== "string" || !Number.isFinite(Date.parse(header["timestamp"])) || typeof header["cwd"] !== "string") return unavailable();
    const ids = new Set<string>(), responses = new Set<string>(), rows: Accounting[] = [];
    let unsupported = 0, excludedRecords = 0;
    for (const line of lines) {
      if (!line.length) continue;
      const entry = parseBoundedJson(line, { canonicalNumbers: true });
      if (!object(entry) || typeof entry["type"] !== "string" || typeof entry["id"] !== "string" || entry["id"].length > 128 || !entry["id"].length || ids.has(entry["id"]) || !(entry["parentId"] === null || typeof entry["parentId"] === "string" && ids.has(entry["parentId"])) || typeof entry["timestamp"] !== "string" || !Number.isFinite(Date.parse(entry["timestamp"]))) return unavailable();
      ids.add(entry["id"]);
      if (entry["type"] !== "message") {
        excludedRecords++;
        if (!["thinking_level_change", "model_change", "compaction", "branch_summary", "custom", "label", "session_info", "custom_message"].includes(entry["type"]) || entry["usage"] !== undefined) unsupported++;
        continue;
      }
      if (!keys(entry, ["type", "id", "parentId", "timestamp", "message"]) || !object(entry["message"])) return unavailable();
      const m = entry["message"];
      if (m["role"] !== "assistant") {
        excludedRecords++;
        // Known non-assistant roles are safe to skip only when they carry no
        // usage. Unsupported accounting must not make assistant subtotals look complete.
        if (!["user", "toolResult", "bashExecution", "custom", "branchSummary", "compactionSummary"].includes(String(m["role"])) || m["usage"] !== undefined) unsupported++;
        continue;
      }
      const responseId = m["responseId"];
      if (responseId !== undefined && (typeof responseId !== "string" || !responseId.length || responseId.length > 256)) return unavailable();
      const identity = sha256(JSON.stringify([source.profile.provider, responseId ?? `${source.sessionId}/${entry["id"]}`]));
      if (responses.has(identity)) return unavailable(); responses.add(identity);
      const row = unknownAccounting(), usage = m["usage"];
      const supported = keys(m, ["role", "content", "api", "provider", "model", "responseModel", "responseId", "diagnostics", "usage", "stopReason", "errorMessage", "rawStopReason", "endTurn", "timestamp"]) && Array.isArray(m["content"]) && Number.isSafeInteger(m["timestamp"]) && m["provider"] === source.profile.provider && m["model"] === source.profile.model && supportedApis[source.profile.provider]?.includes(String(m["api"])) && object(usage) && keys(usage, [...TOKEN_FIELDS, "totalTokens", "cost", "reasoning", "cacheWrite1h"]);
      row.messages = measure(object(usage) ? 1 : 0, 1, object(usage) ? 1 : 0, object(usage) ? 1 : 0);
      if (supported && object(usage)) {
        for (const field of TOKEN_FIELDS) {
          const n = usage[field], valid = typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000_000;
          row[field] = measure(valid ? n : 0, 1, n === undefined ? 0 : 1, valid ? 1 : 0);
        }
        const c = usage["cost"];
        if (object(c) && keys(c, [...TOKEN_FIELDS, "total"]) && c["total"] !== undefined) {
          try { row.recordedCost = measure(decimalText(recordedCostUnits(c["total"])), 1, 1, 1); } catch { row.recordedCost = measure("0", 1, 1, 0); }
        }
      }
      rows.push(row);
    }
    if (unsupported || !rows.length) rows.push(unknownAccounting());
    const accounting = sumAccounting(rows);
    // There is no trustworthy active-duration measurement in session timestamps.
    accounting.durationMs = measure(0, 1, 0, 0);
    return { authority: "provisional-pi-0.84.4-session-v3", accounting, diagnostic: ACCOUNTING_FIELDS.filter(f => f !== "durationMs").every(f => accounting[f].complete) ? null : "unsupported_or_partial", recordIdentities: [...responses].sort(), excludedRecords };
  } catch { return unavailable(); }
}
