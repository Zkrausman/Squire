import path from "node:path";
import { canonicalJson } from "./canonical-json.js";
import { digestBytes, parseCohortManifest, validateCohortManifest, type CohortManifest } from "./cohort-manifest.js";
import { parseTrustRoots, unknownDisposition, validateTrustRoots, verifyDisposition, type TrustRoots } from "./evidence-verification.js";
import { extractHistoricalSession, historicalTotals, type HistoricalTotals } from "./historical-telemetry.js";
import { buildScorecards, type HistoricalRun, type Scorecard } from "./cohort-scorecard.js";
import { publishCohort, readBoundArtifact, readPrivateArtifact, type CohortPublication } from "./private-cohort-store.js";
import { decimalText, decimalUnits } from "./telemetry-stream.js";

export interface BaselineReconciliation {
  authority: "provisional-operator-extraction"; artifactDigest: string; artifactVerified: boolean;
  dimensions: { dimension: string; expected: number | string; extracted: number | string; delta: number | string; complete: boolean; explanation: "match" | "incomplete-extraction" | "structured-usage-variance" }[];
}
export interface CohortReport {
  schemaVersion: 1; ruleVersion: 1; authority: "provisional-pi-session-v1";
  manifestDigest: string; provenance: string; trustRootsDigest: string; optimizationMergeSha: string;
  runs: HistoricalRun[]; totals: HistoricalTotals;
  groups: { phase: string; subphase: string | null; profile: HistoricalRun["sessions"][number]["profile"]; outcome: string; totals: HistoricalTotals }[];
  scorecards: Scorecard[];
  comparison: { gateClass: string; preStrata: string[]; postStrata: string[]; interpretation: "descriptive-stratified-only" }[];
  baseline: BaselineReconciliation | null;
  caveats: string[];
}
function signedDelta(actual: string, expected: string): string { const d = decimalUnits(actual) - decimalUnits(expected); return d < 0 ? `-${decimalText(-d)}` : decimalText(d); }
/** The expected extraction is separately digest-bound provisional operator
 * evidence. Its legacy internal schema is not invented or transcript-scraped. */
