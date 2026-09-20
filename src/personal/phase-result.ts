import { validatePlanEvidence } from "./plan-artifacts.js";
import { PERSONAL_PHASES, type PersonalPhase, type PhaseResult, type PhaseStatus, type ProjectWikiDisposition, type TestCommandEvidence } from "./types.js";
import { validatePhaseProfile, type PhaseProfile } from "./model-policy.js";

const RESULT_KEYS = ["runId", "phase", "attempt", "sessionId", "sessionFile", "inputHead", "outputHead", "status", "summary", "details"] as const;
const PAYLOAD_KEYS = ["outputHead", "status", "summary", "details"] as const;
const TRUSTED_ECHO_KEYS = ["runId", "phase", "attempt", "sessionId", "sessionFile", "inputHead", "profile"] as const;
const STATUSES = ["passed", "remediation_required", "failed"] as const;
const PROJECT_WIKI_PATH_PREFIX = ".llm-wiki/";
const MAX_PROJECT_WIKI_PATHS = 1_000;
const MAX_PROJECT_WIKI_PATH_LENGTH = 512;
const MAX_PROJECT_WIKI_EVIDENCE_LENGTH = 2_000;

/** Pi-supplied fields plus optional compatibility echoes of adapter-owned fields. */
export interface PhaseResultPayload {
  readonly outputHead: string;
  readonly status: PhaseStatus;
  readonly summary: string;
  readonly details: PhaseResult["details"];
  readonly runId?: string;
  readonly phase?: PersonalPhase;
  readonly attempt?: number;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly inputHead?: string;
  readonly profile?: PhaseProfile;
}

export interface PhaseResultValidationOptions {
  /** Published v1 state files may contain an older Implement result. */
  readonly allowLegacyImplementProjectWiki?: boolean;
}

export function validatePhaseResultShape(value: unknown, expectedPhase?: PersonalPhase, options: PhaseResultValidationOptions = {}): asserts value is PhaseResult {
  const result = optionalProfileObject(value, "phase result");
  const phase = result["phase"];
  if (typeof phase !== "string" || !PERSONAL_PHASES.includes(phase as PersonalPhase) || (expectedPhase !== undefined && phase !== expectedPhase)) throw new Error("phase result phase is invalid");
  if (!nonempty(result["runId"], 128) || !Number.isInteger(result["attempt"]) || (result["attempt"] as number) < 1) throw new Error("phase result identity is invalid");
  if (!nonempty(result["sessionId"], 128) || !nonempty(result["sessionFile"], 512)) throw new Error("phase result session identity is invalid");
  if (!sha(result["inputHead"])) throw new Error("phase result Git identity is invalid");
  validateUntrustedResultFields(result, phase as PersonalPhase, options);
  if (result["profile"] !== undefined) validatePhaseProfile(result["profile"], `${phase} result profile`);
}

/** Validate only model-owned output while allowing exact trusted-envelope echoes. */
export function validatePhaseResultPayloadShape(value: unknown, expectedPhase: PersonalPhase): asserts value is PhaseResultPayload {
  const result = requiredWithOptionalObject(value, PAYLOAD_KEYS, TRUSTED_ECHO_KEYS, "phase result payload");
  // Nested supervision is deterministic evidence, never model-owned output.
  if (expectedPhase === "plan") exactObject(result["details"], ["steps"], "legacy Plan payload details");
  validateUntrustedResultFields(result, expectedPhase);
  if (result["profile"] !== undefined) validatePhaseProfile(result["profile"], `${expectedPhase} result profile`);
}

