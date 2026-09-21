import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { classifyExecutionFailure, EXECUTION_FAILURES, PhaseExecutionError, type ExecutionFailure } from "./execution-failure.js";
import type { PersonalPhase, PersonalRunState, PhaseInput, PhaseResult } from "./types.js";

export const LAUNCH_BACKOFF_MS = 1000;
export function validateLaunchRetries(value: unknown): 0 | 1 {
  if (value === undefined) return 1;
  if (value !== 0 && value !== 1) throw new Error("launchRetries must be zero or one");
  return value;
}
export const LAUNCH_RULES = ["daybreak-verification-v1", "service-unavailable-v1", "transport-unavailable-v1"] as const;
export type LaunchRule = typeof LAUNCH_RULES[number];
export interface LaunchFailure { version: 1; rule: LaunchRule; summary: "Provider unavailable before session activity"; digest: string; }
/** Constructed only at the trusted process adapter, never from model report text. */
export class TransientLaunchError extends PhaseExecutionError {
  readonly evidence: LaunchFailure;
  constructor(rule: LaunchRule) {
    super("infrastructure", "Provider unavailable before session activity");
    if (!LAUNCH_RULES.includes(rule)) throw new Error("unknown launch classifier rule");
    this.evidence = Object.freeze({ version: 1, rule, summary: "Provider unavailable before session activity", digest: createHash("sha256").update(rule).digest("hex") });
  }
}
/** Exact isolated stderr plus no stdout, normal nonzero exit, and an explicitly
 * selected provider-launch channel. Killed/partial/unknown failures fail closed. */
export function providerLaunchFailure(provider: string | undefined, stdout: Buffer, stderr: Buffer, exit: string | number | undefined, killed: boolean, aborted: boolean): TransientLaunchError | undefined {
  if (provider !== "openai-codex" || stdout.length || killed || aborted || typeof exit !== "number" || exit === 0) return undefined;
  const diagnostic = stderr.toString("utf8");
  const rules: Readonly<Record<string, LaunchRule>> = {
    "Unable to verify Daybreak Blue access. Please try again.": "daybreak-verification-v1",
    "Provider service unavailable before session start. Please try again.": "service-unavailable-v1",
    "Provider transport unavailable before session start. Please try again.": "transport-unavailable-v1",
  };
  const exact = diagnostic.replace(/\r?\n$/u, "");
  const rule = Object.hasOwn(rules, exact) ? rules[exact] : undefined;
  return rule ? new TransientLaunchError(rule) : undefined;
}
export interface LaunchGeneration {
  phase: PersonalPhase; attempt: number; generation: 0 | 1; sessionId: string; sessionFile: string;
  inputDigest: string; expectedHead: string; baseline: string; expiresAt: string;
}
export interface LaunchTransition extends LaunchGeneration {
  kind: "reserved" | "dispatched" | "returned" | "failed";
  at: string; delayMs: number; errorClass?: ExecutionFailure; failure?: LaunchFailure;
}
export function launchSessionFile(phase: PersonalPhase, attempt: number, generation: number): string {
  return generation === 0 ? `/ticket/sessions/${phase}/${attempt}.jsonl` : `/ticket/sessions/${phase}/${attempt}-launch-${generation}.jsonl`;
}
export function validateLaunchJournal(state: PersonalRunState): void {
  if (state.launchRetries !== undefined) validateLaunchRetries(state.launchRetries);
  if (state.launchJournal === undefined) return;
  if (state.launchRetries === undefined || (!Array.isArray(state.launchJournal) || state.launchJournal.length > 2000)) throw new Error("missing launch policy");
  const previous = new Map<string, LaunchTransition>();
  const sessions = new Set<string>();
  for (const t of state.launchJournal as readonly LaunchTransition[]) {
    if (!t || Object.keys(t).some(k => !["phase", "attempt", "generation", "sessionId", "sessionFile", "inputDigest", "expectedHead", "baseline", "expiresAt", "kind", "at", "delayMs", "failure", "errorClass"].includes(k)) || !["plan", "implement", "review", "test", "retro"].includes(t.phase) || !Number.isSafeInteger(t.attempt) || t.attempt < 1 || t.attempt > state.attempts[t.phase] || ![0, 1].includes(t.generation) || !/^[a-f0-9-]{36}$/u.test(t.sessionId) || t.sessionFile !== launchSessionFile(t.phase, t.attempt, t.generation) || !/^[a-f0-9]{64}$/u.test(t.inputDigest) || !/^[a-f0-9]{40}$/u.test(t.expectedHead) || t.baseline !== state.baseSha || !Number.isFinite(Date.parse(t.expiresAt)) || !Number.isFinite(Date.parse(t.at)) || !Number.isSafeInteger(t.delayMs) || t.delayMs < 0) throw new Error("invalid launch journal");
    const key = `${t.phase}/${t.attempt}`;
    const p = previous.get(key);
    if (t.kind === "reserved") {
      if (sessions.has(t.sessionId) || (!p ? t.generation !== 0 : p.kind !== "failed" || !p.failure || p.generation !== 0 || t.generation !== 1 || state.launchRetries !== 1 || t.inputDigest !== p.inputDigest || t.expectedHead !== p.expectedHead || t.expiresAt !== p.expiresAt)) throw new Error("invalid launch reservation");
      sessions.add(t.sessionId);
    } else {
      const { kind: _kind, at: _at, delayMs: _delay, failure: _failure, errorClass: _error, ...binding } = t;
      const { kind: _pk, at: _pa, delayMs: _pd, failure: _pf, errorClass: _pe, ...prior } = p ?? {};
      if (!p || !isDeepStrictEqual(binding, prior) || (t.kind === "dispatched" ? p.kind !== "reserved" : !["failed", "returned"].includes(t.kind) || p.kind !== "dispatched")) throw new Error("invalid launch transition");
    }
    if (t.kind === "failed" ? !EXECUTION_FAILURES.includes(t.errorClass!) : t.errorClass !== undefined) throw new Error("invalid launch error classification");
    if (t.failure && (t.kind !== "failed" || !isDeepStrictEqual(t.failure, new TransientLaunchError(t.failure.rule).evidence) || !LAUNCH_RULES.includes(t.failure.rule))) throw new Error("invalid launch failure");
    previous.set(key, t);
  }
}
export function assertLaunchAppendOnly(current: PersonalRunState, next: PersonalRunState): void {
  if (current.launchRetries !== next.launchRetries || !isDeepStrictEqual(current.launchJournal ?? [], (next.launchJournal ?? []).slice(0, current.launchJournal?.length ?? 0))) throw new Error("launch evidence is immutable");
  const added = (next.launchJournal?.length ?? 0) - (current.launchJournal?.length ?? 0);
  const appended = added ? next.launchJournal?.at(-1) : undefined;
  if (appended && (appended.phase !== current.step || appended.attempt !== current.attempts[appended.phase] || appended.expectedHead !== current.head || (current.results[appended.phase]?.attempt ?? 0) >= appended.attempt)) throw new Error("launch does not own the current unconsumed phase attempt");
  if (added && (next.step !== current.step || next.head !== current.head || next.baseSha !== current.baseSha || next.status !== current.status)) throw new Error("launch transition changed candidate or lifecycle");
  if (added < 0 || added > 1 || (added && current.status !== "running")) throw new Error("invalid launch journal append");
}

