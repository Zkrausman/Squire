import { createPublicKey, verify } from "node:crypto";
import { canonicalJson } from "./bounded-json.js";
import { sha256 } from "./private-artifact-store.js";
import { decodeCohortDocument, validateCohortDocument, type Binding, type DispositionManifest, type SquireManifest, type SignatureEnvelope, type TrustRoots } from "./cohort-schema.js";
export type ImportDiagnostic = "missing_evidence" | "malformed_evidence" | "noncanonical_evidence" | "digest_mismatch" | "untrusted_key" | "invalid_signature" | "binding_mismatch" | "invalid_semantics";
export type VerifiedImport<T> = { status: "verified"; digest: string; manifest: T } | { status: "unknown"; diagnostic: ImportDiagnostic };
function requireClaim(v: unknown): asserts v { if (!v) throw new Error("invalid_semantics"); }
export function validateTrustRoots(roots: unknown): TrustRoots {
  const v = validateCohortDocument<TrustRoots>("trustRoots", roots);
  const ids = new Set<string>();
  for (const key of v.keys) {
    requireClaim(!ids.has(key.keyId)); ids.add(key.keyId);
    // createPublicKey also accepts PRIVATE KEY PEM. Reject it before handing any
    // bytes to crypto: this API accepts only public SPKI Ed25519 roots.
    requireClaim(key.publicKey.startsWith("-----BEGIN PUBLIC KEY-----\n") && key.publicKey.trimEnd().endsWith("-----END PUBLIC KEY-----"));
    const publicKey = createPublicKey(key.publicKey);
    requireClaim(publicKey.asymmetricKeyType === "ed25519" && publicKey.export({ type: "spki", format: "pem" }).toString().trimEnd() === key.publicKey.trimEnd());
    requireClaim(!key.notBefore || !key.notAfter || key.notBefore <= key.notAfter);
  }
  return v;
}
/** Authentication is independent of digest identity. No diagnostic contains input. */
export function verifyEvidence(kind: "disposition", manifestBytes: Buffer | undefined, envelopeBytes: Buffer | undefined, roots: TrustRoots, binding: Binding): VerifiedImport<DispositionManifest>;
export function verifyEvidence(kind: "squire", manifestBytes: Buffer | undefined, envelopeBytes: Buffer | undefined, roots: TrustRoots, binding: Binding): VerifiedImport<SquireManifest>;
export function verifyEvidence<T extends DispositionManifest | SquireManifest>(kind: T["kind"], manifestBytes: Buffer | undefined, envelopeBytes: Buffer | undefined, roots: TrustRoots, binding: Binding): VerifiedImport<T>;
export function verifyEvidence<T extends DispositionManifest | SquireManifest>(kind: T["kind"], manifestBytes: Buffer | undefined, envelopeBytes: Buffer | undefined, roots: TrustRoots, binding: Binding): VerifiedImport<T> {
  let diagnostic: ImportDiagnostic = "malformed_evidence";
  try {
    if (!manifestBytes || !envelopeBytes) return { status: "unknown", diagnostic: "missing_evidence" };
    const m = decodeCohortDocument<T>(kind, manifestBytes), e = decodeCohortDocument<SignatureEnvelope>("envelope", envelopeBytes);
    diagnostic = "noncanonical_evidence";
    requireClaim(manifestBytes.equals(Buffer.from(canonicalJson(m))));
    diagnostic = "digest_mismatch"; const digest = sha256(manifestBytes); requireClaim(digest === e.manifestDigest);
    diagnostic = "untrusted_key"; validateTrustRoots(roots);
    const key = roots.keys.find(k => k.keyId === e.keyId);
    requireClaim(key && !key.revoked && (!key.notBefore || m.signedAt >= key.notBefore) && (!key.notAfter || m.signedAt <= key.notAfter));
    requireClaim(e.signer === key.signer && e.provenance === key.provenance && m.signer === e.signer && m.provenance === e.provenance && m.signedAt === e.signedAt);
    diagnostic = "invalid_signature";
    const signature = Buffer.from(e.signature, "base64");
    requireClaim(signature.length === 64 && signature.toString("base64") === e.signature && verify(null, manifestBytes, createPublicKey(key.publicKey), signature));
    diagnostic = "binding_mismatch";
    for (const field of ["runId", "ticket", "repository", "candidateSha", "pr"] as const) requireClaim(m[field] === binding[field]);
    requireClaim(m.requiredCheckSet.identity === binding.requiredCheckSet.identity && canonicalJson([...m.requiredCheckSet.names].sort()) === canonicalJson([...binding.requiredCheckSet.names].sort()));
    diagnostic = "invalid_semantics";
    if (m.kind === "disposition") {
      requireClaim(new Set(m.checks.map(c => c.name)).size === m.checks.length);
      requireClaim(m.checks.every(c => c.headSha === m.candidateSha && c.completedAt <= m.signedAt));
      requireClaim(m.prState === "merged" ? m.merge !== null && m.unmergedReason === null && m.merge.at <= m.signedAt : m.merge === null && m.unmergedReason !== null && (m.prState !== "open" || m.unmergedReason === "open"));
    } else {
      requireClaim(m.reservedAt <= m.signedAt && (m.endedAt === null || (m.endedAt >= m.reservedAt && m.endedAt <= m.signedAt)));
      requireClaim(new Set(m.accountedSessions.map(s => s.sessionId)).size === m.accountedSessions.length);
      requireClaim(m.firstCandidate === null || m.enteredImplement === true);
      requireClaim(new Set(m.classifications.map(c => c.sessionId)).size === m.classifications.length);
    }
    return { status: "verified", digest, manifest: m };
  } catch { return { status: "unknown", diagnostic }; }
}
export interface Disposition { ci: "passed" | "failed" | "unknown"; merge: "merged" | "unmerged" | "unknown"; mergeSha: string | null; mergedAt: string | null; reopened: boolean | null; evidenceDigest: string | null; diagnostic: ImportDiagnostic | null; }
export function disposition(result: VerifiedImport<DispositionManifest>): Disposition {
  if (result.status === "unknown") return { ci: "unknown", merge: "unknown", mergeSha: null, mergedAt: null, reopened: null, evidenceDigest: null, diagnostic: result.diagnostic };
  const m = result.manifest;
  const checks = m.requiredCheckSet.names.map(n => m.checks.find(c => c.name === n));
  const ci = checks.every(c => c?.conclusion === "success") ? "passed" : checks.some(c => c && ["failure", "cancelled", "timed_out", "action_required"].includes(c.conclusion)) ? "failed" : "unknown";
  return { ci, merge: m.merge ? "merged" : m.unmergedReason === "not_verified" ? "unknown" : "unmerged", mergeSha: m.merge?.sha ?? null, mergedAt: m.merge?.at ?? null, reopened: m.reopened, evidenceDigest: result.digest, diagnostic: null };
}
