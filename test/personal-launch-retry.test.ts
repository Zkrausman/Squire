import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { PersonalMvpController } from "../src/personal/controller.js";
import { JsonRunStateStore } from "../src/personal/json-run-state.js";
import { SandboxPiPhaseRunner } from "../src/personal/pi-phase-runner.js";
import { CommandExecutionError, type CommandPort } from "../src/personal/command.js";
import { PhaseExecutionError } from "../src/personal/execution-failure.js";
import { DAYBREAK_VERIFICATION, LaunchFailure, classifyLaunchFailure, validateLaunchRetryPolicy } from "../src/personal/launch-retry.js";
import { sameEntryPath } from "../src/personal/entrypoint.js";
import { deriveRunEvents } from "../src/personal/run-events.js";
import { formatRunStatus } from "../src/personal/status.js";
import type { PersonalRunState, PhaseInput } from "../src/personal/types.js";
import { launchTestRoot, assertProtectedAcl } from "./helpers/windows-launch.js";
import { piJson } from "./helpers/pi-json.js";

const base = "a".repeat(40), candidate = "b".repeat(40);
const evidence = { version: 1, kind: "entitlement-verification", code: DAYBREAK_VERIFICATION, boundary: "before-model-events", resultObserved: false, processExited: true } as const;

test("closed classifier: only trusted, exited, pre-event allowlisted failures", () => {
  assert.equal(classifyLaunchFailure(new LaunchFailure(evidence)), "daybreak-verification");
  for (const malformed of [{ ...evidence, resultObserved: undefined }, { ...evidence, processExited: "true" }, { ...evidence, extra: true }]) {
    assert.equal(classifyLaunchFailure(new LaunchFailure(malformed as unknown as typeof evidence)), "not-allowlisted");
  }
  for (const error of [new Error(DAYBREAK_VERIFICATION), { evidence }, new PhaseExecutionError("authentication", DAYBREAK_VERIFICATION), new PhaseExecutionError("timeout", DAYBREAK_VERIFICATION), new LaunchFailure({ ...evidence, boundary: "ambiguous" }), new LaunchFailure({ ...evidence, resultObserved: true }), new LaunchFailure({ ...evidence, processExited: false }), ...["invalid_api_key", "moderation", "schema", "tool", "implementation", "unknown", "HTTP_503", " " + DAYBREAK_VERIFICATION].map(code => new LaunchFailure({ ...evidence, code }))]) assert.equal(classifyLaunchFailure(error), "not-allowlisted");
  assert.equal(classifyLaunchFailure(new LaunchFailure({ ...evidence, kind: "transport", code: "CONNECT_ECONNRESET" })), "transport-connect-reset");
  assert.equal(classifyLaunchFailure(new LaunchFailure({ ...evidence, kind: "service", code: "HTTP_503_PRE_SESSION" })), "service-unavailable");
  assert.deepEqual(validateLaunchRetryPolicy(undefined), { maxRetries: 1 });
  assert.deepEqual(validateLaunchRetryPolicy({ maxRetries: 0 }), { maxRetries: 0 });
  for (const value of [null, {}, { maxRetries: 2 }, { maxRetries: -1 }, { maxRetries: true }, { maxRetries: 1, delay: 0 }]) assert.throws(() => validateLaunchRetryPolicy(value));
});

test("entrypoint canonical Windows spelling cannot silently skip main", () => {
  assert.equal(sameEntryPath("C:\\Users\\Runner\\Squire\\cli.js", "c:\\users\\runner\\squire\\cli.js", "win32"), true);
  assert.equal(sameEntryPath("C:\\Squire\\cli.js", "D:\\Squire\\cli.js", "win32"), false);
  assert.equal(sameEntryPath("/repo/CLI.js", "/repo/cli.js", "linux"), false);
});

