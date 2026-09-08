import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PiAgentDirectoryMaterializer } from "../src/pi/pi-agent-directory.js";
import { buildPiCommand } from "../src/pi/pi-command.js";
import type { ProcessLaunch } from "../src/pi/pi-process.js";
import { buildPlanSystemPrompt } from "../src/plan/plan-instructions.js";
import { acquireActualPiResource, type ActualPiResourceLease } from "./support/actual-pi-resource.js";
import { InMemoryWorkflowStore } from "./support/in-memory-workflow-store.js";
import { probePlanRpc } from "./support/plan-pi-rpc-probe.js";
import { run, runtime } from "./support/fixtures.js";

const PI_CLI = "/ticket/runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
const WIKI_ROOT = "/ticket/runtime/node_modules/@zosmaai/pi-llm-wiki";

function launchSpec(root: string, agentDir: string, homeDir: string, wikiHomeDir: string, extensionPaths: readonly string[]): ProcessLaunch {
  const command = buildPiCommand({
    piBinary: PI_CLI,
    instructions: buildPlanSystemPrompt("trusted Plan instructions"),
    role: "plan",
    workspace: path.join(root, "workspace"),
    sessionRoot: path.join(root, "sessions"),
    agentDir,
    homeDir,
    wikiHomeDir,
    trustedExtensionPaths: extensionPaths,
    config: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high", instructionsPath: "/ticket/control/roles/plan.md", timeoutSeconds: 30 },
    planContext: {
      runId: "run_example01",
      handoffId: "handoff_plan_1",
      attempt: 1,
      targetSessionId: "plan-session-1",
      inputHead: "a".repeat(40),
      inputArtifact: { path: "artifacts/input/phase-input.json", sha256: "b".repeat(64), schemaId: "urn:squire:contracts:v1:phase-input" },
      ticketIdentifier: "AIDEV-218",
      completedAt: "2026-09-01T12:00:00.000Z",
      allowedValidationCommandIds: ["contracts"],
      requiredValidationCommandIds: ["contracts"],
      ticketRoot: path.join(root, "ticket"),
    },
  });
  return { ...command, env: { ...command.env, PI_OFFLINE: "1" } };
}

test("real Pi RPC loads the materialized Plan extension with the fixed Plan role policy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "squire-plan-rpc-"));
  const workspace = path.join(root, "workspace");
  const runtimeRoot = path.join(root, "runtime");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await mkdir(path.join(root, "ticket"), { recursive: true, mode: 0o700 });
  const store = new InMemoryWorkflowStore();
  await store.create(run());
  const resolved = structuredClone(runtime);
  resolved.pi.executable = PI_CLI;
  resolved.llmWiki.root = WIKI_ROOT;
  const materializer = new PiAgentDirectoryMaterializer({ runtimeRoot, workspace, wikiInstallation: { root: WIKI_ROOT, installationId: resolved.llmWiki.installationId, version: resolved.llmWiki.version }, runLifecycleAuthority: store });
  let actualPiResource: ActualPiResourceLease | undefined;
  try {
    const materialized = await materializer.materialize({ runId: "run_example01", runtime: resolved, wikiProfile: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" }, workspace });
    await mkdir(path.join(materialized.wikiHomeDir, ".llm-wiki"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(materialized.wikiHomeDir, ".llm-wiki", "config.json"), `${JSON.stringify({ knowledge_format: "okf-0.2", name: "Plan RPC", topic: "Plan RPC", mode: "project", version: "1.0" })}\n`, { mode: 0o600 });
    const planExtensions = materialized.trustedExtensionPathsByRole?.plan;
    assert.deepEqual(planExtensions, [materialized.trustedExtensionPaths[0], materialized.planExtensionPath, materialized.trustedExtensionPaths[1]]);
    const probePath = path.join(root, "active-tools-probe.mjs");
    await writeFile(probePath, `export default function (pi) { pi.on("session_start", (_event, context) => context.ui.notify("ACTIVE_TOOLS:" + pi.getActiveTools().join(","), "info")); }\n`, { mode: 0o600 });
    const baseSpec = launchSpec(root, materialized.agentDir, materialized.homeDir, materialized.wikiHomeDir, planExtensions!);
    const spec: ProcessLaunch = { ...baseSpec, args: [...baseSpec.args, "--extension", probePath] };
    actualPiResource = await acquireActualPiResource();
    assert.ok(spec.args.includes("--offline"));
    assert.equal(spec.args[spec.args.indexOf("--tools") + 1], "squire_plan_read,squire_plan_grep,squire_plan_find,squire_plan_ls,wiki_recall,squire_submit_plan");
    const probe = await probePlanRpc(spec);
    assert.equal((probe.state["model"] as Record<string, unknown>)["provider"], "openai-codex");
    assert.equal((probe.state["model"] as Record<string, unknown>)["id"], "gpt-5.6-luna");
    assert.equal(probe.state["thinkingLevel"], "high");
    assert.doesNotMatch(`${probe.output}\n${probe.errors}`, /extension_error|failed to load extension|cannot find module|syntaxerror/iu);
    assert.match(probe.output, /ACTIVE_TOOLS:squire_plan_read,squire_plan_grep,squire_plan_find,squire_plan_ls,wiki_recall,squire_submit_plan/u);
    assert.doesNotMatch(probe.output, /ACTIVE_TOOLS:.*(?:^|,)(?:read|grep|find|ls)(?:,|$)/u);
    assert.doesNotMatch(probe.output, /wiki_(?:capture_source|ingest|ensure_page|lint|observe|retro|bootstrap|watch|log_event|rebuild_meta|reindex_embeddings|search|status)/u);
    assert.equal(probe.errors, "");
    assert.match(String(probe.state["sessionFile"]), /sessions/u);
    assert.match(await readFile(materialized.planExtensionPath!, "utf8"), /squire_submit_plan/u);
  } finally {
    try { if (actualPiResource) await actualPiResource.release(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
});
