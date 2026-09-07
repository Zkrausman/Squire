import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import type { PiProcess, PiProcessFactory, ProcessLaunch } from "../../src/pi/pi-process.js";
import {
  BoundedTail,
  collectSensitiveValues,
  PI_CHILD_DIAGNOSTIC_LIMIT_BYTES,
  PI_CHILD_OUTPUT_LIMIT_BYTES,
  PI_CHILD_STDERR_LIMIT_BYTES,
  preparePiChildLaunch,
  redactText,
  truncateUtf8,
} from "./pi-child-support.js";

type TerminalState = "running" | "exited" | "startup-error" | "closed-without-exit";

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
  /** Process errors only; stderr is retained once in the bounded stderr tail. */
  readonly errors: string[] = [];
  private readonly stdoutTail = new BoundedTail(PI_CHILD_OUTPUT_LIMIT_BYTES);
  private readonly stderrTail = new BoundedTail(PI_CHILD_STDERR_LIMIT_BYTES);
  private readonly errorTail = new BoundedTail(PI_CHILD_STDERR_LIMIT_BYTES);
  private readonly redactionValues: readonly string[];
  readonly spawnCommand: string;
  readonly spawnArgs: readonly string[];
  readonly startedAt: number;
  terminalState: TerminalState = "running";
  stdinError: Error | undefined;
  childError: Error | undefined;
  exitCode: number | null = null;
  exitSignal: string | null = null;
  exitObservedAt: number | undefined;
  closeObservedAt: number | undefined;
  settledAt: number | undefined;
  #exitEmitted = false;

  constructor(
    readonly child: ChildProcess,
    readonly launch: ProcessLaunch,
    readonly environment: Readonly<Record<string, string>>,
    spawnCommand: string,
    spawnArgs: readonly string[],
    redactionValues: readonly string[],
    startedAt = Date.now(),
  ) {
    super();
    if (!child.stdin || !child.stdout || !child.stderr) throw new Error("Pi child did not expose piped stdio");
    this.spawnCommand = spawnCommand;
    this.spawnArgs = [...spawnArgs];
    this.redactionValues = redactionValues;
    this.startedAt = startedAt;
    this.stdin = { write: data => this.writeToChild(data) };
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    child.stdout.on("data", chunk => this.stdoutTail.append(chunk));
    child.stderr.on("data", chunk => this.stderrTail.append(chunk));
    child.stdin.on("error", error => {
      this.stdinError = error;
      this.recordError(`stdin: ${error.message}`);
      // A broken RPC pipe is a failed test child, not a diagnostic to discard.
      // Force the normal observed-exit path so PiRpcClient rejects its pending
      // command instead of leaving the child alive after an asynchronous EPIPE.
      if (this.terminalState === "running" && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    });
    child.once("error", error => {
      this.childError = error;
      this.recordError(`child: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      this.exitObservedAt = Date.now();
      this.exitSignal = signal;
      this.exitCode = code ?? (signal === "SIGTERM" ? 143 : 1);
      this.settle("exited", code, signal);
    });
    child.once("close", () => {
      this.closeObservedAt = Date.now();
      if (!this.#exitEmitted) this.settle(this.childError ? "startup-error" : "closed-without-exit", null, null);
    });
  }

  /** Bounded compatibility views; output and stderr are retained once each. */
  get output(): string { return this.stdoutTail.toString(); }
  get stderrOutput(): string { return redactText(this.stderrTail.toString(), this.redactionValues); }

  override on(event: "exit", listener: (code: number | null, signal: string | null) => void): this {
    return super.on(event, listener);
  }

  private recordError(message: string): void {
    const bounded = truncateUtf8(message, PI_CHILD_STDERR_LIMIT_BYTES);
    this.errors.push(bounded);
    this.errorTail.append(bounded);
    while (this.errors.length > 8) this.errors.shift();
  }

  private settle(state: Exclude<TerminalState, "running">, code: number | null, signal: string | null): void {
    if (this.#exitEmitted) return;
    this.#exitEmitted = true;
    this.terminalState = state;
    this.settledAt = Date.now();
    this.emit("exit", code, signal);
  }

  private writeToChild(data: string): boolean {
    const stream = this.child.stdin;
    if (!stream || this.terminalState !== "running" || this.childError || this.child.exitCode !== null || this.child.signalCode !== null || stream.destroyed || !stream.writable) {
      throw new RealPiProcessDiagnosticError(this, "Pi child rejected RPC write before the handshake");
    }
    const accepted = stream.write(data);
    if (!accepted && (this.terminalState !== "running" || this.child.exitCode !== null || this.child.signalCode !== null || stream.destroyed || !stream.writable)) {
      throw new RealPiProcessDiagnosticError(this, "Pi child rejected RPC write during the handshake");
    }
    return accepted;
  }

  diagnostic(reason: string): string {
    const safeEnvironment = Object.fromEntries(Object.entries(this.environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, redactText(truncateUtf8(value, 512), this.redactionValues)]));
    const safeArgs = this.spawnArgs.map(value => redactText(truncateUtf8(value, 512), this.redactionValues));
    const stderr = redactText(this.stderrTail.toString(), this.redactionValues) || "<empty>";
    const observedErrors = redactText(this.errorTail.toString(), this.redactionValues) || "<empty>";
    const rawExit = this.child.exitCode === null ? "null" : String(this.child.exitCode);
    const normalizedExit = this.exitCode === null ? "null" : String(this.exitCode);
    const elapsedMs = Date.now() - this.startedAt;
    const exitElapsedMs = this.exitObservedAt === undefined ? "unknown" : String(this.exitObservedAt - this.startedAt);
    const closeElapsedMs = this.closeObservedAt === undefined ? "unknown" : String(this.closeObservedAt - this.startedAt);
    const settledElapsedMs = this.settledAt === undefined ? "unknown" : String(this.settledAt - this.startedAt);
    const rendered = `${reason}; requestedCommand=${JSON.stringify(truncateUtf8(this.launch.command, 512))}; spawnCommand=${JSON.stringify(truncateUtf8(this.spawnCommand, 512))}; args=${JSON.stringify(safeArgs)}; cwd=${JSON.stringify(truncateUtf8(this.launch.cwd, 512))}; env=${JSON.stringify(safeEnvironment)}; terminalState=${this.terminalState}; rawExit=${rawExit}; normalizedExit=${normalizedExit}; signal=${JSON.stringify(this.exitSignal)}; elapsedMs=${elapsedMs}; exitElapsedMs=${exitElapsedMs}; closeElapsedMs=${closeElapsedMs}; settledElapsedMs=${settledElapsedMs}; stdinDestroyed=${String(this.child.stdin?.destroyed ?? true)}; stdinWritable=${String(this.child.stdin?.writable ?? false)}; observedErrors=${JSON.stringify(observedErrors)}; stderr=${JSON.stringify(stderr)}`;
    return truncateUtf8(redactText(rendered, this.redactionValues), PI_CHILD_DIAGNOSTIC_LIMIT_BYTES);
  }

  kill(signal: "SIGTERM" | "SIGKILL"): boolean {
    if (this.terminalState !== "running") return false;
    return this.child.kill(signal);
  }

  async waitForExit(timeoutMs: number): Promise<void> {
    if (this.terminalState !== "running") return;
    await new Promise<void>((resolve, reject) => {
      const onExit = (): void => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        this.off("exit", onExit);
        reject(new Error("Pi child exit timeout"));
      }, timeoutMs);
      this.once("exit", onExit);
      if (this.terminalState !== "running") onExit();
    });
  }
}

export class RealPiProcessFactory implements PiProcessFactory {
  readonly launches: ProcessLaunch[] = [];
  readonly processes: RealPiProcess[] = [];

  constructor(readonly ambientEnvironment: Readonly<Record<string, string | undefined>> = process.env) {}

  async spawn(spec: ProcessLaunch, signal?: AbortSignal, onSpawn?: (process: PiProcess) => void): Promise<RealPiProcess> {
    if (signal?.aborted) throw new Error("spawn aborted");
    const startedAt = Date.now();
    const prepared = preparePiChildLaunch(spec);
    const child = spawnChild(prepared.command, [...prepared.args], {
      cwd: spec.cwd,
      env: prepared.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const process = new RealPiProcess(
      child,
      spec,
      prepared.environment,
      prepared.command,
      prepared.args,
      collectSensitiveValues(this.ambientEnvironment, spec.env),
      startedAt,
    );
    this.launches.push(spec);
    this.processes.push(process);
    onSpawn?.(process);
    return process;
  }
}