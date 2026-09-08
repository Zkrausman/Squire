import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PI_ROLE_PROFILES, type PiRoleConfig } from "../src/pi/pi-configuration.js";
import { PiAgentDirectoryMaterializer } from "../src/pi/pi-agent-directory.js";
import { PiRunner } from "../src/pi/pi-runner.js";
import { validateSessionRegistration } from "../src/pi/session-registry.js";
import { acquireActualPiResource } from "./support/actual-pi-resource.js";
import { createGitFixture } from "./support/git-fixture.js";
import { FakePiProcessFactory, FakeRuntimeResolver } from "./support/fake-pi-process.js";
import { RealPiProcessFactory } from "./support/real-pi-process.js";
import { runtime } from "./support/fixtures.js";
import { createControllableClock } from "./support/controllable-clock.js";

const REAL_PI_CLI = "/ticket/runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const REAL_WIKI_ROOT = "/ticket/runtime/node_modules/@zosmaai/pi-llm-wiki";

/** Real AIDEV-222/AIDEV-228 composition test. The only fake is the Pi child;
 * Git, the materializer, profile defaults, footer bytes, and lifecycle store
 * are exercised against temporary ticket/repository roots. */
test("Git readiness gates real Pi materialization and ordered aggregate teardown", async t => {
  const clock = createControllableClock();
  const fixture = await createGitFixture({ clock });
  t.after(fixture.cleanup);
  const wikiRoot = path.join(fixture.root, "wiki-installation");
  await mkdir(path.join(wikiRoot, "extensions", "llm-wiki"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(wikiRoot, "package.json"), JSON.stringify({ name: "@zosmaai/pi-llm-wiki", version: "0.11.8" }) + "\n", { mode: 0o600 });
  await writeFile(path.join(wikiRoot, "extensions", "llm-wiki", "index.ts"), "export default function trustedWiki() {}\n", { mode: 0o600 });
  await chmod(wikiRoot, 0o700);
  const resolvedRuntime = structuredClone({ ...((await import("./support/fixtures.js")).runtime), llmWiki: { version: "0.11.8", installationId: "wiki-install-A", root: wikiRoot } });
  const runtimeRoot = path.join(fixture.ticketRoot, "runtime");
  const sessionRoot = path.join(fixture.root, "sessions");
  const workspace = path.join(fixture.ticketRoot, "workspace");
  await mkdir(path.join(sessionRoot, "implement"), { recursive: true, mode: 0o700 });
  const sessionFile = path.join(sessionRoot, "implement", "2026_first.jsonl");
  await writeFile(sessionFile, JSON.stringify({ type: "session", id: "first" }) + "\n", { mode: 0o600 });
  const materializer = new PiAgentDirectoryMaterializer({
    runtimeRoot,
    workspace,
    wikiInstallation: { root: wikiRoot, installationId: resolvedRuntime.llmWiki.installationId, version: resolvedRuntime.llmWiki.version },
    runLifecycleAuthority: fixture.store,
  });
  const roles = Object.fromEntries(Object.entries(DEFAULT_PI_ROLE_PROFILES).map(([role, profile]) => [role, { ...profile, instructionsPath: `/ticket/control/roles/${role}.md`, timeoutSeconds: 30 }])) as Record<keyof typeof DEFAULT_PI_ROLE_PROFILES, PiRoleConfig>;
  const factory = new FakePiProcessFactory();
  const runner = new PiRunner(
    factory,
    new FakeRuntimeResolver(resolvedRuntime),
    fixture.store,
    { roles, workspaceReadiness: fixture.service, workspace, sessionRoot, materializer },
    (registration, signal) => validateSessionRegistration(registration, sessionRoot),
    async () => "trusted implement instructions",
    { now: () => Date.now(), sleep: (ms, signal) => new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("sleep aborted")); }, { once: true }); }) },
  );

  await assert.rejects(() => runner.launch(fixture.input.runId, "implement"), /workspace|ready|record/);
  assert.equal(factory.processes.length, 0, "Pi must not spawn before Git readiness");

  const spec = await fixture.service.createSpec(fixture.input);
  const ready = await fixture.service.provision(fixture.input.runId, spec, "real-cross-component");
  const launchPromise = runner.launch(fixture.input.runId, "implement");
  let launchFailure: unknown;
  void launchPromise.catch(error => { launchFailure = error; });
  for (let tries = 0; tries < 30_000 && factory.processes.length === 0 && !launchFailure; tries += 1) await new Promise(resolve => setTimeout(resolve, 1));
  if (launchFailure) throw launchFailure;
  const process = factory.processes[0];
  assert.ok(process, "Pi process was not spawned after Git readiness");
  process.respondToLast("get_state", true, { model: { provider: roles.implement.provider, id: roles.implement.model }, sessionId: "first", sessionFile });
  const launched = await launchPromise;
  assert.equal(launched.agentDir, path.join(runtimeRoot, fixture.input.runId, "pi-agent"));
  const materialized = await materializer.materialize({ runId: fixture.input.runId, runtime: resolvedRuntime, wikiProfile: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" }, workspace });
  assert.deepEqual(materialized.trustedExtensionPaths, [path.join(wikiRoot, "extensions", "llm-wiki", "index.ts"), materialized.footerExtensionPath]);
  assert.equal(JSON.parse(await readFile(materialized.settingsPath, "utf8")).packages[0], wikiRoot);
  assert.match(await readFile(materialized.footerExtensionPath, "utf8"), /llm-wiki-model|session_start/u);
  assert.equal(ready.paths.worktree, "/ticket/workspace");

  process.kill("SIGTERM");
  for (let tries = 0; tries < 1_000; tries += 1) {
    if ((await fixture.store.read(fixture.input.runId))?.sessions.implement?.processState !== "live") break;
    await new Promise(resolve => setImmediate(resolve));
  }
  runner.release(fixture.input.runId, "implement");
  const policy = { outcome: "success" as const, workspaceRetainUntil: new Date(clock.now() + 60_000).toISOString(), bundleRetainUntil: new Date(clock.now() + 60_000).toISOString() };
  await fixture.service.markRetained(fixture.input.runId, policy, "real-cross-component-retention");
  // Advance the service's injected trusted clock only after retention is
  // durably recorded; the product deadline assertion remains active.
  clock.advance(120_000);
  const fence = await fixture.store.acquireRunTerminalFence(fixture.input.runId, "aggregate-owner", clock.now());
  await fixture.service.disposeUnderTerminalFence(fixture.input.runId, fence, { now: clock.now(), workspaceRetainUntil: policy.workspaceRetainUntil, bundleRetainUntil: policy.bundleRetainUntil });
  assert.equal(await readFile(materialized.footerExtensionPath, "utf8") !== "", true, "Git disposal must not remove AIDEV-228 footer state");
  assert.equal(await readFile(path.join(materialized.homeDir, "../pi-agent/settings.json"), "utf8") !== "", true);
  const teardown = await runner.teardownRunAgentDirectory(fixture.input.runId);
  assert.ok(teardown.capturesRemoved >= 0);
  await assert.rejects(() => fixture.service.verify(fixture.input.runId), /removed|terminal|record|workspace/);
  await assert.rejects(() => runner.launch(fixture.input.runId, "implement"), /removed|terminal|fence/);
});

