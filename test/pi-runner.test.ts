import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ROLES, type Clock, type LeaseGuard, type Role, type RunPrecondition, type RunSnapshot, type RuntimeResolution, type SessionRegistration } from "../src/control/domain.js";
import type { PiProcess, ProcessIdentityResolver, ProcessLaunch, PiProcessFactory, RuntimeResolver } from "../src/pi/pi-process.js";
import { validateSessionRegistration } from "../src/pi/session-registry.js";
import { PiRunner } from "../src/pi/pi-runner.js";
import type { MaterializedPiAgentDirectory, PiAgentDirectoryMaterializerPort } from "../src/pi/pi-agent-directory.js";
import { InMemoryWorkflowStore } from "./support/in-memory-workflow-store.js";
import { FakePiProcess, FakePiProcessFactory, FakeRuntimeResolver } from "./support/fake-pi-process.js";
import { run, runtime } from "./support/fixtures.js";

const roleConfig = Object.fromEntries(ROLES.map(role => [role, { provider: "provider", model: "model", instructionsPath: `/ticket/control/roles/${role}.md`, timeoutSeconds: 30 }])) as Record<Role, { provider: string; model: string; instructionsPath: string; timeoutSeconds: number }>;
const deterministicMaterializer: PiAgentDirectoryMaterializerPort = { materialize: async (request): Promise<MaterializedPiAgentDirectory> => ({ runId: request.runId, agentDir: "/ticket/runtime/test-pi-agent", settingsPath: "/ticket/runtime/test-pi-agent/settings.json", manifestPath: "/ticket/runtime/test-pi-agent/squire-agent-manifest.json", footerExtensionPath: "/ticket/runtime/test-pi-agent/extensions/squire-trusted-wiki-footer.mjs", trustedExtensionPaths: ["/ticket/runtime/wiki-extension.ts", "/ticket/runtime/test-pi-agent/extensions/squire-trusted-wiki-footer.mjs"], extensionDigest: "test-extension-digest" }) };
const clock: Clock = { now: () => Date.parse("2026-09-01T12:00:00Z"), sleep: () => new Promise<void>(() => undefined) };
async function session(root: string, role: Role, id: string): Promise<string> { const dir = path.join(root, role); await mkdir(dir, { recursive: true }); const file = path.join(dir, `2026_${id}.jsonl`); await writeFile(file, `${JSON.stringify({ type: "session", id })}\n`); return file; }
async function settleLaunch(runner: PiRunner, factory: FakePiProcessFactory, runId: string, role: Role, sessionId: string, file: string) { const count = factory.processes.length; const pending = runner.launch(runId, role); for (let tries = 0; tries < 2_000; tries += 1) { const process = factory.processes[count]; if (process?.writes.length) { process.respondToLast("get_state", true, { model: { provider: "provider", id: "model" }, sessionId, sessionFile: file }); return pending; } await new Promise(resolve => setTimeout(resolve, 1)); } throw new Error("Pi process did not request get_state"); }
async function setup(useDefaultMaterializer = false) { const root = await mkdtemp(path.join(os.tmpdir(), "squire-runner-")); for (const role of ROLES) await mkdir(path.join(root, role), { recursive: true }); const store = new InMemoryWorkflowStore(); await store.create(run()); const factory = new FakePiProcessFactory(); const resolver = new FakeRuntimeResolver(runtime); const runner = new PiRunner(factory, resolver, store, { roles: roleConfig, sessionRoot: root, ...(useDefaultMaterializer ? {} : { materializer: deterministicMaterializer }) }, registration => validateSessionRegistration(registration, root), async () => "trusted role", clock); return { root, store, factory, resolver, runner }; }

test("five roles register five independent live processes and one run-scoped runtime", async () => {
  const { root, store, factory, resolver, runner } = await setup(true); const identities = new Set<string>(); const ids = new Set<string>();
  for (const role of ROLES) { const file = await session(root, role, role); const launched = await settleLaunch(runner, factory, "run_example01", role, role, file); identities.add(launched.process.identity); ids.add(launched.state.sessionId); const launch = factory.launches.at(-1)!; assert.equal(launch.command, runtime.pi.executable); assert.equal(launch.env["PI_CODING_AGENT_DIR"], "/ticket/runtime/run_example01/pi-agent"); assert.ok(launch.args.includes("--no-extensions")); assert.equal(launch.args[launch.args.indexOf("--extension") + 1], "/ticket/runtime/node_modules/@zosmaai/pi-llm-wiki/extensions/llm-wiki/index.ts"); }
  assert.equal(identities.size, 5); assert.equal(ids.size, 5); assert.equal(runner.live.size, 5); assert.equal(resolver.calls, 1);
  const persisted = await store.read("run_example01"); for (const role of ROLES) { assert.equal(persisted?.sessions[role]?.processState, "live"); assert.equal(persisted?.sessions[role]?.sessionFile, path.join(root, role, `2026_${role}.jsonl`)); assert.equal(persisted?.processAllocations?.[role], undefined); }
});

