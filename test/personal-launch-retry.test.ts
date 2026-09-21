import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { PersonalMvpController } from "../src/personal/controller.js";
import { JsonRunStateStore, validateState } from "../src/personal/json-run-state.js";
import { SandboxPiPhaseRunner } from "../src/personal/pi-phase-runner.js";
import { NodeCommandRunner } from "../src/personal/command.js";
import { PhaseExecutionError } from "../src/personal/execution-failure.js";
import { classifyTransientLaunch, dispatchPhaseLaunch, generationSessionFile, TransientLaunchError, validateLaunchRetryPolicy, type LaunchContext, type LaunchTransition } from "../src/personal/launch-retry.js";
import { DAYBREAK_VERIFICATION, preSessionProcessFailure, providerLaunchFailure } from "../src/personal/provider-launch-failure.js";
import { createReportEvidence, verifyReportEvidence } from "../src/personal/report-evidence.js";
import { formatRunStatus, formatRunEvent } from "../src/personal/status.js";
import type { PersonalRunState, PhaseInput, PhaseResult, WorkspacePort } from "../src/personal/types.js";
import { launchTestRoot, assertProtectedAcl } from "./helpers/windows-launch.js";
import { piEvents, piJson, jsonLines, fixtureProfile, fixtureSession } from "./helpers/pi-json.js";

const BASE = "a".repeat(40), CANDIDATE = "b".repeat(40);
const effects = { modelOutput: false, toolActivity: false, resultConsumed: false, ambiguous: false } as const;
const transient = () => new TransientLaunchError("daybreak-verification", effects);
function errorStream(sessionId = fixtureSession, profile = fixtureProfile): Buffer {
  const events = piEvents("", sessionId, profile);
  const m = events[6].message;
  m.content = []; m.stopReason = "error"; m.errorMessage = DAYBREAK_VERIFICATION; delete m.responseId;
  m.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  events[5].message = { ...m, stopReason: "stop" };
  delete events[5].message.errorMessage;
  return jsonLines(events);
}
function request(root: string) { return { ticketId: "AIDEV-310", repository: "example/repo", repositoryPath: root, sourceRef: "HEAD", baseBranch: "main" }; }
function workspace(head = BASE): WorkspacePort {
  return { async prepare({ sandbox }) { return { sandbox, head, baseSha: head }; }, async currentHead() { return head; }, async assertClean() {}, async committedProjectWikiPaths() { return []; }, async exportBundle({ branch, baseSha, head }) { return { path: "/private/bundle", sha256: "c".repeat(64), byteLength: 1, branch, baseSha, head }; } };
}
function report(input: PhaseInput): PhaseResult {
  return { runId: input.runId, phase: "review", attempt: input.attempt, inputHead: input.expectedHead, outputHead: input.expectedHead, profile: input.profile, sessionId: input.reportSession!.sessionId, sessionFile: input.reportSession!.sessionFile, status: "passed", summary: "review passed", details: { findings: [] } };
}

test("closed policy and typed classifier never use arbitrary failure text", () => {
  assert.deepEqual(validateLaunchRetryPolicy(undefined), { maxRetries: 1, backoffMs: 1000 });
  for (const v of [{ maxRetries: 2, backoffMs: 0 }, { maxRetries: 1, backoffMs: -1 }, { maxRetries: 1, backoffMs: 5001 }, { maxRetries: 1, backoffMs: 0, unknown: true }, { maxRetries: 1 }]) assert.throws(() => validateLaunchRetryPolicy(v));
  assert.equal(classifyTransientLaunch(transient()), "daybreak-verification");
  for (const error of [new Error(DAYBREAK_VERIFICATION), undefined, { condition: "daybreak-verification", effects }, ...["cancelled", "timeout", "authentication", "infrastructure", "protocol", "unknown"].map(c => new PhaseExecutionError(c as any, DAYBREAK_VERIFICATION)), new TransientLaunchError("moderation" as any, effects), new TransientLaunchError("unknown" as any, effects)]) assert.equal(classifyTransientLaunch(error), null);
  for (const key of Object.keys(effects)) for (const value of [true, null, undefined]) assert.equal(classifyTransientLaunch(new TransientLaunchError("daybreak-verification", { ...effects, [key]: value })), null);
  assert.equal(preSessionProcessFailure("openai-codex", Buffer.alloc(0), Buffer.from(DAYBREAK_VERIFICATION), 1, false)?.condition, "daybreak-verification");
  for (const text of ["Invalid API key", "moderation", `prefix ${DAYBREAK_VERIFICATION}`, `${DAYBREAK_VERIFICATION} secret`, "HTTP 503"]) assert.equal(preSessionProcessFailure("openai-codex", Buffer.alloc(0), Buffer.from(text), 1, false), undefined);
  assert.equal(preSessionProcessFailure("openai-codex", Buffer.from("activity"), Buffer.from(DAYBREAK_VERIFICATION), 1, false), undefined);
  assert.equal(preSessionProcessFailure("openai-codex", Buffer.alloc(0), Buffer.from(DAYBREAK_VERIFICATION), 1, true), undefined);
});

