import { createPublicKey, verify } from "node:crypto";
import { canonicalJson, parseBoundedJson } from "./canonical-json.js";
import { bool, check, checkName, requiredCheckSetDigest, choice, COHORT_LIMITS, count, digestBytes, hash, head, list, nullable, shape, text, timestamp, unique, type CohortRun } from "./cohort-manifest.js";

const publicKey = (value: unknown): string => { check(typeof value === "string" && value.length <= 256 && value.startsWith("-----BEGIN PUBLIC KEY-----\n") && !value.includes("PRIVATE")); const key = createPublicKey(value); check(key.asymmetricKeyType === "ed25519"); return value; };
export const trustRootSchema = shape({ schemaVersion: choice(1), keys: list(shape({ keyId: text, publicKey, signer: text, provenance: hash,
  notBefore: nullable(timestamp), notAfter: nullable(timestamp), revoked: bool }), 32) });
export type TrustRoots = ReturnType<typeof trustRootSchema>;
export function validateTrustRoots(value: unknown): TrustRoots {
  const roots = trustRootSchema(value); unique(roots.keys, k => k.keyId);
  for (const k of roots.keys) check(k.notBefore === null || k.notAfter === null || k.notBefore <= k.notAfter);
  return roots;
}
export function parseTrustRoots(bytes: Buffer): TrustRoots { return validateTrustRoots(parseBoundedJson(bytes, { ...COHORT_LIMITS, maxBytes: 32 * 1024 })); }
const signature = (value: unknown): string => { check(typeof value === "string" && value.length === 88 && Buffer.from(value, "base64").length === 64 && Buffer.from(value, "base64").toString("base64") === value); return value; };
export const signatureEnvelopeSchema = shape({ schemaVersion: choice(1), manifestDigest: hash, keyId: text, algorithm: choice("Ed25519"), signature, signer: text, provenance: hash });
export type SignatureEnvelope = ReturnType<typeof signatureEnvelopeSchema>;
export const dispositionManifestSchema = shape({ schemaVersion: choice(1), signedAt: timestamp, runId: text, repository: text, prNumber: count, candidate: head, requiredCheckSet: hash,
  checks: list(shape({ name: checkName, conclusion: choice("success", "failure", "cancelled", "timed_out", "skipped", "neutral", "action_required", "unknown"), completedAt: timestamp }), 100),
  prState: choice("open", "closed", "merged"), mergeSha: nullable(head), mergedAt: nullable(timestamp), unmergedReason: nullable(text),
  reopened: nullable(bool), signer: text, provenance: hash });
export type DispositionManifest = ReturnType<typeof dispositionManifestSchema>;
export interface VerifiedDisposition {
  authority: "authenticated-import-v1" | "unknown";
  manifestDigest: string | null; ci: "passed" | "failed" | "unknown"; merge: "merged" | "unmerged" | "unknown";
  mergedAt: string | null; mergeSha: string | null; reopened: boolean | null; diagnostics: ("missing_evidence" | "invalid_evidence" | "unbound_evidence")[];
}
export const unknownDisposition = (diagnostic: VerifiedDisposition["diagnostics"][number] = "missing_evidence"): VerifiedDisposition => ({ authority: "unknown", manifestDigest: null, ci: "unknown", merge: "unknown", mergedAt: null, mergeSha: null, reopened: null, diagnostics: [diagnostic] });
/** Import only. SHA-256 is identity, never authentication. No key discovery. */
export function verifyDisposition(bytes: Buffer | undefined, envelopeBytes: Buffer | undefined, roots: TrustRoots, run: Pick<CohortRun, "runId" | "candidate" | "strata">): VerifiedDisposition {
  if (!bytes || !envelopeBytes) return unknownDisposition();
  try {
    roots = validateTrustRoots(roots);
    const raw = parseBoundedJson(bytes, { ...COHORT_LIMITS, maxBytes: 128 * 1024 });
    check(Buffer.from(canonicalJson(raw)).equals(bytes));
    const manifest = dispositionManifestSchema(raw), envelope = signatureEnvelopeSchema(parseBoundedJson(envelopeBytes, { ...COHORT_LIMITS, maxBytes: 4096 }));
    const digest = digestBytes(bytes); check(envelope.manifestDigest === digest);
    const key = roots.keys.find(k => k.keyId === envelope.keyId);
    check(key && !key.revoked && (key.notBefore === null || manifest.signedAt >= key.notBefore) && (key.notAfter === null || manifest.signedAt <= key.notAfter));
    check(key.signer === envelope.signer && envelope.signer === manifest.signer && key.provenance === envelope.provenance && envelope.provenance === manifest.provenance);
    check(verify(null, bytes, createPublicKey(key.publicKey), Buffer.from(envelope.signature, "base64")));
    check(manifest.prNumber > 0); unique(manifest.checks, c => c.name);
    check(manifest.checks.every(c => c.completedAt <= manifest.signedAt));
    if (manifest.prState === "merged") check(manifest.mergeSha !== null && manifest.mergedAt !== null && manifest.mergedAt <= manifest.signedAt && manifest.unmergedReason === null);
    else check(manifest.mergeSha === null && manifest.mergedAt === null && manifest.unmergedReason !== null);
    if (manifest.runId !== run.runId || manifest.repository !== run.strata.repository || manifest.candidate !== run.candidate || manifest.requiredCheckSet !== run.strata.requiredCheckSet) return unknownDisposition("unbound_evidence");
    check(run.strata.requiredCheckSet === requiredCheckSetDigest(run.strata.requiredChecks));
    const checks = run.strata.requiredChecks.map(name => manifest.checks.find(c => c.name === name));
    const ci = checks.some(c => c && ["failure", "cancelled", "timed_out", "action_required"].includes(c.conclusion)) ? "failed" : checks.length && checks.every(c => c?.conclusion === "success") ? "passed" : "unknown";
    return { authority: "authenticated-import-v1", manifestDigest: digest, ci, merge: manifest.prState === "merged" ? "merged" : "unmerged", mergedAt: manifest.mergedAt, mergeSha: manifest.mergeSha, reopened: manifest.reopened, diagnostics: [] };
  } catch { return unknownDisposition("invalid_evidence"); }
}
