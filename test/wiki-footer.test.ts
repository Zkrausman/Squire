import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  ROUTINE_WIKI_STATUS_BLOCK,
  buildTrustedWikiFooterExtensionSource,
  compactVisibleWikiStatuses,
  compactWikiStatus,
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

function normalStatuses(): Map<string, string> {
  return new Map([
    ["llm-wiki", "🧠 LLM Wiki (16 tools, trajectory + observe + recall active)"],
    ["llm-wiki-model", `🧠 wiki model: ${model}`],
  ]);
}

test("trusted footer compacts only the known healthy hidden wiki status and preserves prompt bytes", () => {
  const prompt = `prefix\n\n${ROUTINE_WIKI_STATUS_BLOCK}\n\nunrelated instructions\n\nmultiline`;
  const compact = compactWikiStatusFooter(prompt, model);
  assert.equal(compact, "prefix\n\n<wiki_status>🧠 - · openai-codex/gpt-5.6-luna</wiki_status>\n\nunrelated instructions\n\nmultiline");
  assert.equal(compactWikiStatusFooter(compact, model), compact);

  const counted = `<wiki_status>LLM Wiki active (17 tools) — use wiki_recall for deeper search, wiki_observe to record observations, wiki_retro to save insights.</wiki_status>`;
  assert.match(compactWikiStatusFooter(counted, model), /🧠 17 · openai-codex\/gpt-5\.6-luna/);
});

test("unknown and diagnostic hidden wiki blocks remain lossless", () => {
  const warning = "<wiki_status>LLM Wiki active — warning: indexing failed\nfull diagnostic: retry later</wiki_status>";
  const evolved = "<wiki_status>LLM Wiki active; new status grammar (blocked)</wiki_status>";
  const prompt = `before ${warning} middle ${evolved} after`;
  assert.equal(compactWikiStatusFooter(prompt, model), prompt);
  const compactDiagnostic = `<wiki_status>🧠 13 · ${model} — warning: indexing error</wiki_status>`;
  assert.equal(compactWikiStatusFooter(compactDiagnostic, model), compactDiagnostic);
  const compactFromAnotherModel = "<wiki_status>🧠 13 · other-provider/other-model</wiki_status>";
  assert.equal(compactWikiStatusFooter(compactFromAnotherModel, model), compactFromAnotherModel);
  assert.equal(compactWikiStatusFooter("no wiki footer here", model), "no wiki footer here");
});

test("visible footer uses the personal complementary one-line status grammar", () => {
  const statuses = normalStatuses();
  assert.equal(compactWikiStatus(statuses, model), "🧠 — · openai-codex/gpt-5.6-luna");
  assert.deepEqual(compactVisibleWikiStatuses(statuses, model), ["🧠 — · openai-codex/gpt-5.6-luna"]);

  statuses.set("llm-wiki", "🧠 LLM Wiki — recalled 7 pages for this task");
  assert.equal(compactWikiStatus(statuses, model), "🧠 7 · openai-codex/gpt-5.6-luna");
  assert.deepEqual(compactVisibleWikiStatuses(statuses, model), ["🧠 7 · openai-codex/gpt-5.6-luna"]);
});

test("visible footer preserves full setup, migration, error, and unknown status text", () => {
  const setup = "🧠 Wiki setup blocked:\npermission denied; run the migration command";
  const migration = "🧠 Personal wiki layout fixed: flattened 2 entries\nsee CHANGELOG";
  const evolvedDiagnostic = "🧠 LLM Wiki (13 tools, observe + recall active, warning: indexing error)";
  const statuses = new Map<string, string>([
    ["llm-wiki", setup],
    ["llm-wiki-model", `🧠 wiki model: ${model}`],
    ["other-extension", migration],
  ]);
  assert.deepEqual(compactVisibleWikiStatuses(statuses, model), [
    ...setup.split("\n"),
    ...migration.split("\n"),
  ]);

  statuses.set("llm-wiki", evolvedDiagnostic);
  assert.deepEqual(compactVisibleWikiStatuses(statuses, model), [...evolvedDiagnostic.split("\n"), ...migration.split("\n")]);
  statuses.set("llm-wiki-model", "🧠 wiki model: warning: configured model unavailable\nchoose a model");
  const lines = compactVisibleWikiStatuses(statuses, model);
  assert.ok(lines.includes("🧠 wiki model: warning: configured model unavailable"));
  assert.ok(lines.includes("choose a model"));

  const rendered = renderCompactWikiFooter(160, footerContext(), footerData(statuses), model, theme);
  assert.ok(rendered.some(line => line.includes("warning: indexing error")));
  assert.ok(rendered.some(line => line.includes("configured model unavailable")));
});

