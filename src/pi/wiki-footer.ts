import type { PiModelProfile } from "./pi-configuration.js";
import { wikiModelRef } from "./pi-configuration.js";

/** The routine footer emitted by the pinned pi-llm-wiki installation. */
export const ROUTINE_WIKI_STATUS_BLOCK =
  "<wiki_status>LLM Wiki active — use wiki_recall for deeper search, wiki_observe to record observations, wiki_retro to save insights.</wiki_status>";

const ROUTINE_SUFFIX =
  " — use wiki_recall for deeper search, wiki_observe to record observations, wiki_retro to save insights.";
const DIAGNOSTIC_WORDS = /(?:warning|warn|error|failed|failure|blocked|diagnostic|unavailable|conflict|denied|exception)/iu;
const COMPACT_BLOCK = /^<wiki_status>🧠 (\d+|-) · ([^<>\r\n]+)<\/wiki_status>$/u;
const ROUTINE_BLOCK = new RegExp(
  `^<wiki_status>LLM Wiki active(?: \\((\\d+) tools?\\))?${escapeRegExp(ROUTINE_SUFFIX)}<\\/wiki_status>$`,
  "u",
);

const HEALTHY_WIKI_STATUS = /^🧠 LLM Wiki \(\d+ tools?, .+ active\)$/u;
const HEALTHY_WIKI_STATUS_LEGACY = /^🧠 LLM Wiki active(?: \(\d+ tools?\))?$/u;
const RECALL_STATUS = /^🧠 LLM Wiki — recalled (\d+) page(?:s)? for this task$/u;
const HEALTHY_MODEL_STATUS_PREFIX = "🧠 wiki model: ";
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -\/]*[@-~]/gu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compactRoutineBlock(block: string, model: string): string | undefined {
  const compact = COMPACT_BLOCK.exec(block);
  if (compact) return compact[2] === model ? block : `<wiki_status>🧠 ${compact[1]} · ${model}</wiki_status>`;
  const match = ROUTINE_BLOCK.exec(block);
  if (!match || DIAGNOSTIC_WORDS.test(block)) return undefined;
  const count = match[1] ?? "-";
  return `<wiki_status>🧠 ${count} · ${model}</wiki_status>`;
}

/**
 * Replace only the exact healthy footer grammar emitted by the trusted wiki
 * package. Unknown/evolved blocks and diagnostic-bearing blocks are returned
 * byte-for-byte unchanged. Re-running this function is therefore safe.
 */
export function compactWikiStatusFooter(systemPrompt: string, model: string): string {
  if (!systemPrompt.includes("<wiki_status>")) return systemPrompt;
  let output = "";
  let cursor = 0;
  while (cursor < systemPrompt.length) {
    const start = systemPrompt.indexOf("<wiki_status>", cursor);
    if (start < 0) {
      output += systemPrompt.slice(cursor);
      break;
    }
    const endTag = "</wiki_status>";
    const end = systemPrompt.indexOf(endTag, start + "<wiki_status>".length);
    if (end < 0) {
      output += systemPrompt.slice(cursor);
      break;
    }
    const blockEnd = end + endTag.length;
    output += systemPrompt.slice(cursor, start);
    const block = systemPrompt.slice(start, blockEnd);
    output += compactRoutineBlock(block, model) ?? block;
    cursor = blockEnd;
  }
  return output;
}

export interface BeforeAgentStartEventLike {
  systemPrompt: string;
  prompt?: string;
}

export interface FooterThemeLike {
  fg(color: string, text: string): string;
}

export interface FooterTuiLike {
  requestRender(): void;
}

export interface FooterDataLike {
  getExtensionStatuses(): ReadonlyMap<string, string>;
  getGitBranch?(): string | null;
  getAvailableProviderCount?(): number;
  onBranchChange?(callback: () => void): () => void;
}

export interface FooterModelLike {
  provider?: string;
  id?: string;
  reasoning?: boolean;
  contextWindow?: number;
}

export interface FooterContextUsageLike {
  tokens?: number | null;
  contextWindow?: number;
  percent?: number | null;
}

