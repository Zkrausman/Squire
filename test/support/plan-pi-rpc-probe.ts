import { StringDecoder } from "node:string_decoder";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import type { ProcessLaunch } from "../../src/pi/pi-process.js";
import {
  BoundedFailureAccumulator,
  BoundedRedactionAccumulator,
  BoundedRedactor,
  FailureCategory,
  PI_CHILD_OUTPUT_LIMIT_BYTES,
  PI_CHILD_STDERR_LIMIT_BYTES,
  preparePiChildLaunch,
  truncateUtf8,
} from "./pi-child-support.js";

const RESPONSE_TIMEOUT_MS = 20_000;
// Keep one absolute probe/cleanup deadline below the unchanged 30-second
// acceptance bound. Cleanup consumes the remaining budget rather than adding a
// second serial timeout after the RPC timer.
const TOTAL_DEADLINE_MS = 29_000;
const TERMINATION_GRACE_MS = 5_000;
const NATURAL_EXIT_GRACE_MS = 50;

type ExitObservation = { code: number | null; signal: string | null };

type ProbeState = {
  failures: BoundedFailureAccumulator;
  responseAccepted: boolean;
  exit?: ExitObservation;
  close?: ExitObservation;
  terminalState?: "running" | "exited" | "startup-error" | "closed-without-exit";
  gracefulTeardownRequested: boolean;
  escalation?: "SIGTERM" | "SIGKILL";
  exitFailureRecorded: boolean;
};

