import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PhaseExecutionError, EXECUTION_FAILURES, type ExecutionFailure } from "./execution-failure.js";
import type { PersonalPhase, PersonalRunState, PhaseInput } from "./types.js";

export const LAUNCH_CLASSIFIER_VERSION = 1 as const;
export const DAYBREAK_DIAGNOSTIC = "Unable to verify Daybreak Blue access. Please try again.";
export const LAUNCH_RULES = ["codex-daybreak-verification-v1"] as const;
export interface LaunchRetryPolicy { readonly maxRetries: 0 | 1; readonly backoffMs: number }
export function validateLaunchRetryPolicy(value: unknown = { maxRetries: 1, backoffMs: 1000 }): LaunchRetryPolicy {
  const v = object(value);
  if (!exact(v, ["maxRetries", "backoffMs"]) || ![0, 1].includes(v["maxRetries"] as number) || !Number.isSafeInteger(v["backoffMs"]) || (v["backoffMs"] as number) < 0 || (v["backoffMs"] as number) > 30000) throw new Error("invalid transient launch retry policy");
  return Object.freeze({ maxRetries: v["maxRetries"] as 0 | 1, backoffMs: v["backoffMs"] as number });
}
export interface LaunchFailureEvidence {
  readonly version: 1;
  readonly rule: typeof LAUNCH_RULES[number];
  readonly digest: string;
}
/** Only a trusted provider adapter may construct this error. Exception text is
 * never classifier input. The adapter must have observed process close and a
 * complete, empty provider error envelope, with no model/tool/result activity. */
