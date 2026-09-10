import { execFile } from "node:child_process";

export interface CommandRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly sensitive?: boolean;
}

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandPort {
  run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult>;
}

export class NodeCommandRunner implements CommandPort {
  async run(request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> {
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = execFile(request.command, [...request.args], {
        encoding: "utf8",
        windowsHide: true,
        timeout: request.timeoutMs ?? 120_000,
        maxBuffer: request.maxOutputBytes ?? 8 * 1024 * 1024,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.env ? { env: request.env } : {}),
        ...(signal ? { signal } : {}),
      }, (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr });
          return;
        }
        const failure = error as Error & { code?: string | number };
        const detail = request.sensitive ? "sensitive command failed" : stderr.trim() || stdout.trim() || failure.message;
        reject(new Error(`${request.command} failed${failure.code === undefined ? "" : ` (${String(failure.code)})`}: ${detail.slice(0, 4_000)}`, { cause: error }));
      });
      // Non-interactive commands must observe EOF. In particular, Pi print mode
      // waits for stdin to close before processing its positional prompt.
      child.stdin?.end();
    });
  }
}
