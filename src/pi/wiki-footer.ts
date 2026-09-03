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

// These are the pinned pi-tui/get-east-asian-width tables used by the
// terminal-column implementation. Keeping the tables here makes the typed
// renderer and its import-free generated companion safe to run without
// resolving dependencies through the target repository.
const EAST_ASIAN_FULLWIDTH_RANGES: readonly number[] = [
  12288, 12288, 65281, 65376, 65504, 65510,
];
const EAST_ASIAN_WIDE_RANGES: readonly number[] = [
  4352, 4447, 8986, 8987, 9001, 9002, 9193, 9196, 9200, 9200, 9203, 9203,
  9725, 9726, 9748, 9749, 9776, 9783, 9800, 9811, 9855, 9855, 9866, 9871,
  9875, 9875, 9889, 9889, 9898, 9899, 9917, 9918, 9924, 9925, 9934, 9934,
  9940, 9940, 9962, 9962, 9970, 9971, 9973, 9973, 9978, 9978, 9981, 9981,
  9989, 9989, 9994, 9995, 10024, 10024, 10060, 10060, 10062, 10062,
  10067, 10069, 10071, 10071, 10133, 10135, 10160, 10160, 10175, 10175,
  11035, 11036, 11088, 11088, 11093, 11093, 11904, 11929, 11931, 12019,
  12032, 12245, 12272, 12287, 12289, 12350, 12353, 12438, 12441, 12543,
  12549, 12591, 12593, 12686, 12688, 12773, 12783, 12830, 12832, 12871,
  12880, 42124, 42128, 42182, 43360, 43388, 44032, 55203, 63744, 64255,
  65040, 65049, 65072, 65106, 65108, 65126, 65128, 65131, 94176, 94180,
  94192, 94198, 94208, 101589, 101631, 101662, 101760, 101874, 110576,
  110579, 110581, 110587, 110589, 110590, 110592, 110882, 110898, 110898,
  110928, 110930, 110933, 110933, 110948, 110951, 110960, 111355, 119552,
  119638, 119648, 119670, 126980, 126980, 127183, 127183, 127374, 127374,
  127377, 127386, 127488, 127490, 127504, 127547, 127552, 127560, 127568,
  127569, 127584, 127589, 127744, 127776, 127789, 127797, 127799, 127868,
  127870, 127891, 127904, 127946, 127951, 127955, 127968, 127984, 127988,
  127988, 127992, 128062, 128064, 128064, 128066, 128252, 128255, 128317,
  128331, 128334, 128336, 128359, 128378, 128378, 128405, 128406, 128420,
  128420, 128507, 128591, 128640, 128709, 128716, 128716, 128720, 128722,
  128725, 128728, 128732, 128735, 128747, 128748, 128756, 128764, 128992,
  129003, 129008, 129008, 129292, 129338, 129340, 129349, 129351, 129535,
  129648, 129660, 129664, 129674, 129678, 129734, 129736, 129736, 129741,
  129756, 129759, 129770, 129775, 129784, 131072, 196605, 196608, 262141,
];

function isInEastAsianRange(ranges: readonly number[], codePoint: number): boolean {
  let low = 0;
  let high = Math.floor(ranges.length / 2) - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const index = middle * 2;
    const start = ranges[index]!;
    const end = ranges[index + 1]!;
    if (codePoint < start) high = middle - 1;
    else if (codePoint > end) low = middle + 1;
    else return true;
  }
  return false;
}

function eastAsianWidth(codePoint: number): 1 | 2 {
  return isInEastAsianRange(EAST_ASIAN_FULLWIDTH_RANGES, codePoint)
    || isInEastAsianRange(EAST_ASIAN_WIDE_RANGES, codePoint) ? 2 : 1;
}

const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
const CONTROL = /^\p{Control}$/u;
const FORMAT = /^\p{Format}$/u;
const MARK = /^\p{Mark}$/u;
const SPACING_MARK = /^\p{Spacing_Mark}$/u;
const EXTENDED_PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const RGI_EMOJI = createUnicodePropertyRegex("^\\p{RGI_Emoji}$", "v");