export interface FooterSessionManagerLike {
  getEntries(): readonly unknown[];
  getCwd?(): string;
  getSessionName?(): string | undefined;
}

export interface CompactFooterContextLike {
  cwd?: string;
  model?: FooterModelLike;
  thinkingLevel?: string;
  sessionManager: FooterSessionManagerLike;
  getContextUsage(): FooterContextUsageLike | undefined;
}

export interface FooterComponentLike {
  invalidate(): void;
  render(width: number): string[];
  dispose?(): void;
}

export interface FooterUiLike {
  setFooter(
    factory: (tui: FooterTuiLike, theme: FooterThemeLike, footerData: FooterDataLike) => FooterComponentLike,
  ): void;
}

export interface ExtensionContextLike extends CompactFooterContextLike {
  ui: FooterUiLike;
}

export interface ModelSelectEventLike {
  model: FooterModelLike;
}

export interface ThinkingLevelSelectEventLike {
  level: string;
}

export interface ExtensionApiLike {
  on(event: "before_agent_start", handler: (event: BeforeAgentStartEventLike, ctx?: unknown) => unknown): unknown;
  on(event: "session_start", handler: (event: unknown, ctx: ExtensionContextLike) => unknown): unknown;
  on(event: "model_select", handler: (event: ModelSelectEventLike, ctx: ExtensionContextLike) => unknown): unknown;
  on(event: "thinking_level_select", handler: (event: ThinkingLevelSelectEventLike, ctx: ExtensionContextLike) => unknown): unknown;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function usageFrom(value: unknown): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
} {
  const usage = record(value);
  const costValue = record(usage?.["cost"]);
  return {
    input: numberOrZero(usage?.["input"]),
    output: numberOrZero(usage?.["output"]),
    cacheRead: numberOrZero(usage?.["cacheRead"]),
    cacheWrite: numberOrZero(usage?.["cacheWrite"]),
    cost: numberOrZero(costValue?.["total"]),
  };
}

function addUsage(total: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }, value: unknown): void {
  const usage = usageFrom(value);
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.cost += usage.cost;
}

function formatTokens(count: number): string {
  if (count < 1000) return Math.round(count).toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function visibleWidth(text: string): number {
  return [...text.replace(ANSI_ESCAPE, "")].reduce((width, character) => width + (character.codePointAt(0)! > 0xffff ? 2 : 1), 0);
}

function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  if (width <= 3) return ".".repeat(width);
  const characters = [...text.replace(ANSI_ESCAPE, "")];
  return `${characters.slice(0, width - 3).join("")}...`;
}

function dim(theme: FooterThemeLike, text: string): string {
  return theme.fg("dim", text);
}

function statusLines(text: string): string[] {
  // Do not summarize or sanitize actionable status text. Splitting only makes
  // multiline diagnostics render as separate terminal lines.
  return text.split(/\r?\n/u);
}

function healthyWikiStatus(status: string): { count: string } | undefined {
  const recall = RECALL_STATUS.exec(status);
  if (recall) return { count: recall[1] ?? "-" };
  if (HEALTHY_WIKI_STATUS.test(status) || HEALTHY_WIKI_STATUS_LEGACY.test(status)) return { count: "-" };
  return undefined;
}

function healthyModelStatus(status: string, wikiModel: string): boolean {
  return status === `${HEALTHY_MODEL_STATUS_PREFIX}${wikiModel}`;
}

/**
 * Select the visible wiki status line from pi-llm-wiki's two status keys.
 * Only the known healthy/routine forms are compacted. Setup, migration,
 * warning, error, blocked, and evolved text is returned in full.
 */