test("pinned provider pre-result envelope rejects output, tools, identity mismatches and unknown events", () => {
  assert.equal(providerLaunchFailure(errorStream(), fixtureProfile, fixtureSession)?.condition, "daybreak-verification");
  for (const change of [
    (e: any[]) => { e[6].message.content = [{ type: "text", text: "acted" }]; },
    (e: any[]) => { e.splice(6, 0, { type: "tool_execution_start" }); },
    (e: any[]) => { e.splice(6, 0, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "acted" } }); },
    (e: any[]) => { e[6].message.usage.input = 1; },
    (e: any[]) => { e[6].message.errorMessage = "Invalid authentication"; },
    (e: any[]) => { e[0].id = randomUUID(); },
    (e: any[]) => { e.push({ type: "unknown" }); },
  ]) {
    const events = errorStream().toString().trim().split("\n").map(l => JSON.parse(l)); change(events);
    assert.equal(providerLaunchFailure(jsonLines(events), fixtureProfile, fixtureSession), undefined);
  }
  assert.equal(providerLaunchFailure(Buffer.from("malformed"), fixtureProfile, fixtureSession), undefined);
});

test("real process adapter only emits a typed entitlement failure for an explicitly bound Pi invocation", async () => {
  const commands = new NodeCommandRunner();
  const command = { command: process.execPath, args: ["-e", `process.stderr.write(${JSON.stringify(DAYBREAK_VERIFICATION)}); process.exit(1)`], redactDiagnostics: true };
  await assert.rejects(commands.run(command), e => classifyTransientLaunch(e) === null);
  await assert.rejects(commands.run({ ...command, phaseLaunchProvider: "openai-codex" }), e => classifyTransientLaunch(e) === "daybreak-verification");
});