function createUnicodePropertyRegex(source: string, flags: string): RegExp | undefined {
  try { return new RegExp(source, flags); }
  catch { return undefined; }
}

function isSurrogate(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint >= 0xd800 && codePoint <= 0xdfff;
}

function isZeroWidthCharacter(character: string): boolean {
  return DEFAULT_IGNORABLE.test(character) || CONTROL.test(character) || MARK.test(character) || isSurrogate(character);
}

function isNonPrintingCharacter(character: string): boolean {
  return DEFAULT_IGNORABLE.test(character) || CONTROL.test(character) || FORMAT.test(character) || MARK.test(character) || isSurrogate(character);
}

function isTerminalSpacingMarkCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  const excluded = codePoint === 0x1734 || codePoint === 0x302e || codePoint === 0x302f;
  const legacy = codePoint === 0x065f || codePoint === 0x0f7f || codePoint === 0x102b || codePoint === 0x102c
    || codePoint === 0x1031 || (codePoint >= 0x1033 && codePoint <= 0x1035) || codePoint === 0x1038
    || (codePoint >= 0x103a && codePoint <= 0x103e);
  return (!excluded && SPACING_MARK.test(character)) || legacy;
}

function isTerminalSpacingMark(segment: string): boolean {
  const characters = [...segment];
  return characters.length > 0 && characters.every(isTerminalSpacingMarkCharacter);
}

function isMarkCharacter(character: string): boolean {
  return MARK.test(character);
}

function couldBeEmoji(segment: string): boolean {
  const codePoint = segment.codePointAt(0);
  return (codePoint !== undefined && codePoint >= 0x1f000 && codePoint <= 0x1fbff)
    || (codePoint !== undefined && codePoint >= 0x2300 && codePoint <= 0x23ff)
    || (codePoint !== undefined && codePoint >= 0x2600 && codePoint <= 0x27bf)
    || (codePoint !== undefined && codePoint >= 0x2b50 && codePoint <= 0x2b55)
    || segment.includes("\uFE0F")
    || segment.length > 2;
}

function isRgiEmoji(segment: string): boolean {
  if (RGI_EMOJI?.test(segment)) return true;
  // Node versions without Unicode set properties still get conservative
  // emoji handling for the sequences used by terminal footers.
  const characters = [...segment];
  const first = characters[0]?.codePointAt(0) ?? 0;
  const second = characters[1]?.codePointAt(0) ?? 0;
  const regional = (codePoint: number): boolean => codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
  if (characters.length === 2 && regional(first) && regional(second)) return true;
  if (segment.endsWith("\u20E3") && (segment.includes("\uFE0F") || /^[#*0-9]/u.test(segment))) return true;
  return segment.includes("\uFE0F") && characters.some(character => EXTENDED_PICTOGRAPHIC.test(character));
}

function graphemeWidth(grapheme: string): number {
  if (grapheme === "\t") return 3;
  if (isTerminalSpacingMark(grapheme)) return [...grapheme].length;
  if ([...grapheme].length > 0 && [...grapheme].every(isZeroWidthCharacter)) return 0;
  if (couldBeEmoji(grapheme) && isRgiEmoji(grapheme)) return 2;

  let base = "";
  let baseStart = 0;
  for (const character of grapheme) {
    if (!isNonPrintingCharacter(character)) break;
    baseStart += character.length;
  }
  base = grapheme.slice(baseStart);
  const codePoint = base.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) return 2;

  let width = eastAsianWidth(codePoint);
  let followsMark = false;
  const characters = [...base];
  for (const character of characters.slice(1)) {
    if (isTerminalSpacingMarkCharacter(character)) {
      width += 1;
      followsMark = false;
    } else if (isMarkCharacter(character)) {
      followsMark = true;
    } else if (!isNonPrintingCharacter(character)) {
      const trailingCodePoint = character.codePointAt(0) ?? 0;
      if (followsMark || (trailingCodePoint >= 0xff00 && trailingCodePoint <= 0xffef)) {
        width += eastAsianWidth(trailingCodePoint);
      } else if (trailingCodePoint === 0x0e33 || trailingCodePoint === 0x0eb3) {
        width += 1;
      }
      followsMark = false;
    }
  }
  return width;
}

function graphemeSegments(text: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(text)].map(part => part.segment);
  }
  return [...text];
}

