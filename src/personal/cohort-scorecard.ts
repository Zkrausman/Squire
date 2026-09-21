import { canonicalJson } from "./canonical-json.js";
import { check, digestBytes, type CohortManifest, type CohortRun } from "./cohort-manifest.js";
import { historicalTotals, type HistoricalSession, type HistoricalTotals } from "./historical-telemetry.js";
import { decimalText, decimalUnits } from "./telemetry-stream.js";
import type { VerifiedDisposition } from "./evidence-verification.js";

export interface HistoricalRun {
  runId: string; ticketId: string; side: CohortRun["side"]; strata: CohortRun["strata"];
  authority: "provisional-pi-session-v1"; completion: CohortRun["completion"];
  inventory: { expected: number | null; listed: number; supported: number; complete: boolean };
  totals: HistoricalTotals; sessions: HistoricalSession[]; disposition: VerifiedDisposition;
  wallMs: number | null;
}
export interface TicketScore {
  ticketId: string; runInventory: { expected: number | null; listed: number; complete: boolean }; ruleVersion: 1; evidenceRefs: string[];
  enteredImplement: boolean | null; firstPass: boolean | null; exactHeadCi: VerifiedDisposition["ci"];
  merge: VerifiedDisposition["merge"]; reopened: boolean | null; freshRuns: number; unmergedRunAttempts: number;
  remediationAttempts: number | null; allAttributed: HistoricalTotals; throughMerge: HistoricalTotals | null;
  mergeAccountingUnknownRuns: number; postMergeRuns: number; postMergeTotals: HistoricalTotals;
  wallToMergeMs: number | null;
}
export interface Scorecard {
  side: "pre" | "post"; strata: CohortRun["strata"]; gateClass: string; sampleTickets: number; sampleRuns: number;
  tickets: TicketScore[];
  firstPassAcceptance: { numerator: number; denominator: number; unknownDenominator: number; unknownResults: number };
  exactHeadCi: { passed: number; failed: number; unknown: number };
  merge: { merged: number; unmerged: number; unknown: number; reopened: number; reopenUnknown: number };
  costPerMergedTicket: { recordedSubtotal: string; mergedTickets: number; completeTickets: number };
  wallMsPerMergedTicket: { knownSubtotal: number; mergedTickets: number; completeTickets: number };
  freshRunsPerMergedTicket: { runs: number; mergedTickets: number; completeTickets: number };
  unmergedTickets: { tickets: number; runs: number; totals: HistoricalTotals };
  unknownMergeTickets: { tickets: number; runs: number; totals: HistoricalTotals };
  activePhase: HistoricalTotals["activeMs"];
  waste: { ruleVersion: 1; report: HistoricalTotals; infrastructure: HistoricalTotals; unknown: HistoricalTotals; none: HistoricalTotals };
  caveats: string[];
}
function gateClass(strata: CohortRun["strata"]): string {
  return digestBytes(canonicalJson({ repository: strata.repository, requiredCheckSet: strata.requiredCheckSet, requiredChecks: strata.requiredChecks,
    ticketClass: strata.ticketClass, reviewGate: strata.reviewGate, testGate: strata.testGate, publicationGate: strata.publicationGate }));
}
/** Pure aggregation over validated, explicitly bound inputs. All lifecycle
 * assertions remain operator-provenance, not controller telemetry authority. */
