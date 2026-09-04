import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildGitEnvironment, GitCommandAbortedError, GitCommandError, GitCommandRunner, GitCommandUncertainError, type GitChildProcess, type GitProcessFactory } from "../src/git/git-command.js";

class FakeGitProcess extends EventEmitter implements GitChildProcess {
  readonly stdout = new EventEmitter() as GitChildProcess["stdout"];
  readonly stderr = new EventEmitter() as GitChildProcess["stderr"];
  exitCode: number | null = null;
  constructor(readonly identity: string) { super(); }
  kill(): boolean { this.exitCode = 143; this.emit("exit", null, "SIGTERM"); return true; }
  async waitForExit(): Promise<void> { if (this.exitCode === null) { this.exitCode = 0; this.emit("exit", 0, null); } }
  override on(event: "exit", listener: (code: number | null, signal: string | null) => void): this { return super.on(event, listener); }
}

function factoryReturning(callbackProcess: FakeGitProcess, returnedProcess: FakeGitProcess): GitProcessFactory {
  return { spawn: async (_spec, _signal, onSpawn) => { onSpawn?.(callbackProcess); setImmediate(() => { if (returnedProcess.exitCode === null) { returnedProcess.exitCode = 0; returnedProcess.emit("exit", 0, null); } }); return returnedProcess; } };
}

test("Git execution builds a fresh credential-free environment and uses bounded argv", async () => {
  const environment = buildGitEnvironment({ runId: "run_example01", ticketRoot: "/ticket", allowNetwork: false });
  assert.equal(environment["GIT_ALLOW_PROTOCOL"], "");
  assert.equal(environment["GIT_CONFIG_NOSYSTEM"], "1");
  assert.equal(environment["GIT_TERMINAL_PROMPT"], "0");
  assert.equal(environment["GIT_DIR"], undefined);
  assert.equal(environment["GIT_SSH_COMMAND"], undefined);
  assert.throws(() => buildGitEnvironment({ runId: "run_example01", ticketRoot: "/ticket", allowNetwork: false, extra: { GIT_DIR: "/host/repo" } }), /untrusted Git environment/);
  assert.throws(() => buildGitEnvironment({ runId: "run_example01", ticketRoot: "/ticket", allowNetwork: false, extra: { GIT_ALLOW_PROTOCOL: "ssh" } }), /protocol allowlist/);
  await assert.rejects(() => new GitCommandRunner().run(["status", "bad\narg"], { cwd: "/ticket", runId: "run_example01" }), /argv contains invalid/);
});

test("Git execution refuses process identity substitution at the spawn boundary", async () => {
  const callback = new FakeGitProcess("git-callback");
  const returned = new FakeGitProcess("git-returned");
  const runner = new GitCommandRunner({ processFactory: factoryReturning(callback, returned) });
  await assert.rejects(() => runner.run(["--version"], { cwd: "/ticket", runId: "run_example01" }), GitCommandUncertainError);
});

class RealChild implements GitChildProcess {
  readonly identity: string;
  readonly stdout: GitChildProcess["stdout"];
  readonly stderr: GitChildProcess["stderr"];
  exitCode: number | null = null;
  exitSignal: string | null = null;
  readonly signals: string[] = [];
  constructor(readonly child: ChildProcess) {
    this.identity = `real-git-test-${child.pid ?? "unknown"}-${Math.random()}`;
    this.stdout = child.stdout as GitChildProcess["stdout"];
    this.stderr = child.stderr as GitChildProcess["stderr"];
    child.once("exit", (code, signal) => { this.exitCode = code ?? (signal ? 143 : 1); this.exitSignal = signal; this.emitExit(code, signal); });
  }
  #listeners: Array<(code: number | null, signal: string | null) => void> = [];
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): this { if (event === "exit") this.#listeners.push(listener); return this; }
  private emitExit(code: number | null, signal: string | null): void { for (const listener of [...this.#listeners]) listener(code, signal); }
  kill(signal: "SIGTERM" | "SIGKILL"): boolean { this.signals.push(signal); return this.child.kill(signal); }
  async waitForExit(timeoutMs: number): Promise<void> {
    if (this.exitCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("real test child exit timeout")), timeoutMs);
      this.on("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

class RealProcessFactory implements GitProcessFactory {
  last?: RealChild;
  #spawnWaiters: Array<() => void> = [];
  waitForNextSpawn(): Promise<void> { return new Promise(resolve => this.#spawnWaiters.push(resolve)); }
  async spawn(spec: { command: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>> }, signal?: AbortSignal, onSpawn?: (process: GitChildProcess) => void | Promise<void>, passFileDescriptors: readonly number[] = []): Promise<GitChildProcess> {
    const child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: { ...spec.env }, shell: false, stdio: ["ignore", "pipe", "pipe", ...passFileDescriptors] });
    const process = new RealChild(child);
    this.last = process;
    await onSpawn?.(process);
    if (signal) {
      const abort = (): void => { if (process.exitCode === null) process.kill("SIGTERM"); };
      signal.addEventListener("abort", abort, { once: true });
      process.on("exit", () => signal.removeEventListener("abort", abort));
    }
    for (const resolve of this.#spawnWaiters.splice(0)) resolve();
    return process;
  }
}

test("real Git supervisor observes immediate/abnormal exits, bounds output, and escalates cancellation", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-git-command-real-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, "git-test-child.mjs");
  await writeFile(script, `#!/usr/bin/env ${process.execPath}\nconst mode = process.argv[3];\nif (mode === "fail") process.exit(7);\nif (mode === "overflow") { process.on("SIGTERM", () => process.exit(143)); process.stdout.write("x".repeat(4096)); setInterval(() => {}, 1000); }\nif (mode === "sleep") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }\nif (mode === "immediate") { process.stdout.write("observed\\n"); process.exit(0); }
if (!mode) process.exit(0);\n`);
  await chmod(script, 0o700);
  const factory = new RealProcessFactory();
  const runner = new GitCommandRunner({ gitBinary: script, processFactory: factory, defaultTimeoutMs: 5_000, defaultMaxOutputBytes: 256 });
  let observed = false;
  const immediate = await runner.run(["immediate"], { cwd: root, ticketRoot: root, runId: "run_example01", onObservedExit: () => { observed = true; } });
  assert.equal(immediate.stdout, "observed\n");
  assert.equal(observed, true);
  const delayedAcknowledgement = await runner.run(["immediate"], { cwd: root, ticketRoot: root, runId: "run_example01", onSpawn: async process => { await process.waitForExit(5_000); } });
  assert.equal(delayedAcknowledgement.stdout, "observed\n", "output must be collected before durable spawn acknowledgement settles");
  await assert.rejects(() => runner.run(["fail"], { cwd: root, ticketRoot: root, runId: "run_example01" }), (error: unknown) => error instanceof GitCommandError && error.result?.exitCode === 7);
  await assert.rejects(() => runner.run(["overflow"], { cwd: root, ticketRoot: root, runId: "run_example01", timeoutMs: 5_000, maxOutputBytes: 256 }), GitCommandError);
  assert.equal(factory.last?.signals[0], "SIGTERM");
  const controller = new AbortController();
  const spawned = factory.waitForNextSpawn();
  const cancellation = runner.run(["sleep"], { cwd: root, ticketRoot: root, runId: "run_example01", timeoutMs: 5_000, signal: controller.signal });
  await spawned;
  controller.abort();
  await assert.rejects(() => cancellation, GitCommandAbortedError);
  assert.ok((factory.last?.signals.length ?? 0) >= 2, "cancellation must escalate a noncooperative child");
});