interface AnsiCode {
  code: string;
  length: number;
}

/** Match the same CSI/OSC/APC sequences that pi-tui consumes while clipping. */
function extractAnsiCode(text: string, position: number): AnsiCode | undefined {
  if (position >= text.length || text[position] !== "\u001b") return undefined;
  const next = text[position + 1];
  if (next === "[") {
    let end = position + 2;
    while (end < text.length && !/[mGKHJ]/u.test(text[end]!)) end += 1;
    if (end < text.length) return { code: text.substring(position, end + 1), length: end + 1 - position };
    return undefined;
  }
  if (next === "]" || next === "_") {
    let end = position + 2;
    while (end < text.length) {
      if (text[end] === "\u0007") return { code: text.substring(position, end + 1), length: end + 1 - position };
      if (text[end] === "\u001b" && text[end + 1] === "\\") return { code: text.substring(position, end + 2), length: end + 2 - position };
      end += 1;
    }
  }
  return undefined;
}

function stripAnsi(text: string): string {
  if (!text.includes("\u001b")) return text;
  let result = "";
  let index = 0;
  while (index < text.length) {
    const ansi = extractAnsiCode(text, index);
    if (ansi) {
      index += ansi.length;
      continue;
    }
    result += text[index];
    index += 1;
  }
  return result;
}

function visibleWidth(text: string): number {
  const clean = stripAnsi(text.replaceAll("\t", "   "));
  return graphemeSegments(clean).reduce((width, segment) => width + graphemeWidth(segment), 0);
}

