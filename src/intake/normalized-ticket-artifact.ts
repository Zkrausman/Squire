import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ContractReference } from "../control/domain.js";
import { V1ArtifactValidator } from "../contracts/v1-artifact-validator.js";
import { assertRunId, assertTicketIdentifier } from "../git/identity.js";
import { deriveContractFeatureBranch } from "./naming.js";
import { assertTicketRoot, ensurePrivateDirectory, fsyncDirectory, inspectResource, readExactNoFollow, writeExclusiveFile } from "../git/paths.js";
import { canonicalRowJson } from "../sqlite/row-codec.js";
import { IntakeArtifactConflictError, IntakeValidationError, type NormalizedTicketArtifactWriter } from "./domain.js";

export const NORMALIZED_TICKET_SCHEMA_ID = "urn:squire:contracts:v1:normalized-ticket";
export interface NormalizedTicketDocument {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly source: "linear";
  readonly ticket: { readonly id: string; readonly identifier: string; readonly teamId: string; readonly stateId: string; readonly title: string; readonly description: string; readonly acceptanceCriteria: readonly string[]; readonly labels: readonly string[]; readonly url: string };
  readonly repository: { readonly owner: string; readonly name: string; readonly baseBranch: string; readonly baseSha: string; readonly featureBranch: string };
  readonly normalizedAt: string;
}

export function normalizedTicketPath(runId: string): string { assertRunId(runId); return `artifacts/intake/${runId}/normalized-ticket.json`; }
export function serializeNormalizedTicket(document: NormalizedTicketDocument): Buffer { return Buffer.from(`${canonicalRowJson(document)}\n`, "utf8"); }
export function normalizedTicketDigest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

