import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ROLES, type Clock, type Role } from "../src/control/domain.js";
import { validateSessionRegistration } from "../src/pi/session-registry.js";
import { PiRunner } from "../src/pi/pi-runner.js";
import { InMemoryWorkflowStore } from "./support/in-memory-workflow-store.js";
import { FakePiProcessFactory, FakeRuntimeResolver } from "./support/fake-pi-process.js";
import { run, runtime } from "./support/fixtures.js";

const roleConfig = Object.fromEntries(ROLES.map(role => [role, { provider: "provider", model: "model", instructionsPath: `/ticket/control/roles/${role}.md`, timeoutSeconds: 30 }])) as Record<Role, { provider: string; model: string; instructionsPath: string; timeoutSeconds: number }>;
const clock: Clock = { now: () => Date.parse("2026-09-01T12:00:00Z"), sleep: async () => {} };
async function session(root: string, role: Role, id: string): Promise<string> { const dir = path.join(root, role); await mkdir(dir, { recursive: true }); const file = path.join(dir, `2026_${id}.jsonl`); await writeFile(file, `${JSON.stringify({ type: "session", id })}\n`); return file; }
async function settleLaunch(runner: PiRunner, factory: FakePiProcessFactory, runId: string, role: Role, sessionId: string, file: string) { const count = factory.processes.length; const pending = runner.launch(runId, role); for (let tries = 0; tries < 2_000; tries += 1) { const process = factory.processes[count]; if (process?.writes.length) { process.respondToLast("get_state", true, { model: { provider: "provider", id: "model" }, sessionId, sessionFile: file }); return pending; } await new Promise(resolve => setTimeout(resolve, 1)); } throw new Error("Pi process did not request get_state"); }
async function setup() { const root = await mkdtemp(path.join(os.tmpdir(), "squire-runner-")); for (const role of ROLES) await mkdir(path.join(root, role), { recursive: true }); const store = new InMemoryWorkflowStore(); await store.create(run()); const factory = new FakePiProcessFactory(); const resolver = new FakeRuntimeResolver(runtime); const runner = new PiRunner(factory, resolver, store, { roles: roleConfig, sessionRoot: root }, registration => validateSessionRegistration(registration, root), async () => "trusted role", clock); return { root, store, factory, resolver, runner }; }

test("five roles register five independent live processes and one run-scoped runtime", async () => {
  const { root, store, factory, resolver, runner } = await setup(); const identities = new Set<string>(); const ids = new Set<string>();
  for (const role of ROLES) { const file = await session(root, role, role); const launched = await settleLaunch(runner, factory, "run_example01", role, role, file); identities.add(launched.process.identity); ids.add(launched.state.sessionId); assert.equal(factory.launches.at(-1)?.command, runtime.pi.executable); }
  assert.equal(identities.size, 5); assert.equal(ids.size, 5); assert.equal(runner.live.size, 5); assert.equal(resolver.calls, 1);
  const persisted = await store.read("run_example01"); for (const role of ROLES) { assert.equal(persisted?.sessions[role]?.processState, "live"); assert.equal(persisted?.sessions[role]?.sessionFile, path.join(root, role, `2026_${role}.jsonl`)); }
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
