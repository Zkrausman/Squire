import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, link, lstat, mkdir, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { RunPreparationLease, RunTerminalFence, RuntimeResolution } from "../src/control/domain.js";
import type { RunTeardownRecord } from "../src/sandbox/domain.js";
import type { RunQuiescenceAuthority } from "../src/control/workflow-store.js";
import { PiAgentDirectoryMaterializer as PiAgentDirectoryMaterializerImplementation, type PreparationCaptureBarrier, type PreparationFenceBarrier, type PiAgentDirectoryMaterializerOptions, type RetentionAuthCleanupBarrier, type RetentionPublicationBarrier } from "../src/pi/pi-agent-directory.js";
import { FileLifecycleAuthority } from "./support/file-lifecycle-authority.js";

async function fixture() {
  const root = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), "squire-agent-dir-"));
  const wiki = path.join(root, "resolved-wiki");
  await mkdir(path.join(wiki, "extensions", "llm-wiki"), { recursive: true });
  await writeFile(path.join(wiki, "package.json"), JSON.stringify({ name: "@zosmaai/pi-llm-wiki", version: "0.11.8" }));
  await writeFile(path.join(wiki, "extensions", "llm-wiki", "index.ts"), "export default function wiki() {}\n");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const runtime: RuntimeResolution = {
    schemaVersion: 1,
    runId: "run_materializer01",
    pi: { version: "0.84.4", executable: "/ticket/runtime/pi", installationId: "pi-install-exact" },
    llmWiki: { version: "0.11.8", installationId: "wiki-install-exact", root: wiki },
    modelCapabilities: [{ provider: "openai-codex", model: "gpt-5.6-luna", reasoningCapable: true, piInstallationId: "pi-install-exact", wikiInstallationId: "wiki-install-exact" }],
    resolvedAt: "2026-09-01T12:00:00.000Z",
  };
  return { root, wiki, workspace, runtime };
}

