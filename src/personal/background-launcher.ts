import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";

export interface BackgroundLaunchRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  /** Cancels startup only until the child emits `spawn`; ownership then belongs to the child. */
  readonly signal?: AbortSignal;
  /** Called only for an OS error that happens after launch handoff. */
  readonly onError?: (error: Error) => void;
}

export interface BackgroundLaunchResult {
  readonly pid: number | undefined;
}

export interface BackgroundLauncher {
  launch(request: BackgroundLaunchRequest): Promise<BackgroundLaunchResult>;
}

export interface NodeBackgroundLauncherOptions {
  /** Injectable for focused platform/argv tests. */
  readonly spawn?: typeof spawn;
}

/**
 * Launch a detached Node process with inherited file descriptors rather than a
 * terminal. `windowsHide` applies to the launcher and to Squire's internal
 * command runner so both request hidden-window operation on Windows.
 */
export class NodeBackgroundLauncher implements BackgroundLauncher {
  readonly #spawn: typeof spawn;

  constructor(options: NodeBackgroundLauncherOptions = {}) {
    this.#spawn = options.spawn ?? spawn;
  }

  async launch(request: BackgroundLaunchRequest): Promise<BackgroundLaunchResult> {
    validateRequest(request);
    // An explicitly supplied environment is a launch snapshot, not a set of
    // additions to the parent's mutable environment. Clone it before any
    // asynchronous filesystem work so variables added before spawn cannot
    // change the detached child's configuration roots or other bindings.
    const launchEnvironment: NodeJS.ProcessEnv = { ...(request.env ?? process.env) };
    const stdoutPath = path.resolve(request.stdoutPath);
    const stderrPath = path.resolve(request.stderrPath);
    await mkdir(path.dirname(stdoutPath), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(stderrPath), { recursive: true, mode: 0o700 });

    throwIfAborted(request.signal);
    let stdout: FileHandle | undefined;
    let stderr: FileHandle | undefined;
    try {
      // Append makes a relaunch/diagnostic invocation preserve the first
      // launch error instead of silently truncating it. The descriptors are
      // closed by the parent immediately after spawn confirmation.
      stdout = await openLog(stdoutPath);
      await stdout.chmod(0o600);
      throwIfAborted(request.signal);
      stderr = await openLog(stderrPath);
      await stderr.chmod(0o600);
      throwIfAborted(request.signal);
      const child = this.#spawn(request.executable, [...request.args], {
        ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
        env: launchEnvironment,
        // A background launcher cannot silently degrade to a foreground child.
        detached: true,
        windowsHide: true,
        stdio: ["ignore", stdout.fd, stderr.fd],
        shell: false,
      });
      return await this.#awaitSpawn(child, request.signal, request.onError);
    } finally {
      // File descriptor inheritance has already happened once spawn emits its
      // event. Closing on every path is important on Windows, where an open
      // parent descriptor otherwise prevents log rotation/deletion.
      await stdout?.close().catch(() => undefined);
      await stderr?.close().catch(() => undefined);
    }
  }

  async #awaitSpawn(child: ChildProcess, signal: AbortSignal | undefined, onError: ((error: Error) => void) | undefined): Promise<BackgroundLaunchResult> {
    return await new Promise<BackgroundLaunchResult>((resolve, reject) => {
      let handedOff = false;
      let settled = false;
      let cancelled = false;
      const cleanup = (): void => signal?.removeEventListener("abort", handleAbort);
      const handleAbort = (): void => {
        if (handedOff || settled) return;
        settled = true;
        cancelled = true;
        try { child.kill(); } catch { /* a not-yet-spawned child may not be killable */ }
        cleanup();
        reject(abortReason(signal));
      };
      const handleError = (value: Error): void => {
        if (!handedOff && !settled) {
          settled = true;
          cleanup();
          reject(value);
          return;
        }
        try { onError?.(value); } catch { /* diagnostic hooks cannot alter launch ownership */ }
      };
      child.once("error", handleError);
      child.once("spawn", () => {
        if (settled) {
          if (cancelled) {
            try { child.kill(); } catch { /* cancellation already owns the failure result */ }
            child.unref();
          }
          return;
        }
        handedOff = true;
        settled = true;
        cleanup();
        // The child owns its event loop after this call. Ignoring stdio is
        // deliberate: only the file descriptors above remain attached.
        child.unref();
        resolve({ pid: typeof child.pid === "number" && child.pid > 0 ? child.pid : undefined });
      });
      signal?.addEventListener("abort", handleAbort, { once: true });
      if (signal?.aborted) handleAbort();
    });
  }
}

function validateRequest(request: BackgroundLaunchRequest): void {
  if (!request.executable || request.executable.includes("\0")) throw new Error("background executable is invalid");
  if (request.args.some(argument => argument.includes("\0"))) throw new Error("background argument contains NUL");
  if (!path.isAbsolute(request.stdoutPath) || !path.isAbsolute(request.stderrPath)) throw new Error("background log paths must be absolute");
}

async function openLog(file: string): Promise<FileHandle> {
  // O_NOFOLLOW rejects only a final-component symlink. It does not establish
  // ancestor-integrity or hardlink protection.
  const flags = process.platform === "win32"
    ? "a"
    : constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW;
  return open(file, flags, 0o600);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("operator interrupted background startup");
}
