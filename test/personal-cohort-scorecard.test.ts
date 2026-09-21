import { canonicalJson } from "../src/personal/canonical-json.js";
import test from "node:test";
import assert from "node:assert/strict";
import { buildScorecards, type HistoricalRun } from "../src/personal/cohort-scorecard.js";
import { historicalTotals, extractHistoricalSession } from "../src/personal/historical-telemetry.js";
import { verifyDisposition, unknownDisposition } from "../src/personal/evidence-verification.js";
import { digestBytes, validateCohortManifest, type CohortRun } from "../src/personal/cohort-manifest.js";
import { reconcileBaseline } from "../src/personal/cohort-backfill.js";
import { H, keyFixture, manifestFixture, sessionBytes, sourceFixture, T1, T2, TM } from "./helpers/cohort-fixture.js";

function row(index: number): { input: CohortRun; report: HistoricalRun } {
  const bytes = sessionBytes(`synthetic-session-${index}`), source = { ...sourceFixture(bytes), sessionId: `synthetic-session-${index}` };
  source.artifact.file += String(index);
  const input = { ...manifestFixture(source).runs[0]!, runId: `synthetic-run-${String(index).padStart(4, "0")}` };
  const session = extractHistoricalSession(bytes, source);
  const report: HistoricalRun = { runId: input.runId, ticketId: input.ticketId, side: input.side, strata: input.strata, authority: "provisional-pi-session-v1", completion: input.completion,
    inventory: { expected: 1, listed: 1, supported: 1, complete: true }, totals: historicalTotals([session.totals]), sessions: [session], disposition: unknownDisposition(), wallMs: 30_000 };
  return { input, report };
}
function score(rows: ReturnType<typeof row>[]) {
  for (const r of rows) if (r.input.ticketRunInventory) r.input.ticketRunInventory = { ...r.input.ticketRunInventory, runIds: rows.filter(other => other.input.ticketId === r.input.ticketId).map(other => other.input.runId) };
  return buildScorecards(validateCohortManifest({ ...manifestFixture(), runs: rows.map(r => r.input) }), rows.map(r => r.report)); }
