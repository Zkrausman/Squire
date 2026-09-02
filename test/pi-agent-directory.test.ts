import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
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
  const footer = await readFile(first.footerExtensionPath);
  assert.equal(manifest["files"]["footerExtension"].sha256, createHash("sha256").update(footer).digest("hex"));
  assert.equal((await (await import("node:fs/promises")).readdir(workspace)).length, 0);

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
  await mkdir(partialDir, { recursive: true });
  await writeFile(path.join(partialDir, "settings.json"), "{}");
  await assert.rejects(new PiAgentDirectoryMaterializer(options).materialize({ runId: partialRuntime.runId, runtime: partialRuntime, wikiProfile: profile, workspace }), /manifest|partial|conflict/);

  const conflictWorkspace = path.join(root, "conflict-workspace");
  await mkdir(path.join(conflictWorkspace, ".pi"), { recursive: true });
  await writeFile(path.join(conflictWorkspace, ".pi", "settings.json"), JSON.stringify({ "llm-wiki": { taskModel: { provider: "other", id: "other" } } }));
  await assert.rejects(new PiAgentDirectoryMaterializer({ ...options, workspace: conflictWorkspace }).materialize({ runId: "run_conflict01", runtime: { ...runtime, runId: "run_conflict01" }, wikiProfile: profile, workspace: conflictWorkspace }), /conflict/);

  await assert.rejects(new PiAgentDirectoryMaterializer({ ...options, resolveModelCapability: () => ({ reasoningCapable: false }) }).materialize({ runId: "run_capability01", runtime: { ...runtime, runId: "run_capability01" }, wikiProfile: profile, workspace }), /reasoning-capable/);
});

test("materializer rejects symlinked output and does not copy ambient auth", async () => {
  const { root, workspace, runtime } = await fixture();
  const runtimeRoot = path.join(root, "runtime");
  await mkdir(runtimeRoot, { recursive: true });
  await symlink(path.join(root, "elsewhere"), path.join(runtimeRoot, runtime.runId));
  await assert.rejects(new PiAgentDirectoryMaterializer({ runtimeRoot, workspace }).materialize({ runId: runtime.runId, runtime, wikiProfile: profile, workspace }), /symlink/);
  await assert.rejects(lstat(path.join(root, "runtime", runtime.runId, "pi-agent", "auth.json")), { code: "ENOENT" });
});
