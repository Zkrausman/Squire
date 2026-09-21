import { canonicalJson, cohortAssert as assert, parseBoundedJson, sha256 } from "./canonical-json.js";
import { COHORT_RULE, validateCohortSpec, type CohortRun, type CohortSpec } from "./cohort-domain.js";
import { verifyDisposition, type Disposition, type TrustRoots } from "./disposition-evidence.js";
import { HISTORICAL_RULE, readHistoricalTelemetry, sumCohortTotals, unknownTotals, type HistoricalTelemetry } from "./historical-telemetry.js";
import { readPrivateBytes } from "./private-artifacts.js";
import { TelemetryStore, telemetryTotals, type TelemetryTotals } from "./telemetry-store.js";
import { JsonRunStateStore } from "./json-run-state.js";
import type { PersonalRunState } from "./types.js";
import { decimalText, decimalUnits } from "./telemetry-stream.js";

export interface CohortObservation {
  runId: string; ticketId: string; candidateHead: string; prNumber: number | null; side: "pre" | "post"; stratum: CohortRun["stratum"];
  squire: PersonalRunState["status"] | "unknown"; stateDigest: string | null; telemetryDigest: string | null;
  reservedAt: string | null; endedAt: string | null; enteredImplement: boolean | null; firstPass: boolean | null;
  remediationAttempts: number | null; disposition: Disposition;
  authority: "controller" | "provisional-historical" | "unknown"; inventoryComplete: boolean; totals: TelemetryTotals;
  historical: HistoricalTelemetry[];
  groups: { phase: string; profile: string; outcome: string; totals: TelemetryTotals }[];
  waste: { ruleVersion: typeof COHORT_RULE; report: TelemetryTotals; infrastructure: TelemetryTotals; unknown: TelemetryTotals; unclassifiedSessions: number };
  diagnostics: string[];
}
export interface CohortReaders { states: Pick<JsonRunStateStore, "read">; telemetry: Pick<TelemetryStore, "read">; }
function projectedStateDigest(state: PersonalRunState): string {
  // JSON round-trip removes optional undefined properties; digest retains source
  // identity without copying errors, titles, paths or phase report text.
  return sha256(canonicalJson(JSON.parse(JSON.stringify(state))));
}
export async function reconcileCohort(spec: CohortSpec, roots: TrustRoots, readers: CohortReaders): Promise<CohortObservation[]> {
  validateCohortSpec(spec);
  let remaining = 256 * 1024 * 1024;
  const observations: CohortObservation[] = [];
  for (const r of spec.runs) {
    const diagnostics: string[] = [];
    let state = await readers.states.read(r.runId).catch(() => { diagnostics.push("invalid_state"); return undefined; });
    if (state && (state.ticketId !== r.ticketId || state.repository !== r.stratum.repository || (state.baseSha !== null && state.baseSha !== r.stratum.baselineSha))) { state = undefined; diagnostics.push("state_binding_mismatch"); }
    let telemetry = await readers.telemetry.read(r.runId).catch(() => { diagnostics.push("invalid_telemetry"); return undefined; });
    if (telemetry && (!state || telemetry.stateVersion > state.version || telemetry.outcome !== state.status)) { telemetry = undefined; diagnostics.push("telemetry_binding_mismatch"); }
    let disposition: Disposition = { status: "unknown", diagnostic: "missing_evidence" };
    if (r.disposition) {
      try {
        const [m, e] = await Promise.all([readPrivateBytes(r.disposition.manifest.path), readPrivateBytes(r.disposition.envelope.path)]);
        assert(sha256(m) === r.disposition.manifest.digest && sha256(e) === r.disposition.envelope.digest);
        disposition = verifyDisposition(m, e, roots, r);
      } catch { disposition = { status: "unknown", diagnostic: "invalid_evidence" }; }
    }
    const pr = state?.prUrl ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/u.exec(state.prUrl) : null;
    if ((pr && (pr[1] !== r.stratum.repository || Number(pr[2]) !== r.prNumber)) || (state?.head && state.head !== r.candidateHead)) disposition = { status: "unknown", diagnostic: "binding_mismatch" };
    if (disposition.status === "authenticated" && state?.startedAt && ((disposition.merge && disposition.merge.at < state.startedAt) || disposition.signedAt < state.startedAt || disposition.checks.some(c => c.completedAt < state.startedAt!))) disposition = { status: "unknown", diagnostic: "binding_mismatch" };
    const historical: HistoricalTelemetry[] = [];
    for (const source of r.sources) { const read = await readHistoricalTelemetry(source, remaining); remaining -= read.bytesRead; historical.push(read.artifact); }
    // Current and historical are never added together: the retained session may
    // describe the very same invocation as the controller's stdout capture.
    const totals = telemetry?.totals ?? sumCohortTotals(historical.map(h => h.totals));
    if (!telemetry) {
      // Explicit retained sources are not a verified complete run inventory.
      totals.recordedCost.complete = false; totals.durationMs.complete = false;
      for (const token of Object.values(totals.tokens)) token.complete = false;
    }
    const groups = telemetry ? telemetry.sessions.map(s => ({ phase: s.phase, profile: `${s.profile.provider}/${s.profile.model}/${s.profile.thinking}`, outcome: s.outcome, totals: telemetryTotals([s]) })) : historical.map((h, i) => ({ phase: r.sources[i]!.phase, profile: r.sources[i]!.profile, outcome: "unknown", totals: h.totals }));
    if (historical.length && telemetry) diagnostics.push("historical_not_added_to_controller");
    let firstPass: boolean | null = null;
    if (state && state.attempts.implement > 0) {
      const phases = ["implement", "review", "test"] as const;
      const results = phases.map(p => state!.results[p]);
      if (results.some(result => result?.attempt === 1 && result.status !== "passed") || state.remediations.review > 0 || state.remediations.test > 0) firstPass = false;
      else if (phases.every(p => state!.attempts[p] === 1) && results.every(result => result?.attempt === 1 && result.status === "passed" && result.outputHead === r.candidateHead) && state.results.review?.inputHead === r.candidateHead && state.results.test?.inputHead === r.candidateHead && disposition.status === "authenticated") firstPass = disposition.ci === "unknown" ? null : disposition.ci === "passed";
    }
    const classified = { report: [] as TelemetryTotals[], infrastructure: [] as TelemetryTotals[], unknown: [] as TelemetryTotals[] };
    let unclassifiedSessions = 0;
    if (telemetry) for (const session of telemetry.sessions) {
      const classification = disposition.status === "authenticated" ? disposition.waste.find(w => w.sessionId === session.sessionId && session.streamDigest !== null && w.evidence.includes(session.streamDigest)) : undefined;
      if (classification?.kind === "none") continue;
      const kind = classification?.kind ?? "unknown";
      classified[kind].push(telemetryTotals([session])); if (kind === "unknown") unclassifiedSessions++;
    }
    else { classified.unknown.push(totals); unclassifiedSessions = totals.sessions; }
    observations.push({ runId: r.runId, ticketId: r.ticketId, candidateHead: r.candidateHead, prNumber: r.prNumber, side: r.side, stratum: r.stratum,
      squire: state?.status ?? "unknown", stateDigest: state ? projectedStateDigest(state) : null, telemetryDigest: telemetry ? sha256(canonicalJson(telemetry)) : null,
      reservedAt: state?.startedAt ?? null, endedAt: state?.endedAt ?? null, enteredImplement: state ? state.attempts.implement > 0 : null, firstPass,
      remediationAttempts: state ? state.remediations.review + state.remediations.test : null,
      disposition, authority: telemetry ? "controller" : historical.length ? "provisional-historical" : "unknown", inventoryComplete: telemetry?.inventoryComplete ?? false, totals, historical, groups,
      waste: { ruleVersion: COHORT_RULE, report: sumCohortTotals(classified.report), infrastructure: sumCohortTotals(classified.infrastructure), unknown: sumCohortTotals(classified.unknown), unclassifiedSessions }, diagnostics });
  }
  return observations;
}
function ticketScore(rows: CohortObservation[]) {
  const ordered = [...rows].sort((a, b) => (a.reservedAt ?? "~").localeCompare(b.reservedAt ?? "~") || a.runId.localeCompare(b.runId));
  const allStarts = rows.every(r => r.reservedAt !== null);
  const merges = rows.flatMap(r => r.disposition.status === "authenticated" && r.disposition.merge ? [r.disposition.merge] : []);
  const merge = merges.length && merges.every(m => canonicalJson(m) === canonicalJson(merges[0])) ? merges[0]! : null;
  const strata = new Set(rows.map(r => canonicalJson({ side: r.side, stratum: r.stratum })));
  const firstImplement = ordered.find(r => r.enteredImplement === true);
  const enteredImplement = firstImplement ? true : rows.every(r => r.enteredImplement === false) ? false : null;
  const priorKnown = firstImplement && allStarts && ordered.slice(0, ordered.indexOf(firstImplement)).every(r => r.enteredImplement === false);
  const throughMerge = merge ? rows.filter(r => r.reservedAt !== null && r.endedAt !== null && r.reservedAt <= merge.at && r.endedAt <= merge.at) : [];
  const totals = sumCohortTotals(rows.map(r => r.totals));
  return { ticketId: rows[0]!.ticketId, repository: rows[0]!.stratum.repository, strataConflict: strata.size > 1,
    enteredImplement, firstPass: priorKnown && strata.size === 1 ? firstImplement.firstPass : null,
    requestedRuns: rows.length, freshRunsKnown: rows.filter(r => r.stateDigest !== null).length, freshRunsUnknown: rows.filter(r => r.stateDigest === null).length,
    merge: merge, mergeDisposition: merge ? "merged" : merges.length ? "unknown" : rows.every(r => r.disposition.status === "authenticated" && r.disposition.prState !== "merged") ? "unmerged" : "unknown",
    reopened: rows.some(r => r.disposition.status === "authenticated" && r.disposition.reopened === true) ? true : rows.every(r => r.disposition.status === "authenticated" && r.disposition.reopened === false) ? false : null,
    totals, throughMergeKnown: sumCohortTotals(throughMerge.map(r => r.totals)),
    // Enumeration is explicit, not an independently verified all-run inventory.
    throughMergeUnknownRuns: merge ? rows.filter(r => !throughMerge.includes(r) && (!r.reservedAt || r.reservedAt <= merge.at)).length : rows.length,
    allRunsComplete: false, wallMs: merge && allStarts && ordered[0]!.reservedAt! <= merge.at ? Date.parse(merge.at) - Date.parse(ordered[0]!.reservedAt!) : null,
    remediationAttemptsKnown: rows.reduce((n, r) => n + (r.remediationAttempts ?? 0), 0), remediationAttemptsUnknown: rows.filter(r => r.remediationAttempts === null).length,
  };
}
export function aggregateCohort(spec: CohortSpec, observations: CohortObservation[]) {
  validateCohortSpec(spec); assert(observations.length === spec.runs.length && observations.every((r, i) => r.runId === spec.runs[i]!.runId));
  const byTicket = new Map<string, CohortObservation[]>();
  for (const r of observations) { const key = `${r.stratum.repository}:${r.ticketId}`; byTicket.set(key, [...(byTicket.get(key) ?? []), r]); }
  const tickets = [...byTicket.values()].map(ticketScore);
  const strata = new Map<string, CohortObservation[]>();
  for (const r of observations) { const key = canonicalJson({ side: r.side, stratum: r.stratum }); strata.set(key, [...(strata.get(key) ?? []), r]); }
  const scorecards = [...strata.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => {
    const selected = tickets.filter(t => rows.some(r => r.ticketId === t.ticketId && r.stratum.repository === t.repository) && !t.strataConflict);
    const merged = selected.filter(t => t.merge !== null);
    const groups = new Map<string, TelemetryTotals[]>();
    for (const r of rows) for (const g of r.groups) { const k = canonicalJson({ authority: r.authority, phase: g.phase, profile: g.profile, outcome: g.outcome }); groups.set(k, [...(groups.get(k) ?? []), g.totals]); }
    return { ...JSON.parse(key) as { side: string; stratum: CohortRun["stratum"] }, requestedRuns: rows.length, tickets: selected.length,
      excludedHeterogeneousTickets: tickets.filter(t => t.strataConflict && rows.some(r => r.ticketId === t.ticketId && r.stratum.repository === t.repository)).length,
      firstPassAcceptance: { complete: false, accepted: selected.filter(t => t.enteredImplement && t.firstPass === true).length, enteringImplement: selected.filter(t => t.enteredImplement === true).length, unknownEntry: selected.filter(t => t.enteredImplement === null).length, unknownAcceptance: selected.filter(t => t.enteredImplement === true && t.firstPass === null).length },
      exactHeadCI: { passed: rows.filter(r => r.disposition.status === "authenticated" && r.disposition.ci === "passed").length, failed: rows.filter(r => r.disposition.status === "authenticated" && r.disposition.ci === "failed").length, unknown: rows.filter(r => r.disposition.status === "unknown" || r.disposition.ci === "unknown").length },
      mergedTickets: merged.length, unmergedTickets: selected.filter(t => t.mergeDisposition === "unmerged").length, unknownMergeTickets: selected.filter(t => t.mergeDisposition === "unknown").length,
      reopen: { known: selected.filter(t => t.reopened === true).length, unknown: selected.filter(t => t.reopened === null).length },
      costPerMergedTicket: { knownNumerator: sumCohortTotals(merged.map(t => t.throughMergeKnown)).recordedCost.known, denominator: merged.length, complete: false },
      wallMsPerMergedTicket: { knownNumerator: merged.reduce((n, t) => n + (t.wallMs ?? 0), 0), denominator: merged.length, unknown: merged.filter(t => t.wallMs === null).length, complete: false },
      freshRunsPerMergedTicket: { knownNumerator: merged.reduce((n, t) => n + t.freshRunsKnown, 0), denominator: merged.length, complete: false },
      unmergedAndUnknownTotals: sumCohortTotals(selected.filter(t => !t.merge).map(t => t.totals)),
      totals: sumCohortTotals(rows.map(r => r.totals)),
      waste: { ruleVersion: COHORT_RULE, report: sumCohortTotals(rows.map(r => r.waste.report)), infrastructure: sumCohortTotals(rows.map(r => r.waste.infrastructure)), unknown: sumCohortTotals(rows.map(r => r.waste.unknown)) },
      groups: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, totals]) => ({ ...JSON.parse(k) as { phase: string; profile: string; outcome: string }, totals: sumCohortTotals(totals) })),
    };
  });
  let baseline = null;
  if (spec.baseline) {
    const target = spec.baseline;
    const selected = observations.filter(r => target.runIds.includes(r.runId));
    // Reproduction always uses historical extraction, not a different authority.
    const observed = sumCohortTotals(selected.map(r => sumCohortTotals(r.historical.map(h => h.totals))));
    const signedDecimal = (n: bigint) => n < 0n ? `-${decimalText(-n)}` : decimalText(n);
    const deltas = { input: observed.tokens.input.known - target.input, output: observed.tokens.output.known - target.output, cacheRead: observed.tokens.cacheRead.known - target.cacheRead, messages: observed.messages - target.messages, recordedCost: signedDecimal(decimalUnits(observed.recordedCost.known) - decimalUnits(target.recordedCost)) };
    const reasons: string[] = [];
    if (selected.some(r => !r.historical.length || r.historical.some(h => h.diagnostic === "invalid_or_unavailable_source"))) reasons.push("missing_or_unsupported_sources");
    if (selected.some(r => r.historical.some(h => h.diagnostic === "incomplete_usage"))) reasons.push("incomplete_usage");
    if (target.extractionIdentity !== HISTORICAL_RULE) reasons.push("different_extraction_rule");
    if (Object.values(deltas).some(v => v !== 0 && v !== "0")) reasons.push("unexplained_variance");
    baseline = { authority: "provisional-untrusted-target", target, extractionRule: HISTORICAL_RULE, observed, deltas, reasons, inventoryComplete: false };
  }
  return { schemaVersion: 1, ruleVersion: COHORT_RULE, optimizationMergeSha: spec.optimizationMergeSha, specDigest: sha256(canonicalJson(spec)),
    caveats: ["descriptive_only_no_causal_model_quality_claim", "small_samples_and_unlike_strata_not_pooled", "explicit_inventory_cannot_prove_all_ticket_runs", "historical_source_inventory_provisional", "ratios_are_known_numerator_and_denominator_not_complete_estimates"],
    observations, tickets, scorecards, baseline };
}
export async function readCohortSpec(file: string): Promise<CohortSpec> { const value = parseBoundedJson(await readPrivateBytes(file)); validateCohortSpec(value); return value; }

/** Versioned machine-readable output, excluding the host store's root provenance. */
export type CohortScorecard = ReturnType<typeof aggregateCohort>;
