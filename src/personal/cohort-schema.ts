import AjvImport, { type ValidateFunction } from "ajv/dist/2020.js";
import FormatsImport from "ajv-formats";
import schemas from "../../contracts/cohort/v1/cohort.schema.json" with { type: "json" };
import { parseBoundedJson } from "./bounded-json.js";
import type { PhaseProfile } from "./model-policy.js";
export const COHORT_SCHEMAS = schemas;
interface AjvLike { addSchema(v: object): void; compile(v: object): ValidateFunction; }
const Ajv = AjvImport as unknown as new (options: object) => AjvLike;
const ajv = new Ajv({ strict: true, allErrors: false });
(FormatsImport as unknown as (a: AjvLike) => void)(ajv); ajv.addSchema(schemas);
const validators = new Map<string, ValidateFunction>();
export function validateCohortDocument<T>(name: keyof typeof schemas.$defs, value: unknown): T {
  let validator = validators.get(name);
  if (!validator) { validator = ajv.compile({ $ref: `urn:squire:cohort:v1#/$defs/${name}` }); validators.set(name, validator); }
  if (!validator(value)) throw new Error("invalid cohort document");
  return value as T;
}
export function decodeCohortDocument<T>(name: keyof typeof schemas.$defs, bytes: Buffer): T {
  if (bytes.length > 2 * 1024 * 1024) throw new Error("cohort byte bound exceeded");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  return validateCohortDocument<T>(name, parseBoundedJson(text, { maxBytes: 2 * 1024 * 1024, safeIntegers: true }));
}
export interface EvidenceSource { identity: string; path: string; sha256: string; }
export interface CheckSet { identity: string; names: string[]; }
export interface Binding { runId: string; ticket: string; repository: string; candidateSha: string; pr: number; requiredCheckSet: CheckSet; }
export interface Strata { ticketClass: string; reviewGate: string; testGate: string; publicationGate: string; baselineSha: string; workflow: string; profiles: string[]; escalationPolicy: string; correctionPolicy: string; testSuite: string; }
export interface HistoricalSource { source: EvidenceSource; sessionId: string; format: "pi-0.84.4-session-v3"; phase: "plan" | "implement" | "review" | "test" | "retro" | "unknown"; profile: PhaseProfile; }
export interface EvidenceImport { manifest: EvidenceSource; envelope: EvidenceSource | null; }
export interface CohortRun extends Binding { period: "pre" | "post"; strata: Strata; sessions: HistoricalSource[]; telemetry: EvidenceSource | null; disposition: EvidenceImport | null; squire: EvidenceImport | null; }
export interface CohortRequest { schemaVersion: 1; cohortId: string; optimizationMergeSha: string; runs: CohortRun[]; baseline: { source: EvidenceSource; runIds: string[]; fields: Record<"input" | "output" | "cacheRead" | "messages" | "recordedCost", string> } | null; }
export interface SignedBinding extends Binding { schemaVersion: 1; signedAt: string; signer: string; provenance: string; }
export interface DispositionManifest extends SignedBinding { kind: "disposition"; checks: { name: string; headSha: string; conclusion: "success" | "failure" | "cancelled" | "skipped" | "neutral" | "timed_out" | "action_required" | "unknown"; completedAt: string }[]; prState: "open" | "closed" | "merged"; merge: { sha: string; at: string } | null; unmergedReason: "open" | "closed_unmerged" | "not_verified" | null; reopened: boolean | null; }
export interface SquireManifest extends SignedBinding { kind: "squire"; ruleVersion: 1; inventoryComplete: boolean; reservedRunIds: string[]; reservedAt: string; endedAt: string | null; accountedSessions: { sessionId: string; sourceDigest: string }[]; completion: "completed" | "failed" | "interrupted" | "unknown"; enteredImplement: boolean | null; firstCandidate: { sha: string; implementOrdinal: number; reviewAttempt: number; testAttempt: number; review: "passed" | "failed" | "unknown"; test: "passed" | "failed" | "unknown" } | null; remediationAttempts: number | null; classifications: { ruleVersion: 1; sessionId: string; kind: "report" | "infrastructure" | "code" | "none" | "unknown"; evidenceRefs: string[] }[]; }
export interface SignatureEnvelope { schemaVersion: 1; manifestDigest: string; keyId: string; algorithm: "Ed25519"; signature: string; signer: string; provenance: string; signedAt: string; }
export interface TrustRoots { schemaVersion: 1; keys: { keyId: string; publicKey: string; notBefore: string | null; notAfter: string | null; revoked: boolean; signer: string; provenance: string }[]; }