function takeVisiblePrefix(text: string, maxWidth: number): string {
  if (maxWidth <= 0 || text.length === 0) return "";
  let result = "";
  let width = 0;
  let index = 0;
  let pendingAnsi = "";
  while (index < text.length) {
    const ansi = extractAnsiCode(text, index);
    if (ansi) {
      pendingAnsi += ansi.code;
      index += ansi.length;
      continue;
    }
    if (text[index] === "\t") {
      if (width + 3 > maxWidth) break;
      if (pendingAnsi) {
        result += pendingAnsi;
        pendingAnsi = "";
      }
      result += "\t";
      width += 3;
      index += 1;
      continue;
    }
    let end = index;
    while (end < text.length && text[end] !== "\t") {
      if (extractAnsiCode(text, end)) break;
      end += 1;
    }
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
const ANSI_RESET = "\u001b[0m";
const EAST_ASIAN_FULLWIDTH_RANGES = [12288, 12288, 65281, 65376, 65504, 65510];
const EAST_ASIAN_WIDE_RANGES = [
  4352, 4447, 8986, 8987, 9001, 9002, 9193, 9196, 9200, 9200, 9203, 9203,
  9725, 9726, 9748, 9749, 9776, 9783, 9800, 9811, 9855, 9855, 9866, 9871,
  9875, 9875, 9889, 9889, 9898, 9899, 9917, 9918, 9924, 9925, 9934, 9934,
  9940, 9940, 9962, 9962, 9970, 9971, 9973, 9973, 9978, 9978, 9981, 9981,
  9989, 9989, 9994, 9995, 10024, 10024, 10060, 10060, 10062, 10062,
  10067, 10069, 10071, 10071, 10133, 10135, 10160, 10160, 10175, 10175,
  11035, 11036, 11088, 11088, 11093, 11093, 11904, 11929, 11931, 12019,
  12032, 12245, 12272, 12287, 12289, 12350, 12353, 12438, 12441, 12543,
  12549, 12591, 12593, 12686, 12688, 12773, 12783, 12830, 12832, 12871,
  12880, 42124, 42128, 42182, 43360, 43388, 44032, 55203, 63744, 64255,
  65040, 65049, 65072, 65106, 65108, 65126, 65128, 65131, 94176, 94180,
  94192, 94198, 94208, 101589, 101631, 101662, 101760, 101874, 110576,
  110579, 110581, 110587, 110589, 110590, 110592, 110882, 110898, 110898,
  110928, 110930, 110933, 110933, 110948, 110951, 110960, 111355, 119552,
  119638, 119648, 119670, 126980, 126980, 127183, 127183, 127374, 127374,
  127377, 127386, 127488, 127490, 127504, 127547, 127552, 127560, 127568,
  127569, 127584, 127589, 127744, 127776, 127789, 127797, 127799, 127868,
  127870, 127891, 127904, 127946, 127951, 127955, 127968, 127984, 127988,
  127988, 127992, 128062, 128064, 128064, 128066, 128252, 128255, 128317,
  128331, 128334, 128336, 128359, 128378, 128378, 128405, 128406, 128420,
  128420, 128507, 128591, 128640, 128709, 128716, 128716, 128720, 128722,
  128725, 128728, 128732, 128735, 128747, 128748, 128756, 128764, 128992,
  129003, 129008, 129008, 129292, 129338, 129340, 129349, 129351, 129535,
  129648, 129660, 129664, 129674, 129678, 129734, 129736, 129736, 129741,
  129756, 129759, 129770, 129775, 129784, 131072, 196605, 196608, 262141,
];
function isInEastAsianRange(ranges, codePoint) {
  let low = 0;
  let high = Math.floor(ranges.length / 2) - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const index = middle * 2;
    const start = ranges[index];
    const end = ranges[index + 1];
    if (codePoint < start) high = middle - 1;
    else if (codePoint > end) low = middle + 1;
    else return true;
  }
  return false;
}
function eastAsianWidth(codePoint) {
  return isInEastAsianRange(EAST_ASIAN_FULLWIDTH_RANGES, codePoint) || isInEastAsianRange(EAST_ASIAN_WIDE_RANGES, codePoint) ? 2 : 1;
}
const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
const CONTROL = /^\p{Control}$/u;
const FORMAT = /^\p{Format}$/u;
const MARK = /^\p{Mark}$/u;
const SPACING_MARK = /^\p{Spacing_Mark}$/u;
const EXTENDED_PICTOGRAPHIC = /^\p{Extended_Pictographic}$/u;
const RGI_EMOJI = createUnicodePropertyRegex("^\\p{RGI_Emoji}$", "v");
function createUnicodePropertyRegex(source, flags) {
  try { return new RegExp(source, flags); } catch { return undefined; }
}
function isSurrogate(character) {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint >= 0xd800 && codePoint <= 0xdfff;
}
function isZeroWidthCharacter(character) {
  return DEFAULT_IGNORABLE.test(character) || CONTROL.test(character) || MARK.test(character) || isSurrogate(character);
}
function isNonPrintingCharacter(character) {
  return DEFAULT_IGNORABLE.test(character) || CONTROL.test(character) || FORMAT.test(character) || MARK.test(character) || isSurrogate(character);
}
function isTerminalSpacingMarkCharacter(character) {
  const codePoint = character.codePointAt(0) ?? 0;
  const excluded = codePoint === 0x1734 || codePoint === 0x302e || codePoint === 0x302f;
  const legacy = codePoint === 0x065f || codePoint === 0x0f7f || codePoint === 0x102b || codePoint === 0x102c
    || codePoint === 0x1031 || (codePoint >= 0x1033 && codePoint <= 0x1035) || codePoint === 0x1038
    || (codePoint >= 0x103a && codePoint <= 0x103e);
  return (!excluded && SPACING_MARK.test(character)) || legacy;
}
function isTerminalSpacingMark(segment) {
  const characters = [...segment];
  return characters.length > 0 && characters.every(isTerminalSpacingMarkCharacter);
}
function couldBeEmoji(segment) {
  const codePoint = segment.codePointAt(0);
  return (codePoint !== undefined && codePoint >= 0x1f000 && codePoint <= 0x1fbff)
    || (codePoint !== undefined && codePoint >= 0x2300 && codePoint <= 0x23ff)
    || (codePoint !== undefined && codePoint >= 0x2600 && codePoint <= 0x27bf)
    || (codePoint !== undefined && codePoint >= 0x2b50 && codePoint <= 0x2b55)
    || segment.includes("\uFE0F")
    || segment.length > 2;
}
function isRgiEmoji(segment) {
  if (RGI_EMOJI?.test(segment)) return true;
  const characters = [...segment];
  const first = characters[0]?.codePointAt(0) ?? 0;
  const second = characters[1]?.codePointAt(0) ?? 0;
  const regional = codePoint => codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
  if (characters.length === 2 && regional(first) && regional(second)) return true;
  if (segment.endsWith("\u20E3") && (segment.includes("\uFE0F") || /^[#*0-9]/u.test(segment))) return true;
  return segment.includes("\uFE0F") && characters.some(character => EXTENDED_PICTOGRAPHIC.test(character));
}
function graphemeWidth(grapheme) {
  if (grapheme === "\t") return 3;
  if (isTerminalSpacingMark(grapheme)) return [...grapheme].length;
  if ([...grapheme].length > 0 && [...grapheme].every(isZeroWidthCharacter)) return 0;
  if (couldBeEmoji(grapheme) && isRgiEmoji(grapheme)) return 2;
  let baseStart = 0;
  for (const character of grapheme) {
    if (!isNonPrintingCharacter(character)) break;
    baseStart += character.length;
  }
  const base = grapheme.slice(baseStart);
  const codePoint = base.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) return 2;
  let width = eastAsianWidth(codePoint);
  let followsMark = false;
  const characters = [...base];
  for (const character of characters.slice(1)) {
    if (isTerminalSpacingMarkCharacter(character)) {
      width += 1;
      followsMark = false;
    } else if (/^\p{Mark}$/u.test(character)) {
      followsMark = true;
    } else if (!isNonPrintingCharacter(character)) {
      const trailingCodePoint = character.codePointAt(0) ?? 0;
      if (followsMark || (trailingCodePoint >= 0xff00 && trailingCodePoint <= 0xffef)) width += eastAsianWidth(trailingCodePoint);
      else if (trailingCodePoint === 0x0e33 || trailingCodePoint === 0x0eb3) width += 1;
      followsMark = false;
    }
  }
  return width;
}
function graphemeSegments(text) {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(text)].map(part => part.segment);
  }
  return [...text];
}
function extractAnsiCode(text, position) {
  if (position >= text.length || text[position] !== "\u001b") return undefined;
  const next = text[position + 1];
  if (next === "[") {
    let end = position + 2;
    while (end < text.length && !/[mGKHJ]/u.test(text[end])) end += 1;
    if (end < text.length) return { code: text.substring(position, end + 1), length: end + 1 - position };
    return undefined;
  }
  if (next === "]" || next === "_") {
    let end = position + 2;
    while (end < text.length) {
      if (text[end] === "\u0007") return { code: text.substring(position, end + 1), length: end + 1 - position };
      if (text[end] === "\u001b" && text[end + 1] === "\\") return { code: text.substring(position, end + 2), length: end + 2 - position };
      end += 1;
    }
  }
  return undefined;
}
function stripAnsi(text) {
  if (!text.includes("\u001b")) return text;
  let result = "";
  let index = 0;
  while (index < text.length) {
    const ansi = extractAnsiCode(text, index);
    if (ansi) { index += ansi.length; continue; }
    result += text[index];
    index += 1;
  }
  return result;
}
function visibleWidth(text) {
  const clean = stripAnsi(text.replaceAll("\t", "   "));
  return graphemeSegments(clean).reduce((width, segment) => width + graphemeWidth(segment), 0);
}
function takeVisiblePrefix(text, maxWidth) {
  if (maxWidth <= 0 || text.length === 0) return "";
  let result = "";
  let width = 0;
  let index = 0;
  let pendingAnsi = "";
  while (index < text.length) {
    const ansi = extractAnsiCode(text, index);
    if (ansi) { pendingAnsi += ansi.code; index += ansi.length; continue; }
    if (text[index] === "\t") {
      if (width + 3 > maxWidth) break;
      if (pendingAnsi) { result += pendingAnsi; pendingAnsi = ""; }
      result += "\t";
      width += 3;
      index += 1;
      continue;
    }
    let end = index;
    while (end < text.length && text[end] !== "\t") {
      if (extractAnsiCode(text, end)) break;
      end += 1;
    }
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
