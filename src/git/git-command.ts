import { randomUUID } from "node:crypto";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { ProcessLaunch } from "../pi/pi-process.js";
import { assertRunId } from "./identity.js";
import { assertPathWithin, assertTicketRoot, inspectResource } from "./paths.js";

export interface GitReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
  on(event: "end", listener: () => void): this;
}

export interface GitChildProcess {
  readonly identity: string;
  readonly stdout: GitReadable;
  readonly stderr: GitReadable;
  readonly exitCode: number | null;
  /** The observed OS signal, when the supervisor received one. */
  readonly exitSignal?: string | null;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
  kill(signal: "SIGTERM" | "SIGKILL"): boolean;
  waitForExit(timeoutMs: number): Promise<void>;
}

export interface GitProcessFactory {
  /** The callback is awaited before spawn settlement, making durable process
   * ownership a required supervisor handshake rather than fire-and-forget. */
  spawn(spec: ProcessLaunch, signal?: AbortSignal, onSpawn?: (process: GitChildProcess) => void | Promise<void>, passFileDescriptors?: readonly number[]): Promise<GitChildProcess>;
}

export interface GitProcessIdentityResolver {
  resolve(processIdentity: string, signal?: AbortSignal): Promise<GitChildProcess | undefined>;
}

export interface GitCommandOptions {
  readonly cwd: string;
  readonly runId: string;
  readonly ticketRoot?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly allowExitCodes?: readonly number[];
  readonly allowNetwork?: boolean;
  readonly extraEnv?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly passFileDescriptors?: readonly number[];
  readonly onSpawn?: (process: GitChildProcess) => void | Promise<void>;
  readonly onObservedExit?: (process: GitChildProcess, result: GitCommandResult) => void | Promise<void>;
}

export interface GitCommandResult {
  readonly commandId: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly processIdentity: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitCommandRunnerOptions {
  readonly gitBinary?: string;
  readonly processFactory?: GitProcessFactory;
  readonly defaultTimeoutMs?: number;
  readonly defaultMaxOutputBytes?: number;
  readonly pathEnvironment?: string;
}

export class GitCommandError extends Error {
  constructor(message: string, readonly result?: GitCommandResult) {
    super(message);
    this.name = "GitCommandError";
  }
}

export class GitCommandUncertainError extends GitCommandError {
  constructor(message: string, result?: GitCommandResult) {
    super(message, result);
    this.name = "GitCommandUncertainError";
  }
}

export class GitCommandAbortedError extends GitCommandError {
  constructor(message: string, result?: GitCommandResult) {
    super(message, result);
    this.name = "GitCommandAbortedError";
  }
}

class ChildGitProcess extends EventEmitter implements GitChildProcess {
  readonly identity: string;
  readonly stdout: GitReadable;
  readonly stderr: GitReadable;
  exitCode: number | null = null;
  exitSignal: string | null = null;

  constructor(readonly child: ChildProcess) {
    super();
    this.identity = `git-pid-${child.pid ?? "unknown"}-${randomUUID()}`;
    if (!child.stdout || !child.stderr) throw new Error("Git child did not expose bounded stdout/stderr");
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    child.once("exit", (code, signal) => {
      this.exitSignal = signal;
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
        reject(new Error("Git child exit timeout"));
      }, timeoutMs);
      timer.unref?.();
      const onExit = (): void => { clearTimeout(timer); resolve(); };
      this.once("exit", onExit);
    });
  }
}

