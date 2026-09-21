import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { PersonalMvpController } from "../src/personal/controller.js";
import { JsonRunStateStore, validateState } from "../src/personal/json-run-state.js";
import { SandboxPiPhaseRunner } from "../src/personal/pi-phase-runner.js";
import { CommandExecutionError, ProcessLaunchError } from "../src/personal/command.js";
import { PhaseExecutionError } from "../src/personal/execution-failure.js";
import { classifyLaunchFailure, DAYBREAK_BLUE, generationIdentity, launchInputDigest, providerLaunchFailure, validateLaunchRetryPolicy, assertLaunchRetryUnchanged } from "../src/personal/launch-retry.js";
import type { LaunchRecord } from "../src/personal/launch-retry.js";
import type { PersonalRunState, PhaseInput, RunStatePort } from "../src/personal/types.js";
import { formatRunStatus } from "../src/personal/status.js";
import { synthesizeCurrentRunEvents } from "../src/personal/run-events.js";
import { launchTestRoot, assertProtectedAcl } from "./helpers/windows-launch.js";
import { persistWindowsPhaseInput } from "../src/personal/windows-launch.js";
import { fixtureProfile, fixtureSession, piEvents, jsonLines, piJson } from "./helpers/pi-json.js";
const base = "a".repeat(40), candidate = "b".repeat(40);
const request = { ticketId: "AIDEV-310", repository: "example/repo", repositoryPath: path.resolve("."), sourceRef: "HEAD", baseBranch: "main" };
function failedEvents(input: Pick<PhaseInput, "profile" | "launchGeneration">): any[] {
  const events = piEvents("", input.launchGeneration!.sessionId, input.profile);
  const message = events[6].message;
  delete message.responseId;
  message.content = []; message.stopReason = "error"; message.errorMessage = DAYBREAK_BLUE;
  message.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  events[5].message = structuredClone(message); // Pi emits the final error as start when no stream began.
  return events;
}
const identity = { profile: fixtureProfile, launchGeneration: generationIdentity("review", 1, 0, fixtureSession) };
test("closed typed provider classifier: exact Daybreak envelope, not raw diagnostics or model text", () => {
  assert.equal(classifyLaunchFailure(providerLaunchFailure(jsonLines(failedEvents(identity)), identity)), "codex-daybreak-verification");
  for (const error of [new Error(DAYBREAK_BLUE), ...["authentication", "protocol", "timeout", "infrastructure", "unknown"].map(c => new PhaseExecutionError(c as any, DAYBREAK_BLUE)), { rule: "codex-daybreak-verification", noEffects: true, noResult: true }]) assert.equal(classifyLaunchFailure(error), undefined);
  for (const change of [
    (e: any[]) => { e[6].message.errorMessage = "Invalid authentication"; },
    (e: any[]) => { e[6].message.errorMessage = "moderation blocked"; },
    (e: any[]) => { e[6].message.content = [{ type: "text", text: DAYBREAK_BLUE }]; },
    (e: any[]) => { e[6].message.content = [{ type: "toolCall", name: "bash" }]; },
    (e: any[]) => { e[6].message.usage.input = 1; },
    (e: any[]) => { delete e[6].message.usage; },
    (e: any[]) => { e.splice(6, 0, { type: "tool_execution_start" }); },
    (e: any[]) => { e[0].id = "wrong"; },
    (e: any[]) => { e.pop(); },
  ]) { const events = failedEvents(identity); change(events); assert.equal(providerLaunchFailure(jsonLines(events), identity), undefined); }
  assert.equal(providerLaunchFailure(Buffer.from(DAYBREAK_BLUE), identity), undefined);
  assert.equal(providerLaunchFailure(piJson(DAYBREAK_BLUE), identity), undefined);
  assert.equal(providerLaunchFailure(jsonLines(failedEvents(identity)).subarray(0, -1), identity), undefined);
  assert.deepEqual(validateLaunchRetryPolicy(), { maxRetries: 1 });
  assert.deepEqual(validateLaunchRetryPolicy({ maxRetries: 0 }), { maxRetries: 0 });
  for (const invalid of [null, 0, { maxRetries: 2 }, { maxRetries: 1, delay: 0 }]) assert.throws(() => validateLaunchRetryPolicy(invalid));
});

