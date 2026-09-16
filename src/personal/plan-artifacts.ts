import { createHash } from "node:crypto";
import { canonical } from "./launch-material.js";
import { validatePhaseProfile, type PhaseProfile } from "./model-policy.js";
import { validateProjectWikiPaths } from "./phase-result.js";
import type { PlanSubphase } from "./prompt-policy.js";

export interface RequirementsArtifact {
  readonly version: 1;
  readonly inputHead: string;
  readonly problem: string;
  readonly acceptanceCriteria: readonly string[];
  readonly nonGoals: readonly string[];
  readonly assumptions: readonly string[];
  readonly dependencies: readonly string[];
  readonly openQuestions: readonly string[];
  readonly readiness: "ready" | "needs_clarification";
}
export interface DesignArtifact {
  readonly version: 1;
  readonly inputHead: string;
  readonly requirementsDigest: string;
  readonly steps: readonly string[];
  readonly affectedComponents: readonly string[];
  readonly tests: readonly string[];
  readonly risks: readonly string[];
  readonly exactHeadEvidence: { readonly head: string; readonly observations: readonly string[] };
  readonly projectWiki: { readonly status: "planned"; readonly paths: readonly string[]; readonly summary: string } | { readonly status: "not_required"; readonly reason: string };
}
export interface PlanChildEvidence {
  readonly subphase: PlanSubphase;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly profile: PhaseProfile;
  readonly inputHead: string;
  readonly launchDigest: string;
  readonly promptDigest: string;
  readonly outcome: "passed" | "failed";
  readonly diagnostic: string | null;
  readonly artifact: { readonly path: string; readonly digest: string; readonly content: RequirementsArtifact | DesignArtifact } | null;
}
export interface PlanEvidence {
  readonly version: 1;
  readonly supervisorId: string;
  readonly outcome: "ready" | "needs_clarification" | "failed";
  readonly launchDigest: string;
  readonly children: readonly PlanChildEvidence[];
}
export interface PlanProgress { readonly runId: string; readonly attempt: number; readonly subphase: PlanSubphase; }
export const digestArtifact = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
export function closed(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) throw new Error(`${label} fields are invalid`);
  return v;
}
function text(v: unknown): asserts v is string { if (typeof v !== "string" || !v.trim() || v.length > 8000) throw new Error("invalid Plan text"); }
function list(v: unknown, required = false): asserts v is string[] { if (!Array.isArray(v) || v.length > 100 || (required && !v.length)) throw new Error("invalid Plan list"); v.forEach(text); }
function hash(v: unknown): void { if (typeof v !== "string" || !/^[a-f0-9]{64}$/u.test(v)) throw new Error("invalid Plan digest"); }
export function validateRequirements(value: unknown, head: string): asserts value is RequirementsArtifact {
  const v = closed(value, ["version", "inputHead", "problem", "acceptanceCriteria", "nonGoals", "assumptions", "dependencies", "openQuestions", "readiness"], "Requirements");
  if (v["version"] !== 1 || v["inputHead"] !== head) throw new Error("Requirements HEAD/version mismatch");
  text(v["problem"]); list(v["acceptanceCriteria"], true);
  for (const key of ["nonGoals", "assumptions", "dependencies", "openQuestions"]) list(v[key]);
  if (v["readiness"] !== "ready" && v["readiness"] !== "needs_clarification") throw new Error("invalid Requirements readiness");
  if (v["readiness"] === "needs_clarification" && !(v["openQuestions"] as string[]).length) throw new Error("clarification requires questions");
}
export function validateDesign(value: unknown, head: string, requirementsDigest: string): asserts value is DesignArtifact {
  const v = closed(value, ["version", "inputHead", "requirementsDigest", "steps", "affectedComponents", "tests", "risks", "exactHeadEvidence", "projectWiki"], "Design");
  if (v["version"] !== 1 || v["inputHead"] !== head || v["requirementsDigest"] !== requirementsDigest) throw new Error("Design HEAD/Requirements binding mismatch");
  for (const key of ["steps", "affectedComponents", "tests"]) list(v[key], true);
  list(v["risks"]);
  const exact = closed(v["exactHeadEvidence"], ["head", "observations"], "exact-head evidence");
  if (exact["head"] !== head) throw new Error("Design evidence HEAD mismatch");
  list(exact["observations"], true);
  const wiki = v["projectWiki"] as Record<string, unknown> | null;
  if (wiki?.["status"] === "planned") { closed(wiki, ["status", "paths", "summary"], "prospective wiki"); validateProjectWikiPaths(wiki["paths"]); text(wiki["summary"]); }
  else { const w = closed(wiki, ["status", "reason"], "prospective wiki"); if (w["status"] !== "not_required") throw new Error("invalid prospective wiki disposition"); text(w["reason"]); }
}
export function validatePlanProgress(value: unknown): asserts value is PlanProgress {
  const v = closed(value, ["runId", "attempt", "subphase"], "Plan progress");
  text(v["runId"]);
  if (!Number.isInteger(v["attempt"]) || (v["attempt"] as number) < 1 || !["requirements", "implementation-design"].includes(v["subphase"] as string)) throw new Error("invalid Plan progress");
}
export function validatePlanEvidence(value: unknown, envelope: { sessionId: unknown; inputHead: unknown; profile?: unknown; status: unknown; attempt: unknown }, steps: unknown): asserts value is PlanEvidence {
  const v = closed(value, ["version", "supervisorId", "outcome", "launchDigest", "children"], "Plan evidence");
  if (v["version"] !== 1 || v["supervisorId"] !== envelope.sessionId || !["ready", "needs_clarification", "failed"].includes(v["outcome"] as string)) throw new Error("invalid supervisor identity/outcome");
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
  if (typeof v["supervisorId"] !== "string" || !uuid.test(v["supervisorId"])) throw new Error("invalid supervisor ID");
  hash(v["launchDigest"]);
  const children = v["children"];
  if (!Array.isArray(children) || children.length > 2) throw new Error("invalid Plan children");
  const sessions = new Set<string>();
  let requirements: RequirementsArtifact | undefined;
  let design: DesignArtifact | undefined;
  for (const [index, child] of children.entries()) {
    const c = closed(child, ["subphase", "sessionId", "sessionFile", "profile", "inputHead", "launchDigest", "promptDigest", "outcome", "diagnostic", "artifact"], "Plan child");
    const subphase = index === 0 ? "requirements" : "implementation-design";
    text(c["sessionId"]); hash(c["promptDigest"]); validatePhaseProfile(c["profile"]);
    if (!uuid.test(c["sessionId"]) || sessions.has(c["sessionId"]) || c["sessionId"] === envelope.sessionId || c["subphase"] !== subphase || c["sessionFile"] !== `/ticket/sessions/plan/${envelope.attempt}/${subphase}.jsonl` || c["inputHead"] !== envelope.inputHead || c["launchDigest"] !== v["launchDigest"] || canonical(c["profile"]) !== canonical(envelope.profile)) throw new Error("Plan child identity mismatch");
    sessions.add(c["sessionId"]);
    if (index === 1 && requirements?.readiness !== "ready") throw new Error("Design requires ready Requirements");
    if (c["outcome"] === "failed") { text(c["diagnostic"]); if (c["artifact"] !== null || index !== children.length - 1 || v["outcome"] !== "failed") throw new Error("invalid failed child"); continue; }
    if (c["outcome"] !== "passed" || c["diagnostic"] !== null) throw new Error("invalid child outcome");
    const a = closed(c["artifact"], ["path", "digest", "content"], "Plan artifact reference");
    if (a["path"] !== `/run/squire-plan-${v["supervisorId"]}/artifacts/${subphase}.json` || a["digest"] !== digestArtifact(a["content"])) throw new Error("Plan artifact digest/path mismatch");
    if (index === 0) { validateRequirements(a["content"], envelope.inputHead as string); requirements = a["content"]; }
    else { validateDesign(a["content"], envelope.inputHead as string, digestArtifact(requirements)); design = a["content"]; }
  }
  if ((v["outcome"] === "ready") !== (envelope.status === "passed")) throw new Error("Plan status/outcome mismatch");
  if (v["outcome"] === "ready" && (!design || canonical(steps) !== canonical(design.steps))) throw new Error("Plan missing validated Design");
  if (v["outcome"] === "needs_clarification" && (children.length !== 1 || requirements?.readiness !== "needs_clarification")) throw new Error("invalid clarification evidence");
}
