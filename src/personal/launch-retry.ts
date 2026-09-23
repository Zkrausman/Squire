import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PhaseExecutionError, EXECUTION_FAILURES, type ExecutionFailure } from "./execution-failure.js";
import { rejectAmbiguousJson } from "./report-capture.js";
import type { PersonalPhase, PersonalRunState, PhaseInput } from "./types.js";

export const LAUNCH_CLASSIFIER = "pre-result-provider-v1";
export const LAUNCH_BACKOFF_MS = 1000;
export const DAYBREAK_BLUE = "Unable to verify Daybreak Blue access. Please try again.";
export interface LaunchRetryPolicy { readonly maxRetries: 0 | 1 }
export function validateLaunchRetryPolicy(value: unknown = { maxRetries: 1 }): LaunchRetryPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join() !== "maxRetries" || ![0, 1].includes((value as LaunchRetryPolicy).maxRetries)) throw new Error("launchRetryPolicy requires maxRetries 0 or 1");
  return Object.freeze({ maxRetries: (value as LaunchRetryPolicy).maxRetries });
}
export type LaunchRule = "codex-daybreak-verification" | "process-spawn-unavailable";
const LAUNCH_RULES: readonly LaunchRule[] = ["codex-daybreak-verification", "process-spawn-unavailable"];
/** Constructed only at the trusted adapter boundary, never from report/error text. */
export class TransientLaunchFailure extends PhaseExecutionError {
  readonly classifier = LAUNCH_CLASSIFIER;
  readonly noEffects = true;
  readonly noResult = true;
  readonly recordedCost = "0";
  constructor(readonly rule: LaunchRule) { super("infrastructure", `Phase launch unavailable (${LAUNCH_RULES.includes(rule) ? rule : "unknown"})`); }
}
export function classifyLaunchFailure(error: unknown): LaunchRule | undefined {
  return error instanceof TransientLaunchFailure && LAUNCH_RULES.includes(error.rule) && error.classifier === LAUNCH_CLASSIFIER && error.noEffects === true && error.noResult === true && error.recordedCost === "0" ? error.rule : undefined;
}
/** Pi JSON is the process protocol, not assistant report text. Require a complete
 * single failed provider turn, empty content and zero usage. No stderr matching,
 * partial streams, tool events, successful messages or unknown event extensions.
 * Pi 0.87 completes the turn with exactly one trailing agent_settled.
 * The original protected stream remains telemetry evidence, never public text. */
