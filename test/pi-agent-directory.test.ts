import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RuntimeResolution } from "../src/control/domain.js";
import { PiAgentDirectoryMaterializer } from "../src/pi/pi-agent-directory.js";

async function fixture() {
  const root = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), "squire-agent-dir-"));
  const wiki = path.join(root, "resolved-wiki");
  await mkdir(path.join(wiki, "extensions", "llm-wiki"), { recursive: true });
  await writeFile(path.join(wiki, "package.json"), JSON.stringify({ name: "@zosmaai/pi-llm-wiki", version: "9.9.9" }));
  await writeFile(path.join(wiki, "extensions", "llm-wiki", "index.ts"), "export default function wiki() {}\n");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const runtime: RuntimeResolution = {
    schemaVersion: 1,
    runId: "run_materializer01",
    pi: { version: "0.84.4", executable: "/ticket/runtime/pi", installationId: "pi-install-exact" },
    llmWiki: { version: "9.9.9", installationId: "wiki-install-exact", root: wiki },
    modelCapabilities: [{ provider: "openai-codex", model: "gpt-5.6-luna", reasoningCapable: true, piInstallationId: "pi-install-exact", wikiInstallationId: "wiki-install-exact" }],
    resolvedAt: "2026-09-01T12:00:00.000Z",
  };
  return { root, wiki, workspace, runtime };
}

const profile = { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" as const };

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
  const unknownRuntime = { ...capabilityFixture.runtime, modelCapabilities: [{ ...capabilityFixture.runtime.modelCapabilities[0]!, model: "gpt-5.6-luna-spoof" }] };
  await assert.rejects(new PiAgentDirectoryMaterializer({ runtimeRoot: path.join(capabilityFixture.root, "runtime"), workspace: capabilityFixture.workspace }).materialize({ runId: unknownRuntime.runId, runtime: unknownRuntime, wikiProfile: profile, workspace: capabilityFixture.workspace }), /capability|proven/);
  const spoofRuntime = { ...capabilityFixture.runtime, runId: "run_capability_spoof" };
  await assert.rejects(new PiAgentDirectoryMaterializer({ runtimeRoot: path.join(capabilityFixture.root, "runtime-2"), workspace: capabilityFixture.workspace, resolveModelCapability: () => ({ provider: profile.provider, model: "gpt-5.6-luna-spoof", reasoningCapable: true, piInstallationId: capabilityFixture.runtime.pi.installationId, wikiInstallationId: capabilityFixture.runtime.llmWiki.installationId }) }).materialize({ runId: spoofRuntime.runId, runtime: spoofRuntime, wikiProfile: profile, workspace: capabilityFixture.workspace }), /capability|proven/);
});

test("materializer rejects symlinked output and does not copy ambient auth", async () => {
  const { root, workspace, runtime } = await fixture();
  const runtimeRoot = path.join(root, "runtime");
  await mkdir(runtimeRoot, { recursive: true });
  await symlink(path.join(root, "elsewhere"), path.join(runtimeRoot, runtime.runId));
  await assert.rejects(new PiAgentDirectoryMaterializer({ runtimeRoot, workspace }).materialize({ runId: runtime.runId, runtime, wikiProfile: profile, workspace }), /symlink/);
  await assert.rejects(lstat(path.join(root, "runtime", runtime.runId, "pi-agent", "auth.json")), { code: "ENOENT" });
});
