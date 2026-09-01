import { readFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020Import, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { ContractReference } from "../control/domain.js";
import type { ImmutableArtifactReader } from "../control/safe-artifact-reader.js";

const NAMES = ["common", "implementation-plan", "normalized-ticket", "phase-input", "phase-result", "phase-trigger", "pull-request-delivery-state", "review-findings", "runtime-resolution", "test-evidence", "transition-request", "workflow-config"] as const;
export const V1_SCHEMA_IDS = new Set(NAMES.map(name => `urn:squire:contracts:v1:${name}`));
export class ArtifactValidationError extends Error { constructor(message: string) { super(message); this.name = "ArtifactValidationError"; } }
export type JsonObject = Record<string, unknown>;

export interface TrustedValidation<T extends JsonObject> {
  schemaId: string;
  semantic(document: T): readonly string[];
}

export class V1ArtifactValidator {
  readonly #validators: Map<string, ValidateFunction>;
  readonly #reader: ImmutableArtifactReader;
  private constructor(reader: ImmutableArtifactReader, validators: Map<string, ValidateFunction>) { this.#reader = reader; this.#validators = validators; }
  static async create(reader: ImmutableArtifactReader, schemaDir = path.resolve("contracts/v1")): Promise<V1ArtifactValidator> {
    type AjvLike = { addSchema(schema: unknown): unknown; getSchema(id: string): ValidateFunction | undefined };
    const Ajv2020 = Ajv2020Import as unknown as new (options: Record<string, unknown>) => AjvLike;
    const addFormats = addFormatsImport as unknown as (ajv: AjvLike) => AjvLike;
    const ajv = new Ajv2020({ allErrors: true, strict: true }); addFormats(ajv);
    for (const name of NAMES) ajv.addSchema(JSON.parse(await readFile(path.join(schemaDir, `${name}.schema.json`), "utf8")));
    const validators = new Map<string, ValidateFunction>();
    for (const id of V1_SCHEMA_IDS) { const validator = ajv.getSchema(id); if (!validator) throw new ArtifactValidationError(`schema did not compile: ${id}`); validators.set(id, validator); }
    return new V1ArtifactValidator(reader, validators);
  }
  async validate<T extends JsonObject>(reference: ContractReference, trusted: TrustedValidation<T>, acceptedPaths: ReadonlySet<string> = new Set()): Promise<{ document: T; bytes: Buffer }> {
    if (reference.schemaId !== trusted.schemaId || !V1_SCHEMA_IDS.has(reference.schemaId)) throw new ArtifactValidationError("unsupported schema identity");
    if (acceptedPaths.has(reference.path)) throw new ArtifactValidationError("artifact result was already accepted");
    const bytes = await this.#reader.readExact(reference); // exact bytes/path/digest first
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new ArtifactValidationError("artifact is not valid JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ArtifactValidationError("artifact must be a JSON object");
    if ((parsed as JsonObject)["schemaVersion"] !== 1) throw new ArtifactValidationError("unsupported schema version");
    const structural = this.#validators.get(reference.schemaId);
    if (!structural || !structural(parsed)) throw new ArtifactValidationError(`structural validation failed: ${formatErrors(structural?.errors)}`);
    const errors = trusted.semantic(parsed as T);
    if (errors.length) throw new ArtifactValidationError(`trusted semantic validation failed: ${errors.join("; ")}`);
    return { document: parsed as T, bytes };
  }
  async validateReferences(references: readonly ContractReference[]): Promise<void> {
    const paths = new Set<string>();
    for (const reference of references) { if (paths.has(reference.path)) throw new ArtifactValidationError("duplicate artifact reference"); paths.add(reference.path); await this.#reader.readExact(reference); }
  }
}
function formatErrors(errors: ValidateFunction["errors"]): string { return errors?.map(error => `${error.instancePath || "/"} ${error.message ?? "invalid"}`).join(", ") ?? "unknown"; }

export interface PhaseResultDocument extends JsonObject {
  handoffId: string; inputArtifact: ContractReference; runId: string; phase: "plan" | "implement" | "review" | "test"; sessionId: string;
  inputHead: string; outputHead: string; status: "pass" | "remediation_required" | "failed";
  artifacts: Array<ContractReference & { mediaType: string }>; evidence: Array<{ path: string; sha256: string; mediaType: string; kind: string; commandId?: string }>;
  findings: Array<{ blocking: boolean }>; failures: Array<{ blocking: boolean }>; requestedTransition: { toState: string; reason: string };
}
export interface PhaseResultContext { runId: string; handoffId: string; phase: PhaseResultDocument["phase"]; sessionId: string; inputHead: string; observedOutputHead: string; inputArtifact: ContractReference }
export function validatePhaseResultTrusted(result: PhaseResultDocument, context: PhaseResultContext): string[] {
  const errors: string[] = [];
  for (const [key, expected] of Object.entries({ runId: context.runId, handoffId: context.handoffId, phase: context.phase, sessionId: context.sessionId, inputHead: context.inputHead, outputHead: context.observedOutputHead })) if (result[key] !== expected) errors.push(`${key} does not match trusted context`);
  if (!sameRef(result.inputArtifact, context.inputArtifact)) errors.push("input artifact was substituted");
  if (["plan", "review", "test"].includes(result.phase) && result.outputHead !== result.inputHead) errors.push(`${result.phase} changed Git head`);
  if (result.phase === "implement" && result.status === "pass" && result.outputHead === result.inputHead) errors.push("Implement pass must produce a new observed head");
  const expected: Record<string, [string, string] | undefined> = { "plan:pass": ["implementing", "phase_pass"], "implement:pass": ["reviewing", "phase_pass"], "review:pass": ["testing", "phase_pass"], "review:remediation_required": ["implementing", "remediation_required"], "test:pass": ["publishing", "phase_pass"], "test:remediation_required": ["implementing", "remediation_required"] };
  const transition = expected[`${result.phase}:${result.status}`];
  if (result.status === "failed") { if (result.requestedTransition.toState !== "failed" || result.requestedTransition.reason !== "phase_failed") errors.push("failed result contradicts requested transition"); }
  else if (!transition || transition[0] !== result.requestedTransition.toState || transition[1] !== result.requestedTransition.reason) errors.push("status contradicts requested transition");
  const blocking = [...result.findings, ...result.failures].some(item => item.blocking);
  if (result.status === "pass" && (blocking || result.failures.length > 0)) errors.push("pass contains findings or failures");
  if (result.status === "remediation_required" && !blocking) errors.push("remediation requires blocking feedback");
  return errors;
}
function sameRef(a: ContractReference, b: ContractReference): boolean { return a.path === b.path && a.sha256 === b.sha256 && a.schemaId === b.schemaId; }