test("visible footer retains the complementary model, thinking, context, cost, and idle layout", () => {
  const lines = renderCompactWikiFooter(160, footerContext(), footerData(normalStatuses()), model, theme);
  assert.deepEqual(lines, ["gpt-5.6-sol · high · 🧠 — · openai-codex/gpt-5.6-luna · Ready · Full Access · Context 24k/128k · Session est. $0.012"]);

  let idle = false;
  const workingContext = { ...footerContext(), isIdle: () => idle };
  assert.match(renderCompactWikiFooter(160, workingContext, footerData(normalStatuses()), model, theme)[0]!, / · Working · /);
  idle = true;
  assert.match(renderCompactWikiFooter(160, workingContext, footerData(normalStatuses()), model, theme)[0]!, / · Ready · /);

  const noUsageContext = { ...footerContext(), getContextUsage: () => ({ tokens: null }) };
  assert.match(renderCompactWikiFooter(160, noUsageContext, footerData(normalStatuses()), model, theme)[0]!, /Context —\/128k/);
});

test("ANSI-aware truncation keeps colored output within the requested width", () => {
  const ansiTheme: FooterThemeLike = { fg: (_color, text) => `\u001b[36m${text}\u001b[39m` };
  const line = renderCompactWikiFooter(32, footerContext(), footerData(normalStatuses()), model, ansiTheme)[0]!;
  assert.ok(line.includes("\u001b[0m"));
  assert.ok(line.endsWith("\u001b[39m\u001b[0m"));
  assert.ok(stripAnsi(line).length <= 32);

  const diagnostic = "🧠 Wiki setup blocked: permission denied; retry with the full migration diagnostics";
  const diagnosticLines = renderCompactWikiFooter(
    32,
    footerContext(),
    footerData(new Map([["llm-wiki", diagnostic], ["llm-wiki-model", `🧠 wiki model: ${model}`]])),
    model,
    ansiTheme,
  );
  assert.ok(diagnosticLines.some(lineValue => stripAnsi(lineValue).includes(diagnostic)));
});

