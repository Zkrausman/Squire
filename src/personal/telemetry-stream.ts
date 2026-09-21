import { rejectAmbiguousJson } from "./report-correction.js";
import { createHash } from "node:crypto";
import type { PhaseProfile } from "./model-policy.js";

/** Pinned Pi 0.84.4 JSON mode. Never accepts session JSONL or terminal text. */
export const MAX_STREAM_BYTES = 64 * 1024 * 1024;
export const TOKEN_FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export type TokenField = typeof TOKEN_FIELDS[number];
export type Diagnostic = "missing_stream" | "invalid_stream" | "partial_stream" | "duplicate_message" | "identity_mismatch" | "unsupported_provider" | "invalid_usage" | "missing_cost" | "capture_failure" | "missing_endpoint";
export interface UsageAccounting {
  tokens: Record<TokenField, number | null>;
  /** Pi's recorded USD cost, NOT a provider invoice or a new price estimate. */
  recordedCost: string | null;
  costSource: "pi-recorded" | "unknown";
  messages: number;
  diagnostics: Diagnostic[];
}
export const emptyUsage = (diagnostic: Diagnostic): UsageAccounting => ({ tokens: { input: null, output: null, cacheRead: null, cacheWrite: null }, recordedCost: null, costSource: "unknown", messages: 0, diagnostics: [diagnostic] });
const SCALE = 10n ** 24n;
export function decimalUnits(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,14})(\.[0-9]{1,24})?$/u.test(value)) throw new Error("invalid decimal");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole!) * SCALE + BigInt(fraction.padEnd(24, "0"));
}
export function decimalText(value: bigint): string {
  const fraction = (value % SCALE).toString().padStart(24, "0").replace(/0+$/u, "");
  return `${value / SCALE}${fraction ? `.${fraction}` : ""}`;
}
function cost(value: unknown): bigint {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) throw new Error();
  // Expand scientific notation without rounding or consulting a price table.
  let text = String(value);
  if (text.includes("e")) {
    const [mantissa, exponent] = text.split("e");
    const [whole, fraction = ""] = mantissa!.split(".");
    const digits = whole! + fraction;
    const point = whole!.length + Number(exponent);
    text = point <= 0 ? `0.${"0".repeat(-point)}${digits}` : point >= digits.length ? digits.padEnd(point, "0") : `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  return decimalUnits(text);
}
type Obj = Record<string, any>; // All child data is checked before accounting; content stays opaque.
function object(v: unknown): v is Obj { return !!v && typeof v === "object" && !Array.isArray(v); }
function keys(v: Obj, allowed: readonly string[]) { return Object.keys(v).every(k => allowed.includes(k)); }
function integer(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0; }
/** Pi emits JSON.stringify numbers. Reject lexemes that JSON.parse would
 * silently round (including fractional token values rounded to integers). */
function canonicalNumbers(line: string): void {
  for (const match of line.matchAll(/"(?:\\[\s\S]|[^"\\])*"|(-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/gu)) {
    const numeric = match[1];
    if (numeric !== undefined && JSON.stringify(Number(numeric)) !== numeric) throw new Error("noncanonical Pi number");
  }
}
function digest(v: unknown) { return createHash("sha256").update(JSON.stringify(v)).digest("hex"); }
const APIS: Record<string, readonly string[]> = { "openai-codex": ["openai-codex-responses"], openai: ["openai-responses", "openai-completions"], anthropic: ["anthropic-messages"] };

/** Independent report extraction: bad accounting must not invalidate a valid handoff. */
export function terminalReport(bytes: Buffer): string {
  if (bytes.length > MAX_STREAM_BYTES) throw new Error("structured report exceeds bound");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let final: Obj | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (object(event) && event["type"] === "message_end" && object(event["message"]) && event["message"]["role"] === "assistant") final = event["message"];
  }
  if (!final || !["stop", "length"].includes(final["stopReason"]) || !Array.isArray(final["content"])) throw new Error("missing terminal structured assistant report");
  return final["content"].filter((c: unknown) => object(c) && c["type"] === "text" && typeof c["text"] === "string").map((c: Obj) => c["text"]).join("\n");
}

export function parseUsageStream(bytes: Buffer | undefined, sessionId: string, profile: PhaseProfile, exited: boolean): UsageAccounting {
  if (!bytes) return emptyUsage("missing_stream");
  if (bytes.length > MAX_STREAM_BYTES) return emptyUsage("invalid_stream");
  if (!Object.hasOwn(APIS, profile.provider)) return emptyUsage("unsupported_provider");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(sessionId)) return emptyUsage("identity_mismatch");
  let events: Obj[];
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.endsWith("\n")) return emptyUsage("partial_stream");
    const lines = text.split("\n").filter(l => l.trim());
    if (lines.length > 200_000 || lines.some(l => Buffer.byteLength(l) > 8 * 1024 * 1024)) return emptyUsage("invalid_stream");
    events = lines.map(l => { const event = JSON.parse(l) as Obj; rejectAmbiguousJson(l); canonicalNumbers(l); return event; });
    if (events.some(e => !object(e) || typeof e["type"] !== "string")) throw new Error();
  } catch { return emptyUsage("invalid_stream"); }
  const header = events.shift();
  if (!header || header["type"] !== "session" || header["version"] !== 3 || header["id"] !== sessionId || !keys(header, ["type", "version", "id", "timestamp", "cwd", "parentSession"])) return emptyUsage("identity_mismatch");
  if (typeof header["timestamp"] !== "string" || !Number.isFinite(Date.parse(header["timestamp"])) || typeof header["cwd"] !== "string" || header["cwd"].length > 1024 || (header["parentSession"] !== undefined && (typeof header["parentSession"] !== "string" || header["parentSession"].length > 1024))) return emptyUsage("invalid_stream");
  const tokens: UsageAccounting["tokens"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let recordedCost: bigint | null = 0n;
  const messages: Obj[] = [];
  const seen = new Set<string>();
  let active = false, ended = false, turn = false, message: string | undefined;
  let diagnostic: Diagnostic | undefined;
  let turnMessage: Obj | undefined;
  let lastTimestamp = 0;
  for (const e of events) {
    if (ended) return emptyUsage("invalid_stream");
    switch (e["type"]) {
      case "agent_start": if (!keys(e, ["type"]) || active || messages.length) return emptyUsage("invalid_stream"); active = true; break;
      case "turn_start": if (!keys(e, ["type"]) || !active || turn) return emptyUsage("invalid_stream"); turn = true; turnMessage = undefined; break;
      case "message_start":
        if (!keys(e, ["type", "message"]) || !active || !turn || message || !object(e["message"]) || !["user", "assistant", "toolResult"].includes(e["message"]["role"])) return emptyUsage("invalid_stream");
        message = e["message"]["role"]; break;
      case "message_update": if (message !== "assistant" || !keys(e, ["type", "usage", "assistantMessageEvent"])) return emptyUsage("invalid_stream"); break;
      case "message_end": {
        const m: unknown = e["message"];
        if (!keys(e, ["type", "message"]) || !object(m) || !message || m["role"] !== message) return emptyUsage("invalid_stream");
        message = undefined;
        if (m["role"] !== "assistant") break;
        if (turnMessage) return emptyUsage("invalid_stream");
        if (!keys(m, ["role", "content", "api", "provider", "model", "responseModel", "responseId", "diagnostics", "usage", "stopReason", "errorMessage", "rawStopReason", "endTurn", "timestamp"]) || !integer(m["timestamp"]) || !Array.isArray(m["content"])) return emptyUsage("invalid_stream");
        if (m["provider"] !== profile.provider || m["model"] !== profile.model || !APIS[profile.provider]!.includes(m["api"])) return emptyUsage("identity_mismatch");
        if (!["stop", "length", "toolUse"].includes(m["stopReason"])) return emptyUsage("partial_stream");
        const id = m["responseId"];
        if (id !== undefined && (typeof id !== "string" || !id.length || id.length > 256)) return emptyUsage("identity_mismatch");
        const identity = id ?? digest(m);
        if (seen.has(identity)) return emptyUsage("duplicate_message");
        seen.add(identity);
        const u: unknown = m["usage"];
        if (!object(u) || !keys(u, [...TOKEN_FIELDS, "totalTokens", "cost", "reasoning", "cacheWrite1h"])) return emptyUsage("invalid_usage");
        if (TOKEN_FIELDS.every(f => u[f] === 0) && m["content"].length) return emptyUsage("invalid_usage");
        for (const field of TOKEN_FIELDS) {
          const n = u[field];
          if (n === undefined) { tokens[field] = null; diagnostic = "invalid_usage"; }
          else if (!integer(n) || n > 1_000_000_000_000 || (tokens[field] !== null && (!integer(tokens[field]! + n) || tokens[field]! + n > 1_000_000_000_000))) return emptyUsage("invalid_usage");
          else if (tokens[field] !== null) tokens[field]! += n;
        }
        if (u["totalTokens"] !== undefined && (!integer(u["totalTokens"]) || (TOKEN_FIELDS.every(f => integer(u[f])) && u["totalTokens"] !== TOKEN_FIELDS.reduce((s, f) => s + u[f], 0)))) return emptyUsage("invalid_usage");
        for (const [subset, field] of [["reasoning", "output"], ["cacheWrite1h", "cacheWrite"]] as const) if (u[subset] !== undefined && (!integer(u[subset]) || !integer(u[field]) || u[subset] > u[field])) return emptyUsage("invalid_usage");
        if (u["cost"] === undefined) { recordedCost = null; diagnostic = "missing_cost"; }
        else {
          try {
            const c: unknown = u["cost"];
            if (!object(c) || !keys(c, [...TOKEN_FIELDS, "total"]) || Object.keys(c).length !== 5) throw new Error();
            for (const f of TOKEN_FIELDS) cost(c[f]);
            const amount = cost(c["total"]);
            // Pi uses floating-point arithmetic; total is the recorded authority.
            if (Math.abs(c["total"] - TOKEN_FIELDS.reduce((s, f) => s + c[f], 0)) > Math.max(1e-12, c["total"] * 1e-12)) throw new Error();
            if (recordedCost !== null) recordedCost += amount;
          } catch { recordedCost = null; diagnostic = "invalid_usage"; }
        }
        if (m["timestamp"] < lastTimestamp) return emptyUsage("invalid_stream");
        lastTimestamp = m["timestamp"]; turnMessage = m;
        messages.push(m); break;
      }
      case "turn_end": if (!keys(e, ["type", "message", "toolResults"]) || !Array.isArray(e["toolResults"]) || !turnMessage || digest(e["message"]) !== digest(turnMessage) || !turn || message) return emptyUsage("invalid_stream"); turn = false; break;
      case "agent_end": {
        if (!keys(e, ["type", "messages"]) || !active || turn || message || !Array.isArray(e["messages"])) return emptyUsage("partial_stream");
        const assistants = e["messages"].filter((m: unknown) => object(m) && m["role"] === "assistant");
        if (digest(assistants) !== digest(messages)) return emptyUsage("identity_mismatch");
        ended = true; break;
      }
      case "tool_execution_start": case "tool_execution_update": case "tool_execution_end": if (!turn || message) return emptyUsage("invalid_stream"); break;
      default: return emptyUsage("invalid_stream");
    }
  }
  if (!ended || !exited || !messages.length || !["stop", "length"].includes(messages.at(-1)!["stopReason"])) return emptyUsage("partial_stream");
  return { tokens, recordedCost: recordedCost === null ? null : decimalText(recordedCost), costSource: recordedCost === null ? "unknown" : "pi-recorded", messages: messages.length, diagnostics: diagnostic ? [diagnostic] : [] };
}
