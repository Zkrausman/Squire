import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ROLES, type Clock, type Role } from "../src/control/domain.js";
import type { MaterializedPiAgentDirectory, PiAgentDirectoryRequest, PiAgentDirectoryMaterializerPort } from "../src/pi/pi-agent-directory.js";
import type { PiProcessFactory, ProcessLaunch } from "../src/pi/pi-process.js";
import { PiRunner } from "../src/pi/pi-runner.js";
import { InMemoryWorkflowStore } from "./support/in-memory-workflow-store.js";
import { FakePiProcess, FakePiProcessFactory } from "./support/fake-pi-process.js";
import { run, runtime } from "./support/fixtures.js";

const clock: Clock = { now: () => Date.parse("2026-09-01T12:00:00Z"), sleep: () => new Promise<void>(() => undefined) };
const profiles = {
  orchestrator: { provider: "provider-orchestrator", model: "model-orchestrator", thinking: "high" as const },
  plan: { provider: "provider-plan", model: "model-plan", thinking: "low" as const },
  implement: { provider: "provider-implement", model: "model-implement", thinking: "max" as const },
  review: { provider: "provider-review", model: "model-review", thinking: "medium" as const },
  test: { provider: "provider-test", model: "model-test", thinking: "xhigh" as const },
};
const roleConfig = Object.fromEntries(ROLES.map(role => [role, {
  ...profiles[role],
  instructionsPath: `/ticket/control/roles/${role}.md`,
  timeoutSeconds: 30,
}])) as Record<Role, typeof profiles[Role] & { instructionsPath: string; timeoutSeconds: number }>;

class RecordingMaterializer implements PiAgentDirectoryMaterializerPort {
  calls = 0;
  verifyCalls = 0;
  readonly requests: PiAgentDirectoryRequest[] = [];
  async materialize(request: PiAgentDirectoryRequest): Promise<MaterializedPiAgentDirectory> {
    this.calls += 1;
    this.requests.push(request);
    return {
      runId: request.runId,
      agentDir: `/ticket/runtime/${request.runId}/pi-agent`,
      settingsPath: `/ticket/runtime/${request.runId}/pi-agent/settings.json`,
      manifestPath: `/ticket/runtime/${request.runId}/pi-agent/squire-agent-manifest.json`,
      footerExtensionPath: `/ticket/runtime/${request.runId}/pi-agent/extensions/footer.mjs`,
      homeDir: `/ticket/runtime/${request.runId}/home`,
      wikiHomeDir: `/ticket/runtime/${request.runId}/wiki-home`,
      trustedExtensionPaths: [
        "/ticket/runtime/wiki/extensions/llm-wiki/index.ts",
        `/ticket/runtime/${request.runId}/pi-agent/extensions/footer.mjs`,
      ],
      wikiExtensionDigest: "b".repeat(64),
      extensionDigest: "a".repeat(64),
      packageDigest: "c".repeat(64),
    };
  }
  async verify(_request: PiAgentDirectoryRequest, _materialized: MaterializedPiAgentDirectory): Promise<void> {
    this.verifyCalls += 1;
  }
}

class ProjectCheckingMaterializer extends RecordingMaterializer {
  override async verify(request: PiAgentDirectoryRequest, materialized: MaterializedPiAgentDirectory): Promise<void> {
    await super.verify(request, materialized);
    if (!request.workspace) return;
    try {
      const parsed = JSON.parse(await readFile(path.join(request.workspace, ".pi", "settings.json"), "utf8")) as Record<string, any>;
      const task = parsed["llm-wiki"]?.taskModel;
      if (task && (task.provider !== request.wikiProfile.provider || task.id !== request.wikiProfile.model)) throw new Error("project settings conflict with the controller-selected wiki model");
    } catch (error) {
      if (error instanceof Error && error.message.includes("project settings conflict")) throw error;
      if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT") return;
      throw error;
    }
  }
}