test("real Git readiness gates an actual Pi launch and ordered teardown", { skip: !(existsSync(REAL_PI_CLI) && existsSync(REAL_WIKI_ROOT)) ? "Pi runtime dependency is unavailable" : false }, async t => {
  const clock = createControllableClock();
  const fixture = await createGitFixture({ clock });
  const factory = new RealPiProcessFactory();
  const actualPiResource = await acquireActualPiResource();
  t.after(async () => {
    try {
      for (const process of factory.processes) {
        if (process.exitCode === null) process.kill("SIGKILL");
        await process.waitForExit(5_000).catch(() => undefined);
      }
    } finally {
      try { await actualPiResource.release(); }
      finally { await fixture.cleanup(); }
    }
  });
  const runtimeRoot = path.join(fixture.ticketRoot, "runtime");
  const sessionRoot = path.join(fixture.root, "sessions");
  const workspace = path.join(fixture.ticketRoot, "workspace");
  await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
  const resolvedRuntime = structuredClone({ ...runtime, pi: { ...runtime.pi, executable: REAL_PI_CLI }, llmWiki: { ...runtime.llmWiki, root: REAL_WIKI_ROOT } });
  const materializer = new PiAgentDirectoryMaterializer({
    runtimeRoot,
    workspace,
    wikiInstallation: { root: REAL_WIKI_ROOT, installationId: resolvedRuntime.llmWiki.installationId, version: resolvedRuntime.llmWiki.version },
    runLifecycleAuthority: fixture.store,
  });
  const roles = Object.fromEntries(Object.entries(DEFAULT_PI_ROLE_PROFILES).map(([role, profile]) => [role, { ...profile, instructionsPath: `/ticket/control/roles/${role}.md`, timeoutSeconds: 30 }])) as Record<keyof typeof DEFAULT_PI_ROLE_PROFILES, PiRoleConfig>;
  let readinessChecks = 0;
  const readiness = { verify: async (runId: string, expectedHead?: string) => { readinessChecks += 1; return fixture.service.verify(runId, expectedHead); } };
  const runner = new PiRunner(
    factory,
    { resolve: async () => structuredClone(resolvedRuntime) },
    fixture.store,
    { roles, workspaceReadiness: readiness, workspace, sessionRoot, materializer, wiki: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" }, commandTimeoutMs: 30_000 },
    async () => undefined,
    async () => "trusted implement instructions",
    { now: () => Date.now(), sleep: (milliseconds, signal) => new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, milliseconds); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("sleep aborted")); }, { once: true }); }) },
  );

  await assert.rejects(() => runner.launch(fixture.input.runId, "implement"), /workspace|ready|record/u);
  assert.equal(factory.processes.length, 0, "actual Pi must not spawn before the real Git verifier succeeds");
  const spec = await fixture.service.createSpec(fixture.input);
  const ready = await fixture.service.provision(fixture.input.runId, spec, "real-git-real-pi");
  const prepared = await materializer.materialize({ runId: fixture.input.runId, runtime: resolvedRuntime, wikiProfile: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" }, workspace });
  await mkdir(path.join(prepared.wikiHomeDir, ".llm-wiki"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(prepared.wikiHomeDir, ".llm-wiki", "config.json"), JSON.stringify({ knowledge_format: "okf-0.2", name: "combined Git Pi E2E", topic: "combined Git Pi E2E", mode: "project", version: "1.0" }) + "\n", { mode: 0o600 });
  let launched: Awaited<ReturnType<typeof runner.launch>>;
  try {
    launched = await runner.launch(fixture.input.runId, "implement");
  } catch (error) {
    const child = factory.processes[0];
    if (!child) throw error;
    throw new AggregateError([error, new Error(child.diagnostic("real Git/Pi child startup diagnostics"))], "real Git/Pi launch failed with child startup diagnostics");
  }
  const process = factory.processes[0];
  assert.ok(process, "actual Pi process was not created after real Git readiness");
  assert.equal(launched.state.model?.provider, "openai-codex");
  assert.equal(launched.state.model?.id, "gpt-5.6-luna");
  assert.equal(launched.state.thinkingLevel, "max");
  const launch = factory.launches[0]!;
  const extensionArguments = launch.args.flatMap((value, index) => value === "--extension" ? [launch.args[index + 1]!] : []);
  assert.deepEqual(extensionArguments, [path.join(REAL_WIKI_ROOT, "extensions", "llm-wiki", "index.ts"), prepared.footerExtensionPath]);
  assert.ok(launch.args.indexOf(extensionArguments[0]!) < launch.args.indexOf(extensionArguments[1]!));
  assert.equal(launch.args.includes("--no-extensions"), true);
  assert.equal(launch.env["PI_CODING_AGENT_DIR"], prepared.agentDir);
  assert.equal(launch.env["HOME"], prepared.homeDir);
  assert.equal(launch.env["WIKI_HOME"], prepared.wikiHomeDir);
  assert.equal(launch.cwd, workspace);
  assert.equal(readinessChecks >= 3, true, "readiness must be checked before launch and again inside the final spawn step");
  assert.equal(process.errors.join(""), "");
  process.kill("SIGTERM");
  await process.waitForExit(5_000);
  for (let tries = 0; tries < 5_000; tries += 1) {
    const state = (await fixture.store.read(fixture.input.runId))?.sessions.implement?.processState;
    if (state !== "live" && state !== "launching") break;
    await new Promise(resolve => setImmediate(resolve));
  }
  runner.release(fixture.input.runId, "implement");
  const policy = { outcome: "success" as const, workspaceRetainUntil: new Date(clock.now() + 60_000).toISOString(), bundleRetainUntil: new Date(clock.now() + 60_000).toISOString() };
  await fixture.service.markRetained(fixture.input.runId, policy, "real-git-real-pi-retention");
  clock.advance(120_000);
  const fence = await fixture.store.acquireRunTerminalFence(fixture.input.runId, "real-git-real-pi-terminal", clock.now());
  await fixture.service.disposeUnderTerminalFence(fixture.input.runId, fence, { now: clock.now(), workspaceRetainUntil: policy.workspaceRetainUntil, bundleRetainUntil: policy.bundleRetainUntil });
  assert.equal((await readFile(prepared.footerExtensionPath, "utf8")).length > 0, true, "Git disposal must preserve AIDEV-228 footer state until Pi teardown");
  await runner.teardownRunAgentDirectory(fixture.input.runId);
  assert.equal(await readFile(prepared.footerExtensionPath, "utf8").then(() => true, () => false), false);
  assert.equal(ready.paths.worktree, "/ticket/workspace");
});