type Fault = "retry" | "disabled" | "repeat" | "dirty" | "changed" | "auth" | "moderation" | "unknown" | "malformed" | "implementation" | "timeout" | "cancel" | "deadline" | "missing-accounting" | "spawn";
async function harness(fault: Fault = "retry", crash?: LaunchRecord["kind"]) {
  const root = await launchTestRoot("squire-launch-retry-");
  const states = new JsonRunStateStore(path.join(root, "state"));
  const calls: PhaseInput[] = [], snapshots: PersonalRunState[] = [], warnings: unknown[] = [];
  let clock = 1000;
  let document: PhaseInput, current = base, dirty = false, gets = 0, releases = 0, evidenceReleases = 0, crashed = false;
  const abort = new AbortController();
  const runner = new SandboxPiPhaseRunner({ stagingRoot: root, testCommands: ["npm test"], commands: { byteOutput: true, async run(spec) {
    if (spec.args[0] === "cp") document = JSON.parse(await readFile(spec.args[1]!, "utf8"));
    if (!spec.args.includes("--print")) return { stdout: "", stdoutBytes: Buffer.alloc(0), stderr: "" };
    calls.push(structuredClone(document));
    if (document.phase === "review" && (document.launchGeneration!.generation === 0 || fault === "repeat")) {
      if (fault === "dirty") dirty = true;
      if (fault === "changed") current = "c".repeat(40);
      if (fault === "spawn") throw new ProcessLaunchError("EAGAIN");
      if (fault === "unknown") throw new Error(DAYBREAK_BLUE);
      if (fault === "timeout") throw new CommandExecutionError("timeout", "ambiguous timeout", "", undefined, jsonLines(failedEvents(document)));
      if (fault === "implementation") throw new PhaseExecutionError("unknown", "implementation failed");
      if (fault === "malformed") { const b = piJson("not JSON", document.launchGeneration!.sessionId, document.profile); return { stdout: b.toString(), stdoutBytes: b, stderr: "" }; }
      const events = failedEvents(document);
      if (fault === "auth") events[6].message.errorMessage = "Invalid authentication";
      if (fault === "moderation") events[6].message.errorMessage = "Moderation blocked";
      const bytes = jsonLines(events);
      throw new CommandExecutionError("unknown", "sensitive command failed", bytes.toString(), undefined, bytes);
    }
    if (document.phase === "implement") current = candidate;
    const details = document.phase === "plan" ? { steps: ["implement"] } : document.phase === "implement" ? { changes: ["fixture"], projectWiki: { status: "not_required", reason: "fixture" } } : document.phase === "review" ? { findings: [] } : document.phase === "test" ? { commands: [{ command: "npm test", exitCode: 0, summary: "passed" }] } : { lessons: ["fixture"], followUps: [] };
    const bytes = piJson(JSON.stringify({ outputHead: current, status: "passed", summary: "passed", details }), document.launchGeneration!.sessionId, document.profile);
    return { stdout: bytes.toString(), stdoutBytes: bytes, stderr: "" };
  } } });
  if (fault === "missing-accounting") runner.telemetry.begin = async () => { throw new Error("capture unavailable"); };
  const releaseEvidence = runner.reportEvidence.release?.bind(runner.reportEvidence);
  runner.reportEvidence.release = async () => { evidenceReleases++; await releaseEvidence?.(); };
  const store: RunStatePort = {
    create: s => states.create(s), reserve: s => states.reserve(s), findActive: id => states.findActive(id), read: id => states.read(id), reservationOwner: id => states.reservationOwner(id),
    release: async (id, run) => { releases++; await states.release(id, run); },
    save: async s => {
      await states.save(s); snapshots.push(structuredClone(s));
      const record = s.launchGenerations?.at(-1);
      if (fault === "cancel" && record?.phase === "review" && record.kind === "failed") setTimeout(() => abort.abort(), 10);
      if (fault === "deadline" && record?.phase === "review" && record.kind === "failed") clock += 3600000;
      if (!crashed && crash && record?.phase === "review" && record.kind === crash) { crashed = true; throw new Error("simulated controller crash after durable boundary"); }
    },
  };
  const controller = () => new PersonalMvpController({ states: store, phases: runner, newId: () => "launchretryfixture", launchRetryPolicy: { maxRetries: fault === "disabled" ? 0 : 1 }, ...(fault === "deadline" ? { monotonicNow: () => clock } : {}), onPersistenceError: e => warnings.push(e),
    tickets: { async get(id) { gets++; return { id, title: "PRIVATE", description: "SECRET" }; } },
    workspaces: { async prepare() { return { sandbox: "fixture", baseSha: base, head: base }; }, async currentHead() { return current; }, async assertClean() { if (dirty) throw new Error("dirty workspace"); }, async committedProjectWikiPaths() { return []; }, async exportBundle(i) { return { ...i, path: path.join(root, "bundle"), byteLength: 1, sha256: "c".repeat(64) }; } },
    publication: { async publish(i) { assert.equal(i.head, candidate); assert.equal(i.phases.review.outputHead, candidate); assert.equal(i.phases.test.outputHead, candidate); return { url: "https://example.com/pr", reused: false }; } },
  });
  return { root, states, runner, calls, snapshots, warnings, controller, abort, counters: () => ({ gets, releases, evidenceReleases }), cleanup: async () => { await releaseEvidence?.(); await rm(root, { recursive: true, force: true }); } };
}

