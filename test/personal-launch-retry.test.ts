import { captureLaunchMaterial } from "../src/personal/launch-material.js";
import { supervisePlan } from "../src/personal/plan-supervisor.js";
import { TEST_MATERIAL } from "./helpers/personal-launch.js";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { launchTestRoot } from "./helpers/windows-launch.js";
import { piJson } from "./helpers/pi-json.js";
import { NodeCommandRunner, type CommandPort } from "../src/personal/command.js";
import { PhaseExecutionError } from "../src/personal/execution-failure.js";
import { executeLaunch, LAUNCH_BACKOFF_MS, providerLaunchFailure, TransientLaunchError, validateLaunchRetries, type LaunchCoordinator, type LaunchTransition } from "../src/personal/launch-retry.js";
import { PersonalMvpController } from "../src/personal/controller.js";
import { JsonRunStateStore, validateState } from "../src/personal/json-run-state.js";
import { SandboxPiPhaseRunner } from "../src/personal/pi-phase-runner.js";
import { deterministicFeatureBranch } from "../src/personal/identity.js";
import { resolvePhaseProfiles, APPROVED_PERSONAL_MODEL_POLICY } from "../src/personal/model-policy.js";
import { decimalText, decimalUnits } from "../src/personal/telemetry-stream.js";
import { persistPhaseInput } from "../src/personal/phase-input.js";
import { synthesizeCurrentRunEvents } from "../src/personal/run-events.js";
import { formatRunEvent, formatRunStatus } from "../src/personal/status.js";
import type { PersonalRunState, PhaseInput, PhaseResult } from "../src/personal/types.js";

const DAYBREAK = "Unable to verify Daybreak Blue access. Please try again.";
const base = "a".repeat(40), head = "b".repeat(40);
const runId = "aidev-310-retryfixture";
const request = { ticketId: "AIDEV-310", repository: "example/repo", repositoryPath: process.cwd(), sourceRef: "HEAD", baseBranch: "main" };
const profile = resolvePhaseProfiles("example/repo", "AIDEV-310", APPROVED_PERSONAL_MODEL_POLICY).profiles.review;
function transient() { return providerLaunchFailure("openai-codex", Buffer.alloc(0), Buffer.from(DAYBREAK), 1, false, false)!; }
function initial(): PersonalRunState {
  return { schemaVersion: 1, version: 1, runId, ticketId: request.ticketId, ticketTitle: "private fixture", status: "running", step: "review", sandbox: `squire-${runId}`, repository: request.repository, baseBranch: "main", baseSha: base, head, branch: deterministicFeatureBranch(request.repository, request.ticketId), sessions: {}, attempts: { plan: 0, implement: 0, review: 1, test: 0, retro: 0 }, results: {}, remediations: { review: 0, test: 0 }, prUrl: null, lastError: null, updatedAt: new Date().toISOString(), launchRetries: 1, launchJournal: [] };
}
function input(): PhaseInput {
  const s = initial();
  return { runId, phase: "review", attempt: 1, ticket: { id: s.ticketId, title: "PRIVATE", description: "SECRET" }, repository: s.repository, baseBranch: "main", sandbox: s.sandbox, branch: s.branch, expectedHead: head, originalTicketBaseSha: base, previousCumulative: [], profile, previous: {}, feedback: [], deadline: performance.now() + 60000 };
}
function result(i: PhaseInput): PhaseResult {
  return { runId, phase: "review", attempt: 1, sessionId: i.reportSession!.sessionId, sessionFile: i.reportSession!.sessionFile, inputHead: head, outputHead: head, profile, status: "passed", summary: "review passed", details: { findings: [] } };
}

