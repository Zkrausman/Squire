import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PhaseProfile } from "./model-policy.js";
import { rejectAmbiguousJson } from "./report-correction.js";
import { DAYBREAK_DIAGNOSTIC, TransientLaunchError } from "./launch-retry.js";

export interface ProviderLaunchIdentity { readonly sessionId: string; readonly profile: PhaseProfile }
/** Pinned Pi provider-error envelope, NOT exception/stderr/model text matching.
 * Only the exact entitlement-verification diagnostic is initially supported.
 * Empty provider placeholders are not model activity; any emitted content,
 * response identity, usage, tool event, unknown event or incomplete turn denies.
 * Call only after successful command completion independently established process close. */
export function classifyProviderLaunch(bytes: Buffer, identity: ProviderLaunchIdentity): TransientLaunchError | undefined {
  try {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(identity.sessionId) || identity.profile.provider !== "openai-codex" || bytes.length > 256 * 1024) return undefined;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.endsWith("\n")) return undefined;
    const lines = text.split("\n").filter(l => l.trim());
    if (lines.length < 7 || lines.length > 12) return undefined;
    const events = lines.map(line => { rejectAmbiguousJson(line); return obj(JSON.parse(line)); });
    const header = events.shift()!;
    if (!keys(header, ["type", "version", "id", "timestamp", "cwd"]) || header["type"] !== "session" || header["version"] !== 3 || header["id"] !== identity.sessionId || header["cwd"] !== "/ticket/workspace" || !date(header["timestamp"])) return undefined;
    const take = (type: string, fields: string[] = []) => { const e = events.shift()!; if (!e || e["type"] !== type || !keys(e, ["type", ...fields])) throw new Error(); return e; };
    take("agent_start"); take("turn_start");
    let user: unknown;
    if (events[0]?.["type"] === "message_start" && obj(events[0]["message"])["role"] === "user") {
      user = take("message_start", ["message"])["message"];
      const u = obj(user);
      if (!keys(u, ["role", "content", "timestamp"]) || !Number.isSafeInteger(u["timestamp"]) || (u["timestamp"] as number) < 0 || !(typeof u["content"] === "string" || (Array.isArray(u["content"]) && u["content"].every(c => { const v = obj(c); return keys(v, ["type", "text"]) && v["type"] === "text" && typeof v["text"] === "string"; }))) || !isDeepStrictEqual(take("message_end", ["message"])["message"], user)) return undefined;
    }
    const start = take("message_start", ["message"])["message"];
    // Pi emits the final empty error as message_start when the provider fails
    // before a start event. Streaming message_update is always non-retryable.
    emptyAssistant(start, identity, obj(start)["stopReason"] === "error");
    const message = take("message_end", ["message"])["message"];
    emptyAssistant(message, identity, true);
    if (obj(start)["timestamp"] !== obj(message)["timestamp"]) return undefined;
    if (obj(start)["stopReason"] === "error" && !isDeepStrictEqual(start, message)) return undefined;
    const end = take("turn_end", ["message", "toolResults"]);
    if (!isDeepStrictEqual(end["message"], message) || !isDeepStrictEqual(end["toolResults"], [])) return undefined;
    const agent = take("agent_end", ["messages"]);
    if (!isDeepStrictEqual(agent["messages"], user ? [user, message] : [message]) || events.length) return undefined;
    return new TransientLaunchError({ version: 1, rule: "codex-daybreak-verification-v1", digest: createHash("sha256").update(bytes).digest("hex") });
  } catch { return undefined; }
}
function emptyAssistant(value: unknown, identity: ProviderLaunchIdentity, final: boolean) {
  const m = obj(value);
  const fields = ["role", "content", "api", "provider", "model", "usage", "stopReason", "timestamp", ...(final ? ["errorMessage"] : [])];
  if (!keys(m, fields) || m["role"] !== "assistant" || !isDeepStrictEqual(m["content"], []) || m["api"] !== "openai-codex-responses" || m["provider"] !== identity.profile.provider || m["model"] !== identity.profile.model || !Number.isSafeInteger(m["timestamp"]) || (m["timestamp"] as number) < 0 || m["stopReason"] !== (final ? "error" : "pending") || (final && m["errorMessage"] !== DAYBREAK_DIAGNOSTIC)) throw new Error();
  const usage = obj(m["usage"]);
  if (!keys(usage, ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"]) || !["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(k => usage[k] === 0)) throw new Error();
  const cost = obj(usage["cost"]);
  if (!keys(cost, ["input", "output", "cacheRead", "cacheWrite", "total"]) || !Object.values(cost).every(v => v === 0)) throw new Error();
}
function obj(v: unknown): Record<string, unknown> { if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(); return v as Record<string, unknown>; }
function keys(v: Record<string, unknown>, fields: string[]): boolean { return Object.keys(v).sort().join() === fields.sort().join(); }
function date(v: unknown): boolean { return typeof v === "string" && Number.isFinite(Date.parse(v)); }