export function reconcileBaseline(baseline: NonNullable<CohortManifest["baseline"]>, totals: HistoricalTotals, artifactVerified: boolean): BaselineReconciliation {
  const actual = { input: totals.tokens.input.known, output: totals.tokens.output.known, cacheRead: totals.tokens.cacheRead.known, usageRecords: totals.usageRecords, recordedCost: totals.recordedCost.known };
  const complete = { input: totals.tokens.input.complete, output: totals.tokens.output.complete, cacheRead: totals.tokens.cacheRead.complete, usageRecords: totals.usageRecordsComplete, recordedCost: totals.recordedCost.complete };
  return { authority: "provisional-operator-extraction", artifactDigest: baseline.artifact.digest, artifactVerified,
    dimensions: (Object.keys(actual) as (keyof typeof actual)[]).map(dimension => {
      const expected = baseline.expected[dimension], extracted = actual[dimension];
      const delta = typeof extracted === "string" ? signedDelta(extracted, expected as string) : extracted - (expected as number);
      const known = artifactVerified && complete[dimension];
      return { dimension, expected, extracted, delta, complete: known, explanation: !known ? "incomplete-extraction" : String(delta) === "0" ? "match" : "structured-usage-variance" };
    }) };
}
export async function backfillCohort(input: CohortManifest, roots: TrustRoots, repository: string): Promise<CohortReport> {
  const manifest = validateCohortManifest(input); roots = validateTrustRoots(roots);
  const runs: HistoricalRun[] = [];
  for (const r of manifest.runs) {
    const sessions: HistoricalRun["sessions"] = [];
    for (const source of r.sources) {
      const bytes = await readBoundArtifact(source.artifact, repository).catch(() => undefined);
      sessions.push(extractHistoricalSession(bytes, source));
    }
    const supported = sessions.filter(s => s.inventory.supported).length;
    const inventory = { expected: r.expectedSessions, listed: r.sources.length, supported, complete: r.expectedSessions !== null && r.expectedSessions === r.sources.length && supported === r.sources.length };
    let disposition = unknownDisposition();
    if (r.disposition) {
      try {
        const bytes = await readBoundArtifact(r.disposition.manifest, repository, 128 * 1024);
        const envelope = r.disposition.envelope ? await readBoundArtifact(r.disposition.envelope, repository, 4096) : undefined;
        disposition = verifyDisposition(bytes, envelope, roots, r);
      } catch { disposition = unknownDisposition("invalid_evidence"); }
    }
    runs.push({ runId: r.runId, ticketId: r.ticketId, side: r.side, strata: r.strata, authority: "provisional-pi-session-v1", completion: r.completion,
      inventory, totals: historicalTotals(sessions.map(s => s.totals), inventory.complete), sessions, disposition,
      wallMs: r.reservedAt && r.endedAt ? Date.parse(r.endedAt) - Date.parse(r.reservedAt) : null });
  }
  const totals = historicalTotals(runs.map(r => r.totals), runs.every(r => r.inventory.complete));
  const groups = new Map<string, HistoricalRun["sessions"]>();
  for (const s of runs.flatMap(r => r.sessions)) { const key = canonicalJson({ phase: s.phase, subphase: s.subphase, profile: s.profile, outcome: s.outcome }); groups.set(key, [...(groups.get(key) ?? []), s]); }
  const scorecards = buildScorecards(manifest, runs);
  let baseline: BaselineReconciliation | null = null;
  if (manifest.baseline) { const verified = await readBoundArtifact(manifest.baseline.artifact, repository).then(() => true, () => false); baseline = reconcileBaseline(manifest.baseline, totals, verified); }
  return { schemaVersion: 1, ruleVersion: 1, authority: "provisional-pi-session-v1", manifestDigest: digestBytes(canonicalJson(manifest)), provenance: manifest.provenance,
    trustRootsDigest: digestBytes(canonicalJson(roots)), optimizationMergeSha: manifest.optimizationMergeSha,
    runs, totals, groups: [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, rows]) => ({ phase: rows[0]!.phase, subphase: rows[0]!.subphase, profile: rows[0]!.profile, outcome: rows[0]!.outcome, totals: historicalTotals(rows.map(s => s.totals), runs.every(r => r.inventory.complete)) })), scorecards,
    comparison: [...new Set(scorecards.map(s => s.gateClass))].sort().map(gateClass => ({ gateClass, preStrata: scorecards.filter(s => s.gateClass === gateClass && s.side === "pre").map(s => digestBytes(canonicalJson(s.strata))), postStrata: scorecards.filter(s => s.gateClass === gateClass && s.side === "post").map(s => digestBytes(canonicalJson(s.strata))), interpretation: "descriptive-stratified-only" })),
    baseline, caveats: ["historical-usage-never-controller-authoritative", "completion-ci-and-merge-independent", "missing-is-not-zero", "no-pricing-reconstruction", "explicit-boundary-is-operator-asserted-not-git-ancestry-inference", "small-or-heterogeneous-samples-descriptive-only-no-causal-claims"] };
}
export async function backfillCohortFiles(options: { manifest: string; trustRoots: string; repository: string; dataRoot: string }): Promise<{ publication: CohortPublication; report: CohortReport }> {
  const manifestFile = path.resolve(options.manifest), trustFile = path.resolve(options.trustRoots);
  const manifest = parseCohortManifest(await readPrivateArtifact(manifestFile, path.dirname(manifestFile), options.repository, 2 * 1024 * 1024));
  const roots = parseTrustRoots(await readPrivateArtifact(trustFile, path.dirname(trustFile), options.repository, 32 * 1024));
  const report = await backfillCohort(manifest, roots, options.repository);
  const publication = await publishCohort(path.resolve(options.dataRoot), options.repository, report.manifestDigest, report);
  return { publication, report };
}
