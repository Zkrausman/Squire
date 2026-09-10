import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
    try {
      const result = await execFileAsync(request.command, [...request.args], {
        encoding: "utf8",
        windowsHide: true,
        timeout: request.timeoutMs ?? 120_000,
        maxBuffer: request.maxOutputBytes ?? 8 * 1024 * 1024,
        ...(request.cwd ? { cwd: request.cwd } : {}),
        ...(request.env ? { env: request.env } : {}),
        ...(signal ? { signal } : {}),
      });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string; code?: string | number };
      const stderr = failure.stderr?.trim();
      const stdout = failure.stdout?.trim();
      const detail = request.sensitive ? "sensitive command failed" : stderr || stdout || failure.message;
      throw new Error(`${request.command} failed${failure.code === undefined ? "" : ` (${String(failure.code)})`}: ${detail.slice(0, 4_000)}`, { cause: error });
    }
  }
}
