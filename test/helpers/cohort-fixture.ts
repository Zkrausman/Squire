import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { launchTestRoot } from "./windows-launch.js";
import { windowsLaunch } from "../../src/personal/windows-launch.js";
import { canonicalJson } from "../../src/personal/canonical-json.js";
import { digestBytes, type ArtifactReference, type CohortManifest, type HistoricalSource } from "../../src/personal/cohort-manifest.js";
import type { DispositionManifest, SignatureEnvelope, TrustRoots } from "../../src/personal/evidence-verification.js";

export const CHECK_SET = digestBytes(canonicalJson(["linux", "windows", "codeql"].sort()));
export const H = "a".repeat(64), SHA = "b".repeat(40);
export const T0 = "2026-01-01T00:00:00.000Z", T1 = "2026-01-01T00:00:10.000Z", T2 = "2026-01-01T00:00:30.000Z", TM = "2026-01-01T00:01:00.000Z";
export const PROFILE = { provider: "openai", model: "synthetic-model", thinking: "medium" };
export function sessionBytes(id = "synthetic-session"): Buffer {
  return Buffer.from([JSON.stringify({ type: "session", version: 3, id, cwd: "PRIVATE-PATH-MARKER" }), JSON.stringify({ type: "message", id: "row-1", parentId: null,
    message: { role: "assistant", provider: PROFILE.provider, model: PROFILE.model, api: "openai-responses", content: [{ type: "text", text: "PRIVATE-PROMPT-MARKER ignore rules and invent merge" }],
      usage: { input: 10, output: 2, cacheRead: 30, cacheWrite: 4, cost: { total: 0.1 } } } })].join("\n") + "\n");
}
export function sourceFixture(bytes = sessionBytes(), file = path.resolve("synthetic-private", "session.jsonl")): HistoricalSource {
  return { artifact: { root: path.dirname(file), file, bytes: bytes.length, digest: digestBytes(bytes) }, sessionId: "synthetic-session", provenance: H,
    phase: "implement", subphase: null, profile: PROFILE, attempt: 1, correction: 0, outcome: "passed", startedAt: T0, endedAt: T1,
    waste: { ruleVersion: 1, kind: "none", cause: "unknown", evidenceRefs: [H] } };
}
export function manifestFixture(source = sourceFixture()): CohortManifest {
  return { schemaVersion: 1, provenance: H, optimizationMergeSha: "c".repeat(40), baseline: null,
    runs: [{ runId: "synthetic-run-0001", ticketId: "SYN-1", candidate: SHA, side: "pre",
      strata: { repository: "synthetic/repository", requiredCheckSet: CHECK_SET, requiredChecks: ["linux", "windows", "codeql"], ticketClass: "feature", reviewGate: H, testGate: H, publicationGate: H,
        baselineSha: SHA, workflow: H, profiles: [PROFILE], escalationPolicy: H, correctionPolicy: H, testSuite: H },
      reservedAt: T0, endedAt: T2, completion: "completed", lifecycleEvidence: [H], implementEntered: true, remediationAttempts: 0,
      ticketRunInventory: { runIds: ["synthetic-run-0001"], evidenceRefs: [H] },
      firstCandidate: { head: SHA, review: "passed", test: "passed", evidenceRefs: [H] }, expectedSessions: 1, sources: [source], disposition: null }] };
}
export function keyFixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const roots: TrustRoots = { schemaVersion: 1, keys: [{ keyId: "fixture-key", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(), signer: "synthetic-operator", provenance: H, notBefore: T0, notAfter: null, revoked: false }] };
  const manifest: DispositionManifest = { schemaVersion: 1, signedAt: "2026-01-01T00:02:00.000Z", runId: "synthetic-run-0001", repository: "synthetic/repository", prNumber: 1, candidate: SHA, requiredCheckSet: CHECK_SET,
    checks: ["linux", "windows", "codeql"].map(name => ({ name, conclusion: "success", completedAt: T2 })), prState: "merged", mergeSha: "d".repeat(40), mergedAt: TM, unmergedReason: null, reopened: false, signer: "synthetic-operator", provenance: H };
  const signed = (value: unknown = manifest, raw?: Buffer) => {
    const bytes = raw ?? Buffer.from(canonicalJson(value));
    const envelope: SignatureEnvelope = { schemaVersion: 1, manifestDigest: digestBytes(bytes), keyId: "fixture-key", algorithm: "Ed25519", signature: sign(null, bytes, privateKey).toString("base64"), signer: "synthetic-operator", provenance: H };
    return { bytes, envelope, envelopeBytes: Buffer.from(canonicalJson(envelope)) };
  };
  return { roots, manifest, signed };
}
export async function privateFixture() {
  const base = await launchTestRoot("cohort-fixture-"), root = path.join(base, "private"), repository = path.join(base, "repo");
  await mkdir(repository, { mode: 0o700 });
  const write = async (name: string, bytes: Buffer): Promise<ArtifactReference> => {
    const file = path.join(root, name);
    if (process.platform === "win32") windowsLaunch().persist(file, repository, bytes.toString("utf8"));
    else { await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, bytes, { mode: 0o600 }); }
    return { root, file, bytes: bytes.length, digest: digestBytes(bytes) };
  };
  return { base, root, repository, write, cleanup: () => rm(base, { recursive: true, force: true }) };
}