export interface LaunchCoordinator {
  state(): PersonalRunState;
  append(t: LaunchTransition): Promise<void>;
  inspect(): Promise<void>;
  now(): number;
  remaining?(): number;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}
/** One logical input/deadline; CAS persistence is the dispatch authorization.
 * An unresolved dispatch/return never causes an automatic successor. */
export async function executeLaunch(input: PhaseInput, owner: LaunchCoordinator, run: (input: PhaseInput) => Promise<PhaseResult>, signal?: AbortSignal): Promise<PhaseResult> {
  const fixed = structuredClone(input);
  const { reportSession: _session, launchGeneration: _generation, launchExpiresAt: _expires, deadline: _deadline, ...bound } = fixed;
  const inputDigest = createHash("sha256").update(JSON.stringify({ input: bound, launch: owner.state().launchEvidence ?? null, policy: owner.state().launchRetries })).digest("hex");
  let latest = owner.state().launchJournal?.filter(t => t.phase === input.phase && t.attempt === input.attempt).at(-1);
  const expiresAt = latest?.expiresAt ?? new Date(owner.now() + Math.max(0, owner.remaining?.() ?? (input.deadline ?? performance.now()) - performance.now())).toISOString();
  const check = () => {
    signal?.throwIfAborted();
    if ((owner.state().results[input.phase]?.attempt ?? 0) >= input.attempt) throw new Error("phase result already consumed; human authorization required");
    if (owner.state().status !== "running" || owner.now() >= Date.parse(expiresAt) || (owner.remaining?.() ?? 1) <= 0) throw new PhaseExecutionError("timeout", "original launch deadline exhausted");
  };
  while (true) {
    check();
    if (latest && (latest.inputDigest !== inputDigest || latest.expectedHead !== input.expectedHead || latest.baseline !== input.originalTicketBaseSha)) throw new Error("launch binding mismatch");
    if (latest?.kind === "dispatched" || latest?.kind === "returned") throw new Error("ambiguous launch requires human authorization");
    if (!latest || latest.kind === "failed") {
      if (latest && (!latest.failure || latest.generation !== 0 || owner.state().launchRetries !== 1)) throw new PhaseExecutionError("infrastructure", "launch retry unavailable; human authorization required");
      if (latest) await owner.inspect();
      check();
      const generation = latest ? 1 : 0;
      const t: LaunchTransition = { phase: input.phase, attempt: input.attempt, generation, sessionId: randomUUID(), sessionFile: launchSessionFile(input.phase, input.attempt, generation), inputDigest, expectedHead: input.expectedHead, baseline: input.originalTicketBaseSha, expiresAt, kind: "reserved", at: new Date(owner.now()).toISOString(), delayMs: 0 };
      await owner.append(t); latest = t;
    }
    const reserved = latest;
    const start = owner.now();
    if (reserved.generation) await (owner.sleep ?? (async (ms, s) => { await delay(ms, undefined, s ? { signal: s } : {}); }))(Math.max(0, Date.parse(reserved.at) + LAUNCH_BACKOFF_MS - start), signal);
    check();
    if (reserved.generation) await owner.inspect();
    check();
    const dispatched: LaunchTransition = { ...reserved, kind: "dispatched", at: new Date(owner.now()).toISOString(), delayMs: Math.max(0, owner.now() - Date.parse(reserved.at)) };
    await owner.append(dispatched);
    let result: PhaseResult;
    try {
      result = await run({ ...structuredClone(fixed), launchExpiresAt: expiresAt, launchGeneration: reserved.generation, reportSession: { sessionId: reserved.sessionId, sessionFile: reserved.sessionFile } });
    } catch (error) {
      const safe = error instanceof TransientLaunchError && !signal?.aborted;
      latest = { ...dispatched, kind: "failed", errorClass: classifyExecutionFailure(error, signal), at: new Date(owner.now()).toISOString(), ...(safe ? { failure: error.evidence } : {}) };
      await owner.append(latest);
      if (!safe || reserved.generation || owner.state().launchRetries !== 1) throw error;
      continue;
    }
    await owner.append({ ...dispatched, kind: "returned", at: new Date(owner.now()).toISOString() });
    return result;
  }
}