async function waitForStateRequest(factory: FakePiProcessFactory, index: number): Promise<FakePiProcess> {
  for (let tries = 0; tries < 2_000; tries += 1) {
    const process = factory.processes[index];
    if (process?.writes.length) return process;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error("Pi process did not request state");
}

test("runner selects each independent profile and shares one run materialization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-profile-runner-"));
  for (const role of ROLES) await mkdir(path.join(root, role), { recursive: true });
  const store = new InMemoryWorkflowStore();
  await store.create(run());
  const factory = new FakePiProcessFactory();
  const materializer = new RecordingMaterializer();
  const runner = new PiRunner(
    factory,
    { resolve: async () => structuredClone(runtime) },
    store,
    { roles: roleConfig, sessionRoot: root, materializer },
    async () => undefined,
    async () => "trusted role",
    clock,
  );

  for (const role of ROLES) {
    const processIndex = factory.processes.length;
    const pending = runner.launch("run_example01", role);
    const process = await waitForStateRequest(factory, processIndex);
    const profile = profiles[role];
    const sessionFile = `/ticket/sessions/${role}/session-${role}.jsonl`;
    process.respondToLast("get_state", true, { model: { provider: profile.provider, id: profile.model }, thinkingLevel: profile.thinking, sessionId: `session-${role}`, sessionFile });
    await pending;
    const launch = factory.launches.at(-1)!;
    assert.equal(launch.args[launch.args.indexOf("--provider") + 1], profile.provider);
    assert.equal(launch.args[launch.args.indexOf("--model") + 1], profile.model);
    assert.equal(launch.args[launch.args.indexOf("--thinking") + 1], profile.thinking);
    assert.equal(launch.env["PI_CODING_AGENT_DIR"], "/ticket/runtime/run_example01/pi-agent");
    assert.equal(launch.env["HOME"], "/ticket/runtime/run_example01/home");
    assert.equal(launch.env["WIKI_HOME"], "/ticket/runtime/run_example01/wiki-home");
    assert.ok(launch.args.includes("--no-extensions"));
    const wikiAt = launch.args.indexOf("--extension");
    assert.equal(launch.args[wikiAt + 1], "/ticket/runtime/wiki/extensions/llm-wiki/index.ts");
    assert.equal(launch.args[wikiAt + 2], "--extension");
  }
  assert.equal(materializer.calls, 5);
  assert.equal(materializer.verifyCalls, 5);
  assert.equal(materializer.requests[0]!.wikiProfile.provider, "openai-codex");
  assert.equal(materializer.requests[0]!.wikiProfile.model, "gpt-5.6-luna");
  assert.equal(materializer.requests[0]!.wikiProfile.thinking, "high");
  assert.equal(runner.live.size, 5);
});

class OneProcessFactory implements PiProcessFactory {
  readonly process = new FakePiProcess("thinking-mismatch");
  readonly launches: ProcessLaunch[] = [];
  async spawn(spec: ProcessLaunch, _signal?: AbortSignal, onSpawn?: (process: FakePiProcess) => void): Promise<FakePiProcess> {
    this.launches.push(spec);
    onSpawn?.(this.process);
    return this.process;
  }
}

test("runner rechecks project overrides on each role launch instead of trusting a settled preparation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-project-override-runner-"));
  for (const role of ROLES) await mkdir(path.join(root, role), { recursive: true });
  const store = new InMemoryWorkflowStore();
  await store.create(run());
  const factory = new FakePiProcessFactory();
  const materializer = new ProjectCheckingMaterializer();
  const runner = new PiRunner(
    factory,
    { resolve: async () => structuredClone(runtime) },
    store,
    { roles: roleConfig, sessionRoot: root, workspace: root, materializer },
    async () => undefined,
    async () => "trusted role",
    clock,
  );
  const first = runner.launch("run_example01", "orchestrator");
  const process = await waitForStateRequest(factory, 0);
  process.respondToLast("get_state", true, { model: { provider: profiles.orchestrator.provider, id: profiles.orchestrator.model }, thinkingLevel: profiles.orchestrator.thinking, sessionId: "orchestrator", sessionFile: "/ticket/sessions/orchestrator/session.jsonl" });
  await first;
  await mkdir(path.join(root, ".pi"), { recursive: true });
  await writeFile(path.join(root, ".pi", "settings.json"), JSON.stringify({ "llm-wiki": { taskModel: { provider: "spoof-provider", id: "spoof-model" } } }));
  await assert.rejects(runner.launch("run_example01", "plan"), /project settings conflict/);
  assert.equal(factory.processes.length, 1);
  assert.equal(materializer.calls, 2);
  assert.equal(materializer.verifyCalls, 2);
});

