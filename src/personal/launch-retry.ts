import { isDeepStrictEqual } from "node:util";
import { PhaseExecutionError, EXECUTION_FAILURES, type ExecutionFailure } from "./execution-failure.js";
import type { PersonalPhase, PersonalRunState, PhaseResult } from "./types.js";

export interface LaunchRetryPolicy { readonly maxRetries: 0 | 1; }
export function validateLaunchRetryPolicy(value: unknown): LaunchRetryPolicy {
  if (value === undefined) return Object.freeze({ maxRetries: 1 });
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "maxRetries") || ![0, 1].includes((value as LaunchRetryPolicy).maxRetries)) throw new Error("invalid launchRetryPolicy: only maxRetries 0 or 1 is supported");
  return Object.freeze({ maxRetries: (value as LaunchRetryPolicy).maxRetries });
}
export const LAUNCH_CLASSIFIER_VERSION = 1;
export const RETRY_DELAY_MS = 1000;
export const DAYBREAK_VERIFICATION = "Unable to verify Daybreak Blue access. Please try again.";
export const LAUNCH_RULES = ["daybreak-verification", "transport-connect-reset", "service-unavailable", "not-allowlisted"] as const;
export type LaunchRule = typeof LAUNCH_RULES[number];
/** Only the trusted adapter constructs this envelope. It must never be decoded
 * from phase JSON, ticket text, or an ordinary exception message. */
export interface LaunchFailureEvidence {
  readonly version: 1;
  readonly kind: "entitlement-verification" | "transport" | "service";
  readonly code: string;
  readonly boundary: "before-model-events" | "ambiguous";
  readonly resultObserved: boolean;
  readonly processExited: boolean;
}
export class LaunchFailure extends PhaseExecutionError {
  readonly evidence: Readonly<LaunchFailureEvidence>;
  constructor(evidence: LaunchFailureEvidence) {
    super("infrastructure", "provider launch failed; bounded classifier evidence retained");
    this.evidence = Object.freeze({ ...evidence });
  }
}
export function classifyLaunchFailure(error: unknown): LaunchRule {
  if (!(error instanceof LaunchFailure)) return "not-allowlisted";
  const e = error.evidence;
  if (!isDeepStrictEqual(Object.keys(e).sort(), ["boundary", "code", "kind", "processExited", "resultObserved", "version"]) || e.version !== 1 || e.boundary !== "before-model-events" || e.resultObserved !== false || e.processExited !== true) return "not-allowlisted";
  if (e.kind === "entitlement-verification" && e.code === DAYBREAK_VERIFICATION) return "daybreak-verification";
  if (e.kind === "transport" && e.code === "CONNECT_ECONNRESET") return "transport-connect-reset";
  if (e.kind === "service" && e.code === "HTTP_503_PRE_SESSION") return "service-unavailable";
  return "not-allowlisted";
}
/** Append-only transitions. A dispatched generation can never be dispatched
 * again, including after a controller crash. No raw provider strings live here. */
