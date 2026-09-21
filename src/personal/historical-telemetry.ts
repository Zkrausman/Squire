import { closed, cohortAssert as assert, parseBoundedJson, safeCount, sha256 } from "./canonical-json.js";
import type { HistoricalSource } from "./cohort-domain.js";
import { readPrivateBytes } from "./private-artifacts.js";
import { decimalText, decimalUnits, TOKEN_FIELDS } from "./telemetry-stream.js";
import type { TelemetryTotals } from "./telemetry-store.js";

export const HISTORICAL_RULE = "pi-session-v3-assistant-usage-v1";
export interface HistoricalTelemetry {
  schemaVersion: 1; authority: "provisional-historical-pi-session"; extractionRule: typeof HISTORICAL_RULE;
  sourceDigest: string; sessionId: string; totals: TelemetryTotals;
  diagnostic: "none" | "incomplete_usage" | "invalid_or_unavailable_source";
}
export function unknownTotals(): TelemetryTotals {
  return { sessions: 0, messages: 0, tokens: { input: { known: 0, complete: false }, output: { known: 0, complete: false }, cacheRead: { known: 0, complete: false }, cacheWrite: { known: 0, complete: false } }, recordedCost: { known: "0", complete: false, source: "pi-recorded" }, durationMs: { known: 0, complete: false } };
}
function recordedCost(v: unknown): string {
  assert(typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1_000_000);
  let text = String(v);
  if (text.includes("e")) {
    const [m, e] = text.split("e"); const [w, f = ""] = m!.split("."); const digits = w! + f; const point = w!.length + Number(e);
    text = point <= 0 ? `0.${"0".repeat(-point)}${digits}` : point >= digits.length ? digits.padEnd(point, "0") : `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  return decimalText(decimalUnits(text));
}
/** Only Pi v3 session headers and structured message.usage are inspected.
 * Content, tools, prompts, and text are opaque and never exported. */
export function extractHistoricalTelemetry(bytes: Buffer, source: HistoricalSource): HistoricalTelemetry {
  const result: HistoricalTelemetry = { schemaVersion: 1, authority: "provisional-historical-pi-session", extractionRule: HISTORICAL_RULE, sourceDigest: source.digest, sessionId: source.sessionId, totals: unknownTotals(), diagnostic: "invalid_or_unavailable_source" };
  try {
    assert(bytes.length <= 64 * 1024 * 1024 && sha256(bytes) === source.digest);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); assert(text.endsWith("\n"));
    const lines = text.split("\n"); assert(lines.length <= 200_001); lines.pop(); assert(lines.length > 0 && lines.every(l => l.length > 0));
    const header = parseBoundedJson(Buffer.from(lines.shift()!), true) as Record<string, unknown>;
    closed(header, ["type", "version", "id", "timestamp", "cwd"], ["parentSession"]);
    assert(header["type"] === "session" && header["version"] === 3 && header["id"] === source.sessionId);
    const totals = unknownTotals(); totals.sessions = 1; for (const f of TOKEN_FIELDS) totals.tokens[f].complete = true; totals.recordedCost.complete = true;
    const seen = new Set<string>();
    for (const line of lines) {
      const e = parseBoundedJson(Buffer.from(line), true) as Record<string, unknown>;
      assert(e && typeof e === "object" && !Array.isArray(e) && typeof e["type"] === "string");
      if (e["type"] !== "message") continue;
      assert(typeof e["id"] === "string" && e["id"].length <= 128 && !seen.has(e["id"])); seen.add(e["id"]);
      const m = e["message"] as Record<string, unknown>; assert(m && typeof m === "object" && !Array.isArray(m));
      if (m["role"] !== "assistant") continue;
      const u = m["usage"] as Record<string, unknown> | undefined;
      if (!u || typeof u !== "object" || Array.isArray(u)) { for (const f of TOKEN_FIELDS) totals.tokens[f].complete = false; totals.recordedCost.complete = false; continue; }
      totals.messages++;
      for (const f of TOKEN_FIELDS) {
        const n = u[f];
        if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > 1_000_000_000_000) totals.tokens[f].complete = false;
        else { totals.tokens[f].known += n; safeCount(totals.tokens[f].known); }
      }
      try {
        const c = u["cost"] as Record<string, unknown>; assert(c && typeof c === "object" && !Array.isArray(c));
        totals.recordedCost.known = decimalText(decimalUnits(totals.recordedCost.known) + decimalUnits(recordedCost(c["total"])));
      } catch { totals.recordedCost.complete = false; }
    }
    if (!totals.messages) { for (const f of TOKEN_FIELDS) totals.tokens[f].complete = false; totals.recordedCost.complete = false; }
    result.totals = totals; result.diagnostic = TOKEN_FIELDS.every(f => totals.tokens[f].complete) && totals.recordedCost.complete ? "none" : "incomplete_usage";
  } catch { /* No raw parser, filesystem, or transcript diagnostics escape. */ }
  return result;
}
export async function readHistoricalTelemetry(source: HistoricalSource, maximum = 64 * 1024 * 1024): Promise<{ artifact: HistoricalTelemetry; bytesRead: number }> {
  try { const bytes = await readPrivateBytes(source.path, Math.min(maximum, 64 * 1024 * 1024)); return { artifact: extractHistoricalTelemetry(bytes, source), bytesRead: bytes.length }; }
  catch { return { artifact: extractHistoricalTelemetry(Buffer.alloc(0), source), bytesRead: 0 }; }
}
export function sumCohortTotals(rows: readonly TelemetryTotals[]): TelemetryTotals {
  if (!rows.length) return unknownTotals();
  const out = unknownTotals();
  out.sessions = rows.reduce((n, r) => n + r.sessions, 0); out.messages = rows.reduce((n, r) => n + r.messages, 0); safeCount(out.messages);
  for (const f of TOKEN_FIELDS) { out.tokens[f] = { known: rows.reduce((n, r) => n + r.tokens[f].known, 0), complete: rows.every(r => r.tokens[f].complete) }; safeCount(out.tokens[f].known); }
  out.recordedCost = { known: decimalText(rows.reduce((n, r) => n + decimalUnits(r.recordedCost.known), 0n)), complete: rows.every(r => r.recordedCost.complete), source: "pi-recorded" };
  out.durationMs = { known: rows.reduce((n, r) => n + r.durationMs.known, 0), complete: rows.every(r => r.durationMs.complete) }; safeCount(out.durationMs.known);
  return out;
}
