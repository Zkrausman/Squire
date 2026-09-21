import test from "node:test";
import assert from "node:assert/strict";
import { verifyEvidence, disposition, validateTrustRoots } from "../src/personal/disposition-evidence.js";
import { canonicalJson } from "../src/personal/bounded-json.js";
import { validateCohortDocument } from "../src/personal/cohort-schema.js";
import { binding, dispositionFixture, keys, squireFixture } from "./helpers/cohort.js";

test("Ed25519 canonical detached import authenticates exact head, check set and independent merge", () => {
  const k = keys(), m = dispositionFixture(), s = k.signed(m);
  const result = verifyEvidence("disposition", s.bytes, s.envelope, k.roots, binding());
  assert.equal(result.status, "verified");
  assert.equal(disposition(result).ci, "passed"); assert.equal(disposition(result).merge, "merged");
  m.prState = "open"; m.merge = null; m.unmergedReason = "open";
  const open = k.signed(m); const imported = disposition(verifyEvidence("disposition", open.bytes, open.envelope, k.roots, binding()));
  assert.equal(imported.ci, "passed"); assert.equal(imported.merge, "unmerged");
  const sq = k.signed(squireFixture());
  assert.equal(verifyEvidence("squire", sq.bytes, sq.envelope, k.roots, binding()).status, "verified");
  assert.equal(verifyEvidence("disposition", sq.bytes, sq.envelope, k.roots, binding()).status, "unknown");
});
test("every unsigned, noncanonical, malformed, wrong-key and altered import remains unknown", () => {
  const k = keys(), s = k.signed(dispositionFixture());
  const unknown = (bytes: Buffer | undefined, envelope: Buffer | undefined, roots = k.roots) => {
    const result = verifyEvidence("disposition", bytes, envelope, roots, binding());
    assert.equal(result.status, "unknown"); assert.equal(disposition(result).ci, "unknown"); assert.equal(disposition(result).merge, "unknown");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|BEGIN|\//);
  };
  unknown(s.bytes, undefined); unknown(undefined, s.envelope);
  unknown(Buffer.concat([s.bytes, Buffer.from("\n")]), s.envelope);
  unknown(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), s.bytes]), s.envelope);
  unknown(Buffer.from('{"PRIVATE":1,"PRIVATE":2}'), s.envelope);
  unknown(Buffer.from(s.bytes.toString().replace('"pr":1', '"pr":2')), s.envelope);
  unknown(Buffer.from(s.bytes.toString().replace('"pr":1', '"pr":1.0')), s.envelope);
  for (const [field, value] of [["keyId", "unknown"], ["algorithm", "RSA"], ["manifestDigest", "f".repeat(64)], ["signature", "A".repeat(86) + "=="], ["signature", "bad"], ["signer", "other"], ["provenance", "other"], ["signedAt", "2026-02-01T00:00:00.000Z"]]) {
    unknown(s.bytes, Buffer.from(canonicalJson({ ...JSON.parse(s.envelope.toString()), [field as string]: value })));
  }
  unknown(s.bytes, s.envelope, keys().roots);
  unknown(s.bytes, s.envelope, { schemaVersion: 1, keys: [] });
});
test("rotation selects only exact keyId and checks revocation and signed-time window", () => {
  const k = keys(), s = k.signed(dispositionFixture()), other = keys(); other.roots.keys[0]!.keyId = "rotated";
  const roots = { ...k.roots, keys: [...other.roots.keys, ...k.roots.keys] };
  assert.equal(verifyEvidence("disposition", s.bytes, s.envelope, roots, binding()).status, "verified");
  for (const change of [{ revoked: true }, { notBefore: "2027-01-01T00:00:00.000Z" }, { notAfter: "2025-01-01T00:00:00.000Z" }]) {
    assert.equal(verifyEvidence("disposition", s.bytes, s.envelope, { ...roots, keys: roots.keys.map(key => ({ ...key, ...change })) }, binding()).status, "unknown");
  }
  assert.throws(() => validateTrustRoots({ ...k.roots, keys: [...k.roots.keys, ...k.roots.keys] }));
  assert.throws(() => validateTrustRoots({ ...k.roots, keys: [{ ...k.roots.keys[0], publicKey: k.privateKey.export({ type: "pkcs8", format: "pem" }).toString() }] }));
});
test("authentic signatures do not override run/repository/PR/head/check-set binding or semantics", () => {
  const k = keys(), m = dispositionFixture(), s = k.signed(m);
  for (const b of [{ ...binding(), candidateSha: "c".repeat(40) }, { ...binding(), runId: "synthetic-run-other" }, { ...binding(), repository: "other/repo" }, { ...binding(), pr: 2 }, { ...binding(), requiredCheckSet: { identity: "other", names: ["ci", "codeql"] } }, { ...binding(), requiredCheckSet: { identity: "checks-v1", names: ["ci"] } }]) assert.equal(verifyEvidence("disposition", s.bytes, s.envelope, k.roots, b).status, "unknown");
  for (const mutate of [(v: typeof m) => { v.checks[0]!.headSha = "f".repeat(40); }, (v: typeof m) => { v.checks.push(v.checks[0]!); }, (v: typeof m) => { v.checks[0]!.completedAt = "2027-01-01T00:00:00.000Z"; }, (v: typeof m) => { v.merge = null; }, (v: typeof m) => { v.merge!.at = "2027-01-01T00:00:00.000Z"; }, (v: typeof m) => { v.prState = "open"; }]) {
    const v = structuredClone(m); mutate(v); const signed = k.signed(v); assert.equal(verifyEvidence("disposition", signed.bytes, signed.envelope, k.roots, binding()).status, "unknown");
  }
  m.checks.pop(); let signed = k.signed(m);
  assert.equal(disposition(verifyEvidence("disposition", signed.bytes, signed.envelope, k.roots, binding())).ci, "unknown");
  m.checks[0]!.conclusion = "failure"; signed = k.signed(m);
  const result = disposition(verifyEvidence("disposition", signed.bytes, signed.envelope, k.roots, binding()));
  assert.equal(result.ci, "failed"); assert.equal(result.merge, "merged");
});


