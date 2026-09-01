import type { Clock, Role } from "../control/domain.js";
import type { AttemptRuntime, SessionEntryPage } from "../control/attempt-coordinator.js";
import { boundedAbort, DEFAULT_LIFECYCLE_LIMITS, type LifecycleLimits } from "../control/lifecycle-policy.js";
import type { PiProcess } from "./pi-process.js";
import type { PiRpcClient } from "./pi-rpc-client.js";
import type { PiRunner } from "./pi-runner.js";

/** Production adapter joining the persisted attempt coordinator to one exact-session Pi process. */
export class PiAttemptRuntime implements AttemptRuntime {
  #client: PiRpcClient | undefined;
  #process: PiProcess | undefined;
  constructor(readonly runner: PiRunner, readonly clock: Clock, readonly limits: LifecycleLimits = DEFAULT_LIFECYCLE_LIMITS) {}
  roleTimeoutMs(role: Role): number { const seconds = this.runner.config.roles[role]?.timeoutSeconds; if (!Number.isInteger(seconds) || seconds === undefined || seconds <= 0) throw new Error(`missing finite role timeout: ${role}`); return seconds * 1_000; }
  async ensureProcess(runId: string, role: Role): Promise<void> {
    const existing = this.runner.live.get(`${runId}:${role}`);
    if (existing?.process.exitCode === null && !existing.client.failure) { this.#client = existing.client; this.#process = existing.process; return; }
    const launched = await this.runner.launch(runId, role); this.#client = launched.client; this.#process = launched.process;
  }
  async getEntries(cursor: string | null): Promise<SessionEntryPage> {
    const response = await this.#requiredClient().command({ type: "get_entries", ...(cursor ? { since: cursor } : {}) });
    const data = response.data as { entries?: unknown[]; leafId?: unknown } | undefined;
    if (!response.success || !data || !Array.isArray(data.entries) || (data.leafId !== null && typeof data.leafId !== "string")) throw new Error("malformed get_entries response");
    return { entries: data.entries, cursor: data.leafId };
  }
  async prompt(message: string): Promise<void> { await this.#requiredClient().prompt(message); }
  waitForSettled(timeoutMs: number): Promise<void> { return this.#requiredClient().waitForSettled(timeoutMs); }
  async abort(): Promise<void> {
    const client = this.#client; const process = this.#process; if (!client || !process || process.exitCode !== null) return;
    await boundedAbort({ command: async (type, timeoutMs) => { await client.command({ type }, timeoutMs); }, terminate: () => { process.kill("SIGTERM"); }, kill: () => { process.kill("SIGKILL"); }, exited: () => process.exitCode !== null }, this.clock, this.limits);
  }
  #requiredClient(): PiRpcClient { if (!this.#client || this.#client.failure) throw this.#client?.failure ?? new Error("Pi process is not available"); return this.#client; }
}
