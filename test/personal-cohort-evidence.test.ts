import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, parseBoundedJson, parseCanonicalJson, sha256 } from "../src/personal/canonical-json.js";
import { validateCohortSpec } from "../src/personal/cohort-domain.js";
import { verifyDisposition, validateTrustRoots } from "../src/personal/disposition-evidence.js";
import { extractHistoricalTelemetry } from "../src/personal/historical-telemetry.js";
import { validateRunTelemetry } from "../src/personal/telemetry-store.js";
import { parseArguments } from "../src/personal/cli.js";
import { cohortFixture, signedFixture, sessionFixture } from "./helpers/cohort.js";

test("canonical control JSON rejects duplicate keys, unsafe lexemes, BOM, alternate encodings and depth", () => {
  assert.equal(canonicalJson({ z: [3, { b: true, a: null }], a: 2 }), '{"a":2,"z":[3,{"a":null,"b":true}]}');
  for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":1.0}', '{"a":-0}', '{"a":1e0}', '{"a":9007199254740993}', '{"a":0.1}', '\ufeff{}', '['.repeat(101) + '0' + ']'.repeat(101)]) assert.throws(() => parseBoundedJson(Buffer.from(text)));
  for (const text of ['{}\n', ' { }', '{"b":1,"a":2}', '{"a":"\\u0061"}']) assert.throws(() => parseCanonicalJson(Buffer.from(text)));
  assert.throws(() => parseBoundedJson(Buffer.from([255])));
  assert.throws(() => parseBoundedJson(Buffer.alloc(2 * 1024 * 1024 + 1)));
  assert.equal(canonicalJson(JSON.parse('{"__proto__":{"x":1},"2":2,"10":10}')), '{"10":10,"2":2,"__proto__":{"x":1}}');
});

test("closed bounded cohort schema and exact host CLI grammar", () => {
  const spec = cohortFixture(); validateCohortSpec(spec);
  for (const mutate of [(v: any) => v.runs.push(v.runs[0]), (v: any) => v.schemaVersion++, (v: any) => v.privateKey = "SECRET", (v: any) => v.runs[0].stratum.requiredChecks.push("build"), (v: any) => v.runs[0].sources.push({ ...sessionFixture().source, path: "../secret" })]) { const bad = structuredClone(spec); mutate(bad); assert.throws(() => validateCohortSpec(bad)); }
  assert.equal(parseArguments(["cohort", "input.json", "--trust-roots", "roots.json"])?.command, "cohort");
  for (const args of [["input.json"], ["input.json", "--trust-roots"], ["input.json", "--trust-roots", "--config"], ["input.json", "--trust-roots", "roots.json", "--trust-roots", "roots.json"], ["input.json", "--trust-roots", "roots.json", "--json"], ["--trust-roots", "roots.json", "input.json"]]) assert.equal(parseArguments(["cohort", ...args]), undefined);
  assert.equal(parseArguments(["telemetry", "synthetic-run-0001", "--backfill"]), undefined);
});

test("detached Ed25519 authenticates exact bytes and exact identities, with rotated public keys", () => {
  const s = signedFixture(), other = signedFixture(); other.roots.keys[0]!.keyId = "retired-key";
  const roots = { ...s.roots, keys: [...other.roots.keys, ...s.roots.keys] };
  const result = verifyDisposition(s.bytes, s.envelopeBytes, roots, cohortFixture().runs[0]!);
  assert.equal(result.status, "authenticated"); if (result.status === "authenticated") { assert.equal(result.ci, "passed"); assert.equal(result.prState, "merged"); assert.equal(result.reopened, null); }
  assert.equal(verifyDisposition(s.bytes, s.envelopeBytes, roots, { ...cohortFixture().runs[0]!, candidateHead: "d".repeat(40) }).status, "unknown");
  for (const mutation of [{ revoked: true }, { notBefore: "2027-01-01T00:00:00.000Z" }, { notAfter: "2025-01-01T00:00:00.000Z" }, { keyId: "other-key" }, { signer: "other-operator" }, { publicKey: other.roots.keys[0]!.publicKey }]) {
    assert.deepEqual(verifyDisposition(s.bytes, s.envelopeBytes, { schemaVersion: 1, keys: [{ ...s.roots.keys[0]!, ...mutation }] }, cohortFixture().runs[0]!), { status: "unknown", diagnostic: "invalid_evidence" });
  }
  for (const mutation of [{ algorithm: "RSA" }, { manifestDigest: "0".repeat(64) }, { signature: "SECRET_SIGNATURE" }, { signature: s.envelope.signature.slice(0, -2) }, { keyId: "unknown" }, { signer: "other-operator" }]) assert.equal(verifyDisposition(s.bytes, Buffer.from(canonicalJson({ ...s.envelope, ...mutation })), s.roots, cohortFixture().runs[0]!).status, "unknown");
  for (const bytes of [Buffer.concat([s.bytes, Buffer.from("\n")]), Buffer.from('{}'), Buffer.from('{"runId":"SECRET","runId":"other"}'), Buffer.from([255])]) assert.deepEqual(verifyDisposition(bytes, s.envelopeBytes, s.roots, cohortFixture().runs[0]!), { status: "unknown", diagnostic: "invalid_evidence" });
  assert.throws(() => validateTrustRoots({ ...s.roots, privateKey: "SECRET" }));
});

