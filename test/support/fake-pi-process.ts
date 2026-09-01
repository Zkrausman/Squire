import { EventEmitter } from "node:events";
import type { RuntimeResolution } from "../../src/control/domain.js";
import type { PiProcess, PiProcessFactory, ProcessLaunch, RuntimeResolver } from "../../src/pi/pi-process.js";
class FakeStream extends EventEmitter { override on(event: string, listener: (...args: any[]) => void): this { return super.on(event, listener); } push(chunk: Buffer | string): void { this.emit("data", chunk); } end(): void { this.emit("end"); } }
export class FakePiProcess extends EventEmitter implements PiProcess {
  readonly identity: string; readonly stdout = new FakeStream(); readonly stderr = new FakeStream(); readonly writes: string[] = []; exitCode: number | null = null;
  readonly stdin = { write: (data: string) => { this.writes.push(data); return true; } };
  constructor(identity: string) { super(); this.identity = identity; }
  override on(event: "exit", listener: (code: number | null, signal: string | null) => void): this { return super.on(event, listener); }
  kill(signal: "SIGTERM" | "SIGKILL"): boolean { this.exitCode = signal === "SIGKILL" ? 137 : 143; this.emit("exit", this.exitCode, signal); return true; }
  async waitForExit(_timeoutMs: number): Promise<void> { if (this.exitCode === null) throw new Error("process exit timeout"); }
  send(record: unknown, chunks?: number[]): void { const bytes = Buffer.from(`${JSON.stringify(record)}\n`); if (!chunks) { this.stdout.push(bytes); return; } let offset = 0; for (const size of chunks) { this.stdout.push(bytes.subarray(offset, offset + size)); offset += size; } if (offset < bytes.length) this.stdout.push(bytes.subarray(offset)); }
  respondToLast(command: string, success = true, data?: unknown): void { const request = JSON.parse(this.writes.at(-1) ?? "{}") as { id?: string }; this.send({ id: request.id, type: "response", command, success, ...(data === undefined ? {} : { data }) }); }
}
export class FakePiProcessFactory implements PiProcessFactory {
  readonly launches: ProcessLaunch[] = []; readonly processes: FakePiProcess[] = [];
  async spawn(spec: ProcessLaunch, signal?: AbortSignal, onSpawn?: (process: PiProcess) => void): Promise<FakePiProcess> { if (signal?.aborted) throw new Error("spawn aborted"); this.launches.push(spec); const process = new FakePiProcess(`process-${this.processes.length + 1}`); this.processes.push(process); onSpawn?.(process); return process; }
}
export class FakeRuntimeResolver implements RuntimeResolver {
  calls = 0;
  constructor(readonly resolution: RuntimeResolution) {}
  async resolve(runId: string, signal?: AbortSignal): Promise<RuntimeResolution> { this.calls += 1; if (signal?.aborted) throw new Error("resolution aborted"); if (runId !== this.resolution.runId) throw new Error("wrong run"); return structuredClone(this.resolution); }
}