test("trusted adapter exact Daybreak rule; untyped, partial, killed, auth and moderation text fail closed", async () => {
  assert.equal(transient().evidence.rule, "daybreak-verification-v1");
  for (const text of ["toString", "__proto__", "constructor", "invalid API key", "authentication invalid", "moderation", "timeout", DAYBREAK + " secret", "prefix " + DAYBREAK, "{\"error\":\"" + DAYBREAK + "\"}"]) assert.equal(providerLaunchFailure("openai-codex", Buffer.alloc(0), Buffer.from(text), 1, false, false), undefined);
  for (const [stdout, exit, killed, aborted, provider] of [["partial", 1, false, false, "openai-codex"], ["", "ETIMEDOUT", false, false, "openai-codex"], ["", 1, true, false, "openai-codex"], ["", 1, false, true, "openai-codex"], ["", 0, false, false, "openai-codex"], ["", 1, false, false, "unknown"]] as const) assert.equal(providerLaunchFailure(provider, Buffer.from(stdout), Buffer.from(DAYBREAK), exit, killed, aborted), undefined);
  // Exercise the real execFile callback, not just a synthetic error constructor.
  await assert.rejects(new NodeCommandRunner().run({ command: process.execPath, args: ["-e", `process.stderr.write(${JSON.stringify(DAYBREAK)}); process.exitCode=1`], launchProvider: "openai-codex", redactDiagnostics: true }), e => e instanceof TransientLaunchError);
  await assert.rejects(new NodeCommandRunner().run({ command: process.execPath, args: ["-e", `process.stderr.write(${JSON.stringify(DAYBREAK)}); process.exitCode=1`], redactDiagnostics: true }), e => !(e instanceof TransientLaunchError) && !String(e).includes(DAYBREAK));
  assert.equal(validateLaunchRetries(undefined), 1); assert.equal(validateLaunchRetries(0), 0);
  for (const v of [-1, 2, "1", null, true, {}, 0.5]) assert.throws(() => validateLaunchRetries(v));
});