function stripAnsi(value: string): string {
  return value.replace(/\u001B(?:\[[0-?]*[ -\/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|_[^\u0007]*(?:\u0007|\u001B\\))/gu, "");
}

test("typed and generated truncation stays within pi-tui terminal columns", async () => {
  const piTui = await import(pathToFileURL("/ticket/runtime/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/utils.js").href) as unknown as {
    visibleWidth(value: string): number;
  };
  const ansiTheme: FooterThemeLike = { fg: (_color, text) => `\u001b[36m${text}\u001b[39m` };
  const generatedSource = buildTrustedWikiFooterExtensionSource(profile);
  const generatedModule = await import(`data:text/javascript,${encodeURIComponent(generatedSource)}`);
  const callbacks = new Map<string, (event: unknown, context?: ExtensionContextLike) => unknown>();
  generatedModule.default({ on(event: string, handler: (event: unknown, context?: ExtensionContextLike) => unknown) { callbacks.set(event, handler); } });
  let factory: Parameters<ExtensionContextLike["ui"]["setFooter"]>[0] | undefined;
  const context = {
    ...footerContext(),
    ui: { setFooter: (next: Parameters<ExtensionContextLike["ui"]["setFooter"]>[0]) => { factory = next; } },
  } satisfies ExtensionContextLike;
  await callbacks.get("session_start")!({}, context);
  assert.ok(factory);
  const statuses = footerData(normalStatuses());
  const cases = [
    { id: "界界", widths: [5, 6, 7, 8] },
    { id: "ＡＡ", widths: [5, 6, 7] },
    { id: "e\u0301e", widths: [4, 5, 6] },
    { id: "👨‍👩‍👧‍👦", widths: [4, 5, 6, 7] },
  ];
  for (const current of cases) {
    const currentContext = { ...footerContext(), model: { ...footerContext().model, id: current.id } };
    for (const width of current.widths) {
      const typed = renderCompactWikiFooter(width, currentContext, statuses, model, ansiTheme)[0]!;
      await callbacks.get("model_select")!({ model: { ...currentContext.model } }, context);
      const generated: string = factory!({ requestRender() {} }, ansiTheme, statuses).render(width)[0]!;
      assert.equal(generated, typed, `generated width parity for ${current.id} at ${width}`);
      assert.ok(piTui.visibleWidth(typed) <= width, `${current.id} exceeded ${width}: ${JSON.stringify(typed)}`);
    }
  }
  const cjk = renderCompactWikiFooter(6, { ...footerContext(), model: { ...footerContext().model, id: "界界" } }, statuses, model, ansiTheme)[0]!;
  assert.equal(stripAnsi(cjk), "界...");
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
  assert.deepEqual(before, { systemPrompt: "<wiki_status>🧠 - · openai-codex/gpt-5.6-luna</wiki_status>" });

  let factory: Parameters<ExtensionContextLike["ui"]["setFooter"]>[0] | undefined;
  let renderRequests = 0;
  const context = {
    ...footerContext(),
    ui: { setFooter: (next: Parameters<ExtensionContextLike["ui"]["setFooter"]>[0]) => { factory = next; } },
  } satisfies ExtensionContextLike;
  await callbacks.get("session_start")!({}, context);
  assert.ok(factory);
  const component = factory!({ requestRender() { renderRequests += 1; } }, theme, footerData(normalStatuses()));
  assert.equal(component.render(160)[0], "gpt-5.6-sol · high · 🧠 — · openai-codex/gpt-5.6-luna · Ready · Full Access · Context 24k/128k · Session est. $0.012");
  await callbacks.get("model_select")!({ model: { provider: "openai-codex", id: "gpt-5.6-terra", reasoning: true } }, context);
  await callbacks.get("thinking_level_select")!({ level: "max" }, context);
  assert.ok(renderRequests >= 2);
  assert.match(component.render(160)[0]!, /gpt-5\.6-terra · max/);
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
  assert.deepEqual(generatedLines, ["gpt-5.6-sol · high · 🧠 4 · openai-codex/gpt-5.6-luna · Ready · Full Access · Context 24k/128k · Session est. $0.012"]);

  const actionableStatuses = new Map([
    ["llm-wiki", "🧠 LLM Wiki (13 tools, observe + recall active, warning: indexing error)"],
    ["llm-wiki-model", `🧠 wiki model: ${model}`],
  ]);
  const generatedActionable = factory!({ requestRender() {} }, theme, footerData(actionableStatuses)).render(160);
  assert.ok(generatedActionable.some(line => line.includes("warning: indexing error")));

  const before = await callbacks.get("before_agent_start")!({ systemPrompt: ROUTINE_WIKI_STATUS_BLOCK });
  assert.deepEqual(before, { systemPrompt: "<wiki_status>🧠 - · openai-codex/gpt-5.6-luna</wiki_status>" });
  const compactDiagnostic = `<wiki_status>🧠 13 · ${model} — warning: indexing error</wiki_status>`;
  assert.equal(await callbacks.get("before_agent_start")!({ systemPrompt: compactDiagnostic }), undefined);
});
