import { parseBoundedJson, canonicalJson } from "./canonical-json.js";
import { createHash } from "node:crypto";
import { decimalUnits, decimalText } from "./telemetry-stream.js";

export const COHORT_LIMITS = { maxBytes: 2 * 1024 * 1024, maxDepth: 24, maxItems: 50_000, canonicalNumbers: true } as const;
export const digestBytes = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
export function check(value: unknown): asserts value { if (!value) throw new Error("invalid cohort schema or binding"); }
export type Validator<T> = (value: unknown) => T;
export const text: Validator<string> = value => { check(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u.test(value)); return value; };
export const hash: Validator<string> = value => { check(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)); return value; };
export const head: Validator<string> = value => { check(typeof value === "string" && /^[a-f0-9]{40}$/u.test(value)); return value; };
export const count: Validator<number> = value => { check(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000); return value; };
export const bool: Validator<boolean> = value => { check(typeof value === "boolean"); return value; };
export const decimal: Validator<string> = value => { check(typeof value === "string" && decimalText(decimalUnits(value)) === value); return value; };
export const timestamp: Validator<string> = value => { check(typeof value === "string" && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value); return value; };
export const filePath: Validator<string> = value => { check(typeof value === "string" && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(value)); return value; };
export const nullable = <T>(validate: Validator<T>): Validator<T | null> => value => value === null ? null : validate(value);
export const choice = <T extends string | number>(...values: T[]): Validator<T> => value => { check(values.includes(value as T)); return value as T; };
export const list = <T>(validate: Validator<T>, max: number, min = 0): Validator<T[]> => value => { check(Array.isArray(value) && value.length >= min && value.length <= max); return value.map(validate); };
export function shape<S extends Record<string, Validator<unknown>>>(fields: S): Validator<{ [K in keyof S]: ReturnType<S[K]> }> {
  return value => {
    check(value && typeof value === "object" && !Array.isArray(value));
    const v = value as Record<string, unknown>;
    check(Object.keys(v).length === Object.keys(fields).length && Object.keys(v).every(k => Object.hasOwn(fields, k)));
    return Object.fromEntries(Object.entries(fields).map(([key, validate]) => [key, validate(v[key])])) as { [K in keyof S]: ReturnType<S[K]> };
  };
}
export function unique<T>(rows: readonly T[], key: (row: T) => string): void { check(new Set(rows.map(key)).size === rows.length); }
export const reference = shape({ root: filePath, file: filePath, digest: hash, bytes: count });
export type ArtifactReference = ReturnType<typeof reference>;
export const profile = shape({ provider: text, model: text, thinking: text });
export const strata = shape({ repository: text, requiredCheckSet: hash, requiredChecks: list(text, 100, 1), ticketClass: text,
  reviewGate: hash, testGate: hash, publicationGate: hash, baselineSha: head, workflow: hash,
  profiles: list(profile, 32, 1), escalationPolicy: hash, correctionPolicy: hash, testSuite: hash });
const refs = list(hash, 32, 1);
export const waste = shape({ ruleVersion: choice(1), kind: choice("report", "infrastructure", "none", "unknown"),
  cause: choice("report-validation", "report-correction", "provider", "sandbox", "controller", "publication", "ci-infrastructure", "code-test", "unknown"), evidenceRefs: list(hash, 32) });
export const source = shape({ artifact: reference, sessionId: text, provenance: hash, phase: choice("plan", "implement", "review", "test", "retro"),
  subphase: nullable(choice("requirements", "implementation-design")), profile, attempt: count, correction: count,
  outcome: choice("passed", "failed", "remediation_required", "unknown"), startedAt: nullable(timestamp), endedAt: nullable(timestamp), waste });
