import { isDeepStrictEqual } from "node:util";
import { rejectAmbiguousJson } from "./report-correction.js";
import { TransientLaunchError } from "./launch-retry.js";
import type { PhaseProfile } from "./model-policy.js";

export const DAYBREAK_VERIFICATION = "Unable to verify Daybreak Blue access. Please try again.";
const noEffects = Object.freeze({ modelOutput: false, toolActivity: false, resultConsumed: false, ambiguous: false });
/** Closed Pi 0.84.4 pre-result error envelope. Anything extra, including a
 * streamed text/thinking/tool delta or a prior turn, is effect-ambiguous. */
export function providerLaunchFailure(bytes: Buffer | undefined, profile: PhaseProfile, sessionId: string): TransientLaunchError | undefined {
  if (!Buffer.isBuffer(bytes) || bytes.length > 256 * 1024 || profile.provider !== "openai-codex") return;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.endsWith("\n")) return;
    const events = text.trimEnd().split("\n").map(line => { rejectAmbiguousJson(line); return JSON.parse(line); });
    const exact = (v: any, keys: string[]) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));
    const header = events.shift();
    if (!exact(header, ["type", "version", "id", "timestamp", "cwd"]) || header.type !== "session" || header.version !== 3 || header.id !== sessionId) return;
    if (!isDeepStrictEqual(events.shift(), { type: "agent_start" }) || !isDeepStrictEqual(events.shift(), { type: "turn_start" })) return;
    const userStart = events.shift(), userEnd = events.shift();
    if (!exact(userStart, ["type", "message"]) || userStart.type !== "message_start" || userStart.message?.role !== "user" || !isDeepStrictEqual(userEnd, { type: "message_end", message: userStart.message })) return;
    const start = events.shift();
    const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const validEmpty = (m: any) => exact(m, ["role", "content", "api", "provider", "model", "usage", "stopReason", "errorMessage", "timestamp"]) && m.role === "assistant" && Array.isArray(m.content) && m.content.length === 0 && m.provider === profile.provider && m.model === profile.model && m.api === "openai-codex-responses" && Number.isSafeInteger(m.timestamp) && m.timestamp >= 0 && isDeepStrictEqual(m.usage, zeroUsage);
    const validError = (m: any) => validEmpty(m) && m.stopReason === "error" && m.errorMessage === DAYBREAK_VERIFICATION;
    if (!exact(start, ["type", "message"]) || start.type !== "message_start" || !validEmpty(start.message) || !["stop", "error"].includes(start.message.stopReason)) return;
    if (events[0]?.type === "message_update") {
      const update = events.shift();
      if (!exact(update, ["type", "assistantMessageEvent"]) || !exact(update.assistantMessageEvent, ["type", "reason", "error"]) || update.assistantMessageEvent.type !== "error" || update.assistantMessageEvent.reason !== "error" || !validError(update.assistantMessageEvent.error)) return;
    }
    const end = events.shift();
    if (!exact(end, ["type", "message"]) || end.type !== "message_end" || !validError(end.message)) return;
    if (!isDeepStrictEqual(events.shift(), { type: "turn_end", message: end.message, toolResults: [] }) || !isDeepStrictEqual(events.shift(), { type: "agent_end", messages: [userEnd.message, end.message] }) || events.length) return;
    return new TransientLaunchError("daybreak-verification", noEffects);
  } catch { return; }
}
export function preSessionProcessFailure(provider: string, stdout: Buffer, stderr: Buffer, code: string | number | undefined, interrupted: boolean): TransientLaunchError | undefined {
  if (interrupted || stdout.length !== 0 || stderr.length > 256) return;
  // Exact bounded stderr from a failed process, never a substring of arbitrary
  // diagnostics. Restrict this entitlement rule to its actual provider.
  if (provider === "openai-codex" && typeof code === "number" && code !== 0 && stderr.toString("utf8").trim() === DAYBREAK_VERIFICATION) return new TransientLaunchError("daybreak-verification", noEffects);
  if (stderr.length === 0 && typeof code === "string" && ["EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH"].includes(code)) return new TransientLaunchError("transport-unavailable", noEffects);
  return;
}
