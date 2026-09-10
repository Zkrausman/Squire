import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn as nodeSpawn } from "node:child_process";
import { NodeBackgroundLauncher } from "../src/personal/background-launcher.js";
import { PersonalMvpController } from "../src/personal/controller.js";
import { JsonRunStateStore } from "../src/personal/json-run-state.js";
import { resolvePhaseProfiles } from "../src/personal/model-policy.js";
import { formatRunStatus, findRunState, StatusLookupError } from "../src/personal/status.js";
import { main, parseArguments } from "../src/personal/cli.js";
import type { PersonalRunState, RunRequest } from "../src/personal/types.js";

const REQUEST: RunRequest = {
  ticketId: "AIDEV-1",
  repository: "example/repo",
  repositoryPath: "/tmp/example-repo",
  sourceRef: "HEAD",
  baseBranch: "main",
};

function controller(states: JsonRunStateStore, now = new Date("2026-09-10T00:00:00.000Z"), id = "01234567-89ab-cdef-0123-456789abcdef"): PersonalMvpController {
  return new PersonalMvpController({
    states,
    now: () => now,
    newId: () => id,
    tickets: { async get() { throw new Error("credential lookup failed"); } },
    workspaces: {} as never,
    phases: {} as never,
    publication: {} as never,
  });
}