for (const reconcile of [false, true]) test(`production JSON controller and Pi runner relaunch only Review, retain Implement HEAD and independent gates/accounting (reconcile=${reconcile})`, async () => {
  const root = await launchTestRoot("squire-retry-production-");
  const states = new JsonRunStateStore(path.join(root, "state"));
  let release!: () => void, notify!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const reserved = new Promise<void>(resolve => { notify = resolve; });
  const transition = states.transitionLaunch.bind(states);
  let paused = false;
  states.transitionLaunch = async state => {
    await transition(state);
    const t = state.launchTransitions!.at(-1)!;
    if (reconcile && !paused && t.phase === "review" && t.number === 1 && t.kind === "reserved") {
      paused = true; notify(); await barrier;
    }
  };
  let input: any, head = BASE, ticketCalls = 0, published = 0;
  const inputs: any[] = [], staging: string[] = [];
  const workspaces = { ...workspace(), async currentHead() { return head; } };
  const runner = new SandboxPiPhaseRunner({ stagingRoot: root, testCommands: ["npm test"], commands: { byteOutput: true, async run(command) {
    if (command.args[0] === "cp") {
      const file = command.args[1]!; staging.push(file);
      if (process.platform === "win32") assertProtectedAcl(file);
      input = JSON.parse(await readFile(file, "utf8"));
    }
    if (!command.args.includes("--print")) return { stdout: "", stderr: "", stdoutBytes: Buffer.alloc(0) };
    inputs.push(input);
    if (input.phase === "review" && input.launchGeneration.number === 0) {
      const bytes = errorStream(input.sessionId, input.profile);
      return { stdout: bytes.toString(), stdoutBytes: bytes, stderr: "" };
    }
    if (input.phase === "implement") head = CANDIDATE;
    const details = { plan: { steps: ["implement"] }, implement: { changes: ["implemented"], projectWiki: { status: "not_required", reason: "fixture" } }, review: { findings: [] }, test: { commands: [{ command: "npm test", exitCode: 0, summary: "passed" }] }, retro: { lessons: ["fixture"], followUps: [] } }[input.phase as string];
    const bytes = piJson(JSON.stringify({ outputHead: head, status: "passed", summary: "passed", details }), input.sessionId, input.profile);
    return { stdout: bytes.toString(), stdoutBytes: bytes, stderr: "" };
  } } });
  try {
    const warnings: unknown[] = [];
    const controller = new PersonalMvpController({ states, workspaces, phases: runner, controllerPid: process.pid, launchRetryPolicy: { maxRetries: 1, backoffMs: 0 }, tickets: { async get(id) { ticketCalls++; return { id, title: "retry", description: "private ticket" }; } }, publication: { async publish(p) { published++; assert.equal(p.head, CANDIDATE); assert.equal(p.phases.review.inputHead, CANDIDATE); assert.equal(p.phases.test.inputHead, CANDIDATE); return { url: "https://github.com/example/repo/pull/1", reused: false }; } }, onPersistenceError: e => warnings.push(e) });
    let state: PersonalRunState;
    if (reconcile) {
      const original = controller.run(request(root)).then(value => ({ value }), error => ({ error }));
      await reserved;
      const current = (await states.findByTicket("AIDEV-310"))[0]!;
      // A fresh controller object shares the already-proved reservation owner,
      // never fetches Linear/config/prompts or replays accepted phases.
      const recovered = new PersonalMvpController({ states, workspaces, phases: runner, controllerPid: process.pid, launchRetryPolicy: { maxRetries: 1, backoffMs: 0 }, tickets: { async get() { throw new Error("forbidden second ticket fetch"); } }, publication: { async publish(p) { published++; assert.equal(p.head, CANDIDATE); return { url: "https://github.com/example/repo/pull/1", reused: false }; } }, onPersistenceError: e => warnings.push(e) });
      state = await recovered.reconcileReservedLaunch(current.runId);
      release();
      assert.ok("error" in await original, "stale controller must lose before another dispatch");
      await assert.rejects(recovered.reconcileReservedLaunch(current.runId), /human authorization/);
    } else state = await controller.run(request(root));
    assert.equal(state.status, "completed"); assert.equal(state.head, CANDIDATE); assert.equal(ticketCalls, 1); assert.equal(published, 1);
    assert.deepEqual(inputs.map(i => i.phase), ["plan", "implement", "review", "review", "test", "retro"]);
    assert.deepEqual(state.attempts, { plan: 1, implement: 1, review: 1, test: 1, retro: 1 });
    const reviews = inputs.filter(i => i.phase === "review");
    for (const key of ["deadline", "runId", "ticket", "expectedHead", "profile", "previous", "previousCumulative", "sandbox", "systemPromptDigest"]) assert.deepEqual(reviews[0][key], reviews[1][key], key);
    assert.notEqual(reviews[0].sessionId, reviews[1].sessionId); assert.notEqual(reviews[0].sessionFile, reviews[1].sessionFile);
    const ledger = state.launchTransitions!.filter(t => t.phase === "review");
    assert.deepEqual(ledger.map(t => t.kind), ["reserved", "dispatched", "failed", "reserved", "dispatched", "returned"]);
    assert.equal(ledger[2]!.rule, "daybreak-verification");
    assert.equal(ledger[2]!.inputHead, CANDIDATE);
    assert.equal(new Set(ledger.map(t => t.inputDigest)).size, 1);
    assert.equal((await states.reservationOwner(state.ticketId)), undefined);
    for (const file of staging) await assert.rejects(readFile(file), /ENOENT/);
    assert.equal(new Set(staging).size, 6);
    const telemetry = await runner.telemetry.read(state.runId);
    assert.equal(telemetry!.sessions.length, 6); assert.equal(telemetry!.inventoryComplete, true);
    assert.equal(telemetry!.sessions.filter(s => s.trigger === "transient-retry").length, 1);
    assert.equal(telemetry!.sessions.filter(s => ["plan", "implement"].includes(s.phase)).length, 2, "no repeated expensive accepted phases");
    assert.equal(telemetry!.complete, false, "unknown failed-launch cost must not be fabricated");
    assert.equal(telemetry!.totals.recordedCost.known, "0.5", "only one Plan/Implement charge; replay would add another 0.2");
    assert.ok(warnings.some(e => String(e).includes("accounting incomplete")));
    const events = await states.readEvents(state.runId);
    assert.ok(events.some(e => e.type === "launch_reserved" && e.launch?.generation === 1));
    const display = events.map(formatRunEvent).join("");
    assert.match(display, /daybreak-verification/); assert.doesNotMatch(display, /private ticket|Unable to verify/);
  } finally { release(); await runner.reportEvidence.release?.(); await rm(root, { recursive: true, force: true }); }
});