test("production Review relaunch preserves accepted candidates, JSON CAS, independent gates, telemetry and cleanup", async () => {
  const h = await harness();
  try {
    const state = await h.controller().run(request);
    assert.deepEqual(h.calls.map(i => i.phase), ["plan", "implement", "review", "review", "test", "retro"]);
    const [first, second] = h.calls.filter(i => i.phase === "review");
    assert.equal(first!.expectedHead, candidate); assert.equal(second!.expectedHead, candidate);
    const logical = (input: PhaseInput) => {
      const data = { ...input } as any;
      delete data.sessionId; delete data.sessionFile;
      return launchInputDigest(data);
    };
    assert.equal(logical(first!), logical(second!));
    assert.notEqual(first!.launchGeneration!.sessionId, second!.launchGeneration!.sessionId);
    assert.notEqual(first!.launchGeneration!.inputPath, second!.launchGeneration!.inputPath);
    assert.equal(first!.deadline, second!.deadline);
    assert.equal(state.attempts.review, 1); assert.equal(state.remediations.review, 0);
    assert.equal(state.results.implement!.outputHead, candidate);
    assert.deepEqual(state.launchGenerations!.filter(r => r.phase === "review").map(r => [r.generation, r.kind]), [[0, "reserved"], [0, "dispatched"], [0, "failed"], [0, "retrying"], [1, "reserved"], [1, "dispatched"], [1, "returned"]]);
    assert.ok(state.launchGenerations!.find(r => r.phase === "review" && r.generation === 1)!.delayMs >= 1000);
    assert.equal(h.counters().gets, 1); assert.equal(h.counters().releases, 1); assert.equal(h.counters().evidenceReleases, 5);
    assert.equal(await h.states.reservationOwner(request.ticketId), undefined);
    assert.deepEqual(await readdir(path.join(h.root, state.runId, "phase-inputs")), []);
    const backoff = h.snapshots.find(s => s.launchGenerations?.at(-1)?.kind === "retrying")!;
    assert.match(formatRunStatus(backoff), /retry_backoff/);
    assert.match(formatRunStatus(h.snapshots.find(s => s.launchGenerations?.at(-1)?.kind === "dispatched")!), /model_work/);
    const events = await h.states.readEvents(state.runId);
    const expected = synthesizeCurrentRunEvents(state).filter(e => e.type.startsWith("launch_"));
    assert.deepEqual(new Set(events.filter(e => e.type.startsWith("launch_")).map(e => e.eventId)), new Set(expected.map(e => e.eventId)));
    assert.doesNotMatch(JSON.stringify(events), /SECRET|PRIVATE|Daybreak|sensitive command/);
    const telemetry = (await h.runner.telemetry.read(state.runId))!;
    assert.equal(telemetry.inventoryComplete, true); assert.equal(telemetry.complete, true);
    const rows = telemetry.sessions.filter(s => s.phase === "review");
    assert.deepEqual(rows.map(s => [s.launchGeneration, s.outcome, s.usage.recordedCost]), [[0, "execution-failed", "0"], [1, "passed", "0.1"]]);
    assert.equal(telemetry.phases.find(p => p.phase === "plan")!.totals.sessions, 1);
    assert.equal(telemetry.phases.find(p => p.phase === "implement")!.totals.sessions, 1);
    assert.equal(telemetry.totals.recordedCost.known, "0.5"); // replay would add 0.2 for Plan/Implement alone
    assert.ok(telemetry.sessions.every(s => s.durationMs !== null));
    if (process.platform === "win32") await assertProtectedAcl(path.join(h.root, state.runId, "phase-inputs"));
    const shortened = { ...state, launchGenerations: state.launchGenerations!.slice(0, -1) };
    assert.throws(() => assertLaunchRetryUnchanged(state, shortened), /immutable/);
    const rewritten = structuredClone(state) as any; rewritten.launchGenerations[0].sessionId = fixtureSession;
    assert.throws(() => validateState(rewritten));
  } finally { await h.cleanup(); }
});

