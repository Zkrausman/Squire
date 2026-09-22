import { EventEmitter } from "node:events";
import { type FSWatcher, type watch as fsWatch } from "node:fs";
import { setImmediate as immediate } from "node:timers/promises";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deterministicFeatureBranch } from "../src/personal/identity.js";
import { JsonRunStateStore } from "../src/personal/json-run-state.js";
import { formatRunEvent } from "../src/personal/status.js";
import { deriveRunEvents, MAX_RUN_EVENT_COUNT, synthesizeCurrentRunEvents, validateRunEvent, type RunEvent } from "../src/personal/run-events.js";
import { RunEventConsumer, watchRun } from "../src/personal/run-watcher.js";
import { RunNotificationWorker } from "../src/personal/notification-worker.js";
import type { PlanPhaseResult, PersonalRunState } from "../src/personal/types.js";

const BASE = "a".repeat(40);
const RUN_ID = "aidev-1-0123456789";
const BRANCH = deterministicFeatureBranch("example/repo", "AIDEV-1");

function state(version = 1): PersonalRunState {
  return {
    schemaVersion: 1,
    version,
    runId: RUN_ID,
    ticketId: "AIDEV-1",
    ticketTitle: "secret title should not enter events",
    status: "running",
    step: "preparing",
    lifecycle: "preparing",
    launchState: "started",
    preparationState: "pending",
    executionMode: "foreground",
    startedAt: "2026-09-10T00:00:00.000Z",
    endedAt: null,
    controllerPid: process.pid,
    stdoutPath: "/secret/stdout.log",
    stderrPath: "/secret/stderr.log",
    repositoryPath: "/secret/repository",
    sourceRef: "HEAD",
    sandbox: `squire-${RUN_ID}`,
    repository: "example/repo",
    baseBranch: "main",
    baseSha: null,
    branch: BRANCH,
    head: null,
    sessions: {},
    attempts: { plan: 0, implement: 0, review: 0, test: 0, retro: 0 },
    results: {},
    remediations: { review: 0, test: 0 },
    prUrl: null,
    lastError: null,
    updatedAt: "2026-09-10T00:00:00.000Z",
  };
}

function planResult(): PlanPhaseResult {
  return {
    runId: RUN_ID,
    phase: "plan",
    attempt: 1,
    sessionId: "plan-session",
    sessionFile: "/ticket/sessions/plan/1.jsonl",
    inputHead: BASE,
    outputHead: BASE,
    status: "passed",
    summary: "secret prompt and transcript must not be persisted in event",
    details: { steps: ["make the focused change"] },
  };
}

function terminal(stateValue: PersonalRunState): PersonalRunState {
  return {
    ...stateValue,
    version: stateValue.version + 1,
    status: "failed",
    lifecycle: "failed",
    launchState: "failed",
    preparationState: "failed",
    endedAt: "2026-09-10T00:00:01.000Z",
    lastError: "credential=super-secret transcript=do-not-publish\n",
    updatedAt: "2026-09-10T00:00:01.000Z",
  };
}

