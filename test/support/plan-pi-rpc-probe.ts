import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import type { ProcessLaunch } from "../../src/pi/pi-process.js";

const RESPONSE_TIMEOUT_MS = 20_000;
// Keep one absolute probe/cleanup deadline below the unchanged 30-second
// acceptance bound. Cleanup consumes the remaining budget rather than adding a
// second serial timeout after the RPC timer.
const TOTAL_DEADLINE_MS = 29_000;
const TERMINATION_GRACE_MS = 5_000;
const NATURAL_EXIT_GRACE_MS = 50;

type ExitObservation = { code: number | null; signal: string | null };

interface ProbeState {
  failure?: Error;
  exit?: ExitObservation;
  close?: ExitObservation;
  terminationRequested: boolean;
  terminationSignal?: "SIGTERM" | "SIGKILL";
}

export interface PlanRpcProbeResult {
  state: Record<string, unknown>;
  output: string;
  errors: string;
}

export interface PlanRpcProbeHooks {
  /** Test-only seam for deterministic primary-error/cleanup-error coverage. */
  terminateChild?: (child: ChildProcess, deadlineAt: number) => Promise<void>;
}

function cleanPiEnvironment(overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_"))),
    ...overrides,
  };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function remainingMs(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now());
}

function nextTurn(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

function terminationDescription(observation: ExitObservation): string {
  return observation.code === null ? observation.signal ?? "unknown" : `code ${observation.code}`;
}

function combineErrors(message: string, errors: readonly Error[]): Error {
  if (errors.length === 1) return errors[0]!;
  return new AggregateError(errors, message);
}

async function waitForClose(child: ChildProcess, state: ProbeState, deadlineAt: number, maxWaitMs = Number.POSITIVE_INFINITY): Promise<void> {
  if (state.close) return;
  const timeoutMs = Math.min(remainingMs(deadlineAt), maxWaitMs);
  if (timeoutMs <= 0) throw new Error("Plan RPC child cleanup exceeded absolute deadline before observed close");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("close", onClose);
      reject(new Error("Plan RPC child cleanup timed out before observed close"));
    }, timeoutMs);
    const onClose = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once("close", onClose);
  });
}

async function observeNaturalExit(child: ChildProcess, state: ProbeState, deadlineAt: number): Promise<void> {
  if (state.close || state.exit || child.exitCode !== null || child.signalCode !== null) return;
  await waitForClose(child, state, deadlineAt, NATURAL_EXIT_GRACE_MS).catch(() => undefined);
}

async function terminateChild(child: ChildProcess, state: ProbeState, deadlineAt: number): Promise<void> {
  // Let a natural exit event win over a response-resolution microtask before
  // the parent claims ownership of termination. This is the response/exit race
  // that the previous helper incorrectly settled as success.
  await nextTurn();
  await observeNaturalExit(child, state, deadlineAt);
  if (state.close) return;
  if (!state.exit && child.exitCode === null && child.signalCode === null) {
    state.terminationRequested = true;
    state.terminationSignal = "SIGTERM";
    if (!child.kill("SIGTERM")) {
      state.terminationRequested = false;
      delete state.terminationSignal;
    }
  }
  try {
    await waitForClose(child, state, deadlineAt, TERMINATION_GRACE_MS);
  } catch (termError) {
    if (state.close) return;
    if (!state.terminationRequested || remainingMs(deadlineAt) <= 0) throw termError;
    state.terminationRequested = true;
    state.terminationSignal = "SIGKILL";
    child.kill("SIGKILL");
    await waitForClose(child, state, deadlineAt);
  }
}

function classifyExit(state: ProbeState): Error | undefined {
  if (!state.exit) return new Error("Plan RPC child exit was not observed");
  if (!state.terminationRequested) {
    return new Error(`Plan RPC child exited before parent cleanup: ${terminationDescription(state.exit)}`);
  }
  const expected = state.exit.signal === "SIGTERM"
    || state.exit.signal === "SIGKILL"
    || state.exit.code === 143;
  return expected ? undefined : new Error(`Plan RPC child had an unexpected cleanup exit: ${terminationDescription(state.exit)}`);
}

