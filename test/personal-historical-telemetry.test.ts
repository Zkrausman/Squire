import test from "node:test";
import assert from "node:assert/strict";
import { extractHistoricalSession, historicalTotals } from "../src/personal/historical-telemetry.js";
import { parseCohortManifest, validateCohortManifest } from "../src/personal/cohort-manifest.js";
import { manifestFixture, sourceFixture, sessionBytes } from "./helpers/cohort-fixture.js";

test("historical extraction counts structured assistant usage exactly once and never reads text as authority", () => {
  const bytes = sessionBytes(), source = sourceFixture(bytes), result = extractHistoricalSession(bytes, source);
  assert.equal(result.authority, "provisional-pi-session-v1"); assert.equal(result.totals.usageRecords, 1);
  assert.deepEqual(result.totals.tokens.input, { known: 10, complete: true }); assert.deepEqual(result.totals.tokens.cacheRead, { known: 30, complete: true });
  assert.deepEqual(result.totals.recordedCost, { known: "0.1", complete: true, source: "pi-recorded" }); assert.deepEqual(result.totals.activeMs, { known: 10_000, complete: true });
  assert.ok(!JSON.stringify(result).includes("PRIVATE")); assert.ok(!JSON.stringify(result).includes(source.artifact.file));
  assert.deepEqual(historicalTotals([result.totals, result.totals]).recordedCost, { known: "0.2", complete: true, source: "pi-recorded" });
  assert.equal(historicalTotals([result.totals], false).tokens.input.complete, false);
});
test("missing dimensions, unsupported records and malformed/copy records remain visibly incomplete", () => {
  const original = sessionBytes().toString();
  for (const raw of [original.slice(0, -1), original.replace('"version":3', '"version":2'), original.replace('"id":"synthetic-session"', '"id":"other"'), original + original.split("\n")[1] + "\n", original.replace('"input":10', '"input":10,"input":20'), original.replace('"input":10', '"input":10.0000000000000001')]) {
    const bytes = Buffer.from(raw), result = extractHistoricalSession(bytes, sourceFixture(bytes));
    assert.deepEqual(result.diagnostics, ["invalid_source"]); assert.equal(result.totals.recordedCost.complete, false); assert.equal(result.totals.usageRecords, 0);
  }
  for (const raw of [original.replace('"input":10,', ''), original.replace('"input":10', '"input":-1'), original.replace('"input":10', '"input":0.5')]) {
    const bytes = Buffer.from(raw), result = extractHistoricalSession(bytes, sourceFixture(bytes));
    assert.deepEqual(result.totals.tokens.input, { known: 0, complete: false }); assert.deepEqual(result.totals.tokens.output, { known: 2, complete: true });
  }
  const bytes = Buffer.from(original.replace('"cost":{"total":0.1}', '"cost":{}'));
  assert.deepEqual(extractHistoricalSession(bytes, sourceFixture(bytes)).totals.recordedCost, { known: "0", complete: false, source: "pi-recorded" });
  const unsupported = Buffer.from(original + '{"id":"unknown-record","type":"future-event"}\n');
  const result = extractHistoricalSession(unsupported, sourceFixture(unsupported));
  assert.equal(result.inventory.supported, false); assert.equal(result.totals.tokens.input.known, 10); assert.equal(result.totals.tokens.input.complete, false);
  assert.equal(extractHistoricalSession(undefined, sourceFixture()).totals.tokens.input.complete, false);
  assert.equal(extractHistoricalSession(Buffer.from("bad"), sourceFixture()).diagnostics[0], "invalid_source");
});
test("closed cohort manifest binds inventory, strata, provenance, bounds and explicit optimization boundary", () => {
  const m = manifestFixture(); assert.deepEqual(parseCohortManifest(JSON.stringify(m)), m);
  for (const value of [{ ...m, extra: true }, { ...m, optimizationMergeSha: "main" }, { ...m, runs: [] }, { ...m, runs: [m.runs[0], m.runs[0]] }, { ...m, runs: Array(257).fill(m.runs[0]) }]) assert.throws(() => validateCohortManifest(value));
  for (const patch of [{ sources: [m.runs[0]!.sources[0], m.runs[0]!.sources[0]] }, { lifecycleEvidence: [] }, { firstCandidate: { ...m.runs[0]!.firstCandidate, evidenceRefs: [] } }, { strata: { ...m.runs[0]!.strata, extra: "field" } }, { sources: [{ ...m.runs[0]!.sources[0], attempt: 0 }] }, { sources: [{ ...m.runs[0]!.sources[0], waste: { ruleVersion: 1, kind: "infrastructure", cause: "code-test", evidenceRefs: ["a".repeat(64)] } }] }]) assert.throws(() => validateCohortManifest({ ...m, runs: [{ ...m.runs[0], ...patch }] }));
  assert.throws(() => parseCohortManifest(JSON.stringify(m).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')));
  assert.throws(() => parseCohortManifest(" ".repeat(2 * 1024 * 1024 + 1)));
});
