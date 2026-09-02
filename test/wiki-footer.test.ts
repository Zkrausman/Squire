import assert from "node:assert/strict";
import test from "node:test";
import {
  ROUTINE_WIKI_STATUS_BLOCK,
  buildTrustedWikiFooterExtensionSource,
  compactVisibleWikiStatuses,
  compactWikiStatusFooter,
  installCompactWikiFooterExtension,
  renderCompactWikiFooter,
  type CompactFooterContextLike,
  type ExtensionApiLike,
  type ExtensionContextLike,
  type FooterDataLike,
  type FooterThemeLike,
} from "../src/pi/wiki-footer.js";

const profile = { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" as const };
const model = "openai-codex/gpt-5.6-luna";
const theme: FooterThemeLike = { fg: (_color, text) => text };

function footerData(statuses: ReadonlyMap<string, string>): FooterDataLike {
  return {
    getExtensionStatuses: () => statuses,
    getGitBranch: () => "feature/aidev-228",
    getAvailableProviderCount: () => 1,
    onBranchChange: () => () => {},
  };
}

function footerContext(): CompactFooterContextLike {
  return {
    cwd: "/ticket/workspace",
    model: { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true, contextWindow: 128000 },
    thinkingLevel: "high",
    sessionManager: {
      getCwd: () => "/ticket/workspace",
      getSessionName: () => "aidev-228",
      getEntries: () => [
        {
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 1200, output: 345, cacheRead: 100, cacheWrite: 20, cost: { total: 0.012 } },
          },
        },
      ],
    },
    getContextUsage: () => ({ tokens: 24000, contextWindow: 128000, percent: 18.75 }),
  };
}

test("trusted footer compacts only the known healthy hidden wiki status and preserves prompt bytes", () => {
  const prompt = `prefix\n\n${ROUTINE_WIKI_STATUS_BLOCK}\n\nunrelated instructions\n\nmultiline`;
  const compact = compactWikiStatusFooter(prompt, model);
  assert.equal(compact, `prefix\n\n<wiki_status>🧠 - · ${model}</wiki_status>\n\nunrelated instructions\n\nmultiline`);
  assert.equal(compactWikiStatusFooter(compact, model), compact);

  const counted = `<wiki_status>LLM Wiki active (17 tools) — use wiki_recall for deeper search, wiki_observe to record observations, wiki_retro to save insights.</wiki_status>`;
  assert.match(compactWikiStatusFooter(counted, model), /🧠 17 · openai-codex\/gpt-5\.6-luna/);
});

test("unknown and diagnostic hidden wiki blocks remain lossless", () => {
  const warning = "<wiki_status>LLM Wiki active — warning: indexing failed\nfull diagnostic: retry later</wiki_status>";
  const evolved = "<wiki_status>LLM Wiki active; new status grammar (blocked)</wiki_status>";
  const prompt = `before ${warning} middle ${evolved} after`;
  assert.equal(compactWikiStatusFooter(prompt, model), prompt);
  assert.equal(compactWikiStatusFooter("no wiki footer here", model), "no wiki footer here");
});

test("visible footer compacts the llm-wiki status map and uses the configured wiki model", () => {
  const statuses = new Map<string, string>([
    ["llm-wiki", "🧠 LLM Wiki (16 tools, trajectory + observe + recall active)"],
    ["llm-wiki-model", `🧠 wiki model: ${model}`],
  ]);
  assert.deepEqual(compactVisibleWikiStatuses(statuses, model), [`🧠 - · ${model}`]);

  statuses.set("llm-wiki", "🧠 LLM Wiki — recalled 7 pages for this task");
  assert.deepEqual(compactVisibleWikiStatuses(statuses, model), [`🧠 7 · ${model}`]);
  assert.deepEqual(renderCompactWikiFooter(160, footerContext(), footerData(statuses), model, theme).slice(2), [`🧠 7 · ${model}`]);
});

test("visible footer preserves full setup, migration, error, and unknown status text", () => {
  const setup = "🧠 Wiki setup blocked:\npermission denied; run the migration command";
  const migration = "🧠 Personal wiki layout fixed: flattened 2 entries\nsee CHANGELOG";
  const statuses = new Map<string, string>([
    ["llm-wiki", setup],
    ["llm-wiki-model", `🧠 wiki model: ${model}`],
    ["other-extension", migration],
  ]);
  assert.deepEqual(compactVisibleWikiStatuses(statuses, model), [
    ...setup.split("\n"),
    ...migration.split("\n"),
  ]);

  statuses.set("llm-wiki-model", "🧠 wiki model: warning: configured model unavailable\nchoose a model");
  const lines = compactVisibleWikiStatuses(statuses, model);
  assert.ok(lines.includes("🧠 wiki model: warning: configured model unavailable"));
  assert.ok(lines.includes("choose a model"));
});