export function compactVisibleWikiStatuses(
  statuses: ReadonlyMap<string, string>,
  wikiModel: string,
): string[] {
  const lines: string[] = [];
  const wikiStatus = statuses.get("llm-wiki");
  if (wikiStatus !== undefined) {
    const healthy = healthyWikiStatus(wikiStatus);
    if (healthy) lines.push(`🧠 ${healthy.count} · ${wikiModel}`);
    else lines.push(...statusLines(wikiStatus));
  }

  const modelStatus = statuses.get("llm-wiki-model");
  if (modelStatus !== undefined && !healthyModelStatus(modelStatus, wikiModel)) {
    lines.push(...statusLines(modelStatus));
  }

  for (const [key, text] of [...statuses.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (key === "llm-wiki" || key === "llm-wiki-model") continue;
    lines.push(...statusLines(text));
  }
  return lines;
}

function renderStatsLine(
  width: number,
  context: CompactFooterContextLike,
  footerData: FooterDataLike,
  theme: FooterThemeLike,
): string {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let latestCacheHitRate: number | undefined;
  for (const entry of context.sessionManager.getEntries()) {
    const item = record(entry);
    if (item?.["type"] === "message") {
      const message = record(item["message"]);
      if (message?.["role"] === "assistant") {
        addUsage(total, message["usage"]);
        const usage = usageFrom(message["usage"]);
        const latestPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
        latestCacheHitRate = latestPromptTokens > 0 ? (usage.cacheRead / latestPromptTokens) * 100 : undefined;
      } else if (message?.["role"] === "toolResult") {
        addUsage(total, message["usage"]);
      }
    } else if (item?.["type"] === "branch_summary" || item?.["type"] === "compaction") {
      addUsage(total, item["usage"]);
    }
  }

  const contextUsage = context.getContextUsage();
  const contextWindow = numberOrZero(contextUsage?.contextWindow ?? context.model?.contextWindow);
  const contextPercentValue = typeof contextUsage?.percent === "number" ? contextUsage.percent : 0;
  const contextPercent = contextUsage?.percent === null ? "?" : contextPercentValue.toFixed(1);
  const statsParts: string[] = [];
  if (total.input) statsParts.push(`↑${formatTokens(total.input)}`);
  if (total.output) statsParts.push(`↓${formatTokens(total.output)}`);
  if (total.cacheRead) statsParts.push(`R${formatTokens(total.cacheRead)}`);
  if (total.cacheWrite) statsParts.push(`W${formatTokens(total.cacheWrite)}`);
  if ((total.cacheRead > 0 || total.cacheWrite > 0) && latestCacheHitRate !== undefined) statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
  if (total.cost) statsParts.push(`$${total.cost.toFixed(3)}`);

  const contextText = contextPercent === "?" ? `?/${formatTokens(contextWindow)} (auto)` : `${contextPercent}%/${formatTokens(contextWindow)} (auto)`;
  const contextDisplay = contextPercentValue > 90 ? theme.fg("error", contextText) : contextPercentValue > 70 ? theme.fg("warning", contextText) : contextText;
  statsParts.push(contextDisplay);
  let statsLeft = statsParts.join(" ");

  const modelName = context.model?.id || "no-model";
  let rightSideWithoutProvider = modelName;
  if (context.model?.reasoning) {
    const thinkingLevel = context.thinkingLevel || "off";
    rightSideWithoutProvider = thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
  }
  let rightSide = rightSideWithoutProvider;
  if ((footerData.getAvailableProviderCount?.() ?? 0) > 1 && context.model?.provider) {
    const withProvider = `(${context.model.provider}) ${rightSideWithoutProvider}`;
    if (visibleWidth(statsLeft) + 2 + visibleWidth(withProvider) <= width) rightSide = withProvider;
  }

  if (visibleWidth(statsLeft) > width) statsLeft = truncateToWidth(statsLeft, width);
  const availableForRight = width - visibleWidth(statsLeft) - 2;
  const right = availableForRight > 0 ? truncateToWidth(rightSide, availableForRight) : "";
  const padding = " ".repeat(Math.max(0, width - visibleWidth(statsLeft) - visibleWidth(right)));
  return dim(theme, statsLeft) + dim(theme, padding + right);
}

/** Render the clean Pi footer layout plus the compact/actionable wiki line(s). */
export function renderCompactWikiFooter(
  width: number,
  context: CompactFooterContextLike,
  footerData: FooterDataLike,
  wikiModel: string,
  theme: FooterThemeLike,
): string[] {
  const cwd = context.sessionManager.getCwd?.() ?? context.cwd ?? "";
  const branch = footerData.getGitBranch?.();
  const sessionName = context.sessionManager.getSessionName?.();
  const pwd = `${cwd}${branch ? ` (${branch})` : ""}${sessionName ? ` • ${sessionName}` : ""}`;
  const lines = [truncateToWidth(dim(theme, pwd), width), renderStatsLine(width, context, footerData, theme)];
  lines.push(...compactVisibleWikiStatuses(footerData.getExtensionStatuses(), wikiModel).map(line => line));
  return lines;
}

/** Install the controller-owned handler and TUI footer on a Pi ExtensionAPI-like object. */
export function installCompactWikiFooterExtension(api: ExtensionApiLike, profile: PiModelProfile): void {
  const model = wikiModelRef(profile);
  api.on("before_agent_start", async (event) => {
    if (typeof event.systemPrompt !== "string") throw new Error("Pi wiki footer received a malformed system prompt");
    const systemPrompt = compactWikiStatusFooter(event.systemPrompt, model);
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });
  let activeModel: FooterModelLike | undefined;
  let activeThinkingLevel: string | undefined;
  api.on("model_select", (event, context) => {
    activeModel = event.model;
    activeThinkingLevel = context.thinkingLevel;
  });
  api.on("thinking_level_select", (event) => {
    activeThinkingLevel = event.level;
  });
  api.on("session_start", async (_event, context) => {
    activeModel = context.model;
    activeThinkingLevel = context.thinkingLevel;
    context.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange?.(() => tui.requestRender());
      return {
        invalidate() {},
        ...(unsubscribe ? { dispose: unsubscribe } : {}),
        render(width: number): string[] {
          const renderContext: CompactFooterContextLike = {
            ...context,
            ...(activeModel === undefined ? {} : { model: activeModel }),
            ...(activeThinkingLevel === undefined ? {} : { thinkingLevel: activeThinkingLevel }),
          };
          return renderCompactWikiFooter(width, renderContext, footerData, model, theme);
        },
      };
    });
  });
}

