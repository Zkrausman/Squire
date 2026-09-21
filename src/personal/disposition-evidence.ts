import { createPublicKey, verify } from "node:crypto";
import { canonicalJson, checkName, closed, cohortAssert as assert, digest, head, identity, list, parseBoundedJson, parseCanonicalJson, safeCount, sha256, time, unique } from "./canonical-json.js";
import { validateWaste, type CohortRun, type WasteClassification } from "./cohort-domain.js";
import { validateTelemetryRunId } from "./telemetry-store.js";

export interface DispositionManifest {
  schemaVersion: 1; runId: string; repository: string; prNumber: number; head: string;
  requiredCheckSet: string; checks: { name: string; conclusion: "success" | "failure" | "cancelled" | "timed_out" | "neutral" | "skipped" | "unknown"; completedAt: string }[];
  prState: "open" | "closed" | "merged"; merge: { sha: string; at: string } | null; unmergedReason: string | null;
  signedAt: string; source: string; signer: string; reopened: boolean | null; waste: WasteClassification[];
}
export interface SignatureEnvelope { schemaVersion: 1; manifestDigest: string; keyId: string; algorithm: "Ed25519"; signature: string; signer: string; }
export interface TrustRoot { keyId: string; publicKey: string; signer: string; notBefore?: string; notAfter?: string; revoked?: boolean; }
export interface TrustRoots { schemaVersion: 1; keys: TrustRoot[]; }
export type Disposition = { status: "unknown"; diagnostic: "missing_evidence" | "invalid_evidence" | "binding_mismatch" } | {
  status: "authenticated"; manifestDigest: string; source: string; signer: string; keyId: string;
  head: string; prNumber: number; requiredCheckSet: string; checks: DispositionManifest["checks"]; signedAt: string; unmergedReason: string | null;
  ci: "passed" | "failed" | "unknown"; prState: DispositionManifest["prState"]; merge: DispositionManifest["merge"]; reopened: boolean | null;
  waste: WasteClassification[];
};
export function validateDispositionManifest(value: unknown): asserts value is DispositionManifest {
  const v = value as DispositionManifest;
  closed(v, ["schemaVersion", "runId", "repository", "prNumber", "head", "requiredCheckSet", "checks", "prState", "merge", "unmergedReason", "signedAt", "source", "signer", "reopened", "waste"]);
  assert(v.schemaVersion === 1); validateTelemetryRunId(v.runId); identity(v.repository); assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(v.repository)); safeCount(v.prNumber); assert(v.prNumber > 0); head(v.head); identity(v.requiredCheckSet); time(v.signedAt); identity(v.source); identity(v.signer);
  list(v.checks, 100, 1); unique(v.checks.map(c => c.name));
  for (const c of v.checks) { closed(c, ["name", "conclusion", "completedAt"]); checkName(c.name); assert(["success", "failure", "cancelled", "timed_out", "neutral", "skipped", "unknown"].includes(c.conclusion)); time(c.completedAt); assert(c.completedAt <= v.signedAt); }
  assert(["open", "closed", "merged"].includes(v.prState));
  if (v.prState === "merged") { closed(v.merge, ["sha", "at"]); head(v.merge!.sha); time(v.merge!.at); assert(v.merge!.at <= v.signedAt && v.unmergedReason === null); }
  else { assert(v.merge === null); identity(v.unmergedReason); }
  assert(v.reopened === null || typeof v.reopened === "boolean"); list(v.waste, 1000); v.waste.forEach(validateWaste); unique(v.waste.map(w => w.sessionId));
}
export function validateTrustRoots(value: unknown): asserts value is TrustRoots {
  const v = value as TrustRoots; closed(v, ["schemaVersion", "keys"]); assert(v.schemaVersion === 1); list(v.keys, 32); unique(v.keys.map(k => k.keyId));
  for (const k of v.keys) {
    closed(k, ["keyId", "publicKey", "signer"], ["notBefore", "notAfter", "revoked"]); identity(k.keyId); identity(k.signer);
    assert(typeof k.publicKey === "string" && k.publicKey.length <= 512 && /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----\r?\n?$/u.test(k.publicKey));
    assert(createPublicKey(k.publicKey).asymmetricKeyType === "ed25519");
    if (k.notBefore !== undefined) time(k.notBefore); if (k.notAfter !== undefined) time(k.notAfter);
    assert(!k.notBefore || !k.notAfter || k.notBefore <= k.notAfter); assert(k.revoked === undefined || typeof k.revoked === "boolean");
  }
}
/** Authentication errors are intentionally indistinguishable and never carry input text. */
export function verifyDisposition(manifestBytes: Buffer, envelopeBytes: Buffer, roots: TrustRoots, binding: CohortRun): Disposition {
  try {
    validateTrustRoots(roots);
    const m = parseCanonicalJson(manifestBytes); validateDispositionManifest(m);
    const e = parseBoundedJson(envelopeBytes) as SignatureEnvelope;
    closed(e, ["schemaVersion", "manifestDigest", "keyId", "algorithm", "signature", "signer"]);
    assert(e.schemaVersion === 1 && e.algorithm === "Ed25519"); digest(e.manifestDigest); identity(e.keyId); identity(e.signer);
    assert(e.manifestDigest === sha256(manifestBytes) && e.signer === m.signer);
    assert(typeof e.signature === "string" && /^[A-Za-z0-9+/]{86}==$/u.test(e.signature));
    const signature = Buffer.from(e.signature, "base64"); assert(signature.length === 64 && signature.toString("base64") === e.signature);
    const key = roots.keys.find(k => k.keyId === e.keyId);
    assert(key && !key.revoked && key.signer === m.signer && (!key.notBefore || m.signedAt >= key.notBefore) && (!key.notAfter || m.signedAt <= key.notAfter));
    assert(verify(null, manifestBytes, createPublicKey(key.publicKey), signature));
    if (m.runId !== binding.runId || m.repository !== binding.stratum.repository || m.prNumber !== binding.prNumber || m.head !== binding.candidateHead || m.requiredCheckSet !== binding.stratum.requiredCheckSet || canonicalJson(m.checks.map(c => c.name).sort()) !== canonicalJson(binding.stratum.requiredChecks)) return { status: "unknown", diagnostic: "binding_mismatch" };
    const ci = m.checks.every(c => c.conclusion === "success") ? "passed" : m.checks.some(c => ["failure", "cancelled", "timed_out"].includes(c.conclusion)) ? "failed" : "unknown";
    return { status: "authenticated", manifestDigest: e.manifestDigest, source: m.source, signer: m.signer, keyId: key.keyId, head: m.head, prNumber: m.prNumber, requiredCheckSet: m.requiredCheckSet, checks: m.checks, signedAt: m.signedAt, unmergedReason: m.unmergedReason, ci, prState: m.prState, merge: m.merge, reopened: m.reopened, waste: m.waste };
  } catch { return { status: "unknown", diagnostic: "invalid_evidence" }; }
}
