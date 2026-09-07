import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import type { PiProcess, PiProcessFactory, ProcessLaunch } from "../../src/pi/pi-process.js";
import {
  BoundedRedactionAccumulator,
  BoundedRedactor,
  PI_CHILD_DIAGNOSTIC_LIMIT_BYTES,
  PI_CHILD_OUTPUT_LIMIT_BYTES,
  PI_CHILD_STDERR_LIMIT_BYTES,
  preparePiChildLaunch,
  sanitizeError,
  sanitizeLaunch,
  truncateUtf8,
} from "./pi-child-support.js";

type TerminalState = "running" | "exited" | "startup-error" | "closed-without-exit";

type DiagnosticSnapshot = Readonly<{
  rendered: string;
  terminalState: TerminalState;
  stderrBytes: number;
  stderrDroppedBytes: number;
}>;

class RealPiProcessDiagnosticError extends Error {
  constructor(snapshot: DiagnosticSnapshot, reason: string) {
    super(snapshot.rendered);
    this.name = "RealPiProcessDiagnosticError";
    // Deliberately expose only a frozen scalar snapshot. In particular, do not
    // retain a RealPiProcess, ChildProcess, launch spec, raw environment, or
    // source Error as an enumerable property or cause.
    Object.defineProperty(this, "details", {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Object.freeze({
        reason: truncateUtf8(reason, 1_024),
        terminalState: snapshot.terminalState,
        stderrBytes: snapshot.stderrBytes,
        stderrDroppedBytes: snapshot.stderrDroppedBytes,
      }),
    });
  }
}