test("same role cannot release or launch while prior process remains live", async () => {
  const { root, factory, runner } = await setup(); const file = await session(root, "implement", "impl"); const first = await settleLaunch(runner, factory, "run_example01", "implement", "impl", file);
  assert.throws(() => runner.release("run_example01", "implement"), /live process/);
  await assert.rejects(runner.launch("run_example01", "implement"), /live process/);
  assert.equal(first.process.exitCode, null); assert.equal(factory.processes.length, 1);
});

test("observed terminated generation permits exact-file restart and increments persisted generation", async () => {
  const { root, store, factory, runner } = await setup(); const file = await session(root, "implement", "impl"); const first = await settleLaunch(runner, factory, "run_example01", "implement", "impl", file); first.process.kill("SIGTERM"); for (let tries = 0; tries < 50; tries += 1) { if (["exited", "failed"].includes((await store.read("run_example01"))?.sessions.implement?.processState ?? "")) break; await new Promise(resolve => setImmediate(resolve)); }
  assert.match((await store.read("run_example01"))?.sessions.implement?.processState ?? "", /^(exited|failed)$/);
  const secondPending = settleLaunch(runner, factory, "run_example01", "implement", "impl", file); const second = await secondPending;
  const args = factory.launches[1]!.args; assert.equal(args.filter(value => value === "--session").length, 1); assert.equal(args[args.indexOf("--session") + 1], file); assert.equal(second.process.exitCode, null); assert.equal((await store.read("run_example01"))?.sessions.implement?.processGeneration, 2);
});