function authenticate(r: ReturnType<typeof row>, unmerged = false) {
  const f = keyFixture(), signed = f.signed({ ...f.manifest, runId: r.input.runId, candidate: r.input.candidate,
    ...(unmerged ? { prState: "closed", mergeSha: null, mergedAt: null, unmergedReason: "abandoned" } : {}) });
  r.report.disposition = verifyDisposition(signed.bytes, signed.envelopeBytes, f.roots, r.input);
}
test("completion never implies CI or merge; all unknown denominators remain visible", () => {
  const r = row(1), s = score([r])[0]!;
  assert.equal(r.report.completion, "completed"); assert.deepEqual(s.exactHeadCi, { passed: 0, failed: 0, unknown: 1 });
  assert.equal(s.merge.unknown, 1); assert.equal(s.costPerMergedTicket.mergedTickets, 0); assert.equal(s.firstPassAcceptance.numerator, 0); assert.equal(s.firstPassAcceptance.unknownResults, 1);
  assert.equal(s.unknownMergeTickets.totals.recordedCost.known, "0.1");
  assert.ok(s.caveats.includes("small-sample"));
  r.input.implementEntered = null; r.input.firstCandidate = null;
  assert.equal(score([r])[0]!.firstPassAcceptance.unknownDenominator, 1);
});
test("first-pass acceptance requires first candidate, first Review/Test and exact-head CI", () => {
  const r = row(1); authenticate(r);
  let s = score([r])[0]!; assert.deepEqual(s.firstPassAcceptance, { numerator: 1, denominator: 1, unknownDenominator: 0, unknownResults: 0 });
  assert.deepEqual(s.costPerMergedTicket, { recordedSubtotal: "0.1", mergedTickets: 1, completeTickets: 1 });
  assert.deepEqual(s.wallMsPerMergedTicket, { knownSubtotal: 60_000, mergedTickets: 1, completeTickets: 1 });
  r.input.firstCandidate!.review = "failed"; assert.equal(score([r])[0]!.tickets[0]!.firstPass, false);
  r.input.firstCandidate!.review = "passed"; r.input.firstCandidate!.head = "e".repeat(40); assert.equal(score([r])[0]!.tickets[0]!.firstPass, null);
  r.input.firstCandidate!.head = r.input.candidate!; r.report.disposition.ci = "unknown"; assert.equal(score([r])[0]!.tickets[0]!.firstPass, null);
});
test("merged ticket cost/fresh runs include earlier unmerged attempts; postmerge and unknown timing are separate", () => {
  const earlier = row(1), delivered = row(2);
  earlier.input.firstCandidate!.test = "failed"; earlier.input.remediationAttempts = 2;
  delivered.input.reservedAt = T1; delivered.input.sources[0]!.startedAt = T1;
  authenticate(earlier, true); authenticate(delivered);
  let s = score([earlier, delivered])[0]!;
  assert.equal(s.sampleTickets, 1); assert.equal(s.sampleRuns, 2); assert.equal(s.firstPassAcceptance.numerator, 0);
  assert.equal(s.costPerMergedTicket.recordedSubtotal, "0.2"); assert.deepEqual(s.freshRunsPerMergedTicket, { runs: 2, mergedTickets: 1, completeTickets: 1 });
  assert.equal(s.tickets[0]!.unmergedRunAttempts, 1); assert.equal(s.tickets[0]!.remediationAttempts, 2); assert.equal(s.activePhase.known, 20_000);
  const post = row(3); post.input.reservedAt = "2026-01-01T00:03:00.000Z"; post.input.endedAt = "2026-01-01T00:04:00.000Z"; post.input.sources[0]!.startedAt = post.input.reservedAt; post.input.sources[0]!.endedAt = post.input.endedAt;
  s = score([earlier, delivered, post])[0]!; assert.equal(s.tickets[0]!.postMergeRuns, 1); assert.equal(s.tickets[0]!.postMergeTotals.recordedCost.known, "0.1"); assert.equal(s.costPerMergedTicket.recordedSubtotal, "0.2");
  earlier.input.endedAt = null; s = score([earlier, delivered])[0]!;
  assert.equal(s.costPerMergedTicket.completeTickets, 0); assert.equal(s.costPerMergedTicket.recordedSubtotal, "0.1"); assert.equal(s.tickets[0]!.mergeAccountingUnknownRuns, 1);
  earlier.input.reservedAt = null; assert.equal(score([earlier, delivered])[0]!.wallMsPerMergedTicket.completeTickets, 0);
});
test("unmerged waste, rule-versioned report/infrastructure classifications, remediation and reopening stay distinct", () => {
  const rows = [row(1), row(2), row(3)];
  for (const [i, r] of rows.entries()) { r.input.ticketId = `SYN-${i + 1}`; r.report.ticketId = r.input.ticketId; }
  authenticate(rows[0]!, true); authenticate(rows[1]!);
  rows[1]!.report.disposition.reopened = true;
  for (const [r, kind, cause] of [[rows[0]!, "report", "report-validation"], [rows[1]!, "infrastructure", "provider"], [rows[2]!, "unknown", "unknown"]] as const) {
    const classification = { ruleVersion: 1 as const, kind, cause, evidenceRefs: [H] };
    r.input.sources[0]!.waste = classification; r.report.sessions[0]!.waste = classification;
  }
  const s = score(rows)[0]!;
  assert.equal(s.unmergedTickets.tickets, 1); assert.equal(s.unmergedTickets.totals.recordedCost.known, "0.1"); assert.equal(s.unknownMergeTickets.tickets, 1);
  assert.equal(s.waste.report.recordedCost.known, "0.1"); assert.equal(s.waste.infrastructure.activeMs.known, 10_000); assert.equal(s.waste.unknown.recordedCost.known, "0.1"); assert.equal(s.merge.reopened, 1);
});
test("all materially unlike strata remain separate, while equivalent gate classes can be compared descriptively", () => {
  for (const field of ["repository", "requiredCheckSet", "ticketClass", "reviewGate", "testGate", "publicationGate", "baselineSha", "workflow", "escalationPolicy", "correctionPolicy", "testSuite"] as const) {
    const a = row(1), b = row(2); b.input.ticketId = "SYN-2"; b.report.ticketId = "SYN-2";
    b.input.strata = { ...b.input.strata, [field]: field === "repository" ? "another/repository" : field === "ticketClass" ? "bug" : field === "baselineSha" ? "e".repeat(40) : "e".repeat(64) }; if (field === "requiredCheckSet") { b.input.strata.requiredChecks = ["different-check"]; b.input.strata.requiredCheckSet = digestBytes(canonicalJson(b.input.strata.requiredChecks)); }
    b.report.strata = b.input.strata;
    const cards = score([a, b]); assert.equal(cards.length, 2, field);
    if (["baselineSha", "workflow", "escalationPolicy", "correctionPolicy", "testSuite"].includes(field)) assert.equal(cards[0]!.gateClass, cards[1]!.gateClass);
    else assert.notEqual(cards[0]!.gateClass, cards[1]!.gateClass);
  }
  const a = row(1), b = row(2); b.input.side = "post"; b.report.side = "post";
  assert.throws(() => score([a, b])); // one ticket cannot be silently split across sides
  b.input.ticketId = "SYN-2"; b.report.ticketId = "SYN-2"; assert.equal(score([a, b]).length, 2);
});
test("baseline reconciliation emits exact decimal deltas with immutable provisional provenance", () => {
  const r = row(1), baseline = { artifact: r.input.sources[0]!.artifact, expected: { input: 10, output: 2, cacheRead: 30, usageRecords: 1, recordedCost: "0.1" } };
  assert.ok(reconcileBaseline(baseline, r.report.totals, true).dimensions.every(d => d.explanation === "match"));
  baseline.expected.recordedCost = "0.3"; baseline.expected.input = 8;
  const result = reconcileBaseline(baseline, r.report.totals, true);
  assert.equal(result.dimensions.find(d => d.dimension === "recordedCost")!.delta, "-0.2"); assert.equal(result.dimensions[0]!.delta, 2);
  assert.equal(result.authority, "provisional-operator-extraction");
  assert.ok(reconcileBaseline(baseline, r.report.totals, false).dimensions.every(d => !d.complete));
});

test("unknown ticket run inventory cannot certify all-run cost, first-pass acceptance or earliest reservation", () => {
  const r = row(1); authenticate(r); r.input.ticketRunInventory = null;
  const s = score([r])[0]!;
  assert.equal(s.firstPassAcceptance.unknownResults, 1);
  assert.equal(s.costPerMergedTicket.recordedSubtotal, "0.1");
  assert.equal(s.costPerMergedTicket.completeTickets, 0);
  assert.equal(s.wallMsPerMergedTicket.completeTickets, 0);
  assert.equal(s.freshRunsPerMergedTicket.completeTickets, 0);
  assert.equal(s.tickets[0]!.runInventory.complete, false);
});