async function production(fault: "transient" | "twice" | "disabled" | "unknown" | "auth" | "moderation" | "malformed" | "implementation" | "dirty" | "head" | "inspection" | "test-failed") {
  const root = await launchTestRoot("squire-launch-retry-");
  let current = base, dirty = false, unavailable = false;
  const documents: (PhaseInput & { sessionId: string })[] = [];
  let document: PhaseInput & { sessionId: string };
  let reviews = 0;
  const commands: CommandPort = { byteOutput: true, async run(spec) {
    if (spec.args[0] === "cp") document = JSON.parse(await readFile(spec.args[1]!, "utf8"));
    if (!spec.args.includes("--print")) return { stdout: "", stdoutBytes: Buffer.alloc(0), stderr: "" };
    documents.push(structuredClone(document));
    if (document.phase === "review") {
      reviews++;
      if (reviews === 1 || fault === "twice") {
        if (fault === "unknown") throw new Error(DAYBREAK);
        if (fault === "auth") throw new PhaseExecutionError("authentication", "authentication invalid");
        if (fault === "moderation") throw new PhaseExecutionError("protocol", "moderation");
        if (fault === "dirty") dirty = true;
        if (fault === "head") current = "c".repeat(40);
        if (fault === "inspection") unavailable = true;
        if (!["malformed", "implementation"].includes(fault)) throw transient();
      }
    }
    if (document.phase === "implement") current = head;
    const details = document.phase === "plan" ? { steps: ["implement"] } : document.phase === "implement" ? { changes: ["change"], projectWiki: { status: "not_required", reason: "fixture" } } : document.phase === "review" ? { findings: [] } : document.phase === "test" ? { commands: [{ command: "test", exitCode: fault === "test-failed" ? 1 : 0, summary: "independent gate" }] } : { lessons: ["fixture"], followUps: [] };
    const payload = fault === "malformed" && document.phase === "review" ? "malformed" : JSON.stringify({ outputHead: current, status: (fault === "implementation" && document.phase === "review") || (fault === "test-failed" && document.phase === "test") ? "failed" : "passed", summary: "validated", details });
    const bytes = piJson(payload, document.sessionId, document.profile);
    return { stdout: bytes.toString(), stdoutBytes: bytes, stderr: "" };
  } };
  const states = new JsonRunStateStore(path.join(root, "state"));
  const runner = new SandboxPiPhaseRunner({ commands, stagingRoot: root, testCommands: [] });
  let published = 0;
  const controller = new PersonalMvpController({ states, phases: runner, newId: () => "retryfixture", launchRetries: fault === "disabled" ? 0 : 1,
    tickets: { async get(id) { return { id, title: "PRIVATE", description: "SECRET" }; } },
    workspaces: { async prepare() { return { sandbox: "fixture", baseSha: base, head: base }; }, async currentHead() { if (unavailable) throw new Error("unavailable"); return current; }, async assertClean() { if (dirty) throw new Error("dirty"); }, async committedProjectWikiPaths() { return []; }, async exportBundle(i) { return { ...i, path: "fixture", byteLength: 1, sha256: "c".repeat(64) }; } },
    publication: { async publish() { published++; return { url: "https://example.com/pr", reused: false }; } },
  });
  try {
    const execution = controller.run(request);
    if (fault === "transient") await execution; else await assert.rejects(execution);
    const state = (await states.read("aidev-310-retryfixtu"))!;
    assert.ok(state);
    const generations = state.launchJournal!.filter(t => t.phase === "review");
    assert.equal(documents.filter(i => i.phase === "plan").length, 1);
    assert.equal(documents.filter(i => i.phase === "implement").length, 1);
    const shouldRetry = ["transient", "twice", "test-failed"].includes(fault);
    assert.equal(reviews, shouldRetry ? 2 : 1);
    assert.equal(state.attempts.review, 1);
    assert.equal(state.results.implement!.outputHead, head);
    assert.equal(published, fault === "transient" ? 1 : 0);
    if (shouldRetry) {
      const launches = documents.filter(i => i.phase === "review");
      const a = launches[0]!, b = launches[1]!;
      for (const key of ["runId", "phase", "attempt", "expectedHead", "originalTicketBaseSha", "profile", "previous", "previousCumulative", "feedback", "sandbox", "deadline"] as const) assert.deepEqual(a[key], b[key]);
      assert.notEqual(a.sessionId, b.sessionId); assert.notEqual(a.reportSession!.sessionFile, b.reportSession!.sessionFile);
      assert.deepEqual(generations.map(t => t.kind), ["reserved", "dispatched", "failed", "reserved", "dispatched", fault === "twice" ? "failed" : "returned"]);
      assert.ok(generations[4]!.delayMs >= LAUNCH_BACKOFF_MS);
      assert.equal(generations[2]!.failure!.rule, "daybreak-verification-v1");
      const inputs = await readdir(path.join(root, state.runId, "phase-inputs"));
      assert.ok(inputs.includes("review-1-launch-0.json")); assert.ok(inputs.includes("review-1-launch-1.json"));
      const events = synthesizeCurrentRunEvents(state).map(formatRunEvent).join("");
      assert.match(events, /event=launch_reserved.*generation=1/); assert.doesNotMatch(events, /SECRET|PRIVATE|Daybreak|phase-inputs/);
      assert.equal(new Set(synthesizeCurrentRunEvents(state).map(e => e.eventId)).size, synthesizeCurrentRunEvents(state).length);
      const retrying = { ...state, launchJournal: state.launchJournal!.slice(0, state.launchJournal!.indexOf(generations[3]!) + 1), step: "review" as const };
      assert.match(formatRunStatus(retrying), /retrying-backoff/);
      const telemetry = (await runner.telemetry.read(state.runId))!;
      assert.ok(telemetry); assert.equal(telemetry.inventoryComplete, true);
      assert.equal(telemetry.sessions.filter(s => s.phase === "review").length, 2);
      assert.equal(telemetry.sessions.filter(s => s.trigger === "launch-retry").length, 1);
      const failed = telemetry.sessions.find(s => s.phase === "review" && s.launchGeneration === 0)!;
      assert.equal(failed.outcome, "execution-failed"); assert.ok(failed.endedAt); assert.ok(failed.durationMs !== null);
      // No invented usage for a failed launch; compare measured successful work
      // avoided by not replaying the accepted Plan and Implement sessions.
      assert.equal(failed.usage.messages, 0); assert.equal(telemetry.complete, false);
      const accepted = telemetry.sessions.filter(s => ["plan", "implement"].includes(s.phase));
      assert.equal(accepted.length, 2); assert.ok(accepted.every(s => s.durationMs !== null));
      const avoidedInput = accepted.reduce((n, s) => n + (s.usage.tokens.input ?? 0), 0);
      assert.equal(avoidedInput, 20);
      assert.equal(decimalText(accepted.reduce((n, s) => n + decimalUnits(s.usage.recordedCost!), 0n)), "0.2");
      const avoidedDuration = accepted.reduce((n, s) => n + s.durationMs!, 0);
      assert.ok(avoidedDuration >= 0); // Measured fixture time, not a fabricated incident estimate.
    }
  } finally { await runner.reportEvidence.release?.(); await rm(root, { recursive: true, force: true }); }
}
for (const fault of ["transient", "twice", "disabled", "unknown", "auth", "moderation", "malformed", "implementation", "dirty", "head", "inspection", "test-failed"] as const) test(`production JSON controller/runner ${fault}: no accepted phase replay`, () => production(fault));

