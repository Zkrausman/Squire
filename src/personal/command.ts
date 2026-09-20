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
  /** Suppress task-bearing diagnostics but retain exact report evidence. */
  readonly sanitized?: boolean;
  readonly stdin?: Buffer;
}

export interface CommandResult {
  readonly stdout: string;
  /** Exact transport bytes; required for evidence-backed phase execution. */
  readonly stdoutBytes?: Buffer;
  readonly stderr: string;
}

export interface CommandPort {
  readonly byteOutput?: true;
  readonly byteInput?: true;
  run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult>;
}

/** Partial stdout is evidence, never authority to turn command failure into a result. */
export class CommandExecutionError extends PhaseExecutionError {
  constructor(classification: ExecutionFailure, message: string, readonly stdout: string, options?: ErrorOptions, readonly stdoutBytes?: Buffer) { super(classification, message, options); }
}

export class NodeCommandRunner implements CommandPort {
  readonly byteOutput = true;
  readonly byteInput = true;
  async run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> {
    if (request.sanitized && ([request.command, ...request.args].some(s => s.includes("\0")) ||
      [request.command, ...request.args].reduce((n, s) => n + s.length * 2 + 3, 0) > 24000 ||
      Object.entries(request.env ?? {}).reduce((n, [k, v]) => n + k.length + (v?.length ?? 0) + 2, 0) > 24000))
      throw new PhaseExecutionError("infrastructure", "phase_transport: protected-stdin schema=1 validation=capacity-rejected; repair bounded selectors and authorize fresh attempt");
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
        const detail = request.sensitive || request.sanitized ? "protected command failed" : stderr.toString("utf8").trim() || stdout.toString("utf8").trim() || failure.message;
        reject(new CommandExecutionError(signal?.aborted ? "cancelled" : (failure as Error & { killed?: boolean }).killed ? "timeout" : ((request.sanitized && failure.code === 78) || (typeof failure.code === "string" && ["ENOENT", "EACCES", "ENOBUFS", "ENAMETOOLONG"].includes(failure.code))) ? "infrastructure" : "unknown", `${request.sanitized ? "phase_transport command" : request.command} failed${failure.code === undefined ? "" : ` (${String(failure.code)})`}: ${detail.slice(0, 4_000)}`, request.sensitive ? "" : stdout.toString("utf8"), request.sanitized ? undefined : { cause: error }, request.sensitive ? Buffer.alloc(0) : stdout));
      });
      // Non-interactive commands must observe EOF. In particular, Pi print mode
      // waits for stdin to close before processing its positional prompt.
      // EPIPE accompanies early consumer rejection; child close is authoritative.
      child.stdin?.on("error", () => {});
      child.stdin?.end(request.stdin);
    });
  }
}