class DefaultGitProcessFactory implements GitProcessFactory {
  async spawn(spec: ProcessLaunch, signal?: AbortSignal, onSpawn?: (process: GitChildProcess) => void | Promise<void>, passFileDescriptors: readonly number[] = []): Promise<GitChildProcess> {
    if (signal?.aborted) throw new GitCommandAbortedError("Git command was aborted before spawn");
    const stdio: Array<"ignore" | "pipe" | number> = ["ignore", "pipe", "pipe", ...passFileDescriptors];
    const child = spawnChild(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...spec.env },
      shell: false,
      stdio,
    });
    const process = new ChildGitProcess(child);
    try { await onSpawn?.(process); }
    catch (error) {
      // A child whose durable identity could not be acknowledged is never
      // returned as a clean failure. Try to terminate it, but let the caller
      // retain an unresolved allocation if the exit cannot be observed.
      if (process.exitCode === null) process.kill("SIGKILL");
      try { await process.waitForExit(2_000); } catch { /* unresolved ownership remains authoritative */ }
      throw error;
    }
    if (signal) {
      const abort = (): void => { if (process.exitCode === null) process.kill("SIGTERM"); };
      if (signal.aborted) abort();
      else {
        signal.addEventListener("abort", abort, { once: true });
        process.on("exit", () => signal.removeEventListener("abort", abort));
      }
    }
    return process;
  }
}

/** A deliberately small argv-only, bounded Git process adapter. */
export class GitCommandRunner {
  readonly #gitBinary: string;
  readonly #factory: GitProcessFactory;
  readonly #defaultTimeoutMs: number;
  readonly #defaultMaxOutputBytes: number;
  readonly #pathEnvironment: string;

