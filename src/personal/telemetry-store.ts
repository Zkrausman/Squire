import { currentLaunch } from "./launch-retry.js";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, link, unlink, readdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { windowsLaunch } from "./windows-launch.js";
import { createReportEvidence, verifyReportEvidence, type ReportEvidence } from "./report-evidence.js";
import { validatePhaseProfile, type PhaseProfile } from "./model-policy.js";
import { PERSONAL_PHASES, type PersonalPhase, type PersonalRunState, type PhaseInput } from "./types.js";
import { decimalText, decimalUnits, emptyUsage, MAX_STREAM_BYTES, parseUsageStream, TOKEN_FIELDS, type UsageAccounting } from "./telemetry-stream.js";

const MAX_JSON = 2 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
export function validateTelemetryRunId(v: string): void { if (!/^[a-z0-9][a-z0-9-]{7,127}$/u.test(v)) throw new Error("invalid telemetry run identity"); }
export interface TelemetryInvocation {
  /** Absent on historical v1 artifacts. Logical attempt is unchanged. */
  launchGeneration?: 1 | 2;
  runId: string; phase: PersonalPhase; subphase: "requirements" | "implementation-design" | null;
  attempt: number; correction: number; sessionId: string; sessionArtifactDigest: string;
  inputHead: string; profile: PhaseProfile; escalationDigest: string | null;
  trigger: "initial" | "retry" | "stage_advanced" | "remediation" | "report-correction";
  stageIndex: number | null; stageAttempt: number | null;
  startedAt: string;
}
interface End { endedAt: string | null; exited: boolean; streams: ReportEvidence[]; }
export interface TelemetrySession extends TelemetryInvocation {
  endedAt: string | null; durationMs: number | null;
  outcome: "passed" | "failed" | "remediation_required" | "report-rejected" | "execution-failed" | "interrupted" | "unknown";
  phaseOutcome: "passed" | "failed" | "remediation_required" | null;
  streamDigest: string | null; usage: UsageAccounting;
}
export interface TelemetryTotals {
  sessions: number; messages: number;
  tokens: Record<typeof TOKEN_FIELDS[number], { known: number; complete: boolean }>;
  recordedCost: { known: string; complete: boolean; source: "pi-recorded" };
  durationMs: { known: number; complete: boolean };
}
export interface RunTelemetry {
  schemaVersion: 1; authority: "pi-0.84.4-controller-json-v1";
  runId: string; outcome: "completed" | "failed" | "interrupted";
  startedAt: string | null; endedAt: string | null; wallDurationMs: number | null;
  stateVersion: number; inventoryComplete: boolean; sessions: TelemetrySession[];
  phases: { phase: PersonalPhase; totals: TelemetryTotals; subphases: { subphase: string; totals: TelemetryTotals }[] }[];
  phaseOutcomes: Record<PersonalPhase, "passed" | "failed" | "remediation_required" | "unknown" | "not_run">;
  totals: TelemetryTotals; complete: boolean;
}
function hash(bytes: string | Buffer) { return createHash("sha256").update(bytes).digest("hex"); }
function timestamp(v: unknown): v is string { return typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v)); }
function duration(start: string | null, end: string | null): number | null { return start && end && Date.parse(end) >= Date.parse(start) ? Date.parse(end) - Date.parse(start) : null; }
function assert(v: unknown): asserts v { if (!v) throw new Error("invalid telemetry artifact"); }
function exact(v: object, names: string[]) { assert(v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === names.sort().join()); }
function validateInvocation(v: TelemetryInvocation) {
  validateTelemetryRunId(v.runId);
  assert(v.launchGeneration === undefined || v.launchGeneration === 1 || v.launchGeneration === 2);
  assert(PERSONAL_PHASES.includes(v.phase) && (v.subphase === null || (v.phase === "plan" && ["requirements", "implementation-design"].includes(v.subphase))));
  assert(Number.isSafeInteger(v.attempt) && v.attempt > 0 && v.attempt <= 1_000_000 && Number.isSafeInteger(v.correction) && v.correction >= 0 && v.correction <= 10);
  assert(UUID.test(v.sessionId) && HASH.test(v.sessionArtifactDigest) && /^[a-f0-9]{40}$/u.test(v.inputHead));
  validatePhaseProfile(v.profile);
  assert(/^[a-z0-9][a-z0-9-]{0,63}$/u.test(v.profile.provider) && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(v.profile.model));
  assert(v.escalationDigest === null || HASH.test(v.escalationDigest));
  assert(["initial", "retry", "stage_advanced", "remediation", "report-correction"].includes(v.trigger) && timestamp(v.startedAt));
  assert((v.stageIndex === null && v.stageAttempt === null) || (Number.isSafeInteger(v.stageIndex) && v.stageIndex! >= 0 && v.stageIndex! < 100 && Number.isSafeInteger(v.stageAttempt) && v.stageAttempt! > 0 && v.stageAttempt! <= 1_000_000));
}
const INVOCATION_KEYS = ["runId", "phase", "subphase", "attempt", "correction", "sessionId", "sessionArtifactDigest", "inputHead", "profile", "escalationDigest", "trigger", "stageIndex", "stageAttempt", "startedAt"];
export function invocation(input: PhaseInput, sessionId: string, sessionFile: string, subphase: TelemetryInvocation["subphase"] = null, correction = 0): TelemetryInvocation {
  const value: TelemetryInvocation = { ...(input.launchGeneration ? { launchGeneration: input.launchGeneration } : {}), runId: input.runId, phase: input.phase, subphase, attempt: input.attempt, correction, sessionId,
    sessionArtifactDigest: hash(sessionFile), inputHead: input.expectedHead, profile: validatePhaseProfile(input.profile), escalationDigest: input.escalationDigest ?? null,
    trigger: correction ? "report-correction" : input.launchGeneration === 2 ? "retry" : input.telemetryAttribution?.trigger ?? (input.attempt > 1 ? "retry" : "initial"), stageIndex: input.telemetryAttribution?.stageIndex ?? null, stageAttempt: input.telemetryAttribution?.stageAttempt ?? null, startedAt: new Date().toISOString() };
  return value;
}

