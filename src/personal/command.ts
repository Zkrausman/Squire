import { PhaseExecutionError, type ExecutionFailure } from "./execution-failure.js";
import { execFile } from "node:child_process";

export interface CommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly sensitive?: boolean;
  /** Keep protected bytes for accounting, but never echo child content in errors. */
  readonly redactDiagnostics?: boolean;
}

export interface CommandResult {
  readonly stdout: string;
  /** Exact transport bytes; required for evidence-backed phase execution. */
  readonly stdoutBytes?: Buffer;
  readonly stderr: string;
}

export interface CommandPort {
  readonly byteOutput?: true;
  run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult>;
}

/** Partial stdout is evidence, never authority to turn command failure into a result. */
export class CommandExecutionError extends PhaseExecutionError {
  constructor(classification: ExecutionFailure, message: string, readonly stdout: string, options?: ErrorOptions, readonly stdoutBytes?: Buffer) { super(classification, message, options); }
}

/** OS-confirmed failure to create a process, with no child PID or output.
 * Only the phase adapter may translate this into phase-launch retry authority. */
export class ProcessLaunchError extends CommandExecutionError {
  constructor(readonly code: "EAGAIN") { super("infrastructure", "Process launch temporarily unavailable", "", undefined, Buffer.alloc(0)); }
}

export class NodeCommandRunner implements CommandPort {
  readonly byteOutput = true;
  async run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> {
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = execFile(request.command, [...request.args], {
        encoding: "buffer",
        windowsHide: true,
        timeout: request.timeoutMs ?? 120_000,
        maxBuffer: request.maxOutputBytes ?? 8 * 1024 * 1024,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.env ? { env: request.env } : {}),
        ...(signal ? { signal } : {}),
      }, (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), stdoutBytes: stdout });
          return;
        }
        const failure = error as Error & { code?: string | number };
        if (failure.code === "EAGAIN" && child.pid === undefined && !signal?.aborted && stdout.length === 0 && stderr.length === 0) {
          reject(new ProcessLaunchError("EAGAIN"));
          return;
        }
        const detail = request.sensitive || request.redactDiagnostics ? "sensitive command failed" : stderr.toString("utf8").trim() || stdout.toString("utf8").trim() || failure.message;
        reject(new CommandExecutionError(signal?.aborted ? "cancelled" : (failure as Error & { killed?: boolean }).killed ? "timeout" : typeof failure.code === "string" && ["ENOENT", "EACCES", "ENOBUFS"].includes(failure.code) ? "infrastructure" : "unknown", `${request.command} failed${failure.code === undefined ? "" : ` (${String(failure.code)})`}: ${detail.slice(0, 4_000)}`, request.sensitive ? "" : stdout.toString("utf8"), { cause: error }, request.sensitive ? Buffer.alloc(0) : stdout));
      });
      // Non-interactive commands must observe EOF. In particular, Pi print mode
      // waits for stdin to close before processing its positional prompt.
      child.stdin?.end();
    });
  }
}
