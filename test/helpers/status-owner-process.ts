// Separate, fixture-owned controller. Production reserve holds its original
// ticket-operation handle at a test-only lifecycle barrier. The reservation is
// a pathname reservation in production, not a lifetime mutex; pin that exact
// file too so the native test proves concurrent sharing without changing it.
import { access, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { JsonRunStateStore } from "../../src/personal/json-run-state.js";
import { fileIdentity } from "../../src/personal/reservation-observation.js";
import { statusOwnerState } from "./status-owner-state.js";

const directory = process.argv[2]!;
const ready = process.env["SQUIRE_TEST_ONLY_TICKET_OPERATION_READY_PATH"]!;
const release = process.env["SQUIRE_TEST_ONLY_TICKET_OPERATION_RELEASE_PATH"]!;
const store = new JsonRunStateStore(directory);
const claim = process.argv[3] === "claim";
const initial = claim ? (await store.read(statusOwnerState().runId))! : statusOwnerState();
const state = claim ? { ...initial, version: initial.version + 1, launchState: "started" as const,
  controllerPid: process.pid, lifecycle: "preparing" as const, step: "preparing" as const, preparationState: "started" as const } : initial;
const reservation = claim ? store.claimReserved(state) : store.reserve(state);
let failure: unknown;
void reservation.catch(error => { failure = error; });
const deadline = Date.now() + 15_000;
for (;;) {
  if (failure) throw failure;
  try { await access(ready); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (Date.now() > deadline) throw new Error("owner barrier deadline");
  await new Promise(resolve => setTimeout(resolve, 5));
}
const handle = await open(path.join(directory, "locks", "aidev-305.lock"), "r");
const identity = await fileIdentity(handle);
let finish!: (mode: string) => void;
const stopped = new Promise<string>(resolve => { finish = resolve; });
process.on("message", (message: { command?: string; nonce?: string }) => {
  if (message.command === "challenge") process.send?.({ nonce: message.nonce, pid: process.pid, identity });
  else if (message.command === "stop" || message.command === "abandon") finish(message.command);
});
process.on("disconnect", () => finish("stop"));
process.send?.({ ready: true, pid: process.pid, identity });
const mode = await stopped;
await handle.close();
await writeFile(release, "release\n", { flag: "wx" });
await reservation;
if (mode !== "abandon") {
  await store.save({ ...state, version: state.version + 1, status: "failed", lifecycle: "failed", lastError: "fixture shutdown", endedAt: state.updatedAt });
  await store.release(state.ticketId, state.runId);
}
process.disconnect?.();