export async function probePlanRpc(spec: ProcessLaunch, hooks: PlanRpcProbeHooks = {}): Promise<PlanRpcProbeResult> {
  const child = spawnChild(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: cleanPiEnvironment({ ...spec.env, PI_OFFLINE: "1" }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error("Plan RPC child did not expose piped stdio");
  const startedAt = Date.now();
  const deadlineAt = startedAt + TOTAL_DEADLINE_MS;
  const state: ProbeState = { terminationRequested: false };
  let output = "";
  let errors = "";
  let lineBuffer = "";
  let responseSettled = false;
  let responseTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveResponse!: (value: Record<string, unknown>) => void;
  let rejectResponse!: (error: Error) => void;

  const recordFailure = (error: unknown): void => {
    const failure = asError(error);
    if (!state.failure) state.failure = failure;
    if (!responseSettled) {
      responseSettled = true;
      if (responseTimer) clearTimeout(responseTimer);
      rejectResponse(failure);
    }
  };
  const acceptResponse = (data: Record<string, unknown>): void => {
    if (responseSettled) return;
    responseSettled = true;
    if (responseTimer) clearTimeout(responseTimer);
    resolveResponse(data);
  };
  const inspectLine = (line: string): void => {
    if (!line) return;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (record["type"] === "extension_error" && !state.terminationRequested) {
      recordFailure(new Error(`Plan extension failed to load: ${line}`));
    }
    if (record["id"] !== "probe-state" || record["type"] !== "response") return;
    if (record["success"] !== true || !record["data"] || typeof record["data"] !== "object" || Array.isArray(record["data"])) {
      recordFailure(new Error(`Plan RPC get_state failed: ${line}`));
      return;
    }
    acceptResponse(record["data"] as Record<string, unknown>);
  };

  child.stdout.on("data", chunk => {
    const text = chunk.toString();
    output += text;
    lineBuffer += text;
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) inspectLine(line);
  });
  child.stderr.on("data", chunk => { errors += chunk.toString(); });
  child.stdin.on("error", error => { if (!state.terminationRequested) recordFailure(error); });
  child.once("error", error => { if (!state.terminationRequested) recordFailure(error); });
  child.once("exit", (code, signal) => {
    state.exit = { code, signal };
    if (!state.terminationRequested) recordFailure(new Error(`Plan RPC child exited before parent cleanup: ${terminationDescription(state.exit)}`));
  });
  child.once("close", (code, signal) => {
    state.close = { code, signal };
  });
  const responsePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
    const timeoutMs = Math.min(RESPONSE_TIMEOUT_MS, remainingMs(deadlineAt));
    responseTimer = setTimeout(() => recordFailure(new Error("real Plan RPC probe timed out")), Math.max(1, timeoutMs));
  });

  let response: Record<string, unknown> | undefined;
  let primaryError: Error | undefined;
  try {
    child.stdin.write(`${JSON.stringify({ id: "probe-state", type: "get_state" })}\n`);
    response = await responsePromise;
    await nextTurn();
  } catch (error) {
    primaryError = asError(error);
  }

  const cleanupErrors: Error[] = [];
  try {
    if (hooks.terminateChild) await hooks.terminateChild(child, deadlineAt);
    else await terminateChild(child, state, deadlineAt);
  } catch (error) {
    cleanupErrors.push(asError(error));
  }
  if (!state.close) {
    try { await waitForClose(child, state, deadlineAt); }
    catch (error) { cleanupErrors.push(asError(error)); }
  }
  await nextTurn();
  const exitFailure = classifyExit(state);
  if (exitFailure && !state.failure) cleanupErrors.push(exitFailure);
  const cleanupError = cleanupErrors.length > 0 ? combineErrors("Plan RPC child cleanup failed", cleanupErrors) : undefined;
  const failure = state.failure ?? primaryError;
  if (failure && cleanupError) throw new AggregateError([failure, cleanupError], "Plan RPC probe failed and child cleanup also failed");
  if (failure) throw failure;
  if (cleanupError) throw cleanupError;
  if (!response) throw new Error("Plan RPC probe completed without a response");
  return { state: response, output, errors };
}
