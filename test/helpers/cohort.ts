import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { windowsLaunch } from "../../src/personal/windows-launch.js";
import { sha256 } from "../../src/personal/private-artifact-store.js";
import { canonicalJson } from "../../src/personal/bounded-json.js";
import type { Binding, CohortRun, EvidenceSource, HistoricalSource, SquireManifest, DispositionManifest, SignatureEnvelope, TrustRoots, SignedBinding } from "../../src/personal/cohort-schema.js";
export const head = "a".repeat(40), mergedHead = "b".repeat(40), time = "2026-01-01T00:00:00.000Z", end = "2026-01-01T00:10:00.000Z";
export const profile = { provider: "openai", model: "fixture-model", thinking: "medium" } as const;
export const binding = (runId = "synthetic-run-0001"): Binding => ({ runId, ticket: "SYNTH-1", repository: "fixture/repository", candidateSha: head, pr: 1, requiredCheckSet: { identity: "checks-v1", names: ["ci", "codeql"] } });
export const signedBinding = (b = binding()): SignedBinding => ({ ...b, schemaVersion: 1, signedAt: end, signer: "operator", provenance: "independent-host" });
export const dispositionFixture = (b = binding()): DispositionManifest => ({ ...signedBinding(b), kind: "disposition", checks: b.requiredCheckSet.names.map(name => ({ name, headSha: b.candidateSha, conclusion: "success", completedAt: "2026-01-01T00:05:00.000Z" })), prState: "merged", merge: { sha: mergedHead, at: end }, unmergedReason: null, reopened: false });
export const squireFixture = (b = binding()): SquireManifest => ({ ...signedBinding(b), kind: "squire", ruleVersion: 1, inventoryComplete: true, reservedRunIds: [b.runId], reservedAt: time, endedAt: "2026-01-01T00:02:00.000Z", accountedSessions: [], completion: "completed", enteredImplement: true, firstCandidate: { sha: b.candidateSha, implementOrdinal: 1, reviewAttempt: 1, testAttempt: 1, review: "passed", test: "passed" }, remediationAttempts: 0, classifications: [] });
export function keys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const roots: TrustRoots = { schemaVersion: 1, keys: [{ keyId: "fixture-key", publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(), notBefore: null, notAfter: null, revoked: false, signer: "operator", provenance: "independent-host" }] };
  const signed = (manifest: DispositionManifest | SquireManifest) => {
    const bytes = Buffer.from(canonicalJson(manifest));
    const envelope: SignatureEnvelope = { schemaVersion: 1, manifestDigest: sha256(bytes), keyId: "fixture-key", algorithm: "Ed25519", signature: sign(null, bytes, privateKey).toString("base64"), signer: manifest.signer, provenance: manifest.provenance, signedAt: manifest.signedAt };
    return { bytes, envelope: Buffer.from(canonicalJson(envelope)) };
  };
  return { roots, signed, privateKey };
}
export async function privateFile(root: string, identity: string, bytes: Buffer): Promise<EvidenceSource> {
  const file = path.join(root, `${identity}.json`);
  if (process.platform === "win32") windowsLaunch().persist(file, "", bytes.toString("utf8"));
  else { await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, bytes, { mode: 0o600, flag: "wx" }); }
  return { identity, path: file, sha256: sha256(bytes) };
}
export function historyBytes(sessionId: string, overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from([
    { type: "session", version: 3, id: sessionId, timestamp: time, cwd: "/PRIVATE-CWD-SECRET" },
    { type: "message", id: "entry-1", parentId: null, timestamp: time, message: { role: "assistant", provider: profile.provider, model: profile.model, api: "openai-responses", responseId: `response-${sessionId}`, timestamp: 1, content: [{ type: "text", text: "PROMPT-SECRET /private/credentials" }], usage: { input: 10, output: 3, cacheRead: 20, cacheWrite: 2, cost: { total: 0.123456789 } }, ...overrides } },
  ].map(v => JSON.stringify(v)).join("\n") + "\n");
}
export async function historyFixture(root: string, identity: string): Promise<HistoricalSource> {
  const sessionId = randomUUID(), source = await privateFile(root, identity, historyBytes(sessionId));
  return { source, sessionId, format: "pi-0.84.4-session-v3", phase: "implement", profile };
}
export const runFixture = (b = binding()): CohortRun => ({ ...b, period: "pre", strata: { ticketClass: "maintenance", reviewGate: "review-v1", testGate: "test-v1", publicationGate: "publish-v1", baselineSha: head, workflow: "workflow-v1", profiles: ["openai/fixture-model/medium"], escalationPolicy: "none", correctionPolicy: "none", testSuite: "suite-v1" }, sessions: [], telemetry: null, disposition: null, squire: null });
