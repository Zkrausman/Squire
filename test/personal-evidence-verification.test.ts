import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "../src/personal/canonical-json.js";
import { verifyDisposition, validateTrustRoots, dispositionManifestSchema } from "../src/personal/evidence-verification.js";
import { checkName, requiredCheckSetDigest, digestBytes, parseCohortManifest, validateCohortManifest } from "../src/personal/cohort-manifest.js";
import { keyFixture, manifestFixture, T0, T1 } from "./helpers/cohort-fixture.js";

test("detached Ed25519 binds exact canonical evidence, exact head, checks, signer and configured key", () => {
  const f = keyFixture(), run = manifestFixture().runs[0]!, signed = f.signed();
  const result = verifyDisposition(signed.bytes, signed.envelopeBytes, f.roots, run);
  assert.equal(result.authority, "authenticated-import-v1"); assert.equal(result.ci, "passed"); assert.equal(result.merge, "merged"); assert.equal(result.reopened, false);
  for (const patch of [{ candidate: "e".repeat(40) }, { runId: "synthetic-run-other" }, { strata: { ...run.strata, repository: "other/repo" } }, { strata: { ...run.strata, requiredCheckSet: "f".repeat(64) } }]) {
    const unknown = verifyDisposition(signed.bytes, signed.envelopeBytes, f.roots, { ...run, ...patch });
    assert.equal(unknown.merge, "unknown"); assert.equal(unknown.ci, "unknown"); assert.deepEqual(unknown.diagnostics, ["unbound_evidence"]);
  }
  const subset = verifyDisposition(signed.bytes, signed.envelopeBytes, f.roots, { ...run, strata: { ...run.strata, requiredChecks: ["linux"] } });
  assert.equal(subset.ci, "unknown"); assert.equal(subset.merge, "unknown");
  const missingCheck = f.signed({ ...f.manifest, checks: f.manifest.checks.slice(1) });
  assert.equal(verifyDisposition(missingCheck.bytes, missingCheck.envelopeBytes, f.roots, run).ci, "unknown");
  assert.equal(verifyDisposition(missingCheck.bytes, missingCheck.envelopeBytes, f.roots, run).merge, "merged");
  const failure = f.signed({ ...f.manifest, checks: f.manifest.checks.map(c => ({ ...c, conclusion: "failure" })) });
  assert.equal(verifyDisposition(failure.bytes, failure.envelopeBytes, f.roots, run).ci, "failed");
  const unmerged = f.signed({ ...f.manifest, prState: "closed", mergeSha: null, mergedAt: null, unmergedReason: "not-delivered" });
  assert.equal(verifyDisposition(unmerged.bytes, unmerged.envelopeBytes, f.roots, run).merge, "unmerged");
});
test("all unauthenticated or malformed evidence remains unknown with bounded content-free diagnostics", () => {
  const f = keyFixture(), run = manifestFixture().runs[0]!, s = f.signed();
  const unknown = (bytes = s.bytes, envelope: Buffer | undefined = s.envelopeBytes, roots = f.roots) => {
    const result = verifyDisposition(bytes, envelope, roots, run);
    assert.equal(result.authority, "unknown"); assert.equal(result.ci, "unknown"); assert.equal(result.merge, "unknown");
    assert.ok(JSON.stringify(result).length < 400); assert.ok(!JSON.stringify(result).includes("PRIVATE"));
  };
  unknown(s.bytes, Buffer.from("PRIVATE-MALFORMED-EVIDENCE"));
  assert.equal(verifyDisposition(s.bytes, undefined, f.roots, run).merge, "unknown");
  unknown(s.bytes, s.envelopeBytes, { schemaVersion: 1, keys: [] });
  for (const patch of [{ keyId: "unknown-key" }, { algorithm: "RSA" }, { manifestDigest: "0".repeat(64) }, { signature: "!".repeat(88) }, { signature: Buffer.alloc(64).toString("base64") }, { signer: "another-signer" }, { provenance: "0".repeat(64) }, { privateKey: "PRIVATE" }]) unknown(s.bytes, Buffer.from(JSON.stringify({ ...s.envelope, ...patch })));
  for (const patch of [{ revoked: true }, { notBefore: "2027-01-01T00:00:00.000Z" }, { notAfter: T1 }, { signer: "other" }, { provenance: "0".repeat(64) }]) unknown(s.bytes, s.envelopeBytes, { ...f.roots, keys: [{ ...f.roots.keys[0]!, ...patch }] });
  for (const bytes of [Buffer.concat([s.bytes, Buffer.from("\n")]), Buffer.from('\ufeff' + s.bytes.toString()), Buffer.from(JSON.stringify(f.manifest, null, 2)), Buffer.from(s.bytes.toString().replace('"schemaVersion":1', '"schemaVersion":1.0')), Buffer.from(s.bytes.toString().replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'))]) { const signed = f.signed(undefined, bytes); unknown(bytes, signed.envelopeBytes); }
  for (const patch of [{ checks: [f.manifest.checks[0], f.manifest.checks[0]] }, { mergedAt: null }, { unmergedReason: "not-merged" }, { signedAt: T0 }, { prNumber: 0 }, { extra: "PRIVATE" }]) { const signed = f.signed({ ...f.manifest, ...patch }); unknown(signed.bytes, signed.envelopeBytes); }
});
test("rotation uses the exact configured key, not alternate-key trial or private keys", () => {
  const f = keyFixture(), other = keyFixture(), run = manifestFixture().runs[0]!, s = f.signed();
  const roots = { schemaVersion: 1 as const, keys: [{ ...other.roots.keys[0]!, keyId: "next-key" }, f.roots.keys[0]!] };
  assert.equal(verifyDisposition(s.bytes, s.envelopeBytes, roots, run).ci, "passed");
  const wrongId = Buffer.from(canonicalJson({ ...s.envelope, keyId: "next-key" }));
  assert.equal(verifyDisposition(s.bytes, wrongId, roots, run).ci, "unknown");
  assert.throws(() => validateTrustRoots({ ...roots, keys: [roots.keys[0], roots.keys[0]] }));
  assert.throws(() => validateTrustRoots({ schemaVersion: 1, keys: [{ ...f.roots.keys[0], publicKey: "-----BEGIN PRIVATE KEY-----\nPRIVATE" }] }));
});

test("exact matrix and CodeQL check names survive cohort parsing, hashing and signed imports", () => {
  const f = keyFixture(), cohort = manifestFixture(), run = cohort.runs[0]!;
  const names = ["Analyze (javascript-typescript)", "windows-launch-capture (22.9.0)", "Build / Linux [Node 24]", "Tests — 日本語 ✅"];
  run.strata.requiredChecks = names;
  run.strata.requiredCheckSet = requiredCheckSetDigest(names);
  assert.equal(run.strata.requiredCheckSet, digestBytes(canonicalJson([...names].sort())));
  assert.equal(requiredCheckSetDigest([...names].reverse()), run.strata.requiredCheckSet);
  assert.deepEqual(parseCohortManifest(Buffer.from(canonicalJson(cohort))).runs[0]!.strata.requiredChecks, names);
  const manifest = { ...f.manifest, requiredCheckSet: run.strata.requiredCheckSet,
    checks: names.map(name => ({ ...f.manifest.checks[0]!, name })) };
  const signed = f.signed(manifest);
  const result = verifyDisposition(signed.bytes, signed.envelopeBytes, f.roots, run);
  assert.equal(result.authority, "authenticated-import-v1");
  assert.equal(result.ci, "passed"); assert.equal(result.merge, "merged");
  // Renaming an exact identity must not manufacture a matching required check.
  for (const name of [names[0]!.replace(/[ ()]/gu, ""), names[0]!.toLowerCase(), ` ${names[0]} `]) {
    assert.notEqual(requiredCheckSetDigest([name]), requiredCheckSetDigest([names[0]]));
    const changed = f.signed({ ...manifest, checks: [{ ...manifest.checks[0]!, name }, ...manifest.checks.slice(1)] });
    const result = verifyDisposition(changed.bytes, changed.envelopeBytes, f.roots, run);
    assert.equal(result.ci, "unknown"); assert.equal(result.merge, "merged");
  }
  assert.notEqual(requiredCheckSetDigest(["é"]), requiredCheckSetDigest(["e\u0301"]));
  const duplicate = f.signed({ ...manifest, checks: [...manifest.checks, manifest.checks[0]] });
  assert.equal(verifyDisposition(duplicate.bytes, duplicate.envelopeBytes, f.roots, run).authority, "unknown");
});

test("check names share strict byte, Unicode and control bounds across schemas and hashing", () => {
  for (const name of ["x".repeat(256), "é".repeat(128), " check (matrix) "]) assert.equal(checkName(name), name);
  const f = keyFixture();
  for (const name of ["", "x".repeat(257), "é".repeat(129), "check\nname", "check\tname", "check\u0000", "check\u007f", "check\u0085", "\ud800", 123, null]) {
    assert.throws(() => checkName(name));
    assert.throws(() => requiredCheckSetDigest([name]));
    const cohort = manifestFixture(), run = cohort.runs[0]!;
    assert.throws(() => validateCohortManifest({ ...cohort, runs: [{ ...run, strata: { ...run.strata, requiredChecks: [name] } }] }));
    assert.throws(() => dispositionManifestSchema({ ...f.manifest, checks: [{ ...f.manifest.checks[0], name }] }));
  }
  for (const names of [[], ["same", "same"], Array.from({ length: 101 }, (_, i) => `check (${i})`)]) {
    assert.throws(() => requiredCheckSetDigest(names));
  }
  // Even correctly signed malformed names cannot contribute authority.
  const malformed = f.signed({ ...f.manifest, checks: [{ ...f.manifest.checks[0], name: "check\nname" }] });
  assert.equal(verifyDisposition(malformed.bytes, malformed.envelopeBytes, f.roots, manifestFixture().runs[0]!).authority, "unknown");
});
