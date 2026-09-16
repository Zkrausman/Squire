import { NodeCommandRunner } from "./command.js";
import { closed } from "./plan-artifacts.js";
import { supervisePlan, type PlanSupervisorOptions } from "./plan-supervisor.js";
import type { PhaseInput } from "./types.js";

// Private fork entry point; no CLI configuration/credential loading, state port,
// ticket adapter, publication adapter, or model session exists in this process.
const abort = new AbortController();
let started = false;
let acknowledge: (() => void) | undefined;
const cancel = () => { abort.abort(new Error("Plan supervisor interrupted")); acknowledge?.(); };
process.on("SIGTERM", cancel);
process.on("SIGINT", cancel);
process.on("disconnect", cancel);
process.on("message", (message: unknown) => {
  void receive(message).catch(error => {
    final({ type: "error", message: String(error).slice(0, 8000) });
  });
});
async function receive(message: unknown): Promise<void> {
  const type = (message as { type?: unknown })?.type;
  if (type === "cancel") { closed(message, ["type"], "cancel"); cancel(); return; }
  if (type === "ack") { closed(message, ["type"], "ack"); if (!acknowledge) throw new Error("unexpected progress ack"); acknowledge(); acknowledge = undefined; return; }
  const v = closed(message, ["type", "input", "options"], "supervisor start");
  if (type !== "start" || started) throw new Error("invalid supervisor start");
  started = true;
  const result = await supervisePlan(v["input"] as PhaseInput, v["options"] as PlanSupervisorOptions, new NodeCommandRunner(), abort.signal, async progress => {
    await new Promise<void>((resolve, reject) => {
      acknowledge = resolve;
      if (!process.connected) { cancel(); reject(new Error("controller disconnected")); return; }
      process.send!({ type: "progress", progress });
    });
    abort.signal.throwIfAborted();
  });
  final({ type: "result", result });
}

function final(message: unknown): void {
  if (process.connected) process.send!(message, () => { if (process.connected) process.disconnect?.(); });
}