async function fixture(action: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, options: { maxRetries?: 0 | 1; failure?: "auth" | "partial" | "timeout" | "unknown" | "dirty" | "drift" | "twice" | "budget" | "cancel" | "backoff-dirty" } = {}) {
  const root = await launchTestRoot("squire-launch-retry-");
  try { await action(await setup(root, options)); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function setup(root: string, options: { maxRetries?: 0 | 1; failure?: string }) {
  const staging = path.join(root, "staging"), repository = path.join(root, "repo");
  await mkdir(repository);
  const states = new JsonRunStateStore(path.join(root, "state"));
  const calls: PhaseInput[] = [], staged: string[] = [], snapshots: PersonalRunState[] = [];
  let input: PhaseInput, head = base, dirty = false, review = 0, cleanup = 0, clockOffset = 0;
  const abort = new AbortController();
  const commands: CommandPort = { byteOutput: true, async run(request) {
    if (request.args[0] === "cp") {
      const file = request.args[1]!; staged.push(file);
      if (process.platform === "win32") assertProtectedAcl(file);
      input = JSON.parse(await readFile(file, "utf8"));
    }
    if (!request.args.includes("--print")) return { stdout: "", stdoutBytes: Buffer.alloc(0), stderr: "" };
    calls.push(structuredClone(input!));
    if (input!.phase === "review" && (++review === 1 || options.failure === "twice")) {
      if (options.failure === "budget") clockOffset = 59500;
      if (options.failure === "dirty") dirty = true;
      if (options.failure === "drift") head = "c".repeat(40);
      const stdout = options.failure === "partial" ? Buffer.from('{"type":"message_start"}\n') : Buffer.alloc(0);
      const message = options.failure === "auth" ? "Invalid API key" : options.failure === "unknown" ? "Unknown provider failure" : DAYBREAK_VERIFICATION;
      throw new CommandExecutionError(options.failure === "timeout" ? "timeout" : "unknown", "redacted", stdout.toString(), undefined, stdout, { code: 1, stderrBytes: Buffer.from(message + "\n"), exited: options.failure !== "timeout" });
    }
    if (input!.phase === "implement") head = candidate;
    const details = { plan: { steps: ["focused change"] }, implement: { changes: ["implemented"], projectWiki: { status: "not_required", reason: "fixture only" } }, review: { findings: [] }, test: { commands: [{ command: "npm test", exitCode: 0, summary: "passed" }] }, retro: { lessons: ["no replay"], followUps: [] } }[input!.phase];
    const bytes = piJson(JSON.stringify({ outputHead: head, status: "passed", summary: "passed", details }), input!.reportSession!.sessionId, input!.profile);
    return { stdout: bytes.toString(), stdoutBytes: bytes, stderr: "" };
  } };
  const runner = new SandboxPiPhaseRunner({ commands, stagingRoot: staging, testCommands: ["npm test"] });
  const release = states.release.bind(states);
  states.release = async (...args) => { cleanup++; return release(...args); };
  const save = states.save.bind(states);
  states.save = async state => {
    await save(state); snapshots.push(structuredClone(state));
    if (state.launchGenerations?.at(-1)?.generation === 2 && state.launchGenerations.at(-1)?.kind === "reserved") {
      if (options.failure === "cancel") abort.abort();
      if (options.failure === "backoff-dirty") dirty = true;
    }
  };
  const createController = () => new PersonalMvpController({ phaseTimeoutMs: 60000, monotonicNow: () => performance.now() + clockOffset, states, phases: runner, launchRetryPolicy: { maxRetries: options.maxRetries ?? 1 },
    tickets: { async get(id) { return { id, title: "transient launch", description: "untrusted data" }; } },
    workspaces: { async prepare(i) { return { sandbox: i.sandbox, baseSha: base, head: base }; }, async currentHead() { return head; }, async assertClean() { if (dirty) throw new Error("dirty workspace"); }, async committedProjectWikiPaths() { return []; }, async exportBundle(i) { return { path: path.join(root, "bundle"), sha256: "c".repeat(64), byteLength: 1, baseSha: base, head, branch: i.branch }; } },
    publication: { async publish(i) { assert.equal(i.head, candidate); return { url: "https://github.com/example/repo/pull/1", reused: false }; } },
  });
  const controller = createController();
  const request = { ticketId: "AIDEV-310", repository: "example/repo", repositoryPath: repository, sourceRef: "HEAD", baseBranch: "main" };
  return { root, staging, states, controller, createController, signal: abort.signal, request, calls, staged, snapshots, runner, cleanup: () => cleanup };
}

test("production JSON CAS + Pi boundary retry Review once, preserve Implement and independent gates, account both sessions", async () => fixture(async f => {
  const state = await f.controller.run(f.request, f.signal);
  assert.equal(state.status, "completed");
  assert.deepEqual(f.calls.map(i => i.phase), ["plan", "implement", "review", "review", "test", "retro"]);
  assert.deepEqual(state.attempts, { plan: 1, implement: 1, review: 1, test: 1, retro: 1 });
  const reviews = f.calls.filter(i => i.phase === "review");
  assert.equal(reviews[0]!.expectedHead, candidate);
  assert.equal(reviews[1]!.expectedHead, candidate);
  assert.deepEqual(reviews[0]!.previous.implement, reviews[1]!.previous.implement);
  const logical = (i: PhaseInput) => { const { launchGeneration, reportSession, telemetryAttribution, ...rest } = i; const { sessionId, sessionFile, ...data } = rest as typeof rest & { sessionId?: string; sessionFile?: string }; return data; };
  assert.deepEqual(logical(reviews[0]!), logical(reviews[1]!));
  assert.notEqual(reviews[0]!.reportSession!.sessionId, reviews[1]!.reportSession!.sessionId);
  const ledger = state.launchGenerations!.filter(g => g.phase === "review");
  assert.deepEqual(ledger.map(g => g.kind), ["reserved", "dispatched", "failed", "reserved", "dispatched", "returned"]);
  assert.equal(new Set(ledger.map(g => g.inputDigest)).size, 1);
  assert.equal(ledger[2]!.rule, "daybreak-verification");
  assert.ok(ledger[4]!.elapsedDelayMs >= 900);
  const backoff = f.snapshots.find(s => s.launchGenerations?.at(-1)?.generation === 2 && s.launchGenerations.at(-1)?.kind === "reserved")!;
  assert.match(formatRunStatus(backoff), /retrying \(backoff; no model work\)/);
  const events = deriveRunEvents(undefined, state);
  assert.equal(events.filter(e => e.type === "launch_failed" && e.phase === "review").length, 1);
  assert.ok(!JSON.stringify(events).includes(DAYBREAK_VERIFICATION));
  const summary = await f.runner.telemetry.read(state.runId);
  assert.ok(summary);
  assert.equal(summary.sessions.length, 6);
  assert.equal(summary.inventoryComplete, true);
  assert.equal(summary.sessions.filter(s => s.phase === "implement").length, 1);
  assert.deepEqual(summary.sessions.filter(s => s.phase === "review").map(s => s.trigger), ["initial", "retry"]);
  // No fabricated zero accounting for the failed transport: unknown remains unknown.
  assert.equal(summary.complete, false);
  // Five successful fixture sessions cost 0.1 each. Fresh-run recovery would
  // add two more paid sessions (Plan + Implement): 0.7 rather than 0.5 known
  // subtotal. The failed provider launch remains unknown, never priced at zero.
  assert.equal(summary.totals.recordedCost.known, "0.5");
  const retained = summary.sessions.filter(s => s.phase === "plan" || s.phase === "implement");
  assert.equal(retained.length, 2);
  assert.ok(retained.every(s => s.durationMs !== null && s.durationMs >= 0));
  assert.equal(summary.phases.find(p => p.phase === "implement")!.totals.sessions, 1);
  assert.equal(summary.phases.find(p => p.phase === "plan")!.totals.sessions, 1);
  assert.equal(f.cleanup(), 1);
  assert.equal(await f.states.reservationOwner(f.request.ticketId), undefined);
  for (const file of f.staged) await assert.rejects(readFile(file), /ENOENT/);
}));

for (const failure of ["auth", "partial", "timeout", "unknown", "dirty", "drift", "twice", "budget", "cancel", "backoff-dirty"] as const) test(`no unsafe/unbounded retry: ${failure}`, async () => fixture(async f => {
  await assert.rejects(f.controller.run(f.request, f.signal));
  assert.equal(f.calls.filter(i => i.phase === "review").length, failure === "twice" ? 2 : 1);
  assert.equal(f.calls.filter(i => i.phase === "implement").length, 1);
  assert.equal(f.cleanup(), 1);
  for (const file of f.staged) await assert.rejects(readFile(file), /ENOENT/);
}, { failure }));

test("zero policy disables even exact Daybreak retry", async () => fixture(async f => {
  await assert.rejects(f.controller.run(f.request, f.signal));
  assert.equal(f.calls.filter(i => i.phase === "review").length, 1);
}, { maxRetries: 0 }));

test("concurrent controllers cannot steal a run reservation or replay accepted work", async () => fixture(async f => {
  const results = await Promise.allSettled([f.controller.run(f.request, f.signal), f.createController().run(f.request)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(f.calls.filter(i => i.phase === "implement").length, 1);
  assert.equal(f.calls.filter(i => i.phase === "review").length, 2);
}));

test("immutable input collision preserves the existing file on every platform", async () => fixture(async f => {
  await f.controller.run(f.request, f.signal);
  const input = f.calls.find(i => i.phase === "review")!;
  const file = f.staged.find(p => p.endsWith(`review-1-${input.launchGeneration!.id}.json`))!;
  // Recreate through the native protected writer, not a Linux-shaped temp path.
  if (process.platform === "win32") {
    const { persistWindowsPhaseInput } = await import("../src/personal/windows-launch.js");
    persistWindowsPhaseInput(file, "immutable sentinel");
  } else await writeFile(file, "immutable sentinel", { flag: "wx", mode: 0o600 });
  await assert.rejects(f.runner.run(input));
  assert.equal(await readFile(file, "utf8"), "immutable sentinel");
}));

test("all orphaned crash boundaries fail closed and JSON CAS never redispatches", async () => fixture(async f => {
  await f.controller.run(f.request, f.signal);
  for (const kind of ["failed", "reserved", "dispatched", "returned"] as const) {
    const snapshot = f.snapshots.find(s => { const g = s.launchGenerations?.at(-1); return g?.phase === "review" && g.kind === kind && (kind === "failed" || g.generation === 2); })!;
    const crashRoot = path.join(f.root, `crash-${kind}`);
    const crashed = new JsonRunStateStore(crashRoot);
    await crashed.reserve(snapshot);
    let dispatches = 0;
    const restarted = new PersonalMvpController({ states: crashed,
      tickets: { async get() { throw new Error("must not refetch ticket"); } },
      workspaces: { async prepare() { throw new Error("must not prepare"); }, async currentHead() { throw new Error("must not inspect"); }, async assertClean() {}, async exportBundle() { throw new Error("must not publish"); } },
      phases: { async run() { dispatches++; throw new Error("must not dispatch"); } }, publication: { async publish() { throw new Error("must not publish"); } } });
    await assert.rejects(restarted.runReserved(f.request, snapshot.runId, "0".repeat(64)), /human authorization/);
    assert.equal(dispatches, 0);
    assert.deepEqual(await crashed.read(snapshot.runId), snapshot);
    assert.equal(await crashed.reservationOwner(f.request.ticketId), snapshot.runId);
    // A stale controller cannot roll back a later state or rewrite a failure.
    await assert.rejects(new JsonRunStateStore(f.states.directory).save({ ...snapshot, version: snapshot.version + 1 }));
  }
  const state = (await f.states.findByTicket(f.request.ticketId))[0]!;
  const altered = { ...state, version: state.version + 1, launchGenerations: [...state.launchGenerations!, { ...state.launchGenerations![0]!, id: randomUUID(), sessionId: randomUUID() }] };
  await assert.rejects(f.states.save(altered));
  assert.equal(f.calls.filter(i => i.phase === "review").length, 2);
}));

test("independent JSON stores CAS a reserved retry into exactly one dispatch", async () => fixture(async f => {
  await f.controller.run(f.request, f.signal);
  const reserved = f.snapshots.find(s => { const g = s.launchGenerations?.at(-1); return g?.phase === "review" && g.generation === 2 && g.kind === "reserved"; })!;
  const dispatched = f.snapshots.find(s => { const g = s.launchGenerations?.at(-1); return g?.phase === "review" && g.generation === 2 && g.kind === "dispatched"; })!;
  assert.equal(dispatched.version, reserved.version + 1);
  const directory = path.join(f.root, "dispatch-cas");
  const first = new JsonRunStateStore(directory), second = new JsonRunStateStore(directory);
  await first.reserve(reserved);
  let dispatches = 0;
  const dispatch = async (store: JsonRunStateStore) => { await store.save(dispatched); dispatches++; };
  const outcomes = await Promise.allSettled([dispatch(first), dispatch(second)]);
  assert.equal(outcomes.filter(o => o.status === "fulfilled").length, 1);
  assert.equal(dispatches, 1);
  await assert.rejects(dispatch(second));
  assert.equal(dispatches, 1);
  assert.deepEqual(await first.read(reserved.runId), dispatched);
  // Dispatched does not imply accepted Review or a promoted candidate.
  assert.equal(dispatched.results.review, undefined);
  assert.equal(dispatched.head, candidate);
  const terminal: PersonalRunState = { ...dispatched, version: dispatched.version + 1, status: "failed", lifecycle: "failed", endedAt: new Date().toISOString(), lastError: "ambiguous orphaned dispatch requires human authorization" };
  await first.save(terminal);
  await first.release(terminal.ticketId, terminal.runId);
  assert.equal(await second.reservationOwner(terminal.ticketId), undefined);
}));