function validateUntrustedResultFields(result: Record<string, unknown>, phase: PersonalPhase, options: PhaseResultValidationOptions = {}): void {
  if (!sha(result["outputHead"])) throw new Error("phase result Git identity is invalid");
  if (typeof result["status"] !== "string" || !STATUSES.includes(result["status"] as (typeof STATUSES)[number])) throw new Error("phase result status is invalid");
  if (!nonempty(result["summary"], 8_000)) throw new Error("phase result summary is invalid");

  const details = phase === "plan"
    ? requiredWithOptionalObject(result["details"], ["steps"], ["supervision"], "plan details")
    : phase === "implement" && options.allowLegacyImplementProjectWiki
    ? implementDetailsAllowingLegacyProjectWiki(result["details"])
    : exactObject(
      result["details"],
      phase === "implement" ? ["changes", "projectWiki"] : phase === "review" ? ["findings"] : phase === "test" ? ["commands"] : ["lessons", "followUps"],
      `${phase} details`,
    );
  if (phase === "plan") {
    stringList(details["steps"], "Plan steps", true);
    if (details["supervision"] !== undefined) validatePlanEvidence(details["supervision"], { sessionId: result["sessionId"], inputHead: result["inputHead"], profile: result["profile"], status: result["status"], attempt: result["attempt"] }, details["steps"]);
    if (result["status"] === "remediation_required") throw new Error("Plan cannot request remediation");
  } else if (phase === "implement") {
    stringList(details["changes"], "Implement changes", true);
    if (!options.allowLegacyImplementProjectWiki || Object.prototype.hasOwnProperty.call(details, "projectWiki")) {
      validateProjectWikiDisposition(details["projectWiki"]);
    }
    if (result["status"] === "remediation_required") throw new Error("Implement cannot request remediation");
  } else if (phase === "review") {
    const findings = stringList(details["findings"], "Review findings", false);
    if (result["status"] === "passed" && findings.length !== 0) throw new Error("passing Review must have no findings");
    if (result["status"] === "remediation_required" && findings.length === 0) throw new Error("Review remediation requires findings");
  } else if (phase === "test") {
    const commands = details["commands"];
    if (!Array.isArray(commands) || commands.length === 0 || commands.length > 100) throw new Error("Test commands are invalid");
    const evidence = commands.map((item, index) => validateTestCommand(item, index));
    if (result["status"] === "passed" && evidence.some(item => item.exitCode !== 0)) throw new Error("passing Test contains a failed command");
    if (result["status"] === "remediation_required" && evidence.every(item => item.exitCode === 0)) throw new Error("Test remediation requires a failed command");
  } else {
    stringList(details["lessons"], "Retro lessons", true);
    stringList(details["followUps"], "Retro follow-ups", false);
    if (result["status"] === "remediation_required") throw new Error("Retro cannot request remediation");
  }
}

function implementDetailsAllowingLegacyProjectWiki(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("implement details must be an object");
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object);
  const current = actual.length === 2 && actual.includes("changes") && actual.includes("projectWiki");
  const legacy = actual.length === 1 && actual[0] === "changes";
  if (!current && !legacy) throw new Error("implement details fields are invalid");
  if (current) validateProjectWikiDisposition(object["projectWiki"]);
  return object;
}

function validateTestCommand(value: unknown, index: number): TestCommandEvidence {
  const command = exactObject(value, ["command", "exitCode", "summary"], `Test command ${index}`);
  if (!nonempty(command["command"], 2_000) || !Number.isInteger(command["exitCode"]) || (command["exitCode"] as number) < 0 || (command["exitCode"] as number) > 255 || !nonempty(command["summary"], 8_000)) throw new Error(`Test command ${index} is invalid`);
  return command as unknown as TestCommandEvidence;
}

function stringList(value: unknown, label: string, required: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > 100 || (required && value.length === 0) || value.some(item => !nonempty(item, 8_000))) throw new Error(`${label} are invalid`);
  return value as string[];
}

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

function optionalProfileObject(value: unknown, label: string): Record<string, unknown> {
  return requiredWithOptionalObject(value, RESULT_KEYS, ["profile"], label);
}

function requiredWithOptionalObject(value: unknown, requiredKeys: readonly string[], optionalKeys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const object = value as Record<string, unknown>;
  const required = new Set(requiredKeys);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const actual = Object.keys(object);
  if (actual.some(key => !allowed.has(key)) || [...required].some(key => !actual.includes(key))) throw new PhaseShapeError(label, actual, requiredKeys, [...allowed]);
  return object;
}

function nonempty(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
}

function sha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/u.test(value);
}
