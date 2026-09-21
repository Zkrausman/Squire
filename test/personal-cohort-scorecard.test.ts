import test from "node:test";
import assert from "node:assert/strict";
import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { assembleCohort, runCohort, type CohortOptions } from "../src/personal/cohort-scorecard.js";
import { canonicalJson } from "../src/personal/bounded-json.js";
import { decodeCohortDocument, validateCohortDocument, COHORT_SCHEMAS, type Binding, type CohortRun, type CohortRequest, type SquireManifest, type DispositionManifest } from "../src/personal/cohort-schema.js";
import { sha256 } from "../src/personal/private-artifact-store.js";
import { parseArguments } from "../src/personal/cli.js";
import { launchTestRoot } from "./helpers/windows-launch.js";
import { binding, dispositionFixture, historyFixture, keys, privateFile, runFixture, squireFixture, head } from "./helpers/cohort.js";
async function fixture(fn: (root: string, options: CohortOptions) => Promise<void>) {
  const root = await launchTestRoot("cohort-score-");
  try { await fn(root, { dataDirectory: root, repository: path.resolve("."), controllerTelemetryRoot: path.join(root, "telemetry") }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const request = (runs: CohortRun[]): CohortRequest => ({ schemaVersion: 1, cohortId: "synthetic-cohort", optimizationMergeSha: "c".repeat(40), runs, baseline: null });
function bound(r: CohortRun): Binding { return { runId: r.runId, ticket: r.ticket, repository: r.repository, candidateSha: r.candidateSha, pr: r.pr, requiredCheckSet: r.requiredCheckSet }; }
async function addEvidence(root: string, r: CohortRun, k: ReturnType<typeof keys>, d: DispositionManifest, s: SquireManifest) {
  s.accountedSessions = r.telemetry ? s.classifications.map(c => ({ sessionId: c.sessionId, sourceDigest: r.telemetry!.sha256 })) : r.sessions.map(s => ({ sessionId: s.sessionId, sourceDigest: s.source.sha256 }));
  const di = k.signed(d), sq = k.signed(s);
  r.disposition = { manifest: await privateFile(root, `${r.runId}-disposition`, di.bytes), envelope: await privateFile(root, `${r.runId}-disposition-envelope`, di.envelope) };
  r.squire = { manifest: await privateFile(root, `${r.runId}-squire`, sq.bytes), envelope: await privateFile(root, `${r.runId}-squire-envelope`, sq.envelope) };
}
test("closed schemas and CLI reject unknown fields, duplicate keys, signing options and unbounded inventories", () => {
  assert.ok(Object.hasOwn(COHORT_SCHEMAS.$defs, "scorecard"));
  assert.equal(parseArguments(["cohort", "request.json", "--trust-roots", "public.json"])?.command, "cohort");
  for (const args of [["cohort", "request.json"], ["cohort", "request.json", "--signing-key", "secret"], ["cohort", "request.json", "--trust-roots", "public.json", "--trust-roots", "other"], ["cohort", "request.json", "--trust-roots", "--config"]]) assert.equal(parseArguments(args), undefined);
  assert.throws(() => validateCohortDocument("request", { ...request([runFixture()]), extra: true }));
  assert.throws(() => decodeCohortDocument("request", Buffer.from('{"schemaVersion":1,"schemaVersion":1}')));
  assert.throws(() => validateCohortDocument("request", request(Array.from({ length: 257 }, () => runFixture()))));
});
test("explicit historical usage publishes deterministically with private reconciliation and no inferred authority", () => fixture(async (root, options) => {
  const r = runFixture(); r.sessions.push(await historyFixture(root, "history"));
  const req = request([r]), k = keys();
  const baseline = await privateFile(root, "baseline", Buffer.from(JSON.stringify({ input: 10, output: 3, cacheRead: 21, messages: 1, recordedCost: 0.123456789, secret: "BASELINE-PRIVATE-CONTENT" })));
  req.baseline = { source: baseline, runIds: [r.runId], fields: { input: "/input", output: "/output", cacheRead: "/cacheRead", messages: "/messages", recordedCost: "/recordedCost" } };
  const card = await assembleCohort(req, k.roots, options);
  validateCohortDocument("scorecard", card);
  assert.equal(card.accounting.input.known, 10); assert.equal(card.accounting.input.complete, false);
  assert.equal(card.runs[0]!.completion, "unknown"); assert.equal(card.runs[0]!.disposition.merge, "unknown");
  assert.equal(card.baseline!.fields.find(f => f.field === "cacheRead")!.variance, "-1");
  assert.equal(card.baseline!.fields.find(f => f.field === "input")!.reason, "incomplete_or_unsupported_sources");
  assert.equal(card.groups[0]!.metrics.firstPassAcceptance.unknownDenominator, 1);
  assert.equal(card.groups[0]!.metrics.costPerMergedTicket.denominator, 0);
  const rq = await privateFile(root, "request", Buffer.from(canonicalJson(req))), trust = await privateFile(root, "roots", Buffer.from(canonicalJson(k.roots)));
  const before = await lstat(r.sessions[0]!.source.path), receipt = await runCohort(rq.path, trust.path, options), published = await lstat(receipt.path);
  assert.deepEqual(await runCohort(rq.path, trust.path, options), receipt);
  assert.equal((await lstat(receipt.path)).mtimeMs, published.mtimeMs); assert.equal((await lstat(r.sessions[0]!.source.path)).mtimeMs, before.mtimeMs);
  const bytes = await readFile(receipt.path), output = JSON.parse(bytes.toString()); validateCohortDocument("publication", output);
  assert.equal(sha256(canonicalJson(output.artifact)), receipt.artifactDigest); assert.equal(sha256(canonicalJson(output.manifest)), receipt.manifestDigest);
  assert.doesNotMatch(bytes.toString(), /SECRET|PRIVATE-CONTENT|private\/credentials|BEGIN PUBLIC KEY|"path"/);
}));
test("ticket metrics include failed fresh runs through merge and keep unmerged waste separate", () => fixture(async (root, options) => {
  const k = keys(), a = runFixture(), b = runFixture(binding("synthetic-run-0002")), c = runFixture({ ...binding("synthetic-run-0003"), ticket: "SYNTH-2", pr: 2 });
  b.candidateSha = "d".repeat(40);
  const all = [a, b, c];
  for (const r of all) {
    r.sessions.push(await historyFixture(root, `${r.runId}-history`));
    const d = dispositionFixture(bound(r)), s = squireFixture(bound(r));
    s.reservedRunIds = r === c ? [c.runId] : [a.runId, b.runId];
    s.classifications = [{ ruleVersion: 1, sessionId: r.sessions[0]!.sessionId, kind: r === a ? "report" : r === c ? "infrastructure" : "none", evidenceRefs: [r.sessions[0]!.source.sha256] }];
    if (r !== b) { d.prState = "closed"; d.merge = null; d.unmergedReason = "closed_unmerged"; s.completion = "failed"; }
    if (r === b) { s.reservedAt = "2026-01-01T00:01:00.000Z"; s.firstCandidate!.implementOrdinal = 2; s.remediationAttempts = 1; d.reopened = true; }
    if (r === c) { s.firstCandidate!.review = "failed"; d.checks[0]!.conclusion = "failure"; }
    await addEvidence(root, r, k, d, s);
  }
  const card = await assembleCohort(request(all), k.roots, options); validateCohortDocument("scorecard", card);
  const t = card.tickets.find(t => t.ticket === "SYNTH-1")!, m = card.groups[0]!.metrics;
  assert.equal(t.inventoryComplete, true); assert.equal(t.firstPass, true); assert.equal(t.freshRuns, 2); assert.equal(t.wallMs, 600000);
  assert.equal(t.accounting.recordedCost.known, "0.246913578"); assert.equal(t.accounting.recordedCost.complete, true);
  assert.equal(m.firstPassAcceptance.numerator, 1); assert.equal(m.firstPassAcceptance.denominator, 2); assert.equal(m.firstPassAcceptance.complete, true);
  assert.equal(m.freshRuns.perMergedTicket.numerator, 2); assert.equal(m.freshRuns.unmerged, 1); assert.equal(m.costPerMergedTicket.numerator, "0.246913578"); assert.equal(m.costPerMergedTicket.denominator, 1);
  assert.equal(m.wallMsPerMergedTicket.numerator, 600000); assert.equal(m.activeMsPerMergedTicket.complete, false);
  assert.equal(m.remediationAttempts.known, 1); assert.equal(m.reportWaste.recordedCost.known, "0.123456789"); assert.equal(m.infrastructureWaste.recordedCost.known, "0.123456789"); assert.equal(m.unmergedAccounting.recordedCost.known, "0.123456789"); assert.equal(m.reopened.yes, 1);
  assert.equal(card.phaseProfileOutcome[0]!.accounting.input.known, 30);
}));
test("unlike model/gate strata are visible, no silent pooling or implicit pre/post boundary", () => fixture(async (root, options) => {
  const a = runFixture(), b = runFixture({ ...binding("synthetic-run-0002"), ticket: "SYNTH-2" }), c = runFixture({ ...binding("synthetic-run-0003"), ticket: "SYNTH-3" });
  b.period = "post"; b.strata.workflow = "workflow-v2"; b.strata.profiles = ["another/model/high"];
  c.period = "post"; c.strata.reviewGate = "different-review";
  const card = await assembleCohort(request([a, b, c]), keys().roots, options);
  assert.equal(card.groups.length, 3); assert.equal(new Set(card.groups.map(g => g.gateClass)).size, 2);
  assert.equal(card.interpretation, "descriptive_only_no_causal_claims");
  await assert.rejects(assembleCohort(request([a, { ...b, ticket: a.ticket }]), keys().roots, options));
}));
test("duplicate/conflicting run, source, session and response attribution fails closed", () => fixture(async (root, options) => {
  const r = runFixture(); r.sessions.push(await historyFixture(root, "history")); const k = keys();
  await assert.rejects(assembleCohort(request([r, r]), k.roots, options));
  const other = runFixture(binding("synthetic-run-0002")); other.sessions = r.sessions;
  await assert.rejects(assembleCohort(request([r, other]), k.roots, options));
  const bad = structuredClone(r); bad.sessions.push({ ...r.sessions[0]!, source: { ...r.sessions[0]!.source, sha256: "f".repeat(64) } });
  await assert.rejects(assembleCohort(request([bad]), k.roots, options));
  const fake = structuredClone(r); fake.telemetry = r.sessions[0]!.source; fake.sessions = [];
  await assert.rejects(assembleCohort(request([fake]), k.roots, options));
}));
test("untrusted evidence and unbound classifications cannot create CI, merge, or waste claims", () => fixture(async (root, options) => {
  const r = runFixture(), k = keys(); r.sessions.push(await historyFixture(root, "history"));
  const d = dispositionFixture(bound(r)), s = squireFixture(bound(r)); s.classifications = [{ ruleVersion: 1, sessionId: r.sessions[0]!.sessionId, kind: "report", evidenceRefs: ["f".repeat(64)] }];
  await addEvidence(root, r, k, d, s); r.disposition!.envelope = null;
  const card = await assembleCohort(request([r]), k.roots, options);
  assert.equal(card.runs[0]!.completion, "completed"); assert.equal(card.runs[0]!.disposition.ci, "unknown"); assert.equal(card.runs[0]!.disposition.merge, "unknown");
  assert.equal(card.tickets[0]!.firstPass, null); assert.equal(card.tickets[0]!.reportWaste.recordedCost.known, "0"); assert.equal(card.tickets[0]!.unknownWaste.recordedCost.known, "0.123456789");
  assert.ok(card.runs[0]!.diagnostics.includes("unbound_classification"));
}));

test("same-gate pre/post ratios are exact, visibly stratified, and null when incomplete", () => fixture(async (root, options) => {
  const k = keys(), pre = runFixture(), post = runFixture({ ...binding("synthetic-run-0002"), ticket: "SYNTH-2" });
  post.period = "post"; post.strata.workflow = "workflow-v2";
  for (const r of [pre, post]) {
    r.sessions.push(await historyFixture(root, `${r.runId}-history`));
    const s = squireFixture(bound(r)); s.classifications = [{ ruleVersion: 1, sessionId: r.sessions[0]!.sessionId, kind: "none", evidenceRefs: [r.sessions[0]!.source.sha256] }];
    if (r === pre) s.firstCandidate!.review = "failed";
    await addEvidence(root, r, k, dispositionFixture(bound(r)), s);
  }
  const card = await assembleCohort(request([pre, post]), k.roots, options); validateCohortDocument("scorecard", card);
  assert.equal(card.comparisons.length, 1); const comparison = card.comparisons[0]!;
  assert.equal(comparison.strataDiffer, true);
  assert.deepEqual(comparison.deltas["firstPassAcceptance"], { numerator: "1", denominator: 1 });
  assert.deepEqual(comparison.deltas["costPerMergedTicket"], { numerator: "0", denominator: 1 });
  assert.deepEqual(comparison.deltas["reportWasteCostPerTicket"], { numerator: "0", denominator: 1 });
  assert.equal(comparison.deltas["activeMsPerMergedTicket"], null);
  assert.equal(card.groups[0]!.metrics.reportWaste.recordedCost.complete, true);
}));

test("missing ticket inventory or uncertain earlier Implement keeps first-pass/cost incomplete", () => fixture(async (root, options) => {
  const k = keys(), a = runFixture(), b = runFixture(binding("synthetic-run-0002"));
  for (const r of [a, b]) {
    r.sessions.push(await historyFixture(root, `${r.runId}-history`));
    const s = squireFixture(bound(r)); s.reservedRunIds = [a.runId, b.runId];
    if (r === a) { s.enteredImplement = null; s.firstCandidate = null; }
    else s.reservedAt = "2026-01-01T00:01:00.000Z";
    await addEvidence(root, r, k, dispositionFixture(bound(r)), s);
  }
  const card = await assembleCohort(request([a, b]), k.roots, options);
  assert.equal(card.tickets[0]!.firstPass, null);
  assert.equal(card.groups[0]!.metrics.firstPassAcceptance.unknownNumerator, 1);
  const subset = await assembleCohort(request([b]), k.roots, options);
  assert.equal(subset.tickets[0]!.inventoryComplete, false); assert.equal(subset.groups[0]!.metrics.costPerMergedTicket.complete, false);
}));

test("controller telemetry uses only the established summary location and preserves active time", () => fixture(async (root, options) => {
  const { buildTelemetry } = await import("../src/personal/telemetry-store.js");
  const { randomUUID } = await import("node:crypto");
  const r = runFixture(), k = keys(), sessionId = randomUUID();
  const t = buildTelemetry({ schemaVersion: 1, authority: "pi-0.84.4-controller-json-v1", runId: r.runId, outcome: "completed", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:02:00.000Z", wallDurationMs: 120000, stateVersion: 10, inventoryComplete: true, phaseOutcomes: { plan: "not_run", implement: "passed", review: "not_run", test: "not_run", retro: "not_run" }, sessions: [{ runId: r.runId, phase: "implement", subphase: null, attempt: 1, correction: 0, sessionId, sessionArtifactDigest: "e".repeat(64), inputHead: head, profile: { provider: "openai", model: "fixture-model", thinking: "medium" }, escalationDigest: null, trigger: "initial", stageIndex: null, stageAttempt: null, startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:01:00.000Z", durationMs: 60000, outcome: "passed", phaseOutcome: "passed", streamDigest: "f".repeat(64), usage: { tokens: { input: 10, output: 3, cacheRead: 20, cacheWrite: 2 }, recordedCost: "0.5", costSource: "pi-recorded", messages: 1, diagnostics: [] } }] });
  r.telemetry = await privateFile(path.join(options.controllerTelemetryRoot, r.runId), "summary", Buffer.from(JSON.stringify(t)));
  const s = squireFixture(bound(r)); s.classifications = [{ ruleVersion: 1, sessionId, kind: "infrastructure", evidenceRefs: [r.telemetry.sha256] }];
  await addEvidence(root, r, k, dispositionFixture(bound(r)), s);
  const card = await assembleCohort(request([r]), k.roots, options); validateCohortDocument("scorecard", card);
  assert.equal(card.runs[0]!.sessions[0]!.authority, "pi-0.84.4-controller-json-v1");
  assert.equal(card.groups[0]!.metrics.activeMsPerMergedTicket.numerator, 60000); assert.equal(card.groups[0]!.metrics.activeMsPerMergedTicket.complete, true);
  assert.equal(card.groups[0]!.metrics.wallMsPerMergedTicket.numerator, 600000);
  assert.equal(card.groups[0]!.metrics.infrastructureWaste.durationMs.known, 60000);
}));

test("synthetic 24-run baseline reconciles exact totals without committing private cohort identities", () => fixture(async (root, options) => {
  const k = keys(), runs: CohortRun[] = [];
  for (let i = 0; i < 24; i++) {
    const r = runFixture({ ...binding(`synthetic-run-${String(i).padStart(4, "0")}`), ticket: `SYNTH-${i + 1}`, pr: i + 1 });
    r.sessions.push(await historyFixture(root, `${r.runId}-history`));
    await addEvidence(root, r, k, dispositionFixture(bound(r)), squireFixture(bound(r))); runs.push(r);
  }
  const req = request(runs);
  const source = await privateFile(root, "baseline", Buffer.from(JSON.stringify({ totals: { input: 240, output: 72, cacheRead: 480, messages: 24, recordedCost: "2.962962936" } })));
  req.baseline = { source, runIds: runs.map(r => r.runId), fields: { input: "/totals/input", output: "/totals/output", cacheRead: "/totals/cacheRead", messages: "/totals/messages", recordedCost: "/totals/recordedCost" } };
  const card = await assembleCohort(req, k.roots, options); validateCohortDocument("scorecard", card);
  assert.equal(card.runs.length, 24); assert.equal(card.accounting.recordedCost.known, "2.962962936");
  assert.ok(card.baseline!.fields.every(f => f.complete && f.variance === "0" && f.reason === "matched"));
  assert.equal(card.groups[0]!.metrics.costPerMergedTicket.denominator, 24);
  assert.equal(card.groups[0]!.metrics.firstPassAcceptance.numerator, 24);
  assert.equal(card.accounting.durationMs.complete, false);
}));
