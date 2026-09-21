import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { backfillSession } from "../src/personal/historical-telemetry.js";
import { sha256 } from "../src/personal/private-artifact-store.js";
import { historyBytes, profile } from "./helpers/cohort.js";
import type { HistoricalSource } from "../src/personal/cohort-schema.js";
const sessionId = randomUUID();
function source(bytes: Buffer): HistoricalSource { return { source: { identity: "fixture", sha256: sha256(bytes), path: "not-read-by-parser" }, sessionId, format: "pi-0.84.4-session-v3", phase: "implement", profile }; }
function parse(bytes: Buffer) { return backfillSession(bytes, source(bytes)); }
test("retained Pi v3 structured usage stays provisional, exact-decimal, private, and time-incomplete", () => {
  const result = parse(historyBytes(sessionId));
  assert.equal(result.authority, "provisional-pi-0.84.4-session-v3");
  assert.equal(result.accounting.input.known, 10); assert.equal(result.accounting.cacheRead.known, 20); assert.equal(result.accounting.cacheWrite.known, 2);
  assert.equal(result.accounting.output.known, 3); assert.equal(result.accounting.recordedCost.known, "0.123456789");
  assert.equal(result.accounting.messages.known, 1); assert.equal(result.accounting.durationMs.complete, false);
  assert.equal(result.diagnostic, null); assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE|credentials|content/);
});
test("missing costs/tokens preserve independent known subtotals, never estimate prices", () => {
  const result = parse(historyBytes(sessionId, { usage: { input: 9, output: 2 } }));
  assert.equal(result.accounting.input.known, 9); assert.equal(result.accounting.output.complete, true);
  assert.equal(result.accounting.cacheRead.complete, false); assert.equal(result.accounting.recordedCost.known, "0"); assert.equal(result.accounting.recordedCost.complete, false);
  assert.equal(result.diagnostic, "unsupported_or_partial");
  const noUsage = parse(historyBytes(sessionId, { usage: undefined }));
  assert.equal(noUsage.accounting.messages.complete, false);
});
test("duplicate entry/response identities, attribution/digest mismatch and unsafe numbers fail closed", () => {
  const bytes = historyBytes(sessionId), lines = bytes.toString().trimEnd().split("\n");
  const repeated = Buffer.from([...lines, lines[1]].join("\n") + "\n"); assert.equal(parse(repeated).diagnostic, "invalid_source");
  const entry = JSON.parse(lines[1]!); entry.id = "entry-2"; entry.parentId = "entry-1";
  assert.equal(parse(Buffer.from([...lines, JSON.stringify(entry)].join("\n") + "\n")).diagnostic, "invalid_source");
  assert.equal(backfillSession(bytes, { ...source(bytes), sessionId: randomUUID() }).diagnostic, "invalid_source");
  assert.equal(backfillSession(bytes, { ...source(bytes), source: { ...source(bytes).source, sha256: "f".repeat(64) } }).diagnostic, "invalid_source");
  assert.equal(parse(Buffer.from(bytes.toString().replace('"input":10', '"input":1.00000000000000001'))).diagnostic, "invalid_source");
  assert.equal(parse(Buffer.from(bytes.toString().replace('"input":10', '"input":10,"input":10'))).diagnostic, "invalid_source");
  assert.equal(parse(bytes.subarray(0, -1)).diagnostic, "invalid_source");
  assert.equal(parse(Buffer.from([0xff])).diagnostic, "invalid_source");
});
test("unknown providers/versions/record kinds remain unsupported rather than transcript-derived usage", () => {
  assert.equal(parse(historyBytes(sessionId, { provider: "unsupported" })).accounting.input.complete, false);
  const bytes = historyBytes(sessionId);
  assert.equal(parse(Buffer.from(bytes.toString().replace('"version":3', '"version":4'))).diagnostic, "invalid_source");
  const extra = { type: "future_kind", id: "entry-2", parentId: "entry-1", timestamp: "2026-01-01T00:00:00.000Z", usage: { input: 999999 } };
  const result = parse(Buffer.concat([bytes, Buffer.from(JSON.stringify(extra) + "\n")]));
  assert.equal(result.accounting.input.known, 10); assert.equal(result.accounting.input.complete, false); assert.equal(result.excludedRecords, 1);
});
test("long escaped strings use bounded scanner without content extraction", { timeout: 5000 }, () => {
  const bytes = historyBytes(sessionId, { content: [{ type: "text", text: '\\"'.repeat(200000) }] });
  assert.equal(parse(bytes).accounting.input.known, 10);
});