for (const fault of ["disabled", "repeat", "dirty", "changed", "auth", "moderation", "unknown", "malformed", "implementation", "timeout", "cancel", "deadline"] as const) test(`fail closed: ${fault}`, async () => {
  const h = await harness(fault);
  try {
    await assert.rejects(h.controller().run(request, h.abort.signal));
    const state = (await h.states.findByTicket(request.ticketId))[0]!;
    assert.equal(h.calls.filter(i => i.phase === "review").length, fault === "repeat" ? 2 : 1);
    assert.equal(h.calls.filter(i => i.phase === "implement").length, 1);
    assert.equal(h.calls.filter(i => i.phase === "plan").length, 1);
    assert.equal(state.results.implement?.outputHead, candidate);
    assert.equal(state.results.review, undefined);
    assert.equal(h.counters().gets, 1); assert.equal(h.counters().releases, 1);
  } finally { await h.cleanup(); }
});

for (const boundary of ["failed", "retrying", "reserved", "dispatched", "returned"] as const) test(`JSON crash boundary ${boundary} never duplicates a launch or reclaims reservation`, async () => {
  const h = await harness("retry", boundary);
  try {
    await assert.rejects(h.controller().run(request));
    const state = (await h.states.findByTicket(request.ticketId))[0]!;
    const count = h.calls.length;
    await assert.rejects(h.controller().run(request));
    await assert.rejects(h.controller().runReserved(request, state.runId, "f".repeat(64)));
    assert.equal(h.calls.length, count); assert.equal(h.counters().gets, 1);
    assert.equal(h.counters().releases, 0);
    assert.equal(await h.states.reservationOwner(request.ticketId), state.runId);
    assert.equal(state.status, "running");
  } finally { await h.cleanup(); }
});

test("independent controllers and production stores cannot dispatch duplicate retry", async () => {
  const h = await harness();
  try {
    const settled = await Promise.allSettled([h.controller().run(request), h.controller().run(request)]);
    assert.equal(settled.filter(s => s.status === "fulfilled").length, 1);
    assert.equal(h.calls.filter(i => i.phase === "review").length, 2);
    const state = (await h.states.findByTicket(request.ticketId))[0]!;
    const other = new JsonRunStateStore(path.join(h.root, "state"));
    const next = { ...state, version: state.version + 1 };
    const cas = await Promise.allSettled([h.states.save(next), other.save(next)]);
    assert.equal(cas.filter(s => s.status === "fulfilled").length, 1);
    assert.equal(h.counters().gets, 1); assert.equal(h.counters().releases, 1);
  } finally { await h.cleanup(); }
});