/** Same private boundary as launch material; no repository/sandbox file is read. */
async function secureDirectory(directory: string, create: boolean) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  assert(await realpath(directory) === directory);
  for (let cursor = directory; ; cursor = path.dirname(cursor)) {
    const s = await lstat(cursor);
    assert(s.isDirectory() && !s.isSymbolicLink());
    if (process.platform !== "win32") assert((s.uid === 0 || s.uid === process.getuid!()) && (!(s.mode & 0o022) || !!(s.mode & 0o1000)));
    if (cursor === directory && process.platform !== "win32") assert(s.uid === process.getuid!() && !(s.mode & 0o077));
    if (path.dirname(cursor) === cursor) break;
  }
}
async function readPrivate(file: string): Promise<unknown> {
  if (process.platform === "win32") {
    const text = windowsLaunch().read(file, ""); assert(Buffer.byteLength(text) <= MAX_JSON); return JSON.parse(text);
  }
  if (process.platform !== "linux") throw new Error("unsupported private telemetry platform");
  const root = path.dirname(file);
  await secureDirectory(root, false);
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const pinned = await directory.stat();
    const anchored = `/proc/self/fd/${directory.fd}/${path.basename(file)}`;
    const h = await open(anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = await h.stat(); assert(s.isFile() && s.nlink === 1 && s.size <= MAX_JSON && s.uid === process.getuid!() && !(s.mode & 0o077));
      const bytes = Buffer.alloc(s.size + 1); let used = 0;
      while (used < bytes.length) { const result = await h.read(bytes, used, bytes.length - used, used); if (!result.bytesRead) break; used += result.bytesRead; }
      assert(used === s.size);
      const after = await h.stat(); const named = await lstat(anchored); const parent = await lstat(root);
      assert(s.ino === named.ino && s.dev === named.dev && s.size === after.size && s.mtimeMs === after.mtimeMs && s.ctimeMs === after.ctimeMs && s.mode === after.mode && !named.isSymbolicLink());
      assert(pinned.ino === parent.ino && pinned.dev === parent.dev && !parent.isSymbolicLink() && await realpath(root) === root);
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)));
    } finally { await h.close(); }
  } finally { await directory.close(); }
}
async function publish(file: string, value: unknown) {
  const text = JSON.stringify(value); assert(Buffer.byteLength(text) <= MAX_JSON);
  try { const previous = await readPrivate(file); assert(isDeepStrictEqual(previous, value)); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(process.platform === "win32" && !await lstat(file).then(() => true, e => { if (e.code !== "ENOENT") throw e; return false; }))) throw error; }
  if (process.platform === "win32") { windowsLaunch().persist(file, "", text); return; }
  if (process.platform !== "linux") throw new Error("unsupported private telemetry platform");
  const root = path.dirname(file);
  await secureDirectory(root, true);
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const pinned = await directory.stat();
    const anchored = `/proc/self/fd/${directory.fd}`;
    const target = `${anchored}/${path.basename(file)}`;
    const temporary = `${target}.${randomUUID()}.tmp`;
    const h = await open(temporary, "wx", 0o600);
    try { await h.writeFile(text); await h.sync(); } finally { await h.close(); }
    try {
      const named = await lstat(root);
      assert(pinned.ino === named.ino && pinned.dev === named.dev && !named.isSymbolicLink() && await realpath(root) === root);
      try { await link(temporary, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; assert(isDeepStrictEqual(await readPrivate(file), value)); }
    } finally { await unlink(temporary); }
    await directory.sync();
  } finally { await directory.close(); }
}

