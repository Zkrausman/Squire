import path from "node:path";
import { cohortAssert as assert, closed, checkName, digest, head, identity, list, safeCount, time, unique } from "./canonical-json.js";
import { decimalText, decimalUnits } from "./telemetry-stream.js";
import { validateTelemetryRunId } from "./telemetry-store.js";

export const COHORT_RULE = "cohort-v1" as const;
export interface FileIdentity { path: string; digest: string; }
export interface HistoricalSource extends FileIdentity { sessionId: string; phase: string; profile: string; }
export interface GateStratum {
  repository: string; requiredCheckSet: string; requiredChecks: string[]; ticketClass: string;
  reviewGate: string; testGate: string; publicationGate: string; baselineSha: string;
  workflow: string; modelProfiles: string[]; escalationPolicy: string; correctionPolicy: string; testSuite: string;
}
export interface CohortRun {
  runId: string; ticketId: string; side: "pre" | "post"; stratum: GateStratum;
  candidateHead: string; prNumber: number | null;
  sources: HistoricalSource[];
  disposition: { manifest: FileIdentity; envelope: FileIdentity } | null;
}
export interface BaselineTarget {
  artifactDigest: string; extractionIdentity: string; runIds: string[];
  input: number; output: number; cacheRead: number; messages: number; recordedCost: string;
}
export interface CohortSpec { schemaVersion: 1; optimizationMergeSha: string; runs: CohortRun[]; baseline?: BaselineTarget; }
export function absoluteFile(v: unknown): asserts v is string {
  assert(typeof v === "string" && v.length <= 2048 && !/[\x00-\x1f\x7f]/u.test(v) && path.isAbsolute(v) && path.normalize(v) === v);
}
export function validateFileIdentity(v: FileIdentity): void { closed(v, ["path", "digest"]); absoluteFile(v.path); digest(v.digest); }
export function canonicalDecimal(v: unknown): asserts v is string { assert(typeof v === "string" && decimalText(decimalUnits(v)) === v); }
export function validateStratum(v: GateStratum): void {
  closed(v, ["repository", "requiredCheckSet", "requiredChecks", "ticketClass", "reviewGate", "testGate", "publicationGate", "baselineSha", "workflow", "modelProfiles", "escalationPolicy", "correctionPolicy", "testSuite"]);
  assert(typeof v.repository === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(v.repository)); identity(v.repository);
  for (const key of ["requiredCheckSet", "ticketClass", "reviewGate", "testGate", "publicationGate", "workflow", "escalationPolicy", "correctionPolicy", "testSuite"] as const) identity(v[key]);
  head(v.baselineSha);
  for (const values of [v.requiredChecks, v.modelProfiles]) { list(values, 100, 1); values.forEach(values === v.requiredChecks ? checkName : identity); unique(values); const sorted = [...values].sort(); assert(values.every((value, i) => value === sorted[i])); }
}
export function validateCohortSpec(value: unknown): asserts value is CohortSpec {
  const v = value as CohortSpec; closed(v, ["schemaVersion", "optimizationMergeSha", "runs"], ["baseline"]);
  assert(v.schemaVersion === 1); head(v.optimizationMergeSha); list(v.runs, 100, 1);
  const sources: string[] = [], sessions: string[] = [], paths: string[] = [];
  for (const r of v.runs) {
    closed(r, ["runId", "ticketId", "side", "stratum", "candidateHead", "prNumber", "sources", "disposition"]);
    validateTelemetryRunId(r.runId); identity(r.ticketId); assert(r.side === "pre" || r.side === "post"); validateStratum(r.stratum); head(r.candidateHead);
    if (r.prNumber !== null) { safeCount(r.prNumber); assert(r.prNumber > 0); }
    list(r.sources, 100);
    for (const s of r.sources) {
      closed(s, ["path", "digest", "sessionId", "phase", "profile"]); absoluteFile(s.path); digest(s.digest);
      assert(typeof s.sessionId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(s.sessionId));
      assert(["plan", "implement", "review", "test", "retro", "unknown"].includes(s.phase)); identity(s.profile);
      sources.push(s.digest); sessions.push(s.sessionId); paths.push(s.path);
    }
    if (r.disposition !== null) { closed(r.disposition, ["manifest", "envelope"]); validateFileIdentity(r.disposition.manifest); validateFileIdentity(r.disposition.envelope); }
  }
  unique(v.runs.map(r => r.runId)); unique(sources); unique(sessions); unique(paths); assert(sources.length <= 1000);
  if (v.baseline !== undefined) {
    const b = v.baseline; closed(b, ["artifactDigest", "extractionIdentity", "runIds", "input", "output", "cacheRead", "messages", "recordedCost"]);
    digest(b.artifactDigest); identity(b.extractionIdentity); list(b.runIds, 100, 1); unique(b.runIds);
    assert(b.runIds.every(id => v.runs.some(r => r.runId === id))); for (const f of ["input", "output", "cacheRead", "messages"] as const) safeCount(b[f]); canonicalDecimal(b.recordedCost);
  }
}
export interface WasteClassification {
  ruleVersion: typeof COHORT_RULE; sessionId: string; kind: "report" | "infrastructure" | "none" | "unknown";
  reason: "report-validation-only" | "provider" | "sandbox" | "controller" | "publication" | "ci-infrastructure" | "code-test" | "ambiguous";
  evidence: string[];
}
export function validateWaste(v: WasteClassification): void {
  closed(v, ["ruleVersion", "sessionId", "kind", "reason", "evidence"]); assert(v.ruleVersion === COHORT_RULE); identity(v.sessionId);
  list(v.evidence, 20, 1); v.evidence.forEach(digest); unique(v.evidence);
  assert(v.kind === "report" ? v.reason === "report-validation-only" : v.kind === "infrastructure" ? ["provider", "sandbox", "controller", "publication", "ci-infrastructure"].includes(v.reason) : v.kind === "none" ? v.reason === "code-test" : v.kind === "unknown" && v.reason === "ambiguous");
}
// Re-export timestamp validation for schema consumers.
export { time as validateCohortTimestamp };
