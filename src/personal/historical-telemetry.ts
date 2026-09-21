import { parseBoundedJson } from "./canonical-json.js";
import { check, digestBytes, type HistoricalSource } from "./cohort-manifest.js";
import { decimalText, decimalUnits, recordedCostUnits, TOKEN_FIELDS, type TokenField } from "./telemetry-stream.js";

export interface KnownNumber { known: number; complete: boolean; }
export interface HistoricalTotals {
  sessions: number; usageRecords: number; usageRecordsComplete: boolean; assistantRecords: number;
  tokens: Record<TokenField, KnownNumber>;
  recordedCost: { known: string; complete: boolean; source: "pi-recorded" };
  activeMs: KnownNumber;
}
export type HistoricalDiagnostic = "unavailable_source" | "invalid_source" | "unsupported_record" | "missing_usage" | "missing_dimension" | "missing_endpoint";
export interface HistoricalSession {
  authority: "provisional-pi-session-v1"; sourceDigest: string; provenance: string;
  phase: HistoricalSource["phase"]; subphase: HistoricalSource["subphase"]; profile: HistoricalSource["profile"];
  attempt: number; correction: number; outcome: HistoricalSource["outcome"];
  totals: HistoricalTotals; inventory: { records: number; supported: boolean }; diagnostics: HistoricalDiagnostic[];
  waste: HistoricalSource["waste"];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function emptyHistoricalTotals(): HistoricalTotals { return { sessions: 0, usageRecords: 0, usageRecordsComplete: false, assistantRecords: 0, tokens: { input: { known: 0, complete: false }, output: { known: 0, complete: false }, cacheRead: { known: 0, complete: false }, cacheWrite: { known: 0, complete: false } }, recordedCost: { known: "0", complete: false, source: "pi-recorded" }, activeMs: { known: 0, complete: false } }; }
export function extractHistoricalSession(bytes: Buffer | undefined, source: HistoricalSource): HistoricalSession {
  const result: HistoricalSession = { authority: "provisional-pi-session-v1", sourceDigest: source.artifact.digest, provenance: source.provenance,
    phase: source.phase, subphase: source.subphase, profile: source.profile, attempt: source.attempt, correction: source.correction, outcome: source.outcome,
    totals: emptyHistoricalTotals(), inventory: { records: 0, supported: false }, diagnostics: [], waste: source.waste };
  result.totals.sessions = 1;
  if (!bytes) { result.diagnostics = ["unavailable_source"]; return result; }
  try {
    check(bytes.length <= 64 * 1024 * 1024 && bytes.length === source.artifact.bytes && digestBytes(bytes) === source.artifact.digest);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    check(text.endsWith("\n")); const lines = text.split("\n").filter(l => l.trim()); check(lines.length > 0 && lines.length <= 200_000);
    const header = parseBoundedJson(lines.shift()!, { canonicalNumbers: true });
    check(object(header) && header["type"] === "session" && header["version"] === 3 && header["id"] === source.sessionId);
    const totals = emptyHistoricalTotals(); totals.sessions = 1;
    for (const f of TOKEN_FIELDS) totals.tokens[f].complete = true;
    totals.recordedCost.complete = true;
    const ids = new Set<string>(), responses = new Set<string>(), diagnostics = new Set<HistoricalDiagnostic>();
    let cost = 0n, supported = true;
    for (const line of lines) {
      const record = parseBoundedJson(line, { canonicalNumbers: true }); check(object(record));
      check(typeof record["id"] === "string" && record["id"].length > 0 && record["id"].length <= 128 && !ids.has(record["id"])); ids.add(record["id"]);
      if (record["type"] !== "message") {
        if (!["model_change", "thinking_level_change", "custom", "custom_message", "label", "compaction", "branch_summary", "session_info"].includes(String(record["type"]))) { supported = false; diagnostics.add("unsupported_record"); }
        continue;
      }
      const message = record["message"]; check(object(message));
      if (message["role"] !== "assistant") { check(["user", "toolResult"].includes(String(message["role"]))); continue; }
      const apis: Record<string, string[]> = { openai: ["openai-responses", "openai-completions"], "openai-codex": ["openai-codex-responses"], anthropic: ["anthropic-messages"] };
      check(Object.hasOwn(apis, source.profile.provider) && apis[source.profile.provider]!.includes(String(message["api"])) && message["provider"] === source.profile.provider && message["model"] === source.profile.model);
      if (message["responseId"] !== undefined) { const id = message["responseId"]; check(typeof id === "string" && id.length > 0 && id.length <= 256 && !responses.has(id)); responses.add(id); }
      totals.assistantRecords++;
      const usage = message["usage"];
      if (!object(usage)) { diagnostics.add("missing_usage"); for (const f of TOKEN_FIELDS) totals.tokens[f].complete = false; totals.recordedCost.complete = false; continue; }
      totals.usageRecords++;
      for (const f of TOKEN_FIELDS) {
        const n = usage[f];
        if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > 1_000_000_000_000) { totals.tokens[f].complete = false; diagnostics.add("missing_dimension"); }
        else { totals.tokens[f].known += n; check(Number.isSafeInteger(totals.tokens[f].known)); }
      }
      try { check(object(usage["cost"])); cost += recordedCostUnits(usage["cost"]["total"]); }
      catch { totals.recordedCost.complete = false; diagnostics.add("missing_dimension"); }
    }
    totals.usageRecordsComplete = supported && totals.assistantRecords > 0 && totals.usageRecords === totals.assistantRecords;
    totals.recordedCost.known = decimalText(cost);
    if (!totals.assistantRecords || !supported) { for (const f of TOKEN_FIELDS) totals.tokens[f].complete = false; totals.recordedCost.complete = false; }
    if (source.startedAt && source.endedAt) totals.activeMs = { known: Date.parse(source.endedAt) - Date.parse(source.startedAt), complete: true };
    else diagnostics.add("missing_endpoint");
    return { ...result, totals, inventory: { records: lines.length, supported }, diagnostics: [...diagnostics].sort() };
  } catch { result.diagnostics = ["invalid_source"]; return result; }
}
export function historicalTotals(rows: readonly HistoricalTotals[], inventoryComplete = true): HistoricalTotals {
  const totals = emptyHistoricalTotals(), complete = rows.length > 0 && inventoryComplete;
  const sum = (fn: (r: HistoricalTotals) => number) => { const n = rows.reduce((n, r) => n + fn(r), 0); check(Number.isSafeInteger(n)); return n; };
  totals.usageRecordsComplete = complete && rows.every(r => r.usageRecordsComplete);
  totals.sessions = sum(r => r.sessions); totals.usageRecords = sum(r => r.usageRecords); totals.assistantRecords = sum(r => r.assistantRecords);
  for (const f of TOKEN_FIELDS) totals.tokens[f] = { known: sum(r => r.tokens[f].known), complete: complete && rows.every(r => r.tokens[f].complete) };
  totals.recordedCost = { known: decimalText(rows.reduce((n, r) => n + decimalUnits(r.recordedCost.known), 0n)), complete: complete && rows.every(r => r.recordedCost.complete), source: "pi-recorded" };
  totals.activeMs = { known: sum(r => r.activeMs.known), complete: complete && rows.every(r => r.activeMs.complete) }; return totals;
}
