import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { createReportEvidence, reportHash, validateEvidenceRef, verifyReportEvidence, MAX_REPORT_BYTES, type ReportEvidence, type ReportEvidencePort } from "./report-evidence.js";
import { emptyTokens, parsePiUsage, TELEMETRY_DIAGNOSTICS, type ParsedUsage, type TelemetryDiagnostic, type Tokens } from "./pi-telemetry-parser.js";
import { validatePhaseProfile, type PhaseProfile } from "./model-policy.js";
import { stagedSelection } from "./staged-attempts.js";
import { PERSONAL_PHASES, type PersonalPhase, type PersonalRunState, type PhaseInput } from "./types.js";

export const TELEMETRY_VERSION = 1;
export type SessionOutcome = "passed" | "failed" | "remediation_required" | "interrupted" | "invalid_report" | "returned" | "needs_clarification";
export type TelemetrySubphase = "requirements" | "implementation-design" | null;
export interface TelemetrySession extends ParsedUsage {
  runId: string; phase: PersonalPhase; subphase: TelemetrySubphase; attempt: number;
  sessionId: string; sessionFile: string | null; channelId: string; profile: PhaseProfile;
  remediation: boolean;
  kind: "phase" | "report-correction"; correctionAttempt: number | null;
  startedAt: string; endedAt: string | null; durationMs: number | null; outcome: SessionOutcome;
  streamSha256: string | null; streamBytes: number;
}
export interface AttributedSession extends TelemetrySession {
  stageIndex: number | null; stageAttempt: number | null; policyDigest: string | null;
}
export interface TelemetryTotals {
  sessions: number; durationMs: number; durationComplete: boolean;
  tokens: Tokens; tokensComplete: boolean;
  providerCost: null; costComplete: boolean;
}
export interface RunTelemetry {
  version: 1; authority: "controller-pi-json-v1"; runId: string; terminalVersion: number;
  outcome: "completed" | "failed" | "interrupted"; startedAt: string | null; endedAt: string;
  wallDurationMs: number | null; sessions: AttributedSession[];
  phases: { phase: PersonalPhase; attempts: number; outcome: "passed" | "failed" | "remediation_required" | "not_started" | "unreported"; totals: TelemetryTotals }[];
  planSubphases: { subphase: Exclude<TelemetrySubphase, null>; totals: TelemetryTotals }[];
  totals: TelemetryTotals; completeness: "complete" | "incomplete";
  diagnostics: TelemetryDiagnostic[];
}
export type TelemetryDisposition = { status: "available"; completeness: "complete" | "incomplete"; terminalVersion: number; artifact: ReportEvidence } | { status: "unavailable"; diagnostic: "publication_failed" };
export type TelemetryReadResult = { status: "available"; summary: RunTelemetry } | { status: "unavailable"; completeness: "incomplete"; diagnostic: "active_run" | "not_captured" | "publication_failed" | "invalid_artifact" };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const RUN = /^[a-z0-9][a-z0-9-]{7,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.sort().join()) throw new Error("invalid telemetry shape");
}
function timestamp(v: unknown): v is string { return typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v)); }
function number(v: unknown, max = Number.MAX_SAFE_INTEGER): v is number { return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max; }
function duration(start: string | null, end: string | null): number | null { return start && end && Date.parse(end) >= Date.parse(start) ? Date.parse(end) - Date.parse(start) : null; }
export function validateTelemetryDisposition(v: unknown): asserts v is TelemetryDisposition {
  const s = (v as TelemetryDisposition)?.status;
  if (s === "available") { exact(v, ["status", "completeness", "terminalVersion", "artifact"]); if (!["complete", "incomplete"].includes(v["completeness"] as string) || !number(v["terminalVersion"]) || !v["terminalVersion"]) throw new Error("invalid telemetry revision"); validateEvidenceRef(v["artifact"] as ReportEvidence); }
  else { exact(v, ["status", "diagnostic"]); if (s !== "unavailable" || v["diagnostic"] !== "publication_failed") throw new Error("invalid telemetry disposition"); }
}
const SESSION_KEYS = ["remediation", "runId", "phase", "subphase", "attempt", "sessionId", "sessionFile", "channelId", "profile", "kind", "correctionAttempt", "startedAt", "endedAt", "durationMs", "outcome", "streamSha256", "streamBytes", "piSessionId", "tokens", "providerCost", "records", "diagnostics"];
export function validateTelemetrySession(v: unknown, attributed = false): asserts v is TelemetrySession {
  exact(v, [...SESSION_KEYS, ...(attributed ? ["stageIndex", "stageAttempt", "policyDigest"] : [])]);
  const s = v as unknown as AttributedSession;
  if (!RUN.test(s.runId) || !PERSONAL_PHASES.includes(s.phase) || !number(s.attempt, 1_000_000) || !s.attempt || !UUID.test(s.sessionId) || !UUID.test(s.channelId) || (s.piSessionId !== null && !UUID.test(s.piSessionId))) throw new Error("invalid telemetry identity");
  validatePhaseProfile(s.profile);
  if (s.profile.provider.length > 256 || s.profile.model.length > 256) throw new Error("telemetry profile exceeds bound");
  if (![null, "requirements", "implementation-design"].includes(s.subphase) || (s.subphase !== null && s.phase !== "plan")) throw new Error("invalid telemetry subphase");
  if (s.kind === "phase") {
    if (s.correctionAttempt !== null || s.sessionFile !== `/ticket/sessions/${s.phase}/${s.attempt}${s.subphase ? `/${s.subphase}` : ""}.jsonl`) throw new Error("invalid telemetry session binding");
  } else if (s.kind !== "report-correction" || !number(s.correctionAttempt, 10) || !s.correctionAttempt || s.sessionFile !== null || s.subphase !== null) throw new Error("invalid correction binding");
  if (!timestamp(s.startedAt) || (s.endedAt !== null && !timestamp(s.endedAt)) || s.durationMs !== duration(s.startedAt, s.endedAt) || !["passed", "failed", "remediation_required", "interrupted", "invalid_report", "returned", "needs_clarification"].includes(s.outcome)) throw new Error("invalid telemetry lifecycle");
  if ((s.streamSha256 !== null && !HASH.test(s.streamSha256)) || !number(s.streamBytes, 64 * 1024 * 1024) || !number(s.records, 10_001) || s.providerCost !== null) throw new Error("invalid telemetry usage");
  if (!Array.isArray(s.diagnostics) || s.diagnostics.length > TELEMETRY_DIAGNOSTICS.length || new Set(s.diagnostics).size !== s.diagnostics.length || s.diagnostics.some(d => !TELEMETRY_DIAGNOSTICS.includes(d))) throw new Error("invalid telemetry diagnostics");
  if (s.tokens !== null) { exact(s.tokens, ["input", "output", "cacheRead", "cacheWrite"]); if (!Object.values(s.tokens).every(n => number(n, 1_000_000_000_000)) || s.diagnostics.some(d => !["cost_not_provider_reported", "invalid_duration"].includes(d)) || !s.piSessionId || !s.streamSha256 || !s.records) throw new Error("invalid telemetry tokens"); }
  if ((s.streamSha256 === null && s.streamBytes !== 0) || (s.endedAt === null && (s.streamSha256 !== null || s.streamBytes !== 0 || s.tokens !== null || s.records !== 0 || s.piSessionId !== null))) throw new Error("invalid open telemetry boundary");
  if (s.tokens === null && s.diagnostics.every(d => d === "cost_not_provider_reported" || d === "invalid_duration")) throw new Error("missing telemetry accounting diagnostic");
  if (typeof s.remediation !== "boolean") throw new Error("invalid remediation attribution");
  if (attributed && ((s.policyDigest !== null && !HASH.test(s.policyDigest)) || (s.stageIndex !== null && !number(s.stageIndex, 100)) || (s.stageAttempt !== null && (!number(s.stageAttempt, 1_000_000) || !s.stageAttempt)) || typeof s.remediation !== "boolean")) throw new Error("invalid telemetry attribution");
}
export function telemetryTotals(rows: readonly TelemetrySession[]): TelemetryTotals {
  const tokens = emptyTokens();
  for (const s of rows) for (const k of Object.keys(tokens) as (keyof Tokens)[]) { tokens[k] += s.tokens?.[k] ?? 0; if (!number(tokens[k])) throw new Error("telemetry total overflow"); }
  const durationMs = rows.reduce((n, s) => n + (s.durationMs ?? 0), 0);
  if (!number(durationMs)) throw new Error("telemetry duration overflow");
  return { sessions: rows.length, durationMs, durationComplete: rows.every(s => s.durationMs !== null), tokens, tokensComplete: rows.every(s => s.tokens !== null), providerCost: null, costComplete: rows.length === 0 };
}
function aggregate(rows: AttributedSession[], state: PersonalRunState) {
  return { phases: PERSONAL_PHASES.map(phase => ({ phase, attempts: state.attempts[phase], outcome: state.attempts[phase] === 0 ? "not_started" as const : state.results[phase]?.attempt === state.attempts[phase] ? state.results[phase]!.status : "unreported" as const, totals: telemetryTotals(rows.filter(s => s.phase === phase)) })), planSubphases: (["requirements", "implementation-design"] as const).map(subphase => ({ subphase, totals: telemetryTotals(rows.filter(s => s.subphase === subphase)) })), totals: telemetryTotals(rows) };
}
export function buildRunTelemetry(state: PersonalRunState, sessions: readonly TelemetrySession[], captureFailed = false): RunTelemetry {
  if (state.status === "running" || !timestamp(state.endedAt) || sessions.length > 1024) throw new Error("telemetry requires bounded terminal run");
  const diagnostics = new Set<TelemetryDiagnostic>(captureFailed ? ["capture_failed"] : []);
  const ids = new Set<string>();
  const piIds = new Set<string>();
  const rows = sessions.map(s => {
    validateTelemetrySession(s);
    if (s.runId !== state.runId || ids.has(s.channelId) || ids.has(s.sessionId)) throw new Error("telemetry launch mismatch");
    ids.add(s.channelId); ids.add(s.sessionId);
    if (s.piSessionId) { if (piIds.has(s.piSessionId)) diagnostics.add("ledger_mismatch"); piIds.add(s.piSessionId); }
    const slot = stagedSelection(state, s.phase, s.attempt);
    if (s.attempt > state.attempts[s.phase] || !isDeepStrictEqual(s.profile, slot?.profile ?? state.profiles?.[s.phase])) diagnostics.add("ledger_mismatch");
    const persisted = state.results[s.phase]?.attempt === s.attempt ? state.results[s.phase] : state.stagedTransitions?.find(t => t.phase === s.phase && t.attempt === s.attempt && t.kind === "closed")?.result;
    if (s.kind === "phase" && persisted) {
      if (s.subphase !== null && persisted.phase === "plan") {
        const child = persisted.details.supervision?.children.find(c => c.subphase === s.subphase);
        if (!child || child.sessionId !== s.sessionId || child.sessionFile !== s.sessionFile || !isDeepStrictEqual(child.profile, s.profile) || (child.outcome === "passed" ? !["passed", "needs_clarification"].includes(s.outcome) : !["failed", "interrupted", "invalid_report"].includes(s.outcome))) diagnostics.add("ledger_mismatch");
      } else {
        const corrected = s.outcome === "invalid_report" && (state.reportCorrections ?? []).some(r => r.phase === s.phase && r.attempt === s.attempt && r.kind === "accepted");
        if (persisted.sessionId !== s.sessionId || persisted.sessionFile !== s.sessionFile || (!corrected && persisted.status !== s.outcome)) diagnostics.add("ledger_mismatch");
      }
    }
    const outcome = s.kind === "report-correction" && s.outcome === "returned" ? ((state.reportCorrections ?? []).some(r => r.phase === s.phase && r.attempt === s.attempt && r.kind === "accepted" && r.used === s.correctionAttempt) ? "passed" as const : "failed" as const) : s.outcome;
    return { ...structuredClone(s), outcome, stageIndex: slot?.stageIndex ?? null, stageAttempt: slot?.stageAttempt ?? null, policyDigest: slot?.policyDigest ?? null };
  });
  for (const phase of PERSONAL_PHASES) {
    const primary = rows.filter(s => s.phase === phase && s.kind === "phase");
    if (phase === "plan" && state.planExecution === "supervised-v1") {
      const requirements = primary.filter(s => s.subphase === "requirements");
      if (requirements.length !== state.attempts.plan || new Set(requirements.map(s => s.attempt)).size !== requirements.length || primary.some(s => s.subphase === null) || new Set(primary.map(s => `${s.attempt}:${s.subphase}`)).size !== primary.length) diagnostics.add("missing_session");
      for (const result of [state.results.plan, ...(state.stagedTransitions ?? []).filter(t => t.phase === "plan" && t.kind === "closed").map(t => t.result)]) {
        if (result?.status === "passed" && !primary.some(s => s.attempt === result.attempt && s.subphase === "implementation-design")) diagnostics.add("missing_session");
      }
    } else if (primary.length !== state.attempts[phase] || new Set(primary.map(s => s.attempt)).size !== primary.length || primary.some(s => s.subphase !== null)) diagnostics.add("missing_session");
  }
  const expectedCorrections = (state.reportCorrections ?? []).filter(r => r.kind === "launched").length;
  if (rows.filter(s => s.kind === "report-correction").length !== expectedCorrections) diagnostics.add("ledger_mismatch");
  const totals = aggregate(rows, state);
  if (diagnostics.size) { for (const total of [totals.totals, ...totals.phases.map(p => p.totals), ...totals.planSubphases.map(p => p.totals)]) { total.tokensComplete = false; total.durationComplete = false; } }
  const wallDurationMs = duration(state.startedAt ?? null, state.endedAt);
  return { version: 1, authority: "controller-pi-json-v1", runId: state.runId, terminalVersion: state.version, outcome: state.status, startedAt: state.startedAt ?? null, endedAt: state.endedAt, wallDurationMs, sessions: rows, ...totals, completeness: diagnostics.size === 0 && totals.totals.tokensComplete && totals.totals.costComplete && totals.totals.durationComplete && wallDurationMs !== null ? "complete" : "incomplete", diagnostics: [...diagnostics] };
}
export function validateRunTelemetry(value: unknown, state: PersonalRunState): asserts value is RunTelemetry {
  exact(value, ["version", "authority", "runId", "terminalVersion", "outcome", "startedAt", "endedAt", "wallDurationMs", "sessions", "phases", "planSubphases", "totals", "completeness", "diagnostics"]);
  const v = value as unknown as RunTelemetry;
  if (v.version !== 1 || v.authority !== "controller-pi-json-v1" || v.runId !== state.runId || !number(v.terminalVersion) || v.terminalVersion > state.version || v.outcome !== state.status || v.endedAt !== state.endedAt || v.startedAt !== (state.startedAt ?? null) || !Array.isArray(v.sessions) || v.sessions.length > 1024) throw new Error("invalid telemetry terminal binding");
  v.sessions.forEach(s => validateTelemetrySession(s, true));
  const raw = v.sessions.map(({ stageIndex: _i, stageAttempt: _a, policyDigest: _p, ...s }) => s);
  const expected = buildRunTelemetry({ ...state, version: v.terminalVersion }, raw, v.diagnostics.includes("capture_failed"));
  if (!isDeepStrictEqual(v, expected)) throw new Error("telemetry reconciliation mismatch");
}

