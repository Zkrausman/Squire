import type { PiModelProfile } from "./pi-configuration.js";
import { wikiModelRef } from "./pi-configuration.js";

/** The routine footer emitted by the pinned pi-llm-wiki installation. */
export const ROUTINE_WIKI_STATUS_BLOCK =
  "<wiki_status>LLM Wiki active — use wiki_recall for deeper search, wiki_observe to record observations, wiki_retro to save insights.</wiki_status>";

const ROUTINE_SUFFIX =
  " — use wiki_recall for deeper search, wiki_observe to record observations, wiki_retro to save insights.";
const DIAGNOSTIC_WORDS = /(?:warning|warn|error|failed|failure|blocked|diagnostic|unavailable|conflict|denied|exception|fixed|migration|setup)/iu;
const COMPACT_BLOCK = /^<wiki_status>🧠 (\d+|-) · ([^<>\r\n]+)<\/wiki_status>$/u;
const ROUTINE_BLOCK = new RegExp(
  `^<wiki_status>LLM Wiki active(?: \\((\\d+) tools?\\))?${escapeRegExp(ROUTINE_SUFFIX)}<\\/wiki_status>$`,
  "u",
);

// These are the exact healthy activity messages currently emitted by
// @zosmaai/pi-llm-wiki. Evolved or diagnostic text must remain actionable.
const HEALTHY_WIKI_STATUS = /^🧠 LLM Wiki \((?:13 tools, observe \+ recall active|16 tools, trajectory \+ observe \+ recall active)\)$/u;
const RECALL_STATUS = /^🧠 LLM Wiki — recalled (\d+) page(?:s)? for this task$/u;
const HEALTHY_MODEL_STATUS_PREFIX = "🧠 wiki model: ";
const EMPTY_COUNT = "—";
const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -\/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|_[^\u0007]*(?:\u0007|\u001B\\))/gu;
const ANSI_RESET = "\u001b[0m";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasDiagnostic(text: string): boolean {
  return DIAGNOSTIC_WORDS.test(text);
}

function compactRoutineBlock(block: string, model: string): string | undefined {
  const compact = COMPACT_BLOCK.exec(block);
  if (compact) {
    // A compact-looking block may come from a newer extension or an
    // untrusted resource. Only our exact model/count form is routine; never
    // rewrite a diagnostic-bearing or model-mismatched block.
    if (compact[2] !== model || hasDiagnostic(block)) return undefined;
    return block;
  }
  const match = ROUTINE_BLOCK.exec(block);
  if (!match || hasDiagnostic(block)) return undefined;
  const count = match[1] ?? "-";
  return `<wiki_status>🧠 ${count} · ${model}</wiki_status>`;
}