async function coordinatorFixture() {
  const root = await launchTestRoot("squire-retry-cas-");
  const store = new JsonRunStateStore(path.join(root, "state"));
  let state = initial();
  await store.reserve(state);
  let now = Date.now();
  const owner: LaunchCoordinator = {
    state: () => state,
    async append(t) { const next = { ...state, version: state.version + 1, launchJournal: [...state.launchJournal!, t] }; await store.save(next); state = next; },
    async inspect() {}, now: () => now, async sleep(ms) { now += ms; },
  };
  return { root, store, owner, get state() { return state; }, set state(s: PersonalRunState) { state = s; }, advance(ms: number) { now += ms; }, async cleanup() { await rm(root, { recursive: true, force: true }); } };
}
for (const boundary of ["failed", "reserved", "dispatched", "returned"] as const) test(`production JSON CAS crash at ${boundary}: retry dispatch at most once`, async () => {
  const f = await coordinatorFixture(); const i = input();
  let dispatches = 0;
  const append = f.owner.append;
  let crashed = false;
  f.owner.append = async t => { await append(t); if (!crashed && t.kind === boundary && (boundary === "failed" || t.generation === 1)) { crashed = true; throw new Error("simulated controller loss"); } };
  const run = async (p: PhaseInput) => { dispatches++; if (!p.launchGeneration) throw transient(); return result(p); };
  try {
    await assert.rejects(executeLaunch(i, f.owner, run), /simulated controller loss/);
    f.state = (await new JsonRunStateStore(path.join(f.root, "state")).read(runId))!;
    f.owner.append = append;
    if (boundary === "failed" || boundary === "reserved") await executeLaunch(i, f.owner, run); else await assert.rejects(executeLaunch(i, f.owner, run), /ambiguous launch/);
    assert.equal(dispatches, boundary === "dispatched" ? 1 : 2);
    assert.equal(f.state.launchJournal!.filter(t => t.kind === "dispatched" && t.generation === 1).length, 1);
    validateState(f.state);
  } finally { await f.cleanup(); }
});

test("concurrent production JSON controllers cannot reserve or dispatch a generation twice", async () => {
  const f = await coordinatorFixture();
  try {
    const snapshot = f.state;
    const secondStore = new JsonRunStateStore(path.join(f.root, "state"));
    let secondState = snapshot, calls = 0;
    const second: LaunchCoordinator = { ...f.owner, state: () => secondState, async append(t) { const next = { ...secondState, version: secondState.version + 1, launchJournal: [...secondState.launchJournal!, t] }; await secondStore.save(next); secondState = next; } };
    const run = async (i: PhaseInput) => { calls++; return result(i); };
    const outcomes = await Promise.allSettled([executeLaunch(input(), f.owner, run), executeLaunch(input(), second, run)]);
    assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1); assert.equal(calls, 1);
    const winner = (await f.store.read(runId))!;
    const modified = { ...winner, version: winner.version + 1, launchJournal: winner.launchJournal!.slice(1) };
    await assert.rejects(f.store.save(modified), /launch/);
  } finally { await f.cleanup(); }
});

