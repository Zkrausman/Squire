import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import type { PiProcess, PiProcessFactory, ProcessLaunch } from "../../src/pi/pi-process.js";

export class RealPiProcess extends EventEmitter implements PiProcess {
  readonly identity = `real-pi-${randomUUID()}`;
  readonly stdin: PiProcess["stdin"];
  readonly stdout: PiProcess["stdout"];
  readonly stderr: PiProcess["stderr"];
  readonly output: string[] = [];
  readonly errors: string[] = [];
  stdinError: Error | undefined;
  exitCode: number | null = null;

  constructor(readonly child: ChildProcess) {
    super();
    if (!child.stdin || !child.stdout || !child.stderr) throw new Error("Pi child did not expose piped stdio");
    this.stdin = { write: data => child.stdin!.write(data) };
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    child.stdout.on("data", chunk => this.output.push(chunk.toString()));
    child.stderr.on("data", chunk => this.errors.push(chunk.toString()));
    child.stdin.on("error", error => {
      this.stdinError = error;
      this.errors.push(`stdin: ${error.message}`);
      // A broken RPC pipe is a failed test child, not a diagnostic to discard.
      // Force the normal observed-exit path so PiRpcClient rejects its pending
      // command instead of leaving the child alive after an asynchronous EPIPE.
      if (this.exitCode === null && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    });
    child.once("error", error => this.errors.push(`child: ${error.message}`));
    child.once("exit", (code, signal) => {
      this.exitCode = code ?? (signal === "SIGTERM" ? 143 : 1);
      this.emit("exit", code, signal);
    });
  }

  override on(event: "exit", listener: (code: number | null, signal: string | null) => void): this {
    return super.on(event, listener);
  }

  kill(signal: "SIGTERM" | "SIGKILL"): boolean { return this.child.kill(signal); }

  async waitForExit(timeoutMs: number): Promise<void> {
    if (this.exitCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("exit", onExit);
        reject(new Error("Pi child exit timeout"));
      }, timeoutMs);
      timer.unref?.();
      const onExit = (): void => { clearTimeout(timer); resolve(); };
      this.once("exit", onExit);
    });
  }
}

export class RealPiProcessFactory implements PiProcessFactory {
  readonly launches: ProcessLaunch[] = [];
  readonly processes: RealPiProcess[] = [];

  async spawn(spec: ProcessLaunch, signal?: AbortSignal, onSpawn?: (process: PiProcess) => void): Promise<RealPiProcess> {
    if (signal?.aborted) throw new Error("spawn aborted");
    const child = spawnChild(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...spec.env, PI_OFFLINE: "1" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const process = new RealPiProcess(child);
    this.launches.push(spec);
    this.processes.push(process);
    onSpawn?.(process);
    return process;
  }
}
