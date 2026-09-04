import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020Import, { type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { ContractReference } from "../control/domain.js";
import type { ImmutableArtifactReader } from "../control/safe-artifact-reader.js";
import { SafeArtifactReader } from "../control/safe-artifact-reader.js";
import { assertTicketRoot, writeExclusiveFile, ensurePrivateDirectory, inspectResource, readExactNoFollow } from "./paths.js";
import { assertBaseBranch, assertCredentialFreeHttpsCloneUrl, assertFullObjectId, assertRepositoryPart, assertRunId, assertTicketIdentifier, branchRef, deriveFeatureBranch } from "./identity.js";
import type { GitBundleManifestDocument, GitObjectFormat, GitRepositoryIdentity, GitWorkspaceManifestDocument, GitWorkspacePaths, GitWorkspaceSpecDocument, GitWorkspaceSpecInput, ResourceIdentity } from "./domain.js";

export const GIT_WORKSPACE_SCHEMA_NAMES = ["workspace-spec", "workspace-manifest", "bundle-manifest"] as const;
export const GIT_WORKSPACE_SCHEMA_IDS = new Set(GIT_WORKSPACE_SCHEMA_NAMES.map(name => `urn:squire:git-workspace:v1:${name}`));
export type GitWorkspaceSchemaId = `urn:squire:git-workspace:v1:${(typeof GIT_WORKSPACE_SCHEMA_NAMES)[number]}`;

export class GitWorkspaceContractError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitWorkspaceContractError";
  }
}

export interface GitContractArtifactWriter {
  writeCreateOnly(relativePath: string, bytes: Uint8Array): Promise<ContractReference>;
}

export class FileGitContractWriter implements GitContractArtifactWriter {
  readonly #ticketRoot: string;
  readonly #artifactRoot: string;
  constructor(readonly ticketRoot = "/ticket") {
    this.#ticketRoot = assertTicketRoot(ticketRoot);
    this.#artifactRoot = path.join(this.#ticketRoot, "artifacts");
  }

