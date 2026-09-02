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
type TransitiveReference = { path: string; sha256: string; schemaId?: string };

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
  validateDocument<T extends JsonObject>(schemaId: string, document: unknown): T {
    if (!V1_SCHEMA_IDS.has(schemaId)) throw new ArtifactValidationError("unsupported schema identity");
    if (!document || typeof document !== "object" || Array.isArray(document)) throw new ArtifactValidationError("artifact must be a JSON object");
    if ((document as JsonObject)["schemaVersion"] !== 1) throw new ArtifactValidationError("unsupported schema version");
    const structural = this.#validators.get(schemaId);
    if (!structural || !structural(document)) throw new ArtifactValidationError(`structural validation failed: ${formatErrors(structural?.errors)}`);
    return document as T;
  }
  async acceptPhaseResult(reference: ContractReference, context: PhaseResultContext, semanticPolicy: (result: PhaseResultDocument) => Readonly<Record<string, (document: JsonObject) => readonly string[]>>, acceptedPaths: ReadonlySet<string> = new Set()): Promise<ValidatedPhaseResult> {
    const outer = await this.validate<PhaseResultDocument>(reference, { schemaId: "urn:squire:contracts:v1:phase-result", semantic: result => validatePhaseResultTrusted(result, context) }, acceptedPaths);
    const transitiveSemantics = semanticPolicy(outer.document);
    const seen = new Map<string, TransitiveReference>([[reference.path, reference]]);
    const queue: TransitiveReference[] = [...outer.document.artifacts, ...outer.document.evidence];
    while (queue.length) {
      const nested = queue.shift()!;
      const prior = seen.get(nested.path);
      if (prior) {
        if (prior.sha256 !== nested.sha256 || prior.schemaId !== nested.schemaId) throw new ArtifactValidationError("conflicting transitive artifact reference");
        continue;
      }
      seen.set(nested.path, nested);
      const bytes = await this.#reader.readExact(nested);
      if (nested.schemaId) {
        if (!V1_SCHEMA_IDS.has(nested.schemaId)) throw new ArtifactValidationError("unsupported transitive schema identity");
        let parsed: unknown;
        try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new ArtifactValidationError("schema-identified transitive artifact is not JSON"); }
        const document = this.validateDocument<JsonObject>(nested.schemaId, parsed);
        const semantic = transitiveSemantics[nested.schemaId];
        if (!semantic) throw new ArtifactValidationError(`missing trusted semantics for ${nested.schemaId}`);
        const errors = semantic(document);
        if (errors.length) throw new ArtifactValidationError(`transitive trusted semantic validation failed: ${errors.join("; ")}`);
        queue.push(...collectReferences(document));
      }
    }
    const required: Partial<Record<PhaseResultDocument["phase"], string>> = { plan: "urn:squire:contracts:v1:implementation-plan", review: "urn:squire:contracts:v1:review-findings", test: "urn:squire:contracts:v1:test-evidence" };
    const requiredSchema = required[outer.document.phase];
    if (requiredSchema && !outer.document.artifacts.some(artifact => artifact.schemaId === requiredSchema)) throw new ArtifactValidationError(`missing required ${outer.document.phase} domain artifact`);
    return { result: outer.document, reference, paths: new Set(seen.keys()) };
  }
}

export interface ValidatedPhaseResult { result: PhaseResultDocument; reference: ContractReference; paths: ReadonlySet<string> }
function formatErrors(errors: ValidateFunction["errors"]): string { return errors?.map(error => `${error.instancePath || "/"} ${error.message ?? "invalid"}`).join(", ") ?? "unknown"; }

export interface PhaseResultDocument extends JsonObject {
  handoffId: string; inputArtifact: ContractReference; runId: string; phase: "plan" | "implement" | "review" | "test"; sessionId: string;
  inputHead: string; outputHead: string; status: "pass" | "remediation_required" | "failed";
  artifacts: Array<{ path: string; sha256: string; mediaType: string; schemaId?: string }>; evidence: Array<{ path: string; sha256: string; mediaType: string; kind: string; schemaId?: string; commandId?: string }>;
  findings: Array<{ blocking: boolean }>; failures: Array<{ blocking: boolean }>; requestedTransition: { toState: string; reason: string }; completedAt: string;
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
function collectReferences(value: unknown, references: TransitiveReference[] = []): TransitiveReference[] {
  if (Array.isArray(value)) { for (const item of value) collectReferences(item, references); return references; }
  if (!value || typeof value !== "object") return references;
  const object = value as Record<string, unknown>;
  if (typeof object["path"] === "string" && typeof object["sha256"] === "string") {
    const schemaId = object["schemaId"];
    references.push({ path: object["path"], sha256: object["sha256"], ...(typeof schemaId === "string" ? { schemaId } : {}) });
    return references;
  }
  for (const nested of Object.values(object)) collectReferences(nested, references);
  return references;
}
