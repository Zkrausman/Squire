import { PERSONAL_PHASES, type PersonalPhase, type PhaseResult, type PhaseStatus, type ProjectWikiDisposition } from "./types.js";
import { validatePhaseProfile } from "./model-policy.js";
const PROJECT_WIKI_PATH_PREFIX = ".llm-wiki/";
const MAX_PROJECT_WIKI_PATHS = 1000;
const MAX_PROJECT_WIKI_PATH_LENGTH = 512;
const MAX_PROJECT_WIKI_EVIDENCE_LENGTH = 2000;
export interface PhaseResultPayload { readonly version: 1; readonly outputHead: string; readonly status: PhaseStatus; readonly summary: string; readonly details: PhaseResult["details"]; }
export function validatePhaseResultPayloadShape(value: unknown, phase: PersonalPhase): asserts value is PhaseResultPayload {
  const v = exactObject(value, ["version", "outputHead", "status", "summary", "details"], "phase report");
  if (v["version"] !== 1) throw new Error("invalid phase report version");
  fields(v, phase);
}
export function validatePhaseResultShape(value: unknown, phase?: PersonalPhase): asserts value is PhaseResult {
  const v = exactObject(value, ["runId", "phase", "attempt", "sessionId", "sessionFile", "inputHead", "outputHead", "status", "summary", "details", "profile"], "phase envelope");
  if (!PERSONAL_PHASES.includes(v["phase"] as PersonalPhase) || (phase && phase !== v["phase"]) || (!Number.isInteger(v["attempt"]) || (v["attempt"] as number) < 1 || (v["attempt"] as number) > 2) || !sha(v["inputHead"]) || !nonempty(v["runId"],128) || !nonempty(v["sessionId"],128) || !nonempty(v["sessionFile"],512)) throw new Error("invalid phase envelope identity");
  validatePhaseProfile(v["profile"]);
  fields(v, v["phase"] as PersonalPhase);
}
function fields(v: Record<string, unknown>, phase: PersonalPhase): void {
  if (!sha(v["outputHead"]) || !["passed", "failed"].includes(v["status"] as string) || !nonempty(v["summary"], 2000)) throw new Error("invalid phase disposition");
  const details = v["details"] as Record<string, unknown>;
  const correction = phase === "verify" && details && typeof details === "object" && Object.prototype.hasOwnProperty.call(details,"correction");
  const d = exactObject(v["details"], phase === "implement" ? ["changes", "projectWiki"] : correction ? ["findings", "commands", "correction"] : ["findings", "commands"], "phase details");
  if (phase === "implement") { stringList(d["changes"]); validateProjectWikiDisposition(d["projectWiki"]); }
  else {
    if (correction) {
      if (v["status"] !== "failed") throw new Error("passing Verify cannot request correction");
      const recommendation = exactObject(d["correction"],["kind","reason"],"correction recommendation");
      if (!["code_only","requires_owner","security_ambiguity","unknown"].includes(recommendation["kind"] as string) || !nonempty(recommendation["reason"],2000)) throw new Error("invalid correction recommendation");
    }
    stringList(d["findings"]);
    if (!Array.isArray(d["commands"]) || d["commands"].length > 100) throw new Error("invalid command evidence");
    const seen = new Set();
    for (const item of d["commands"]) {
      const c = exactObject(item, ["command", "exitCode", "summary"], "command evidence");
      if (!nonempty(c["command"],2000) || !Number.isInteger(c["exitCode"]) || (c["exitCode"] as number) < 0 || (c["exitCode"] as number) > 255 || !nonempty(c["summary"],2000) || seen.has(c["command"])) throw new Error("invalid command evidence");
      seen.add(c["command"]);
      if (v["status"] === "passed" && c["exitCode"] !== 0) throw new Error("passing Verify contains failed command");
    }
    if (v["status"] === "passed" && (d["findings"] as string[]).length) throw new Error("passing Verify contains findings");
  }
}
export function validateVerifyCommands(result: PhaseResult, commands: readonly string[]): void {
  if (result.phase !== "verify") throw new Error("expected Verify");
  if (result.details.commands.length !== commands.length || commands.some((command, i) => result.details.commands[i]?.command !== command)) throw new Error("Verify must represent every configured command in order");
}
function stringList(v: unknown): void { if (!Array.isArray(v) || v.length > 100 || v.some(x => !nonempty(x,2000))) throw new Error("invalid bounded findings/evidence"); }
/** Validate the closed project-wiki evidence union used by Implement. */
export function validateProjectWikiDisposition(value: unknown): asserts value is ProjectWikiDisposition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("project-wiki disposition must be an object");
  const status = (value as Record<string, unknown>)["status"];
  if (status === "updated") {
    const updated = exactObject(value, ["status", "paths", "summary"], "project-wiki updated disposition");
    validateProjectWikiPaths(updated["paths"]);
    if (!singleLineEvidence(updated["summary"], "project-wiki update summary")) throw new Error("project-wiki update summary is invalid");
    return;
  }
  if (status === "not_required") {
    const notRequired = exactObject(value, ["status", "reason"], "project-wiki not-required disposition");
    if (!singleLineEvidence(notRequired["reason"], "project-wiki no-update reason")) throw new Error("project-wiki no-update reason is invalid");
    return;
  }
  throw new Error("project-wiki disposition status is invalid");
}

/** Validate canonical repository-relative paths and reject prefix/traversal confusion. */
export function validateProjectWikiPaths(value: unknown, label = "project-wiki paths"): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PROJECT_WIKI_PATHS) throw new Error(`${label} are invalid`);
  const seen = new Set<string>();
  for (const item of value) {
    if (!isCanonicalProjectWikiPath(item) || seen.has(item)) throw new Error(`${label} are invalid`);
    seen.add(item);
  }
  return value as string[];
}

export function isCanonicalProjectWikiPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PROJECT_WIKI_PATH_LENGTH) return false;
  if (!value.startsWith(PROJECT_WIKI_PATH_PREFIX) || value.includes("\\") || value.includes("`") || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || value.endsWith("/")) return false;
  const segments = value.split("/");
  return segments.length >= 2
    && segments.every(segment => segment.length > 0 && segment !== "." && segment !== "..")
    && value === segments.join("/");
}

function singleLineEvidence(value: unknown, label: string): value is string {
  if (!nonempty(value, MAX_PROJECT_WIKI_EVIDENCE_LENGTH) || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new Error(`${label} is invalid`);
  return true;
}

export class PhaseShapeError extends Error {
  readonly unexpected: readonly string[];
  readonly missing: readonly string[];
  constructor(readonly field: string, actual: readonly string[], required: readonly string[], allowed: readonly string[] = required) {
    const unexpected = actual.filter(key => !allowed.includes(key));
    const missing = required.filter(key => !actual.includes(key));
    super(`${field} fields are invalid: unexpected=${JSON.stringify(unexpected)} missing=${JSON.stringify(missing)}`);
    this.unexpected = Object.freeze(unexpected);
    this.missing = Object.freeze(missing);
  }
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) throw new PhaseShapeError(label, actual, keys);
  return object;
}

function nonempty(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function sha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
}
