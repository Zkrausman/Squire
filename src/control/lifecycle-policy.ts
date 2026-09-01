import { isTerminal, type Clock, type RunSnapshot, type TerminalState } from "./domain.js";
export interface LifecycleLimits { maxProcessLaunches: number; rpcGraceMs: number; abortGraceMs: number; terminateGraceMs: number }
export const DEFAULT_LIFECYCLE_LIMITS: LifecycleLimits = { maxProcessLaunches: 2, rpcGraceMs: 5_000, abortGraceMs: 5_000, terminateGraceMs: 10_000 };
export interface AbortTarget { command(type: "clear_queue" | "abort_retry" | "abort", timeoutMs: number): Promise<void>; terminate(): void; kill(): void; exited(): boolean }
export async function boundedAbort(target: AbortTarget, clock: Clock, limits: LifecycleLimits = DEFAULT_LIFECYCLE_LIMITS): Promise<void> {
  for (const type of ["clear_queue", "abort_retry", "abort"] as const) { try { await target.command(type, limits.rpcGraceMs); } catch { /* escalation is mandatory */ } }
  await clock.sleep(limits.abortGraceMs); if (target.exited()) return;
  target.terminate(); await clock.sleep(limits.terminateGraceMs); if (!target.exited()) target.kill();
}
export function terminateRun(run: RunSnapshot, state: Extract<TerminalState, "failed" | "cancelled" | "expired">, code: string, message: string, at: string): RunSnapshot {
  if (isTerminal(run.state)) throw new Error("terminal race already decided");
  return { ...run, version: run.version + 1, state, terminalError: { code, message, at, evidence: [] } };
}
export function assertLaunchBudget(run: RunSnapshot, limits: LifecycleLimits = DEFAULT_LIFECYCLE_LIMITS): void { if (run.processLaunches >= limits.maxProcessLaunches) throw new Error("process launch budget exhausted"); }