export interface LaunchGeneration {
  readonly id: string;
  readonly owner: string;
  readonly phase: PersonalPhase;
  readonly attempt: number;
  readonly generation: 1 | 2;
  readonly sessionId: string;
  readonly inputDigest: string;
  readonly expectedHead: string;
  readonly kind: "reserved" | "dispatched" | "returned" | "failed";
  readonly failure: ExecutionFailure | null;
  readonly resultDigest: string | null;
  readonly timestamp: string;
  readonly delayMs: number;
  readonly elapsedDelayMs: number;
  readonly classifierVersion: 1;
  readonly rule: LaunchRule;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
export function validateLaunchGenerations(state: PersonalRunState): void {
  if (state.launchRetryPolicy === undefined && state.launchGenerations === undefined) return;
  if (state.launchRetryPolicy === undefined || state.launchGenerations === undefined) throw new Error("incomplete launch generation policy/history");
  validateLaunchRetryPolicy(state.launchRetryPolicy);
  const rows = state.launchGenerations;
  if (!Array.isArray(rows) || rows.length > 12000) throw new Error("invalid launch generation ledger");
  const latest = new Map<string, LaunchGeneration>();
  const keys = ["id", "owner", "phase", "attempt", "generation", "sessionId", "inputDigest", "expectedHead", "kind", "timestamp", "delayMs", "elapsedDelayMs", "classifierVersion", "rule", "failure", "resultDigest"].sort();
  for (const row of rows as readonly LaunchGeneration[]) {
    if (!row || !isDeepStrictEqual(Object.keys(row).sort(), keys)
      || [row.id, row.owner, row.sessionId, row.phase, row.inputDigest, row.expectedHead, row.timestamp, row.kind, row.rule].some(v => typeof v !== "string")
      || !UUID.test(row.id) || !UUID.test(row.owner) || !UUID.test(row.sessionId)
      || !["plan", "implement", "review", "test", "retro"].includes(row.phase)
      || !Number.isSafeInteger(row.attempt) || row.attempt < 1 || row.attempt > state.attempts[row.phase]
      || ![1, 2].includes(row.generation) || !/^[a-f0-9]{64}$/u.test(row.inputDigest) || !/^[a-f0-9]{40}$/u.test(row.expectedHead)
      || !Number.isFinite(Date.parse(row.timestamp)) || row.classifierVersion !== LAUNCH_CLASSIFIER_VERSION || !LAUNCH_RULES.includes(row.rule)
      || row.delayMs !== (row.generation === 1 ? 0 : RETRY_DELAY_MS) || !Number.isFinite(row.elapsedDelayMs) || row.elapsedDelayMs < 0
      || row.resultDigest !== null && typeof row.resultDigest !== "string") throw new Error("invalid launch generation evidence");
    if (row.kind === "failed" ? !EXECUTION_FAILURES.includes(row.failure!) : row.failure !== null) throw new Error("invalid sanitized launch failure");
    if (row.kind === "returned" ? !/^[a-f0-9]{64}$/u.test(row.resultDigest!) : row.resultDigest !== null) throw new Error("invalid launch return digest");
    if (row.rule !== "not-allowlisted" && (row.kind !== "failed" || row.failure !== "infrastructure")) throw new Error("classifier rule requires an infrastructure failure");
    if (rows[0]!.owner !== row.owner) throw new Error("launch controller owner is immutable");
    const prior = latest.get(row.id);
    if (!prior) {
      if (row.kind !== "reserved" || [...latest.values()].some(p => p.sessionId === row.sessionId || p.phase === row.phase && p.attempt === row.attempt && p.generation === row.generation)) throw new Error("duplicate launch reservation");
      if (row.generation === 2) {
        const failed = [...latest.values()].find(p => p.phase === row.phase && p.attempt === row.attempt && p.generation === 1);
        if (state.launchRetryPolicy?.maxRetries !== 1 || !failed || failed.kind !== "failed" || failed.rule === "not-allowlisted" || failed.inputDigest !== row.inputDigest || failed.expectedHead !== row.expectedHead || failed.owner !== row.owner) throw new Error("retry lacks immutable failed predecessor");
      }
    } else {
      const immutable = (r: LaunchGeneration) => { const { kind, timestamp, elapsedDelayMs, rule, failure, resultDigest, ...rest } = r; return rest; };
      if (!isDeepStrictEqual(immutable(prior), immutable(row)) || !(prior.kind === "reserved" && row.kind === "dispatched" || prior.kind === "dispatched" && ["failed", "returned"].includes(row.kind)) || Date.parse(row.timestamp) < Date.parse(prior.timestamp)) throw new Error("invalid launch generation transition");
    }
    latest.set(row.id, row);
  }
}
export function assertLaunchGenerationsUnchanged(current: PersonalRunState, next: PersonalRunState): void {
  if (!isDeepStrictEqual(current.launchRetryPolicy, next.launchRetryPolicy)) throw new Error("launch retry policy is immutable");
  const before = current.launchGenerations, after = next.launchGenerations;
  if (before === undefined) { if (after !== undefined) throw new Error("cannot invent legacy launch history"); return; }
  if (!after || after.length < before.length || after.length > before.length + 1 || !isDeepStrictEqual(before, after.slice(0, before.length))) throw new Error("launch generations are append-only");
  if (after.length !== before.length) {
    if (current.status !== "running") throw new Error("terminal launch history is immutable");
    const row = after.at(-1)!;
    if (current.step !== row.phase || current.attempts[row.phase] !== row.attempt || next.head !== current.head || row.kind === "reserved" && row.expectedHead !== current.head) throw new Error("launch generation is not bound to the active phase/candidate");
  }
}

/** Legacy phases retain their old path; generation-aware phases require the
 * exact controller-issued session, not merely a plausibly qualified filename. */
export function launchSessionMatches(state: PersonalRunState, result: PhaseResult): boolean {
  const generations = state.launchGenerations?.filter(g => g.phase === result.phase && g.attempt === result.attempt) ?? [];
  if (!generations.length || result.phase === "plan" && result.details.supervision) return result.sessionFile === `/ticket/sessions/${result.phase}/${result.attempt}.jsonl`;
  return generations.some(g => (g.kind === "returned" || g.kind === "failed") && g.sessionId === result.sessionId && g.expectedHead === result.inputHead && result.sessionFile === `/ticket/sessions/${g.phase}/${g.attempt}-${g.id}.jsonl`);
}