test("visible footer retains Pi model/thinking, token, context, cost, and status layout", () => {
  const statuses = new Map<string, string>([
    ["llm-wiki", "🧠 LLM Wiki (13 tools, observe + recall active)"],
    ["llm-wiki-model", `🧠 wiki model: ${model}`],
  ]);
  const lines = renderCompactWikiFooter(160, footerContext(), footerData(statuses), model, theme);
  assert.equal(lines[0], "/ticket/workspace (feature/aidev-228) • aidev-228");
  assert.match(lines[1]!, /↑1\.2k ↓345 R100 W20 CH7\.6% \$0\.012 18\.8%\/128k \(auto\)/);
  assert.match(lines[1]!, /gpt-5\.6-sol • high/);
  assert.equal(lines[2], `🧠 - · ${model}`);
});

test("ExtensionAPI installs both the hidden prompt transform and visible setFooter renderer", async () => {
  const callbacks = new Map<string, (event: unknown, context?: ExtensionContextLike) => unknown>();
  const api = {
    on(event: string, handler: (event: unknown, context?: ExtensionContextLike) => unknown): void {
      callbacks.set(event, handler);
    },
  } as unknown as ExtensionApiLike;
  installCompactWikiFooterExtension(api, profile);

  const before = await callbacks.get("before_agent_start")!({ systemPrompt: ROUTINE_WIKI_STATUS_BLOCK });
  assert.deepEqual(before, { systemPrompt: `<wiki_status>🧠 - · ${model}</wiki_status>` });

  let factory: Parameters<ExtensionContextLike["ui"]["setFooter"]>[0] | undefined;
  const context = {
    ...footerContext(),
    ui: { setFooter: (next: Parameters<ExtensionContextLike["ui"]["setFooter"]>[0]) => { factory = next; } },
  } satisfies ExtensionContextLike;
  await callbacks.get("session_start")!({}, context);
  assert.ok(factory);
  const component = factory!({ requestRender() {} }, theme, footerData(new Map([
    ["llm-wiki", "🧠 LLM Wiki (16 tools, trajectory + observe + recall active)"],
    ["llm-wiki-model", `🧠 wiki model: ${model}`],
  ])));
  assert.equal(component.render(160)[2], `🧠 - · ${model}`);
  await callbacks.get("model_select")!({ model: { provider: "openai-codex", id: "gpt-5.6-terra", reasoning: true } }, context);
  await callbacks.get("thinking_level_select")!({ level: "max" }, context);
  assert.match(component.render(160)[1]!, /gpt-5\.6-terra • max/);
});

test("generated self-contained extension has the same status-map footer behavior", async () => {
  const source = buildTrustedWikiFooterExtensionSource(profile);
  assert.match(source, /before_agent_start/);
  assert.match(source, /session_start/);
  assert.match(source, /setFooter/);
  assert.match(source, /getExtensionStatuses/);
  assert.match(source, /llm-wiki-model/);
  assert.match(source, /gpt-5\.6-luna/);
  assert.doesNotMatch(source, /from ["']/);

  const module = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  const callbacks = new Map<string, (event: unknown, context?: ExtensionContextLike) => unknown>();
  module.default({ on(event: string, handler: (event: unknown, context?: ExtensionContextLike) => unknown) { callbacks.set(event, handler); } });

  let factory: Parameters<ExtensionContextLike["ui"]["setFooter"]>[0] | undefined;
  const context = {
    ...footerContext(),
    ui: { setFooter: (next: Parameters<ExtensionContextLike["ui"]["setFooter"]>[0]) => { factory = next; } },
  } satisfies ExtensionContextLike;
  await callbacks.get("session_start")!({}, context);
  assert.ok(factory);
  const statuses = new Map([
    ["llm-wiki", "🧠 LLM Wiki — recalled 4 pages for this task"],
    ["llm-wiki-model", `🧠 wiki model: ${model}`],
  ]);
  const generatedLines = factory!({ requestRender() {} }, theme, footerData(statuses)).render(160);
  const typedLines = renderCompactWikiFooter(160, footerContext(), footerData(statuses), model, theme);
  assert.deepEqual(generatedLines, typedLines);
  const actionableStatuses = new Map([
    ["llm-wiki", "🧠 Wiki setup blocked:\npermission denied; migrate first"],
    ["llm-wiki-model", `🧠 wiki model: ${model}`],
  ]);
  const generatedActionable = factory!({ requestRender() {} }, theme, footerData(actionableStatuses)).render(160);
  assert.ok(generatedActionable.includes("permission denied; migrate first"));

  const before = await callbacks.get("before_agent_start")!({ systemPrompt: ROUTINE_WIKI_STATUS_BLOCK });
  assert.deepEqual(before, { systemPrompt: `<wiki_status>🧠 - · ${model}</wiki_status>` });
});