export function providerLaunchFailure(bytes: Buffer | undefined, input: Pick<PhaseInput, "profile" | "launchGeneration">): TransientLaunchFailure | undefined {
  if (!input.launchGeneration || !bytes || bytes.length > 65536 || input.profile.provider !== "openai-codex") return;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!text.endsWith("\n")) return;
    const events = text.trim().split("\n").map(line => { rejectAmbiguousJson(line); return JSON.parse(line); });
    const header = events.shift();
    if (!header || header.type !== "session" || header.version !== 3 || header.id !== input.launchGeneration.sessionId || typeof header.timestamp !== "string" || !Number.isFinite(Date.parse(header.timestamp)) || typeof header.cwd !== "string" || Object.keys(header).some(k => !["type", "version", "id", "timestamp", "cwd"].includes(k))) return;
    // Pi may include the initial user message before the provider turn.
    let user: unknown;
    if (events[2]?.type === "message_start" && events[2]?.message?.role === "user") {
      if (events[3]?.type !== "message_end" || !isDeepStrictEqual(events[2].message, events[3].message)) return;
      user = events[3].message;
      events.splice(2, 2);
    }
    const permittedKeys = [["type"], ["type"], ["type", "message"], ["type", "message"], ["type", "message", "toolResults"], ["type", "messages", "willRetry"], ["type"]];
    if (events.length !== permittedKeys.length || events.some((e, i) => !e || Object.keys(e).some(k => !permittedKeys[i]!.includes(k)))) return;
    const types = events.map(e => e.type).join();
    if (types !== "agent_start,turn_start,message_start,message_end,turn_end,agent_end,agent_settled" || events[5].willRetry !== false) return;
    const message = events[3]?.message;
    if (!message || message.role !== "assistant" || message.provider !== input.profile.provider || message.model !== input.profile.model || message.api !== "openai-codex-responses" || message.stopReason !== "error" || message.errorMessage !== DAYBREAK_BLUE || !Array.isArray(message.content) || message.content.length) return;
    if (Object.keys(message).some(k => !["role", "content", "api", "provider", "model", "usage", "stopReason", "errorMessage", "timestamp"].includes(k)) || !Number.isSafeInteger(message.timestamp) || message.timestamp < 0) return;
    const start = events[2].message;
    if (!start || start.role !== "assistant" || start.provider !== message.provider || start.model !== message.model || start.api !== message.api || !["pending", "error"].includes(start.stopReason) || !Array.isArray(start.content) || start.content.length || Object.keys(start).some(k => !Object.keys(message).includes(k))) return;
    if (!isDeepStrictEqual(events[4].message, message) || !Array.isArray(events[4].toolResults) || events[4].toolResults.length || !isDeepStrictEqual(events[5].messages, user ? [user, message] : [message])) return;
    const usage = message.usage;
    if (!usage || Object.keys(usage).sort().join() !== "cacheRead,cacheWrite,cost,input,output,totalTokens" || Object.keys(usage.cost ?? {}).sort().join() !== "cacheRead,cacheWrite,input,output,total" || ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].some(k => usage[k] !== 0) || !usage.cost || ["input", "output", "cacheRead", "cacheWrite", "total"].some(k => usage.cost[k] !== 0)) return;
    return new TransientLaunchFailure("codex-daybreak-verification");
  } catch { return; }
}
export interface LaunchGeneration {
  readonly generation: 0 | 1;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly inputPath: string;
}
export interface LaunchRecord extends LaunchGeneration {
  readonly phase: PersonalPhase; readonly attempt: number;
  readonly expectedHead: string; readonly inputDigest: string;
  readonly deadlineAt: string;
  readonly kind: "reserved" | "dispatched" | "failed" | "returned" | "retrying";
  readonly timestamp: string;
  readonly delayMs: number;
  readonly classifier: typeof LAUNCH_CLASSIFIER;
  readonly rule: LaunchRule | null;
  readonly errorCode: ExecutionFailure | null;
}
export function generationIdentity(phase: PersonalPhase, attempt: number, generation: 0 | 1, sessionId: string): LaunchGeneration {
  return { generation, sessionId, sessionFile: `/ticket/sessions/${phase}/${attempt}${generation ? `-g${generation}` : ""}.jsonl`, inputPath: `/ticket/artifacts/inputs/${phase}-${attempt}${generation ? `-g${generation}` : ""}.json` };
}
export function launchInputDigest(input: PhaseInput): string {
  const { launchGeneration: _g, reportSession: _s, ...logical } = input;
  return createHash("sha256").update(JSON.stringify(logical)).digest("hex");
}
export function validateLaunchRetryState(state: PersonalRunState): void {
  if (state.launchRetryPolicy === undefined) { if (state.launchGenerations !== undefined) throw new Error("launch ledger without policy"); return; }
  const policy = validateLaunchRetryPolicy(state.launchRetryPolicy);
  if (!Array.isArray(state.launchGenerations) || state.launchGenerations.length > 10000) throw new Error("invalid launch ledger");
  const latest = new Map<string, LaunchRecord>();
  const sessions = new Set<string>();
  for (const r of state.launchGenerations) {
    if (
      !r || Object.keys(r).sort().join() !== "attempt,classifier,deadlineAt,delayMs,errorCode,expectedHead,generation,inputDigest,inputPath,kind,phase,rule,sessionFile,sessionId,timestamp"
      || !["implement", "verify"].includes(r.phase)
      || !Number.isSafeInteger(r.attempt) || r.attempt < 1 || r.attempt > state.attempts[r.phase as PersonalPhase]
      || ![0, 1].includes(r.generation) || r.generation > policy.maxRetries
      || (r.generation === 1 && r.delayMs < LAUNCH_BACKOFF_MS)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(r.sessionId)
      || !/^[a-f0-9]{40}$/u.test(r.expectedHead) || !/^[a-f0-9]{64}$/u.test(r.inputDigest)
      || typeof r.timestamp !== "string" || r.timestamp.length > 64 || !Number.isFinite(Date.parse(r.timestamp))
      || typeof r.deadlineAt !== "string" || r.deadlineAt.length > 64 || !Number.isFinite(Date.parse(r.deadlineAt))
      || !Number.isSafeInteger(r.delayMs) || r.delayMs < 0
      || r.classifier !== LAUNCH_CLASSIFIER || ![null, ...LAUNCH_RULES].includes(r.rule)
    ) throw new Error("invalid launch generation");
    if (r.kind === "failed" ? !EXECUTION_FAILURES.includes(r.errorCode!) : r.errorCode !== null || (r.kind !== "retrying" && r.rule !== null)) throw new Error("invalid launch error code");
    if (r.kind === "failed" && r.rule !== null && r.errorCode !== "infrastructure") throw new Error("retry rule requires infrastructure failure");
    const identity = generationIdentity(r.phase, r.attempt, r.generation, r.sessionId);
    if (r.sessionFile !== identity.sessionFile || r.inputPath !== identity.inputPath) throw new Error("invalid generation paths");
    const key = `${r.phase}:${r.attempt}`;
    const prior = latest.get(key);
    if (r.kind === "reserved") {
      if (sessions.has(r.sessionId) || (r.generation === 0 ? !!prior : !prior || prior.generation !== 0 || prior.kind !== "retrying" || prior.rule === null || prior.inputDigest !== r.inputDigest || prior.expectedHead !== r.expectedHead || prior.deadlineAt !== r.deadlineAt)) throw new Error("invalid launch reservation");
      sessions.add(r.sessionId);
    } else {
      const retrying = r.kind === "retrying" && r.generation === 0 && policy.maxRetries === 1 && prior?.kind === "failed" && prior.rule !== null && r.rule === prior.rule;
      if (!prior || prior.generation !== r.generation || (!retrying && (!["reserved", "dispatched"].includes(prior.kind) || (prior.kind === "reserved" ? r.kind !== "dispatched" : !["failed", "returned"].includes(r.kind))))) throw new Error("invalid launch transition");
      for (const k of ["sessionId", "sessionFile", "inputPath", "inputDigest", "expectedHead", "deadlineAt"] as const) if (prior[k] !== r[k]) throw new Error("launch identity changed");
    }
    latest.set(key, r);
  }
}
export function assertLaunchRetryUnchanged(current: PersonalRunState, next: PersonalRunState): void {
  if ((next.launchGenerations?.length ?? 0) > (current.launchGenerations?.length ?? 0)) {
    const record = next.launchGenerations!.at(-1)!;
    if (record.phase !== current.step || record.attempt !== current.attempts[record.phase] || (record.kind === "reserved" && record.expectedHead !== current.head)) throw new Error("launch generation baseline/attempt mismatch");
  }
  if ((next.launchGenerations?.length ?? 0) > (current.launchGenerations?.length ?? 0) + 1 || !isDeepStrictEqual(current.launchRetryPolicy, next.launchRetryPolicy) || (next.launchGenerations?.length ?? 0) < (current.launchGenerations?.length ?? 0) || !isDeepStrictEqual(current.launchGenerations, next.launchGenerations?.slice(0, current.launchGenerations?.length))) throw new Error("launch retry policy and ledger are immutable");
}