export interface PlanRpcProbeResult {
  state: Record<string, unknown>;
  output: string;
  errors: string;
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

function combineFailures(state: ProbeState): Error | undefined {
  return state.failures.toError();
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

function recordFailure(
  state: ProbeState,
  error: unknown,
  category: FailureCategory,
  redactor: BoundedRedactor,
  responseSettled: { value: boolean },
  responseTimer: { value: ReturnType<typeof setTimeout> | undefined },
  rejectResponse: (error: Error) => void,
): void {
  const failure = state.failures.add(error, category, redactor);
  if (!responseSettled.value && category !== "cleanup") {
    responseSettled.value = true;
    if (responseTimer.value) clearTimeout(responseTimer.value);
    rejectResponse(failure);
  }
}

async function terminateChild(
  child: ChildProcess,
  state: ProbeState,
  deadlineAt: number,
  recordCleanupFailure: (error: unknown) => void,
): Promise<void> {
  // Let a natural exit event win over a response-resolution microtask before
  // the controller claims ownership of graceful teardown.
  await nextTurn();
  await observeNaturalExit(child, state, deadlineAt);
  if (state.close) return;
  if (state.exit || child.exitCode !== null || child.signalCode !== null) {
    try { await waitForClose(child, state, deadlineAt); }
    catch (error) { recordCleanupFailure(error); }
    return;
  }

  state.gracefulTeardownRequested = true;
  try {
    child.stdin?.end();
  } catch (error) {
    recordCleanupFailure(error);
  }

  try {
    await waitForClose(child, state, deadlineAt, TERMINATION_GRACE_MS);
    return;
  } catch {
    recordCleanupFailure(new Error("Plan RPC graceful child teardown timed out; controller requested SIGTERM"));
  }
  if (state.close) return;
  if (state.exit || child.exitCode !== null || child.signalCode !== null) {
    try { await waitForClose(child, state, deadlineAt); }
    catch (error) { recordCleanupFailure(error); }
    return;
  }

  state.escalation = "SIGTERM";
  if (!child.kill("SIGTERM")) recordCleanupFailure(new Error("Plan RPC controller SIGTERM teardown request failed"));
  try {
    await waitForClose(child, state, deadlineAt, TERMINATION_GRACE_MS);
    return;
  } catch {
    recordCleanupFailure(new Error("Plan RPC SIGTERM teardown did not close the child before its grace deadline; controller requested SIGKILL"));
  }
  if (state.close) return;
  state.escalation = "SIGKILL";
  if (!child.kill("SIGKILL")) recordCleanupFailure(new Error("Plan RPC controller SIGKILL teardown request failed"));
  try { await waitForClose(child, state, deadlineAt); }
  catch (error) { recordCleanupFailure(error); }
}

function classifyLifecycle(state: ProbeState, recordCleanupFailure: (error: unknown) => void): void {
  if (!state.exit) {
    recordCleanupFailure(new Error(`Plan RPC child terminal state ${state.terminalState ?? "unknown"} settled without an observed exit`));
    recordCleanupFailure(new Error("Plan RPC child exit was not observed before the absolute deadline"));
  } else if (!state.gracefulTeardownRequested) {
    if (!state.exitFailureRecorded) {
      state.exitFailureRecorded = true;
      recordCleanupFailure(new Error(`Plan RPC child exited before controller teardown: ${terminationDescription(state.exit)}`));
    }
  } else if (state.exit.code !== 0 || state.exit.signal !== null) {
    recordCleanupFailure(new Error(`Plan RPC graceful teardown ended with ${terminationDescription(state.exit)} instead of code 0`));
  }
  if (!state.close) recordCleanupFailure(new Error("Plan RPC child close was not observed before the absolute deadline"));
}

export async function probePlanRpc(spec: ProcessLaunch): Promise<PlanRpcProbeResult> {
  const startedAt = Date.now();
  const prepared = preparePiChildLaunch(spec);
  const redactor = new BoundedRedactor(process.env, spec.env);
  const child = spawnChild(prepared.command, [...prepared.args], {
    cwd: spec.cwd,
    env: prepared.environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error("Plan RPC child did not expose piped stdio");
  const deadlineAt = startedAt + TOTAL_DEADLINE_MS;
  const state: ProbeState = {
    failures: new BoundedFailureAccumulator(),
    responseAccepted: false,
    terminalState: "running",
    gracefulTeardownRequested: false,
    exitFailureRecorded: false,
  };
  const outputTail = new BoundedRedactionAccumulator(PI_CHILD_OUTPUT_LIMIT_BYTES, redactor);
  const errorTail = new BoundedRedactionAccumulator(PI_CHILD_STDERR_LIMIT_BYTES, redactor);
  const stdoutDecoder = new StringDecoder("utf8");
  let lineBuffer = "";
  const responseSettled = { value: false };
  const responseTimer: { value: ReturnType<typeof setTimeout> | undefined } = { value: undefined };
  let resolveResponse!: (value: Record<string, unknown>) => void;
  let rejectResponse!: (error: Error) => void;

  const record = (error: unknown, category: FailureCategory): void => {
    recordFailure(state, error, category, redactor, responseSettled, responseTimer, rejectResponse);
  };
  const recordCleanupFailure = (error: unknown): void => { record(error, "cleanup"); };
  const acceptResponse = (data: Record<string, unknown>): void => {
    if (responseSettled.value || state.responseAccepted || state.failures.hasAny()) return;
    state.responseAccepted = true;
    responseSettled.value = true;
    if (responseTimer.value) clearTimeout(responseTimer.value);
    resolveResponse(data);
  };
  const inspectLine = (line: string): void => {
    if (!line) return;
    let recordValue: Record<string, unknown>;
    try { recordValue = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (recordValue["type"] === "extension_error") {
      record(new Error(`Plan extension failed to load: ${line}`), state.responseAccepted ? "lifecycle" : "protocol");
    }
    if (recordValue["id"] !== "probe-state" || recordValue["type"] !== "response") return;
    if (recordValue["success"] !== true || !recordValue["data"] || typeof recordValue["data"] !== "object" || Array.isArray(recordValue["data"])) {
      record(new Error(`Plan RPC get_state failed: ${line}`), "protocol");
      return;
    }
    acceptResponse(recordValue["data"] as Record<string, unknown>);
  };
  const consumeStdoutText = (text: string): void => {
    lineBuffer += text;
    if (Buffer.byteLength(lineBuffer, "utf8") > PI_CHILD_OUTPUT_LIMIT_BYTES) {
      record(new Error("Plan RPC child emitted an unterminated stdout line beyond the bounded output limit"), "protocol");
      lineBuffer = Buffer.from(lineBuffer, "utf8").subarray(-PI_CHILD_OUTPUT_LIMIT_BYTES).toString("utf8");
    }
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) inspectLine(line);
  };

  child.stdout.on("data", chunk => {
    outputTail.append(chunk);
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    for (let offset = 0; offset < input.length; offset += 8_192) {
      const text = stdoutDecoder.write(input.subarray(offset, Math.min(input.length, offset + 8_192)));
      if (text) consumeStdoutText(text);
    }
  });
  child.stderr.on("data", chunk => { errorTail.append(chunk); });
  child.stdin.on("error", error => { record(error, state.responseAccepted ? "lifecycle" : "startup"); });
  child.once("error", error => { record(error, state.responseAccepted ? "lifecycle" : "startup"); });
  child.once("exit", (code, signal) => {
    state.terminalState = "exited";
    state.exit = { code, signal };
    if (!state.gracefulTeardownRequested) {
      state.exitFailureRecorded = true;
      record(new Error(`Plan RPC child exited before controller teardown: ${terminationDescription(state.exit)}`), state.responseAccepted ? "lifecycle" : "startup");
    }
  });
  child.once("close", (code, signal) => {
    state.close = { code, signal };
    if (!state.exit) state.terminalState = state.failures.hasCategory("startup") ? "startup-error" : "closed-without-exit";
  });
  const responsePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
    const timeoutMs = Math.min(RESPONSE_TIMEOUT_MS, remainingMs(deadlineAt));
    responseTimer.value = setTimeout(() => record(new Error("real Plan RPC probe timed out"), "protocol"), Math.max(1, timeoutMs));
  });

  let response: Record<string, unknown> | undefined;
  try {
    child.stdin.write(`${JSON.stringify({ id: "probe-state", type: "get_state" })}\n`);
    response = await responsePromise;
    await nextTurn();
  } catch (error) {
    // recordFailure already rejects with the sanitized retained primary error.
    // Only a synchronous write failure reaches this branch without a record.
    if (!state.failures.hasAny()) {
      responseSettled.value = true;
      if (responseTimer.value) clearTimeout(responseTimer.value);
      record(error, "protocol");
    }
  }

  await terminateChild(child, state, deadlineAt, recordCleanupFailure);
  if (!state.close) {
    try { await waitForClose(child, state, deadlineAt); }
    catch (error) { recordCleanupFailure(error); }
  }
  await nextTurn();
  const tail = stdoutDecoder.end();
  if (tail) consumeStdoutText(tail);
  classifyLifecycle(state, recordCleanupFailure);
  const failure = combineFailures(state);
  if (failure) throw failure;
  if (!response) throw new Error("Plan RPC probe completed without a response");
  return { state: response, output: outputTail.text(), errors: errorTail.text() };
}