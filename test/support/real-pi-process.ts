import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import type { PiProcess, PiProcessFactory, ProcessLaunch } from "../../src/pi/pi-process.js";

const DIAGNOSTIC_STDERR_LIMIT = 8_192;

function cleanPiEnvironment(overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_"))),
    ...overrides,
  };
}

class RealPiProcessDiagnosticError extends Error {
  constructor(readonly process: RealPiProcess, readonly reason: string) {
    super(reason);
    this.name = "RealPiProcessDiagnosticError";
    Object.defineProperty(this, "message", {
      configurable: true,
      enumerable: false,
      get: () => process.diagnostic(reason),
    });
  }
}

export class RealPiProcess extends EventEmitter implements PiProcess {
  readonly identity = `real-pi-${randomUUID()}`;
  readonly stdin: PiProcess["stdin"];
  readonly stdout: PiProcess["stdout"];
  readonly stderr: PiProcess["stderr"];
  readonly output: string[] = [];
  readonly errors: string[] = [];
  readonly stderrOutput: string[] = [];
  stdinError: Error | undefined;
  childError: Error | undefined;
  exitCode: number | null = null;
  exitSignal: string | null = null;
  exitObservedAt: number | undefined;
  closeObservedAt: number | undefined;

  constructor(readonly child: ChildProcess, readonly launch: ProcessLaunch, readonly environment: Readonly<Record<string, string>>, readonly startedAt = Date.now()) {
    super();
    if (!child.stdin || !child.stdout || !child.stderr) throw new Error("Pi child did not expose piped stdio");
    this.stdin = { write: data => this.writeToChild(data) };
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    child.stdout.on("data", chunk => this.output.push(chunk.toString()));
    child.stderr.on("data", chunk => {
      const text = chunk.toString();
      this.stderrOutput.push(text);
      this.errors.push(text);
    });
    child.stdin.on("error", error => {
      this.stdinError = error;
      this.errors.push(`stdin: ${error.message}`);
      // A broken RPC pipe is a failed test child, not a diagnostic to discard.
      // Force the normal observed-exit path so PiRpcClient rejects its pending
      // command instead of leaving the child alive after an asynchronous EPIPE.
      if (this.exitCode === null && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    });
    child.once("error", error => {
      this.childError = error;
      this.errors.push(`child: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      this.exitSignal = signal;
      this.exitObservedAt = Date.now();
      this.exitCode = code ?? (signal === "SIGTERM" ? 143 : 1);
      this.emit("exit", code, signal);
    });
    child.once("close", () => { this.closeObservedAt = Date.now(); });
  }

  override on(event: "exit", listener: (code: number | null, signal: string | null) => void): this {
    return super.on(event, listener);
  }

  private writeToChild(data: string): boolean {
    const stream = this.child.stdin;
    if (!stream || this.childError || this.child.exitCode !== null || this.child.signalCode !== null || stream.destroyed || !stream.writable) {
      throw new RealPiProcessDiagnosticError(this, "Pi child rejected RPC write before the handshake");
    }
    const accepted = stream.write(data);
    if (!accepted && (this.child.exitCode !== null || this.child.signalCode !== null || stream.destroyed || !stream.writable)) {
      throw new RealPiProcessDiagnosticError(this, "Pi child rejected RPC write during the handshake");
    }
    return accepted;
  }

  diagnostic(reason: string): string {
    const env = Object.fromEntries(Object.entries(this.environment)
      .filter(([key]) => key === "PATH" || key === "HOME" || key === "WIKI_HOME" || key === "CI" || key.startsWith("PI_") || key.startsWith("SQUIRE_"))
      .sort(([left], [right]) => left.localeCompare(right)));
    const stderr = this.stderrOutput.join("").slice(-DIAGNOSTIC_STDERR_LIMIT) || "<empty>";
    const observedErrors = this.errors.join("").slice(-DIAGNOSTIC_STDERR_LIMIT) || "<empty>";
    const rawExit = this.child.exitCode === null ? "null" : String(this.child.exitCode);
    const normalizedExit = this.exitCode === null ? "null" : String(this.exitCode);
    const elapsedMs = Date.now() - this.startedAt;
    const exitElapsedMs = this.exitObservedAt === undefined ? "unknown" : String(this.exitObservedAt - this.startedAt);
    const closeElapsedMs = this.closeObservedAt === undefined ? "unknown" : String(this.closeObservedAt - this.startedAt);
    return `${reason}; command=${JSON.stringify(this.launch.command)}; args=${JSON.stringify(this.launch.args)}; cwd=${JSON.stringify(this.launch.cwd)}; env=${JSON.stringify(env)}; rawExit=${rawExit}; normalizedExit=${normalizedExit}; signal=${JSON.stringify(this.exitSignal)}; elapsedMs=${elapsedMs}; exitElapsedMs=${exitElapsedMs}; closeElapsedMs=${closeElapsedMs}; stdinDestroyed=${String(this.child.stdin?.destroyed ?? true)}; stdinWritable=${String(this.child.stdin?.writable ?? false)}; observedErrors=${JSON.stringify(observedErrors)}; stderr=${JSON.stringify(stderr)}`;
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
    const startedAt = Date.now();
    const environment = cleanPiEnvironment({ ...spec.env, PI_OFFLINE: "1" });
    const child = spawnChild(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const process = new RealPiProcess(child, spec, environment as Record<string, string>, startedAt);
    this.launches.push(spec);
    this.processes.push(process);
    onSpawn?.(process);
    return process;
  }
}