/**
 * Replace only the exact known healthy footer grammar emitted by the trusted
 * wiki package. Unknown/evolved blocks and diagnostic-bearing blocks are
 * returned byte-for-byte unchanged. Re-running this function is safe.
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
  contextWindow?: number | null;
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
  /** Optional only for small test doubles; real Pi always supplies it. */
  isIdle?(): boolean;
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
  on(event: "agent_start" | "agent_end" | "agent_settled", handler: (event: unknown, ctx: ExtensionContextLike) => unknown): unknown;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function usageCost(value: unknown): number {
  const usage = record(value);
  const cost = record(usage?.["cost"]);
  return numberOrZero(cost?.["total"]);
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}k`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function getEstimatedCost(entries: readonly unknown[]): number {
  let total = 0;
  for (const entry of entries) {
    const item = record(entry);
    const usage = item?.["type"] === "message" ? record(item["message"])?.["usage"] : item?.["usage"];
    total += usageCost(usage);
  }
  return total;
}

function ansiAt(text: string, index: number): string | undefined {
  ANSI_ESCAPE.lastIndex = index;
  const match = ANSI_ESCAPE.exec(text);
  ANSI_ESCAPE.lastIndex = 0;
  return match?.index === index ? match[0] : undefined;
}

function nextAnsiIndex(text: string, index: number): number {
  ANSI_ESCAPE.lastIndex = index;
  const match = ANSI_ESCAPE.exec(text);
  ANSI_ESCAPE.lastIndex = 0;
  return match?.index ?? -1;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

function graphemeWidth(grapheme: string): number {
  if (grapheme === "\t") return 3;
  const codePoints = [...grapheme].map(character => character.codePointAt(0) ?? 0);
  if (codePoints.length > 0 && codePoints.every(code => code < 0x20 || code === 0x7f)) return 0;
  if (/^\p{Mark}+$/u.test(grapheme)) return 0;
  return codePoints.some(code => code > 0xffff) ? 2 : 1;
}

function graphemeSegments(text: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(text)].map(part => part.segment);
  }
  return [...text];
}

function visibleWidth(text: string): number {
  const clean = stripAnsi(text).replaceAll("\t", "   ");
  return graphemeSegments(clean).reduce((width, segment) => width + graphemeWidth(segment), 0);
}

function takeVisiblePrefix(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  let result = "";
  let width = 0;
  let index = 0;
  let pendingAnsi = "";
  while (index < text.length) {
    const ansi = ansiAt(text, index);
    if (ansi !== undefined) {
      pendingAnsi += ansi;
      index += ansi.length;
      continue;
    }
    const next = nextAnsiIndex(text, index);
    const end = next < 0 ? text.length : next;
    for (const segment of graphemeSegments(text.slice(index, end))) {
      const segmentWidth = graphemeWidth(segment);
      if (width + segmentWidth > maxWidth) return result;
      if (pendingAnsi) {
        result += pendingAnsi;
        pendingAnsi = "";
      }
      result += segment;
      width += segmentWidth;
    }
    index = end;
  }
  return result;
}

function finishTruncated(prefix: string, ellipsis: string): string {
  const prefixReset = prefix.includes("\u001b") ? ANSI_RESET : "";
  const ellipsisReset = ellipsis.includes("\u001b") ? ANSI_RESET : "";
  return `${prefix}${prefixReset}${ellipsis}${ellipsisReset}`;
}

function truncateToWidth(text: string, maxWidth: number, ellipsis = "..."): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  const ellipsisWidth = visibleWidth(ellipsis);
  if (ellipsisWidth >= maxWidth) return finishTruncated("", takeVisiblePrefix(ellipsis, maxWidth));
  return finishTruncated(takeVisiblePrefix(text, maxWidth - ellipsisWidth), ellipsis);
}

function compactWikiModel(status: string | undefined): string | undefined {
  if (!status) return undefined;
  const label = status.replace(/^🧠\s*wiki model:\s*/iu, "").trim();
  const sessionModel = label.match(/^session model \((.+)\)$/iu);
  return sessionModel ? `session:${sessionModel[1]}` : label;
}

function healthyWikiCount(status: string | undefined): string | undefined {
  if (!status) return undefined;
  const recalled = RECALL_STATUS.exec(status);
  if (recalled) return recalled[1] ?? "-";
  if (HEALTHY_WIKI_STATUS.test(status)) return EMPTY_COUNT;
  return undefined;
}

function healthyModelStatus(status: string, wikiModel: string): boolean {
  return status === `${HEALTHY_MODEL_STATUS_PREFIX}${wikiModel}`;
}

function statusLines(text: string): string[] {
  // Splitting only makes multiline diagnostics render as separate terminal
  // lines; no diagnostic text is summarized or sanitized.
  return text.split(/\r?\n/u);
}

interface VisibleWikiStatus {
  text: string | undefined;
  diagnostic: boolean;
}

function visibleWikiStatus(statuses: ReadonlyMap<string, string>, configuredModel?: string): VisibleWikiStatus {
  const activity = statuses.get("llm-wiki");
  const modelStatus = statuses.get("llm-wiki-model");
  const model = compactWikiModel(modelStatus) ?? configuredModel;
  const activityCount = healthyWikiCount(activity);
  const activityDiagnostic = activity !== undefined && activity.length > 0 && (activityCount === undefined || hasDiagnostic(activity) || /[\r\n]/u.test(activity));
  const modelDiagnostic = modelStatus !== undefined && modelStatus.length > 0 && (hasDiagnostic(modelStatus) || /[\r\n]/u.test(modelStatus));

  // Do not manufacture a wiki marker before the native extension publishes a
  // status. A configured model is only a fallback once either native key is
  // present.
  if (!activity && !modelStatus) return { text: undefined, diagnostic: false };

  if (activityDiagnostic) {
    const suffix = modelDiagnostic ? modelStatus : model;
    return {
      text: suffix ? `${activity} · ${suffix}` : activity,
      diagnostic: true,
    };
  }

  const marker = `🧠 ${activityCount ?? EMPTY_COUNT}${model ? ` · ${model}` : ""}`;
  if (modelDiagnostic) return { text: `${marker} · ${modelStatus}`, diagnostic: true };
  return { text: marker, diagnostic: false };
}

/**
 * Compact the native llm-wiki status map using the personal complementary
 * footer grammar. Healthy activity is represented as a count or em dash;
 * actionable and evolved status text is retained in full.
 */
export function compactWikiStatus(statuses: ReadonlyMap<string, string>, configuredModel?: string): string | undefined {
  return visibleWikiStatus(statuses, configuredModel).text;
}

/**
 * Preserve the line-oriented status helper for callers that inspect entries
 * directly. Normal status is one compact line; diagnostics and unrelated
 * extension statuses stay complete and line-oriented.
 */
export function compactVisibleWikiStatuses(statuses: ReadonlyMap<string, string>, wikiModel: string): string[] {
  const lines: string[] = [];
  const activity = statuses.get("llm-wiki");
  const modelStatus = statuses.get("llm-wiki-model");
  const activityCount = healthyWikiCount(activity);
  const healthyModel = modelStatus !== undefined && healthyModelStatus(modelStatus, wikiModel);

  if (activity) {
    if (activityCount !== undefined && !hasDiagnostic(activity) && !/[\r\n]/u.test(activity)) lines.push(`🧠 ${activityCount} · ${wikiModel}`);
    else lines.push(...statusLines(activity));
  } else if (modelStatus && healthyModel) {
    lines.push(`🧠 ${EMPTY_COUNT} · ${wikiModel}`);
  } else if (modelStatus) {
    lines.push(...statusLines(modelStatus));
  }

  if (modelStatus && activity && !healthyModel) lines.push(...statusLines(modelStatus));
  for (const [key, text] of [...statuses.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (key === "llm-wiki" || key === "llm-wiki-model") continue;
    lines.push(...statusLines(text));
  }
  return lines;
}

interface FooterPartsResult {
  parts: string[];
  wikiStatus: VisibleWikiStatus;
  wikiIndex: number;
}

function footerParts(
  context: CompactFooterContextLike,
  footerData: FooterDataLike,
  wikiModel: string,
  theme: FooterThemeLike,
): FooterPartsResult {
  const model = context.model?.id ?? "no-model";
  const thinking = context.model?.reasoning ? context.thinkingLevel ?? "off" : "";
  const contextUsage = context.getContextUsage();
  const contextTokens = contextUsage?.tokens;
  const contextWindow = contextUsage?.contextWindow ?? context.model?.contextWindow;
  const tokenText = contextTokens === undefined || contextTokens === null ? EMPTY_COUNT : formatTokens(contextTokens);
  const windowText = contextWindow === undefined || contextWindow === null ? EMPTY_COUNT : formatTokens(contextWindow);
  const wikiStatus = visibleWikiStatus(footerData.getExtensionStatuses(), wikiModel);
  const parts: string[] = [theme.fg("warning", model)];
  if (thinking) parts.push(theme.fg("thinkingMedium", thinking));
  const wikiIndex = parts.length;
  if (wikiStatus.text) parts.push(theme.fg("accent", wikiStatus.text));
  const idle = context.isIdle?.() ?? true;
  parts.push(theme.fg(idle ? "accent" : "warning", idle ? "Ready" : "Working"));
  parts.push(theme.fg("success", "Full Access"));
  parts.push(theme.fg("customMessageLabel", `Context ${tokenText}/${windowText}`));
  parts.push(theme.fg("text", `Session est. $${getEstimatedCost(context.sessionManager.getEntries()).toFixed(3)}`));
  return { parts, wikiStatus, wikiIndex: wikiStatus.text ? wikiIndex : -1 };
}

/** Render the personal complementary one-line footer from the control reference. */
export function renderCompactWikiFooter(
  width: number,
  context: CompactFooterContextLike,
  footerData: FooterDataLike,
  wikiModel: string,
  theme: FooterThemeLike,
): string[] {
  const { parts, wikiStatus, wikiIndex } = footerParts(context, footerData, wikiModel, theme);
  const separator = theme.fg("dim", " · ");
  const complete = parts.join(separator);

  // The normal footer is exactly one line. If a diagnostic would otherwise be
  // hidden by truncation, keep the complete diagnostic on lossless lines.
  if (wikiStatus.diagnostic && (complete.includes("\n") || visibleWidth(complete) > width)) {
    const baseParts = wikiIndex < 0 ? parts : parts.filter((_part, index) => index !== wikiIndex);
    const base = truncateToWidth(baseParts.join(separator), width, theme.fg("dim", "..."));
    return [base, ...statusLines(wikiStatus.text ?? "").map(line => theme.fg("accent", line))];
  }
  return [truncateToWidth(complete, width, theme.fg("dim", "..."))];
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
  let requestRender: () => void = () => {};
  api.on("model_select", (event, context) => {
    activeModel = event.model;
    activeThinkingLevel = context.thinkingLevel;
    requestRender();
  });
  api.on("thinking_level_select", (event) => {
    activeThinkingLevel = event.level;
    requestRender();
  });
  api.on("agent_start", () => requestRender());
  api.on("agent_end", () => requestRender());
  api.on("agent_settled", () => requestRender());
  api.on("session_start", async (_event, context) => {
    activeModel = context.model;
    activeThinkingLevel = context.thinkingLevel;
    context.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange?.(requestRender);
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
 * Pi can load the trusted file from a run directory without resolving through
 * the target repository. The generated renderer mirrors the typed implementation
 * and the personal complementary footer reference.
 */
export function buildTrustedWikiFooterExtensionSource(profile: PiModelProfile): string {
  const model = wikiModelRef(profile);
  return GENERATED_EXTENSION_SOURCE.replace("__SQUIRE_WIKI_MODEL__", JSON.stringify(model));
}

const GENERATED_EXTENSION_SOURCE = String.raw`// Squire trusted wiki footer; do not edit.
const WIKI_MODEL = __SQUIRE_WIKI_MODEL__;
const ROUTINE_SUFFIX = " — use wiki_recall for deeper search, wiki_observe to record observations, wiki_retro to save insights.";
const DIAGNOSTIC_WORDS = ["warning", "warn", "error", "failed", "failure", "blocked", "diagnostic", "unavailable", "conflict", "denied", "exception", "fixed", "migration", "setup"];
const EMPTY_COUNT = "—";
const COMPACT_BLOCK = /^<wiki_status>🧠 (\d+|-) · ([^<>\r\n]+)<\/wiki_status>$/u;
const CLOSE_TAG = "</wiki_status>";
const HEALTHY_WIKI_STATUS = /^🧠 LLM Wiki \((?:13 tools, observe \+ recall active|16 tools, trajectory \+ observe \+ recall active)\)$/u;
const RECALL_STATUS = /^🧠 LLM Wiki — recalled (\d+) page(?:s)? for this task$/u;
const HEALTHY_MODEL_STATUS_PREFIX = "🧠 wiki model: ";
const ANSI_ESCAPE = /\u001B(?:\[[0-?]*[ -\/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|_[^\u0007]*(?:\u0007|\u001B\\))/gu;
const ANSI_RESET = "\u001b[0m";
function hasDiagnostic(text) {
  const lower = text.toLowerCase();
  return DIAGNOSTIC_WORDS.some(word => lower.includes(word));
}
function isCount(value) {
  if (value === "-") return true;
  if (!value) return false;
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code === undefined || code < 48 || code > 57) return false;
  }
  return true;
}
function compactRoutineBlock(block) {
  const compact = COMPACT_BLOCK.exec(block);
  if (compact) {
    if (compact[2] !== WIKI_MODEL || hasDiagnostic(block)) return undefined;
    return block;
  }
  if (!block.startsWith("<wiki_status>") || !block.endsWith(CLOSE_TAG)) return undefined;
  const body = block.slice("<wiki_status>".length, -CLOSE_TAG.length);
  const plain = "LLM Wiki active" + ROUTINE_SUFFIX;
  if (body === plain && !hasDiagnostic(body)) return "<wiki_status>🧠 - · " + WIKI_MODEL + CLOSE_TAG;
  const countStart = "LLM Wiki active (";
  if (!body.startsWith(countStart) || hasDiagnostic(body)) return undefined;
  for (const suffix of [") tools" + ROUTINE_SUFFIX, ") tool" + ROUTINE_SUFFIX]) {
    if (!body.endsWith(suffix)) continue;
    const count = body.slice(countStart.length, body.length - suffix.length);
    if (isCount(count) && count !== "-") return "<wiki_status>🧠 " + count + " · " + WIKI_MODEL + CLOSE_TAG;
  }
  return undefined;
}
function compactPrompt(prompt) {
  if (!prompt.includes("<wiki_status>")) return prompt;
  let output = "";
  let cursor = 0;
  while (cursor < prompt.length) {
    const start = prompt.indexOf("<wiki_status>", cursor);
    if (start < 0) { output += prompt.slice(cursor); break; }
    const end = prompt.indexOf(CLOSE_TAG, start + "<wiki_status>".length);
    if (end < 0) { output += prompt.slice(cursor); break; }
    const blockEnd = end + CLOSE_TAG.length;
    const block = prompt.slice(start, blockEnd);
    output += prompt.slice(cursor, start) + (compactRoutineBlock(block) ?? block);
    cursor = blockEnd;
  }
  return output;
}
function ansiAt(text, index) {
  ANSI_ESCAPE.lastIndex = index;
  const match = ANSI_ESCAPE.exec(text);
  ANSI_ESCAPE.lastIndex = 0;
  return match?.index === index ? match[0] : undefined;
}
function nextAnsiIndex(text, index) {
  ANSI_ESCAPE.lastIndex = index;
  const match = ANSI_ESCAPE.exec(text);
  ANSI_ESCAPE.lastIndex = 0;
  return match?.index ?? -1;
}
function stripAnsi(text) { return text.replace(ANSI_ESCAPE, ""); }
function graphemeWidth(grapheme) {
  if (grapheme === "\t") return 3;
  const codePoints = [...grapheme].map(character => character.codePointAt(0) ?? 0);
  if (codePoints.length > 0 && codePoints.every(code => code < 32 || code === 127)) return 0;
  if (/^\p{Mark}+$/u.test(grapheme)) return 0;
  return codePoints.some(code => code > 65535) ? 2 : 1;
}
function graphemeSegments(text) {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(text)].map(part => part.segment);
  }
  return [...text];
}
function visibleWidth(text) {
  const clean = stripAnsi(text).replaceAll("\t", "   ");
  return graphemeSegments(clean).reduce((width, segment) => width + graphemeWidth(segment), 0);
}
function takeVisiblePrefix(text, maxWidth) {
  if (maxWidth <= 0) return "";
  let result = "";
  let width = 0;
  let index = 0;
  let pendingAnsi = "";
  while (index < text.length) {
    const ansi = ansiAt(text, index);
    if (ansi !== undefined) { pendingAnsi += ansi; index += ansi.length; continue; }
    const next = nextAnsiIndex(text, index);
    const end = next < 0 ? text.length : next;
    for (const segment of graphemeSegments(text.slice(index, end))) {
      const segmentWidth = graphemeWidth(segment);
      if (width + segmentWidth > maxWidth) return result;
      if (pendingAnsi) { result += pendingAnsi; pendingAnsi = ""; }
      result += segment;
      width += segmentWidth;
    }
    index = end;
  }
  return result;
}
function finishTruncated(prefix, ellipsis) {
  const prefixReset = prefix.includes("\u001b") ? ANSI_RESET : "";
  const ellipsisReset = ellipsis.includes("\u001b") ? ANSI_RESET : "";
  return prefix + prefixReset + ellipsis + ellipsisReset;
}
function truncateToWidth(text, maxWidth, ellipsis) {
  ellipsis = ellipsis ?? "...";
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  const ellipsisWidth = visibleWidth(ellipsis);
  if (ellipsisWidth >= maxWidth) return finishTruncated("", takeVisiblePrefix(ellipsis, maxWidth));
  return finishTruncated(takeVisiblePrefix(text, maxWidth - ellipsisWidth), ellipsis);
}
function asRecord(value) { return typeof value === "object" && value !== null ? value : undefined; }
function numberOrZero(value) { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function usageCost(value) { const usage = asRecord(value); const cost = asRecord(usage?.cost); return numberOrZero(cost?.total); }
function formatTokens(tokens) {
  if (tokens < 1000) return String(tokens);
  if (tokens < 10000) return (tokens / 1000).toFixed(1) + "k";
  if (tokens < 1000000) return Math.round(tokens / 1000) + "k";
  return (tokens / 1000000).toFixed(1) + "M";
}
function estimatedCost(entries) {
  let total = 0;
  for (const entry of entries) {
    const item = asRecord(entry);
    const usage = item?.type === "message" ? asRecord(item.message)?.usage : item?.usage;
    total += usageCost(usage);
  }
  return total;
}
function compactWikiModel(status) {
  if (!status) return undefined;
  const label = status.replace(/^🧠\s*wiki model:\s*/iu, "").trim();
  const sessionModel = label.match(/^session model \((.+)\)$/iu);
  return sessionModel ? "session:" + sessionModel[1] : label;
}
function healthyWikiCount(status) {
  if (!status) return undefined;
  const recalled = RECALL_STATUS.exec(status);
  if (recalled) return recalled[1] ?? "-";
  if (HEALTHY_WIKI_STATUS.test(status)) return EMPTY_COUNT;
  return undefined;
}
function visibleWikiStatus(statuses) {
  const activity = statuses.get("llm-wiki");
  const modelStatus = statuses.get("llm-wiki-model");
  const model = compactWikiModel(modelStatus) ?? WIKI_MODEL;
  const activityCount = healthyWikiCount(activity);
  const activityDiagnostic = activity !== undefined && activity.length > 0 && (activityCount === undefined || hasDiagnostic(activity) || /[\r\n]/u.test(activity));
  const modelDiagnostic = modelStatus !== undefined && modelStatus.length > 0 && (hasDiagnostic(modelStatus) || /[\r\n]/u.test(modelStatus));
  if (!activity && !modelStatus) return { text: undefined, diagnostic: false };
  if (activityDiagnostic) {
    const suffix = modelDiagnostic ? modelStatus : model;
    return { text: suffix ? activity + " · " + suffix : activity, diagnostic: true };
  }
  const marker = "🧠 " + (activityCount ?? EMPTY_COUNT) + (model ? " · " + model : "");
  if (modelDiagnostic) return { text: marker + " · " + modelStatus, diagnostic: true };
  return { text: marker, diagnostic: false };
}
function footerParts(context, footerData, theme) {
  const model = context.model?.id ?? "no-model";
  const thinking = context.model?.reasoning ? context.thinkingLevel ?? "off" : "";
  const contextUsage = context.getContextUsage();
  const contextTokens = contextUsage?.tokens;
  const contextWindow = contextUsage?.contextWindow ?? context.model?.contextWindow;
  const tokenText = contextTokens === undefined || contextTokens === null ? EMPTY_COUNT : formatTokens(contextTokens);
  const windowText = contextWindow === undefined || contextWindow === null ? EMPTY_COUNT : formatTokens(contextWindow);
  const wikiStatus = visibleWikiStatus(footerData.getExtensionStatuses());
  const separator = theme.fg("dim", " · ");
  const parts = [theme.fg("warning", model)];
  if (thinking) parts.push(theme.fg("thinkingMedium", thinking));
  const wikiIndex = parts.length;
  if (wikiStatus.text) parts.push(theme.fg("accent", wikiStatus.text));
  const idle = context.isIdle?.() ?? true;
  parts.push(theme.fg(idle ? "accent" : "warning", idle ? "Ready" : "Working"));
  parts.push(theme.fg("success", "Full Access"));
  parts.push(theme.fg("customMessageLabel", "Context " + tokenText + "/" + windowText));
  parts.push(theme.fg("text", "Session est. $" + estimatedCost(context.sessionManager.getEntries()).toFixed(3)));
  return { parts, wikiStatus, wikiIndex: wikiStatus.text ? wikiIndex : -1, separator };
}
function renderFooter(width, context, footerData, theme) {
  const data = footerParts(context, footerData, theme);
  const separator = data.separator;
  const complete = data.parts.join(separator);
  if (data.wikiStatus.diagnostic && (complete.includes("\n") || visibleWidth(complete) > width)) {
    const baseParts = data.wikiIndex < 0 ? data.parts : data.parts.filter((_part, index) => index !== data.wikiIndex);
    return [truncateToWidth(baseParts.join(separator), width, theme.fg("dim", "...")), ...(data.wikiStatus.text ?? "").split(/\r?\n/u).map(line => theme.fg("accent", line))];
  }
  return [truncateToWidth(complete, width, theme.fg("dim", "..."))];
}
export default function squireTrustedWikiFooter(pi) {
  pi.on("before_agent_start", async event => {
    if (typeof event.systemPrompt !== "string") throw new Error("Pi wiki footer received a malformed system prompt");
    const systemPrompt = compactPrompt(event.systemPrompt);
    return systemPrompt === event.systemPrompt ? undefined : { systemPrompt };
  });
  let activeModel;
  let activeThinkingLevel;
  let requestRender = () => {};
  pi.on("model_select", (event, context) => { activeModel = event.model; activeThinkingLevel = context?.thinkingLevel; requestRender(); });
  pi.on("thinking_level_select", event => { activeThinkingLevel = event.level; requestRender(); });
  pi.on("agent_start", () => requestRender());
  pi.on("agent_end", () => requestRender());
  pi.on("agent_settled", () => requestRender());
  pi.on("session_start", async (_event, context) => {
    activeModel = context.model;
    activeThinkingLevel = context.thinkingLevel;
    context.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange?.(requestRender);
      return {
        invalidate() {},
        ...(unsubscribe ? { dispose: unsubscribe } : {}),
        render(width) {
          const renderContext = { ...context, ...(activeModel === undefined ? {} : { model: activeModel }), ...(activeThinkingLevel === undefined ? {} : { thinkingLevel: activeThinkingLevel }) };
          return renderFooter(width, renderContext, footerData, theme);
        },
      };
    });
  });
}
`;
