import type { PhaseProfile } from "../../src/personal/model-policy.js";
export const fixtureSession = "11111111-1111-4111-8111-111111111111";
export const fixtureProfile: PhaseProfile = { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" };
/** Actual pinned Pi event envelopes, not retained-session JSONL. */
export function piEvents(report: string, sessionId = fixtureSession, profile = fixtureProfile): any[] {
  const user = { role: "user", content: "PRIVATE PROMPT", timestamp: 1 };
  const assistant = { role: "assistant", content: [{ type: "text", text: report }], api: "openai-codex-responses", provider: profile.provider, model: profile.model, responseId: "response-1", timestamp: 2, stopReason: "stop", usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100, cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 } } };
  return [{ type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/private/workspace" }, { type: "agent_start" }, { type: "turn_start" }, { type: "message_start", message: user }, { type: "message_end", message: user }, { type: "message_start", message: { ...assistant, content: [] } }, { type: "message_end", message: assistant }, { type: "turn_end", message: assistant, toolResults: [] }, { type: "agent_end", messages: [user, assistant] }];
}
export function jsonLines(events: unknown[]): Buffer { return Buffer.from(events.map(e => JSON.stringify(e)).join("\n") + "\n"); }
export function piJson(report: string, sessionId = fixtureSession, profile = fixtureProfile): Buffer { return jsonLines(piEvents(report, sessionId, profile)); }
