import { deepFreeze } from "./prompt-policy.js";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { validateEvidenceRef, verifyReportEvidence, type ReportEvidence, type ReportEvidencePort } from "./report-evidence.js";
import { classifyExecutionFailure, PhaseExecutionError } from "./execution-failure.js";
import { canonical } from "./launch-material.js";
import { PERSONAL_PHASES, type PersonalRunState, type PhaseInput, type PhaseResult, type WorkspacePort } from "./types.js";

export interface LaunchRetryPolicy { readonly maxRetries: 0 | 1; readonly backoffMs: number; }
export function validateLaunchRetryPolicy(value: unknown): LaunchRetryPolicy {
  if (value === undefined) return Object.freeze({ maxRetries: 1, backoffMs: 1000 });
  const v = value as LaunchRetryPolicy;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== "backoffMs,maxRetries" || ![0, 1].includes(v.maxRetries) || !Number.isSafeInteger(v.backoffMs) || v.backoffMs < 0 || v.backoffMs > 5000) throw new Error("invalid launchRetryPolicy");
  return Object.freeze({ ...v });
}
export const LAUNCH_CLASSIFIER_VERSION = 1;
export const LAUNCH_CONDITIONS = ["daybreak-verification", "transport-unavailable", "service-unavailable"] as const;
export type LaunchCondition = typeof LAUNCH_CONDITIONS[number];
export interface LaunchEffects {
  readonly modelOutput: false | true | null;
  readonly toolActivity: false | true | null;
  readonly resultConsumed: false | true | null;
  readonly ambiguous: false | true | null;
}
/** Only a trusted process/provider adapter may construct this signal. Text alone is not retry authority. */
export class TransientLaunchError extends PhaseExecutionError {
  readonly effects: LaunchEffects;
  constructor(readonly condition: LaunchCondition, effects: LaunchEffects) {
    super("infrastructure", `phase launch failed: ${LAUNCH_CONDITIONS.includes(condition) ? condition : "unknown"}`);
    this.effects = Object.freeze({ ...effects });
  }
}
export function classifyTransientLaunch(error: unknown): LaunchCondition | null {
  if (!(error instanceof TransientLaunchError) || !LAUNCH_CONDITIONS.includes(error.condition)) return null;
  const e = error.effects;
  return Object.keys(e).sort().join() === "ambiguous,modelOutput,resultConsumed,toolActivity" && Object.values(e).every(v => v === false) ? error.condition : null;
}
export interface LaunchGeneration {
  /** Dispatch-only monotonic projection of the original durable expiry. */
  readonly deadline?: number;
  readonly id: string;
  readonly number: 0 | 1;
  readonly sessionId: string;
  readonly sessionFile: string;
}
export interface LaunchTransition extends Omit<LaunchGeneration, "deadline"> {
  readonly phase: PhaseInput["phase"];
  readonly attempt: number;
  readonly inputHead: string;
  readonly inputDigest: string;
  readonly inputEvidence: ReportEvidence | null;
  readonly errorCode: "cancelled" | "timeout" | "authentication" | "infrastructure" | "protocol" | "unknown" | null;
  readonly launchDigest: string | null;
  readonly expiresAt: number;
  readonly notBefore: number;
  readonly kind: "reserved" | "dispatched" | "failed" | "returned";
  readonly timestamp: number;
  readonly delayMs: number;
  readonly classifierVersion: 1;
  readonly rule: LaunchCondition | null;
}
export function phaseInputDigest(input: PhaseInput): string { return createHash("sha256").update(canonical(input)).digest("hex"); }
export function generationSessionFile(phase: PhaseInput["phase"], attempt: number, number: number, id: string): string {
  return number === 0 ? `/ticket/sessions/${phase}/${attempt}.jsonl` : `/ticket/sessions/${phase}/${attempt}-${id}.jsonl`;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const KEYS = "attempt,classifierVersion,delayMs,errorCode,expiresAt,id,inputDigest,inputEvidence,inputHead,kind,launchDigest,notBefore,number,phase,rule,sessionFile,sessionId,timestamp";
export function validateLaunchState(state: PersonalRunState): void {
  if (state.launchRetryPolicy === undefined && state.launchTransitions === undefined) return;
  if (!state.launchRetryPolicy || !Array.isArray(state.launchTransitions) || state.launchTransitions.length > 2000) throw new Error("incomplete launch retry state");
  const policy = validateLaunchRetryPolicy(state.launchRetryPolicy);
  const slots = new Map<string, LaunchTransition>();
  const ids = new Set<string>(), sessions = new Set<string>();
  for (const t of state.launchTransitions as readonly LaunchTransition[]) {
    if (!t || Object.keys(t).sort().join() !== KEYS || !PERSONAL_PHASES.includes(t.phase) || !Number.isSafeInteger(t.attempt) || t.attempt < 1 || t.attempt > state.attempts[t.phase] || !UUID.test(t.id) || !UUID.test(t.sessionId) || ![0, 1].includes(t.number) || t.number > policy.maxRetries || !/^[a-f0-9]{40}$/u.test(t.inputHead) || !HASH.test(t.inputDigest) || t.launchDigest !== (state.launchEvidence?.digest ?? null) || t.classifierVersion !== 1 || (t.rule !== null && !LAUNCH_CONDITIONS.includes(t.rule))) throw new Error("invalid launch transition identity");
    if (t.sessionFile !== generationSessionFile(t.phase, t.attempt, t.number, t.id) || !["reserved", "dispatched", "failed", "returned"].includes(t.kind) || ![t.expiresAt, t.notBefore, t.timestamp, t.delayMs].every(n => Number.isSafeInteger(n) && n >= 0) || t.delayMs > 14400000 || t.notBefore >= t.expiresAt) throw new Error("invalid launch transition timing");
    if (t.inputEvidence !== null) { validateEvidenceRef(t.inputEvidence); if (t.inputEvidence.sha256 !== t.inputDigest) throw new Error("launch input evidence digest mismatch"); }
    if (t.kind === "failed" ? !["cancelled", "timeout", "authentication", "infrastructure", "protocol", "unknown"].includes(t.errorCode!) : t.errorCode !== null) throw new Error("invalid launch error code");
    const slot = `${t.phase}/${t.attempt}`;
    const prior = slots.get(slot);
    if (t.kind === "reserved") {
      if (ids.has(t.id) || sessions.has(t.sessionId) || (t.number === 0 ? prior !== undefined : !prior || prior.kind !== "failed" || prior.number !== 0 || prior.rule === null || t.rule !== prior.rule || !isDeepStrictEqual(t.inputEvidence, prior.inputEvidence) || t.inputDigest !== prior.inputDigest || t.inputHead !== prior.inputHead || t.expiresAt !== prior.expiresAt || t.notBefore !== t.timestamp + policy.backoffMs)) throw new Error("invalid launch reservation");
      if (t.number === 0 && (t.rule !== null || t.notBefore !== t.timestamp || t.expiresAt - t.timestamp > 14400000)) throw new Error("invalid initial launch reservation");
      ids.add(t.id); sessions.add(t.sessionId);
    } else {
      if (!prior || prior.id !== t.id || (t.kind === "dispatched" ? prior.kind !== "reserved" : prior.kind !== "dispatched")) throw new Error("invalid launch transition order");
      const identity = (v: LaunchTransition) => { const { kind: _kind, rule: _rule, errorCode: _error, timestamp: _timestamp, delayMs: _delay, ...rest } = v; return rest; };
      if (!isDeepStrictEqual(identity(prior), identity(t)) || t.timestamp < prior.timestamp || (t.kind !== "failed" && t.rule !== prior.rule) || (t.kind === "dispatched" && (t.timestamp < t.notBefore || t.timestamp >= t.expiresAt))) throw new Error("rewritten launch identity");
    }
    slots.set(slot, t);
  }
}
export function assertLaunchAppendOnly(current: PersonalRunState, next: PersonalRunState): void {
  if (!isDeepStrictEqual(current.launchRetryPolicy, next.launchRetryPolicy) || !isDeepStrictEqual(current.launchTransitions, next.launchTransitions?.slice(0, current.launchTransitions?.length ?? 0))) throw new Error("launch history/policy cannot be rewritten");
  const added = (next.launchTransitions?.length ?? 0) - (current.launchTransitions?.length ?? 0);
  if (added < 0 || added > 1 || (added && current.status !== "running")) throw new Error("invalid launch ledger append");
}
export interface LaunchContext {
  readonly state: PersonalRunState;
  persist(changes: Partial<PersonalRunState>): Promise<void>;
}
export interface DispatchOptions {
  readonly context: LaunchContext;
  /** Legacy embedders without an owner-checked CAS may record, but not retry. */
  readonly allowRetry?: boolean;
  readonly evidence?: ReportEvidencePort;
  readonly input: PhaseInput;
  readonly workspaces: WorkspacePort;
  readonly run: (input: PhaseInput) => Promise<PhaseResult>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
  readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Reconciliation only: caller supplies the original captured private input, never a refreshed ticket. */
  readonly reconcile?: boolean;
}
/** Persist-before-dispatch. CAS losers throw before the adapter; never redispatch a paid/ambiguous generation. */
export async function dispatchPhaseLaunch(options: DispatchOptions): Promise<{ result: PhaseResult; input: PhaseInput }> {
  const { context, input, signal } = options;
  const now = options.now ?? Date.now, monotonic = options.monotonicNow ?? (() => performance.now());
  const wait = options.wait ?? (async (ms, signal) => { await delay(ms, undefined, signal ? { signal } : {}); });
  const policy = validateLaunchRetryPolicy(context.state.launchRetryPolicy);
  const digest = phaseInputDigest(input);
  if (context.state.status !== "running" || context.state.runId !== input.runId || context.state.sandbox !== input.sandbox || context.state.head !== input.expectedHead || context.state.attempts[input.phase] !== input.attempt || context.state.step !== input.phase) throw new Error("launch context identity mismatch");
  const append = async (t: LaunchTransition) => { await context.persist({ launchTransitions: [...context.state.launchTransitions ?? [], t] }); };
  const existing = context.state.launchTransitions?.filter(t => t.phase === input.phase && t.attempt === input.attempt);
  let current = existing?.at(-1);
  if (current) {
    if (!options.reconcile || current.kind !== "reserved" || current.inputDigest !== digest) throw new Error("launch reconciliation requires a reserved generation and exact original input; human authorization required");
    if (current.inputEvidence && options.evidence) await verifyReportEvidence(options.evidence, current.inputEvidence, canonical(input));
  } else {
    if (options.reconcile) throw new Error("no reserved launch to reconcile");
    const inputEvidence = options.evidence ? await options.evidence.write(canonical(input)) : null;
    if (inputEvidence) await verifyReportEvidence(options.evidence!, inputEvidence, canonical(input));
    const timestamp = now();
    const id = randomUUID();
    current = { id, number: 0, sessionId: input.reportSession?.sessionId ?? randomUUID(), sessionFile: generationSessionFile(input.phase, input.attempt, 0, id), phase: input.phase, attempt: input.attempt, inputHead: input.expectedHead, inputDigest: digest, inputEvidence, errorCode: null, launchDigest: context.state.launchEvidence?.digest ?? null, expiresAt: timestamp + Math.floor((input.deadline ?? monotonic()) - monotonic()), notBefore: timestamp, kind: "reserved", timestamp, delayMs: 0, classifierVersion: 1, rule: null };
    if (current.expiresAt <= timestamp) throw new PhaseExecutionError("timeout", "original phase deadline exhausted");
    await append(current);
  }
  for (;;) {
    signal?.throwIfAborted();
    if (current.number || options.reconcile) {
      await options.workspaces.assertClean(input.sandbox, signal);
      if (await options.workspaces.currentHead(input.sandbox, signal) !== input.expectedHead) throw new Error("launch workspace changed; human authorization required");
    }
    const waiting = Math.max(0, current.notBefore - now());
    if (now() + waiting >= current.expiresAt) throw new PhaseExecutionError("timeout", "original phase deadline exhausted");
    if (waiting) await wait(waiting, signal);
    if (waiting && (current.number || options.reconcile)) {
      await options.workspaces.assertClean(input.sandbox, signal);
      if (await options.workspaces.currentHead(input.sandbox, signal) !== input.expectedHead) throw new Error("launch workspace changed during backoff; human authorization required");
    }
    signal?.throwIfAborted();
    const timestamp = now();
    if (timestamp >= current.expiresAt) throw new PhaseExecutionError("timeout", "original phase deadline exhausted");
    current = { ...current, kind: "dispatched", timestamp, delayMs: timestamp - (existing?.find(t => t.id === current!.id && t.kind === "reserved")?.timestamp ?? current.timestamp) };
    await append(current);
    const dispatched: PhaseInput = deepFreeze({ ...structuredClone(input), launchGeneration: { id: current.id, number: current.number, sessionId: current.sessionId, sessionFile: current.sessionFile, ...(options.reconcile ? { deadline: monotonic() + current.expiresAt - now() } : {}) }, reportSession: { sessionId: current.sessionId, sessionFile: current.sessionFile }, ...(current.number ? { telemetryAttribution: { ...input.telemetryAttribution!, trigger: "transient-retry", stageIndex: input.telemetryAttribution?.stageIndex ?? null, stageAttempt: input.telemetryAttribution?.stageAttempt ?? null } } : {}) });
    let result: PhaseResult;
    try { result = await options.run(dispatched); }
    catch (error) {
      const rule = signal?.aborted ? null : classifyTransientLaunch(error);
      current = { ...current, kind: "failed", timestamp: now(), rule, errorCode: classifyExecutionFailure(error, signal) };
      await append(current);
      if (options.allowRetry === false || !rule || current.number >= policy.maxRetries || now() + policy.backoffMs >= current.expiresAt) throw error;
      // Workspace inspection is independent of adapter-provided effect flags.
      await options.workspaces.assertClean(input.sandbox, signal);
      if (await options.workspaces.currentHead(input.sandbox, signal) !== input.expectedHead) throw new Error("failed launch changed HEAD; human authorization required");
      const id = randomUUID(), timestamp = now();
      current = { ...current, id, number: 1, sessionId: randomUUID(), sessionFile: generationSessionFile(input.phase, input.attempt, 1, id), kind: "reserved", timestamp, notBefore: timestamp + policy.backoffMs, delayMs: 0, errorCode: null };
      await append(current);
      continue;
    }
    await append({ ...current, kind: "returned", timestamp: now() });
    if (signal?.aborted || now() >= current.expiresAt) throw new PhaseExecutionError("timeout", "original phase deadline exhausted before result acceptance");
    return { result, input: dispatched };
  }
}