test("background reservation is durable before ticket lookup and rejects a concurrent ticket", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-background-state-"));
  try {
    const states = new JsonRunStateStore(root);
    const first = controller(states);
    const second = controller(states);
    const reserved = await first.reserve(REQUEST, { executionMode: "background", stdoutPath: path.join(root, "out.log"), stderrPath: path.join(root, "err.log"), controllerPid: null });
    assert.equal(reserved.step, "launching");
    assert.equal(reserved.launchState, "reserved");
    await assert.rejects(second.reserve(REQUEST, { executionMode: "foreground" }), /active or ambiguous reservation/);
    assert.equal((await states.read(reserved.runId))?.status, "running");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("credential/bootstrap failure is recorded and status never needs live adapters", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-background-failure-"));
  try {
    const states = new JsonRunStateStore(root);
    const run = controller(states);
    await assert.rejects(run.run(REQUEST), /credential lookup failed/);
    const state = (await states.findByTicket(REQUEST.ticketId))[0]!;
    assert.equal(state.status, "failed");
    assert.equal(state.lifecycle, "failed");
    assert.ok(state.endedAt);
    assert.match(formatRunStatus(state, new Date("2026-09-11T00:00:00.000Z")), /Terminal error: credential lookup failed/);
    assert.match(formatRunStatus(state, new Date("2026-09-11T00:00:00.000Z")), /Elapsed: 0s/);
    assert.equal((await findRunState(states, REQUEST.ticketId)).runId, state.runId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy status explicitly reports unavailable timing and model evidence", async () => {
  const state: PersonalRunState = {
    schemaVersion: 1, version: 1, runId: "aidev-1-legacy1234", ticketId: "AIDEV-1", ticketTitle: "Legacy", status: "running", step: "preparing",
    sandbox: "squire-aidev-1-legacy1234", repository: "example/repo", baseBranch: "main", baseSha: null, branch: "squire/aidev-1-333bc53d", head: null,
    sessions: {}, attempts: { plan: 0, implement: 0, review: 0, test: 0, retro: 0 }, results: {}, remediations: { review: 0, test: 0 }, prUrl: null, lastError: null, updatedAt: "2026-09-10T00:00:00.000Z",
  };
  const output = formatRunStatus(state, new Date("2026-09-11T00:00:00.000Z"));
  assert.match(output, /Elapsed: unavailable/);
  assert.match(output, /Model: unavailable/);
  assert.match(output, /Current HEAD: unavailable/);
});

test("status renders persisted phase, timing, model, head, error, PR, and log evidence", () => {
  const output = formatRunStatus({
    schemaVersion: 1,
    version: 4,
    runId: "aidev-1-status1234",
    ticketId: "AIDEV-1",
    ticketTitle: "Status fields",
    status: "completed",
    step: "review",
    lifecycle: "completed",
    executionMode: "background",
    startedAt: "2026-09-10T00:00:00.000Z",
    endedAt: "2026-09-10T01:01:01.000Z",
    controllerPid: 4321,
    stdoutPath: "/home/user/.local/state/squire/logs/out.log",
    stderrPath: "/home/user/.local/state/squire/logs/err.log",
    repositoryPath: "/work/repo",
    sourceRef: "main",
    launchConfigDigest: "a".repeat(64),
    sandbox: "squire-aidev-1-status1234",
    repository: "example/repo",
    baseBranch: "main",
    baseSha: "b".repeat(40),
    branch: "squire/aidev-1-status1234",
    profiles: resolvePhaseProfiles("example/repo", "AIDEV-1").profiles,
    head: "c".repeat(40),
    sessions: {},
    attempts: { plan: 1, implement: 1, review: 2, test: 1, retro: 1 },
    results: {},
    remediations: { review: 1, test: 0 },
    prUrl: "https://github.com/example/repo/pull/12",
    lastError: "a terminal diagnostic",
    updatedAt: "2026-09-10T01:01:01.000Z",
  }, new Date("2026-09-11T00:00:00.000Z"));
  assert.match(output, /Phase: review/);
  assert.match(output, /Attempt: 2/);
  assert.match(output, /Provider: openai-codex/);
  assert.match(output, /Model: gpt-5\.6-sol/);
  assert.match(output, /Thinking: medium/);
  assert.match(output, /Elapsed: 1h 1m 1s \(3661000 ms\)/);
  assert.match(output, new RegExp(`Current HEAD: ${"c".repeat(40)}`));
  assert.match(output, /Terminal error: a terminal diagnostic/);
  assert.match(output, /PR URL: https:\/\/github\.com\/example\/repo\/pull\/12/);
  assert.match(output, /Stdout log: \/home\/user\/\.local\/state\/squire\/logs\/out\.log/);
  assert.match(output, /Stderr log: \/home\/user\/\.local\/state\/squire\/logs\/err\.log/);
});

test("detached launcher uses file descriptors, no shell/window, and unrefs after spawn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-background-launch-"));
  try {
    const requests: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    class FakeChild extends EventEmitter {
      pid = 321;
      unrefCalled = false;
      unref(): void { this.unrefCalled = true; }
    }
    let child: FakeChild | undefined;
    const fakeSpawn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
      requests.push({ command, args, options });
      child = new FakeChild();
      setImmediate(() => child?.emit("spawn"));
      return child;
    }) as unknown as typeof nodeSpawn;
    const launcher = new NodeBackgroundLauncher({ spawn: fakeSpawn });
    const stdoutPath = path.join(root, "logs", "run.stdout.log");
    const stderrPath = path.join(root, "logs", "run.stderr.log");
    const result = await launcher.launch({ executable: process.execPath, args: ["/absolute/cli.js", "run", "AIDEV-1"], stdoutPath, stderrPath });
    assert.equal(result.pid, 321);
    assert.equal(child?.unrefCalled, true);
    assert.equal(requests[0]?.options["detached"], true);
    assert.equal(requests[0]?.options["windowsHide"], true);
    assert.equal(requests[0]?.options["shell"], false);
    const stdio = requests[0]?.options["stdio"] as unknown[];
    assert.equal(stdio[0], "ignore");
    assert.equal(typeof stdio[1], "number");
    assert.equal(typeof stdio[2], "number");
    if (process.platform !== "win32") {
      assert.equal((await stat(stdoutPath)).mode & 0o777, 0o600);
      assert.equal((await stat(stderrPath)).mode & 0o777, 0o600);
    }
    assert.equal(await readFile(stdoutPath, "utf8"), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("POSIX log opening rejects a final-component symlink", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-background-log-link-"));
  try {
    const target = path.join(root, "target.log");
    const stdoutPath = path.join(root, "stdout.log");
    await writeFile(target, "sentinel\n", "utf8");
    await symlink(target, stdoutPath, "file");
    let spawned = false;
    const launcher = new NodeBackgroundLauncher({
      spawn: (() => { spawned = true; throw new Error("spawn must not be reached"); }) as unknown as typeof nodeSpawn,
    });
    await assert.rejects(launcher.launch({
      executable: process.execPath,
      args: [],
      stdoutPath,
      stderrPath: path.join(root, "stderr.log"),
    }), (error: unknown) => (error as NodeJS.ErrnoException).code === "ELOOP");
    assert.equal(spawned, false);
    assert.equal(await readFile(target, "utf8"), "sentinel\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("post-spawn errors are diagnostic only after the child handoff", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-post-spawn-error-"));
  try {
    class FakeChild extends EventEmitter {
      pid = 654;
      unref(): void {}
    }
    const fakeSpawn = (() => {
      const child = new FakeChild();
      setImmediate(() => {
        child.emit("spawn");
        setImmediate(() => child.emit("error", new Error("late child error")));
      });
      return child;
    }) as unknown as typeof nodeSpawn;
    let observeError!: (error: Error) => void;
    const observed = new Promise<Error>(resolve => { observeError = resolve; });
    const result = await new NodeBackgroundLauncher({ spawn: fakeSpawn }).launch({
      executable: process.execPath,
      args: [],
      stdoutPath: path.join(root, "stdout.log"),
      stderrPath: path.join(root, "stderr.log"),
      onError: observeError,
    });
    assert.equal(result.pid, 654);
    assert.match((await observed).message, /late child error/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI accepts background/status options in either documented order and rejects malformed selectors", () => {
  const run = parseArguments(["run", "--config", "/tmp/squire.json", "AIDEV-1", "--background"]);
  assert.equal(run?.command, "run");
  assert.equal((run as { background: boolean } | undefined)?.background, true);
  const status = parseArguments(["status", "--config", "/tmp/squire.json", "aidev-1-0123456789"]);
  assert.equal(status?.command, "status");
  assert.equal(parseArguments(["status", "not-an-id"]), undefined);
  assert.equal(parseArguments(["run", "AIDEV-1", "--background", "--background"]), undefined);
});

test("status lookup reports a missing or ambiguous selector with a useful code", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-status-errors-"));
  try {
    const states = new JsonRunStateStore(root);
    await assert.rejects(findRunState(states, "AIDEV-1"), (error: unknown) => error instanceof StatusLookupError && error.code === "missing");
    await assert.rejects(findRunState(states, "bad"), (error: unknown) => error instanceof StatusLookupError && error.code === "malformed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real detached child outlives launch handoff and inherits stdout/stderr logs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-real-detached-"));
  try {
    const marker = path.join(root, "finished.txt");
    const stdoutPath = path.join(root, "stdout.log");
    const stderrPath = path.join(root, "stderr.log");
    const launched = await new NodeBackgroundLauncher().launch({
      executable: process.execPath,
      args: [path.resolve("fixtures/background-child.mjs"), marker, "400"],
      stdoutPath,
      stderrPath,
    });
    assert.ok(launched.pid);
    await assert.rejects(access(marker));
    await waitForFile(marker);
    assert.match(await readFile(stdoutPath, "utf8"), /detached stdout inherited/);
    assert.match(await readFile(stderrPath, "utf8"), /detached stderr inherited/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a short-lived launcher parent exits before the detached child and logs survive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-real-parent-detached-"));
  try {
    const marker = path.join(root, "finished.txt");
    const stdoutPath = path.join(root, "stdout.log");
    const stderrPath = path.join(root, "stderr.log");
    const parentExit = await spawnExit(process.execPath, [
      path.resolve("fixtures/background-launch-parent.mjs"), marker, stdoutPath, stderrPath, "800",
    ]);
    assert.equal(parentExit, 0);
    await assert.rejects(access(marker));
    await waitForFile(marker);
    assert.match(await readFile(stdoutPath, "utf8"), /detached stdout inherited/);
    assert.match(await readFile(stderrPath, "utf8"), /detached stderr inherited/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("background bootstrap transport follows the JSON store when no override is supplied", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-background-state-transport-"));
  try {
    const states = new JsonRunStateStore(path.join(root, "state"));
    let launchEnvironment: NodeJS.ProcessEnv | undefined;
    await controller(states).startBackground(REQUEST, {
      launcher: { async launch(request) {
        launchEnvironment = request.env;
        return { pid: 777 };
      } },
      cliPath: path.resolve("dist/src/personal/cli.js"),
      configPath: path.resolve("squire.config.example.json"),
      logsDirectory: path.join(root, "logs"),
      launchConfigDigest: "d".repeat(64),
    });
    assert.equal(launchEnvironment?.["SQUIRE_STATE_DIRECTORY"], states.directory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("background parent performs no post-spawn state write and child validates immutable identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-single-writer-"));
  try {
    const states = new JsonRunStateStore(path.join(root, "state"));
    const digest = "c".repeat(64);
    const run = controller(states);
    const launched = await run.startBackground(REQUEST, {
      launcher: { async launch() { return { pid: 777 }; } },
      cliPath: path.resolve("dist/src/personal/cli.js"),
      configPath: path.resolve("squire.config.example.json"),
      stateDirectory: states.directory,
      logsDirectory: path.join(root, "logs"),
      launchConfigDigest: digest,
    });
    const afterParent = await states.read(launched.runId);
    assert.equal(afterParent?.version, 1);
    assert.equal(afterParent?.launchState, "reserved");
    assert.equal(afterParent?.controllerPid, null);
    await assert.rejects(run.runReserved({ ...REQUEST, sourceRef: "changed" }, launched.runId, digest), /configuration identity mismatch/);
    await assert.rejects(run.runReserved(REQUEST, launched.runId, "d".repeat(64)), /configuration identity mismatch/);
    await assert.rejects(run.runReserved(REQUEST, launched.runId, digest), /credential lookup failed/);
    const afterChild = await states.read(launched.runId);
    assert.equal(afterChild?.status, "failed");
    assert.ok((afterChild?.version ?? 0) >= 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a detached child claims with a parent-monotonic timestamp before adapters when its clock moved backward", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-background-clock-regression-"));
  try {
    const states = new JsonRunStateStore(root);
    const digest = "6".repeat(64);
    const parentTime = "2026-09-10T00:00:00.000Z";
    const reserved = await controller(states, new Date(parentTime)).reserve(REQUEST, { executionMode: "background", controllerPid: null, launchConfigDigest: digest });
    let adapterObservedClaim = false;
    const child = new PersonalMvpController({
      states,
      now: () => new Date("2026-09-09T23:59:59.000Z"),
      tickets: { async get() {
        const claimed = await states.read(reserved.runId);
        assert.equal(claimed?.launchState, "started");
        assert.equal(claimed?.startedAt, parentTime);
        assert.equal(claimed?.updatedAt, parentTime);
        adapterObservedClaim = true;
        throw new Error("stop after observing the claim");
      } },
      workspaces: {} as never,
      phases: {} as never,
      publication: {} as never,
    });
    await assert.rejects(child.runReserved(REQUEST, reserved.runId, digest), /stop after observing the claim/);
    assert.equal(adapterObservedClaim, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runReserved rejects a concurrent call on one controller", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-local-claim-"));
  try {
    const states = new JsonRunStateStore(root);
    const digest = "e".repeat(64);
    let ticketEntered!: () => void;
    let rejectTicket!: (error: Error) => void;
    const entered = new Promise<void>(resolve => { ticketEntered = resolve; });
    const ticketBlocked = new Promise<never>((_, reject) => { rejectTicket = reject; });
    const run = new PersonalMvpController({
      states,
      tickets: { async get() { ticketEntered(); return ticketBlocked; } },
      workspaces: {} as never,
      phases: {} as never,
      publication: {} as never,
    });
    const reserved = await run.reserve(REQUEST, { executionMode: "background", controllerPid: null, launchConfigDigest: digest });
    const first = run.runReserved(REQUEST, reserved.runId, digest);
    await entered;
    await assert.rejects(run.runReserved(REQUEST, reserved.runId, digest), /already being claimed/);
    rejectTicket(new Error("release first claim"));
    await assert.rejects(first, /release first claim/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("two detached claimants admit exactly one owner before ticket and workspace side effects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-detached-claim-"));
  try {
    const states = new JsonRunStateStore(path.join(root, "state"));
    const digest = "f".repeat(64);
    const reserved = await controller(states).reserve(REQUEST, { executionMode: "background", controllerPid: null, launchConfigDigest: digest });
    const release = path.join(root, "release");
    const sideEffects = path.join(root, "side-effects");
    const ready = [path.join(root, "ready-a"), path.join(root, "ready-b")];
    const results = [path.join(root, "result-a"), path.join(root, "result-b")];
    const workers = ready.map((readyPath, index) => spawnDetachedExit(process.execPath, [
      path.resolve("fixtures/run-reserved-claim-worker.mjs"), states.directory, reserved.runId, digest,
      readyPath, release, sideEffects, results[index]!,
    ]));
    await Promise.all(ready.map(waitForFile));
    await writeFile(release, "go\n", "utf8");
    assert.deepEqual(await Promise.all(workers), [2, 2]);
    const effects = (await readFile(sideEffects, "utf8")).trim().split("\n");
    assert.deepEqual(effects, ["ticket", "workspace"]);
    const messages = await Promise.all(results.map(file => readFile(file, "utf8")));
    // The losing claimant observes the already-started state and must stop;
    // it must not reload that state and run a second ticket/workspace side
    // effect. The exact diagnostic is intentionally not part of the contract.
    assert.equal(messages.filter(message => /reserved run claim is no longer available|version must advance by one/u.test(message)).length, 1);
    assert.equal(messages.filter(message => /stop after workspace side effect/u.test(message)).length, 1);
    const winner = await states.read(reserved.runId);
    assert.equal(winner?.status, "failed");
    assert.equal(winner?.lastError, "stop after workspace side effect");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a detached child must own the exact reservation before adapter calls", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-background-owner-"));
  try {
    const states = new JsonRunStateStore(path.join(root, "state"));
    const digest = "8".repeat(64);
    let ticketCalls = 0;
    const run = new PersonalMvpController({
      states,
      tickets: { async get() { ticketCalls += 1; throw new Error("ticket adapter must not be called"); } },
      workspaces: {} as never,
      phases: {} as never,
      publication: {} as never,
    });
    const reserved = await run.reserve(REQUEST, { executionMode: "background", controllerPid: null, launchConfigDigest: digest });
    await writeFile(path.join(states.directory, "locks", "aidev-1.lock"), "aidev-1-replacement123\n", "utf8");
    await assert.rejects(run.runReserved(REQUEST, reserved.runId, digest), /reservation ownership mismatch/);
    assert.equal(ticketCalls, 0);
    assert.equal((await states.read(reserved.runId))?.launchState, "reserved");
    assert.equal((await states.read(reserved.runId))?.version, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a reservation replacement during claim cannot admit a detached child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-background-claim-race-"));
  try {
    let replaced = false;
    const states = new class extends JsonRunStateStore {
      override async claimReserved(state: PersonalRunState): Promise<void> {
        if (!replaced) {
          replaced = true;
          await writeFile(path.join(this.directory, "locks", "aidev-1.lock"), "aidev-1-replacement123\n", "utf8");
        }
        return super.claimReserved(state);
      }
    }(path.join(root, "state"));
    const digest = "7".repeat(64);
    let ticketCalls = 0;
    const run = new PersonalMvpController({
      states,
      tickets: { async get() { ticketCalls += 1; throw new Error("ticket adapter must not be called"); } },
      workspaces: {} as never,
      phases: {} as never,
      publication: {} as never,
    });
    const reserved = await run.reserve(REQUEST, { executionMode: "background", controllerPid: null, launchConfigDigest: digest });
    await assert.rejects(run.runReserved(REQUEST, reserved.runId, digest), /reservation ownership mismatch/);
    assert.equal(ticketCalls, 0);
    assert.equal((await states.read(reserved.runId))?.version, 1);
    assert.equal(await states.reservationOwner(REQUEST.ticketId), "aidev-1-replacement123");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("launcher rejects a pre-handoff OS error and interruption closes the reservation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-launch-failures-"));
  try {
    class FakeChild extends EventEmitter {
      pid = undefined;
      unref(): void {}
      kill(): boolean { return true; }
    }
    const failingSpawn = (() => {
      const child = new FakeChild();
      setImmediate(() => child.emit("error", new Error("spawn denied")));
      return child;
    }) as unknown as typeof nodeSpawn;
    await assert.rejects(new NodeBackgroundLauncher({ spawn: failingSpawn }).launch({
      executable: process.execPath,
      args: [],
      stdoutPath: path.join(root, "failed.stdout.log"),
      stderrPath: path.join(root, "failed.stderr.log"),
    }), /spawn denied/);

    const states = new JsonRunStateStore(path.join(root, "state"));
    const run = controller(states);
    const abort = new AbortController();
    const launcher = {
      async launch(request: Parameters<NodeBackgroundLauncher["launch"]>[0]): Promise<never> {
        if (request.signal!.aborted) throw request.signal!.reason;
        return await new Promise((_, reject) => request.signal!.addEventListener("abort", () => reject(request.signal!.reason), { once: true }));
      },
    };
    const starting = run.startBackground(REQUEST, {
      launcher,
      cliPath: path.resolve("dist/src/personal/cli.js"),
      configPath: path.resolve("squire.config.example.json"),
      stateDirectory: states.directory,
      logsDirectory: path.join(root, "logs"),
      launchConfigDigest: "a".repeat(64),
      signal: abort.signal,
    });
    setImmediate(() => abort.abort(new Error("operator interrupted background startup")));
    await assert.rejects(starting, /operator interrupted background startup/);
    const interrupted = (await states.findByTicket(REQUEST.ticketId))[0]!;
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.launchState, "failed");
    assert.equal(await states.reservationOwner(REQUEST.ticketId), undefined);
    await controller(states, new Date("2026-09-10T00:00:01.000Z"), "11234567-89ab-cdef-0123-456789abcdef").reserve(REQUEST);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI SIGINT and SIGTERM before child handoff persist interrupted evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-cli-interrupt-"));
  const originalLaunch = NodeBackgroundLauncher.prototype.launch;
  try {
    const repositoryPath = path.join(root, "repository");
    await mkdir(repositoryPath);
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify({
      repository: { slug: "example/repo", path: repositoryPath, sourceRef: "HEAD", baseBranch: "main" },
      dataDirectory: path.join(root, "runtime"),
      paths: { state: path.join(root, "state"), bridges: path.join(root, "bridges"), staging: path.join(root, "staging") },
      linear: { apiKeyEnv: "SQUIRE_TEST_LINEAR_KEY" },
      github: { tokenCommand: [process.execPath, "token-helper.js"] },
      sandbox: { roleUser: "squire", piExecutable: "/usr/bin/pi", piAgentDirectory: "/ticket/pi-agent" },
      testCommands: ["npm test"],
    }), "utf8");

    for (const [signal, ticket] of [["SIGINT", "AIDEV-1"], ["SIGTERM", "AIDEV-2"]] as const) {
      let entered!: () => void;
      const launchEntered = new Promise<void>(resolve => { entered = resolve; });
      NodeBackgroundLauncher.prototype.launch = async function(request): Promise<never> {
        entered();
        if (request.signal!.aborted) throw request.signal!.reason;
        return await new Promise((_, reject) => request.signal!.addEventListener("abort", () => reject(request.signal!.reason), { once: true }));
      };
      const running = main(["run", ticket, "--background", "--config", configPath]);
      await launchEntered;
      process.emit(signal, signal);
      assert.equal(await running, 1);
      const states = new JsonRunStateStore(path.join(root, "state"));
      const persisted = (await states.findByTicket(ticket))[0]!;
      assert.equal(persisted.status, "interrupted");
      assert.equal(persisted.launchState, "failed");
      assert.match(persisted.lastError ?? "", /operator interrupted background startup/);
    }
  } finally {
    NodeBackgroundLauncher.prototype.launch = originalLaunch;
    await rm(root, { recursive: true, force: true });
  }
});

test("cross-process state CAS admits exactly one writer at the same version", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-state-cas-"));
  try {
    const states = new JsonRunStateStore(root);
    const reserved = await controller(states).reserve(REQUEST);
    const barrier = path.join(root, "go");
    const candidateFiles = [path.join(root, "candidate-a"), path.join(root, "candidate-b")];
    const resultFiles = [path.join(root, "result-a"), path.join(root, "result-b")];
    await Promise.all(candidateFiles.map((file, index) => writeFile(file, JSON.stringify({ ...reserved, version: 2, ticketTitle: `writer-${index}`, updatedAt: `2026-09-10T00:00:0${index + 1}.000Z` }), "utf8")));
    const workers = candidateFiles.map((file, index) => spawnExit(process.execPath, [path.resolve("fixtures/run-state-save-worker.mjs"), root, file, barrier, resultFiles[index]!]));
    await writeFile(barrier, "go\n", "utf8");
    const exits = await Promise.all(workers);
    assert.deepEqual([...exits].sort(), [0, 2]);
    const results = await Promise.all(resultFiles.map(file => readFile(file, "utf8")));
    assert.equal(results.filter(result => result === "saved\n").length, 1);
    assert.equal((await states.read(reserved.runId))?.version, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cross-process ticket operations serialize two old releases around a replacement reservation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-release-race-"));
  try {
    const states = new JsonRunStateStore(root);
    const old = await controller(states).reserve(REQUEST);
    await states.save({ ...old, version: 2, status: "interrupted", lifecycle: "interrupted", endedAt: "2026-09-10T00:00:01.000Z", lastError: "stopped", updatedAt: "2026-09-10T00:00:01.000Z" });
    const replacement = derivedReservationState(old, "aidev-1-2123456789", "2026-09-10T00:00:02.000Z");
    const inputs = path.join(root, "inputs");
    await mkdir(inputs);
    const replacementFile = path.join(inputs, "replacement.json");
    await writeFile(replacementFile, JSON.stringify(replacement), "utf8");

    const firstReady = path.join(root, "first-release-ready");
    const firstRelease = path.join(root, "first-release-go");
    const firstResult = path.join(root, "first-release-result");
    const first = startReservationRaceWorker({
      mode: "release", directory: root, ticketId: REQUEST.ticketId, runId: old.runId, resultFile: firstResult,
      env: {
        SQUIRE_TEST_ONLY_TICKET_OPERATION_STAGE: "release-after-owner-read",
        SQUIRE_TEST_ONLY_TICKET_OPERATION_READY_PATH: firstReady,
        SQUIRE_TEST_ONLY_TICKET_OPERATION_RELEASE_PATH: firstRelease,
      },
    });
    await waitForFile(firstReady);

    const secondCaller = path.join(root, "second-release-caller");
    const secondResult = path.join(root, "second-release-result");
    const second = startReservationRaceWorker({ mode: "release", directory: root, ticketId: REQUEST.ticketId, runId: old.runId, callerReady: secondCaller, resultFile: secondResult });
    const replacementCaller = path.join(root, "replacement-caller");
    const replacementResult = path.join(root, "replacement-result");
    const reserve = startReservationRaceWorker({ mode: "reserve", directory: root, ticketId: REQUEST.ticketId, runId: replacement.runId, stateFile: replacementFile, callerReady: replacementCaller, resultFile: replacementResult });
    // Both old-owner release and replacement calls have been submitted while
    // the first releaser is paused after its ownership read.
    await Promise.all([waitForFile(secondCaller), waitForFile(replacementCaller)]);
    await writeFile(firstRelease, "go\n", "utf8");

    const [firstExit, secondExit, replacementExit] = await Promise.all([first, second, reserve]);
    assert.equal(firstExit, 0);
    assert.equal(replacementExit, 0);
    assert.ok(secondExit === 0 || secondExit === 2);
    assert.equal((await states.reservationOwner(REQUEST.ticketId)), replacement.runId);
    assert.equal((await states.read(replacement.runId))?.status, "running");
    assert.match(await readFile(replacementResult, "utf8"), /^fulfilled\n$/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed reservation cleanup cannot remove a replacement acquired by another process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-failed-reservation-race-"));
  try {
    const states = new JsonRunStateStore(root);
    const active = await controller(states).reserve(REQUEST);
    await unlink(path.join(root, "locks", "aidev-1.lock"));
    const failedReservation = derivedReservationState(active, "aidev-1-2123456789", "2026-09-10T00:00:01.000Z");
    const replacement = derivedReservationState(active, "aidev-1-3123456789", "2026-09-10T00:00:02.000Z");
    const inputs = path.join(root, "inputs");
    await mkdir(inputs);
    const failedFile = path.join(inputs, "failed-reservation.json");
    const replacementFile = path.join(inputs, "replacement.json");
    await writeFile(failedFile, JSON.stringify(failedReservation), "utf8");
    await writeFile(replacementFile, JSON.stringify(replacement), "utf8");

    const failedReady = path.join(root, "failed-cleanup-ready");
    const failedRelease = path.join(root, "failed-cleanup-go");
    const failedResult = path.join(root, "failed-reservation-result");
    const failed = startReservationRaceWorker({
      mode: "reserve", directory: root, ticketId: REQUEST.ticketId, runId: failedReservation.runId, stateFile: failedFile, resultFile: failedResult,
      env: {
        SQUIRE_TEST_ONLY_TICKET_OPERATION_STAGE: "reserve-before-failed-cleanup",
        SQUIRE_TEST_ONLY_TICKET_OPERATION_READY_PATH: failedReady,
        SQUIRE_TEST_ONLY_TICKET_OPERATION_RELEASE_PATH: failedRelease,
      },
    });
    await waitForFile(failedReady);
    await states.save({ ...active, version: 2, status: "failed", lifecycle: "failed", endedAt: "2026-09-10T00:00:01.500Z", lastError: "stopped", updatedAt: "2026-09-10T00:00:01.500Z" });

    const replacementCaller = path.join(root, "replacement-caller");
    const replacementResult = path.join(root, "replacement-result");
    const reserve = startReservationRaceWorker({ mode: "reserve", directory: root, ticketId: REQUEST.ticketId, runId: replacement.runId, stateFile: replacementFile, callerReady: replacementCaller, resultFile: replacementResult });
    await waitForFile(replacementCaller);
    await writeFile(failedRelease, "go\n", "utf8");

    const [failedExit, replacementExit] = await Promise.all([failed, reserve]);
    assert.equal(failedExit, 2);
    assert.equal(replacementExit, 0);
    assert.match(await readFile(failedResult, "utf8"), /ticket already has an active run/);
    assert.match(await readFile(replacementResult, "utf8"), /^fulfilled\n$/u);
    assert.equal(await states.reservationOwner(REQUEST.ticketId), replacement.runId);
    assert.equal((await states.read(replacement.runId))?.status, "running");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("child bootstrap failure clamps a future reservation timestamp and releases the reservation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-bootstrap-fallback-"));
  try {
    const states = new JsonRunStateStore(path.join(root, "state"));
    const digest = "b".repeat(64);
    const reservedAt = "9999-12-31T23:59:59.999Z";
    const reserved = await controller(states, new Date(reservedAt)).reserve(REQUEST, { executionMode: "background", launchConfigDigest: digest });
    const exit = await spawnExit(process.execPath, [
      path.resolve("dist/src/personal/cli.js"), "run", REQUEST.ticketId,
      "--config", path.join(root, "missing-config.json"),
      "--reserved-run-id", reserved.runId,
      "--reserved-config-sha256", digest,
    ], { ...process.env, SQUIRE_STATE_DIRECTORY: states.directory });
    assert.equal(exit, 1);
    const failed = await states.read(reserved.runId);
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.lifecycle, "failed");
    assert.equal(failed?.launchState, "failed");
    assert.equal(failed?.endedAt, reservedAt);
    assert.equal(failed?.updatedAt, reservedAt);
    assert.match(failed?.lastError ?? "", /ENOENT/);
    assert.equal(await states.reservationOwner(REQUEST.ticketId), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bootstrap fallback cannot terminalize a reservation with a different ticket or digest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-bootstrap-identity-"));
  try {
    const states = new JsonRunStateStore(path.join(root, "state"));
    const digest = "1".repeat(64);
    const reserved = await controller(states).reserve({ ...REQUEST, ticketId: "AIDEV-2" }, { executionMode: "background", launchConfigDigest: digest });
    const missingConfig = path.join(root, "missing-config.json");
    const wrongTicketExit = await spawnExit(process.execPath, [
      path.resolve("dist/src/personal/cli.js"), "run", REQUEST.ticketId,
      "--config", missingConfig,
      "--reserved-run-id", reserved.runId,
      "--reserved-config-sha256", digest,
    ], { ...process.env, SQUIRE_STATE_DIRECTORY: states.directory });
    assert.equal(wrongTicketExit, 1);
    assert.equal((await states.read(reserved.runId))?.status, "running");

    const matchingTicket = { ...REQUEST, ticketId: "AIDEV-2" };
    const wrongDigestExit = await spawnExit(process.execPath, [
      path.resolve("dist/src/personal/cli.js"), "run", matchingTicket.ticketId,
      "--config", missingConfig,
      "--reserved-run-id", reserved.runId,
      "--reserved-config-sha256", "2".repeat(64),
    ], { ...process.env, SQUIRE_STATE_DIRECTORY: states.directory });
    assert.equal(wrongDigestExit, 1);
    assert.equal((await states.read(reserved.runId))?.status, "running");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bootstrap fallback requires its reservation to be present and unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-bootstrap-owner-"));
  try {
    const states = new JsonRunStateStore(path.join(root, "state"));
    const digest = "3".repeat(64);
    const cases = [
      { ticketId: "AIDEV-3", id: "31234567-89ab-cdef-0123-456789abcdef", replacement: undefined },
      { ticketId: "AIDEV-4", id: "41234567-89ab-cdef-0123-456789abcdef", replacement: "aidev-4-replacement123" },
    ] as const;
    for (const item of cases) {
      const request = { ...REQUEST, ticketId: item.ticketId };
      const reserved = await controller(states, new Date("2026-09-10T00:00:00.000Z"), item.id).reserve(request, { executionMode: "background", launchConfigDigest: digest });
      const lock = path.join(states.directory, "locks", `${item.ticketId.toLowerCase()}.lock`);
      if (item.replacement === undefined) await unlink(lock);
      else await writeFile(lock, `${item.replacement}\n`, "utf8");
      const exit = await spawnExit(process.execPath, [
        path.resolve("dist/src/personal/cli.js"), "run", item.ticketId,
        "--config", path.join(root, "missing-config.json"),
        "--reserved-run-id", reserved.runId,
        "--reserved-config-sha256", digest,
      ], { ...process.env, SQUIRE_STATE_DIRECTORY: states.directory });
      assert.equal(exit, 1);
      assert.equal((await states.read(reserved.runId))?.status, "running");
      assert.equal((await states.read(reserved.runId))?.version, 1);
      assert.equal(await states.reservationOwner(item.ticketId), item.replacement);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("background launch rejects direct and resolved destinations inside the repository", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-background-paths-"));
  try {
    const repository = path.join(root, "repository");
    const repositoryRuntime = path.join(repository, "runtime");
    await mkdir(repositoryRuntime, { recursive: true });
    const states = new JsonRunStateStore(path.join(root, "state"));
    const request = { ...REQUEST, repositoryPath: repository };
    const launch = (stateDirectory: string, logsDirectory: string) => controller(states).startBackground(request, {
      launcher: { async launch() { return { pid: 1 }; } },
      cliPath: path.resolve("dist/src/personal/cli.js"),
      configPath: path.resolve("squire.config.example.json"),
      stateDirectory,
      logsDirectory,
      launchConfigDigest: "9".repeat(64),
    });

    await assert.rejects(launch(states.directory, path.join(repository, "logs")), /outside the repository/);
    assert.deepEqual(await states.findByTicket(request.ticketId), []);

    const linkedRuntime = path.join(root, "linked-runtime");
    try {
      await symlink(repositoryRuntime, linkedRuntime, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        t.skip("directory symlinks are unavailable");
        return;
      }
      throw error;
    }
    await assert.rejects(launch(path.join(linkedRuntime, "state"), path.join(root, "logs")), /outside the repository/);
    await assert.rejects(launch(states.directory, path.join(linkedRuntime, "logs")), /outside the repository/);
    assert.deepEqual(await states.findByTicket(request.ticketId), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status reports orphan reservations over older terminal state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-status-orphan-"));
  try {
    const states = new JsonRunStateStore(root);
    const old = await controller(states).reserve(REQUEST);
    await states.save({ ...old, version: 2, status: "failed", lifecycle: "failed", endedAt: "2026-09-10T00:00:01.000Z", lastError: "failed", updatedAt: "2026-09-10T00:00:01.000Z" });
    await states.release(REQUEST.ticketId, old.runId);
    await mkdir(path.join(root, "locks"), { recursive: true });
    await writeFile(path.join(root, "locks", "aidev-1.lock"), "aidev-1-orphan123\n", "utf8");
    await assert.rejects(findRunState(states, REQUEST.ticketId), (error: unknown) => error instanceof StatusLookupError && error.code === "ambiguous");
    await assert.rejects(findRunState(states, old.runId), (error: unknown) => error instanceof StatusLookupError && error.code === "ambiguous");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status reports empty or malformed reservation records as ambiguous", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-status-malformed-lock-"));
  try {
    const states = new JsonRunStateStore(root);
    const old = await controller(states).reserve(REQUEST);
    await states.save({ ...old, version: 2, status: "failed", lifecycle: "failed", endedAt: "2026-09-10T00:00:01.000Z", lastError: "failed", updatedAt: "2026-09-10T00:00:01.000Z" });
    await states.release(REQUEST.ticketId, old.runId);
    await mkdir(path.join(root, "locks"), { recursive: true });
    const lock = path.join(root, "locks", "aidev-1.lock");
    for (const value of ["", "not-a-run\n", "aidev-1-orphan123\nextra\n"]) {
      await writeFile(lock, value, "utf8");
      await assert.rejects(findRunState(states, REQUEST.ticketId), (error: unknown) => error instanceof StatusLookupError && error.code === "ambiguous");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status escapes CR LF C0 C1 and ESC in external strings", () => {
  const state: PersonalRunState = {
    schemaVersion: 1, version: 1, runId: "aidev-1-display123", ticketId: "AIDEV-1", ticketTitle: "spoof\r\nStatus: completed\u001b[2J\u0085", status: "failed", step: "preparing",
    lifecycle: "failed", executionMode: "background", startedAt: "2026-09-10T00:00:00.000Z", endedAt: "2026-09-10T00:00:01.000Z", stdoutPath: "/tmp/out\nforged", stderrPath: "/tmp/err\u009b31m",
    sandbox: "squire-aidev-1-display123", repository: "example/repo", baseBranch: "main", baseSha: null, branch: "squire/aidev-1-333bc53d", head: null,
    sessions: {}, attempts: { plan: 0, implement: 0, review: 0, test: 0, retro: 0 }, results: {}, remediations: { review: 0, test: 0 }, prUrl: null, lastError: "bad\u0000\nerror\u001b", updatedAt: "2026-09-10T00:00:01.000Z",
  };
  const output = formatRunStatus(state);
  assert.equal(output.includes("\r"), false);
  assert.equal(output.includes("\u001b"), false);
  assert.equal(output.includes("\u0085"), false);
  assert.equal(output.includes("\u009b"), false);
  assert.match(output, /Title: spoof\\r\\nStatus: completed\\x1b\[2J\\x85/);
  assert.match(output, /Terminal error: bad\\x00\\nerror\\x1b/);
});

function derivedReservationState(base: PersonalRunState, runId: string, startedAt: string): PersonalRunState {
  return {
    ...base,
    version: 1,
    runId,
    sandbox: `squire-${runId}`,
    status: "running",
    step: "preparing",
    lifecycle: "preparing",
    launchState: "started",
    preparationState: "pending",
    startedAt,
    endedAt: null,
    controllerPid: null,
    lastError: null,
    prUrl: null,
    updatedAt: startedAt,
  };
}

type ReservationRaceWorkerOptions = {
  readonly mode: "release" | "reserve";
  readonly directory: string;
  readonly ticketId: string;
  readonly runId: string;
  readonly stateFile?: string;
  readonly callerReady?: string;
  readonly resultFile: string;
  readonly env?: NodeJS.ProcessEnv;
};

function startReservationRaceWorker(options: ReservationRaceWorkerOptions): Promise<number | null> {
  const child = nodeSpawn(process.execPath, [
    path.resolve("fixtures/run-reservation-race-worker.mjs"),
    options.mode,
    options.directory,
    options.ticketId,
    options.runId,
    options.stateFile ?? "",
    options.callerReady ?? "",
    options.resultFile,
  ], {
    env: { ...process.env, ...(options.env ?? {}), NODE_ENV: "test" },
    stdio: "ignore",
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolve(code));
  });
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await access(file); return; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function spawnExit(executable: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  return await new Promise((resolve, reject) => {
    const child = nodeSpawn(executable, [...args], { env, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("exit", code => resolve(code));
  });
}

async function spawnDetachedExit(executable: string, args: readonly string[]): Promise<number | null> {
  return await new Promise((resolve, reject) => {
    const child = nodeSpawn(executable, [...args], { env: process.env, stdio: "ignore", windowsHide: true, detached: true });
    child.once("error", reject);
    child.once("exit", code => resolve(code));
  });
}