test("thinking-level handshake mismatch fails closed before registration", async () => {
  const store = new InMemoryWorkflowStore();
  await store.create(run());
  const factory = new OneProcessFactory();
  const materializer = new RecordingMaterializer();
  const config = { roles: roleConfig, materializer, processLeaseMs: 100, allocationStepTimeoutMs: 50, allocationTimeoutMs: 500 };
  const runner = new PiRunner(factory, { resolve: async () => structuredClone(runtime) }, store, config, async () => undefined, async () => "trusted role", clock);
  const pending = runner.launch("run_example01", "implement");
  await waitForStateRequest({ processes: [factory.process] } as unknown as FakePiProcessFactory, 0);
  factory.process.respondToLast("get_state", true, { model: { provider: "provider-implement", id: "model-implement" }, thinkingLevel: "low", sessionId: "session", sessionFile: "/ticket/sessions/implement/session.jsonl" });
  await assert.rejects(pending, /thinking level mismatch/);
  assert.notEqual(factory.process.exitCode, null);
  assert.equal((await store.read("run_example01"))?.sessions.implement, undefined);
});

class ExpiringClock implements Clock {
  value = 0;
  readonly sleepers: Array<{ due: number; resolve: () => void; signal?: AbortSignal }> = [];
  now(): number { return this.value; }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const item = { due: this.value + ms, resolve, ...(signal ? { signal } : {}) };
      this.sleepers.push(item);
      signal?.addEventListener("abort", () => reject(new Error("sleep aborted")), { once: true });
    });
  }
  advance(ms: number): void {
    this.value += ms;
    for (const item of this.sleepers.splice(0)) {
      if (item.due <= this.value && !item.signal?.aborted) item.resolve();
      else this.sleepers.push(item);
    }
  }
}

class BlockingMaterializer implements PiAgentDirectoryMaterializerPort {
  readonly entered: Promise<void>;
  #enter!: () => void;
  async materialize(request: PiAgentDirectoryRequest): Promise<MaterializedPiAgentDirectory> {
    this.#enter();
    await new Promise<void>((resolve, reject) => {
      request.signal?.addEventListener("abort", () => reject(new Error("materialization aborted")), { once: true });
      if (!request.signal) resolve();
    });
    throw new Error("materialization should not reach spawn");
  }
  constructor() { this.entered = new Promise(resolve => { this.#enter = resolve; }); }
}

test("materialization is a bounded pre-spawn stage and lease expiry cannot spawn", async () => {
  const raceClock = new ExpiringClock();
  const store = new InMemoryWorkflowStore();
  await store.create(run());
  const factory = new FakePiProcessFactory();
  const materializer = new BlockingMaterializer();
  const runner = new PiRunner(
    factory,
    { resolve: async () => structuredClone(runtime) },
    store,
    { roles: roleConfig, materializer, processLeaseMs: 10, allocationStepTimeoutMs: 5, allocationTimeoutMs: 50 },
    async () => undefined,
    async () => "trusted role",
    raceClock,
  );
  const pending = runner.launch("run_example01", "implement");
  await materializer.entered;
  raceClock.advance(51);
  await assert.rejects(pending, /allocation|materialization|expired|bounded|aborted/);
  assert.equal(factory.processes.length, 0);
});