async function setup(root: string) {
  const states = new JsonRunStateStore(path.join(root, "state"));
  const controller = new PersonalMvpController({ states, workspaces: workspace(), phases: {} as never, tickets: {} as never, publication: {} as never, controllerPid: process.pid, launchRetryPolicy: { maxRetries: 1, backoffMs: 0 } });
  const reserved = await controller.reserve(request(root));
  const state: PersonalRunState = { ...reserved, version: reserved.version + 1, step: "review", lifecycle: "running", preparationState: "ready", baseSha: CANDIDATE, head: CANDIDATE, attempts: { ...reserved.attempts, review: 1 } };
  await states.save(state);
  const input: PhaseInput = { deadline: performance.now() + 60_000, runId: state.runId, phase: "review", attempt: 1, expectedHead: CANDIDATE, originalTicketBaseSha: CANDIDATE, previousCumulative: [], previous: {}, feedback: [], profile: state.profiles!.review, ticket: { id: state.ticketId, title: "fixture", description: "PRIVATE" }, repository: state.repository, branch: state.branch, baseBranch: state.baseBranch, sandbox: state.sandbox };
  const evidence = createReportEvidence(path.join(root, "private-inputs"));
  const context = (snapshot: PersonalRunState, crash?: (t: LaunchTransition) => boolean): LaunchContext => {
    const c = { state: snapshot, async persist(changes: Partial<PersonalRunState>) {
      const next = { ...c.state, ...changes, version: c.state.version + 1 };
      await states.transitionLaunch(next); c.state = next;
      if (crash?.(next.launchTransitions!.at(-1)!)) throw new Error("simulated crash after durable CAS");
    } }; return c;
  };
  return { states, input, evidence, context, state };
}

for (const crashState of ["failed", "reserved", "dispatched", "returned"] as const) test(`production CAS restart at retry ${crashState} is at most once`, async () => {
  const root = await launchTestRoot(`squire-retry-${crashState}-`);
  const f = await setup(root); let calls = 0;
  const run = async (input: PhaseInput) => { calls++; if (!input.launchGeneration!.number) throw transient(); return report(input); };
  try {
    const initial = f.context(f.state, t => t.kind === crashState && (crashState === "failed" ? t.number === 0 : t.number === 1));
    await assert.rejects(dispatchPhaseLaunch({ context: initial, input: f.input, evidence: f.evidence, workspaces: workspace(CANDIDATE), run }), /simulated crash/);
    const persisted = (await f.states.read(f.state.runId))!;
    const last = persisted.launchTransitions!.at(-1)!;
    assert.equal(last.kind, crashState);
    const original = JSON.parse((await verifyReportEvidence(f.evidence, last.inputEvidence!)).toString()) as PhaseInput;
    const before = calls;
    const attempts = await Promise.allSettled([1, 2].map(() => dispatchPhaseLaunch({ context: f.context(structuredClone(persisted)), input: original, evidence: f.evidence, workspaces: workspace(CANDIDATE), run, reconcile: true })));
    assert.equal(calls - before, crashState === "reserved" ? 1 : 0);
    assert.equal(attempts.filter(a => a.status === "fulfilled").length, crashState === "reserved" ? 1 : 0);
    const after = (await f.states.read(f.state.runId))!;
    assert.deepEqual(after.launchTransitions!.slice(0, persisted.launchTransitions!.length), persisted.launchTransitions);
    if (crashState === "reserved") assert.match(formatRunStatus(persisted), /retrying \(waiting\/reserved\)/);
    const rewrite = { ...after, version: after.version + 1, launchTransitions: after.launchTransitions!.map((t, i) => i === 0 ? { ...t, inputHead: BASE } : t) };
    await assert.rejects(f.states.save(rewrite));
  } finally { await f.evidence.release?.(); await rm(root, { recursive: true, force: true }); }
});