test("original budget, changed binding, and missing reservation prohibit successors", async () => {
  for (const fault of ["deadline", "binding", "owner"] as const) {
    const f = await coordinatorFixture(); const i = input(); const append = f.owner.append;
    try {
      f.owner.append = async t => { await append(t); if (t.kind === "failed") throw new Error("crash"); };
      await assert.rejects(executeLaunch(i, f.owner, async () => { throw transient(); }), /crash/);
      f.owner.append = append;
      if (fault === "deadline") f.advance(60001);
      if (fault === "owner") {
        // Do not steal ownership: removing proof makes state ambiguous and CAS
        // must reject without any process dispatch.
        const names = await readdir(path.join(f.root, "state", "locks"));
        const proof = names.find(n => n.endsWith(".owner"))!; assert.ok(proof);
        await rm(path.join(f.root, "state", "locks", proof));
      }
      let calls = 0;
      await assert.rejects(executeLaunch(fault === "binding" ? { ...i, feedback: ["changed"] } : i, f.owner, async p => { calls++; return result(p); }));
      assert.equal(calls, 0);
    } finally { await f.cleanup(); }
  }
});

test("native private generation input collisions are immutable and never cleaned by a losing runner", async () => {
  const root = await launchTestRoot("squire-retry-input-");
  const i = { ...input(), launchGeneration: 1 as const, reportSession: { sessionId: "12345678-1234-1234-1234-123456789abc", sessionFile: "/ticket/sessions/review/1-launch-1.jsonl" } };
  const file = path.join(root, runId, "phase-inputs", "review-1-launch-1.json");
  let copies = 0, launches = 0;
  const runner = new SandboxPiPhaseRunner({ stagingRoot: root, testCommands: [], commands: { byteOutput: true, async run(spec) { if (spec.args[0] === "cp") copies++; if (spec.args.includes("--print")) launches++; throw new Error("unexpected dispatch"); } } });
  try {
    await persistPhaseInput(file, "original immutable evidence");
    const before = createHash("sha256").update(await readFile(file)).digest("hex");
    await assert.rejects(runner.run(i)); await assert.rejects(runner.run(i));
    assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), before);
    assert.equal(copies, 0); assert.equal(launches, 0);
    assert.deepEqual(await readdir(path.dirname(file)), [path.basename(file)]);
  } finally { await runner.reportEvidence.release?.(); await rm(root, { recursive: true, force: true }); }
});

test("non-allowlisted typed failures, untyped exceptions, and ambiguous effects never retry", async () => {
  for (const error of [new Error(DAYBREAK), new PhaseExecutionError("timeout", DAYBREAK), new PhaseExecutionError("cancelled", DAYBREAK), new PhaseExecutionError("authentication", DAYBREAK), new PhaseExecutionError("protocol", DAYBREAK), new PhaseExecutionError("infrastructure", DAYBREAK)]) {
    const f = await coordinatorFixture(); let calls = 0;
    try { await assert.rejects(executeLaunch(input(), f.owner, async () => { calls++; throw error; })); assert.equal(calls, 1); assert.equal(f.state.launchJournal!.filter(t => t.kind === "reserved").length, 1); }
    finally { await f.cleanup(); }
  }
});

test("replacement dispatch CAS has one winner after a safely persisted failure", async () => {
  const f = await coordinatorFixture(); const i = input(); const append = f.owner.append;
  try {
    f.owner.append = async t => { await append(t); if (t.kind === "reserved" && t.generation === 1) throw new Error("crash after reservation"); };
    await assert.rejects(executeLaunch(i, f.owner, async () => { throw transient(); }), /crash after reservation/);
    f.owner.append = append;
    let otherState = structuredClone(f.state), calls = 0;
    const store = new JsonRunStateStore(path.join(f.root, "state"));
    const other: LaunchCoordinator = { ...f.owner, state: () => otherState, async append(t) { const next = { ...otherState, version: otherState.version + 1, launchJournal: [...otherState.launchJournal!, t] }; await store.save(next); otherState = next; } };
    const run = async (p: PhaseInput) => { calls++; return result(p); };
    const outcomes = await Promise.allSettled([executeLaunch(i, f.owner, run), executeLaunch(i, other, run)]);
    assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1); assert.equal(calls, 1);
    assert.equal((await store.read(runId))!.launchJournal!.filter(t => t.kind === "dispatched" && t.generation === 1).length, 1);
  } finally { await f.cleanup(); }
});