/**
 * Generate a self-contained ESM extension. It intentionally has no imports so
 * Pi can load the trusted file from a run directory without resolving anything
 * through the target repository. The generated renderer mirrors the typed
 * implementation above, including the built-in model/thinking/stats layout.
 */
export function buildTrustedWikiFooterExtensionSource(profile: PiModelProfile): string {
  const model = wikiModelRef(profile);
  return GENERATED_EXTENSION_SOURCE.replace("__SQUIRE_WIKI_MODEL__", JSON.stringify(model));
}

const GENERATED_EXTENSION_SOURCE = String.raw`// Squire trusted wiki footer; do not edit.
const WIKI_MODEL = __SQUIRE_WIKI_MODEL__;
const ROUTINE_SUFFIX = " — use wiki_recall for deeper search, wiki_observe to record observations, wiki_retro to save insights.";
const DIAGNOSTIC_WORDS = /(?:warning|warn|error|failed|failure|blocked|diagnostic|unavailable|conflict|denied|exception)/iu;
const COMPACT_BLOCK = /^<wiki_status>🧠 (\d+|-) · ([^<>\r\n]+)<\/wiki_status>$/u;
const ROUTINE_BLOCK = new RegExp("^<wiki_status>LLM Wiki active(?: \\((\\d+) tools?\\))?" + ROUTINE_SUFFIX.replace(/[.*+?^$\\{}()|[\\]\\]/g, "\\$&") + "<\\/wiki_status>$", "u");
const HEALTHY_WIKI_STATUS = /^🧠 LLM Wiki \(\d+ tools?, .+ active\)$/u;
const HEALTHY_WIKI_STATUS_LEGACY = /^🧠 LLM Wiki active(?: \(\d+ tools?\))?$/u;
const RECALL_STATUS = /^🧠 LLM Wiki — recalled (\d+) page(?:s)? for this task$/u;
const HEALTHY_MODEL_STATUS_PREFIX = "🧠 wiki model: ";
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -\/]*[@-~]/gu;
function compactBlock(block) {
  const compact = COMPACT_BLOCK.exec(block);
  if (compact) return compact[2] === WIKI_MODEL ? block : "<wiki_status>🧠 " + compact[1] + " · " + WIKI_MODEL + "</wiki_status>";
  const match = ROUTINE_BLOCK.exec(block);
  if (!match || DIAGNOSTIC_WORDS.test(block)) return block;
  return "<wiki_status>🧠 " + (match[1] ?? "-") + " · " + WIKI_MODEL + "</wiki_status>";
}
function compactPrompt(prompt) {
  if (!prompt.includes("<wiki_status>")) return prompt;
  let output = "";
  let cursor = 0;
  while (cursor < prompt.length) {
    const start = prompt.indexOf("<wiki_status>", cursor);
    if (start < 0) { output += prompt.slice(cursor); break; }
    const endTag = "</wiki_status>";
    const end = prompt.indexOf(endTag, start + 13);
    if (end < 0) { output += prompt.slice(cursor); break; }
    const blockEnd = end + endTag.length;
    output += prompt.slice(cursor, start) + compactBlock(prompt.slice(start, blockEnd));
    cursor = blockEnd;
  }
  return output;
}
function asRecord(value) {
  return typeof value === "object" && value !== null ? value : undefined;
}
function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function usageFrom(value) {
  const usage = asRecord(value);
  const cost = asRecord(usage?.cost);
  return { input: numberOrZero(usage?.input), output: numberOrZero(usage?.output), cacheRead: numberOrZero(usage?.cacheRead), cacheWrite: numberOrZero(usage?.cacheWrite), cost: numberOrZero(cost?.total) };
}
function addUsage(total, value) {
  const usage = usageFrom(value);
  total.input += usage.input; total.output += usage.output; total.cacheRead += usage.cacheRead; total.cacheWrite += usage.cacheWrite; total.cost += usage.cost;
}
function formatTokens(count) {
  if (count < 1000) return Math.round(count).toString();
  if (count < 10000) return (count / 1000).toFixed(1) + "k";
  if (count < 1000000) return Math.round(count / 1000) + "k";
  if (count < 10000000) return (count / 1000000).toFixed(1) + "M";
  return Math.round(count / 1000000) + "M";
}
function visibleWidth(text) {
  return [...text.replace(ANSI_ESCAPE, "")].reduce((width, character) => width + (character.codePointAt(0) > 0xffff ? 2 : 1), 0);
}
function truncateToWidth(text, width) {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  if (width <= 3) return ".".repeat(width);
  return [...text.replace(ANSI_ESCAPE, "")].slice(0, width - 3).join("") + "...";
}
function statusLines(text) { return text.split(/\r?\n/u); }
function healthyWikiStatus(status) {
  const recall = RECALL_STATUS.exec(status);
  if (recall) return recall[1];
  if (HEALTHY_WIKI_STATUS.test(status) || HEALTHY_WIKI_STATUS_LEGACY.test(status)) return "-";
  return undefined;
}
function healthyModelStatus(status) { return status === HEALTHY_MODEL_STATUS_PREFIX + WIKI_MODEL; }
function visibleWikiStatuses(statuses) {
  const lines = [];
  const wikiStatus = statuses.get("llm-wiki");
  if (wikiStatus !== undefined) {
    const count = healthyWikiStatus(wikiStatus);
    if (count !== undefined) lines.push("🧠 " + count + " · " + WIKI_MODEL);
    else lines.push(...statusLines(wikiStatus));
  }
  const modelStatus = statuses.get("llm-wiki-model");
  if (modelStatus !== undefined && !healthyModelStatus(modelStatus)) lines.push(...statusLines(modelStatus));
  for (const [key, text] of [...statuses.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (key === "llm-wiki" || key === "llm-wiki-model") continue;
    lines.push(...statusLines(text));
  }
  return lines;
}
function dim(theme, text) { return theme.fg("dim", text); }
function renderStatsLine(width, context, footerData, theme) {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let latestCacheHitRate;
  for (const entry of context.sessionManager.getEntries()) {
    const item = asRecord(entry);
    if (item?.type === "message") {
      const message = asRecord(item.message);
      if (message?.role === "assistant") {
        addUsage(total, message.usage);
        const usage = usageFrom(message.usage);
        const latestPromptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
        latestCacheHitRate = latestPromptTokens > 0 ? usage.cacheRead / latestPromptTokens * 100 : undefined;
      } else if (message?.role === "toolResult") addUsage(total, message.usage);
    } else if (item?.type === "branch_summary" || item?.type === "compaction") addUsage(total, item.usage);
  }
  const contextUsage = context.getContextUsage();
  const contextWindow = numberOrZero(contextUsage?.contextWindow ?? context.model?.contextWindow);
  const contextPercentValue = typeof contextUsage?.percent === "number" ? contextUsage.percent : 0;
  const contextPercent = contextUsage?.percent === null ? "?" : contextPercentValue.toFixed(1);
  const parts = [];
  if (total.input) parts.push("↑" + formatTokens(total.input));
  if (total.output) parts.push("↓" + formatTokens(total.output));
  if (total.cacheRead) parts.push("R" + formatTokens(total.cacheRead));
  if (total.cacheWrite) parts.push("W" + formatTokens(total.cacheWrite));
  if ((total.cacheRead > 0 || total.cacheWrite > 0) && latestCacheHitRate !== undefined) parts.push("CH" + latestCacheHitRate.toFixed(1) + "%");
  if (total.cost) parts.push("$" + total.cost.toFixed(3));
  const contextText = contextPercent === "?" ? "?/" + formatTokens(contextWindow) + " (auto)" : contextPercent + "%/" + formatTokens(contextWindow) + " (auto)";
  parts.push(contextPercentValue > 90 ? theme.fg("error", contextText) : contextPercentValue > 70 ? theme.fg("warning", contextText) : contextText);
  let left = parts.join(" ");
  const modelName = context.model?.id || "no-model";
  let rightNoProvider = modelName;
  if (context.model?.reasoning) {
    const thinking = context.thinkingLevel || "off";
    rightNoProvider = thinking === "off" ? modelName + " • thinking off" : modelName + " • " + thinking;
  }
  let right = rightNoProvider;
  if ((footerData.getAvailableProviderCount?.() ?? 0) > 1 && context.model?.provider) {
    const withProvider = "(" + context.model.provider + ") " + rightNoProvider;
    if (visibleWidth(left) + 2 + visibleWidth(withProvider) <= width) right = withProvider;
  }
  if (visibleWidth(left) > width) left = truncateToWidth(left, width);
  const available = width - visibleWidth(left) - 2;
  const rightFit = available > 0 ? truncateToWidth(right, available) : "";
  const padding = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(rightFit)));
  return dim(theme, left) + dim(theme, padding + rightFit);
}
function renderFooter(width, context, footerData, theme) {
  const cwd = context.sessionManager.getCwd?.() ?? context.cwd ?? "";
  const branch = footerData.getGitBranch?.();
  const sessionName = context.sessionManager.getSessionName?.();
  const pwd = cwd + (branch ? " (" + branch + ")" : "") + (sessionName ? " • " + sessionName : "");
  return [truncateToWidth(dim(theme, pwd), width), renderStatsLine(width, context, footerData, theme), ...visibleWikiStatuses(footerData.getExtensionStatuses())];
}
export default function squireTrustedWikiFooter(pi) {
  pi.on("before_agent_start", async (event) => {
    if (typeof event.systemPrompt !== "string") throw new Error("Pi wiki footer received a malformed system prompt");
    const systemPrompt = compactPrompt(event.systemPrompt);
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });
  let activeModel;
  let activeThinkingLevel;
  pi.on("model_select", (event, context) => {
    activeModel = event.model;
    activeThinkingLevel = context.thinkingLevel;
  });
  pi.on("thinking_level_select", (event) => { activeThinkingLevel = event.level; });
  pi.on("session_start", async (_event, context) => {
    activeModel = context.model;
    activeThinkingLevel = context.thinkingLevel;
    context.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange?.(() => tui.requestRender());
      return { invalidate() {}, ...(unsubscribe ? { dispose: unsubscribe } : {}), render(width) { return renderFooter(width, { ...context, model: activeModel, thinkingLevel: activeThinkingLevel }, footerData, theme); } };
    });
  });
}
`;
