import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { rm } from "node:fs/promises";
import { canonicalJson, sha256 } from "../src/personal/canonical-json.js";
import { reconcileCohort, aggregateCohort } from "../src/personal/cohort-scorecard.js";
import { publishPrivateBytes } from "../src/personal/private-artifacts.js";
import { buildTelemetry, type TelemetrySession } from "../src/personal/telemetry-store.js";
import type { PersonalRunState } from "../src/personal/types.js";
import { launchTestRoot } from "./helpers/windows-launch.js";
import { at, cohortFixture, manifestFixture, sessionFixture, signedFixture, sessionId } from "./helpers/cohort.js";

const emptyReaders = { states: { async read() { return undefined; } }, telemetry: { async read() { return undefined; } } };
const roots = { schemaVersion: 1 as const, keys: [] };
function stateFixture(): PersonalRunState {
  const r = cohortFixture().runs[0]!;
  return { runId: r.runId, ticketId: r.ticketId, repository: r.stratum.repository, baseSha: r.stratum.baselineSha, head: r.candidateHead, status: "completed", version: 10, startedAt: at, endedAt: "2026-01-01T00:01:00.000Z", attempts: { plan: 0, implement: 1, review: 1, test: 1, retro: 0 }, remediations: { review: 0, test: 0 }, results: Object.fromEntries(["implement", "review", "test"].map(phase => [phase, { phase, attempt: 1, status: "passed", inputHead: r.candidateHead, outputHead: r.candidateHead }])) } as unknown as PersonalRunState;
}
function telemetryFixture() {
  const state = stateFixture();
  const session: TelemetrySession = { runId: state.runId, phase: "implement", subphase: null, attempt: 1, correction: 0, sessionId, sessionArtifactDigest: "1".repeat(64), inputHead: state.head!, profile: { provider: "openai", model: "synthetic", thinking: "medium" }, escalationDigest: null, trigger: "initial", stageIndex: null, stageAttempt: null, startedAt: at, endedAt: state.endedAt!, durationMs: 60000, outcome: "passed", phaseOutcome: "passed", streamDigest: "2".repeat(64), usage: { tokens: { input: 10, output: 2, cacheRead: 30, cacheWrite: 4 }, recordedCost: "2", costSource: "pi-recorded", messages: 1, diagnostics: [] } };
  return buildTelemetry({ schemaVersion: 1, authority: "pi-0.84.4-controller-json-v1", runId: state.runId, outcome: "completed", startedAt: at, endedAt: state.endedAt!, wallDurationMs: 60000, stateVersion: 10, inventoryComplete: true, sessions: [session], phaseOutcomes: { plan: "not_run", implement: "passed", review: "passed", test: "passed", retro: "not_run" } });
}
test("missing state/telemetry/evidence stays unknown, never zero-complete or merged", async () => {
  const spec = cohortFixture(); const observations = await reconcileCohort(spec, roots, emptyReaders); const score = aggregateCohort(spec, observations);
  assert.equal(observations[0]!.squire, "unknown"); assert.equal(observations[0]!.totals.recordedCost.complete, false);
  assert.equal(score.scorecards[0]!.firstPassAcceptance.unknownEntry, 1); assert.equal(score.scorecards[0]!.unknownMergeTickets, 1); assert.equal(score.scorecards[0]!.costPerMergedTicket.denominator, 0);
  assert.equal(score.tickets[0]!.freshRunsKnown, 0); assert.equal(score.tickets[0]!.freshRunsUnknown, 1);
});
test("Squire completion alone proves neither exact-head CI nor merge", async () => {
  const spec = cohortFixture(); const observations = await reconcileCohort(spec, roots, { ...emptyReaders, states: { async read() { return stateFixture(); } } });
  assert.equal(observations[0]!.squire, "completed"); assert.equal(observations[0]!.disposition.status, "unknown"); assert.equal(observations[0]!.firstPass, null);
});
test("authenticated merge/first pass, all ticket runs and unmerged waste have explicit denominators", async () => {
  const root = await launchTestRoot("squire-cohort-metrics-");
  try {
    const spec = cohortFixture(), m = manifestFixture();
    m.waste = [{ ruleVersion: "cohort-v1", sessionId, kind: "infrastructure", reason: "provider", evidence: ["2".repeat(64)] }];
    const signed = signedFixture(m), manifestPath = path.join(root, "manifest"), envelopePath = path.join(root, "envelope");
    await publishPrivateBytes(manifestPath, signed.bytes.toString()); await publishPrivateBytes(envelopePath, signed.envelopeBytes.toString());
    spec.runs[0]!.disposition = { manifest: { path: manifestPath, digest: sha256(signed.bytes) }, envelope: { path: envelopePath, digest: sha256(signed.envelopeBytes) } };
    const first = structuredClone(spec.runs[0]!); first.runId = "synthetic-run-0000"; first.disposition = null;
    const unmerged = structuredClone(first); unmerged.runId = "synthetic-run-0002"; unmerged.ticketId = "SYN-2";
    spec.runs.push(first, unmerged);
    const observations = await reconcileCohort(spec, signed.roots, {
      states: { async read(id) { return id === spec.runs[0]!.runId ? stateFixture() : { ...stateFixture(), runId: id, ticketId: id === unmerged.runId ? "SYN-2" : "SYN-1", startedAt: "2025-12-31T23:58:00.000Z", endedAt: "2025-12-31T23:59:00.000Z", attempts: { plan: 1, implement: 0, review: 0, test: 0, retro: 0 }, results: {} }; } },
      telemetry: { async read(id) { return { ...telemetryFixture(), runId: id }; } },
    });
    const score = aggregateCohort(spec, observations); const group = score.scorecards[0]!;
    assert.equal(group.firstPassAcceptance.accepted, 1); assert.equal(group.firstPassAcceptance.enteringImplement, 1);
    assert.equal(group.exactHeadCI.passed, 1); assert.equal(group.exactHeadCI.unknown, 2);
    assert.deepEqual(group.costPerMergedTicket, { knownNumerator: "4", denominator: 1, complete: false });
    assert.deepEqual(group.freshRunsPerMergedTicket, { knownNumerator: 2, denominator: 1, complete: false });
    assert.equal(group.wallMsPerMergedTicket.knownNumerator, 240000); assert.equal(group.totals.durationMs.known, 180000);
    assert.equal(group.unmergedAndUnknownTotals.recordedCost.known, "2"); assert.equal(group.waste.infrastructure.recordedCost.known, "2"); assert.equal(group.waste.unknown.recordedCost.known, "4");
    assert.equal(score.tickets.find(t => t.ticketId === "SYN-1")!.reopened, null);
    observations[0]!.stratum = { ...observations[0]!.stratum, modelProfiles: ["different-model"] };
    const heterogeneous = aggregateCohort(spec, observations); assert.equal(heterogeneous.scorecards.length, 2); assert.ok(heterogeneous.tickets[0]!.strataConflict); assert.ok(heterogeneous.scorecards.every(g => g.costPerMergedTicket.denominator === 0));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("private baseline reconciliation uses provisional sources, exact deltas, not current authority", async () => {
  const root = await launchTestRoot("squire-cohort-baseline-");
  try {
    const spec = cohortFixture(), fixture = sessionFixture(); fixture.source.path = path.join(root, "session.jsonl");
    await publishPrivateBytes(fixture.source.path, fixture.bytes.toString()); spec.runs[0]!.sources.push(fixture.source);
    spec.baseline = { artifactDigest: "e".repeat(64), extractionIdentity: "operator-extraction-v0", runIds: [spec.runs[0]!.runId], input: 11, output: 2, cacheRead: 30, messages: 1, recordedCost: "0.13" };
    const observations = await reconcileCohort(spec, roots, emptyReaders); const score = aggregateCohort(spec, observations);
    assert.equal(score.baseline!.deltas.input, -1); assert.equal(score.baseline!.deltas.recordedCost, "-0.005"); assert.equal(score.baseline!.authority, "provisional-untrusted-target");
    assert.deepEqual(score.baseline!.reasons, ["different_extraction_rule", "unexplained_variance"]);
    assert.equal(observations[0]!.authority, "provisional-historical"); assert.equal(observations[0]!.disposition.status, "unknown");
    assert.doesNotMatch(canonicalJson(score), /SECRET|PRIVATE_PATH|session.jsonl/u);
    const current = await reconcileCohort(spec, roots, { states: { async read() { return stateFixture(); } }, telemetry: { async read() { return telemetryFixture(); } } });
    assert.equal(current[0]!.totals.recordedCost.known, "2"); assert.equal(aggregateCohort(spec, current).baseline!.observed.recordedCost.known, "0.125");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing merge-boundary endpoints, remediation and cross-side strata remain explicit", async () => {
  const spec = cohortFixture(); const state = { ...stateFixture(), attempts: { ...stateFixture().attempts, implement: 2 }, remediations: { review: 1, test: 0 } };
  const observations = await reconcileCohort(spec, roots, { ...emptyReaders, states: { async read() { return state; } } });
  assert.equal(observations[0]!.firstPass, false); assert.equal(observations[0]!.remediationAttempts, 1);
  const second = structuredClone(spec.runs[0]!); second.runId = "synthetic-run-0002"; second.ticketId = "SYN-2"; second.side = "post"; second.stratum = { ...second.stratum, testSuite: "new-suite" }; spec.runs.push(second);
  const all = await reconcileCohort(spec, roots, emptyReaders); const score = aggregateCohort(spec, all);
  assert.equal(score.scorecards.length, 2); assert.ok(score.scorecards.every(s => s.tickets === 1));
  assert.ok(score.caveats.includes("descriptive_only_no_causal_model_quality_claim"));
});