test("immutable generation input collision preserves existing bytes and performs no dispatch or cleanup of foreign file", async () => {
  const h = await harness();
  try {
    await h.controller().run(request);
    const input = h.calls.find(i => i.phase === "review" && i.launchGeneration?.generation === 1)!;
    const file = path.join(h.root, input.runId, "phase-inputs", path.posix.basename(input.launchGeneration!.inputPath));
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    if (process.platform === "win32") persistWindowsPhaseInput(file, "immutable collision");
    else await writeFile(file, "immutable collision", { flag: "wx", mode: 0o600 });
    const before = h.calls.length;
    await assert.rejects(h.runner.run(input));
    assert.equal(h.calls.length, before);
    assert.equal(await readFile(file, "utf8"), "immutable collision");
  } finally { await h.cleanup(); }
});


test("missing accounting stays additive after a recovered launch: no ticket refetch or workflow replay", async () => {
  const h = await harness("missing-accounting");
  try {
    const state = await h.controller().run(request);
    assert.equal(state.status, "completed");
    const summary = (await h.runner.telemetry.read(state.runId))!;
    assert.equal(summary.inventoryComplete, false);
    assert.equal(summary.complete, false);
    assert.equal(summary.totals.recordedCost.complete, false);
    assert.ok(h.warnings.some(e => String(e).includes("Run accounting incomplete")));
    assert.equal(h.counters().gets, 1);
    assert.deepEqual(h.calls.map(i => i.phase), ["plan", "implement", "review", "review", "test", "retro"]);
  } finally { await h.cleanup(); }
});


test("typed pre-spawn process failure retries only at the phase invocation boundary", async () => {
  const h = await harness("spawn");
  try {
    const state = await h.controller().run(request);
    assert.deepEqual(h.calls.map(i => i.phase), ["plan", "implement", "review", "review", "test", "retro"]);
    assert.equal(state.launchGenerations!.find(r => r.kind === "failed")!.rule, "process-spawn-unavailable");
    assert.equal(classifyLaunchFailure(new ProcessLaunchError("EAGAIN")), undefined);
    assert.equal(state.head, candidate);
    // No provider usage was emitted; accounting does not fabricate Pi billing.
    assert.equal((await h.runner.telemetry.read(state.runId))!.complete, false);
  } finally { await h.cleanup(); }
});


test("production JSON generation-one dispatch CAS has exactly one adapter winner", async () => {
  const h = await harness("retry", "retrying");
  try {
    await assert.rejects(h.controller().run(request));
    const prior = (await h.states.findByTicket(request.ticketId))[0]!;
    const identity = generationIdentity("review", 1, 1, randomUUID());
    const reserved: LaunchRecord = { ...prior.launchGenerations!.at(-1)!, ...identity, kind: "reserved", timestamp: new Date().toISOString(), delayMs: 1000, rule: null, errorCode: null };
    const state = { ...prior, version: prior.version + 1, launchGenerations: [...prior.launchGenerations!, reserved] };
    await h.states.save(state);
    const dispatched = { ...state, version: state.version + 1, launchGenerations: [...state.launchGenerations, { ...reserved, kind: "dispatched" as const }] };
    const other = new JsonRunStateStore(path.join(h.root, "state"));
    const input = { ...h.calls.find(i => i.phase === "review")!, launchGeneration: identity };
    const launch = async (store: JsonRunStateStore) => { await store.save(dispatched); return h.runner.run(input); };
    const results = await Promise.allSettled([launch(h.states), launch(other)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(h.calls.filter(i => i.phase === "review").length, 2);
    assert.equal((await h.states.read(state.runId))!.head, candidate);
    assert.equal(h.counters().releases, 0); // no terminal state was inferred
  } finally { await h.cleanup(); }
});
