import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PI_ROLE_PROFILES, type PiRoleConfig } from "../src/pi/pi-configuration.js";
import { PiAgentDirectoryMaterializer } from "../src/pi/pi-agent-directory.js";
import { PiRunner } from "../src/pi/pi-runner.js";
import { validateSessionRegistration } from "../src/pi/session-registry.js";
import { createGitFixture } from "./support/git-fixture.js";
import { FakePiProcessFactory, FakeRuntimeResolver } from "./support/fake-pi-process.js";

/** Real AIDEV-222/AIDEV-228 composition test. The only fake is the Pi child;
 * Git, the materializer, profile defaults, footer bytes, and lifecycle store
 * are exercised against temporary ticket/repository roots. */
test("Git readiness gates real Pi materialization and ordered aggregate teardown", async t => {
  const fixture = await createGitFixture();
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
  const policy = { outcome: "success" as const, workspaceRetainUntil: new Date(Date.now() + 100).toISOString(), bundleRetainUntil: new Date(Date.now() + 100).toISOString() };
  await fixture.service.markRetained(fixture.input.runId, policy, "real-cross-component-retention");
  await new Promise(resolve => setTimeout(resolve, 150));
  const fence = await fixture.store.acquireRunTerminalFence(fixture.input.runId, "aggregate-owner", Date.now());
  await fixture.service.disposeUnderTerminalFence(fixture.input.runId, fence, { now: Date.now(), workspaceRetainUntil: policy.workspaceRetainUntil, bundleRetainUntil: policy.bundleRetainUntil });
  assert.equal(await readFile(materialized.footerExtensionPath, "utf8") !== "", true, "Git disposal must not remove AIDEV-228 footer state");
  assert.equal(await readFile(path.join(materialized.homeDir, "../pi-agent/settings.json"), "utf8") !== "", true);
  const teardown = await runner.teardownRunAgentDirectory(fixture.input.runId);
  assert.ok(teardown.capturesRemoved >= 0);
  await assert.rejects(() => fixture.service.verify(fixture.input.runId), /removed|terminal|record|workspace/);
  await assert.rejects(() => runner.launch(fixture.input.runId, "implement"), /removed|terminal|fence/);
});
