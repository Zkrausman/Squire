import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ROLES, type Clock, type LeaseGuard, type Role, type RunPrecondition, type RunSnapshot, type RuntimeResolution, type SessionRegistration } from "../src/control/domain.js";
import type { PiProcess, ProcessLaunch, PiProcessFactory, RuntimeResolver } from "../src/pi/pi-process.js";
import { validateSessionRegistration } from "../src/pi/session-registry.js";
import { PiRunner } from "../src/pi/pi-runner.js";
import { InMemoryWorkflowStore } from "./support/in-memory-workflow-store.js";
import { FakePiProcess, FakePiProcessFactory, FakeRuntimeResolver } from "./support/fake-pi-process.js";
import { run, runtime } from "./support/fixtures.js";

const roleConfig = Object.fromEntries(ROLES.map(role => [role, { provider: "provider", model: "model", instructionsPath: `/ticket/control/roles/${role}.md`, timeoutSeconds: 30 }])) as Record<Role, { provider: string; model: string; instructionsPath: string; timeoutSeconds: number }>;
const clock: Clock = { now: () => Date.parse("2026-09-01T12:00:00Z"), sleep: () => new Promise<void>(() => undefined) };
async function session(root: string, role: Role, id: string): Promise<string> { const dir = path.join(root, role); await mkdir(dir, { recursive: true }); const file = path.join(dir, `2026_${id}.jsonl`); await writeFile(file, `${JSON.stringify({ type: "session", id })}\n`); return file; }
async function settleLaunch(runner: PiRunner, factory: FakePiProcessFactory, runId: string, role: Role, sessionId: string, file: string) { const count = factory.processes.length; const pending = runner.launch(runId, role); for (let tries = 0; tries < 2_000; tries += 1) { const process = factory.processes[count]; if (process?.writes.length) { process.respondToLast("get_state", true, { model: { provider: "provider", id: "model" }, sessionId, sessionFile: file }); return pending; } await new Promise(resolve => setTimeout(resolve, 1)); } throw new Error("Pi process did not request get_state"); }
async function setup() { const root = await mkdtemp(path.join(os.tmpdir(), "squire-runner-")); for (const role of ROLES) await mkdir(path.join(root, role), { recursive: true }); const store = new InMemoryWorkflowStore(); await store.create(run()); const factory = new FakePiProcessFactory(); const resolver = new FakeRuntimeResolver(runtime); const runner = new PiRunner(factory, resolver, store, { roles: roleConfig, sessionRoot: root }, registration => validateSessionRegistration(registration, root), async () => "trusted role", clock); return { root, store, factory, resolver, runner }; }

test("five roles register five independent live processes and one run-scoped runtime", async () => {
  const { root, store, factory, resolver, runner } = await setup(); const identities = new Set<string>(); const ids = new Set<string>();
  for (const role of ROLES) { const file = await session(root, role, role); const launched = await settleLaunch(runner, factory, "run_example01", role, role, file); identities.add(launched.process.identity); ids.add(launched.state.sessionId); assert.equal(factory.launches.at(-1)?.command, runtime.pi.executable); }
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
async function waitUntil(predicate: () => boolean): Promise<void> { for (let tries = 0; tries < 2_000; tries += 1) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); } throw new Error("race did not reach expected stall"); }

for (const stall of ["lookup", "reservation", "runtime", "runtime-record", "instructions", "spawn-intent", "spawn", "spawn-claim", "handshake", "validation", "registration"] as const) test(`first-session ${stall} stall is bounded and fenced`, async () => {
  const gate = new Gate(); const raceClock = new ManualClock(); const store = new RaceStore(stall, gate); await store.create(run(["runtime", "runtime-record"].includes(stall) ? {} : { runtimeResolution: runtime }));
  const factory = new RaceFactory(stall, gate); const resolver = new RaceResolver(stall, gate); let instructionCalls = 0; let validationCalls = 0;
  const instructions = async (_path: string, signal?: AbortSignal) => { if (stall === "instructions" && instructionCalls++ === 0) await gate.wait(signal); return "trusted role"; };
  const validator = async (_registration: SessionRegistration, signal?: AbortSignal) => { if (stall === "validation" && validationCalls++ === 0) await gate.wait(signal); };
  const config = { roles: roleConfig, processLeaseMs: 10, allocationStepTimeoutMs: 5, allocationTimeoutMs: 100 };
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
  const factory = new RaceFactory("generation", gate); const resolver = new RaceResolver("generation", gate); const config = { roles: roleConfig, processLeaseMs: 10, allocationStepTimeoutMs: 5, allocationTimeoutMs: 100 };
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
const postConfig = { roles: roleConfig, processLeaseMs: 10, allocationStepTimeoutMs: 5, allocationTimeoutMs: 100, commandTimeoutMs: 100 };

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