test("JSON state commits publish bounded versioned events without secrets or logs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-events-state-"));
  try {
    const states = new JsonRunStateStore(directory);
    const initial = state();
    await states.create(initial);
    const phaseStarted = { ...initial, version: 2, step: "plan" as const, baseSha: BASE, head: BASE, attempts: { ...initial.attempts, plan: 1 }, updatedAt: "2026-09-10T00:00:00.100Z" };
    await states.save(phaseStarted);
    const phaseCompleted = { ...phaseStarted, version: 3, head: BASE, baseSha: BASE, sessions: { plan: "plan-session" }, results: { plan: planResult() }, updatedAt: "2026-09-10T00:00:00.200Z" };
    await states.save(phaseCompleted);
    const events = await states.readEvents(RUN_ID);
    assert.deepEqual(events.map(event => event.type), ["run_started", "phase_started", "phase_completed"]);
    assert.ok(events.every(event => event.stateRevision >= 1 && event.eventId.length === 64));
    for (const event of events) validateRunEvent(event);
    const raw = await readFile(states.eventPath(RUN_ID), "utf8");
    assert.equal(raw.includes("secret"), false);
    assert.equal(raw.includes("credential"), false);
    assert.equal(raw.includes("stdout.log"), false);
    assert.ok(raw.length < 64 * 1024);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("terminal state remains authoritative and watcher synthesizes after outbox failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-events-terminal-failure-"));
  try {
    const states = new JsonRunStateStore(directory, { maxEventBytes: 1 });
    await states.create(state());
    const failed = { ...terminal(state()), reservationCleanupFailure: "reservation release blocked or unverified" };
    await states.save(failed);
    const persisted = await states.read(RUN_ID);
    assert.equal(persisted?.status, "failed");
    assert.equal(persisted?.reservationCleanupFailure, failed.reservationCleanupFailure);
    assert.equal((await states.readEvents(RUN_ID)).length, 0);
    assert.equal(synthesizeCurrentRunEvents(persisted!).at(-1)?.type, "terminal_failed");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("state remains authoritative when event persistence fails", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-events-state-first-"));
  try {
    const states = new JsonRunStateStore(directory, { maxEventBytes: 1 });
    await states.create(state());
    assert.equal((await states.read(RUN_ID))?.version, 1);
    assert.deepEqual(await states.readEvents(RUN_ID), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("metadata-only state updates are silent and malformed outbox data is recoverable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-events-malformed-"));
  try {
    const states = new JsonRunStateStore(directory);
    const initial = state();
    await states.create(initial);
    await writeFile(states.eventPath(RUN_ID), "not-json\n", "utf8");
    const changed = { ...initial, version: 2, ticketTitle: "new title", updatedAt: "2026-09-10T00:00:00.100Z" };
    await states.save(changed);
    assert.deepEqual((await states.readEvents(RUN_ID)).map(event => event.type), []);
    const failed = terminal(changed);
    await states.save(failed);
    assert.deepEqual((await states.readEvents(RUN_ID)).map(event => event.type), ["terminal_failed"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("outbox retention is bounded and event IDs deduplicate replay", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-events-retention-"));
  try {
    const outbox = new (await import("../src/personal/run-events.js")).JsonRunEventOutbox(directory, { maxEvents: 2 });
    let current = state();
    await outbox.append(undefined, current);
    for (let version = 2; version <= 10; version += 1) {
      const next = { ...current, version, step: "plan" as const, attempts: { ...current.attempts, plan: 1 }, updatedAt: `2026-09-10T00:00:${String(version).padStart(2, "0")}.000Z` };
      await outbox.append(current, next);
      current = next;
    }
    const events = await outbox.read(RUN_ID);
    assert.ok(events.length <= 2);
    assert.ok(events.length <= MAX_RUN_EVENT_COUNT);
    const ids = new Set(events.map(event => event.eventId));
    assert.equal(ids.size, events.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("watch reconciles a missed terminal event and exits without live adapters", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-events-watch-"));
  try {
    const states = new JsonRunStateStore(directory);
    const initial = state();
    await states.create(initial);
    const failed = terminal(initial);
    await states.save(failed);
    await unlink(states.eventPath(RUN_ID));
    const seen: RunEvent[] = [];
    const result = await watchRun({ states, selector: RUN_ID, onEvent: event => { seen.push(event); } });
    assert.equal(result.state.status, "failed");
    assert.deepEqual(seen.map(event => event.type), ["run_started", "terminal_failed"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const platform of [process.platform, "win32"] as const) test(`watch observes atomic replacement (${platform}) without duplicate delivery`, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-events-atomic-watch-"));
  let timer: NodeJS.Timeout | undefined;
  let writer: Promise<void> | undefined;
  let cancelWriter: (() => void) | undefined;
  const abort = new AbortController();
  try {
    const states = new JsonRunStateStore(directory);
    const initial = state();
    await states.reserve(initial);
    const seen: RunEvent[] = [];
    let changed = false;
    let watchCalls = 0;
    const watching = watchRun({
      states,
      platform,
      ...(platform === "win32" ? { watch: (() => { watchCalls++; throw new Error("Windows invoked fs.watch"); }) as typeof fsWatch } : {}),
      signal: abort.signal,
      selector: RUN_ID,
      debounceMs: 10,
      reconcileIntervalMs: 200,
      onEvent: event => {
        seen.push(event);
        if (event.type === "run_started" && !changed) {
          changed = true;
          writer = new Promise<void>((resolve, reject) => {
            cancelWriter = resolve;
            timer = setTimeout(() => {
              cancelWriter = undefined;
              states.save(terminal(initial)).then(resolve, reject);
            }, 30);
          });
          // Observe failures immediately and stop the watcher rather than hang.
          void writer.catch(error => abort.abort(error));
        }
      },
    });
    const result = await watching;
    assert.equal(watchCalls, 0);
    await writer;
    assert.equal(result.state.status, "failed");
    assert.equal(seen.filter(event => event.type === "run_started").length, 1);
    assert.equal(seen.filter(event => event.type === "terminal_failed").length, 1);
  } finally {
    // Atomic state visibility precedes outbox publication and lock release.
    // Do not remove the fixture while the writer is still releasing ownership.
    clearTimeout(timer);
    cancelWriter?.();
    try { await writer; }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("watch output is one sanitized bounded line", () => {
  const event: RunEvent = {
    schemaVersion: 1,
    eventId: "a3b57ba0d4aac722e2f3813aba6cc35b372814a5973a7f3039049ed72c312b27",
    runId: RUN_ID,
    ticketId: "AIDEV-1",
    stateRevision: 1,
    timestamp: "2026-09-10T00:00:00.000Z",
    type: "run_started",
  };
  const output = formatRunEvent(event);
  assert.equal(output.endsWith("\n"), true);
  assert.equal(output.split("\n").length, 2);
  assert.equal(output.includes("secret"), false);
});

test("notification worker retries and checkpoints only after successful terminal delivery", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-events-worker-"));
  try {
    const states = new JsonRunStateStore(directory);
    const initial = state();
    await states.create(initial);
    const failed = terminal(initial);
    await states.save(failed);
    await unlink(states.eventPath(RUN_ID));
    let attempts = 0;
    const worker = new RunNotificationWorker({
      states,
      selector: RUN_ID,
      consumerId: "test-adapter",
      checkpointDirectory: path.join(directory, "checkpoints"),
      adapter: { async notify(event) { assert.equal(event.type, "terminal_failed"); attempts += 1; if (attempts === 1) throw new Error("temporary adapter failure"); } },
      maxAttempts: 2,
      retryDelayMs: 0,
    });
    await worker.run();
    assert.equal(attempts, 2);
    const checkpoint = JSON.parse(await readFile(worker.checkpointPath, "utf8")) as { deliveredEventIds: string[] };
    assert.equal(checkpoint.deliveredEventIds.length, 1);
    assert.equal(await access(worker.checkpointPath).then(() => true), true);
    let replayAttempts = 0;
    await new RunNotificationWorker({
      states,
      selector: RUN_ID,
      consumerId: "test-adapter",
      checkpointDirectory: path.join(directory, "checkpoints"),
      adapter: { async notify() { replayAttempts += 1; } },
      maxAttempts: 1,
    }).run();
    assert.equal(replayAttempts, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("derived events include attention and remediation transitions without claiming CI", () => {
  const previous = { ...state(), version: 4, step: "review" as const, attempts: { ...state().attempts, plan: 1, implement: 1, review: 1 }, remediations: { review: 0, test: 0 } };
  const review = { ...planResult(), phase: "review" as const, sessionFile: "/ticket/sessions/review/1.jsonl", sessionId: "review", status: "remediation_required" as const, details: { findings: ["fix"] } };
  const next = { ...previous, version: 5, results: { review }, remediations: { review: 1, test: 0 }, updatedAt: "2026-09-10T00:00:00.500Z" };
  const events = deriveRunEvents(previous, next);
  assert.deepEqual(events.map(event => event.type), ["phase_completed", "attention_required", "remediation_requested"]);
  assert.equal(events.some(event => (event.type as string) === "ci_updated"), false);
});

test("reconciliation uses exact remediation attempts across Review/Test retries", () => {
  const reviewPass = {
    ...planResult(),
    phase: "review" as const,
    attempt: 3,
    sessionId: "review-3",
    sessionFile: "/ticket/sessions/review/3.jsonl",
    status: "passed" as const,
    details: { findings: [] },
  };
  const testPass = {
    ...planResult(),
    phase: "test" as const,
    attempt: 2,
    sessionId: "test-2",
    sessionFile: "/ticket/sessions/test/2.jsonl",
    status: "passed" as const,
    details: { commands: [{ command: "npm test", exitCode: 0, summary: "passed" }] },
  };
  const recovered = {
    ...state(20),
    step: "test" as const,
    baseSha: BASE,
    head: BASE,
    attempts: { plan: 1, implement: 3, review: 3, test: 2, retro: 0 },
    sessions: { review: "review-3", test: "test-2" },
    results: { review: reviewPass, test: testPass },
    remediations: { review: 1, test: 1 },
    remediationAttempts: { review: [2], test: [1] },
    updatedAt: "2026-09-10T00:00:20.000Z",
  };

  const events = synthesizeCurrentRunEvents(recovered);
  assert.ok(events.some(event => event.type === "phase_started" && event.phase === "implement" && event.attempt === 1));
  assert.ok(events.some(event => event.type === "phase_completed" && event.phase === "review" && event.attempt === 1 && event.outcome === "passed"));
  assert.equal(events.some(event => event.type === "attention_required" && event.phase === "review" && event.attempt === 1), false);
  assert.equal(events.some(event => event.type === "remediation_requested" && event.phase === "review" && event.attempt === 1), false);
  assert.ok(events.some(event => event.type === "attention_required" && event.phase === "review" && event.attempt === 2));
  assert.ok(events.some(event => event.type === "remediation_requested" && event.phase === "review" && event.attempt === 2));
  assert.ok(events.some(event => event.type === "attention_required" && event.phase === "test" && event.attempt === 1));
  assert.ok(events.some(event => event.type === "remediation_requested" && event.phase === "test" && event.attempt === 1));
  assert.ok(events.some(event => event.type === "phase_completed" && event.phase === "review" && event.attempt === 3 && event.outcome === "passed"));
  assert.equal(events.some(event => (event.type as string) === "ci_updated"), false);
});

test("reconciliation never fabricates run_started for an unclaimed failed background launch", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "squire-events-reserved-failure-"));
  try {
    const states = new JsonRunStateStore(directory);
    const reserved = {
      ...state(),
      step: "launching" as const,
      lifecycle: "launching" as const,
      launchState: "reserved" as const,
      preparationState: "pending" as const,
      executionMode: "background" as const,
      startedAt: "2026-09-10T00:00:00.000Z",
      endedAt: null,
      controllerPid: null,
      stdoutPath: path.join(directory, "stdout.log"),
      stderrPath: path.join(directory, "stderr.log"),
      repositoryPath: path.join(directory, "repository"),
      sourceRef: "HEAD",
      launchConfigDigest: "a".repeat(64),
    };
    await states.reserve(reserved);
    const failed = {
      ...reserved,
      version: 2,
      status: "failed" as const,
      lifecycle: "failed" as const,
      launchState: "failed" as const,
      preparationState: "failed" as const,
      endedAt: "2026-09-10T00:00:01.000Z",
      lastError: "bootstrap failed",
      updatedAt: "2026-09-10T00:00:01.000Z",
    };
    await states.failReserved(failed);
    await unlink(states.eventPath(RUN_ID));
    const seen: RunEvent[] = [];
    const result = await watchRun({ states, selector: RUN_ID, onEvent: event => { seen.push(event); } });
    assert.equal(result.state.launchState, "failed");
    assert.ok(seen.some(event => event.type === "run_reserved"));
    assert.equal(seen.some(event => event.type === "run_started"), false);
    assert.ok(seen.some(event => event.type === "terminal_failed"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const platform of ["win32", "linux"] as const) {
  for (const ending of ["terminal", "stop", "abort", "watch-error", "watch-unavailable", "reconcile-error"] as const) {
    test(`bounded consumer ${platform}: ${ending} clears all wake timers/handles`, async t => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "squire-watch-seam-"));
      const abort = new AbortController();
      let current = state();
      let reads = 0;
      let failRead = false;
      let ready!: () => void;
      const initialized = new Promise<void>(resolve => { ready = resolve; });
      const handles: (EventEmitter & { close(): void; closes: number })[] = [];
      const callbacks: (() => void)[] = [];
      const watched: string[] = [];
      const events: RunEvent[] = [];
      const consumer = new RunEventConsumer({
        states: {
          directory,
          async create() { assert.fail("consumer wrote state"); },
          async save() { assert.fail("consumer wrote state"); },
          async findActive() { return current; },
          async read() { reads++; if (failRead) throw new Error("read failed"); return current; },
          async readEvents() { if (reads === 2) ready(); return []; },
        },
        selector: RUN_ID, platform, signal: abort.signal,
        reconcileIntervalMs: 200, debounceMs: 10,
        onEvent: event => { events.push(event); },
        watch: ((name: string, _options: unknown, callback: () => void) => {
          watched.push(name);
          assert.notEqual(platform, "win32", "Windows must never invoke fs.watch");
          if (ending === "watch-unavailable") throw new Error("watch unavailable");
          callbacks.push(callback);
          const handle = Object.assign(new EventEmitter(), { closes: 0, close() { this.closes++; }, ref() { return this; }, unref() { return this; } });
          handles.push(handle);
          return handle as unknown as FSWatcher;
        }) as typeof fsWatch,
      });
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const scheduled = t.mock.method(globalThis, "setTimeout");
      const cleared = t.mock.method(globalThis, "clearTimeout");
      const watching = consumer.watch();
      // Attach rejection handling before advancing clocks or aborting.
      const outcome = watching.then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error }));
      try {
        await initialized;
        await immediate();
        assert.equal(reads, 2, "only initial race-closing reconciliation");
        assert.deepEqual(watched, platform === "win32" ? [] : [directory, path.join(directory, "events")]);
        t.mock.timers.tick(199);
        await immediate();
        assert.equal(reads, 2, "no busy polling before configured bound");
        if (ending === "terminal" || ending === "watch-unavailable") current = terminal(current);
        if (ending === "reconcile-error") failRead = true;
        if (ending === "stop") { callbacks.forEach(callback => callback()); consumer.stop(); }
        if (ending === "abort") { callbacks.forEach(callback => callback()); abort.abort(new Error("test abort")); }
        if (ending === "watch-error") {
          handles.forEach(handle => handle.emit("error", new Error("watch failed")));
          current = terminal(current);
        }
        t.mock.timers.tick(1);
        await immediate();
        const result = await outcome;
        if (ending === "terminal" || ending === "watch-error" || ending === "watch-unavailable") {
          assert.equal(result.error, undefined);
          assert.equal(result.value?.state.status, "failed");
          assert.equal(reads, 3, "terminal visible at configured reconciliation bound");
          assert.deepEqual(events.map(event => event.type), ["run_started", "terminal_failed"]);
        } else {
          assert.match(result.error?.message ?? "", /stopped|test abort|read failed/);
        }
        assert.ok(handles.every(handle => handle.closes === 1));
        for (const call of scheduled.mock.calls) {
          assert.ok(cleared.mock.calls.some(clear => clear.arguments[0] === call.result), "every debounce/reconciliation timer was cleared");
        }
        const finalReads = reads;
        t.mock.timers.runAll(); // leaked debounce/reconcile timers would run here
        await immediate();
        assert.equal(reads, finalReads, "no reads after terminal/stop/abort/failure");
      } finally {
        consumer.stop();
        await outcome;
        t.mock.restoreAll();
        t.mock.timers.reset();
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}