test("replacement uses detached original prompt data even if an adapter mutates its failed input", async () => {
  const f = await coordinatorFixture(); const i = { ...input(), feedback: ["original"] }; let calls = 0;
  try {
    await executeLaunch(i, f.owner, async p => {
      if (++calls === 1) { (p.feedback as string[])[0] = "changed"; (p.ticket as { description: string }).description = "changed"; throw transient(); }
      assert.deepEqual(p.feedback, ["original"]); assert.equal(p.ticket.description, "SECRET"); return result(p);
    });
    assert.deepEqual(i.feedback, ["original"]);
  } finally { await f.cleanup(); }
});

test("backoff consumes original deadline and cancellation cannot dispatch replacement", async () => {
  for (const cancelled of [false, true]) {
    const f = await coordinatorFixture(); let calls = 0; const abort = new AbortController();
    f.owner.sleep = async () => { if (cancelled) abort.abort(); else f.advance(60001); };
    try { await assert.rejects(executeLaunch(input(), f.owner, async () => { calls++; throw transient(); }, abort.signal)); assert.equal(calls, 1); assert.equal(f.state.launchJournal!.at(-1)!.kind, "reserved"); }
    finally { await f.cleanup(); }
  }
});

test("legacy input cleanup removes only the input this invocation created", async () => {
  const root = await launchTestRoot("squire-input-cleanup-");
  const directory = path.join(root, runId, "phase-inputs");
  const other = path.join(directory, "review-1-launch-1.json");
  const i = input(); let copies = 0;
  const runner = new SandboxPiPhaseRunner({ stagingRoot: root, testCommands: [], commands: { async run() { copies++; throw new Error("copy failed before dispatch"); } } });
  try {
    await persistPhaseInput(other, "other generation");
    await assert.rejects(runner.run(i), /copy failed/);
    assert.equal(copies, 1); assert.deepEqual(await readdir(directory), [path.basename(other)]);
    assert.equal(await readFile(other, "utf8"), "other generation");
  } finally { await runner.reportEvidence.release?.(); await rm(root, { recursive: true, force: true }); }
});