export class FileNormalizedTicketArtifactWriter implements NormalizedTicketArtifactWriter {
  readonly #ticketRoot: string;
  readonly #maxBytes: number;
  constructor(ticketRoot = "/ticket", maxBytes = 4 * 1024 * 1024) { this.#ticketRoot = assertTicketRoot(ticketRoot); if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) throw new IntakeValidationError("normalized-ticket size bound is invalid"); this.#maxBytes = maxBytes; }
  async writeCreateOnly(relativePath: string, bytes: Uint8Array): Promise<ContractReference> {
    assertNormalizedPath(relativePath);
    const buffer = Buffer.from(bytes);
    if (buffer.length > this.#maxBytes) throw new IntakeValidationError("normalized-ticket artifact exceeds its size bound");
    const expectedDigest = normalizedTicketDigest(buffer);
    const target = path.join(this.#ticketRoot, ...relativePath.split("/"));
    const parent = path.dirname(target);
    await ensurePrivateDirectory(path.join(this.#ticketRoot, "artifacts"), this.#ticketRoot);
    await ensurePrivateDirectory(path.join(this.#ticketRoot, "artifacts", "intake"), this.#ticketRoot);
    await ensurePrivateDirectory(parent, this.#ticketRoot);
    try {
      await writeExclusiveFile(target, buffer, this.#ticketRoot, 0o600);
    } catch (error) {
      try {
        const existing = await readExactNoFollow(target, this.#ticketRoot, this.#maxBytes);
        if (!existing.equals(buffer)) throw new IntakeArtifactConflictError();
      } catch (readError) {
        if (readError instanceof IntakeArtifactConflictError) throw readError;
        throw new IntakeArtifactConflictError("normalized-ticket publication collided with an unsafe or different file");
      }
    }
    const identity = await inspectResource(target, "file", true, this.#ticketRoot);
    if (identity.mode !== 0o600 || identity.linkCount !== 1) throw new IntakeArtifactConflictError("normalized-ticket artifact mode or link identity is unsafe");
    await fsyncDirectory(parent, this.#ticketRoot);
    const actual = await readExactNoFollow(target, this.#ticketRoot, this.#maxBytes);
    if (normalizedTicketDigest(actual) !== expectedDigest) throw new IntakeArtifactConflictError("normalized-ticket digest changed after publication");
    return { path: relativePath, sha256: expectedDigest, schemaId: NORMALIZED_TICKET_SCHEMA_ID };
  }
  async readExact(reference: ContractReference): Promise<Buffer> {
    assertNormalizedReference(reference);
    const target = path.join(this.#ticketRoot, ...reference.path.split("/"));
    const bytes = await readExactNoFollow(target, this.#ticketRoot, this.#maxBytes);
    if (normalizedTicketDigest(bytes) !== reference.sha256) throw new IntakeArtifactConflictError("normalized-ticket digest mismatch");
    return bytes;
  }
}

export function validateNormalizedTicketDocument(value: unknown): NormalizedTicketDocument { return structuralValidate(value); }

export async function validatePublishedNormalizedTicket(reference: ContractReference, writer: NormalizedTicketArtifactWriter, validator?: V1ArtifactValidator): Promise<{ document: NormalizedTicketDocument; bytes: Buffer }> {
  assertNormalizedReference(reference);
  const bytes = writer.readExact ? await writer.readExact(reference) : await readViaWriterPath(writer, reference);
  if (normalizedTicketDigest(bytes) !== reference.sha256) throw new IntakeArtifactConflictError("normalized-ticket artifact digest does not match its reference");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new IntakeValidationError("normalized-ticket artifact is not valid JSON"); }
  if (Buffer.from(`${canonicalRowJson(parsed)}\n`, "utf8").compare(bytes) !== 0) throw new IntakeValidationError("normalized-ticket artifact is not canonical JSON");
  let document: NormalizedTicketDocument;
  if (validator) document = validator.validateDocument<NormalizedTicketDocument & Record<string, unknown>>(NORMALIZED_TICKET_SCHEMA_ID, parsed) as NormalizedTicketDocument;
  else document = structuralValidate(parsed);
  if (document.runId !== reference.path.split("/")[2]) throw new IntakeValidationError("normalized-ticket artifact run identity mismatch");
  return { document, bytes };
}

function structuralValidate(value: unknown): NormalizedTicketDocument {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new IntakeValidationError("normalized-ticket is not an object");
  const document = value as Partial<NormalizedTicketDocument> & Record<string, unknown>;
  exactKeys(document, ["schemaVersion", "runId", "source", "ticket", "repository", "normalizedAt"], "normalized-ticket");
  if (document.schemaVersion !== 1 || document.source !== "linear" || typeof document.runId !== "string" || !document.ticket || !document.repository || typeof document.normalizedAt !== "string" || !Number.isFinite(Date.parse(document.normalizedAt))) throw new IntakeValidationError("normalized-ticket shape is invalid");
  assertRunId(document.runId);
  const ticket = document.ticket as NormalizedTicketDocument["ticket"]; const repository = document.repository as NormalizedTicketDocument["repository"];
  if (!ticket || typeof ticket !== "object" || Array.isArray(ticket) || !repository || typeof repository !== "object" || Array.isArray(repository)) throw new IntakeValidationError("normalized-ticket nested shape is invalid");
  exactKeys(ticket, ["id", "identifier", "teamId", "stateId", "title", "description", "acceptanceCriteria", "labels", "url"], "normalized-ticket ticket");
  exactKeys(repository, ["owner", "name", "baseBranch", "baseSha", "featureBranch"], "normalized-ticket repository");
  for (const candidate of [ticket.id, ticket.teamId, ticket.stateId]) if (typeof candidate !== "string" || !isUuid(candidate)) throw new IntakeValidationError("normalized-ticket UUID is invalid");
  if (typeof ticket.identifier !== "string") throw new IntakeValidationError("normalized-ticket identifier is invalid"); assertTicketIdentifier(ticket.identifier);
  if (typeof ticket.title !== "string" || ticket.title.length < 1 || ticket.title.length > 4_096 || typeof ticket.description !== "string" || ticket.description.length > 1_000_000 || !Array.isArray(ticket.acceptanceCriteria) || ticket.acceptanceCriteria.length > 200 || ticket.acceptanceCriteria.some(item => typeof item !== "string" || item.length < 1 || item.length > 8_192) || !Array.isArray(ticket.labels) || ticket.labels.length > 100 || ticket.labels.some(label => typeof label !== "string" || label.length < 1 || label.length > 256) || new Set(ticket.labels).size !== ticket.labels.length || typeof ticket.url !== "string" || !/^https:\/\//u.test(ticket.url)) throw new IntakeValidationError("normalized-ticket content is invalid");
  let ticketUrl: URL; try { ticketUrl = new URL(ticket.url); } catch { throw new IntakeValidationError("normalized-ticket URL is invalid"); } if (ticketUrl.protocol !== "https:" || ticketUrl.hostname.toLowerCase() !== "linear.app" || ticketUrl.username || ticketUrl.password || ticketUrl.search || ticketUrl.hash) throw new IntakeValidationError("normalized-ticket URL is not canonical Linear HTTPS");
  if (typeof repository.owner !== "string" || typeof repository.name !== "string" || typeof repository.baseBranch !== "string" || typeof repository.baseSha !== "string" || typeof repository.featureBranch !== "string") throw new IntakeValidationError("normalized-ticket repository is invalid");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(repository.baseSha) || /^0+$/u.test(repository.baseSha)) throw new IntakeValidationError("normalized-ticket base SHA is invalid");
  if (repository.featureBranch !== deriveContractFeatureBranch(ticket.identifier, document.runId)) throw new IntakeValidationError("normalized-ticket feature branch is not derived from its ticket/run identity");
  return document as NormalizedTicketDocument;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void { if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) throw new IntakeValidationError(`${label} is not closed`); }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value); }
async function readViaWriterPath(writer: NormalizedTicketArtifactWriter, reference: ContractReference): Promise<Buffer> {
  // A custom writer without a read seam cannot prove adoption.  Refuse rather
  // than trusting a caller-provided document or a second pathname API.
  void writer; void reference;
  throw new IntakeValidationError("artifact writer does not provide exact-byte verification");
}
function assertNormalizedPath(value: string): void {
  if (typeof value !== "string" || !/^artifacts\/intake\/run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/normalized-ticket\.json$/u.test(value) || path.posix.normalize(value) !== value) throw new IntakeValidationError("normalized-ticket path is not canonical");
}
function assertNormalizedReference(reference: ContractReference): void {
  assertNormalizedPath(reference.path);
  if (reference.schemaId !== NORMALIZED_TICKET_SCHEMA_ID || !/^[0-9a-f]{64}$/u.test(reference.sha256)) throw new IntakeValidationError("normalized-ticket reference identity is invalid");
}
void constants;
void readFile;