const profile = { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" as const };
const execFile = promisify(execFileCallback);

function lifecycleAuthority(
  quiescent: () => boolean = () => true,
  afterAcquire?: () => void | Promise<void>,
  onTeardownAssertion?: (runId: string) => void | Promise<void>,
): RunQuiescenceAuthority {
  const fences = new Map<string, RunTerminalFence>();
  const teardowns = new Map<string, RunTeardownRecord>();
  const preparationLeases = new Map<string, RunPreparationLease[]>();
  return {
    async assertRunStartAllowed(runId) {
      if (fences.has(runId) || teardowns.has(runId)) throw new Error("run has a permanent terminal fence");
    },
    async beginRunTeardown(runId, owner, reason = "retention", now = Date.now()) {
      const existing = teardowns.get(runId); if (existing) return existing;
      const teardown: RunTeardownRecord = { runId, owner, generation: 1, state: "draining", reason, requestedAt: new Date(now).toISOString() };
      teardowns.set(runId, teardown); return teardown;
    },
    async acquireRunPreparationLease(runId, owner, now = Date.now()) {
      if (fences.has(runId) || teardowns.has(runId)) throw new Error("run has a permanent terminal fence");
      const leases = preparationLeases.get(runId) ?? [];
      const lease: RunPreparationLease = { runId, owner, fencingToken: leases.length + 1, acquiredAt: new Date(now).toISOString(), state: "held" };
      preparationLeases.set(runId, [...leases, lease]);
      return lease;
    },
    async releaseRunPreparationLease(runId, lease) {
      const leases = preparationLeases.get(runId) ?? [];
      preparationLeases.set(runId, leases.filter(candidate => candidate.owner !== lease.owner || candidate.fencingToken !== lease.fencingToken));
    },
    async acquireRunTerminalFence(runId, owner, now = Date.now()) {
      const existing = fences.get(runId);
      if (existing) return existing;
      if ((preparationLeases.get(runId) ?? []).length > 0) throw new Error("preparation lease remains");
      if (!quiescent()) throw new Error("role processes/controllers are not quiescent");
      const fence: RunTerminalFence = { runId, owner, fencingToken: 1, acquiredAt: new Date(now).toISOString(), state: "held" };
      fences.set(runId, fence);
      teardowns.set(runId, { ...(teardowns.get(runId) ?? { runId, owner, generation: 1, reason: "terminal" as const, requestedAt: new Date(now).toISOString() }), state: "fenced" as const, fence });
      await afterAcquire?.();
      return fence;
    },
    async assertRunTeardownQuiescent(runId, fence) {
      const existing = fences.get(runId);
      if (!existing || existing.state !== "held" || fence.state !== "held" || existing.owner !== fence.owner || existing.fencingToken !== fence.fencingToken) throw new Error("terminal fence ownership changed");
      if ((preparationLeases.get(runId) ?? []).length > 0) throw new Error("preparation lease remains");
      if (!quiescent()) throw new Error("role processes/controllers are not quiescent");
      await onTeardownAssertion?.(runId);
    },
    async completeRunTeardown(runId, fence) {
      const existing = fences.get(runId);
      if (!existing || existing.owner !== fence.owner || existing.fencingToken !== fence.fencingToken) throw new Error("terminal fence ownership changed");
      if ((preparationLeases.get(runId) ?? []).length > 0) throw new Error("preparation lease remains");
      teardowns.set(runId, { ...(teardowns.get(runId) ?? { runId, owner: fence.owner, generation: 1, reason: "terminal" as const, requestedAt: fence.acquiredAt }), state: "completed" as const, fence: { ...fence, state: "removed" } });
    },
  };
}

/** Unit tests use a fresh authority unless they explicitly share one. */
type TestMaterializerOptions = Omit<PiAgentDirectoryMaterializerOptions, "runLifecycleAuthority"> & { runLifecycleAuthority?: RunQuiescenceAuthority };
class PiAgentDirectoryMaterializer extends PiAgentDirectoryMaterializerImplementation {
  constructor(options: TestMaterializerOptions = {}) {
    super({ ...options, runLifecycleAuthority: options.runLifecycleAuthority ?? lifecycleAuthority() });
  }
}

test("materializer writes deterministic run-scoped settings, manifest, and trusted footer", async () => {
  const { root, workspace, runtime } = await fixture();
  const materializer = new PiAgentDirectoryMaterializer({ runtimeRoot: path.join(root, "runtime"), workspace });
  const first = await materializer.materialize({ runId: runtime.runId, runtime, wikiProfile: profile, workspace });
  const second = await materializer.materialize({ runId: runtime.runId, runtime, wikiProfile: profile, workspace });
  assert.deepEqual(second, first);
  assert.equal(first.agentDir, path.join(root, "runtime", runtime.runId, "pi-agent"));
  assert.equal(first.homeDir, path.join(root, "runtime", runtime.runId, "home"));
  assert.equal(first.wikiHomeDir, path.join(root, "runtime", runtime.runId, "wiki-home"));
  assert.equal((await stat(path.join(root, "runtime", runtime.runId))).mode & 0o777, 0o700);
  assert.equal((await stat(first.agentDir)).mode & 0o777, 0o700);
  assert.equal((await stat(first.homeDir)).mode & 0o777, 0o700);
  assert.equal((await stat(first.wikiHomeDir)).mode & 0o777, 0o700);
  assert.deepEqual(first.trustedExtensionPaths, [path.join(runtime.llmWiki.root!, "extensions", "llm-wiki", "index.ts"), first.footerExtensionPath]);

  const settings = JSON.parse(await readFile(first.settingsPath, "utf8")) as Record<string, any>;
  assert.deepEqual(settings["packages"], [runtime.llmWiki.root]);
  assert.deepEqual(settings["llm-wiki"].taskModel, { provider: profile.provider, id: profile.model });
  assert.equal(settings["modelThinkingLevels"]["openai-codex/gpt-5.6-luna"], "high");
  assert.equal(settings["defaultThinkingLevel"], "high");
  const manifest = JSON.parse(await readFile(first.manifestPath, "utf8")) as Record<string, any>;
  assert.equal(manifest["runId"], runtime.runId);
  assert.equal(manifest["runtime"]["pi"].installationId, "pi-install-exact");
  assert.equal(manifest["runtime"]["llmWiki"].installationId, "wiki-install-exact");
  assert.equal(manifest["runtime"]["llmWiki"].root, runtime.llmWiki.root);
  assert.deepEqual(manifest["wikiProfile"], profile);
  assert.equal(manifest["isolation"]["home"], "home");
  assert.equal(manifest["isolation"]["wikiHome"], "wiki-home");
  assert.equal(manifest["trustedPackage"]["entrypoint"]["path"], first.trustedExtensionPaths[0]);
  assert.equal(manifest["trustedPackage"]["entrypoint"]["sha256"], first.wikiExtensionDigest);
  assert.equal(manifest["trustedPackage"]["treeSha256"], first.packageDigest);
  const footer = await readFile(first.footerExtensionPath);
  assert.equal(manifest["files"]["footerExtension"].sha256, createHash("sha256").update(footer).digest("hex"));
  assert.equal((await (await import("node:fs/promises")).readdir(workspace)).length, 0);
  // Pi creates these private runtime files on its first real launch. They are
  // permitted only by their fixed names; auth remains the empty unprovisioned
  // store unless an explicit trusted auth input was supplied.
  await writeFile(path.join(first.agentDir, "auth.json"), "{}", { mode: 0o600 });
  await writeFile(path.join(first.agentDir, "models-store.json"), JSON.stringify({ "openai-codex": { refreshedAt: 1 } }), { mode: 0o600 });

  const restarted = new PiAgentDirectoryMaterializer({ runtimeRoot: path.join(root, "runtime"), workspace });
  assert.deepEqual(await restarted.materialize({ runId: runtime.runId, runtime, wikiProfile: profile, workspace }), first);
});

test("retained captures have authenticated bounds and quiescent teardown", async () => {
  const { root, workspace, runtime } = await fixture();
  const runtimeRoot = path.join(root, "runtime");
  let quiescent = false;
  const options = {
    runtimeRoot,
    workspace,
    maxRetainedCapturesPerRun: 2,
    maxRetainedCapturesGlobal: 2,
    runLifecycleAuthority: lifecycleAuthority(() => quiescent),
  };
  const materializer = new PiAgentDirectoryMaterializer(options);
  const request = { runId: runtime.runId, runtime, wikiProfile: profile, workspace };
  try {
    const first = await materializer.materialize(request);
    const retainedRun = path.join(runtimeRoot, ".pi-agent-quarantine-retained", runtime.runId);
    const firstRecords = (await readdir(retainedRun)).filter(name => name.endsWith(".json"));
    assert.equal(firstRecords.length, 1);
    const firstRecord = JSON.parse(await readFile(path.join(retainedRun, firstRecords[0]!), "utf8")) as Record<string, any>;
    assert.equal(firstRecord["kind"], "squire-pi-agent-retained-capture");
    assert.equal(firstRecord["runId"], runtime.runId);
    assert.equal(typeof firstRecord["auth"], "string");
    assert.deepEqual(Object.keys(firstRecord["identity"]).sort(), ["dev", "ino"]);
    assert.match(firstRecord["source"], new RegExp(runtime.runId));

    await rm(first.agentDir, { recursive: true, force: false });
    await materializer.materialize(request);
    assert.equal((await readdir(retainedRun)).filter(name => name.endsWith(".json")).length, 2);

    await rm(first.agentDir, { recursive: true, force: false });
    await assert.rejects(materializer.materialize(request), /bound|teardown/iu);
    await assert.rejects(materializer.teardown(runtime.runId), /not quiescent/iu);

    quiescent = true;
    const teardown = await materializer.teardown(runtime.runId);
    assert.ok(teardown.capturesRemoved >= 2);
    assert.equal(teardown.fencesRemoved, 0);
    await assert.rejects(lstat(retainedRun), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(runtimeRoot, runtime.runId)), { code: "ENOENT" });
    assert.equal((await lstat(path.join(runtimeRoot, ".pi-agent-terminal-fences", runtime.runId, "fence.json"))).isFile(), true);

    // A completed teardown is permanent; the durable and filesystem fences
    // reject every later preparation for this run.
    await assert.rejects(materializer.materialize(request), /terminal fence/iu);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("durable teardown fencing excludes an independent materializer", async () => {
  const { root, workspace, runtime } = await fixture();
  const runtimeRoot = path.join(root, "runtime");
  let acquiredResolve!: () => void;
  const acquired = new Promise<void>(resolve => { acquiredResolve = resolve; });
  let releaseAcquire!: () => void;
  const hold = new Promise<void>(resolve => { releaseAcquire = resolve; });
  const authority = lifecycleAuthority(() => true, async () => {
    acquiredResolve();
    await hold;
  });
  const options = { runtimeRoot, workspace, runLifecycleAuthority: authority };
  const first = new PiAgentDirectoryMaterializer(options);
  const second = new PiAgentDirectoryMaterializer(options);
  const request = { runId: runtime.runId, runtime, wikiProfile: profile, workspace };
  try {
    await first.materialize(request);
    const teardown = first.teardown(runtime.runId);
    await acquired;
    await assert.rejects(second.materialize(request), /terminal fence/iu);
    releaseAcquire();
    await teardown;
    await assert.rejects(second.materialize(request), /terminal fence/iu);
  } finally {
    releaseAcquire?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("durable preparation lease closes the final no-fence observation race", async () => {
  const { root, workspace, runtime } = await fixture();
  const runtimeRoot = path.join(root, "runtime");
  let observedResolve!: () => void;
  const observed = new Promise<void>(resolve => { observedResolve = resolve; });
  let releaseResolve!: () => void;
  const release = new Promise<void>(resolve => { releaseResolve = resolve; });
  const preparationFenceBarrier: PreparationFenceBarrier = async event => {
    assert.equal(event.runId, runtime.runId);
    assert.equal(event.operation, "materialize");
    observedResolve();
    await release;
  };
  const authority = lifecycleAuthority();
  const materializer = new PiAgentDirectoryMaterializer({ runtimeRoot, workspace, runLifecycleAuthority: authority, preparationFenceBarrier });
  const contender = new PiAgentDirectoryMaterializer({ runtimeRoot, workspace, runLifecycleAuthority: authority });
  const request = { runId: runtime.runId, runtime, wikiProfile: profile, workspace };
  try {
    const preparation = materializer.materialize(request);
    await observed;
    await assert.rejects(authority.acquireRunTerminalFence(runtime.runId, "teardown-contender"), /preparation lease/iu);
    await assert.rejects(contender.teardown(runtime.runId), /live preparation controller/iu);
    assert.equal((await lstat(path.join(runtimeRoot, runtime.runId))).isDirectory(), true);
    releaseResolve();
    await preparation;
    await materializer.teardown(runtime.runId);
    await assert.rejects(contender.materialize(request), /terminal fence/iu);
  } finally {
    releaseResolve?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a separate controller lease blocks teardown after the final no-fence observation", async () => {
  const { root, workspace, runtime } = await fixture();
  const runtimeRoot = path.join(root, "runtime");
  const authorityRoot = path.join(root, "authority");
  const authority = await FileLifecycleAuthority.open(authorityRoot, runtime.runId);
  const moduleUrl = pathToFileURL(path.resolve("dist/src/pi/pi-agent-directory.js")).href;
  const authorityUrl = pathToFileURL(path.resolve("dist/test/support/file-lifecycle-authority.js")).href;
  const childSource = `
    import { PiAgentDirectoryMaterializer } from ${JSON.stringify(moduleUrl)};
    import { FileLifecycleAuthority } from ${JSON.stringify(authorityUrl)};
    const runtime = ${JSON.stringify(runtime)};
    const workspace = ${JSON.stringify(workspace)};
    const runtimeRoot = ${JSON.stringify(runtimeRoot)};
    const authority = await FileLifecycleAuthority.open(${JSON.stringify(authorityRoot)}, runtime.runId);
    const preparationFenceBarrier = async event => {
      process.stdout.write(JSON.stringify({ kind: "after-no-fence-observation", operation: event.operation }) + "\\n");
      await new Promise(resolve => process.stdin.once("data", resolve));
    };
    const result = await new PiAgentDirectoryMaterializer({ runtimeRoot, workspace, runLifecycleAuthority: authority, preparationFenceBarrier }).materialize({
      runId: runtime.runId,
      runtime,
      wikiProfile: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
      workspace,
    });
    process.stdout.write(JSON.stringify({ kind: "complete", result }) + "\\n");
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childSource], {
    cwd: workspace,
    env: { ...process.env, HOME: path.join(root, "host-home"), WIKI_HOME: path.join(root, "host-wiki-home") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let stderr = "";
  let buffer = "";
  let complete: { kind: string; result?: unknown } | undefined;
  let observedResolve!: () => void;
  let observedReject!: (error: Error) => void;
  const observed = new Promise<void>((resolve, reject) => { observedResolve = resolve; observedReject = reject; });
  child.stdout.on("data", chunk => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      output += line;
      try {
        const event = JSON.parse(line) as { kind: string; result?: unknown };
        if (event.kind === "after-no-fence-observation") observedResolve();
        if (event.kind === "complete") complete = event;
      } catch { /* child diagnostics are reported through stderr */ }
    }
  });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => {
      if (code !== 0 && child.exitCode !== null) observedReject(new Error(`preparation controller exited before its fence barrier: ${code}; stderr=${stderr}`));
      resolve(code);
    });
  });
  try {
    await observed;
    await assert.rejects(authority.acquireRunTerminalFence(runtime.runId, "teardown-contender"), /preparation lease/iu);
    const parentMaterializer = new PiAgentDirectoryMaterializer({ runtimeRoot, workspace, runLifecycleAuthority: authority });
    await assert.rejects(parentMaterializer.teardown(runtime.runId), /preparation lease/iu);
    child.stdin.end("release\n");
    assert.equal(await exited, 0);
    assert.equal(stderr, "");
    assert.equal(complete?.kind, "complete");
    await parentMaterializer.teardown(runtime.runId);
    await assert.rejects(parentMaterializer.materialize({ runId: runtime.runId, runtime, wikiProfile: profile, workspace }), /terminal fence/iu);
    assert.match(output, /after-no-fence-observation/iu);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("materialization and verification release their durable preparation leases", async () => {
  const { root, workspace, runtime } = await fixture();
  const events: string[] = [];
  const authority = lifecycleAuthority();
  const materializer = new PiAgentDirectoryMaterializer({
    runtimeRoot: path.join(root, "runtime"),
    workspace,
    runLifecycleAuthority: authority,
    preparationFenceBarrier: async event => { events.push(event.operation); },
  });
  const request = { runId: runtime.runId, runtime, wikiProfile: profile, workspace };
  try {
    const result = await materializer.materialize(request);
    await materializer.verify(request, result);
    assert.deepEqual(events, ["materialize", "verify"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("teardown gates every destructive boundary against a governed contender", async () => {
  const { root, workspace, runtime } = await fixture();
  const runtimeRoot = path.join(root, "runtime");
  let checks = 0;
  let authority!: RunQuiescenceAuthority;
  authority = lifecycleAuthority(() => true, undefined, async runId => {
    checks += 1;
    await assert.rejects(authority.acquireRunPreparationLease(runId, `governed-contender-${checks}`), /permanent terminal fence/iu);
    await assert.rejects(authority.assertRunStartAllowed(runId), /permanent terminal fence/iu);
  });
  const materializer = new PiAgentDirectoryMaterializer({ runtimeRoot, workspace, runLifecycleAuthority: authority });
  const request = { runId: runtime.runId, runtime, wikiProfile: profile, workspace };
  try {
    const first = await materializer.materialize(request);
    await rm(first.agentDir, { recursive: true, force: false });
    await materializer.materialize(request);
    await materializer.teardown(runtime.runId);
    assert.ok(checks >= 10, `expected every disposal boundary to be governed, observed ${checks}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("global retained-capture bound stays closed under concurrent run allocations", async () => {
  const { root, workspace, runtime } = await fixture();
  const runtimeRoot = path.join(root, "runtime");
  const secondRunId = "run_example02";
  const secondRuntime = { ...runtime };
  const materializer = new PiAgentDirectoryMaterializer({
    runtimeRoot,
    workspace,
    maxRetainedCapturesPerRun: 32,
    maxRetainedCapturesGlobal: 1,
    runLifecycleAuthority: lifecycleAuthority(),
  });
  const request = { runId: runtime.runId, runtime, wikiProfile: profile, workspace };
  const secondRequest = { runId: secondRunId, runtime: secondRuntime, wikiProfile: profile, workspace };
  try {
    const results = await Promise.allSettled([materializer.materialize(request), materializer.materialize(secondRequest)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const retainedRoot = path.join(runtimeRoot, ".pi-agent-quarantine-retained");
    let records = 0;
    for (const runId of [runtime.runId, secondRunId]) {
      const retainedRun = path.join(retainedRoot, runId);
      try { records += (await readdir(retainedRun)).filter(name => name.endsWith(".json") && name.startsWith("capture-")).length; }
      catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ENOENT"); }
    }
    assert.equal(records, 1);
    await materializer.teardown(runtime.runId);
    await materializer.teardown(secondRunId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("metadata-bearing quarantine fences reconcile through trusted teardown", async () => {
  const { root, workspace, runtime } = await fixture();
  const runtimeRoot = path.join(root, "runtime");
  const runRoot = path.join(runtimeRoot, runtime.runId);
  let moved: string | undefined;
  const barrier: PreparationCaptureBarrier = async event => {
    if (event.name !== "Pi agent-directory preparation lock") return;
    moved = path.join(root, "moved-capture");
    await rename(event.quarantine, moved);
  };
  const materializer = new PiAgentDirectoryMaterializer({
    runtimeRoot,
    workspace,
    preparationCaptureBarrier: barrier,
    runLifecycleAuthority: lifecycleAuthority(),
  });
  const request = { runId: runtime.runId, runtime, wikiProfile: profile, workspace };
  try {
    await assert.rejects(materializer.materialize(request), /quarantine|replacement|missing|disappeared/iu);
    const fences = (await readdir(runRoot)).filter(name => name.startsWith(".pi-agent-quarantine-"));
    assert.equal(fences.length, 1);
    const fence = path.join(runRoot, fences[0]!);
    const metadata = JSON.parse(await readFile(path.join(fence, "capture.json"), "utf8")) as Record<string, any>;
    assert.equal(metadata["kind"], "squire-pi-agent-retained-capture");
    assert.equal(metadata["state"], "fence");
    assert.equal(metadata["runId"], runtime.runId);
    assert.equal(metadata["type"], "quarantine-fence");
    const teardown = await materializer.teardown(runtime.runId);
    assert.equal(teardown.fencesRemoved, 1);
    await assert.rejects(lstat(runRoot), { code: "ENOENT" });
    assert.equal((await lstat(path.join(runtimeRoot, ".pi-agent-terminal-fences", runtime.runId, "fence.json"))).isFile(), true);
    assert.ok(moved);
    assert.equal((await lstat(moved!)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted teardown discards an interrupted empty quarantine fence", async () => {
  const { root, workspace, runtime } = await fixture();
  const runtimeRoot = path.join(root, "runtime");
  const runRoot = path.join(runtimeRoot, runtime.runId);
  let moved: string | undefined;
  const barrier: PreparationCaptureBarrier = async event => {
    if (event.name !== "Pi agent-directory preparation lock") return;
    moved = path.join(root, "interrupted-fence-capture");
    await rename(event.quarantine, moved);
  };
  const materializer = new PiAgentDirectoryMaterializer({ runtimeRoot, workspace, preparationCaptureBarrier: barrier, runLifecycleAuthority: lifecycleAuthority() });
  const request = { runId: runtime.runId, runtime, wikiProfile: profile, workspace };
  try {
    await assert.rejects(materializer.materialize(request), /quarantine|replacement|missing|disappeared/iu);
    const fenceName = (await readdir(runRoot)).find(name => name.startsWith(".pi-agent-quarantine-"));
    assert.ok(fenceName);
    await rm(path.join(runRoot, fenceName!, "capture.json"), { force: false });
    const teardown = await materializer.teardown(runtime.runId);
    assert.equal(teardown.fencesRemoved, 1);
    assert.ok(moved);
    assert.equal((await lstat(moved!)).isDirectory(), true);
    await assert.rejects(lstat(runRoot), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupted authenticated record publication is resumable by trusted teardown", async () => {
  const { root, workspace, runtime } = await fixture();
  const runtimeRoot = path.join(root, "runtime");
  let interrupt = true;
  const publicationBarrier: RetentionPublicationBarrier = async event => {
    if (interrupt && event.kind === "capture-record" && event.stage === "temporary-written") {
      interrupt = false;
      throw new Error("simulated record publication interruption");
    }
  };
  const materializer = new PiAgentDirectoryMaterializer({ runtimeRoot, workspace, retentionPublicationBarrier: publicationBarrier, runLifecycleAuthority: lifecycleAuthority() });
  const request = { runId: runtime.runId, runtime, wikiProfile: profile, workspace };
  try {
    await assert.rejects(materializer.materialize(request), /simulated record publication interruption/iu);
    const teardown = await materializer.teardown(runtime.runId);
    assert.ok(teardown.capturesRemoved >= 1);
    await assert.rejects(lstat(path.join(runtimeRoot, runtime.runId)), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted teardown discards a partial authentication-key publication", async () => {
  const { root, workspace, runtime } = await fixture();
  const runtimeRoot = path.join(root, "runtime");
  let interrupt = true;
  const publicationBarrier: RetentionPublicationBarrier = async event => {
    if (interrupt && event.kind === "auth-key" && event.stage === "temporary-written") {
      interrupt = false;
      await writeFile(event.temporaryPath, "partial-auth-key", { mode: 0o600 });
      throw new Error("simulated auth-key publication interruption");
    }
  };
  const materializer = new PiAgentDirectoryMaterializer({ runtimeRoot, workspace, retentionPublicationBarrier: publicationBarrier, runLifecycleAuthority: lifecycleAuthority() });
  const request = { runId: runtime.runId, runtime, wikiProfile: profile, workspace };
  try {
    await assert.rejects(materializer.materialize(request), /simulated auth-key publication interruption/iu);
    const teardown = await materializer.teardown(runtime.runId);
    assert.equal(teardown.capturesRemoved, 0);
    await assert.rejects(lstat(path.join(runtimeRoot, runtime.runId)), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retained-record publication converges when an authenticated final handoff wins", async () => {
  for (const removeTemporary of [false, true]) {
    const { root, workspace, runtime } = await fixture();
    const runtimeRoot = path.join(root, "runtime");
    let observed = 0;
    const handoff: RetentionPublicationBarrier = async event => {
      if (event.kind !== "capture-record" || event.stage !== "before-temporary-read") return;
      observed += 1;
      await link(event.temporaryPath, event.finalPath);
      if (removeTemporary) await rm(event.temporaryPath, { recursive: false, force: false });
    };
    const materializer = new PiAgentDirectoryMaterializer({ runtimeRoot, workspace, retentionPublicationBarrier: handoff, runLifecycleAuthority: lifecycleAuthority() });
    const request = { runId: runtime.runId, runtime, wikiProfile: profile, workspace };
    try {
      const result = await materializer.materialize(request);
      assert.equal(observed, 1);
      assert.equal(result.agentDir, path.join(runtimeRoot, runtime.runId, "pi-agent"));
      const retainedRun = path.join(runtimeRoot, ".pi-agent-quarantine-retained", runtime.runId);
      assert.deepEqual((await readdir(retainedRun)).filter(name => name.startsWith(".capture-")), []);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("retained-record publication rejects a replaced temporary despite matching final bytes", async () => {
  const { root, workspace, runtime } = await fixture();
  const runtimeRoot = path.join(root, "runtime");
  let observed = false;
  const publicationBarrier: RetentionPublicationBarrier = async event => {
    if (observed || event.kind !== "capture-record" || event.stage !== "before-temporary-read") return;
    observed = true;
    const bytes = await readFile(event.temporaryPath);
    await link(event.temporaryPath, event.finalPath);
    await rm(event.temporaryPath, { recursive: false, force: false });
    await writeFile(event.temporaryPath, bytes, { flag: "wx", mode: 0o600 });
  };
  const materializer = new PiAgentDirectoryMaterializer({ runtimeRoot, workspace, retentionPublicationBarrier: publicationBarrier, runLifecycleAuthority: lifecycleAuthority() });
  const request = { runId: runtime.runId, runtime, wikiProfile: profile, workspace };
  try {
    await assert.rejects(materializer.materialize(request), /temporary file identity changed during handoff/iu);
    assert.equal(observed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("auth-key temporary disappearance after observer scan is a verified handoff", async () => {
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const { root, workspace, runtime } = await fixture();
    const runtimeRoot = path.join(root, "runtime");
    const retainedRoot = path.join(runtimeRoot, ".pi-agent-quarantine-retained");
    const firstTemporary = path.join(retainedRoot, `.capture-auth-key.tmp-${randomUUID()}`);
    const secondTemporary = path.join(retainedRoot, `.capture-auth-key.tmp-${randomUUID()}`);
    await mkdir(retainedRoot, { recursive: true, mode: 0o700 });
    await chmod(retainedRoot, 0o700);
    const key = Buffer.alloc(32, iteration + 1);
    await writeFile(firstTemporary, key, { flag: "wx", mode: 0o600 });
    let barrierCalls = 0;
    const authCleanupBarrier: RetentionAuthCleanupBarrier = async event => {
      barrierCalls += 1;
      assert.equal(event.finalPath, path.join(retainedRoot, ".capture-auth-key"));
      await rm(event.temporaryPath, { recursive: false, force: false });
      if (barrierCalls === 1) await writeFile(secondTemporary, key, { flag: "wx", mode: 0o600 });
    };
    const materializer = new PiAgentDirectoryMaterializer({ runtimeRoot, workspace, retentionAuthCleanupBarrier: authCleanupBarrier });
    const request = { runId: runtime.runId, runtime, wikiProfile: profile, workspace };
    try {
      const result = await materializer.materialize(request);
      assert.equal(barrierCalls, 2);
      assert.deepEqual((await readdir(retainedRoot)).filter(name => name.startsWith(".capture-auth-key.tmp-")), []);
      assert.equal((await readFile(path.join(retainedRoot, ".capture-auth-key"))).equals(key), true);
      assert.equal(result.agentDir, path.join(runtimeRoot, runtime.runId, "pi-agent"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("trusted teardown resumes an interrupted terminal-fence publication", async () => {
  const { root, workspace, runtime } = await fixture();
  const runtimeRoot = path.join(root, "runtime");
  let interrupt = true;
  const publicationBarrier: RetentionPublicationBarrier = async event => {
    if (interrupt && event.kind === "terminal-fence" && event.stage === "temporary-written") {
      interrupt = false;
      throw new Error("simulated terminal-fence publication interruption");
    }
  };
  const materializer = new PiAgentDirectoryMaterializer({ runtimeRoot, workspace, retentionPublicationBarrier: publicationBarrier, runLifecycleAuthority: lifecycleAuthority() });
  const request = { runId: runtime.runId, runtime, wikiProfile: profile, workspace };
  try {
    await materializer.materialize(request);
    await assert.rejects(materializer.teardown(runtime.runId), /simulated terminal-fence publication interruption/iu);
    const terminalRoot = path.join(runtimeRoot, ".pi-agent-terminal-fences");
    assert.ok((await readdir(terminalRoot)).some(name => name.startsWith(".terminal-fence-run_materializer01-")));
    await materializer.teardown(runtime.runId);
    await assert.rejects(lstat(path.join(runtimeRoot, runtime.runId)), { code: "ENOENT" });
    assert.equal((await lstat(path.join(terminalRoot, runtime.runId, "fence.json"))).isFile(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal teardown preserves a replaced run sandbox", async () => {
  const { root, workspace, runtime } = await fixture();
  const runtimeRoot = path.join(root, "runtime");
  let interrupt = true;
  const publicationBarrier: RetentionPublicationBarrier = async event => {
    if (interrupt && event.kind === "terminal-fence" && event.stage === "final-published") {
      interrupt = false;
      throw new Error("simulated post-publication interruption");
    }
  };
  const materializer = new PiAgentDirectoryMaterializer({ runtimeRoot, workspace, retentionPublicationBarrier: publicationBarrier, runLifecycleAuthority: lifecycleAuthority() });
  const request = { runId: runtime.runId, runtime, wikiProfile: profile, workspace };
  const runRoot = path.join(runtimeRoot, runtime.runId);
  const original = path.join(root, "original-run-sandbox");
  try {
    await materializer.materialize(request);
    await assert.rejects(materializer.teardown(runtime.runId), /post-publication interruption/iu);
    await rename(runRoot, original);
    await mkdir(runRoot, { recursive: false, mode: 0o700 });
    await chmod(runRoot, 0o700);
    await assert.rejects(materializer.teardown(runtime.runId), /sandbox identity changed/iu);
    assert.equal((await lstat(runRoot)).isDirectory(), true);
    assert.equal((await lstat(original)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("materializer rejects tampering, partial state, conflicting project settings, and non-reasoning models", async () => {
  const { root, workspace, runtime } = await fixture();
  const options = { runtimeRoot: path.join(root, "runtime"), workspace };
  const materializer = new PiAgentDirectoryMaterializer(options);
  const created = await materializer.materialize({ runId: runtime.runId, runtime, wikiProfile: profile, workspace });
  await writeFile(created.footerExtensionPath, "tampered");
  await assert.rejects(new PiAgentDirectoryMaterializer(options).materialize({ runId: runtime.runId, runtime, wikiProfile: profile, workspace }), /digest|manifest|conflict/);

  const partialRuntime = { ...runtime, runId: "run_partial01" };
  const partialDir = path.join(root, "runtime", partialRuntime.runId, "pi-agent");
  await mkdir(path.dirname(partialDir), { recursive: true, mode: 0o700 });
  await chmod(path.dirname(partialDir), 0o700);
  await mkdir(partialDir, { recursive: true, mode: 0o700 });
  await chmod(partialDir, 0o700);
  await writeFile(path.join(partialDir, "settings.json"), "{}");
  await assert.rejects(new PiAgentDirectoryMaterializer(options).materialize({ runId: partialRuntime.runId, runtime: partialRuntime, wikiProfile: profile, workspace }), /manifest|partial|conflict/);

  const conflictWorkspace = path.join(root, "conflict-workspace");
  await mkdir(path.join(conflictWorkspace, ".pi"), { recursive: true });
  await writeFile(path.join(conflictWorkspace, ".pi", "settings.json"), JSON.stringify({ "llm-wiki": { taskModel: { provider: "other", id: "other" } } }));
  await assert.rejects(new PiAgentDirectoryMaterializer({ ...options, workspace: conflictWorkspace }).materialize({ runId: "run_conflict01", runtime: { ...runtime, runId: "run_conflict01" }, wikiProfile: profile, workspace: conflictWorkspace }), /conflict/);

  await assert.rejects(new PiAgentDirectoryMaterializer({ ...options, resolveModelCapability: () => ({ provider: profile.provider, model: profile.model, reasoningCapable: false, piInstallationId: runtime.pi.installationId, wikiInstallationId: runtime.llmWiki.installationId }) }).materialize({ runId: "run_capability01", runtime: { ...runtime, runId: "run_capability01" }, wikiProfile: profile, workspace }), /reasoning-capable/);
});

test("materializer binds package bytes, secure modes, and exact runtime capabilities", async () => {
  const firstFixture = await fixture();
  const options = { runtimeRoot: path.join(firstFixture.root, "runtime"), workspace: firstFixture.workspace };
  const created = await new PiAgentDirectoryMaterializer(options).materialize({ runId: firstFixture.runtime.runId, runtime: firstFixture.runtime, wikiProfile: profile, workspace: firstFixture.workspace });
  await writeFile(path.join(firstFixture.wiki, "extensions", "llm-wiki", "index.ts"), "export default function spoofed() {}\n");
  await assert.rejects(new PiAgentDirectoryMaterializer(options).materialize({ runId: firstFixture.runtime.runId, runtime: firstFixture.runtime, wikiProfile: profile, workspace: firstFixture.workspace }), /package|entrypoint|manifest|digest/);

  const modeFixture = await fixture();
  const modeOptions = { runtimeRoot: path.join(modeFixture.root, "runtime"), workspace: modeFixture.workspace };
  const modeCreated = await new PiAgentDirectoryMaterializer(modeOptions).materialize({ runId: modeFixture.runtime.runId, runtime: modeFixture.runtime, wikiProfile: profile, workspace: modeFixture.workspace });
  await chmod(modeCreated.agentDir, 0o777);
  await assert.rejects(new PiAgentDirectoryMaterializer(modeOptions).materialize({ runId: modeFixture.runtime.runId, runtime: modeFixture.runtime, wikiProfile: profile, workspace: modeFixture.workspace }), /permissions|0700/);
  await chmod(modeCreated.agentDir, 0o700);
  await chmod(path.join(modeFixture.root, "runtime", modeFixture.runtime.runId), 0o777);
  await assert.rejects(new PiAgentDirectoryMaterializer(modeOptions).materialize({ runId: modeFixture.runtime.runId, runtime: modeFixture.runtime, wikiProfile: profile, workspace: modeFixture.workspace }), /permissions|0700/);
  await chmod(path.join(modeFixture.root, "runtime", modeFixture.runtime.runId), 0o700);
  await chmod(path.join(modeCreated.agentDir, "extensions"), 0o777);
  await assert.rejects(new PiAgentDirectoryMaterializer(modeOptions).materialize({ runId: modeFixture.runtime.runId, runtime: modeFixture.runtime, wikiProfile: profile, workspace: modeFixture.workspace }), /permissions|0700/);

  const authFixture = await fixture();
  const authSource = path.join(authFixture.root, "ticket-auth.json");
  await writeFile(authSource, JSON.stringify({ "openai-codex": { access: "ticket-only" } }), { mode: 0o600 });
  const authOptions = { runtimeRoot: path.join(authFixture.root, "runtime"), workspace: authFixture.workspace, trustedAuth: { sourcePath: authSource } };
  const authCreated = await new PiAgentDirectoryMaterializer(authOptions).materialize({ runId: authFixture.runtime.runId, runtime: authFixture.runtime, wikiProfile: profile, workspace: authFixture.workspace });
  await writeFile(authCreated.agentDir + "/auth.json", "{}");
  await assert.rejects(new PiAgentDirectoryMaterializer(authOptions).materialize({ runId: authFixture.runtime.runId, runtime: authFixture.runtime, wikiProfile: profile, workspace: authFixture.workspace }), /auth digest/);

  const capabilityFixture = await fixture();
  const unknownRuntime = { ...capabilityFixture.runtime, modelCapabilities: [{ ...capabilityFixture.runtime.modelCapabilities![0]!, model: "gpt-5.6-luna-spoof" }] };
  await assert.rejects(new PiAgentDirectoryMaterializer({ runtimeRoot: path.join(capabilityFixture.root, "runtime"), workspace: capabilityFixture.workspace }).materialize({ runId: unknownRuntime.runId, runtime: unknownRuntime, wikiProfile: profile, workspace: capabilityFixture.workspace }), /capability|proven/);
  const spoofRuntime = { ...capabilityFixture.runtime, runId: "run_capability_spoof" };
  await assert.rejects(new PiAgentDirectoryMaterializer({ runtimeRoot: path.join(capabilityFixture.root, "runtime-2"), workspace: capabilityFixture.workspace, resolveModelCapability: () => ({ provider: profile.provider, model: "gpt-5.6-luna-spoof", reasoningCapable: true, piInstallationId: capabilityFixture.runtime.pi.installationId, wikiInstallationId: capabilityFixture.runtime.llmWiki.installationId }) }).materialize({ runId: spoofRuntime.runId, runtime: spoofRuntime, wikiProfile: profile, workspace: capabilityFixture.workspace }), /capability|proven/);
});

test("independent materializers converge through a private lock and recover stale preparation", async () => {
  for (let iteration = 0; iteration < 25; iteration += 1) {
    const { root, workspace, runtime } = await fixture();
    const options = { runtimeRoot: path.join(root, "runtime"), workspace };
    const request = { runId: runtime.runId, runtime, wikiProfile: profile, workspace };
    const results = await Promise.all(Array.from({ length: 12 }, () => new PiAgentDirectoryMaterializer(options).materialize(request)));
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.deepEqual((await (await import("node:fs/promises")).readdir(path.join(options.runtimeRoot, runtime.runId))).sort(), ["home", "pi-agent", "wiki-home"]);
  }

  const conflicting = await fixture();
  const alternateProfile = { provider: "openai-codex", model: "gpt-5.6-luna-alt", thinking: "high" as const };
  const conflictingRuntime = {
    ...conflicting.runtime,
    modelCapabilities: [...conflicting.runtime.modelCapabilities!, {
      provider: alternateProfile.provider,
      model: alternateProfile.model,
      reasoningCapable: true,
      piInstallationId: conflicting.runtime.pi.installationId,
      wikiInstallationId: conflicting.runtime.llmWiki.installationId,
    }],
  };
  const conflictingOptions = { runtimeRoot: path.join(conflicting.root, "runtime"), workspace: conflicting.workspace };
  const conflictingRequests = await Promise.allSettled([
    new PiAgentDirectoryMaterializer(conflictingOptions).materialize({ runId: conflicting.runtime.runId, runtime: conflictingRuntime, wikiProfile: profile, workspace: conflicting.workspace }),
    new PiAgentDirectoryMaterializer(conflictingOptions).materialize({ runId: conflicting.runtime.runId, runtime: conflictingRuntime, wikiProfile: alternateProfile, workspace: conflicting.workspace }),
  ]);
  assert.equal(conflictingRequests.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(conflictingRequests.filter(result => result.status === "rejected").length, 1);
  const conflictReason = conflictingRequests.find(result => result.status === "rejected") as PromiseRejectedResult;
  assert.match(String(conflictReason.reason), /conflicting|manifest/iu);

  const stale = await fixture();
  const runtimeRoot = path.join(stale.root, "runtime");
  const runRoot = path.join(runtimeRoot, stale.runtime.runId);
  const initial = await new PiAgentDirectoryMaterializer({ runtimeRoot, workspace: stale.workspace }).materialize({ runId: stale.runtime.runId, runtime: stale.runtime, wikiProfile: profile, workspace: stale.workspace });
  const manifestFingerprint = createHash("sha256").update(await readFile(initial.manifestPath)).digest("hex");
  const fingerprint = createHash("sha256").update(`${manifestFingerprint}\\0${path.resolve(stale.workspace)}`).digest("hex");
  await rm(initial.agentDir, { recursive: true, force: false });
  const lockDirectory = path.join(runRoot, ".pi-agent-lock");
  await mkdir(lockDirectory, { recursive: false, mode: 0o700 });
  await chmod(lockDirectory, 0o700);
  const old = new Date(Date.now() - 10_000);
  await writeFile(path.join(lockDirectory, "owner.json"), JSON.stringify({ schemaVersion: 1, kind: "squire-pi-agent-preparation-lock", runId: stale.runtime.runId, token: "00000000-0000-4000-8000-000000000001", pid: 99999999, createdAt: old.getTime(), requestFingerprint: fingerprint }) + "\n", { mode: 0o600 });
  await writeFile(path.join(lockDirectory, "heartbeat"), "heartbeat\n", { mode: 0o600 });
  await utimes(lockDirectory, old, old);
  await utimes(path.join(lockDirectory, "owner.json"), old, old);
  await utimes(path.join(lockDirectory, "heartbeat"), old, old);
  const staleOptions = { runtimeRoot, workspace: stale.workspace, preparationLockStaleMs: 50, preparationLockTimeoutMs: 5_000 };
  const recovered = await Promise.all(Array.from({ length: 12 }, () => new PiAgentDirectoryMaterializer(staleOptions).materialize({ runId: stale.runtime.runId, runtime: stale.runtime, wikiProfile: profile, workspace: stale.workspace })));
  for (const result of recovered) assert.deepEqual(result, recovered[0]);
  assert.equal(recovered[0]!.agentDir, path.join(runRoot, "pi-agent"));
  assert.equal((await (await import("node:fs/promises")).readdir(runRoot)).includes(".pi-agent-lock"), false);
});

function replacementLockBarrier(expectedSource: string, runId: string, sentinelPath: string): { barrier: PreparationCaptureBarrier; calls: () => number } {
  let calls = 0;
  const barrier: PreparationCaptureBarrier = async event => {
    if (event.name !== "Pi agent-directory preparation lock") return;
    calls += 1;
    assert.equal(event.source, expectedSource);
    await assert.rejects(lstat(event.source), { code: "ENOENT" });
    assert.match(path.basename(event.quarantine), /^\.pi-agent-quarantine-[0-9a-f-]{36}$/iu);
    const capturedOwner = JSON.parse(await readFile(path.join(event.quarantine, "owner.json"), "utf8")) as { runId: string; requestFingerprint: string };
    const childSource = `
      import { chmod, mkdir, writeFile } from "node:fs/promises";
      import path from "node:path";
      const source = ${JSON.stringify(event.source)};
      const sentinel = ${JSON.stringify(sentinelPath)};
      await mkdir(source, { recursive: false, mode: 0o700 });
      await chmod(source, 0o700);
      const owner = {
        schemaVersion: 1,
        kind: "squire-pi-agent-preparation-lock",
        runId: ${JSON.stringify(runId)},
        token: "00000000-0000-4000-8000-000000000002",
        pid: process.pid,
        createdAt: Date.now(),
        requestFingerprint: ${JSON.stringify(capturedOwner.requestFingerprint)},
      };
      await writeFile(path.join(source, "owner.json"), JSON.stringify(owner) + "\\n", { flag: "wx", mode: 0o600 });
      await chmod(path.join(source, "owner.json"), 0o600);
      await writeFile(path.join(source, "heartbeat"), "heartbeat\\n", { flag: "wx", mode: 0o600 });
      await chmod(path.join(source, "heartbeat"), 0o600);
      await writeFile(sentinel, "replacement-sentinel\\n", { flag: "wx", mode: 0o600 });
      await chmod(sentinel, 0o600);
    `;
    const result = await execFile(process.execPath, ["--input-type=module", "-e", childSource], { cwd: path.dirname(expectedSource) });
    assert.equal(result.stderr, "");
  };
  return { barrier, calls: () => calls };
}

function quarantineReplacementBarrier(expectedSource: string, capturedPath: string): { barrier: PreparationCaptureBarrier; calls: () => number; replacementPath: () => string | undefined } {
  let calls = 0;
  let replacementPath: string | undefined;
  const barrier: PreparationCaptureBarrier = async event => {
    if (event.name !== "Pi agent-directory preparation lock") return;
    calls += 1;
    assert.equal(event.source, expectedSource);
    await assert.rejects(lstat(event.source), { code: "ENOENT" });
    replacementPath = event.quarantine;
    await rename(event.quarantine, capturedPath);
    await mkdir(event.quarantine, { recursive: false, mode: 0o700 });
    await chmod(event.quarantine, 0o700);
    await writeFile(path.join(event.quarantine, "replacement-sentinel"), "replacement-sentinel\n", { flag: "wx", mode: 0o600 });
    await chmod(path.join(event.quarantine, "replacement-sentinel"), 0o600);
  };
  return { barrier, calls: () => calls, replacementPath: () => replacementPath };
}

test("atomic release capture preserves a synchronized replacement lock and sentinel", async () => {
  const { root, workspace, runtime } = await fixture();
  const runtimeRoot = path.join(root, "runtime");
  const runRoot = path.join(runtimeRoot, runtime.runId);
  const lockDirectory = path.join(runRoot, ".pi-agent-lock");
  const sentinelPath = path.join(lockDirectory, "replacement-sentinel");
  const replacement = replacementLockBarrier(lockDirectory, runtime.runId, sentinelPath);
  try {
    const request = { runId: runtime.runId, runtime, wikiProfile: profile, workspace };
    await new PiAgentDirectoryMaterializer({ runtimeRoot, workspace, preparationCaptureBarrier: replacement.barrier }).materialize(request);
    assert.equal(replacement.calls(), 1);
    const retained = await readdir(path.join(runtimeRoot, ".pi-agent-quarantine-retained", runtime.runId));
    assert.ok(retained.some(name => name.startsWith("capture-")));
    assert.equal(await readFile(sentinelPath, "utf8"), "replacement-sentinel\n");
    assert.equal(await readFile(path.join(lockDirectory, "heartbeat"), "utf8"), "heartbeat\n");
    assert.deepEqual((await readdir(runRoot)).filter(name => name.startsWith(".pi-agent-quarantine-")), []);
    await assert.rejects(
      new PiAgentDirectoryMaterializer({ runtimeRoot, workspace, preparationLockTimeoutMs: 250, preparationLockStaleMs: 5_000 }).materialize(request),
      /unexpected|partial|timed out|conflicting/iu,
    );
    assert.equal(await readFile(sentinelPath, "utf8"), "replacement-sentinel\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quarantine replacement survives when the captured directory is moved aside", async () => {
  const { root, workspace, runtime } = await fixture();
  const runtimeRoot = path.join(root, "runtime");
  const runRoot = path.join(runtimeRoot, runtime.runId);
  const lockDirectory = path.join(runRoot, ".pi-agent-lock");
  const capturedPath = path.join(root, "captured-lock-directory");
  const replacement = quarantineReplacementBarrier(lockDirectory, capturedPath);
  try {
    const request = { runId: runtime.runId, runtime, wikiProfile: profile, workspace };
    await assert.rejects(
      new PiAgentDirectoryMaterializer({ runtimeRoot, workspace, preparationCaptureBarrier: replacement.barrier }).materialize(request),
      /quarantine was replaced|replacement/iu,
    );
    assert.equal(replacement.calls(), 1);
    const exactReplacementPath = replacement.replacementPath();
    assert.ok(exactReplacementPath);
    assert.equal(await readFile(path.join(exactReplacementPath, "replacement-sentinel"), "utf8"), "replacement-sentinel\n");
    assert.equal((await lstat(capturedPath)).isDirectory(), true);
    assert.equal((await readdir(capturedPath)).includes("owner.json"), true);
    assert.equal((await readdir(runRoot)).includes(".pi-agent-lock"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic stale reclaim capture preserves a synchronized replacement lock and blocks preparation", async () => {
  const { root, workspace, runtime } = await fixture();
  const runtimeRoot = path.join(root, "runtime");
  const runRoot = path.join(runtimeRoot, runtime.runId);
  const initial = await new PiAgentDirectoryMaterializer({ runtimeRoot, workspace }).materialize({ runId: runtime.runId, runtime, wikiProfile: profile, workspace });
  const sentinelPath = path.join(runRoot, ".pi-agent-lock", "replacement-sentinel");
  const replacement = replacementLockBarrier(path.join(runRoot, ".pi-agent-lock"), runtime.runId, sentinelPath);
  try {
    const manifestFingerprint = createHash("sha256").update(await readFile(initial.manifestPath)).digest("hex");
    const fingerprint = createHash("sha256").update(`${manifestFingerprint}\\0${path.resolve(workspace)}`).digest("hex");
    await rm(initial.agentDir, { recursive: true, force: false });
    const lockDirectory = path.join(runRoot, ".pi-agent-lock");
    await mkdir(lockDirectory, { recursive: false, mode: 0o700 });
    await chmod(lockDirectory, 0o700);
    const old = new Date(Date.now() - 10_000);
    await writeFile(path.join(lockDirectory, "owner.json"), JSON.stringify({ schemaVersion: 1, kind: "squire-pi-agent-preparation-lock", runId: runtime.runId, token: "00000000-0000-4000-8000-000000000001", pid: 99999999, createdAt: old.getTime(), requestFingerprint: fingerprint }) + "\n", { mode: 0o600 });
    await writeFile(path.join(lockDirectory, "heartbeat"), "heartbeat\n", { mode: 0o600 });
    await utimes(lockDirectory, old, old);
    await utimes(path.join(lockDirectory, "owner.json"), old, old);
    await utimes(path.join(lockDirectory, "heartbeat"), old, old);

    const request = { runId: runtime.runId, runtime, wikiProfile: profile, workspace };
    await assert.rejects(
      new PiAgentDirectoryMaterializer({ runtimeRoot, workspace, preparationLockStaleMs: 50, preparationLockTimeoutMs: 500, preparationCaptureBarrier: replacement.barrier }).materialize(request),
      /unexpected|partial|timed out|conflicting/iu,
    );
    assert.equal(replacement.calls(), 1);
    assert.equal(await readFile(sentinelPath, "utf8"), "replacement-sentinel\n");
    await assert.rejects(lstat(initial.agentDir), { code: "ENOENT" });
    assert.equal(await readFile(path.join(lockDirectory, "heartbeat"), "utf8"), "heartbeat\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("separate controller processes converge on the same verified materialization", async () => {
  for (let iteration = 0; iteration < 10; iteration += 1) {
    const { root, workspace, runtime } = await fixture();
    const runtimeRoot = path.join(root, "runtime");
    const moduleUrl = pathToFileURL(path.resolve("dist/src/pi/pi-agent-directory.js")).href;
    const childSource = `
      import { PiAgentDirectoryMaterializer } from ${JSON.stringify(moduleUrl)};
      const runtime = ${JSON.stringify(runtime)};
      const workspace = ${JSON.stringify(workspace)};
      const runtimeRoot = ${JSON.stringify(runtimeRoot)};
      const preparationLeases = new Set();
      const authority = {
        async assertRunStartAllowed() {},
        async acquireRunPreparationLease(runId, owner, now = Date.now()) {
          if (preparationLeases.has(owner)) throw new Error("duplicate preparation lease");
          const lease = { runId, owner, fencingToken: preparationLeases.size + 1, acquiredAt: new Date(now).toISOString(), state: "held" };
          preparationLeases.add(owner);
          return lease;
        },
        async releaseRunPreparationLease(_runId, lease) { preparationLeases.delete(lease.owner); },
        async acquireRunTerminalFence() { throw new Error("test child does not tear down"); },
        async assertRunTeardownQuiescent() {},
        async completeRunTeardown() {},
      };
      const result = await new PiAgentDirectoryMaterializer({ runtimeRoot, workspace, runLifecycleAuthority: authority }).materialize({
        runId: runtime.runId,
        runtime,
        wikiProfile: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
        workspace,
      });
      process.stdout.write(JSON.stringify(result));
    `;
    const launch = (): Promise<{ stdout: string; stderr: string }> => execFile(
      process.execPath,
      ["--input-type=module", "-e", childSource],
      { cwd: workspace, env: { ...process.env, HOME: path.join(root, "host-home"), WIKI_HOME: path.join(root, "unused-host-wiki-home") } },
    );
    const results = await Promise.all(Array.from({ length: 12 }, launch));
    const parsed = results.map(result => JSON.parse(result.stdout));
    for (const result of parsed) assert.deepEqual(result, parsed[0]);
    for (const result of results) assert.equal(result.stderr, "");
    assert.equal((await (await import("node:fs/promises")).readdir(path.join(runtimeRoot, runtime.runId))).includes(".pi-agent-lock"), false);
  }
});

test("legacy v1 runtime observations remain readable but require exact capability evidence to materialize", async () => {
  const { root, workspace, runtime } = await fixture();
  const { modelCapabilities: _omitted, ...legacyRuntime } = runtime;
  await assert.rejects(
    new PiAgentDirectoryMaterializer({ runtimeRoot: path.join(root, "runtime"), workspace }).materialize({ runId: runtime.runId, runtime: legacyRuntime, wikiProfile: profile, workspace }),
    /capability|proven/iu,
  );
  const materialized = await new PiAgentDirectoryMaterializer({
    runtimeRoot: path.join(root, "runtime-with-registry"),
    workspace,
    resolveModelCapability: () => ({
      provider: profile.provider,
      model: profile.model,
      reasoningCapable: true,
      piInstallationId: runtime.pi.installationId,
      wikiInstallationId: runtime.llmWiki.installationId,
    }),
  }).materialize({ runId: runtime.runId, runtime: legacyRuntime, wikiProfile: profile, workspace });
  assert.equal(materialized.runId, runtime.runId);
});

test("materializer rejects symlinked output and does not copy ambient auth", async () => {
  const { root, workspace, runtime } = await fixture();
  const runtimeRoot = path.join(root, "runtime");
  await mkdir(runtimeRoot, { recursive: true });
  await symlink(path.join(root, "elsewhere"), path.join(runtimeRoot, runtime.runId));
  await assert.rejects(new PiAgentDirectoryMaterializer({ runtimeRoot, workspace }).materialize({ runId: runtime.runId, runtime, wikiProfile: profile, workspace }), /symlink/);
  await assert.rejects(lstat(path.join(root, "runtime", runtime.runId, "pi-agent", "auth.json")), { code: "ENOENT" });
});
