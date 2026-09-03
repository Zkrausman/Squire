import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { buildGitEnvironment, GitCommandRunner, GitCommandUncertainError, type GitChildProcess, type GitProcessFactory } from "../src/git/git-command.js";

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