class ManualClock implements Clock {
  value = 0; readonly sleepers: Array<{ due: number; resolve: () => void; reject: (error: Error) => void; signal?: AbortSignal }> = [];
  now(): number { return this.value; }
  sleep(ms: number, signal?: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { const item = { due: this.value + ms, resolve, reject, ...(signal ? { signal } : {}) }; this.sleepers.push(item); signal?.addEventListener("abort", () => reject(new Error("sleep aborted")), { once: true }); }); }
  advance(ms: number): void { this.value += ms; for (const item of this.sleepers.splice(0)) { if (item.due <= this.value && !item.signal?.aborted) item.resolve(); else this.sleepers.push(item); } }
}
class Gate {
  readonly entered: Promise<void>; #entered!: () => void; #release!: () => void;
  constructor() { this.entered = new Promise(resolve => { this.#entered = resolve; }); }
  wait(signal?: AbortSignal): Promise<void> { this.#entered(); return new Promise((resolve, reject) => { this.#release = resolve; signal?.addEventListener("abort", () => reject(new Error("gated operation aborted")), { once: true }); }); }
  release(): void { this.#release?.(); }
}
type Stall = "lookup" | "reservation" | "runtime" | "runtime-record" | "instructions" | "spawn-intent" | "spawn" | "spawn-claim" | "handshake" | "validation" | "registration" | "generation";
class RaceStore extends InMemoryWorkflowStore {
  lookupCalls = 0; registrationCalls = 0; runtimeRecordCalls = 0; allocationMutationCalls = 0;
  constructor(readonly stall: Stall, readonly gate: Gate) { super(); }
  override async getSession(runId: string, role: Role): Promise<SessionRegistration | undefined> { if (this.stall === "lookup" && this.lookupCalls++ === 0) await this.gate.wait(); return super.getSession(runId, role); }
  override async compareAndSetFenced(runId: string, expected: RunPrecondition, guard: LeaseGuard, mutate: (current: RunSnapshot) => RunSnapshot): Promise<RunSnapshot> {
    const current = await this.read(runId); const allocation = current?.processAllocations?.implement;
    const matches = (this.stall === "reservation" && !allocation && !current?.sessions.implement)
      || (this.stall === "spawn-intent" && allocation?.state === "reserved")
      || (this.stall === "spawn-claim" && allocation?.state === "spawning")
      || (this.stall === "generation" && current?.sessions.implement?.processState === "exited");
    if (matches && this.allocationMutationCalls++ === 0) await this.gate.wait();
    return super.compareAndSetFenced(runId, expected, guard, mutate);
  }
  override async recordRuntimeFenced(runId: string, expected: RunPrecondition, guard: LeaseGuard, resolution: RuntimeResolution): Promise<RunSnapshot> { if (this.stall === "runtime-record" && this.runtimeRecordCalls++ === 0) await this.gate.wait(); return super.recordRuntimeFenced(runId, expected, guard, resolution); }
  override async registerSessionFenced(runId: string, expected: RunPrecondition, guard: LeaseGuard, registration: SessionRegistration): Promise<RunSnapshot> { if (this.stall === "registration" && this.registrationCalls++ === 0) await this.gate.wait(); return super.registerSessionFenced(runId, expected, guard, registration); }
}
class RaceResolver implements RuntimeResolver {
  calls = 0;
  constructor(readonly stall: Stall, readonly gate: Gate) {}
  async resolve(_runId: string, signal?: AbortSignal): Promise<RuntimeResolution> { if (this.stall === "runtime" && this.calls++ === 0) await this.gate.wait(signal); return structuredClone(runtime); }
}
class RaceFactory implements PiProcessFactory {
  calls = 0; readonly launches: ProcessLaunch[] = []; readonly processes: FakePiProcess[] = [];
  constructor(readonly stall: Stall, readonly gate: Gate) {}
  async spawn(spec: ProcessLaunch, signal?: AbortSignal, onSpawn?: (process: PiProcess) => void): Promise<FakePiProcess> { if (this.stall === "spawn" && this.calls++ === 0) await this.gate.wait(signal); if (signal?.aborted) throw new Error("stale owner cannot spawn"); this.launches.push(spec); const process = new FakePiProcess(`race-process-${this.processes.length + 1}`); this.processes.push(process); onSpawn?.(process); return process; }
}
async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> { for (let tries = 0; tries < 2_000; tries += 1) { if (await predicate()) return; await new Promise(resolve => setImmediate(resolve)); } throw new Error("race did not reach expected stall"); }

for (const stall of ["lookup", "reservation", "runtime", "runtime-record", "instructions", "spawn-intent", "spawn", "spawn-claim", "handshake", "validation", "registration"] as const) test(`first-session ${stall} stall is bounded and fenced`, async () => {
  const gate = new Gate(); const raceClock = new ManualClock(); const store = new RaceStore(stall, gate); await store.create(run(["runtime", "runtime-record"].includes(stall) ? {} : { runtimeResolution: runtime }));
  const factory = new RaceFactory(stall, gate); const resolver = new RaceResolver(stall, gate); let instructionCalls = 0; let validationCalls = 0;
  const instructions = async (_path: string, signal?: AbortSignal) => { if (stall === "instructions" && instructionCalls++ === 0) await gate.wait(signal); return "trusted role"; };
  const validator = async (_registration: SessionRegistration, signal?: AbortSignal) => { if (stall === "validation" && validationCalls++ === 0) await gate.wait(signal); };
  const config = { roles: roleConfig, materializer: deterministicMaterializer, processLeaseMs: 10, allocationStepTimeoutMs: 5, allocationTimeoutMs: 100 };
  const firstRunner = new PiRunner(factory, resolver, store, config, validator, instructions, raceClock); const secondRunner = new PiRunner(factory, resolver, store, config, validator, instructions, raceClock);
  const first = firstRunner.launch("run_example01", "implement");
  if (!["handshake", "validation", "registration"].includes(stall)) await gate.entered;
  else {
    await waitUntil(() => factory.processes[0]?.writes.length === 1);
    if (stall !== "handshake") { factory.processes[0]!.respondToLast("get_state", true, { model: { provider: "provider", id: "model" }, sessionId: "first", sessionFile: "/ticket/sessions/implement/first.jsonl" }); await gate.entered; }
  }
  raceClock.advance(11);
  await assert.rejects(first, /allocation|bounded|fenced|expired|aborted/);
  const beforeSecond = factory.processes.length;
  const second = secondRunner.launch("run_example01", "implement");
  const safelyReplaceable = ["lookup", "reservation", "runtime", "runtime-record", "instructions", "spawn-intent", "spawn"].includes(stall);
  if (safelyReplaceable) {
    await waitUntil(() => factory.processes[beforeSecond]?.writes.length === 1);
    factory.processes[beforeSecond]!.respondToLast("get_state", true, { model: { provider: "provider", id: "model" }, sessionId: "second", sessionFile: "/ticket/sessions/implement/second.jsonl" });
    await second;
  } else await assert.rejects(second, /reconciliation|allocation|live process/);
  gate.release(); await new Promise(resolve => setImmediate(resolve));
  const snapshot = (await store.read("run_example01"))!;
  assert.ok(factory.processes.length <= 1, `${stall}: more than one first-session process/session allocation was created`);
  assert.ok(Object.keys(snapshot.sessions).length <= 1, `${stall}: more than one session was registered`);
  if (safelyReplaceable) assert.equal(snapshot.sessions.implement?.sessionId, "second");
  else assert.equal(snapshot.sessions.implement, undefined);
});

test("registered-session generation claim rejects a stale allocation owner", async () => {
  const gate = new Gate(); const raceClock = new ManualClock(); const store = new RaceStore("generation", gate);
  const registration: SessionRegistration = { runId: "run_example01", role: "implement", sessionId: "registered", sessionFile: "/ticket/sessions/implement/registered.jsonl", processGeneration: 1, processState: "exited", registeredAt: runtime.resolvedAt };
  await store.create(run({ runtimeResolution: runtime, sessions: { implement: registration } }));
  const factory = new RaceFactory("generation", gate); const resolver = new RaceResolver("generation", gate); const config = { roles: roleConfig, materializer: deterministicMaterializer, processLeaseMs: 10, allocationStepTimeoutMs: 5, allocationTimeoutMs: 100 };
  const firstRunner = new PiRunner(factory, resolver, store, config, async () => undefined, async () => "trusted role", raceClock); const secondRunner = new PiRunner(factory, resolver, store, config, async () => undefined, async () => "trusted role", raceClock);
  const first = firstRunner.launch("run_example01", "implement"); await gate.entered; raceClock.advance(11); await assert.rejects(first, /allocation|fenced|expired/);
  const second = secondRunner.launch("run_example01", "implement"); await waitUntil(() => factory.processes[0]?.writes.length === 1); factory.processes[0]!.respondToLast("get_state", true, { model: { provider: "provider", id: "model" }, sessionId: registration.sessionId, sessionFile: registration.sessionFile }); await second;
  gate.release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(factory.processes.length, 1); assert.equal((await store.read("run_example01"))?.sessions.implement?.processGeneration, 2); assert.equal((await store.read("run_example01"))?.sessions.implement?.processState, "live");
});

type PostStage = "stale-recovery" | "lookup" | "reservation" | "runtime" | "runtime-record" | "session-validation" | "instructions" | "spawn-intent" | "spawn" | "spawn-claim" | "handshake" | "validation" | "registration" | "generation" | "live";
class PostExpiry {
  fired = false;
  constructor(readonly clock: ManualClock) {}
  fire(): void { if (!this.fired) { this.fired = true; this.clock.advance(11); } }
}
class PostStore extends InMemoryWorkflowStore {
  constructor(readonly stage: PostStage, readonly post: PostExpiry) { super(); }
  override async getSession(runId: string, role: Role): Promise<SessionRegistration | undefined> { const value = await super.getSession(runId, role); if (this.stage === "lookup") this.post.fire(); return value; }
  override async compareAndSetFenced(runId: string, expected: RunPrecondition, guard: LeaseGuard, mutate: (current: RunSnapshot) => RunSnapshot): Promise<RunSnapshot> {
    const before = await this.read(runId); const value = await super.compareAndSetFenced(runId, expected, guard, mutate); const oldAllocation = before?.processAllocations?.implement; const allocation = value.processAllocations?.implement;
    if (this.stage === "stale-recovery" && oldAllocation?.owner === "predecessor" && oldAllocation.state === "reserved" && !allocation) this.post.fire();
    if (this.stage === "reservation" && !oldAllocation && allocation?.state === "reserved") this.post.fire();
    if (this.stage === "spawn-intent" && oldAllocation?.state === "reserved" && allocation?.state === "spawning") this.post.fire();
    if (this.stage === "spawn-claim" && oldAllocation?.state === "spawning" && allocation?.state === "spawned") this.post.fire();
    if (this.stage === "generation" && before?.sessions.implement?.processState !== "launching" && value.sessions.implement?.processState === "launching") this.post.fire();
    if (this.stage === "live" && before?.sessions.implement?.processState === "launching" && value.sessions.implement?.processState === "live") this.post.fire();
    return value;
  }
  override async recordRuntimeFenced(runId: string, expected: RunPrecondition, guard: LeaseGuard, resolution: RuntimeResolution): Promise<RunSnapshot> { const value = await super.recordRuntimeFenced(runId, expected, guard, resolution); if (this.stage === "runtime-record") this.post.fire(); return value; }
  override async registerSessionFenced(runId: string, expected: RunPrecondition, guard: LeaseGuard, registration: SessionRegistration): Promise<RunSnapshot> { const value = await super.registerSessionFenced(runId, expected, guard, registration); if (this.stage === "registration") this.post.fire(); return value; }
}
class PostResolver implements RuntimeResolver {
  constructor(readonly stage: PostStage, readonly post: PostExpiry) {}
  async resolve(): Promise<RuntimeResolution> { if (this.stage === "runtime") this.post.fire(); return structuredClone(runtime); }
}
class PostFactory implements PiProcessFactory {
  readonly launches: ProcessLaunch[] = []; readonly processes: FakePiProcess[] = [];
  constructor(readonly stage: PostStage, readonly post: PostExpiry) {}
  async spawn(spec: ProcessLaunch, _signal?: AbortSignal, onSpawn?: (process: PiProcess) => void): Promise<FakePiProcess> { this.launches.push(spec); const process = new FakePiProcess(`post-process-${this.processes.length + 1}`); this.processes.push(process); onSpawn?.(process); if (this.stage === "spawn") this.post.fire(); return process; }
}
const postConfig = { roles: roleConfig, materializer: deterministicMaterializer, processLeaseMs: 10, allocationStepTimeoutMs: 5, allocationTimeoutMs: 100, commandTimeoutMs: 100 };

for (const stage of ["stale-recovery", "lookup", "reservation", "runtime", "runtime-record", "instructions", "spawn-intent", "spawn", "spawn-claim", "handshake", "validation", "registration"] as const) test(`first-session post-${stage} settlement expiry converges cleanup`, async () => {
  const raceClock = new ManualClock(); const post = new PostExpiry(raceClock); const store = new PostStore(stage, post); const stale = stage === "stale-recovery" ? { processAllocations: { implement: { role: "implement" as const, owner: "predecessor", fencingToken: 0, generation: 1, state: "reserved" as const, allocatedAt: "now" } } } : {}; await store.create(run({ ...(["runtime", "runtime-record"].includes(stage) ? {} : { runtimeResolution: runtime }), ...stale })); const factory = new PostFactory(stage, post); const resolver = new PostResolver(stage, post);
  const instructions = async () => { if (stage === "instructions") post.fire(); return "trusted role"; }; const validator = async () => { if (stage === "validation") post.fire(); };
  const runner = new PiRunner(factory, resolver, store, postConfig, validator, instructions, raceClock); const pending = runner.launch("run_example01", "implement"); const rejected = assert.rejects(pending, /allocation|bounded|expired|fenced/);
  if (["handshake", "validation", "registration"].includes(stage)) { await waitUntil(() => factory.processes[0]?.writes.length === 1); factory.processes[0]!.respondToLast("get_state", true, { model: { provider: "provider", id: "model" }, sessionId: "first", sessionFile: "/ticket/sessions/implement/first.jsonl" }); if (stage === "handshake") post.fire(); }
  await waitUntil(() => post.fired); await rejected; await new Promise(resolve => setImmediate(resolve));
  const snapshot = (await store.read("run_example01"))!; assert.equal(runner.live.size, 0); assert.ok(factory.processes.every(process => process.exitCode !== null)); assert.ok(!["reserved", "spawning", "spawned"].includes(snapshot.processAllocations?.implement?.state ?? "")); assert.ok(!["launching", "live"].includes(snapshot.sessions.implement?.processState ?? ""));
});

for (const stage of ["session-validation", "reservation", "generation", "instructions", "spawn-intent", "spawn", "spawn-claim", "handshake", "live"] as const) test(`resumed-generation post-${stage} settlement expiry is retryable`, async () => {
  const raceClock = new ManualClock(); const post = new PostExpiry(raceClock); const store = new PostStore(stage, post); const registration: SessionRegistration = { runId: "run_example01", role: "implement", sessionId: "registered", sessionFile: "/ticket/sessions/implement/registered.jsonl", processGeneration: 1, processState: "exited", registeredAt: runtime.resolvedAt }; await store.create(run({ runtimeResolution: runtime, sessions: { implement: registration } }));
  const factory = new PostFactory(stage, post); const resolver = new PostResolver(stage, post); const instructions = async () => { if (stage === "instructions") post.fire(); return "trusted role"; }; const validator = async () => { if (stage === "session-validation") post.fire(); };
  const firstRunner = new PiRunner(factory, resolver, store, postConfig, validator, instructions, raceClock); const first = firstRunner.launch("run_example01", "implement"); const rejected = assert.rejects(first, /allocation|bounded|expired|fenced/);
  if (["handshake", "live"].includes(stage)) { await waitUntil(() => factory.processes[0]?.writes.length === 1); factory.processes[0]!.respondToLast("get_state", true, { model: { provider: "provider", id: "model" }, sessionId: registration.sessionId, sessionFile: registration.sessionFile }); if (stage === "handshake") post.fire(); }
  await waitUntil(() => post.fired); await rejected; await new Promise(resolve => setImmediate(resolve)); const failed = (await store.read("run_example01"))!; assert.equal(firstRunner.live.size, 0); assert.ok(factory.processes.every(process => process.exitCode !== null)); assert.equal(failed.processAllocations?.implement, undefined); assert.ok(!["launching", "live"].includes(failed.sessions.implement?.processState ?? ""));
  const retryRunner = new PiRunner(factory, resolver, store, postConfig, async () => undefined, async () => "trusted role", raceClock); const index = factory.processes.length; const retry = retryRunner.launch("run_example01", "implement"); await waitUntil(() => factory.processes[index]?.writes.length === 1); factory.processes[index]!.respondToLast("get_state", true, { model: { provider: "provider", id: "model" }, sessionId: registration.sessionId, sessionFile: registration.sessionFile }); await retry; assert.equal((await store.read("run_example01"))?.sessions.implement?.processState, "live");
});

class StubbornProcess extends FakePiProcess {
  readonly signals: Array<"SIGTERM" | "SIGKILL"> = []; cooperative = false;
  override kill(signal: "SIGTERM" | "SIGKILL"): boolean { this.signals.push(signal); return this.cooperative ? super.kill(signal) : false; }
  override async waitForExit(_timeoutMs: number): Promise<void> { if (this.exitCode === null) throw new Error("observed exit timeout"); }
  observeExit(): void { if (this.exitCode === null) { this.exitCode = 137; this.emit("exit", 137, "SIGKILL"); } }
}
class StubbornFactory implements PiProcessFactory {
  readonly launches: ProcessLaunch[] = []; readonly processes: StubbornProcess[] = [];
  constructor(readonly stage: "spawn" | "spawn-claim" | "handshake" | "validation" | "registration" | "live", readonly post: PostExpiry) {}
  async spawn(spec: ProcessLaunch, _signal?: AbortSignal, onSpawn?: (process: PiProcess) => void): Promise<StubbornProcess> { this.launches.push(spec); const process = new StubbornProcess(`stubborn-${this.processes.length + 1}`); this.processes.push(process); onSpawn?.(process); if (this.stage === "spawn") this.post.fire(); return process; }
}
class ExactIdentityResolver implements ProcessIdentityResolver {
  constructor(readonly processes: readonly StubbornProcess[]) {}
  async resolve(identity: string): Promise<PiProcess | undefined> { return this.processes.find(process => process.identity === identity); }
}
class MismatchedIdentityResolver implements ProcessIdentityResolver {
  async resolve(): Promise<PiProcess> { return new StubbornProcess("mismatched-process"); }
}
class PendingStubbornFactory implements PiProcessFactory {
  readonly launches: ProcessLaunch[] = []; readonly processes: StubbornProcess[] = [];
  async spawn(spec: ProcessLaunch, signal?: AbortSignal, onSpawn?: (process: PiProcess) => void): Promise<StubbornProcess> { this.launches.push(spec); const process = new StubbornProcess("pending-stubborn"); this.processes.push(process); onSpawn?.(process); await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("spawn aborted after creation")), { once: true })); return process; }
}

for (const stage of ["spawn", "spawn-claim", "handshake", "validation"] as const) test(`termination failure after ${stage} retains an actionable first-session process`, async () => {
  const raceClock = new ManualClock(); const post = new PostExpiry(raceClock); const store = new PostStore(stage, post); await store.create(run({ runtimeResolution: runtime })); const factory = new StubbornFactory(stage, post); const validator = async () => { if (stage === "validation") post.fire(); };
  const runner = new PiRunner(factory, new PostResolver(stage, post), store, postConfig, validator, async () => "trusted role", raceClock); const pending = runner.launch("run_example01", "implement");
  if (stage === "handshake" || stage === "validation") { await waitUntil(() => factory.processes[0]?.writes.length === 1); factory.processes[0]!.respondToLast("get_state", true, { model: { provider: "provider", id: "model" }, sessionId: "first", sessionFile: "/ticket/sessions/implement/first.jsonl" }); if (stage === "handshake") post.fire(); }
  await assert.rejects(pending, error => error instanceof AggregateError && /cleanup could not converge/.test(error.message));
  const process = factory.processes[0]!; const retained = (await store.read("run_example01"))!.processAllocations?.implement; const tracked = runner.allocating.get("run_example01:implement")?.process ?? runner.live.get("run_example01:implement")?.process;
  assert.deepEqual(process.signals, ["SIGTERM", "SIGKILL"]); assert.equal(process.exitCode, null); assert.equal(tracked, process); assert.equal(retained?.state, "termination_failed"); assert.equal(retained?.processIdentity, process.identity); assert.throws(() => runner.release("run_example01", "implement"), /allocating process|live process/);
  await assert.rejects(runner.launch("run_example01", "implement"), /unresolved allocating process|live process/); const restarted = new PiRunner(factory, new PostResolver(stage, post), store, postConfig, async () => undefined, async () => "trusted role", raceClock, new ExactIdentityResolver(factory.processes)); await assert.rejects(restarted.launch("run_example01", "implement"), /reconciliation/); assert.equal(factory.processes.length, 1);
  process.observeExit(); await waitUntil(async () => (await store.read("run_example01"))!.processAllocations?.implement?.state === "failed"); await waitUntil(() => runner.allocating.size === 0 && runner.live.size === 0); assert.equal((await store.read("run_example01"))!.sessions.implement, undefined);
});

test("termination failure retains a process exposed before its spawn promise settles", async () => {
  const raceClock = new ManualClock(); const store = new InMemoryWorkflowStore(); await store.create(run({ runtimeResolution: runtime })); const factory = new PendingStubbornFactory(); const runner = new PiRunner(factory, new FakeRuntimeResolver(runtime), store, postConfig, async () => undefined, async () => "trusted role", raceClock); const pending = runner.launch("run_example01", "implement");
  await waitUntil(() => factory.processes.length === 1); raceClock.advance(6); await assert.rejects(pending, AggregateError); const process = factory.processes[0]!; const allocation = (await store.read("run_example01"))!.processAllocations?.implement;
  assert.equal(runner.allocating.get("run_example01:implement")?.process, process); assert.equal(process.exitCode, null); assert.deepEqual(process.signals, ["SIGTERM", "SIGKILL"]); assert.equal(allocation?.state, "termination_failed"); assert.equal(allocation?.processIdentity, process.identity); await assert.rejects(runner.launch("run_example01", "implement"), /unresolved/);
  process.observeExit(); await waitUntil(async () => (await store.read("run_example01"))!.processAllocations?.implement?.state === "failed"); await waitUntil(() => runner.allocating.size === 0);
});

test("a restarted runner reaps durable termination failure and unwedges a resumed generation", async () => {
  const raceClock = new ManualClock(); const post = new PostExpiry(raceClock); const store = new PostStore("spawn", post); const registration: SessionRegistration = { runId: "run_example01", role: "implement", sessionId: "registered", sessionFile: "/ticket/sessions/implement/registered.jsonl", processGeneration: 1, processState: "exited", registeredAt: runtime.resolvedAt }; await store.create(run({ runtimeResolution: runtime, sessions: { implement: registration } })); const factory = new StubbornFactory("spawn", post);
  const failedRunner = new PiRunner(factory, new PostResolver("spawn", post), store, postConfig, async () => undefined, async () => "trusted role", raceClock); await assert.rejects(failedRunner.launch("run_example01", "implement"), AggregateError); const process = factory.processes[0]!; process.removeAllListeners("exit");
  const blindRestart = new PiRunner(factory, new PostResolver("spawn", post), store, postConfig, async () => undefined, async () => "trusted role", raceClock); await assert.rejects(blindRestart.reconcileProcessAllocation("run_example01", "implement"), /could not be resolved/); assert.equal((await store.read("run_example01"))!.processAllocations?.implement?.state, "termination_failed");
  const restarted = new PiRunner(factory, new PostResolver("spawn", post), store, postConfig, async () => undefined, async () => "trusted role", raceClock, new ExactIdentityResolver(factory.processes)); await assert.rejects(restarted.launch("run_example01", "implement"), /reconciliation/); assert.equal(factory.processes.length, 1);
  await assert.rejects(restarted.reconcileProcessAllocation("run_example01", "implement"), /observed exit timeout/); assert.equal(restarted.allocating.get("run_example01:implement")?.process, process); assert.equal((await store.read("run_example01"))!.processAllocations?.implement?.state, "termination_failed");
  process.cooperative = true; await restarted.reconcileProcessAllocation("run_example01", "implement"); const recovered = (await store.read("run_example01"))!; assert.equal(restarted.allocating.size, 0); assert.equal(recovered.processAllocations?.implement, undefined); assert.equal(recovered.sessions.implement?.processState, "failed");
  const index = factory.processes.length; const retry = restarted.launch("run_example01", "implement"); await waitUntil(() => factory.processes[index]?.writes.length === 1); factory.processes[index]!.respondToLast("get_state", true, { model: { provider: "provider", id: "model" }, sessionId: registration.sessionId, sessionFile: registration.sessionFile }); await retry; assert.equal((await store.read("run_example01"))!.sessions.implement?.processState, "live");
});

test("registered cleanup cannot clobber a newer process generation", async () => {
  const raceClock = new ManualClock(); const store = new InMemoryWorkflowStore(); const old = new StubbornProcess("old-process"); old.cooperative = true; const registration: SessionRegistration = { runId: "run_example01", role: "implement", sessionId: "registered", sessionFile: "/ticket/sessions/implement/registered.jsonl", processGeneration: 1, processState: "live", processIdentity: old.identity, registeredAt: runtime.resolvedAt }; await store.create(run({ runtimeResolution: runtime, sessions: { implement: registration } }));
  const resolver: ProcessIdentityResolver = { resolve: async () => { const current = (await store.read("run_example01"))!; await store.compareAndSet("run_example01", { version: current.version }, snapshot => ({ ...snapshot, version: snapshot.version + 1, sessions: { ...snapshot.sessions, implement: { ...registration, processGeneration: 2, processState: "live", processIdentity: "new-process" } } })); return old; } };
  const runner = new PiRunner(new FakePiProcessFactory(), new FakeRuntimeResolver(runtime), store, postConfig, async () => undefined, async () => "trusted role", raceClock, resolver); await assert.rejects(runner.reconcileProcessAllocation("run_example01", "implement"), /generation changed/); const current = (await store.read("run_example01"))!.sessions.implement!;
  assert.equal(old.exitCode, 143); assert.equal(current.processGeneration, 2); assert.equal(current.processIdentity, "new-process"); assert.equal(current.processState, "live"); assert.equal(runner.allocating.size, 0);
});

for (const stage of ["registration", "live"] as const) test(`restart repeatedly reaps a registered ${stage} termination failure before exact-session relaunch`, async () => {
  const raceClock = new ManualClock(); const post = new PostExpiry(raceClock); const store = new PostStore(stage, post); const registration: SessionRegistration = { runId: "run_example01", role: "implement", sessionId: "registered", sessionFile: "/ticket/sessions/implement/registered.jsonl", processGeneration: 1, processState: "exited", registeredAt: runtime.resolvedAt }; await store.create(run({ runtimeResolution: runtime, ...(stage === "live" ? { sessions: { implement: registration } } : {}) })); const factory = new StubbornFactory(stage, post);
  const first = new PiRunner(factory, new PostResolver(stage, post), store, postConfig, async () => undefined, async () => "trusted role", raceClock); const pending = first.launch("run_example01", "implement"); await waitUntil(() => factory.processes[0]?.writes.length === 1); factory.processes[0]!.respondToLast("get_state", true, { model: { provider: "provider", id: "model" }, sessionId: registration.sessionId, sessionFile: registration.sessionFile }); await assert.rejects(pending, AggregateError); const process = factory.processes[0]!; process.removeAllListeners("exit"); const persisted = (await store.read("run_example01"))!.sessions.implement!;
  assert.equal((await store.read("run_example01"))!.processAllocations?.implement, undefined); assert.equal(persisted.processState, "live"); assert.equal(persisted.processIdentity, process.identity); const generation = persisted.processGeneration;
  const blind = new PiRunner(factory, new PostResolver(stage, post), store, postConfig, async () => undefined, async () => "trusted role", raceClock); await assert.rejects(blind.reconcileProcessAllocation("run_example01", "implement"), /could not be resolved/); const mismatch = new PiRunner(factory, new PostResolver(stage, post), store, postConfig, async () => undefined, async () => "trusted role", raceClock, new MismatchedIdentityResolver()); await assert.rejects(mismatch.reconcileProcessAllocation("run_example01", "implement"), /mismatched handle/);
  const restarted = new PiRunner(factory, new PostResolver(stage, post), store, postConfig, async () => undefined, async () => "trusted role", raceClock, new ExactIdentityResolver(factory.processes)); await assert.rejects(restarted.reconcileProcessAllocation("run_example01", "implement"), /observed exit timeout/); await assert.rejects(restarted.reconcileProcessAllocation("run_example01", "implement"), /observed exit timeout/); assert.deepEqual(process.signals, ["SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL", "SIGTERM", "SIGKILL"]); assert.equal(restarted.allocating.get("run_example01:implement")?.process, process); assert.equal((await store.read("run_example01"))!.sessions.implement?.processIdentity, process.identity);
  await assert.rejects(restarted.launch("run_example01", "implement"), /unresolved/); const otherRestart = new PiRunner(factory, new PostResolver(stage, post), store, postConfig, async () => undefined, async () => "trusted role", raceClock); await assert.rejects(otherRestart.launch("run_example01", "implement"), /registered session changed/); assert.equal(factory.processes.length, 1);
  process.cooperative = true; await restarted.reconcileProcessAllocation("run_example01", "implement"); assert.equal((await store.read("run_example01"))!.sessions.implement?.processState, "failed"); assert.equal((await store.read("run_example01"))!.sessions.implement?.processGeneration, generation); assert.equal(restarted.allocating.size, 0);
  const index = factory.processes.length; const retry = restarted.launch("run_example01", "implement"); await waitUntil(() => factory.processes[index]?.writes.length === 1); factory.processes[index]!.respondToLast("get_state", true, { model: { provider: "provider", id: "model" }, sessionId: registration.sessionId, sessionFile: registration.sessionFile }); await retry; const relaunched = (await store.read("run_example01"))!.sessions.implement!; assert.equal(relaunched.processState, "live"); assert.equal(relaunched.processGeneration, generation + 1);
});