  async writeCreateOnly(relativePath: string, bytes: Uint8Array): Promise<ContractReference> {
    assertContractPath(relativePath);
    await ensurePrivateDirectory(this.#artifactRoot, this.#ticketRoot);
    await ensurePrivateDirectory(path.join(this.#artifactRoot, "git"), this.#ticketRoot);
    const parts = relativePath.split("/");
    const runDirectory = path.join(this.#ticketRoot, ...parts.slice(0, 3));
    await ensurePrivateDirectory(runDirectory, this.#ticketRoot);
    const target = path.join(this.#ticketRoot, ...parts);
    const buffer = Buffer.from(bytes);
    const sha256 = digest(buffer);
    try {
      await writeExclusiveFile(target, buffer, this.#ticketRoot);
    } catch (error) {
      // Idempotency is allowed only for the exact immutable bytes. A hardlink,
      // symlink, replacement, or different digest remains a conflict.
      try {
        const existing = await inspectResource(target, "file", true, this.#ticketRoot);
        if (existing.linkCount !== 1 || existing.mode !== 0o600) throw error;
        const current = await readExactNoFollow(target, this.#ticketRoot, buffer.length);
        if (!current.equals(buffer)) throw error;
      } catch { throw error; }
    }
    return { path: relativePath, sha256, schemaId: schemaIdForPath(relativePath) };
  }
}

export interface ValidatedGitDocument<T> {
  readonly document: T;
  readonly bytes: Buffer;
  readonly reference: ContractReference;
}

export class GitWorkspaceContractValidator {
  readonly #validators: Map<string, ValidateFunction>;
  readonly #reader: ImmutableArtifactReader;
  private constructor(reader: ImmutableArtifactReader, validators: Map<string, ValidateFunction>) {
    this.#reader = reader;
    this.#validators = validators;
  }

  static async create(reader: ImmutableArtifactReader, schemaDir = path.resolve("contracts/git-workspace/v1")): Promise<GitWorkspaceContractValidator> {
    type AjvLike = { addSchema(schema: unknown): unknown; getSchema(id: string): ValidateFunction | undefined };
    const Ajv2020 = Ajv2020Import as unknown as new (options: Record<string, unknown>) => AjvLike;
    const addFormats = addFormatsImport as unknown as (ajv: AjvLike) => AjvLike;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    for (const name of GIT_WORKSPACE_SCHEMA_NAMES) ajv.addSchema(JSON.parse(await readFile(path.join(schemaDir, `${name}.schema.json`), "utf8")));
    const validators = new Map<string, ValidateFunction>();
    for (const schemaId of GIT_WORKSPACE_SCHEMA_IDS) {
      const validator = ajv.getSchema(schemaId);
      if (!validator) throw new GitWorkspaceContractError(`schema did not compile: ${schemaId}`);
      validators.set(schemaId, validator);
    }
    return new GitWorkspaceContractValidator(reader, validators);
  }

  static async forTicketRoot(ticketRoot = "/ticket", schemaDir = path.resolve("contracts/git-workspace/v1")): Promise<GitWorkspaceContractValidator> {
    return GitWorkspaceContractValidator.create(new SafeArtifactReader(ticketRoot), schemaDir);
  }

  async validateSpec(reference: ContractReference, expected?: Partial<Pick<GitWorkspaceSpecDocument, "runId" | "fingerprint">>): Promise<ValidatedGitDocument<GitWorkspaceSpecDocument>> {
    const result = await this.#validate<GitWorkspaceSpecDocument>(reference, "urn:squire:git-workspace:v1:workspace-spec");
    assertSpecSemantics(result.document);
    if (expected?.runId !== undefined && result.document.runId !== expected.runId) throw new GitWorkspaceContractError("workspace spec run identity mismatch");
    if (expected?.fingerprint !== undefined && result.document.fingerprint !== expected.fingerprint) throw new GitWorkspaceContractError("workspace spec fingerprint mismatch");
    return result;
  }

  async validateManifest(reference: ContractReference, expected?: { readonly spec?: ContractReference; readonly runId?: string; readonly specFingerprint?: string }): Promise<ValidatedGitDocument<GitWorkspaceManifestDocument>> {
    const result = await this.#validate<GitWorkspaceManifestDocument>(reference, "urn:squire:git-workspace:v1:workspace-manifest");
    assertManifestSemantics(result.document);
    if (expected?.runId !== undefined && result.document.runId !== expected.runId) throw new GitWorkspaceContractError("workspace manifest run identity mismatch");
    if (expected?.specFingerprint !== undefined && result.document.specFingerprint !== expected.specFingerprint) throw new GitWorkspaceContractError("workspace manifest spec fingerprint mismatch");
    if (expected?.spec && !sameReference(result.document.spec, expected.spec)) throw new GitWorkspaceContractError("workspace manifest spec reference mismatch");
    return result;
  }

  async validateBundle(reference: ContractReference, expected?: { readonly runId?: string; readonly spec?: ContractReference; readonly workspaceManifest?: ContractReference; readonly headSha?: string }): Promise<ValidatedGitDocument<GitBundleManifestDocument>> {
    const result = await this.#validate<GitBundleManifestDocument>(reference, "urn:squire:git-workspace:v1:bundle-manifest");
    assertBundleSemantics(result.document);
    if (expected?.runId !== undefined && result.document.runId !== expected.runId) throw new GitWorkspaceContractError("bundle run identity mismatch");
    if (expected?.spec && !sameReference(result.document.spec, expected.spec)) throw new GitWorkspaceContractError("bundle spec reference mismatch");
    if (expected?.workspaceManifest && !sameReference(result.document.workspaceManifest, expected.workspaceManifest)) throw new GitWorkspaceContractError("bundle workspace manifest reference mismatch");
    if (expected?.headSha !== undefined && result.document.headSha !== expected.headSha) throw new GitWorkspaceContractError("bundle head mismatch");
    return result;
  }

  validateDocument<T extends GitWorkspaceDocument>(schemaId: GitWorkspaceSchemaId, document: unknown): T {
    if (!GIT_WORKSPACE_SCHEMA_IDS.has(schemaId)) throw new GitWorkspaceContractError("unsupported Git workspace schema identity");
    const validator = this.#validators.get(schemaId);
    if (!validator || !validator(document)) throw new GitWorkspaceContractError(`structural validation failed: ${formatErrors(validator?.errors)}`);
    return document as T;
  }

  /** Validates canonical bytes that have already been opened by a trusted
   * descriptor. This is used when a crash has moved an artifact root out of
   * its original logical pathname. */
  validateBytes<T extends GitWorkspaceDocument>(schemaId: GitWorkspaceSchemaId, bytes: Uint8Array): T {
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch (error) { throw new GitWorkspaceContractError("Git workspace contract is not valid JSON", { cause: error }); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new GitWorkspaceContractError("Git workspace contract must be a JSON object");
    const buffer = Buffer.from(bytes);
    if (!buffer.equals(serializeCanonical(parsed))) throw new GitWorkspaceContractError("Git workspace contract is not deterministically serialized");
    const document = this.validateDocument<T>(schemaId, parsed);
    if (schemaId === "urn:squire:git-workspace:v1:workspace-spec") assertSpecSemantics(document as GitWorkspaceSpecDocument);
    else if (schemaId === "urn:squire:git-workspace:v1:workspace-manifest") assertManifestSemantics(document as GitWorkspaceManifestDocument);
    else assertBundleSemantics(document as GitBundleManifestDocument);
    return document;
  }

  async #validate<T extends GitWorkspaceDocument>(reference: ContractReference, schemaId: GitWorkspaceSchemaId): Promise<ValidatedGitDocument<T>> {
    if (reference.schemaId !== schemaId || !GIT_WORKSPACE_SCHEMA_IDS.has(reference.schemaId)) throw new GitWorkspaceContractError("unsupported Git workspace schema identity");
    assertContractPath(reference.path);
    const bytes = await this.#reader.readExact(reference);
    // Exact bytes are checked by the reader first; canonical reserialization is
    // then required so semantically equal but differently encoded documents do
    // not create multiple identities.
    const document = this.validateBytes<T>(schemaId, bytes);
    return { document, bytes, reference };
  }
}

export type GitWorkspaceDocument = GitWorkspaceSpecDocument | GitWorkspaceManifestDocument | GitBundleManifestDocument;

export function buildWorkspaceSpec(input: GitWorkspaceSpecInput, paths: GitWorkspacePaths): GitWorkspaceSpecDocument {
  assertRunId(input.runId);
  assertTicketIdentifier(input.ticketIdentifier);
  assertRepositoryPart(input.repository.owner, "owner");
  assertRepositoryPart(input.repository.name, "name");
  assertCredentialFreeHttpsCloneUrl(input.repository.cloneUrl, input.repository.owner, input.repository.name);
  assertBaseBranch(input.baseBranch);
  assertFullObjectId(input.baseSha, input.objectFormat);
  const createdAt = input.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt))) throw new GitWorkspaceContractError("workspace spec timestamp is invalid");
  const featureBranch = deriveFeatureBranch(input.ticketIdentifier, input.runId);
  assertLogicalPaths(paths, input.runId);
  const withoutFingerprint = {
    schemaVersion: 1 as const,
    kind: "squire-git-workspace-spec" as const,
    runId: input.runId,
    ticketIdentifier: input.ticketIdentifier,
    repository: { owner: input.repository.owner, name: input.repository.name, cloneUrl: input.repository.cloneUrl },
    baseBranch: input.baseBranch,
    baseSha: input.baseSha,
    objectFormat: input.objectFormat,
    featureBranch,
    paths: { repository: paths.repository, worktree: paths.worktree, artifactRoot: paths.artifactRoot, controlRoot: paths.controlRoot },
    createdAt,
  };
  return { ...withoutFingerprint, fingerprint: digest(serializeCanonical(withoutFingerprint)) };
}

export function buildWorkspaceManifest(input: Omit<GitWorkspaceManifestDocument, "schemaVersion" | "kind">): GitWorkspaceManifestDocument {
  const document: GitWorkspaceManifestDocument = { schemaVersion: 1, kind: "squire-git-workspace-manifest", ...input };
  assertManifestSemantics(document);
  return document;
}

export function buildBundleManifest(input: Omit<GitBundleManifestDocument, "schemaVersion" | "kind">): GitBundleManifestDocument {
  const document: GitBundleManifestDocument = { schemaVersion: 1, kind: "squire-git-bundle-manifest", ...input };
  assertBundleSemantics(document);
  return document;
}

export function serializeCanonical(value: unknown): Buffer {
  return Buffer.from(`${canonicalValue(value)}\n`, "utf8");
}

export function canonicalJson(value: unknown): string { return canonicalValue(value); }
export function sha256Bytes(value: Uint8Array): string { return digest(Buffer.from(value)); }

function assertSpecSemantics(document: GitWorkspaceSpecDocument): void {
  assertRunId(document.runId);
  assertTicketIdentifier(document.ticketIdentifier);
  assertRepositoryPart(document.repository.owner, "owner");
  assertRepositoryPart(document.repository.name, "name");
  assertCredentialFreeHttpsCloneUrl(document.repository.cloneUrl, document.repository.owner, document.repository.name);
  assertBaseBranch(document.baseBranch);
  assertFullObjectId(document.baseSha, document.objectFormat);
  if (document.featureBranch !== deriveFeatureBranch(document.ticketIdentifier, document.runId)) throw new GitWorkspaceContractError("feature branch is not the deterministic branch");
  assertLogicalPaths(document.paths, document.runId);
  const { fingerprint, ...withoutFingerprint } = document;
  if (fingerprint !== digest(serializeCanonical(withoutFingerprint))) throw new GitWorkspaceContractError("workspace spec fingerprint mismatch");
}

function assertManifestSemantics(document: GitWorkspaceManifestDocument): void {
  assertRunId(document.runId);
  assertTicketIdentifier(document.ticketIdentifier);
  assertRepositoryPart(document.repository.owner, "owner");
  assertRepositoryPart(document.repository.name, "name");
  assertCredentialFreeHttpsCloneUrl(document.repository.cloneUrl, document.repository.owner, document.repository.name);
  assertBaseBranch(document.baseBranch);
  assertFullObjectId(document.baseSha, document.objectFormat);
  assertFullObjectId(document.headSha, document.objectFormat);
  if (document.featureBranch !== deriveFeatureBranch(document.ticketIdentifier, document.runId)) throw new GitWorkspaceContractError("workspace manifest feature branch mismatch");
  if (document.spec.path !== `artifacts/git/${document.runId}/workspace-spec.json` || document.spec.schemaId !== "urn:squire:git-workspace:v1:workspace-spec") throw new GitWorkspaceContractError("workspace manifest spec reference is not fixed");
  if (!/^[0-9a-f]{64}$/u.test(document.specFingerprint) || !/^[0-9a-f]{64}$/u.test(document.safeConfigDigest)) throw new GitWorkspaceContractError("workspace manifest digest identity is malformed");
  if (branchRef(document.featureBranch) !== `refs/heads/${document.featureBranch}`) throw new GitWorkspaceContractError("workspace manifest branch is not literal");
  if (document.alternates !== null || document.worktreeCount !== 1) throw new GitWorkspaceContractError("workspace manifest does not prove isolated object/worktree state");
  const expectedPaths: Record<string, { path: string; kind: "file" | "directory" }> = {
    repository: { path: "/ticket/git/repo.git", kind: "directory" },
    worktree: { path: "/ticket/workspace", kind: "directory" },
    worktreeGitDir: { path: "/ticket/git/repo.git/worktrees/workspace", kind: "directory" },
    config: { path: "/ticket/git/repo.git/config", kind: "file" },
    hooks: { path: `/ticket/control/git/${document.runId}/hooks`, kind: "directory" },
    objects: { path: "/ticket/git/repo.git/objects", kind: "directory" },
    artifactRoot: { path: `/ticket/artifacts/git/${document.runId}`, kind: "directory" },
    controlRoot: { path: `/ticket/control/git/${document.runId}`, kind: "directory" },
  };
  for (const [key, expected] of Object.entries(expectedPaths)) {
    const resourceKey = key as keyof GitWorkspaceManifestDocument["resources"];
    const resource = document.resources[resourceKey];
    if (!resource || resource.path !== expected.path || resource.kind !== expected.kind) throw new GitWorkspaceContractError(`workspace manifest resource ${key} is not the fixed trusted resource`);
    assertResourceSemantics(resource);
    if (expected.kind === "file" && resource.linkCount !== 1) throw new GitWorkspaceContractError(`workspace manifest resource ${key} is hardlinked`);
  }
  for (const value of [document.gitCommonDir, document.worktreeGitDir, document.worktree, document.hooksPath, document.objectDirectory]) assertLogicalAbsolutePath(value);
  if (document.gitCommonDir !== "/ticket/git/repo.git" || document.worktreeGitDir !== "/ticket/git/repo.git/worktrees/workspace" || document.worktree !== "/ticket/workspace" || document.hooksPath !== `/ticket/control/git/${document.runId}/hooks` || document.objectDirectory !== "/ticket/git/repo.git/objects") throw new GitWorkspaceContractError("workspace manifest infrastructure path is not fixed");
}

function assertBundleSemantics(document: GitBundleManifestDocument): void {
  assertRunId(document.runId);
  assertFullObjectId(document.baseSha, document.objectFormat);
  assertFullObjectId(document.headSha, document.objectFormat);
  if (document.spec.path !== `artifacts/git/${document.runId}/workspace-spec.json` || document.spec.schemaId !== "urn:squire:git-workspace:v1:workspace-spec" || document.workspaceManifest.path !== `artifacts/git/${document.runId}/workspace-manifest.json` || document.workspaceManifest.schemaId !== "urn:squire:git-workspace:v1:workspace-manifest") throw new GitWorkspaceContractError("bundle contract references are not fixed");
  if (document.featureBranch !== deriveFeatureBranchFromRef(document.featureBranch, document.runId)) throw new GitWorkspaceContractError("bundle feature branch is not deterministic");
  assertFullObjectId(document.refs[0]?.oid ?? "", document.objectFormat);
  if (document.refs.length !== 1 || document.refs[0]?.name !== `refs/heads/${document.featureBranch}` || document.refs[0]?.oid !== document.headSha) throw new GitWorkspaceContractError("bundle must advertise exactly the expected feature ref");
  if (document.bundlePath !== `artifacts/git/${document.runId}/${document.headSha}.bundle`) throw new GitWorkspaceContractError("bundle path is not digest-bound to the head");
  if (document.byteLength <= 0 || !Number.isSafeInteger(document.byteLength)) throw new GitWorkspaceContractError("bundle byte length is invalid");
  for (const prerequisite of document.prerequisites) assertFullObjectId(prerequisite, document.objectFormat);
}

function deriveFeatureBranchFromRef(branch: string, runId: string): string {
  assertRunId(runId);
  if (!/^squire\/[a-z][a-z0-9]+-[1-9][0-9]*-run_[A-Za-z0-9._-]+$/u.test(branch)) throw new GitWorkspaceContractError("bundle feature branch has invalid shape");
  if (!branch.endsWith(`-${runId}`)) throw new GitWorkspaceContractError("bundle feature branch run identity mismatch");
  branchRef(branch);
  return branch;
}

function assertLogicalPaths(paths: GitWorkspacePaths, runId: string): void {
  if (paths.repository !== "/ticket/git/repo.git" || paths.worktree !== "/ticket/workspace") throw new GitWorkspaceContractError("workspace paths are not fixed logical paths");
  if (paths.artifactRoot !== `artifacts/git/${runId}` || paths.controlRoot !== `control/git/${runId}`) throw new GitWorkspaceContractError("workspace artifact/control paths are not run scoped");
}

function assertResourceSemantics(resource: ResourceIdentity): void {
  assertLogicalAbsolutePath(resource.path);
  if (!Number.isSafeInteger(resource.mode) || resource.mode < 0 || resource.mode > 0o777 || !Number.isSafeInteger(resource.linkCount) || resource.linkCount < 1) throw new GitWorkspaceContractError("workspace resource identity is unsafe");
  if (!resource.device || !resource.inode) throw new GitWorkspaceContractError("workspace resource identity is incomplete");
}

function assertLogicalAbsolutePath(value: string): void {
  if (typeof value !== "string" || !value.startsWith("/ticket/") || path.posix.normalize(value) !== value || value.includes("\\") || value.includes("\0") || value.includes("/../") || value.endsWith("/..") || value.endsWith("/")) throw new GitWorkspaceContractError("workspace manifest contains a non-canonical path");
}

function assertContractPath(value: string): void {
  if (typeof value !== "string" || !/^artifacts\/git\/run_[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9._-]+\.json$/u.test(value) || path.posix.normalize(value) !== value) throw new GitWorkspaceContractError("Git workspace contract path is not canonical");
}

function schemaIdForPath(value: string): string {
  if (value.endsWith("workspace-spec.json")) return "urn:squire:git-workspace:v1:workspace-spec";
  if (value.endsWith("workspace-manifest.json")) return "urn:squire:git-workspace:v1:workspace-manifest";
  if (value.endsWith("bundle-manifest.json")) return "urn:squire:git-workspace:v1:bundle-manifest";
  throw new GitWorkspaceContractError("unknown Git workspace contract filename");
}

function sameReference(a: ContractReference, b: ContractReference): boolean { return a.path === b.path && a.sha256 === b.sha256 && a.schemaId === b.schemaId; }
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function formatErrors(errors: ValidateFunction["errors"]): string { return errors?.map(error => `${error.instancePath || "/"} ${error.message ?? "invalid"}`).join(", ") ?? "unknown"; }

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new GitWorkspaceContractError("canonical JSON cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") throw new GitWorkspaceContractError("canonical JSON cannot contain bigint");
  if (Array.isArray(value)) return `[${value.map(item => canonicalValue(item)).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalValue(object[key])}`).join(",")}}`;
  }
  throw new GitWorkspaceContractError("canonical JSON contains an unsupported value");
}