/** Recover only a crash between exclusive link publication and removal of its
 * same-directory temporary name. Content/state/session evidence is untouched. */
async function recoverPublicationLinks(root: string): Promise<void> {
  if (process.platform !== "linux") return; // Native Windows publication is one rename.
  try { await secureDirectory(root, false); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const pinned = await directory.stat();
    const anchor = `/proc/self/fd/${directory.fd}`;
    const names = await readdir(anchor); assert(names.length <= 10_000);
    for (const name of names) {
      const match = /^(summary\.json|[a-f0-9-]{36}\.(?:start|end|outcome|phase-outcome)\.json)\.([a-f0-9-]{36})\.tmp$/u.exec(name);
      if (!match || !UUID.test(match[2]!)) continue;
      const temporary = await lstat(`${anchor}/${name}`);
      const target = await lstat(`${anchor}/${match[1]}`).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
      if (!target) continue; // Unpublished bytes cannot invent a completed ledger operation.
      assert(temporary.isFile() && target.isFile() && !temporary.isSymbolicLink() && !target.isSymbolicLink() && temporary.ino === target.ino && temporary.dev === target.dev && target.nlink === 2 && target.uid === process.getuid!() && !(target.mode & 0o077));
      const named = await lstat(root); assert(named.ino === pinned.ino && named.dev === pinned.dev && !named.isSymbolicLink() && await realpath(root) === root);
      await unlink(`${anchor}/${name}`);
    }
    await directory.sync();
  } finally { await directory.close(); }
}

