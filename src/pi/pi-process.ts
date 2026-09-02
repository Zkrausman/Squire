import type { RuntimeResolution } from "../control/domain.js";
export interface PiReadable { on(event: "data", listener: (chunk: Buffer | string) => void): this; on(event: "end", listener: () => void): this }
export interface PiWritable { write(data: string): boolean }
export interface PiProcess {
  readonly identity: string;
  readonly stdin: PiWritable;
  readonly stdout: PiReadable;
  readonly stderr: PiReadable;
  readonly exitCode: number | null;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
  kill(signal: "SIGTERM" | "SIGKILL"): boolean;
  /** Resolves only after observed exit and rejects after the finite timeout. */
  waitForExit(timeoutMs: number): Promise<void>;
}
export interface ProcessLaunch { command: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>> }
export interface PiProcessFactory {
  /** Calls onSpawn exactly once synchronously on creation, returns that same process, and creates nothing after abort. */
  spawn(spec: ProcessLaunch, signal?: AbortSignal, onSpawn?: (process: PiProcess) => void): Promise<PiProcess>;
}
/** Resolves a supervisor-owned process handle from its durable exact identity; undefined means unknown, not exited. */
export interface ProcessIdentityResolver { resolve(processIdentity: string, signal?: AbortSignal): Promise<PiProcess | undefined> }
/** Resolves the selected installations once; no repository-wide exact version pin is required. */
export interface RuntimeResolver { resolve(runId: string, signal?: AbortSignal): Promise<RuntimeResolution> }