export function buildScorecards(manifest: CohortManifest, runs: readonly HistoricalRun[]): Scorecard[] {
  check(runs.length === manifest.runs.length && runs.every((r, i) => r.runId === manifest.runs[i]!.runId));
  const byId = new Map(manifest.runs.map(r => [r.runId, r]));
  const groups = new Map<string, HistoricalRun[]>();
  for (const r of runs) { const key = canonicalJson({ side: r.side, strata: r.strata }); groups.set(key, [...(groups.get(key) ?? []), r]); }
  return [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, group]) => {
    const tickets: TicketScore[] = [];
    for (const ticketId of [...new Set(group.map(r => r.ticketId))].sort()) {
      const rows = group.filter(r => r.ticketId === ticketId);
      const inputs = rows.map(r => byId.get(r.runId)!);
      const inventory = inputs[0]!.ticketRunInventory;
      const inventoryComplete = inventory !== null && inventory.runIds.length === rows.length && inventory.runIds.every(id => rows.some(r => r.runId === id));
      const merges = rows.filter(r => r.disposition.merge === "merged");
      // Conflicting successful merges cannot define one delivery endpoint.
      const merged = merges.length && new Set(merges.map(r => `${r.disposition.mergeSha}/${r.disposition.mergedAt}`)).size === 1 ? merges[0]! : undefined;
      const merge: TicketScore["merge"] = merged ? "merged" : rows.every(r => r.disposition.merge === "unmerged") ? "unmerged" : "unknown";
      const mergeTime = merged?.disposition.mergedAt ?? null;
      const enteredImplement = inputs.some(r => r.implementEntered === true) ? true : inputs.every(r => r.implementEntered === false) ? false : null;
      const entering = inputs.filter(r => r.implementEntered === true).sort((a, b) => (a.reservedAt ?? "").localeCompare(b.reservedAt ?? ""));
      const first = entering[0];
      const ordered = inventoryComplete && inputs.every(r => r.implementEntered !== null && r.reservedAt !== null) && new Set(entering.map(r => r.reservedAt)).size === entering.length;
      let firstPass: boolean | null = null;
      if (ordered && first?.firstCandidate) {
        const f = first.firstCandidate, disposition = rows.find(r => r.runId === first.runId)!.disposition;
        if (f.review === "failed" || f.test === "failed") firstPass = false;
        else if (f.head === first.candidate && disposition.ci === "failed") firstPass = false;
        else if (f.review === "passed" && f.test === "passed" && f.head === first.candidate && disposition.ci === "passed") firstPass = true;
      }
      const before = mergeTime ? rows.filter(r => { const input = byId.get(r.runId)!; return input.reservedAt !== null && input.endedAt !== null && input.reservedAt <= mergeTime && input.endedAt <= mergeTime; }) : [];
      const after = mergeTime ? rows.filter(r => { const input = byId.get(r.runId)!; return input.reservedAt !== null && input.reservedAt > mergeTime; }) : [];
      const unknownRuns = mergeTime ? rows.length - before.length - after.length : 0;
      const earliest = inventoryComplete && inputs.every(r => r.reservedAt !== null) ? inputs.map(r => r.reservedAt!).sort()[0]! : null;
      const throughMerge = mergeTime ? historicalTotals(before.map(r => r.totals), inventoryComplete && unknownRuns === 0 && before.length > 0) : null;
      const reopening = rows.map(r => r.disposition.reopened);
      tickets.push({ ticketId, runInventory: { expected: inventory?.runIds.length ?? null, listed: rows.length, complete: inventoryComplete }, ruleVersion: 1, evidenceRefs: [...new Set(inputs.flatMap(r => [...r.lifecycleEvidence, ...(r.ticketRunInventory?.evidenceRefs ?? []), ...(r.firstCandidate?.evidenceRefs ?? [])]).concat(rows.flatMap(r => r.disposition.manifestDigest ? [r.disposition.manifestDigest] : [])))].sort(),
        enteredImplement, firstPass, exactHeadCi: merged?.disposition.ci ?? (rows.every(r => r.disposition.ci === "passed") ? "passed" : rows.some(r => r.disposition.ci === "failed") ? "failed" : "unknown"),
        merge, reopened: reopening.some(v => v === true) ? true : reopening.every(v => v === false) ? false : null,
        freshRuns: rows.length, unmergedRunAttempts: rows.filter(r => r.disposition.merge !== "merged").length,
        remediationAttempts: inputs.every(r => r.remediationAttempts !== null) ? inputs.reduce((s, r) => s + r.remediationAttempts!, 0) : null,
        allAttributed: historicalTotals(rows.map(r => r.totals), inventoryComplete), throughMerge, mergeAccountingUnknownRuns: unknownRuns,
        postMergeRuns: after.length, postMergeTotals: historicalTotals(after.map(r => r.totals)),
        wallToMergeMs: earliest && mergeTime && mergeTime >= earliest ? Date.parse(mergeTime) - Date.parse(earliest) : null });
    }
    const merged = tickets.filter(t => t.merge === "merged");
    const wallSubtotal = merged.reduce((sum, t) => sum + (t.wallToMergeMs ?? 0), 0); check(Number.isSafeInteger(wallSubtotal));
    const category = (merge: TicketScore["merge"]) => { const ts = tickets.filter(t => t.merge === merge); return { tickets: ts.length, runs: ts.reduce((s, t) => s + t.freshRuns, 0), totals: historicalTotals(ts.map(t => t.allAttributed)) }; };
    const sessions = group.flatMap(r => r.sessions);
    const waste = (kind: HistoricalSession["waste"]["kind"]) => historicalTotals(sessions.filter(s => s.waste.kind === kind).map(s => s.totals), group.every(r => r.inventory.complete));
    return { side: group[0]!.side, strata: group[0]!.strata, gateClass: gateClass(group[0]!.strata), sampleTickets: tickets.length, sampleRuns: group.length, tickets,
      firstPassAcceptance: { numerator: tickets.filter(t => t.firstPass === true).length, denominator: tickets.filter(t => t.enteredImplement === true).length, unknownDenominator: tickets.filter(t => t.enteredImplement === null).length, unknownResults: tickets.filter(t => t.enteredImplement === true && t.firstPass === null).length },
      exactHeadCi: { passed: group.filter(r => r.disposition.ci === "passed").length, failed: group.filter(r => r.disposition.ci === "failed").length, unknown: group.filter(r => r.disposition.ci === "unknown").length },
      merge: { merged: merged.length, unmerged: tickets.filter(t => t.merge === "unmerged").length, unknown: tickets.filter(t => t.merge === "unknown").length, reopened: tickets.filter(t => t.reopened === true).length, reopenUnknown: tickets.filter(t => t.reopened === null).length },
      costPerMergedTicket: { recordedSubtotal: decimalText(merged.reduce((sum, t) => sum + decimalUnits(t.throughMerge?.recordedCost.known ?? "0"), 0n)), mergedTickets: merged.length, completeTickets: merged.filter(t => t.throughMerge?.recordedCost.complete).length },
      wallMsPerMergedTicket: { knownSubtotal: wallSubtotal, mergedTickets: merged.length, completeTickets: merged.filter(t => t.wallToMergeMs !== null).length },
      freshRunsPerMergedTicket: { runs: merged.reduce((sum, t) => sum + t.freshRuns - t.postMergeRuns, 0), mergedTickets: merged.length, completeTickets: merged.filter(t => t.runInventory.complete && t.mergeAccountingUnknownRuns === 0).length },
      unmergedTickets: category("unmerged"), unknownMergeTickets: category("unknown"), activePhase: historicalTotals(group.map(r => r.totals)).activeMs,
      waste: { ruleVersion: 1, report: waste("report"), infrastructure: waste("infrastructure"), unknown: waste("unknown"), none: waste("none") },
      caveats: ["descriptive-only-no-causal-model-quality-claims", "operator-lifecycle-and-classification-provenance", ...(tickets.length < 30 ? ["small-sample"] : []), ...(groups.size > 1 ? ["unlike-strata-not-pooled"] : []), "explicit-run-cohort-may-omit-other-ticket-attempts"] };
  });
}