test("historical assistant-only recorded usage stays provisional and never becomes RunTelemetry", () => {
  const { bytes, source, records } = sessionFixture(); const result = extractHistoricalTelemetry(bytes, source);
  assert.equal(result.diagnostic, "none"); assert.equal(result.totals.messages, 1);
  assert.deepEqual(Object.values(result.totals.tokens).map(t => t.known), [10, 2, 30, 4]); assert.equal(result.totals.recordedCost.known, "0.125"); assert.equal(result.totals.durationMs.complete, false);
  assert.throws(() => validateRunTelemetry(result, "synthetic-run-0001"));
  assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE_PATH|content|\/synthetic/u);
  assert.equal(extractHistoricalTelemetry(Buffer.concat([bytes, Buffer.from("x")]), source).diagnostic, "invalid_or_unavailable_source");
  for (const mutate of [(r: any[]) => delete r[2].message.usage.cost, (r: any[]) => delete r[2].message.usage.cacheWrite]) {
    const r = structuredClone(records); mutate(r); const b = Buffer.from(r.map(v => JSON.stringify(v)).join("\n") + "\n"); const partial = extractHistoricalTelemetry(b, { ...source, digest: sha256(b) }); assert.equal(partial.diagnostic, "incomplete_usage"); assert.equal(partial.totals.tokens.input.known, 10);
  }
  for (const mutate of [(r: any[]) => r.push(r[2]), (r: any[]) => r[0].id = "wrong", (r: any[]) => r[0].version = 2]) {
    const r = structuredClone(records); mutate(r); const b = Buffer.from(r.map(v => JSON.stringify(v)).join("\n") + "\n"); assert.equal(extractHistoricalTelemetry(b, { ...source, digest: sha256(b) }).diagnostic, "invalid_or_unavailable_source");
  }
});

test("signed-but-malformed or incomplete disposition cannot manufacture passing gates", () => {
  const binding = cohortFixture().runs[0]!;
  for (const mutate of [
    (m: any) => m.checks.pop(),
    (m: any) => m.checks.push(m.checks[0]),
    (m: any) => m.checks[0].completedAt = "2027-01-01T00:00:00.000Z",
    (m: any) => m.prState = "closed",
    (m: any) => m.runId = "synthetic-run-9999",
    (m: any) => m.prNumber = 2,
    (m: any) => m.requiredCheckSet = "other-checks",
    (m: any) => m.extra = "SECRET",
    (m: any) => m.waste = [{ ruleVersion: "cohort-v1", sessionId: "example", kind: "infrastructure", reason: "code-test", evidence: ["a".repeat(64)] }],
  ]) {
    const original = signedFixture(); const m = JSON.parse(original.bytes.toString()); mutate(m); const signed = signedFixture(m);
    assert.equal(verifyDisposition(signed.bytes, signed.envelopeBytes, signed.roots, binding).status, "unknown");
  }
  for (const conclusion of ["neutral", "skipped", "unknown", "failure", "cancelled", "timed_out"] as const) {
    const m = JSON.parse(signedFixture().bytes.toString()); m.checks[0].conclusion = conclusion; const signed = signedFixture(m);
    const result = verifyDisposition(signed.bytes, signed.envelopeBytes, signed.roots, binding); assert.equal(result.status, "authenticated");
    if (result.status === "authenticated") assert.equal(result.ci, ["neutral", "skipped", "unknown"].includes(conclusion) ? "unknown" : "failed");
  }
  const signed = signedFixture(); signed.roots.keys[0]!.notBefore = "2026-01-01T00:03:00.000Z"; signed.roots.keys[0]!.notAfter = signed.roots.keys[0]!.notBefore;
  assert.equal(verifyDisposition(signed.bytes, signed.envelopeBytes, signed.roots, binding).status, "authenticated");
});
