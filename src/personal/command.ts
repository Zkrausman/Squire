import { PhaseExecutionError, type ExecutionFailure } from "./execution-failure.js";
import { execFile, spawn } from "node:child_process";

export interface CommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly sensitive?: boolean;
  /** Drain JSON-mode Pi stdout without killing paid work at the accounting bound. */
  readonly capture?: "pi-json";
}

export interface CommandResult {
  readonly stdout: string;
  /** Exact transport bytes; required for evidence-backed phase execution. */
  readonly stdoutBytes?: Buffer;
  readonly stderr: string;
  readonly stdoutTruncated?: boolean;
  readonly terminalEventBytes?: Buffer;
}

export interface CommandPort {
  readonly byteOutput?: true;
  run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult>;
}

/** Partial stdout is evidence, never authority to turn command failure into a result. */
export class CommandExecutionError extends PhaseExecutionError {
  constructor(classification: ExecutionFailure, message: string, readonly stdout: string, options?: ErrorOptions, readonly stdoutBytes?: Buffer, readonly terminalEventBytes?: Buffer, readonly stdoutTruncated = false) { super(classification, message, options); }
}

export class NodeCommandRunner implements CommandPort {
  readonly byteOutput = true;
  async run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> {
    if (request.capture === "pi-json") return capturePiStream(request, signal);
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
        const detail = request.sensitive ? "sensitive command failed" : stderr.toString("utf8").trim() || stdout.toString("utf8").trim() || failure.message;
        reject(new CommandExecutionError(signal?.aborted ? "cancelled" : (failure as Error & { killed?: boolean }).killed ? "timeout" : typeof failure.code === "string" && ["ENOENT", "EACCES", "ENOBUFS"].includes(failure.code) ? "infrastructure" : "unknown", `${request.command} failed${failure.code === undefined ? "" : ` (${String(failure.code)})`}: ${detail.slice(0, 4_000)}`, request.sensitive ? "" : stdout.toString("utf8"), { cause: error }, request.sensitive ? Buffer.alloc(0) : stdout));
      });
      // Non-interactive commands must observe EOF. In particular, Pi print mode
      // waits for stdin to close before processing its positional prompt.
      child.stdin?.end();
    });
  }
}

/** Two independent bounds: exact accounting prefix and most recent complete JSON
 * event. Overflow drains (never kills) the child, and is explicit in the result.
 * Neither decoded events nor child stderr are ever put in an exception message. */
async function capturePiStream(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> {
  if (request.sensitive) throw new Error("sensitive commands cannot use Pi stream capture");
  const maximum = request.maxOutputBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64 * 1024 * 1024) throw new Error("invalid Pi stream bound");
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const prefix: Buffer[] = [];
    let prefixLength = 0, truncated = false;
    let line: Buffer[] = [], lineLength = 0, lineOverflow = false;
    let terminal: Buffer | undefined;
    let timedOut = false, processError: unknown;
    const child = spawn(request.command, [...request.args], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...(request.cwd ? { cwd: request.cwd } : {}), ...(request.env ? { env: request.env } : {}) });
    const interrupt = () => child.kill();
    signal?.addEventListener("abort", interrupt, { once: true });
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, request.timeoutMs ?? 120_000);
    child.stdout.on("data", (chunk: Buffer) => {
      const kept = Math.min(chunk.length, maximum - prefixLength);
      if (kept) { prefix.push(Buffer.from(chunk.subarray(0, kept))); prefixLength += kept; }
      if (kept !== chunk.length) truncated = true;
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline + 1;
        const part = chunk.subarray(start, end);
        lineLength += part.length;
        if (lineLength > maximum) { lineOverflow = true; line = []; }
        else if (!lineOverflow) line.push(Buffer.from(part));
        if (newline >= 0) {
          terminal = lineOverflow ? undefined : Buffer.concat(line, lineLength);
          line = []; lineLength = 0; lineOverflow = false;
        }
        start = end;
      }
    });
    // Drain all presentation/errors. They are private and never accounting or
    // phase authority; only structured stdout terminal events carry reports.
    child.stderr.resume();
    child.once("error", error => { processError = error; });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timeout); signal?.removeEventListener("abort", interrupt);
      const bytes = Buffer.concat(prefix, prefixLength);
      if (lineLength || lineOverflow) terminal = undefined;
      if (processError || code !== 0 || exitSignal || signal?.aborted || timedOut) {
        const classification = signal?.aborted ? "cancelled" : timedOut ? "timeout" : processError ? "infrastructure" : "unknown";
        reject(new CommandExecutionError(classification, "Pi structured child execution failed", "", undefined, bytes, terminal, truncated));
      } else resolve({ stdout: "", stderr: "", stdoutBytes: bytes, stdoutTruncated: truncated, ...(terminal ? { terminalEventBytes: terminal } : {}) });
    });
    if (signal?.aborted) interrupt();
  });
}