  constructor(options: GitCommandRunnerOptions = {}) {
    this.#gitBinary = options.gitBinary ?? "git";
    if (!this.#gitBinary || this.#gitBinary.includes("\0")) throw new Error("Git executable is not trusted");
    this.#factory = options.processFactory ?? new DefaultGitProcessFactory();
    this.#defaultTimeoutMs = positiveInteger(options.defaultTimeoutMs ?? 30_000, "Git command timeout");
    this.#defaultMaxOutputBytes = positiveInteger(options.defaultMaxOutputBytes ?? 4 * 1024 * 1024, "Git command output limit");
    this.#pathEnvironment = options.pathEnvironment ?? "/usr/bin:/bin";
  }

  async run(args: readonly string[], options: GitCommandOptions): Promise<GitCommandResult> {
    validateArgv(args);
    assertRunId(options.runId);
    const timeoutMs = positiveInteger(options.timeoutMs ?? this.#defaultTimeoutMs, "Git command timeout");
    const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? this.#defaultMaxOutputBytes, "Git command output limit");
    const ticketRoot = assertTicketRoot(options.ticketRoot ?? "/ticket");
    validatePassFileDescriptors(options.passFileDescriptors);
    if (assertPathWithin(ticketRoot, options.cwd) !== options.cwd) throw new Error("Git command cwd is not canonical or under the ticket root");
    await inspectResource(options.cwd, "directory", true, ticketRoot);
    const commandId = `git-${randomUUID()}`;
    const env = buildGitEnvironment({
      runId: options.runId,
      ticketRoot,
      allowNetwork: options.allowNetwork === true,
      path: this.#pathEnvironment,
      ...(options.extraEnv ? { extra: options.extraEnv } : {}),
    });
    const launch: ProcessLaunch = { command: this.#gitBinary, args: ["--no-pager", ...args], cwd: options.cwd, env };
    let child: GitChildProcess | undefined;
    let callbackChild: GitChildProcess | undefined;
    let stdout = "";
    let stderr = "";
    let outputError: Error | undefined;
    const collect = (target: "stdout" | "stderr") => (chunk: Buffer | string): void => {
      if (outputError) return;
      const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (Buffer.byteLength(target === "stdout" ? stdout : stderr, "utf8") + Buffer.byteLength(value, "utf8") > maxOutputBytes) {
        outputError = new GitCommandError("Git command output exceeded its bounded limit");
        if (child?.exitCode === null) child.kill("SIGTERM");
        return;
      }
      if (target === "stdout") stdout += value; else stderr += value;
    };
    const started = Date.now();
    try {
      child = await this.#factory.spawn(launch, options.signal, async process => {
        callbackChild = process;
        child = process;
        await options.onSpawn?.(process);
      }, options.passFileDescriptors);
      // The awaited callback is the durable ownership boundary. Refuse a
      // factory that omits it or returns a different process identity; accepting
      // either would make recovery unable to prove which child was spawned.
      if (!child || !callbackChild || !validProcessIdentity(child.identity) || !validProcessIdentity(callbackChild.identity) || child.identity !== callbackChild.identity) throw new GitCommandUncertainError("Git child identity was not established exactly");
      child.stdout.on("data", collect("stdout"));
      child.stderr.on("data", collect("stderr"));
      const observed = await observeExit(child, timeoutMs, options.signal, () => {
        if (child?.exitCode === null) child.kill("SIGTERM");
      });
      const result: GitCommandResult = {
        commandId,
        args: [...args],
        cwd: options.cwd,
        processIdentity: child.identity,
        exitCode: observed.exitCode,
        signal: observed.signal,
        stdout,
        stderr,
      };
      if (outputError) throw new GitCommandError(outputError.message, result);
      await options.onObservedExit?.(child, result);
      const allowed = options.allowExitCodes ?? [0];
      if (!allowed.includes(observed.exitCode ?? -1)) throw new GitCommandError(`Git command failed (${diagnosticArgv(this.#gitBinary, args)}): ${redactDiagnostic(stderr || stdout)}`, result);
      return result;
    } catch (error) {
      if (error instanceof GitCommandError) {
        if (error instanceof GitCommandUncertainError) {
          const candidates = [child, callbackChild].filter((value, index, values): value is GitChildProcess => Boolean(value) && values.indexOf(value) === index);
          for (const candidate of candidates) {
            if (candidate.exitCode !== null) continue;
            try { candidate.kill("SIGKILL"); await candidate.waitForExit(Math.min(timeoutMs, 2_000)); } catch { /* the original uncertainty remains authoritative */ }
          }
        }
        throw error;
      }
      if (options.signal?.aborted) throw new GitCommandAbortedError(`Git command aborted after ${Date.now() - started}ms`);
      if (child && child.exitCode === null) {
        try { child.kill("SIGKILL"); await child.waitForExit(Math.min(timeoutMs, 2_000)); }
        catch { throw new GitCommandUncertainError(`Git command ownership is uncertain (${diagnosticArgv(this.#gitBinary, args)})`); }
      }
      throw new GitCommandError(`Git command could not be observed (${diagnosticArgv(this.#gitBinary, args)}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async checkRefFormat(refName: string, options: Omit<GitCommandOptions, "runId"> & { runId: string }): Promise<void> {
    await this.run(["check-ref-format", refName], options);
  }
}

export interface GitEnvironmentOptions {
  readonly runId: string;
  readonly ticketRoot: string;
  readonly allowNetwork: boolean;
  readonly path?: string;
  readonly extra?: Readonly<Record<string, string>>;
}

/** Builds a fresh environment; no ambient Git configuration or credential
 * variables are inherited. */
export function buildGitEnvironment(options: GitEnvironmentOptions): Readonly<Record<string, string>> {
  assertRunId(options.runId);
  const ticketRoot = assertTicketRoot(options.ticketRoot);
  if (options.path !== undefined && (options.path.includes("\0") || /[\r\n]/u.test(options.path))) throw new Error("Git PATH contains invalid data");
  const nullConfig = process.platform === "win32" ? "NUL" : "/dev/null";
  const controlHome = `${ticketRoot.replace(/[\\/]$/u, "")}/control/git/${options.runId}/home`;
  const environment: Record<string, string> = {
    PATH: options.path ?? "/usr/bin:/bin",
    LC_ALL: "C",
    LANG: "C",
    HOME: controlHome,
    XDG_CONFIG_HOME: `${ticketRoot.replace(/[\\/]$/u, "")}/control/git/${options.runId}/xdg-config`,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: nullConfig,
    GIT_CONFIG_GLOBAL: nullConfig,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_ALLOW_PROTOCOL: options.allowNetwork ? "https" : "",
    GIT_CONFIG_COUNT: "0",
  };
  const extra = options.extra ?? {};
  for (const [key, value] of Object.entries(extra)) {
    if (!EXTRA_ENV_ALLOWLIST.has(key) || DANGEROUS_ENV.has(key) || key === "GIT_CONFIG_COUNT") throw new Error(`untrusted Git environment variable: ${key}`);
    if (value.includes("\0") || /[\r\n]/u.test(value)) throw new Error(`invalid Git environment value: ${key}`);
    if (key === "GIT_ALLOW_PROTOCOL" && value !== "https" && value !== "file") throw new Error("Git protocol allowlist is not trusted");
    environment[key] = value;
  }
  return environment;
}

const EXTRA_ENV_ALLOWLIST = new Set(["GIT_ALLOW_PROTOCOL", "GIT_HTTP_USER_AGENT"]);

const DANGEROUS_ENV = new Set([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_REPLACE_REF_BASE", "GIT_NAMESPACE", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_EXEC_PATH", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS",
  "GIT_TRACE", "GIT_TRACE2", "GIT_TRACE2_EVENT", "GIT_CREDENTIAL_HELPER", "GIT_ASKPASS", "SSH_ASKPASS",
]);

async function observeExit(
  child: GitChildProcess,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  terminate: () => void,
): Promise<{ exitCode: number | null; signal: string | null }> {
  const currentExit = (): { exitCode: number; signal: string | null } | undefined => child.exitCode === null ? undefined : { exitCode: child.exitCode, signal: child.exitSignal ?? null };
  const alreadyExited = currentExit();
  if (alreadyExited) return alreadyExited;
  let exit: { exitCode: number | null; signal: string | null } | undefined;
  let resolveExit!: () => void;
  const exited = new Promise<void>(resolve => { resolveExit = resolve; });
  const onExit = (code: number | null, signalName: string | null): void => {
    if (!exit) exit = { exitCode: code, signal: signalName };
    resolveExit();
  };
  child.on("exit", onExit);
  // The process can exit between the initial check and listener registration.
  // Re-checking the durable child state closes that immediate-exit window.
  const racedExit = currentExit();
  if (racedExit) exit = racedExit;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted = false;
  const onAbort = (): void => { aborted = true; terminate(); };
  if (signal?.aborted) { aborted = true; terminate(); }
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(() => { terminate(); resolve(); }, timeoutMs);
    timer.unref?.();
  });
  try {
    if (!exit) await Promise.race([exited, timeout]);
    if (!exit) {
      try { await child.waitForExit(Math.min(timeoutMs, 2_000)); } catch { /* escalate below */ }
      const afterGrace = currentExit();
      if (afterGrace) exit = afterGrace;
      if (!exit) {
        // Timeout and cancellation both escalate to SIGKILL. If this also
        // cannot be observed, recovery must retain an unresolved child.
        child.kill("SIGKILL");
        try { await child.waitForExit(Math.min(timeoutMs, 2_000)); }
        catch { throw new GitCommandUncertainError("Git child did not provide an observed exit"); }
        const afterKill = currentExit();
        if (afterKill) exit = afterKill;
      }
    }
    if (aborted) throw new GitCommandAbortedError("Git command was aborted");
    if (!exit) throw new GitCommandUncertainError("Git child termination was not observed");
    return exit;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function validateArgv(args: readonly string[]): void {
  if (!Array.isArray(args) || args.length === 0) throw new Error("Git argv must not be empty");
  for (const arg of args) if (typeof arg !== "string" || arg.includes("\0") || /[\r\n]/u.test(arg)) throw new Error("Git argv contains invalid data");
}

function validatePassFileDescriptors(values: readonly number[] | undefined): void {
  if (!values) return;
  if (values.some(value => !Number.isSafeInteger(value) || value < 0) || new Set(values).size !== values.length) throw new Error("Git pass-through descriptors are not trusted");
}

function diagnosticArgv(command: string, args: readonly string[]): string {
  return [command, ...args].map(value => JSON.stringify(value)).join(" ");
}

function redactDiagnostic(value: string): string {
  return value.replace(/(?:https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, "https://<redacted>@").slice(0, 2_000);
}

function validProcessIdentity(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 300 && !/[\u0000-\u001f\u007f\r\n]/u.test(value);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}