for (const reason of ["disabled", "unknown", "authentication", "moderation", "implementation", "malformed-result", "telemetry-warning", "linear-failure", "timeout", "effects", "dirty", "changed-head", "deadline", "second-failure"] as const) test(`no automatic replay for ${reason}`, async () => {
  const root = await launchTestRoot("squire-retry-negative-"); const f = await setup(root); let calls = 0;
  try {
    let state = f.state;
    if (reason === "disabled") { // Construct a separately reserved policy identity, never mutate a live policy.
      state = { ...state, launchRetryPolicy: { maxRetries: 0, backoffMs: 0 } };
    }
    let current = state;
    const context = { get state() { return current; }, async persist(changes: Partial<PersonalRunState>) { const next = { ...current, ...changes, version: current.version + 1 }; validateState(next); current = next; } };
    let clock = 1000;
    const ws = { ...workspace(CANDIDATE), async assertClean() { if (calls && reason === "dirty") throw new Error("dirty"); }, async currentHead() { return calls && reason === "changed-head" ? BASE : CANDIDATE; } };
    await assert.rejects(dispatchPhaseLaunch({ context, input: { ...f.input, deadline: 60000 }, workspaces: ws, now: () => clock, monotonicNow: () => 0, run: async input => {
      calls++;
      if (reason === "deadline") clock += 60000;
      if (["unknown", "moderation", "implementation", "malformed-result", "telemetry-warning", "linear-failure"].includes(reason)) throw new Error(reason);
      if (reason === "authentication" || reason === "timeout") throw new PhaseExecutionError(reason, DAYBREAK_VERIFICATION);
      if (reason === "effects") throw new TransientLaunchError("daybreak-verification", { ...effects, toolActivity: null });
      if (input.launchGeneration!.number && reason !== "second-failure") throw new Error("unexpected retry");
      throw transient();
    } }));
    assert.equal(calls, reason === "second-failure" ? 2 : 1);
  } finally { await f.evidence.release?.(); await rm(root, { recursive: true, force: true }); }
});

test("immutable generation input collision preserves original bytes, cleans only owned artifacts", async () => {
  const root = await launchTestRoot("squire-retry-collision-"); const f = await setup(root);
  let copied = 0, local: string | undefined;
  const id = randomUUID();
  const generation = { id, number: 1 as const, sessionId: randomUUID(), sessionFile: generationSessionFile("review", 1, 1, id) };
  const runner = new SandboxPiPhaseRunner({ stagingRoot: root, testCommands: ["npm test"], commands: { async run(r) { if (r.args[0] === "cp") { copied++; local = r.args[1]!; throw new Error("copy failed"); } return { stdout: "", stderr: "" }; } } });
  try {
    const input = { ...f.input, launchGeneration: generation, reportSession: { sessionId: generation.sessionId, sessionFile: generation.sessionFile } };
    await assert.rejects(runner.run(input), /copy failed/); assert.equal(copied, 1); await assert.rejects(readFile(local!), /ENOENT/);
    const file = path.join(root, f.state.runId, "phase-inputs", `review-1-${generation.id}.json`);
    if (process.platform === "win32") { const { persistWindowsPhaseInput } = await import("../src/personal/windows-launch.js"); persistWindowsPhaseInput(file, "original"); }
    else await writeFile(file, "original", { flag: "wx", mode: 0o600 });
    await assert.rejects(runner.run(input)); assert.equal(copied, 1); assert.equal(await readFile(file, "utf8"), "original");
    assert.deepEqual(await readdir(path.dirname(file)), [path.basename(file)]);
  } finally { await f.evidence.release?.(); await runner.reportEvidence.release?.(); await rm(root, { recursive: true, force: true }); }
});

