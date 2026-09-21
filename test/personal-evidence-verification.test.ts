import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "../src/personal/canonical-json.js";
import { verifyDisposition, validateTrustRoots } from "../src/personal/evidence-verification.js";
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
