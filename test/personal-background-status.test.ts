import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn as nodeSpawn } from "node:child_process";
import { NodeBackgroundLauncher } from "../src/personal/background-launcher.js";
import { PersonalMvpController } from "../src/personal/controller.js";
import { JsonRunStateStore } from "../src/personal/json-run-state.js";
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
      paths: { state: path.join(root, "state"), bridges: path.join(root, "bridges"), staging: path.join(root, "staging"), logs: path.join(root, "logs") },
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

test("terminal reservation release cannot delete a concurrently acquired new owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-release-race-"));
  try {
    const states = new JsonRunStateStore(root);
    const old = await controller(states).reserve(REQUEST);
    await states.save({ ...old, version: 2, status: "interrupted", lifecycle: "interrupted", endedAt: "2026-09-10T00:00:01.000Z", lastError: "stopped", updatedAt: "2026-09-10T00:00:01.000Z" });
    const nextController = controller(states, new Date("2026-09-10T00:00:02.000Z"), "21234567-89ab-cdef-0123-456789abcdef");
    const [, firstReserve] = await Promise.allSettled([states.release(REQUEST.ticketId, old.runId), nextController.reserve(REQUEST)]);
    const next = firstReserve.status === "fulfilled" ? firstReserve.value : await nextController.reserve(REQUEST);
    assert.equal(await states.reservationOwner(REQUEST.ticketId), next.runId);
    await assert.rejects(controller(states, new Date(), "31234567-89ab-cdef-0123-456789abcdef").reserve(REQUEST), /active or ambiguous reservation/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("child bootstrap failure persists through the original state-directory fallback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-bootstrap-fallback-"));
  try {
    const states = new JsonRunStateStore(path.join(root, "state"));
    const digest = "b".repeat(64);
    const reserved = await controller(states).reserve(REQUEST, { executionMode: "background", launchConfigDigest: digest });
    const exit = await spawnExit(process.execPath, [
      path.resolve("dist/src/personal/cli.js"), "run", REQUEST.ticketId,
      "--config", path.join(root, "missing-config.json"),
      "--reserved-run-id", reserved.runId,
      "--reserved-config-sha256", digest,
    ], { ...process.env, SQUIRE_STATE_DIRECTORY: states.directory });
    assert.equal(exit, 1);
    const failed = await states.read(reserved.runId);
    assert.equal(failed?.status, "failed");
    assert.match(failed?.lastError ?? "", /ENOENT/);
    assert.equal(await states.reservationOwner(REQUEST.ticketId), undefined);
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