export type HistoricalSource = ReturnType<typeof source>;
export const run = shape({ runId: text, ticketId: text, candidate: nullable(head), side: choice("pre", "post"), strata,
  reservedAt: nullable(timestamp), endedAt: nullable(timestamp), completion: choice("completed", "failed", "interrupted", "unknown"),
  lifecycleEvidence: list(hash, 32), implementEntered: nullable(bool), remediationAttempts: nullable(count),
  firstCandidate: nullable(shape({ head, review: choice("passed", "failed", "unknown"), test: choice("passed", "failed", "unknown"), evidenceRefs: refs })),
  ticketRunInventory: nullable(shape({ runIds: list(text, 256, 1), evidenceRefs: refs })),
  expectedSessions: nullable(count), sources: list(source, 500),
  disposition: nullable(shape({ manifest: reference, envelope: nullable(reference) })) });
export type CohortRun = ReturnType<typeof run>;
const totals = shape({ input: count, output: count, cacheRead: count, usageRecords: count, recordedCost: decimal });
export const baselineArtifact = shape({ schemaVersion: choice(1), authority: choice("provisional-operator-extraction"), totals });
const manifest = shape({ schemaVersion: choice(1), provenance: hash, optimizationMergeSha: head,
  runs: list(run, 256, 1), baseline: nullable(shape({ artifact: reference, expected: totals })) });
export type CohortManifest = ReturnType<typeof manifest>;
export function validateCohortManifest(value: unknown): CohortManifest {
  const result = manifest(value); unique(result.runs, r => r.runId);
  const sources = result.runs.flatMap(r => r.sources); check(sources.length <= 2000);
  unique(sources, s => s.artifact.digest); unique(sources, s => `${s.artifact.root}\0${s.artifact.file}`);
  check(sources.reduce((sum, s) => sum + s.artifact.bytes, 0) <= 512 * 1024 * 1024);
  for (const r of result.runs) {
    check(/^[a-z0-9][a-z0-9-]{7,127}$/u.test(r.runId) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(r.strata.repository));
    unique(r.strata.requiredChecks, x => x);
    check(r.strata.requiredCheckSet === digestBytes(canonicalJson([...r.strata.requiredChecks].sort()))); unique(r.sources, s => s.sessionId);
    unique(r.strata.profiles, canonicalJson);
    check(r.endedAt === null || r.reservedAt === null || r.endedAt >= r.reservedAt);
    if (r.implementEntered !== null || r.completion !== "unknown" || r.remediationAttempts !== null) check(r.lifecycleEvidence.length > 0);
    if (r.ticketRunInventory) { unique(r.ticketRunInventory.runIds, x => x); check(r.ticketRunInventory.runIds.includes(r.runId)); }
    if (r.firstCandidate) check(r.implementEntered === true);
    for (const s of r.sources) {
      check(s.attempt >= 1 && s.attempt <= 1000 && s.correction <= 10 && (s.subphase === null || s.phase === "plan"));
      check(s.artifact.bytes <= 64 * 1024 * 1024 && r.strata.profiles.some(p => canonicalJson(p) === canonicalJson(s.profile)));
      check(s.endedAt === null || s.startedAt === null || s.endedAt >= s.startedAt);
      check(s.startedAt === null || r.reservedAt === null || s.startedAt >= r.reservedAt);
      check(s.endedAt === null || r.endedAt === null || s.endedAt <= r.endedAt);
      if (s.waste.kind !== "unknown") check(s.waste.evidenceRefs.length > 0);
      if (s.waste.kind === "report") check(["report-validation", "report-correction"].includes(s.waste.cause));
      if (s.waste.kind === "infrastructure") check(["provider", "sandbox", "controller", "publication", "ci-infrastructure"].includes(s.waste.cause));
    }
  }
  // A ticket cannot straddle the optimization boundary or unlike accounting strata.
  const tickets = new Map<string, string>();
  for (const r of result.runs) { const key = `${r.strata.repository}/${r.ticketId}`, identity = canonicalJson({ side: r.side, strata: r.strata, ticketRunInventory: r.ticketRunInventory }); check(!tickets.has(key) || tickets.get(key) === identity); tickets.set(key, identity); }
  return result;
}
export function parseCohortManifest(bytes: Buffer | string): CohortManifest { return validateCohortManifest(parseBoundedJson(bytes, COHORT_LIMITS)); }