export class TelemetryStore {
  readonly root: string;
  constructor(stagingRoot: string) { this.root = path.resolve(stagingRoot, "telemetry"); }
  directory(runId: string) { validateTelemetryRunId(runId); return path.join(this.root, runId); }
  async begin(value: TelemetryInvocation): Promise<void> { validateInvocation(value); await publish(path.join(this.directory(value.runId), `${value.sessionId}.start.json`), value); }
  async end(value: TelemetryInvocation, bytes: Buffer | undefined, exited: boolean): Promise<void> {
    const directory = this.directory(value.runId);
    const evidence = createReportEvidence(path.join(directory, "streams"));
    const streams: ReportEvidence[] = [];
    try {
      if (bytes && bytes.length <= MAX_STREAM_BYTES) for (let i = 0; i < bytes.length; i += MAX_JSON) {
        const chunk = bytes.subarray(i, i + MAX_JSON);
        const ref = await evidence.write(chunk);
        await verifyReportEvidence(evidence, ref, chunk);
        streams.push(ref);
      }
      await publish(path.join(directory, `${value.sessionId}.end.json`), { endedAt: exited ? new Date().toISOString() : null, exited, streams } satisfies End);
    } finally { await evidence.release?.(); }
  }
  async settle(runId: string, sessionId: string, outcome: TelemetrySession["outcome"]): Promise<void> {
    assert(UUID.test(sessionId));
    await publish(path.join(this.directory(runId), `${sessionId}.outcome.json`), { outcome });
  }
  async acceptPhase(runId: string, sessionId: string, outcome: NonNullable<TelemetrySession["phaseOutcome"]>): Promise<void> {
    assert(UUID.test(sessionId));
    await publish(path.join(this.directory(runId), `${sessionId}.phase-outcome.json`), { outcome });
  }
  /** Current-run only. Requires terminal state; repeat calls never rewrite evidence. */
  async finalize(state: PersonalRunState): Promise<RunTelemetry> {
    assert(state.status !== "running");
    await recoverPublicationLinks(this.directory(state.runId));
    const existing = await this.read(state.runId); if (existing) { assert(existing.stateVersion <= state.version && existing.outcome === state.status); return existing; }
    const directory = this.directory(state.runId);
    const names = await readdir(directory).catch(e => { if (e.code === "ENOENT") return []; throw e; });
    const starts = names.filter(n => /^[a-f0-9-]{36}\.start\.json$/u.test(n)).sort(); assert(starts.length <= 1000);
    const sessions: TelemetrySession[] = [];
    for (const name of starts) {
      const start = await readPrivate(path.join(directory, name)) as TelemetryInvocation; exact(start, [...INVOCATION_KEYS, ...(start.launchGeneration === undefined ? [] : ["launchGeneration"])]); validateInvocation(start); assert(start.runId === state.runId && name === `${start.sessionId}.start.json`);
      let end: End | undefined; let bytes: Buffer | undefined; let usage: UsageAccounting;
      const evidence = createReportEvidence(path.join(directory, "streams"));
      try {
        end = await readPrivate(path.join(directory, `${start.sessionId}.end.json`)) as End;
        exact(end, ["endedAt", "exited", "streams"]); assert((end.endedAt === null || timestamp(end.endedAt)) && typeof end.exited === "boolean" && Array.isArray(end.streams) && end.streams.length <= 32);
        bytes = Buffer.concat(await Promise.all(end.streams.map(ref => verifyReportEvidence(evidence, ref))));
        usage = parseUsageStream(bytes, start.sessionId, start.profile, end.exited);
      } catch { usage = emptyUsage("capture_failure"); end = undefined; }
      finally { await evidence.release?.(); }
      const results = [...Object.values(state.results), ...(state.stagedTransitions ?? []).flatMap(t => t.result ? [t.result] : [])];
      const result = results.find(r => r?.sessionId === start.sessionId);
      const child = results.flatMap(r => r?.phase === "plan" ? r.details.supervision?.children ?? [] : []).find(c => c.sessionId === start.sessionId);
      const correction = state.reportCorrections?.find(c => c.producer === start.sessionId && c.kind === "accepted");
      const settled = await readPrivate(path.join(directory, `${start.sessionId}.outcome.json`)).catch(() => undefined) as { outcome: TelemetrySession["outcome"] } | undefined;
      if (settled) exact(settled, ["outcome"]);
      const receipt = await readPrivate(path.join(directory, `${start.sessionId}.phase-outcome.json`)).catch(() => undefined) as { outcome: NonNullable<TelemetrySession["phaseOutcome"]> } | undefined;
      if (receipt) exact(receipt, ["outcome"]);
      const phaseOutcome = receipt?.outcome ?? result?.status ?? (child?.outcome === "passed" ? "passed" : child ? "failed" : correction ? "passed" : null);
      const outcome: TelemetrySession["outcome"] = settled?.outcome ?? phaseOutcome ?? (child?.outcome === "passed" ? "passed" : child ? "failed" : correction ? "passed" : !end ? "unknown" : end.exited ? "report-rejected" : state.status === "interrupted" ? "interrupted" : "execution-failed");
      if (duration(start.startedAt, end?.endedAt ?? null) === null) usage.diagnostics = [...new Set([...usage.diagnostics, "missing_endpoint" as const])];
      sessions.push({ ...start, endedAt: end?.endedAt ?? null, durationMs: duration(start.startedAt, end?.endedAt ?? null), outcome, phaseOutcome, streamDigest: bytes ? hash(bytes) : null, usage });
    }
    sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || PERSONAL_PHASES.indexOf(a.phase) - PERSONAL_PHASES.indexOf(b.phase) || a.attempt - b.attempt || a.correction - b.correction || a.sessionId.localeCompare(b.sessionId));
    // The state attempt ledger is independent of the capture ledger. Missing
    // launches cannot turn an empty/partial ledger into complete accounting.
    const inventoryComplete = PERSONAL_PHASES.every(phase => {
      for (let attempt = 1; attempt <= state.attempts[phase]; attempt++) {
        const rows = sessions.filter(s => s.phase === phase && s.attempt === attempt && !s.correction);
        if (phase === "plan" && state.planExecution === "supervised-v1") {
          if (rows.length !== 2 || !rows.some(s => s.subphase === "requirements") || !rows.some(s => s.subphase === "implementation-design")) return false;
        } else if (state.launches) {
          const expected = state.launches.filter(r => r.phase === phase && r.attempt === attempt && r.kind === "dispatched");
          const reserved = state.launches.filter(r => r.phase === phase && r.attempt === attempt && r.kind === "reserved");
          if (!expected.length || expected.length !== reserved.length || rows.length !== expected.length || !expected.every(r => rows.some(s => s.launchGeneration === r.generation && s.sessionId === r.sessionId && s.sessionArtifactDigest === hash(r.sessionFile) && s.inputHead === r.expectedHead))) return false;
        } else if (rows.length !== 1) return false;
      }
      return true;
    }) && sessions.every(s => s.attempt <= state.attempts[s.phase]) && (state.reportCorrections ?? []).filter(c => c.kind === "launched").every(c => sessions.some(s => s.sessionId === c.producer));
    const phaseOutcomes = Object.fromEntries(PERSONAL_PHASES.map(phase => {
      const attempt = state.attempts[phase];
      const result = state.results[phase];
      const launch = currentLaunch(state, phase, attempt);
      const receipt = phase === "plan" ? undefined : sessions.find(s => s.phase === phase && s.attempt === attempt && !s.correction && (!launch || s.sessionId === launch.sessionId))?.phaseOutcome;
      return [phase, attempt === 0 ? "not_run" : result?.attempt === attempt ? result.status : receipt ?? "unknown"];
    })) as RunTelemetry["phaseOutcomes"];
    const artifact = buildTelemetry({ phaseOutcomes, schemaVersion: 1, authority: "pi-0.84.4-controller-json-v1", runId: state.runId, outcome: state.status as RunTelemetry["outcome"], startedAt: state.startedAt ?? null, endedAt: state.endedAt ?? null, wallDurationMs: duration(state.startedAt ?? null, state.endedAt ?? null), stateVersion: state.version, inventoryComplete, sessions });
    validateRunTelemetry(artifact, state.runId);
    await publish(path.join(directory, "summary.json"), artifact); return artifact;
  }
  async read(runId: string): Promise<RunTelemetry | undefined> {
    const file = path.join(this.directory(runId), "summary.json");
    try { const value = await readPrivate(file); validateRunTelemetry(value, runId); return value; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (process.platform === "win32" && !await lstat(file).then(() => true, e => { if (e.code !== "ENOENT") throw e; return false; })) return undefined;
      throw new Error("Telemetry artifact unavailable: invalid or unsafe private evidence");
    }
  }
}

