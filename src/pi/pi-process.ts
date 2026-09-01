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
}
export interface ProcessLaunch { command: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>> }
export interface PiProcessFactory {
  /** Aborting before settlement must reject and must not leave a created process alive. */
  spawn(spec: ProcessLaunch, signal?: AbortSignal): Promise<PiProcess>;
}
/** Resolves the selected installations once; no repository-wide exact version pin is required. */
export interface RuntimeResolver { resolve(runId: string, signal?: AbortSignal): Promise<RuntimeResolution> }