for (const failureAt of ["requirements", "implementation-design"] as const) test(`supervised Plan ${failureAt} launch failure: only an unacted Plan may retry`, async () => {
  const root = await launchTestRoot("squire-plan-launch-retry-");
  const config = { ...TEST_MATERIAL.config, repository: { ...TEST_MATERIAL.config.repository, path: process.cwd() }, dataDirectory: root, paths: { state: path.join(root, "state"), staging: root, bridges: path.join(root, "bridges") }, promptPolicy: { version: 1 as const, id: "default", plan: ["requirements", "implementation-design"] as const } };
  const raw = Buffer.from(JSON.stringify(config));
  const material = await captureLaunchMaterial({ config, rawConfig: raw.toString("base64"), digest: createHash("sha256").update(raw).digest("hex") });
  const copies = new Map<string, any>(); let document: any; let current = base; let failures = 0; let cleanupChecks = 0;
  const launched: { phase: string; generation: number }[] = [];
  const commands: CommandPort = { byteOutput: true, async run(spec) {
    const args = spec.args;
    if (args[0] === "cp") { const value = JSON.parse(await readFile(args[1]!, "utf8")); copies.set(args[2]!.split(":").slice(1).join(":"), value); if (value.phase) document = value; }
    if (args.at(-1)?.includes("rev-parse HEAD")) return { stdout: current, stderr: "" };
    if (args.at(-1)?.includes("/done")) cleanupChecks++;
    if (args.includes("node")) {
      const guard = copies.get(args.at(-1)!); const child = copies.get(guard.args.at(-1).match(/from (.+)\. Treat/)[1]);
      launched.push({ phase: child.subphase, generation: child.launchGeneration });
      if (child.subphase === failureAt && failures++ === 0) throw transient();
      const artifact = child.subphase === "requirements" ? { version: 1, inputHead: base, problem: "deliver", acceptanceCriteria: ["verified"], nonGoals: [], assumptions: [], dependencies: [], openQuestions: [], readiness: "ready" } : { version: 1, inputHead: base, requirementsDigest: child.requirements.digest, steps: ["implement"], affectedComponents: ["src"], tests: ["npm test"], risks: [], exactHeadEvidence: { head: base, observations: ["inspected"] }, projectWiki: { status: "not_required", reason: "fixture" } };
      const bytes = piJson(JSON.stringify(artifact), child.sessionId, child.profile); return { stdout: bytes.toString(), stdoutBytes: bytes, stderr: "" };
    }
    if (!args.includes("--print")) return { stdout: "", stdoutBytes: Buffer.alloc(0), stderr: "" };
    launched.push({ phase: document.phase, generation: document.launchGeneration });
    if (document.phase === "implement") current = head;
    const details = document.phase === "implement" ? { changes: ["fixture"], projectWiki: { status: "not_required", reason: "fixture" } } : document.phase === "review" ? { findings: [] } : document.phase === "test" ? { commands: [{ command: "test", exitCode: 0, summary: "pass" }] } : { lessons: ["fixture"], followUps: [] };
    const bytes = piJson(JSON.stringify({ outputHead: current, status: "passed", summary: "pass", details }), document.sessionId, document.profile);
    return { stdout: bytes.toString(), stdoutBytes: bytes, stderr: "" };
  } };
  const runner = new SandboxPiPhaseRunner({ commands, stagingRoot: root, testCommands: [] });
  const states = new JsonRunStateStore(config.paths.state);
  const controller = new PersonalMvpController({ launchMaterial: material, newId: () => "retryfixture", states,
    tickets: { async get(id) { return { id, title: "fixture", description: "fixture" }; } },
    phases: { reportEvidence: runner.reportEvidence, reportCapture: r => runner.reportCapture(r), telemetrySettled: r => runner.telemetrySettled(r), telemetryTerminal: s => runner.telemetryTerminal(s), async run(i, signal, progress) { return i.phase === "plan" ? supervisePlan(i, { stagingRoot: root, launchMaterial: material, testCommands: [] }, commands, signal!, progress!) : runner.run(i, signal); } },
    workspaces: { async prepare() { return { sandbox: "fixture", baseSha: base, head: base }; }, async currentHead() { return current; }, async assertClean() {}, async committedProjectWikiPaths() { return []; }, async exportBundle(i) { return { ...i, path: "fixture", byteLength: 1, sha256: "c".repeat(64) }; } }, publication: { async publish() { return { url: "https://example.com/pr", reused: false }; } },
  });
  try {
    const execution = controller.run(request);
    if (failureAt === "requirements") await execution; else await assert.rejects(execution);
    const state = (await states.read("aidev-310-retryfixtu"))!;
    const ledger = (await runner.telemetry.read(state.runId))!;
    if (failureAt === "requirements") {
      assert.deepEqual(launched.slice(0, 3), [{ phase: "requirements", generation: 0 }, { phase: "requirements", generation: 1 }, { phase: "implementation-design", generation: 1 }]);
      assert.equal(launched.length, 7); assert.equal(cleanupChecks, 3); assert.equal(state.attempts.plan, 1);
      assert.equal(ledger.sessions.filter(s => s.phase === "plan").length, 3); assert.equal(ledger.inventoryComplete, true);
      assert.equal(state.results.plan!.sessionFile, "/ticket/sessions/plan/1-launch-1.jsonl");
    } else {
      assert.equal(launched.length, 2); assert.ok(launched.every(p => p.generation === 0)); assert.equal(cleanupChecks, 2);
      assert.equal(state.attempts.implement, 0);
    }
  } finally { await runner.reportEvidence.release?.(); await rm(root, { recursive: true, force: true }); }
});