export class TransientLaunchError extends PhaseExecutionError {
  readonly evidence: LaunchFailureEvidence;
  constructor(evidence: LaunchFailureEvidence) {
    super("infrastructure", "Transient provider launch failed (codex-daybreak-verification-v1)");
    validateLaunchFailure(evidence);
    this.evidence = Object.freeze({ ...evidence });
  }
}
export function classifyTransientLaunch(error: unknown): LaunchFailureEvidence | undefined {
  if (!(error instanceof TransientLaunchError)) return undefined;
  try { validateLaunchFailure(error.evidence); return { ...error.evidence }; } catch { return undefined; }
}
export function validateLaunchFailure(v: unknown): asserts v is LaunchFailureEvidence {
  const o = object(v);
  if (!exact(o, ["version", "rule", "digest"]) || o["version"] !== 1 || !LAUNCH_RULES.includes(o["rule"] as typeof LAUNCH_RULES[number]) || !hash(o["digest"])) throw new Error("invalid launch classifier evidence");
}
export type LaunchKind = "reserved" | "dispatched" | "failed" | "returned" | "stopped";
export interface LaunchRecord {
  readonly phase: PersonalPhase; readonly attempt: number; readonly generation: 1 | 2;
  readonly sessionId: string; readonly sessionFile: string; readonly inputPath: string;
  readonly logicalDigest: string; readonly promptDigest: string; readonly expectedHead: string;
  readonly owner: string; readonly deadline: number;
  readonly kind: LaunchKind; readonly timestamp: string; readonly delayMs: number; readonly elapsedDelayMs: number;
  readonly failure: LaunchFailureEvidence | null;
  readonly errorCode: ExecutionFailure | null;
}
export function launchPaths(phase: PersonalPhase, attempt: number, generation: number) {
  const suffix = generation === 1 ? "" : `-g${generation}`;
  return { sessionFile: `/ticket/sessions/${phase}/${attempt}${suffix}.jsonl`, inputPath: `/ticket/artifacts/inputs/${phase}-${attempt}${suffix}.json` };
}
export function logicalInputDigest(input: PhaseInput): string {
  const { reportSession: _session, launchGeneration: _generation, ...logical } = input;
  return createHash("sha256").update(JSON.stringify(logical)).digest("hex");
}
export function currentLaunch(state: PersonalRunState, phase: PersonalPhase, attempt: number): LaunchRecord | undefined {
  return [...(state.launches ?? [])].reverse().find(r => r.phase === phase && r.attempt === attempt);
}
export function validateLaunchState(state: PersonalRunState): void {
  if (state.launchRetryPolicy === undefined && state.launches === undefined) return;
  if (!state.launchRetryPolicy || !Array.isArray(state.launches) || state.launches.length > 10000) throw new Error("incomplete launch ledger");
  const policy = validateLaunchRetryPolicy(state.launchRetryPolicy);
  const active = new Map<string, LaunchRecord>();
  const sessions = new Set<string>();
  let last: LaunchRecord | undefined;
  for (const r of state.launches as readonly LaunchRecord[]) {
    if (!exact(object(r), ["phase", "attempt", "generation", "sessionId", "sessionFile", "inputPath", "logicalDigest", "promptDigest", "expectedHead", "owner", "deadline", "kind", "timestamp", "delayMs", "elapsedDelayMs", "failure", "errorCode"]) || !["plan", "implement", "review", "test", "retro"].includes(r.phase) || !Number.isSafeInteger(r.attempt) || r.attempt < 1 || r.attempt > state.attempts[r.phase] || ![1, 2].includes(r.generation) || !uuid(r.sessionId) || !uuid(r.owner) || !hash(r.logicalDigest) || !hash(r.promptDigest) || !/^[a-f0-9]{40,64}$/u.test(r.expectedHead) || !Number.isFinite(r.deadline) || r.deadline <= 0 || !Number.isFinite(Date.parse(r.timestamp)) || !Number.isFinite(r.elapsedDelayMs) || r.elapsedDelayMs < 0) throw new Error("invalid launch ledger record");
    const paths = launchPaths(r.phase, r.attempt, r.generation);
    if (r.sessionFile !== paths.sessionFile || r.inputPath !== paths.inputPath || r.delayMs !== (r.generation === 1 ? 0 : policy.backoffMs)) throw new Error("invalid launch generation paths or delay");
    if (["failed", "stopped"].includes(r.kind) ? !EXECUTION_FAILURES.includes(r.errorCode!) : r.errorCode !== null) throw new Error("invalid launch error code");
    if (r.failure !== null) { validateLaunchFailure(r.failure); if (r.errorCode !== "infrastructure") throw new Error("contradictory launch classifier evidence"); }
    const key = `${r.phase}:${r.attempt}`;
    const previous = active.get(key);
    if (r.kind === "reserved") {
      if (last && ["reserved", "dispatched"].includes(last.kind)) throw new Error("overlapping launch generations");
      if (sessions.has(r.sessionId) || r.elapsedDelayMs !== 0 || r.failure !== null) throw new Error("reused launch identity");
      sessions.add(r.sessionId);
      if (!previous) { if (r.generation !== 1) throw new Error("launch generation gap"); }
      else if (previous.kind !== "failed" || !previous.failure || previous.generation !== 1 || r.generation !== 2 || policy.maxRetries !== 1 || !sameBinding(previous, r)) throw new Error("unauthorized launch retry");
    } else {
      if (!previous || previous !== last || !sameIdentity(previous, r) || !((previous.kind === "reserved" && ["dispatched", "stopped"].includes(r.kind)) || (previous.kind === "dispatched" && ["failed", "returned", "stopped"].includes(r.kind))) || (r.kind !== "failed" && r.failure !== null)) throw new Error("invalid launch transition");
      if (r.kind === "dispatched" && r.elapsedDelayMs < r.delayMs) throw new Error("launch backoff not elapsed");
      if (previous.kind !== "reserved" && r.elapsedDelayMs !== previous.elapsedDelayMs) throw new Error("launch elapsed delay changed");
    }
    active.set(key, r);
    last = r;
  }
  for (const result of Object.values(state.results)) {
    const launch = active.get(`${result.phase}:${result.attempt}`);
    if (!launch || (launch.kind !== "returned" || result.sessionId !== launch.sessionId || result.sessionFile !== launch.sessionFile || result.inputHead !== launch.expectedHead)) throw new Error("result from unauthorized launch generation");
  }
}
export function assertLaunchAppendOnly(current: PersonalRunState, next: PersonalRunState): void {
  if (!isDeepStrictEqual(current.launchRetryPolicy, next.launchRetryPolicy) || (!!current.launches !== !!next.launches)) throw new Error("launch policy is immutable");
  if (!current.launches) return;
  if (next.launches!.length < current.launches.length || next.launches!.length > current.launches.length + 1 || !isDeepStrictEqual(current.launches, next.launches!.slice(0, current.launches.length))) throw new Error("launch history is append-only");
  if (next.launches!.length > current.launches.length && (current.status !== "running" || next.status !== "running")) throw new Error("terminal launch transition forbidden");
}
function sameBinding(a: LaunchRecord, b: LaunchRecord): boolean { return ["phase", "attempt", "logicalDigest", "promptDigest", "expectedHead", "deadline", "owner"].every(k => a[k as keyof LaunchRecord] === b[k as keyof LaunchRecord]); }
function sameIdentity(a: LaunchRecord, b: LaunchRecord): boolean { return sameBinding(a, b) && ["generation", "sessionId", "sessionFile", "inputPath", "delayMs"].every(k => a[k as keyof LaunchRecord] === b[k as keyof LaunchRecord]); }
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("invalid launch object"); return v as Record<string, unknown>; }
function exact(v: Record<string, unknown>, keys: string[]): boolean { return Object.keys(v).sort().join() === keys.sort().join(); }
function hash(v: unknown): v is string { return typeof v === "string" && /^[a-f0-9]{64}$/u.test(v); }
function uuid(v: unknown): v is string { return typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v); }
