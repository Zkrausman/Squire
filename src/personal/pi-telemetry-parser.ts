import { createHash } from "node:crypto";
import type { PhaseProfile } from "./model-policy.js";

/** Pi print JSON v3 header + pi-agent-core events. Never session JSONL. */
export const MAX_STREAM_BYTES = 64 * 1024 * 1024;
export const TELEMETRY_DIAGNOSTICS = ["missing_stream", "stream_limit", "invalid_stream", "invalid_order", "duplicate_message", "profile_mismatch", "unsupported_provider", "invalid_usage", "partial_stream", "missing_usage", "cost_not_provider_reported", "capture_failed", "missing_session", "ledger_mismatch", "invalid_duration"] as const;
export type TelemetryDiagnostic = typeof TELEMETRY_DIAGNOSTICS[number];
export interface Tokens { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface ParsedUsage {
  piSessionId: string | null;
  tokens: Tokens | null;
  /** Pi normalized cost is rate-table calculated, not provider billed cost. */
  providerCost: null;
  records: number;
  diagnostics: TelemetryDiagnostic[];
}
export const emptyTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const SUPPORTED: Record<string, string> = { "openai-codex": "openai-codex-responses", openai: "openai-responses", anthropic: "anthropic-messages" };
type Obj = Record<string, any>;
function object(v: unknown): v is Obj { return !!v && typeof v === "object" && !Array.isArray(v); }
function shape(v: Obj, required: string[], optional: string[] = []): boolean { return required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k)); }
function integer(v: unknown): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000_000_000; }
function fingerprint(v: unknown): string { return createHash("sha256").update(JSON.stringify(v)).digest("hex"); }
function rejectDuplicateKeys(raw: string, reportOnly = false): void {
  // Accounting-only fields cannot make an otherwise unambiguous phase report
  // invalid. The accounting parser always checks every member independently.
  const accounting = new Set(["usage", "api", "provider", "model", "responseModel", "responseId", "diagnostics", "timestamp", "errorMessage"]);
  const stack: { keys: Set<string> | null; key: boolean; lastKey: string | null; ignored: boolean }[] = [];
  for (const token of raw.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]|[^\s{}\[\],:]+/gu) ?? []) {
    if (token === "{" || token === "[") {
      const parent = stack.at(-1);
      stack.push({ keys: token === "{" ? new Set() : null, key: token === "{", lastKey: null, ignored: !!parent?.ignored || !!(reportOnly && parent?.lastKey && accounting.has(parent.lastKey)) });
    } else if (token === "}" || token === "]") stack.pop();
    else {
      const top = stack.at(-1);
      if (top?.keys && token === ",") { top.key = true; top.lastKey = null; }
      else if (top?.keys && top.key && token.startsWith('"')) {
        const key = JSON.parse(token) as string;
        if (top.keys.has(key) && !top.ignored && !(reportOnly && accounting.has(key))) throw new Error("invalid_stream");
        top.keys.add(key); top.key = false; top.lastKey = key;
      }
    }
    if (stack.length > 100) throw new Error("stream_limit");
  }
}
function events(bytes: Buffer): Obj[] {
  if (bytes.length > MAX_STREAM_BYTES) throw new Error("stream_limit");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.endsWith("\n")) throw new Error("partial_stream");
  const lines = text.trimEnd().split("\n");
  if (lines.length > 200_000) throw new Error("stream_limit");
  return lines.map(line => { const v: unknown = JSON.parse(line); rejectDuplicateKeys(line); if (!object(v) || typeof v["type"] !== "string") throw new Error("invalid_stream"); return v; });
}
/** Report extraction deliberately independent of usage validation. */
export function terminalPiReport(bytes: Buffer): Buffer {
  if (bytes.length > MAX_STREAM_BYTES) throw new Error("Pi stream exceeds bound");
  if (bytes.at(-1) !== 10) throw new Error("Pi terminal event truncated");
  const endOffset = bytes.length - 1;
  const startOffset = bytes.lastIndexOf(10, endOffset - 1) + 1;
  const lastLine = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(startOffset, endOffset));
  const end: unknown = JSON.parse(lastLine);
  rejectDuplicateKeys(lastLine, true);
  if (!object(end) || end["type"] !== "agent_end" || !shape(end, ["type", "messages"])) throw new Error("Pi terminal event missing");
  const messages: unknown = end["messages"];
  if (!Array.isArray(messages)) throw new Error("Pi terminal messages invalid");
  const last: unknown = messages.at(-1);
  if (!object(last) || last["role"] !== "assistant" || !["stop", "length"].includes(last["stopReason"]) || !Array.isArray(last["content"])) throw new Error("Pi terminal assistant missing");
  const text = last["content"].filter((c: unknown) => object(c) && c["type"] === "text").map((c: Obj) => { if (typeof c["text"] !== "string") throw new Error("Pi terminal text invalid"); return c["text"]; }).join("\n");
  return Buffer.from(text, "utf8");
}
export function parsePiUsage(bytes: Buffer | undefined, profile: PhaseProfile): ParsedUsage {
  const diagnostics = new Set<TelemetryDiagnostic>();
  const add = (code: TelemetryDiagnostic) => diagnostics.add(code);
  let piSessionId: string | null = null;
  let records = 0;
  const total = emptyTokens();
  if (!bytes) return { piSessionId, tokens: null, providerCost: null, records, diagnostics: ["missing_stream"] };
  try {
    const stream = events(bytes);
    let started = false, ended = false, turn = false;
    let open: Obj | undefined;
    let lastAssistant: Obj | undefined;
    let lastTimestamp = 0;
    const assistants: string[] = [], seen = new Set<string>(), responseIds = new Set<string>(), timestamps = new Set<number>();
    for (const [index, e] of stream.entries()) {
      const type = e["type"];
      if (ended) add("invalid_order");
      if (index === 0) {
        if (type !== "session" || !shape(e, ["type", "version", "id", "timestamp", "cwd"]) || e["version"] !== 3 || typeof e["id"] !== "string" || !UUID.test(e["id"]) || typeof e["timestamp"] !== "string" || !Number.isFinite(Date.parse(e["timestamp"])) || typeof e["cwd"] !== "string") add("invalid_stream");
        else piSessionId = e["id"];
        continue;
      }
      if (type === "agent_start") { if (started || !shape(e, ["type"])) add("invalid_order"); started = true; continue; }
      if (!started) add("invalid_order");
      if (type === "turn_start") { if (turn || open || !shape(e, ["type"])) add("invalid_order"); turn = true; }
      else if (type === "message_start") {
        if (!turn || open || !shape(e, ["type", "message"]) || !object(e["message"])) add("invalid_order");
        open = object(e["message"]) ? e["message"] : undefined;
        if (open?.["role"] === "assistant" && (open["provider"] !== profile.provider || open["model"] !== profile.model || open["api"] !== SUPPORTED[profile.provider])) add("profile_mismatch");
      } else if (type === "message_update") {
        if (!open || open["role"] !== "assistant" || !shape(e, ["type", "message", "assistantMessageEvent"]) || !object(e["message"]) || e["message"]["role"] !== "assistant" || e["message"]["timestamp"] !== open["timestamp"]) add("invalid_order");
        if (object(e["message"]) && (e["message"]["provider"] !== profile.provider || e["message"]["model"] !== profile.model || e["message"]["api"] !== SUPPORTED[profile.provider])) add("profile_mismatch");
      } else if (type === "message_end") {
        const m: unknown = e["message"];
        if (!shape(e, ["type", "message"]) || !object(m)) { add("invalid_stream"); continue; }
        if (!open || m["role"] !== open["role"] || m["timestamp"] !== open["timestamp"]) add("invalid_order");
        open = undefined;
        if (m["role"] !== "assistant") { if (!["user", "toolResult"].includes(m["role"])) add("invalid_stream"); continue; }
        if (m["timestamp"] < lastTimestamp) add("invalid_order");
        lastTimestamp = m["timestamp"];
        const hash = fingerprint(m);
        if (seen.has(hash) || timestamps.has(m["timestamp"]) || (typeof m["responseId"] === "string" && responseIds.has(m["responseId"]))) add("duplicate_message");
        timestamps.add(m["timestamp"]); seen.add(hash); if (typeof m["responseId"] === "string") responseIds.add(m["responseId"]);
        assistants.push(hash); lastAssistant = m; records++;
        if (records > 10_000) { add("stream_limit"); break; }
        if (!shape(m, ["role", "content", "api", "provider", "model", "usage", "stopReason", "timestamp"], ["responseModel", "responseId", "diagnostics", "errorMessage"]) || !Array.isArray(m["content"]) || !Number.isSafeInteger(m["timestamp"]) || m["timestamp"] < 0) add("invalid_stream");
        if ((m["responseId"] !== undefined && (typeof m["responseId"] !== "string" || m["responseId"].length < 1 || m["responseId"].length > 512)) || (m["responseModel"] !== undefined && (typeof m["responseModel"] !== "string" || m["responseModel"].length > 512)) || (m["diagnostics"] !== undefined && (!Array.isArray(m["diagnostics"]) || m["diagnostics"].length > 100)) || (m["errorMessage"] !== undefined && typeof m["errorMessage"] !== "string")) add("invalid_stream");
        if (m["provider"] !== profile.provider || m["model"] !== profile.model) add("profile_mismatch");
        if (!SUPPORTED[profile.provider] || m["api"] !== SUPPORTED[profile.provider]) add("unsupported_provider");
        if (!["stop", "length", "toolUse"].includes(m["stopReason"])) add("partial_stream");
        const u = m["usage"];
        if (!object(u) || !shape(u, ["input", "output", "cacheRead", "cacheWrite", "totalTokens"], ["cost"]) || !Object.keys(total).every(k => integer(u[k])) || !integer(u["totalTokens"]) || u["totalTokens"] !== u["input"] + u["output"] + u["cacheRead"] + u["cacheWrite"]) { add("invalid_usage"); continue; }
        if (u["cost"] !== undefined && (!object(u["cost"]) || !shape(u["cost"], ["input", "output", "cacheRead", "cacheWrite", "total"]) || Object.values(u["cost"]).some(v => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1_000_000) || u["cost"]["total"] !== u["cost"]["input"] + u["cost"]["output"] + u["cost"]["cacheRead"] + u["cost"]["cacheWrite"])) add("invalid_usage");
        for (const k of Object.keys(total) as (keyof Tokens)[]) { total[k] += u[k]; if (!integer(total[k])) add("invalid_usage"); }
      } else if (type === "turn_end") {
        if (!turn || open || !shape(e, ["type", "message", "toolResults"]) || !Array.isArray(e["toolResults"]) || fingerprint(e["message"]) !== fingerprint(lastAssistant)) add("invalid_order");
        turn = false;
      } else if (type === "agent_end") {
        if (turn || open || !shape(e, ["type", "messages"]) || !Array.isArray(e["messages"])) add("invalid_order");
        else if (JSON.stringify(e["messages"].filter((m: unknown) => object(m) && m["role"] === "assistant").map(fingerprint)) !== JSON.stringify(assistants)) add("invalid_order");
        ended = true;
      } else if (!["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(type)) add("invalid_stream");
      else if (!turn || open) add("invalid_order");
    }
    if (!ended || open || !piSessionId) add("partial_stream");
    if (!records) add("missing_usage");
  } catch (error) { add(error instanceof Error && TELEMETRY_DIAGNOSTICS.includes(error.message as TelemetryDiagnostic) ? error.message as TelemetryDiagnostic : "invalid_stream"); }
  const tokens = diagnostics.size ? null : total;
  add("cost_not_provider_reported");
  return { piSessionId, tokens, providerCost: null, records, diagnostics: [...diagnostics] };
}