export class RealPiProcess extends EventEmitter implements PiProcess {
  readonly identity = `real-pi-${randomUUID()}`;
  readonly stdin: PiProcess["stdin"];
  readonly stdout: PiProcess["stdout"];
  readonly stderr: PiProcess["stderr"];
  /** Process errors only; stderr is retained once in the bounded accumulator. */
  readonly errors: string[] = [];
  private readonly stdoutTail: BoundedRedactionAccumulator;
  private readonly stderrTail: BoundedRedactionAccumulator;
  private readonly errorTail: BoundedRedactionAccumulator;
  private readonly redactor: BoundedRedactor;
  readonly spawnCommand: string;
  readonly spawnArgs: readonly string[];
  readonly startedAt: number;
  readonly launch: ProcessLaunch;
  readonly environment: Readonly<Record<string, string>>;
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
    launch: ProcessLaunch,
    environment: Readonly<Record<string, string>>,
    spawnCommand: string,
    spawnArgs: readonly string[],
    redactor: BoundedRedactor,
    startedAt = Date.now(),
  ) {
    super();
    if (!child.stdin || !child.stdout || !child.stderr) throw new Error("Pi child did not expose piped stdio");
    this.redactor = redactor;
    this.environment = Object.freeze({ ...environment });
    this.launch = sanitizeLaunch(launch, this.environment, redactor);
    this.spawnCommand = truncateUtf8(redactor.redact(spawnCommand), 512);
    this.spawnArgs = Object.freeze(spawnArgs.slice(0, 64).map(value => truncateUtf8(redactor.redact(value), 512)));
    this.startedAt = startedAt;
    this.stdoutTail = new BoundedRedactionAccumulator(PI_CHILD_OUTPUT_LIMIT_BYTES, redactor);
    this.stderrTail = new BoundedRedactionAccumulator(PI_CHILD_STDERR_LIMIT_BYTES, redactor);
    this.errorTail = new BoundedRedactionAccumulator(PI_CHILD_STDERR_LIMIT_BYTES, redactor);
    this.stdin = { write: data => this.writeToChild(data) };
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    child.stdout.on("data", chunk => this.stdoutTail.append(chunk));
    child.stderr.on("data", chunk => this.stderrTail.append(chunk));
    child.stdin.on("error", error => {
      if (this.stdinError) return;
      this.stdinError = sanitizeError(error, this.redactor);
      this.recordError("stdin", this.stdinError);
      // A broken RPC pipe is a failed test child, not a diagnostic to discard.
      // Force the normal observed-exit path so PiRpcClient rejects its pending
      // command instead of leaving the child alive after an asynchronous EPIPE.
      if (this.terminalState === "running" && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    });
    child.once("error", error => {
      if (this.childError) return;
      this.childError = sanitizeError(error, this.redactor);
      this.recordError("child", this.childError);
    });
    child.once("exit", (code, signal) => {
      this.exitObservedAt = Date.now();
      this.exitSignal = signal;
      this.exitCode = code;
      this.settle("exited", code, signal);
    });
    child.once("close", () => {
      this.closeObservedAt = Date.now();
      if (!this.#exitEmitted) this.settle(this.childError ? "startup-error" : "closed-without-exit", null, null);
    });
  }

  /** Bounded compatibility views; output and stderr are retained once each. */
  get output(): string { return this.stdoutTail.text(); }
  get stderrOutput(): string { return this.stderrTail.text(); }

  override on(event: "exit", listener: (code: number | null, signal: string | null) => void): this {
    return super.on(event, listener);
  }

  private recordError(kind: string, error: Error): void {
    const bounded = `${kind}: ${truncateUtf8(this.redactor.redact(error.message), PI_CHILD_STDERR_LIMIT_BYTES)}`;
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
      throw new RealPiProcessDiagnosticError(this.diagnosticSnapshot("Pi child rejected RPC write before the handshake"), "Pi child rejected RPC write before the handshake");
    }
    const accepted = stream.write(data);
    if (!accepted && (this.terminalState !== "running" || this.child.exitCode !== null || this.child.signalCode !== null || stream.destroyed || !stream.writable)) {
      throw new RealPiProcessDiagnosticError(this.diagnosticSnapshot("Pi child rejected RPC write during the handshake"), "Pi child rejected RPC write during the handshake");
    }
    return accepted;
  }

  private diagnosticSnapshot(reason: string): DiagnosticSnapshot {
    const safeEnvironment = Object.fromEntries(Object.entries(this.environment)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, truncateUtf8(this.redactor.redact(value), 512)]));
    const safeArgs = this.spawnArgs.map(value => truncateUtf8(this.redactor.redact(value), 512));
    const stderr = this.stderrTail.text() || "<empty>";
    const observedErrors = this.errorTail.text() || "<empty>";
    const rawExit = this.child.exitCode === null ? "null" : String(this.child.exitCode);
    const normalizedExit = this.exitCode === null ? "null" : String(this.exitCode);
    const elapsedMs = Date.now() - this.startedAt;
    const exitElapsedMs = this.exitObservedAt === undefined ? "unknown" : String(this.exitObservedAt - this.startedAt);
    const closeElapsedMs = this.closeObservedAt === undefined ? "unknown" : String(this.closeObservedAt - this.startedAt);
    const settledElapsedMs = this.settledAt === undefined ? "unknown" : String(this.settledAt - this.startedAt);
    const rendered = `${this.redactor.redact(truncateUtf8(reason, 1_024))}; requestedCommand=${JSON.stringify(this.launch.command)}; spawnCommand=${JSON.stringify(this.spawnCommand)}; args=${JSON.stringify(safeArgs)}; cwd=${JSON.stringify(this.launch.cwd)}; env=${JSON.stringify(safeEnvironment)}; terminalState=${this.terminalState}; rawExit=${rawExit}; normalizedExit=${normalizedExit}; signal=${JSON.stringify(this.exitSignal)}; elapsedMs=${elapsedMs}; exitElapsedMs=${exitElapsedMs}; closeElapsedMs=${closeElapsedMs}; settledElapsedMs=${settledElapsedMs}; stdinDestroyed=${String(this.child.stdin?.destroyed ?? true)}; stdinWritable=${String(this.child.stdin?.writable ?? false)}; observedErrors=${JSON.stringify(observedErrors)}; stderr=${JSON.stringify(stderr)}`;
    return {
      rendered: truncateUtf8(this.redactor.redact(rendered), PI_CHILD_DIAGNOSTIC_LIMIT_BYTES),
      terminalState: this.terminalState,
      stderrBytes: this.stderrTail.retainedBytes,
      stderrDroppedBytes: this.stderrTail.droppedBytes,
    };
  }

  diagnostic(reason: string): string {
    return this.diagnosticSnapshot(reason).rendered;
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
    const redactor = new BoundedRedactor(this.ambientEnvironment, spec.env);
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
      redactor,
      startedAt,
    );
    this.launches.push(sanitizeLaunch(spec, prepared.environment, redactor));
    this.processes.push(process);
    onSpawn?.(process);
    return process;
  }
}