/** Append-only host evidence. Raw chunks never enter telemetry summaries or notifications. */
export class TelemetryLedger {
  readonly #evidence: ReportEvidencePort;
  readonly #rows: TelemetrySession[] = [];
  readonly #failed = new Set<string>();
  readonly #published = new Map<string, Promise<TelemetryDisposition>>();
  constructor(root: string) { this.#evidence = createReportEvidence(root); }
  async begin(input: PhaseInput, sessionId: string, subphase: TelemetrySubphase = null, correctionAttempt: number | null = null): Promise<TelemetrySession> {
    const row: TelemetrySession = { remediation: input.previousCumulative.some(r => (r.phase === "review" || r.phase === "test") && r.status === "remediation_required"), runId: input.runId, phase: input.phase, subphase, attempt: input.attempt, sessionId, sessionFile: correctionAttempt === null ? `/ticket/sessions/${input.phase}/${input.attempt}${subphase ? `/${subphase}` : ""}.jsonl` : null, channelId: randomUUID(), profile: structuredClone(input.profile), kind: correctionAttempt === null ? "phase" : "report-correction", correctionAttempt, startedAt: new Date().toISOString(), endedAt: null, durationMs: null, outcome: "interrupted", streamSha256: null, streamBytes: 0, ...parsePiUsage(undefined, input.profile) };
    this.#rows.push(row);
    await this.#persist({ version: 1, event: "launch", row }, row.runId);
    return row;
  }
  async finish(row: TelemetrySession, bytes: Buffer | undefined, outcome: SessionOutcome, endedAt = new Date().toISOString(), truncated = false): Promise<void> {
    const refs: ReportEvidence[] = [];
    let failed = false;
    if (bytes) try {
      for (let i = 0; i < bytes.length; i += MAX_REPORT_BYTES) {
        const chunk = bytes.subarray(i, i + MAX_REPORT_BYTES);
        const ref = await this.#evidence.write(chunk);
        await verifyReportEvidence(this.#evidence, ref, chunk);
        refs.push(ref);
      }
    } catch { failed = true; this.#failed.add(row.runId); }
    Object.assign(row, parsePiUsage(bytes, row.profile), { endedAt, durationMs: duration(row.startedAt, endedAt), outcome, streamSha256: bytes ? reportHash(bytes) : null, streamBytes: bytes?.length ?? 0 });
    if (truncated) { row.tokens = null; if (!row.diagnostics.includes("stream_limit")) row.diagnostics.push("stream_limit"); }
    if (failed) { row.tokens = null; row.diagnostics.push("capture_failed"); }
    if (row.durationMs === null) row.diagnostics.push("invalid_duration");
    if (this.#failed.has(row.runId) && !row.diagnostics.includes("capture_failed")) { row.tokens = null; row.diagnostics.push("capture_failed"); }
    await this.#persist({ version: 1, event: "closed", row, chunks: refs }, row.runId);
    await this.release();
    if (this.#failed.has(row.runId) && !row.diagnostics.includes("capture_failed")) { row.tokens = null; row.diagnostics.push("capture_failed"); }
  }
  async #persist(v: unknown, runId: string): Promise<void> {
    try { const bytes = Buffer.from(JSON.stringify(v)); const ref = await this.#evidence.write(bytes); await verifyReportEvidence(this.#evidence, ref, bytes); }
    catch { this.#failed.add(runId); }
  }
  markIncomplete(runId: string): void { this.#failed.add(runId); }
  /** Only trusted supervisor IPC may call this; never model phase result fields. */
  accept(row: unknown, input: PhaseInput): void {
    validateTelemetrySession(row);
    if (row.runId !== input.runId || row.attempt !== input.attempt || row.phase !== "plan" || row.subphase === null || !isDeepStrictEqual(row.profile, input.profile)) throw new Error("invalid supervisor telemetry binding");
    const prior = this.#rows.find(r => r.channelId === row.channelId || r.sessionId === row.sessionId);
    if (prior) {
      const identity = (r: TelemetrySession) => [r.runId, r.phase, r.subphase, r.attempt, r.sessionId, r.sessionFile, r.channelId, r.profile, r.kind, r.correctionAttempt, r.startedAt, r.remediation];
      if (prior.endedAt !== null || row.endedAt === null || !isDeepStrictEqual(identity(prior), identity(row))) throw new Error("duplicate or contradictory supervisor telemetry");
      Object.assign(prior, structuredClone(row));
    } else {
      if (row.endedAt !== null) throw new Error("supervisor telemetry launch missing");
      this.#rows.push(structuredClone(row));
    }
  }
  async release(): Promise<void> { try { await this.#evidence.release?.(); } catch { for (const row of this.#rows) this.#failed.add(row.runId); } }
  rows(): readonly TelemetrySession[] { return structuredClone(this.#rows); }
  async publish(state: PersonalRunState, directory: string): Promise<TelemetryDisposition> {
    if (state.telemetry) return state.telemetry;
    let summary: RunTelemetry;
    try { summary = buildRunTelemetry(state, this.#rows.filter(r => r.runId === state.runId), this.#failed.has(state.runId)); }
    catch { await this.release(); return { status: "unavailable", diagnostic: "publication_failed" }; }
    const key = reportHash(Buffer.from(JSON.stringify(summary)));
    const existing = this.#published.get(key);
    if (existing) return existing;
    const pending = (async (): Promise<TelemetryDisposition> => {
      try {
        return await publishRunTelemetry(summary, directory);
      } catch { return { status: "unavailable", diagnostic: "publication_failed" }; }
      finally { await this.release(); }
    })();
    this.#published.set(key, pending);
    return pending;
  }
}
/** Publication is an immutable, fsynced private object; state CAS is the atomic commit pointer. */
export async function publishRunTelemetry(summary: RunTelemetry, directory: string): Promise<TelemetryDisposition> {
  const store = createReportEvidence(path.join(path.resolve(directory), "telemetry"));
  try { const artifact = await store.write(JSON.stringify(summary)); await verifyReportEvidence(store, artifact); return { status: "available", completeness: summary.completeness, terminalVersion: summary.terminalVersion, artifact }; }
  finally { await store.release?.(); }
}
export async function readRunTelemetry(state: PersonalRunState, directory: string): Promise<TelemetryReadResult> {
  if (state.status === "running") return { status: "unavailable", completeness: "incomplete", diagnostic: "active_run" };
  if (!state.telemetry) return { status: "unavailable", completeness: "incomplete", diagnostic: "not_captured" };
  if (state.telemetry.status === "unavailable") return { status: "unavailable", completeness: "incomplete", diagnostic: "publication_failed" };
  let store: ReportEvidencePort | undefined;
  try {
    validateTelemetryDisposition(state.telemetry);
    store = createReportEvidence(path.join(path.resolve(directory), "telemetry"));
    const bytes = await verifyReportEvidence(store, state.telemetry.artifact);
    const summary: unknown = JSON.parse(bytes.toString("utf8"));
    validateRunTelemetry(summary, state);
    if (summary.terminalVersion !== state.telemetry.terminalVersion || summary.completeness !== state.telemetry.completeness) throw new Error("telemetry reference revision mismatch");
    return { status: "available", summary };
  } catch { return { status: "unavailable", completeness: "incomplete", diagnostic: "invalid_artifact" }; }
  finally { await store?.release?.(); }
}
export function formatRunTelemetry(result: TelemetryReadResult): string {
  if (result.status === "unavailable") return `Telemetry unavailable / incomplete (${result.diagnostic})\n`;
  const s = result.summary;
  const totals = (t: TelemetryTotals) => `${t.sessions} sessions; ${t.durationMs}ms${t.durationComplete ? "" : " (partial)"}; input=${t.tokens.input} output=${t.tokens.output} cache-read=${t.tokens.cacheRead} cache-write=${t.tokens.cacheWrite}${t.tokensComplete ? "" : " (partial)"}; provider cost=unknown`;
  return [`Telemetry ${s.runId}: ${s.outcome}; accounting ${s.completeness}`, ...s.sessions.map(r => `${r.phase}/${r.subphase ?? r.kind} #${r.attempt}${r.correctionAttempt ? ` correction ${r.correctionAttempt}` : ""} ${r.profile.provider}/${r.profile.model}/${r.profile.thinking} ${r.outcome} ${r.durationMs ?? "unknown"}ms tokens=${r.tokens ? JSON.stringify(r.tokens) : "unknown"} cost=unknown${r.diagnostics.length ? ` [${r.diagnostics.join(",")}]` : ""}`), ...s.planSubphases.map(p => `Plan ${p.subphase}: ${totals(p.totals)}`), ...s.phases.map(p => `${p.phase}: attempts=${p.attempts} ${p.outcome}; ${totals(p.totals)}`), `Total: ${totals(s.totals)}; run wall=${s.wallDurationMs ?? "unknown"}ms`, ""].join("\n");
}
