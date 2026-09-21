import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalJson, sha256 } from "../../src/personal/canonical-json.js";
import type { CohortSpec } from "../../src/personal/cohort-domain.js";
import type { DispositionManifest, TrustRoots } from "../../src/personal/disposition-evidence.js";
export const sessionId = "12345678-1234-4234-8234-123456789abc";
export const at = "2026-01-01T00:00:00.000Z";
export function cohortFixture(): CohortSpec {
  return { schemaVersion: 1, optimizationMergeSha: "f".repeat(40), runs: [{ runId: "synthetic-run-0001", ticketId: "SYN-1", side: "pre", candidateHead: "b".repeat(40), prNumber: 1, sources: [], disposition: null,
    stratum: { repository: "synthetic/repository", requiredCheckSet: "checks-v1", requiredChecks: ["build", "test"], ticketClass: "bug", reviewGate: "review-v1", testGate: "test-v1", publicationGate: "publication-v1", baselineSha: "a".repeat(40), workflow: "workflow-v1", modelProfiles: ["synthetic-model"], escalationPolicy: "escalation-v1", correctionPolicy: "correction-v1", testSuite: "suite-v1" } }] };
}
export function manifestFixture(): DispositionManifest {
  const r = cohortFixture().runs[0]!;
  return { schemaVersion: 1, runId: r.runId, repository: r.stratum.repository, prNumber: 1, head: r.candidateHead, requiredCheckSet: r.stratum.requiredCheckSet,
    checks: r.stratum.requiredChecks.map(name => ({ name, conclusion: "success", completedAt: "2026-01-01T00:01:00.000Z" })), prState: "merged", merge: { sha: "c".repeat(40), at: "2026-01-01T00:02:00.000Z" }, unmergedReason: null, signedAt: "2026-01-01T00:03:00.000Z", source: "synthetic-producer", signer: "synthetic-operator", reopened: null, waste: [] };
}
export function signedFixture(manifest = manifestFixture()) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const bytes = Buffer.from(canonicalJson(manifest));
  const envelope = { schemaVersion: 1, manifestDigest: sha256(bytes), keyId: "fixture-key", algorithm: "Ed25519", signature: sign(null, bytes, privateKey).toString("base64"), signer: manifest.signer };
  const roots: TrustRoots = { schemaVersion: 1, keys: [{ keyId: envelope.keyId, publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(), signer: manifest.signer }] };
  return { bytes, envelope, roots, envelopeBytes: Buffer.from(canonicalJson(envelope)) };
}
export function sessionFixture() {
  const records = [{ type: "session", version: 3, id: sessionId, timestamp: at, cwd: "PRIVATE_PATH" },
    { type: "message", id: "user", message: { role: "user", content: "SECRET_PROMPT", usage: { input: 999 } } },
    { type: "message", id: "assistant", message: { role: "assistant", content: "SECRET_OUTPUT", usage: { input: 10, output: 2, cacheRead: 30, cacheWrite: 4, cost: { total: 0.125 } } } }];
  const bytes = Buffer.from(records.map(r => JSON.stringify(r)).join("\n") + "\n");
  return { bytes, records, source: { path: "/synthetic/session.jsonl", digest: sha256(bytes), sessionId, phase: "implement", profile: "synthetic-model" } };
}