test("check names preserve matrix punctuation, spaces and Unicode with exact matching", () => {
  const k = keys(), b = binding();
  b.requiredCheckSet.names = ["windows-launch-capture (20.17.0)", "CI / build [linux, node=22]", "Vérification ✅", "x".repeat(256)];
  validateCohortDocument("checkSet", b.requiredCheckSet);
  const m = dispositionFixture(b), signed = k.signed(m);
  const result = verifyEvidence("disposition", signed.bytes, signed.envelope, k.roots, b);
  assert.equal(result.status, "verified");
  if (result.status === "verified") assert.deepEqual(result.manifest.checks.map(c => c.name), b.requiredCheckSet.names);
  assert.equal(disposition(result).ci, "passed");
  // No trimming, punctuation removal or case folding may bind a different check.
  for (const name of ["windows-launch-capture (20.17.0) ", "windows-launch-capture 20.17.0", "Windows-launch-capture (20.17.0)"]) {
    const changed = structuredClone(m); changed.checks[0]!.name = name;
    const s = k.signed(changed);
    assert.equal(disposition(verifyEvidence("disposition", s.bytes, s.envelope, k.roots, b)).ci, "unknown");
    const changedBinding = structuredClone(b); changedBinding.requiredCheckSet.names[0] = name;
    assert.equal(verifyEvidence("disposition", signed.bytes, signed.envelope, k.roots, changedBinding).status, "unknown");
  }
});

test("check names remain nonempty, bounded and control-free in requests and signed checks", () => {
  const k = keys();
  for (const name of ["", "x".repeat(257), "ci\n", "ci\r", "ci\t", "ci\u0000", "ci\u007f", "ci\u0085"]) {
    assert.throws(() => validateCohortDocument("checkSet", { identity: "checks-v1", names: [name] }));
    const m = dispositionFixture(); m.checks[0]!.name = name;
    const s = k.signed(m);
    assert.deepEqual(verifyEvidence("disposition", s.bytes, s.envelope, k.roots, binding()), { status: "unknown", diagnostic: "malformed_evidence" });
  }
  assert.throws(() => validateCohortDocument("checkSet", { identity: "checks-v1", names: ["matrix (22)", "matrix (22)"] }));
  assert.throws(() => validateCohortDocument("checkSet", { identity: "not an identity", names: ["matrix (22)"] }));
});
