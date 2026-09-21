import { providerLaunchFailure, generationIdentity } from "./launch-retry.js";
import type { CommandPort, CommandRequest, CommandResult } from "./command.js";
import { CommandExecutionError } from "./command.js";
import { TelemetryStore, type TelemetryInvocation } from "./telemetry-store.js";

/** Trusted host only. Neither JSONL sessions nor model-authored paths are read. */
export async function captureInvocation(store: TelemetryStore, identity: TelemetryInvocation, commands: CommandPort, request: CommandRequest, signal?: AbortSignal): Promise<CommandResult> {
  // Accounting is deliberately non-gating. A failed begin/end leaves a missing
  // inventory slot or endpoint, never a fabricated zero or a workflow retry.
  const started = await store.begin(identity).then(() => true, () => false);
  try {
    const output = await commands.run({ ...request, redactDiagnostics: true }, signal);
    if (started) await store.end(identity, output.stdoutBytes, true).catch(() => undefined);
    return output;
  } catch (error) {
    const terminalLaunchFailure = error instanceof CommandExecutionError && !signal?.aborted && !["timeout", "cancelled"].includes(error.classification) && identity.launchGeneration !== undefined && !!providerLaunchFailure(error.stdoutBytes, { profile: identity.profile, launchGeneration: generationIdentity(identity.phase, identity.attempt, identity.launchGeneration, identity.sessionId) });
    if (started) await store.end(identity, error instanceof CommandExecutionError ? error.stdoutBytes : undefined, false, terminalLaunchFailure).catch(() => undefined);
    throw error;
  }
}

/** Seed the Pi header to the controller-issued invocation identity. Root creates
 * it exclusively; subsequent model-writable session bytes are not evidence. */
export function sessionSeed(sessionId: string, file: string): string {
  const sh = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;
  const header = JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: "/ticket/workspace" }) + "\n";
  return `( set -C; printf %s ${sh(header)} > ${sh(file)} )`;
}