export function telemetryTotals(rows: readonly TelemetrySession[]): TelemetryTotals {
  const tokens = Object.fromEntries(TOKEN_FIELDS.map(f => {
    const known = rows.reduce((sum, s) => sum + (s.usage.tokens[f] ?? 0), 0); assert(Number.isSafeInteger(known));
    return [f, { known, complete: rows.every(s => s.usage.tokens[f] !== null) }];
  })) as TelemetryTotals["tokens"];
  const known = rows.reduce((sum, s) => sum + decimalUnits(s.usage.recordedCost ?? "0"), 0n);
  const ms = rows.reduce((sum, s) => sum + (s.durationMs ?? 0), 0); assert(Number.isSafeInteger(ms));
  return { sessions: rows.length, messages: rows.reduce((sum, s) => sum + s.usage.messages, 0), tokens,
    recordedCost: { known: decimalText(known), complete: rows.every(s => s.usage.recordedCost !== null), source: "pi-recorded" },
    durationMs: { known: ms, complete: rows.every(s => s.durationMs !== null) } };
}
type Base = Omit<RunTelemetry, "phases" | "totals" | "complete">;
export function buildTelemetry(base: Base): RunTelemetry {
  const total = (rows: readonly TelemetrySession[]) => {
    const t = telemetryTotals(rows);
    // An incomplete controller/launch inventory means even a sum of known
    // rows is only a subtotal. Never advertise dimension completeness then.
    if (!base.inventoryComplete) {
      for (const f of TOKEN_FIELDS) t.tokens[f].complete = false;
      t.recordedCost.complete = false; t.durationMs.complete = false;
    }
    return t;
  };
  const totals = total(base.sessions);
  return { ...base, phases: PERSONAL_PHASES.map(phase => ({ phase, totals: total(base.sessions.filter(s => s.phase === phase)), subphases: phase === "plan" ? ["requirements", "implementation-design"].map(subphase => ({ subphase, totals: total(base.sessions.filter(s => s.phase === phase && s.subphase === subphase)) })) : [] })), totals,
    complete: base.inventoryComplete && base.wallDurationMs !== null && base.sessions.length > 0 && totals.durationMs.complete && totals.recordedCost.complete && TOKEN_FIELDS.every(f => totals.tokens[f].complete) };
}
export function validateRunTelemetry(value: unknown, runId: string): asserts value is RunTelemetry {
  const v = value as RunTelemetry;
  exact(v, ["schemaVersion", "authority", "runId", "outcome", "startedAt", "endedAt", "wallDurationMs", "stateVersion", "inventoryComplete", "sessions", "phases", "phaseOutcomes", "totals", "complete"]);
  validateTelemetryRunId(runId); assert(v.runId === runId && v.schemaVersion === 1 && v.authority === "pi-0.84.4-controller-json-v1" && ["completed", "failed", "interrupted"].includes(v.outcome));
  assert((v.startedAt === null || timestamp(v.startedAt)) && (v.endedAt === null || timestamp(v.endedAt)) && v.wallDurationMs === duration(v.startedAt, v.endedAt));
  assert(Number.isSafeInteger(v.stateVersion) && v.stateVersion > 0 && typeof v.inventoryComplete === "boolean" && Array.isArray(v.sessions) && v.sessions.length <= 1000);
  exact(v.phaseOutcomes, [...PERSONAL_PHASES]);
  assert(PERSONAL_PHASES.every(p => ["passed", "failed", "remediation_required", "unknown", "not_run"].includes(v.phaseOutcomes[p])));
  const seen = new Set<string>();
  for (const s of v.sessions) {
    exact(s, [...INVOCATION_KEYS, ...(s.launchGeneration === undefined ? [] : ["launchGeneration"]), "endedAt", "durationMs", "outcome", "phaseOutcome", "streamDigest", "usage"]); validateInvocation(s);
    assert(s.runId === runId && !seen.has(s.sessionId)); seen.add(s.sessionId);
    assert((s.endedAt === null || timestamp(s.endedAt)) && s.durationMs === duration(s.startedAt, s.endedAt) && (s.streamDigest === null || HASH.test(s.streamDigest)));
    assert(s.phaseOutcome === null || ["passed", "failed", "remediation_required"].includes(s.phaseOutcome));
    assert(["passed", "failed", "remediation_required", "report-rejected", "execution-failed", "interrupted", "unknown"].includes(s.outcome));
    exact(s.usage, ["tokens", "recordedCost", "costSource", "messages", "diagnostics"]); exact(s.usage.tokens, [...TOKEN_FIELDS]);
    for (const f of TOKEN_FIELDS) assert(s.usage.tokens[f] === null || (Number.isSafeInteger(s.usage.tokens[f]) && s.usage.tokens[f]! >= 0 && s.usage.tokens[f]! <= 1_000_000_000_000));
    assert(s.usage.recordedCost === null || decimalText(decimalUnits(s.usage.recordedCost)) === s.usage.recordedCost);
    assert(s.usage.costSource === (s.usage.recordedCost === null ? "unknown" : "pi-recorded") && Number.isSafeInteger(s.usage.messages) && s.usage.messages >= 0 && s.usage.messages <= 200_000);
    if (s.usage.messages === 0 || s.streamDigest === null) assert(TOKEN_FIELDS.every(f => s.usage.tokens[f] === null) && s.usage.recordedCost === null);
    if (TOKEN_FIELDS.some(f => s.usage.tokens[f] !== null) || s.usage.recordedCost !== null) assert(["openai-codex", "openai", "anthropic"].includes(s.profile.provider));
    assert(Array.isArray(s.usage.diagnostics) && s.usage.diagnostics.length <= 10 && s.usage.diagnostics.every(d => ["missing_stream", "invalid_stream", "partial_stream", "duplicate_message", "identity_mismatch", "unsupported_provider", "invalid_usage", "missing_cost", "capture_failure", "missing_endpoint"].includes(d)));
  }
  const { phases: _p, totals: _t, complete: _c, ...base } = v;
  assert(isDeepStrictEqual(buildTelemetry(base), v));
}
export function formatTelemetry(v: RunTelemetry | undefined, runId: string): string {
  if (!v) return `${runId}: telemetry unavailable/incomplete (no terminal artifact)`;
  const amounts = (t: TelemetryTotals) => `sessions=${t.sessions} ms=${t.durationMs.known}${t.durationMs.complete ? "" : "+unknown"} ${TOKEN_FIELDS.map(f => `${f}=${t.tokens[f].known}${t.tokens[f].complete ? "" : "+unknown"}`).join(" ")} Pi-recorded USD=${t.recordedCost.known}${t.recordedCost.complete ? "" : "+unknown"}`;
  return [`${v.runId}: ${v.outcome}; accounting ${v.complete ? "complete" : "incomplete"}; wall-ms=${v.wallDurationMs ?? "unknown"}`,
    ...v.sessions.map(s => `${s.phase}/${s.subphase ?? "main"} #${s.attempt}${s.launchGeneration ? ` generation-${s.launchGeneration}` : ""}${s.correction ? ` correction-${s.correction}` : ""} ${s.sessionId} ${s.profile.provider}/${s.profile.model}/${s.profile.thinking} ${s.trigger} ${s.outcome} phase-outcome=${s.phaseOutcome ?? "unknown"} ${amounts(telemetryTotals([s]))}`),
    ...v.phases.flatMap(p => [`${p.phase} ${v.phaseOutcomes[p.phase]}: ${amounts(p.totals)}`, ...p.subphases.map(s => `  ${s.subphase}: ${amounts(s.totals)}`)]), `Run: ${amounts(v.totals)}`].join("\n");
}