test("deterministic backoff shares one deadline; cancellation and workspace changes during wait cannot dispatch", async () => {
  for (const variant of ["success", "cancel", "mutate", "expire", "late-return"]) {
    const root = await launchTestRoot("squire-retry-budget-"); const f = await setup(root);
    try {
      let clock = 1000, calls = 0, dirty = false;
      const waits: number[] = [], deadlines: number[] = [];
      let state = { ...f.state, launchRetryPolicy: { maxRetries: 1 as const, backoffMs: 5000 } };
      const abort = new AbortController();
      const context = { get state() { return state; }, async persist(changes: Partial<PersonalRunState>) { const next = { ...state, ...changes, version: state.version + 1 }; validateState(next); state = next as typeof state; } };
      const workspaces = { ...workspace(CANDIDATE), async assertClean() { if (dirty) throw new Error("dirty during backoff"); } };
      const operation = dispatchPhaseLaunch({ context, input: { ...f.input, deadline: 6000 }, workspaces, signal: abort.signal, now: () => clock, monotonicNow: () => 0,
        wait: async ms => { waits.push(ms); clock += ms; if (variant === "cancel") abort.abort(); if (variant === "mutate") dirty = true; if (variant === "expire") clock += 1000; },
        run: async input => { calls++; deadlines.push(input.deadline!); if (calls === 1) throw transient(); if (variant === "late-return") clock += 1000; return report(input); },
      });
      if (variant === "success") {
        await operation; assert.equal(state.launchTransitions!.at(-1)!.delayMs, 5000);
        assert.deepEqual(deadlines, [6000, 6000]);
      } else await assert.rejects(operation);
      assert.deepEqual(waits, [5000]);
      assert.equal(calls, ["success", "late-return"].includes(variant) ? 2 : 1);
    } finally { await f.evidence.release?.(); await rm(root, { recursive: true, force: true }); }
  }
});

test("owner-checked CAS rejects ordinary-save dispatch bypass, changed candidate and foreign process identity", async () => {
  const root = await launchTestRoot("squire-retry-fencing-"); const f = await setup(root);
  try {
    await assert.rejects(dispatchPhaseLaunch({ context: f.context(f.state, t => t.kind === "reserved"), input: f.input, evidence: f.evidence, workspaces: workspace(CANDIDATE), run: async () => { throw new Error("must not run"); } }), /simulated crash/);
    const current = (await f.states.read(f.state.runId))!;
    const t = current.launchTransitions!.at(-1)!;
    const dispatch: LaunchTransition = { ...t, kind: "dispatched", timestamp: Date.now(), delayMs: 0 };
    const next = { ...current, version: current.version + 1, launchTransitions: [...current.launchTransitions!, dispatch] };
    await assert.rejects(f.states.save(next), /owner-checked CAS/);
    await assert.rejects(f.states.transitionLaunch({ ...next, head: BASE }), /exact run\/candidate/);
    await assert.rejects(f.states.transitionLaunch({ ...next, controllerPid: process.pid + 1 }), /ownership/);
    const mismatch = { ...f.input, ticket: { ...f.input.ticket, description: "changed" } };
    await assert.rejects(dispatchPhaseLaunch({ context: f.context(current), input: mismatch, evidence: f.evidence, workspaces: workspace(CANDIDATE), run: async () => { throw new Error("must not run"); }, reconcile: true }), /exact original input/);
    assert.deepEqual(await f.states.read(f.state.runId), current);
  } finally { await f.evidence.release?.(); await rm(root, { recursive: true, force: true }); }
});
