import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, readdir, realpath, rmdir } from "node:fs/promises";
import path from "node:path";
import type { Clock, ContractReference, Lease, LeaseGuard, RunPreparationLease, RunSnapshot, RunTerminalFence } from "../control/domain.js";
import { StoreConflictError, type RunQuiescenceAuthority, type WorkflowStore } from "../control/workflow-store.js";
import { SafeArtifactReader, type ImmutableArtifactReader } from "../control/safe-artifact-reader.js";
import { buildBundleManifest, buildWorkspaceManifest, buildWorkspaceSpec, canonicalJson, FileGitContractWriter, GitWorkspaceContractError, GitWorkspaceContractValidator, serializeCanonical, sha256Bytes, type GitContractArtifactWriter } from "./contracts.js";
import { descriptorPathForGit, digestDescriptor, openImmutableFile, copyDescriptorToExclusive, type DescriptorDigest } from "./bundle-reader.js";
import { assertBaseBranch, assertCredentialFreeHttpsCloneUrl, assertFullObjectId, assertGitRefFormat, assertValidInternalRefName, assertRepositoryPart, assertRunId, assertTicketIdentifier, branchRef, deriveFeatureBranch, objectIdLength, zeroObjectId } from "./identity.js";
import { assertSafeAncestors, assertTicketRoot, createGitWorkspaceFilesystemPaths, ensurePrivateDirectory, entryKind, GitPathSecurityError, inspectResource, isAlreadyExists, isMissing, logicalGitWorkspacePaths, openNoFollow, readExactNoFollow, removeTreeNoFollow, renameWithIdentity, sameResourceIdentity, sameStat, writeExclusiveFile, type GitWorkspaceFilesystemPaths } from "./paths.js";
import { GitCommandError, GitCommandRunner, GitCommandUncertainError, type GitChildProcess, type GitCommandOptions, type GitCommandResult, type GitCommandRunnerOptions } from "./git-command.js";
import type { GitBundleManifestDocument, GitBundleRecord, GitDisposalAuthorization, GitDisposalResult, GitObjectFormat, GitOperationStep, GitRepositoryIdentity, GitWorkspaceManifestDocument, GitWorkspaceReadiness, GitWorkspaceRecord, GitWorkspaceRetention, GitWorkspaceServicePort, GitWorkspaceSpecDocument, GitWorkspaceStatus, GitWorkspaceCommit, ReadyGitWorkspace, ResourceIdentity } from "./domain.js";

export interface GitSourceAuthorization {
  /** The URL is normally the same credential-free HTTPS URL in the spec. */
  readonly cloneUrl: string;
  /** A test-only local transport may be supplied by an explicitly trusted test authorizer. */
  readonly localTransport?: boolean;
  /** Only non-secret, command-specific values may be supplied by a source adapter. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly release?: () => void | Promise<void>;
}

export interface RepositorySourceAuthorizer {
  authorize(repository: GitRepositoryIdentity, signal?: AbortSignal): Promise<GitSourceAuthorization>;
}

export interface GitWorkspaceProcessOptions {
  readonly processResolver?: { resolve(processIdentity: string, signal?: AbortSignal): Promise<GitChildProcess | undefined> };
}

export interface GitWorkspaceServiceOptions {
  readonly store: WorkflowStore;
  readonly runLifecycleAuthority?: RunQuiescenceAuthority;
  readonly clock?: Clock;
  readonly ticketRoot?: string;
  readonly command?: GitCommandRunner;
  readonly commandOptions?: GitCommandRunnerOptions;
  readonly artifactReader?: ImmutableArtifactReader;
  readonly artifactWriter?: GitContractArtifactWriter;
  readonly contractValidator?: GitWorkspaceContractValidator;
  readonly sourceAuthorizer?: RepositorySourceAuthorizer;
  readonly repositorySourceAuthorizer?: RepositorySourceAuthorizer;
  readonly process?: GitWorkspaceProcessOptions;
  readonly operationLeaseMs?: number;
  readonly commandTimeoutMs?: number;
  readonly commandOutputBytes?: number;
  readonly maxBundleBytes?: number;
  readonly verifierVersion?: string;
  /** Production remains false; local/file transport is available only to tests. */
  readonly allowLocalTransport?: boolean;
  /** The publisher boundary is strict by default. */
  readonly requirePublishingGates?: boolean;
}

interface GitLeaseContext {
  readonly runId: string;
  readonly owner: string;
  readonly lease: Lease;
  readonly preparation: RunPreparationLease;
  readonly operationId: string;
  readonly preparationOwner: string;
}

interface WorkspaceObservation {
  readonly headSha: string;
  readonly gitCommonDir: string;
  readonly worktreeGitDir: string;
  readonly worktree: string;
  readonly hooksPath: string;
  readonly objectDirectory: string;
  readonly safeConfigDigest: string;
  readonly resources: GitWorkspaceResourcesPhysical;
}

interface GitWorkspaceResourcesPhysical {
  readonly repository: ResourceIdentity;
  readonly worktree: ResourceIdentity;
  readonly worktreeGitDir: ResourceIdentity;
  readonly config: ResourceIdentity;
  readonly hooks: ResourceIdentity;
  readonly objects: ResourceIdentity;
  readonly alternates: ResourceIdentity | null;
  readonly artifactRoot: ResourceIdentity;
  readonly controlRoot: ResourceIdentity;
}

const GIT_LEASE_KEY = "git-workspace";
const DEFAULT_OPERATION_LEASE_MS = 120_000;
const DEFAULT_MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;
const VERIFIER_VERSION = "aidev-222-git-verifier-v1.0";
const SAFE_GIT_EMAIL = "squire@localhost.invalid";
const OWNERSHIP_KIND = "squire-git-workspace-owner";
const OWNERSHIP_FILE = "ownership.json";
const BUNDLE_STAGING = /^\.bundle-[0-9a-f-]{36}\.tmp$/u;
const BUNDLE_CHECK = /^\.bundle-check-[0-9a-f-]{36}\.git$/u;
const DISPOSAL_DIRECTORY = /^\.git-workspace-disposal-(run_[A-Za-z0-9][A-Za-z0-9._-]{0,127})-([0-9]+)$/u;
const INTERNAL_BASE_REF = (runId: string): string => `refs/squire/${runId}/base`;
const GIT_OPERATION_STEPS = new Set<GitOperationStep>(["initialize", "fetch", "verify-import", "feature-ref", "worktree", "config", "workspace-verify", "bundle-create", "bundle-verify", "bundle-publish", "retention", "dispose"]);
const GIT_COMMAND_STATES = new Set(["reserved", "spawning", "spawned", "exited", "unknown"]);
const DISPOSAL_LOCKS = new Map<string, Promise<void>>();

const REAL_CLOCK: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("sleep aborted")); }, { once: true });
  }),
};

class DefaultRepositorySourceAuthorizer implements RepositorySourceAuthorizer {
  async authorize(repository: GitRepositoryIdentity): Promise<GitSourceAuthorization> {
    assertCredentialFreeHttpsCloneUrl(repository.cloneUrl, repository.owner, repository.name);
    return { cloneUrl: repository.cloneUrl };
  }
}

/** Trusted Git workspace component. It owns only its exact Git/artifact/control
 * paths; the run lifecycle fence is always supplied by the merged authority. */
export class GitWorkspaceService implements GitWorkspaceServicePort, GitWorkspaceReadiness {
  readonly #store: WorkflowStore;
  readonly #authority: RunQuiescenceAuthority;
  readonly #clock: Clock;
  readonly #ticketRoot: string;
  readonly #command: GitCommandRunner;
  readonly #reader: ImmutableArtifactReader;
  readonly #writer: GitContractArtifactWriter;
  readonly #validatorPromise: Promise<GitWorkspaceContractValidator>;
  readonly #sourceAuthorizer: RepositorySourceAuthorizer;
  readonly #processResolver: GitWorkspaceProcessOptions["processResolver"];
  readonly #operationLeaseMs: number;
  readonly #commandTimeoutMs: number;
  readonly #commandOutputBytes: number;
  readonly #maxBundleBytes: number;
  readonly #verifierVersion: string;
  readonly #allowLocalTransport: boolean;
  readonly #requirePublishingGates: boolean;

  constructor(options: GitWorkspaceServiceOptions) {
    this.#store = options.store;
    this.#authority = options.runLifecycleAuthority ?? options.store;
    this.#clock = options.clock ?? REAL_CLOCK;
    this.#ticketRoot = assertTicketRoot(options.ticketRoot ?? "/ticket");
    const commandOptions = {
      ...(options.commandOptions ?? {}),
      ...(options.commandTimeoutMs !== undefined ? { defaultTimeoutMs: options.commandTimeoutMs } : {}),
      ...(options.commandOutputBytes !== undefined ? { defaultMaxOutputBytes: options.commandOutputBytes } : {}),
    };
    this.#command = options.command ?? new GitCommandRunner(commandOptions);
    this.#reader = options.artifactReader ?? new SafeArtifactReader(this.#ticketRoot);
    this.#writer = options.artifactWriter ?? new FileGitContractWriter(this.#ticketRoot);
    this.#validatorPromise = options.contractValidator ? Promise.resolve(options.contractValidator) : GitWorkspaceContractValidator.create(this.#reader);
    this.#sourceAuthorizer = options.sourceAuthorizer ?? options.repositorySourceAuthorizer ?? new DefaultRepositorySourceAuthorizer();
    this.#processResolver = options.process?.processResolver;
    this.#operationLeaseMs = positiveInteger(options.operationLeaseMs ?? DEFAULT_OPERATION_LEASE_MS, "Git operation lease");
    this.#commandTimeoutMs = positiveInteger(options.commandTimeoutMs ?? 30_000, "Git command timeout");
    this.#commandOutputBytes = positiveInteger(options.commandOutputBytes ?? 4 * 1024 * 1024, "Git command output limit");
    this.#maxBundleBytes = positiveInteger(options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES, "Git bundle size limit");
    this.#verifierVersion = options.verifierVersion ?? VERIFIER_VERSION;
    if (!/^aidev-222-git-verifier-v1(?:\.[0-9]+)*$/u.test(this.#verifierVersion)) throw new Error("invalid Git verifier version");
    this.#allowLocalTransport = options.allowLocalTransport === true;
    this.#requirePublishingGates = options.requirePublishingGates !== false;
  }

  async createSpec(input: import("./domain.js").GitWorkspaceSpecInput): Promise<ContractReference> {
    const paths = logicalGitWorkspacePaths(input.runId);
    const document = buildWorkspaceSpec(input, paths);
    const relativePath = `artifacts/git/${input.runId}/workspace-spec.json`;
    const reference = await this.#writer.writeCreateOnly(relativePath, serializeCanonical(document));
    if (reference.path !== relativePath || reference.schemaId !== "urn:squire:git-workspace:v1:workspace-spec" || reference.sha256 !== sha256Bytes(serializeCanonical(document))) throw new GitWorkspaceContractError("workspace spec writer returned a substituted reference");
    await (await this.#validatorPromise).validateSpec(reference, { runId: input.runId, fingerprint: document.fingerprint });
    return reference;
  }

  async provision(runId: string, spec: ContractReference, owner: string): Promise<ReadyGitWorkspace> {
    assertRunId(runId);
    const context = await this.#acquire(runId, owner);
    try {
      const validator = await this.#validatorPromise;
      const validated = await validator.validateSpec(spec, { runId });
      const document = validated.document;
      if (spec.path !== `artifacts/git/${runId}/workspace-spec.json`) throw new GitWorkspaceContractError("workspace spec is not at the fixed run path");
      this.#assertLogicalSpecPaths(document, runId);
      await this.#authority.assertRunStartAllowed(runId, this.#clock.now());
      const current = await this.#store.read(runId);
      if (!current) throw new Error("run not found");
      this.#assertExistingRecord(current.gitWorkspace, document, spec, runId);
      const record = await this.#beginProvisioning(context, document, spec, current.gitWorkspace);
      if (record.stage === "blocked") throw new Error(`Git workspace is blocked: ${record.error.code}: ${record.error.message}`);
      if (record.stage === "retained") throw new Error("Git workspace is retained and cannot be provisioned");
      if (record.stage === "ready") {
        try { return await this.#verifyReady(context, document, record, undefined); }
        catch (error) { await this.#block(context, runId, error, "workspace_verification_failed"); throw error; }
      }
      if (record.stage !== "provisioning") throw new Error("Git workspace has an unsupported lifecycle stage");
      try {
        const source = await this.#sourceAuthorizer.authorize(document.repository);
        try {
          this.#assertAuthorizedTransport(document.repository, source);
          await this.#provisionFilesystem(context, document, record, source);
        } finally { await source.release?.(); }
        return await this.#finishProvisioning(context, document, record);
      } catch (error) {
        await this.#block(context, runId, error, "provision_failed");
        throw error;
      }
    } finally { await this.#release(context); }
  }

  async verify(runId: string, expectedHead?: string): Promise<ReadyGitWorkspace> {
    assertRunId(runId);
    const context = await this.#acquire(runId, `verify-${randomUUID()}`);
    let blockOnError = false;
    try {
      const current = await this.#store.read(runId);
      if (!current?.gitWorkspace) throw new Error("Git workspace record is missing");
      if (current.gitWorkspace.stage === "blocked") throw new Error(`Git workspace is blocked: ${current.gitWorkspace.error.code}: ${current.gitWorkspace.error.message}`);
      if (current.gitWorkspace.stage === "retained") throw new Error("Git workspace is retained");
      blockOnError = current.gitWorkspace.stage === "ready";
      const spec = await (await this.#validatorPromise).validateSpec(current.gitWorkspace.spec, { runId, fingerprint: current.gitWorkspace.specFingerprint });
      this.#assertRecordIdentity(current.gitWorkspace, spec.document, current.gitWorkspace.spec);
      if (current.gitWorkspace.stage === "provisioning" || current.gitWorkspace.stage === "exporting") {
        if (current.gitWorkspace.operation?.command && ["spawning", "spawned", "unknown"].includes(current.gitWorkspace.operation.command.state)) throw new Error("Git workspace has an unresolved child command");
        throw new Error("Git workspace provisioning/export operation requires recovery");
      }
      return await this.#verifyReady(context, spec.document, current.gitWorkspace, expectedHead);
    } catch (error) {
      if (blockOnError) await this.#block(context, runId, error, "workspace_verification_failed");
      throw error;
    } finally { await this.#release(context); }
  }

  async observeHead(runId?: string): Promise<string> {
    if (!runId) throw new Error("Git head observation requires a run ID");
    return (await this.verify(runId)).headSha;
  }

  async exportBundle(runId: string, expectedHead: string, owner: string): Promise<GitBundleRecord> {
    assertRunId(runId);
    const context = await this.#acquire(runId, owner);
    try {
      const snapshot = await this.#store.read(runId);
      if (!snapshot) throw new Error("run not found");
      if (this.#requirePublishingGates) this.#assertPublishingGates(snapshot, expectedHead);
      const record = snapshot.gitWorkspace;
      if (!record || (record.stage !== "ready" && record.stage !== "exporting")) throw new Error("bundle export requires a ready Git workspace");
      const specValidation = await (await this.#validatorPromise).validateSpec(record.spec, { runId, fingerprint: record.specFingerprint });
      const spec = specValidation.document;
      this.#assertRecordIdentity(record, spec, record.spec);
      assertFullObjectId(expectedHead, spec.objectFormat);
      if (record.stage === "ready" && record.bundle?.headSha === expectedHead) {
        await this.#verifyReady(context, spec, record, expectedHead);
        await this.#verifyBundleRecord(context, spec, record.bundle, record.spec, record.manifest);
        return record.bundle;
      }
      if (record.stage === "exporting" && record.expectedHead !== expectedHead) throw new Error("another Git bundle export owns a different head");
      const ready = record.stage === "ready" ? await this.#verifyReady(context, spec, record, expectedHead) : await this.#verifyReadyForExport(context, spec, record, expectedHead);
      const exportGeneration = record.stage === "exporting" ? record.exportGeneration : (record.bundle?.exportGeneration ?? 0) + 1;
      const bundleRelativePath = `artifacts/git/${runId}/${expectedHead}.bundle`;
      const operationId = record.stage === "exporting" && record.operation ? record.operation.operationId : `git-export-${runId}-${randomUUID()}`;
      const exporting = await this.#beginExporting(context, ready, record, expectedHead, exportGeneration, bundleRelativePath, operationId);
      if (exporting.stage !== "exporting") throw new Error("Git bundle export reservation did not persist");
      const fs = this.#paths(runId);
      const destination = path.join(this.#ticketRoot, ...bundleRelativePath.split("/"));
      const destinationKind = await this.#pathKind(destination);
      if (destinationKind !== "missing") {
        if (record.stage !== "exporting") throw new Error("pre-existing Git bundle cannot be adopted");
        const existingFile = await openImmutableFile(destination, this.#maxBundleBytes, this.#ticketRoot);
        try {
          const existingDigest = await digestDescriptor(existingFile.handle, this.#maxBundleBytes);
          const existingVerification = await this.#verifyBundleBytes(context, spec, expectedHead, existingFile.handle, existingDigest, exporting.operation?.operationId ?? operationId);
          const existingManifestPath = `artifacts/git/${runId}/bundle-manifest.json`;
          const existingManifestReference = await this.#existingContractReference(existingManifestPath, "urn:squire:git-workspace:v1:bundle-manifest");
          let manifestReference: ContractReference;
          if (existingManifestReference) {
            const existingManifest = await (await this.#validatorPromise).validateBundle(existingManifestReference, { runId, spec: record.spec, workspaceManifest: ready.manifest, headSha: expectedHead });
            if (existingManifest.document.bundlePath !== bundleRelativePath || existingManifest.document.sha256 !== existingDigest.sha256 || existingManifest.document.byteLength !== existingDigest.byteLength || existingManifest.document.exportGeneration !== exporting.exportGeneration) throw new Error("existing Git bundle manifest does not match the persisted export");
            manifestReference = existingManifestReference;
          } else {
            const existingManifestDocument = buildBundleManifest({ spec: record.spec, workspaceManifest: ready.manifest, runId, featureBranch: spec.featureBranch, baseSha: spec.baseSha, headSha: expectedHead, bundlePath: bundleRelativePath, byteLength: existingDigest.byteLength, sha256: existingDigest.sha256, objectFormat: spec.objectFormat, prerequisites: existingVerification.prerequisites, refs: existingVerification.refs, exportGeneration: exporting.exportGeneration, verifiedAt: new Date(this.#clock.now()).toISOString() });
            manifestReference = await this.#writer.writeCreateOnly(existingManifestPath, serializeCanonical(existingManifestDocument));
            await (await this.#validatorPromise).validateBundle(manifestReference, { runId, spec: record.spec, workspaceManifest: ready.manifest, headSha: expectedHead });
          }
          const existingBundle: GitBundleRecord = { manifest: manifestReference, bundlePath: bundleRelativePath, byteLength: existingDigest.byteLength, sha256: existingDigest.sha256, objectFormat: spec.objectFormat, featureBranch: spec.featureBranch, baseSha: spec.baseSha, headSha: expectedHead, exportGeneration: exporting.exportGeneration };
          return await this.#completeExport(context, spec, exporting, expectedHead, exporting.exportGeneration, existingBundle);
        } finally { await existingFile.handle.close(); }
      }
      const staging = path.join(fs.artifactRoot, `.bundle-${randomUUID()}.tmp`);
      if (!BUNDLE_STAGING.test(path.basename(staging))) throw new Error("invalid bundle staging identity");
      await this.#assertNoPath(staging);
      let opened: Awaited<ReturnType<typeof openImmutableFile>> | undefined;
      let digest: DescriptorDigest | undefined;
      try {
        await this.#git(context, exporting.operation?.operationId ?? operationId, "bundle-create", ["--git-dir", fs.repository, "bundle", "create", staging, branchRef(spec.featureBranch)]);
        opened = await openImmutableFile(staging, this.#maxBundleBytes, this.#ticketRoot);
        digest = await digestDescriptor(opened.handle, this.#maxBundleBytes);
        if (digest.byteLength <= 0) throw new Error("Git bundle is empty");
        const bundleVerification = await this.#verifyBundleBytes(context, spec, expectedHead, opened.handle, digest, exporting.operation?.operationId ?? operationId);
        if (bundleVerification.refs.length !== 1 || bundleVerification.refs[0]?.name !== branchRef(spec.featureBranch) || bundleVerification.refs[0]?.oid !== expectedHead) throw new Error("Git bundle advertised an unexpected ref");
        await copyDescriptorToExclusive(opened.handle, destination, this.#ticketRoot, digest);
        const destinationFile = await openImmutableFile(destination, this.#maxBundleBytes, this.#ticketRoot);
        try {
          const destinationDigest = await digestDescriptor(destinationFile.handle, this.#maxBundleBytes);
          if (destinationDigest.sha256 !== digest.sha256 || destinationDigest.byteLength !== digest.byteLength) throw new Error("published Git bundle digest mismatch");
        } finally { await destinationFile.handle.close(); }
        const manifestDocument = buildBundleManifest({
          spec: record.spec,
          workspaceManifest: ready.manifest,
          runId,
          featureBranch: spec.featureBranch,
          baseSha: spec.baseSha,
          headSha: expectedHead,
          bundlePath: bundleRelativePath,
          byteLength: digest.byteLength,
          sha256: digest.sha256,
          objectFormat: spec.objectFormat,
          prerequisites: bundleVerification.prerequisites,
          refs: bundleVerification.refs,
          exportGeneration,
          verifiedAt: new Date(this.#clock.now()).toISOString(),
        });
        const manifestRelativePath = `artifacts/git/${runId}/bundle-manifest.json`;
        const existingManifestReference = await this.#existingContractReference(manifestRelativePath, "urn:squire:git-workspace:v1:bundle-manifest");
        let manifestReference: ContractReference;
        if (existingManifestReference) {
          const existingManifest = await (await this.#validatorPromise).validateBundle(existingManifestReference, { runId, spec: record.spec, workspaceManifest: ready.manifest, headSha: expectedHead });
          if (existingManifest.document.bundlePath !== bundleRelativePath || existingManifest.document.sha256 !== digest.sha256 || existingManifest.document.byteLength !== digest.byteLength || existingManifest.document.exportGeneration !== exportGeneration) throw new Error("existing Git bundle manifest does not match the current export");
          manifestReference = existingManifestReference;
        } else {
          manifestReference = await this.#writer.writeCreateOnly(manifestRelativePath, serializeCanonical(manifestDocument));
          await (await this.#validatorPromise).validateBundle(manifestReference, { runId, spec: record.spec, workspaceManifest: ready.manifest, headSha: expectedHead });
        }
        const bundle: GitBundleRecord = { manifest: manifestReference, bundlePath: bundleRelativePath, byteLength: digest.byteLength, sha256: digest.sha256, objectFormat: spec.objectFormat, featureBranch: spec.featureBranch, baseSha: spec.baseSha, headSha: expectedHead, exportGeneration };
        return await this.#completeExport(context, spec, exporting, expectedHead, exportGeneration, bundle);
      } catch (error) {
        await this.#block(context, runId, error, "bundle_export_failed");
        throw error;
      } finally {
        if (opened) await opened.handle.close();
        await this.#removeOwnedTemporary(staging);
      }
    } finally {
      await this.#release(context);
    }
  }

  async markRetained(runId: string, policy: GitWorkspaceRetention, owner: string): Promise<GitWorkspaceRecord> {
    assertRunId(runId);
    const context = await this.#acquire(runId, owner);
    try {
      const current = await this.#store.read(runId);
      if (!current) throw new Error("run not found");
      const record = current.gitWorkspace;
      if (!record || (record.stage !== "ready" && record.stage !== "retained")) throw new Error("retention requires a ready Git workspace");
      const spec = await (await this.#validatorPromise).validateSpec(record.spec, { runId, fingerprint: record.specFingerprint });
      this.#assertRecordIdentity(record, spec.document, record.spec);
      if (record.stage === "retained") {
        if (!sameRetention(record.retention, policy)) throw new Error("retention decision is immutable");
        return record;
      }
      assertRetention(policy, this.#clock.now());
      const committed = await this.#updateRecord(context, snapshot => {
        const latest = snapshot.gitWorkspace;
        if (!latest || latest.stage !== "ready") throw new StoreConflictError("Git workspace changed before retention");
        const { operation: _operation, ...withoutOperation } = latest;
        return { ...withoutOperation, stage: "retained", retention: policy } as GitWorkspaceRecord;
      });
      return committed.gitWorkspace!;
    } catch (error) {
      await this.#block(context, runId, error, "retention_failed");
      throw error;
    } finally { await this.#release(context); }
  }

  async recover(runId: string, owner: string): Promise<GitWorkspaceRecord> {
    assertRunId(runId);
    const context = await this.#acquire(runId, owner);
    try {
      const current = await this.#store.read(runId);
      if (!current?.gitWorkspace) throw new Error("Git workspace record is missing");
      const record = current.gitWorkspace;
      if (record.stage === "blocked") return record;
      const command = record.operation?.command;
      if (command && ["spawning", "spawned", "unknown"].includes(command.state)) {
        if (!command.processIdentity || !this.#processResolver) throw new Error("Git child ownership is unresolved; operator recovery is required");
        const process = await this.#processResolver.resolve(command.processIdentity);
        if (!process || process.identity !== command.processIdentity || process.exitCode === null) throw new Error("Git child identity is live or unknown; replacement is forbidden");
      }
      if (command && ["reserved", "spawning", "spawned", "unknown", "exited"].includes(command.state)) {
        // A command allocation is cleared only after an exact reserved intent
        // or supervisor-observed exit. The operation itself remains the single
        // lifecycle record and is resumed by the next provision/export call.
        await this.#updateRecord(context, snapshot => {
          const latest = snapshot.gitWorkspace;
          if (!latest || !latest.operation || latest.operation.operationId !== record.operation?.operationId) throw new StoreConflictError("Git recovery operation changed");
          const { command: _command, ...withoutCommand } = latest.operation;
          return { ...snapshot, gitWorkspace: { ...latest, operation: withoutCommand } };
        });
      }
      return (await this.#store.read(runId))!.gitWorkspace!;
    } catch (error) {
      await this.#block(context, runId, error, "recovery_blocked");
      throw error;
    } finally { await this.#release(context); }
  }

  async status(runId: string): Promise<GitWorkspaceStatus> {
    assertRunId(runId);
    const context = await this.#acquire(runId, `status-${randomUUID()}`);
    try {
      const current = await this.#store.read(runId);
      if (!current?.gitWorkspace || (current.gitWorkspace.stage !== "ready" && current.gitWorkspace.stage !== "retained")) throw new Error("Git workspace is not ready for status");
      const spec = (await (await this.#validatorPromise).validateSpec(current.gitWorkspace.spec, { runId, fingerprint: current.gitWorkspace.specFingerprint })).document;
      this.#assertRecordIdentity(current.gitWorkspace, spec, current.gitWorkspace.spec);
      await this.#verifyReady(context, spec, current.gitWorkspace);
      const headSha = await this.#readFeatureHead(context, spec, `git-status-head-${randomUUID()}`);
      const result = await this.#git(context, `git-status-${randomUUID()}`, "workspace-verify", ["status", "--porcelain=v2", "--untracked-files=all", "--no-renames"], { cwd: this.#paths(runId).worktree });
      return { runId, headSha, porcelain: result.stdout };
    } finally { await this.#release(context); }
  }

  offlineStatus(runId: string): Promise<GitWorkspaceStatus> { return this.status(runId); }

  async commit(runId: string, message: string): Promise<GitWorkspaceCommit> {
    if (typeof message !== "string" || message.length === 0 || message.length > 10_000 || /[\u0000\r\n]/u.test(message)) throw new Error("commit message is not a bounded single-line value");
    assertRunId(runId);
    const context = await this.#acquire(runId, `commit-${randomUUID()}`);
    try {
      const current = await this.#store.read(runId);
      if (!current?.gitWorkspace || current.gitWorkspace.stage !== "ready") throw new Error("Git workspace is not ready for offline commit");
      if (current.gitWorkspace.bundle) throw new Error("offline commit is closed after bundle publication");
      const spec = (await (await this.#validatorPromise).validateSpec(current.gitWorkspace.spec, { runId, fingerprint: current.gitWorkspace.specFingerprint })).document;
      this.#assertRecordIdentity(current.gitWorkspace, spec, current.gitWorkspace.spec);
      await this.#verifyReady(context, spec, current.gitWorkspace);
      const fs = this.#paths(runId);
      await this.#git(context, `git-commit-${randomUUID()}`, "workspace-verify", ["add", "--all"], { cwd: fs.worktree });
      const result = await this.#git(context, `git-commit-${randomUUID()}`, "workspace-verify", ["commit", "--no-verify", "--no-gpg-sign", "-m", message], { cwd: fs.worktree });
      const headSha = await this.#readFeatureHead(context, spec, `git-commit-head-${randomUUID()}`);
      const latest = await this.#store.read(runId);
      if (!latest?.gitWorkspace || latest.gitWorkspace.stage !== "ready" || latest.gitWorkspace.bundle) throw new Error("Git workspace changed while committing");
      await this.#verifyWorkspace(context, spec, latest.gitWorkspace, headSha, true);
      await this.#updateRecord(context, snapshot => {
        const record = snapshot.gitWorkspace;
        if (!record || record.stage !== "ready" || record.bundle) throw new StoreConflictError("Git workspace changed before commit head persistence");
        return { ...snapshot, gitWorkspace: { ...record, headSha, lastVerifiedAt: new Date(this.#clock.now()).toISOString() } };
      });
      return { runId, headSha, output: result.stdout };
    } finally { await this.#release(context); }
  }

  async disposeUnderTerminalFence(runId: string, fence: RunTerminalFence, authorization: GitDisposalAuthorization, signal?: AbortSignal): Promise<GitDisposalResult> {
    assertRunId(runId);
    const lockKey = `${this.#ticketRoot}:${runId}:${fence.fencingToken}`;
    const previous = DISPOSAL_LOCKS.get(lockKey);
    let unlock!: () => void;
    const turn = new Promise<void>(resolve => { unlock = resolve; });
    const currentLock = previous ? previous.then(() => turn) : turn;
    DISPOSAL_LOCKS.set(lockKey, currentLock);
    await previous;
    try {
      if (fence.runId !== runId || fence.state !== "held") throw new Error("terminal fence does not authorize this Git workspace");
    await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
    const snapshot = await this.#store.read(runId);
    const record = snapshot?.gitWorkspace;
    if (!record || (record.stage !== "retained" && record.stage !== "ready")) throw new Error("Git workspace has no retained disposal record");
    if (record.stage !== "retained") throw new Error("Git workspace retention authorization is missing");
    assertDisposalRecordShape(record, runId);
    assertDisposalAuthorization(record.retention, authorization);
    const fs = this.#paths(runId);
    const disposal = path.join(fs.disposalRoot, `.git-workspace-disposal-${runId}-${fence.fencingToken}`);
    await this.#ensureDisposalRoot(fs);
    await this.#assertDisposalDirectory(disposal, runId, fence.fencingToken);
    const removed: string[] = [];
    const alreadyAbsent: string[] = [];
    const targetKeys = [
      { name: "workspace", source: fs.worktree, key: "worktree" as const, enabled: authorization.disposeWorkspace !== false },
      { name: "repository", source: fs.repository, key: "repository" as const, enabled: authorization.disposeWorkspace !== false },
      { name: "control", source: fs.controlRoot, key: "controlRoot" as const, enabled: authorization.disposeWorkspace !== false },
      { name: "artifacts", source: fs.artifactRoot, key: "artifactRoot" as const, enabled: authorization.disposeBundle !== false },
    ];
    const identityPath = path.join(disposal, ".disposal-identity.json");
    const manifestPhysicalPath = path.join(this.#ticketRoot, ...record.manifest.path.split("/"));
    const manifestKind = await this.#pathKind(manifestPhysicalPath);
    let resources: GitWorkspaceManifestDocument["resources"];
    if (manifestKind !== "missing") {
      if (manifestKind !== "file") throw new Error("Git workspace manifest is an unsafe replacement");
      const manifestDocument = (await (await this.#validatorPromise).validateManifest(record.manifest, { spec: record.spec, runId, specFingerprint: record.specFingerprint })).document;
      resources = manifestDocument.resources;
      await this.#writeDisposalIdentity(identityPath, runId, fence, record.manifest, resources);
    } else {
      resources = await this.#readDisposalIdentity(identityPath, runId, fence.fencingToken, record.manifest);
    }
    const targets: Array<{ name: string; source: string; expected: ResourceIdentity | undefined; enabled: boolean }> = targetKeys.map(target => {
      const resource = resources[target.key];
      return { name: target.name, source: target.source, expected: resource ? { ...resource, path: this.#physicalPath(resource.path) } : undefined, enabled: target.enabled };
    });
    for (const target of targets) {
      if (!target.enabled) continue;
      await this.#disposeOne(runId, fence, target.name, target.source, path.join(disposal, target.name), target.expected, removed, alreadyAbsent, signal);
    }
    await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
    // The parent /ticket/git is shared as a controller root. Remove it only if
    // it is empty; never recursively remove a sibling run or repository.
    await this.#removeEmptyControllerRoot(fs.gitRoot, runId, fence, signal);
    await this.#removeEmptyControllerRoot(fs.disposalRoot, runId, fence, signal);
      return { runId, fence: { owner: fence.owner, fencingToken: fence.fencingToken }, removed, alreadyAbsent };
    } finally {
      unlock();
      if (DISPOSAL_LOCKS.get(lockKey) === currentLock) DISPOSAL_LOCKS.delete(lockKey);
    }
  }

  async #acquire(runId: string, owner: string): Promise<GitLeaseContext> {
    if (typeof owner !== "string" || owner.length === 0 || owner.length > 200 || /[\u0000-\u001f\u007f\r\n]/u.test(owner)) throw new Error("Git operation owner is invalid");
    await this.#authority.assertRunStartAllowed(runId, this.#clock.now());
    const lease = await this.#store.acquireLease(runId, GIT_LEASE_KEY, owner, this.#clock.now(), this.#operationLeaseMs);
    if (!lease) throw new StoreConflictError("Git workspace operation lease is held");
    let preparation: RunPreparationLease | undefined;
    try {
      const snapshot = await this.#store.read(runId);
      if (!snapshot) throw new Error("run not found");
      const operationId = snapshot.gitWorkspace?.operation?.operationId ?? `git-${runId}-${randomUUID()}`;
      const preparationOwner = `git-operation-${operationId}`;
      // The newly acquired generic lease proves that an older Git owner is no
      // longer current. Reap only the preparation lease whose owner is bound
      // to the persisted operation, and only after resolving its exact child.
      await this.#releaseStaleGitPreparationLease(snapshot, operationId);
      preparation = await this.#authority.acquireRunPreparationLease(runId, preparationOwner, this.#clock.now());
      await this.#authority.assertRunStartAllowed(runId, this.#clock.now());
      return { runId, owner, lease, preparation, operationId, preparationOwner };
    } catch (error) {
      if (preparation) await this.#authority.releaseRunPreparationLease(runId, preparation, this.#clock.now()).catch(() => undefined);
      await this.#store.releaseLease(runId, GIT_LEASE_KEY, owner, lease.fencingToken);
      throw error;
    }
  }

  async #releaseStaleGitPreparationLease(snapshot: RunSnapshot, operationId: string): Promise<void> {
    const operation = snapshot.gitWorkspace?.operation;
    const candidates = (snapshot.preparationLeases ?? []).filter(lease => lease.state === "held" && lease.owner.startsWith("git-operation-"));
    if (!operation) {
      if (candidates.length > 0) throw new StoreConflictError("Git has an orphaned preparation lease without persisted operation proof");
      return;
    }
    const candidate = candidates.find(lease => lease.owner === `git-operation-${operationId}`);
    if (!candidate) {
      if (candidates.length > 0) throw new StoreConflictError("Git has an orphaned preparation lease alongside its persisted operation");
      return;
    }
    if (operation.operationId !== operationId || candidates.some(lease => lease.owner !== candidate.owner || lease.fencingToken !== candidate.fencingToken)) throw new StoreConflictError("Git preparation lease has no matching persisted operation");
    const command = operation.command;
    if (command && ["spawning", "spawned", "unknown"].includes(command.state)) {
      if (!command.processIdentity || !this.#processResolver) throw new StoreConflictError("Git preparation lease has unresolved child ownership");
      const process = await this.#processResolver.resolve(command.processIdentity);
      if (!process || process.identity !== command.processIdentity || process.exitCode === null) throw new StoreConflictError("Git preparation lease has a live or unknown child");
    }
    await this.#authority.releaseRunPreparationLease(snapshot.runId, candidate, this.#clock.now());
  }

  async #release(context: GitLeaseContext): Promise<void> {
    try {
      const snapshot = await this.#store.read(context.runId);
      const command = snapshot?.gitWorkspace?.operation?.command;
      const unresolved = command && ["spawning", "spawned", "unknown"].includes(command.state);
      // Keep the durable preparation lease with an unresolved Git child so a
      // terminal fence cannot race it. Recovery can release this exact lease
      // after supervisor proof of observed exit.
      if (!unresolved) await this.#authority.releaseRunPreparationLease(context.runId, context.preparation, this.#clock.now());
    } finally { await this.#store.releaseLease(context.runId, GIT_LEASE_KEY, context.owner, context.lease.fencingToken); }
  }

  #paths(runId: string): GitWorkspaceFilesystemPaths { return createGitWorkspaceFilesystemPaths(runId, this.#ticketRoot); }

  async #beginProvisioning(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, reference: ContractReference, existing?: GitWorkspaceRecord): Promise<GitWorkspaceRecord> {
    const operationId = existing?.operation?.operationId ?? context.operationId;
    const operationGeneration = existing?.operationGeneration ?? 1;
    const operation = existing?.stage === "provisioning" && existing.operation ? existing.operation : { operationId, owner: context.preparationOwner, generation: operationGeneration, step: "initialize" as const, startedAt: new Date(this.#clock.now()).toISOString() };
    return (await this.#updateRecord(context, snapshot => {
      const current = snapshot.gitWorkspace;
      if (current) {
        this.#assertRecordIdentity(current, spec, reference);
        if (current.stage === "blocked") return current;
        if (current.stage === "ready" || current.stage === "retained" || current.stage === "exporting") return current;
        if (current.stage === "provisioning") return current;
      }
      return { ...snapshot, gitWorkspace: { runId: spec.runId, stage: "provisioning", spec: reference, specFingerprint: spec.fingerprint, featureBranch: spec.featureBranch, paths: logicalGitWorkspacePaths(spec.runId), operationGeneration, operation } as GitWorkspaceRecord };
    })).gitWorkspace!;
  }

  async #provisionFilesystem(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, record: GitWorkspaceRecord, source: GitSourceAuthorization): Promise<void> {
    if (record.stage !== "provisioning") throw new Error("provisioning record changed");
    const fs = this.#paths(spec.runId);
    await this.#ensureRoots(fs, context);
    await this.#assertNoUnownedGitPaths(fs);
    await this.#writeOwnershipMarker(context, spec, record.operationGeneration);
    await this.#ensureTemplateAndHooks(fs, context);
    const repositoryKind = await this.#pathKind(fs.repository);
    if (repositoryKind === "missing") {
      await this.#git(context, record.operation?.operationId ?? context.operationId, "initialize", ["init", "--bare", `--object-format=${spec.objectFormat}`, `--template=${fs.templatePath}`, fs.repository]);
      await chmod(fs.repository, 0o700);
      await this.#authority.assertRunStartAllowed(spec.runId, this.#clock.now());
      await inspectResource(fs.repository, "directory", true, this.#ticketRoot);
    } else {
      await this.#verifyOwnedRepository(context, spec, record);
      await chmod(fs.repository, 0o700);
    }
    await this.#verifyRepositorySafety(context, spec, record, true);
    const baseRef = INTERNAL_BASE_REF(spec.runId);
    const imported = await this.#readRef(context, fs.repository, baseRef, spec.objectFormat, record.operation?.operationId ?? context.operationId);
    if (!imported) {
      await this.#git(context, record.operation?.operationId ?? context.operationId, "fetch", ["--git-dir", fs.repository, "fetch", "--no-tags", "--no-recurse-submodules", "--no-auto-gc", "--no-write-fetch-head", source.cloneUrl, `refs/heads/${spec.baseBranch}:${baseRef}`], { allowNetwork: source.localTransport !== true, ...(source.localTransport ? { extraEnv: { GIT_ALLOW_PROTOCOL: "file" } } : source.environment ? { extraEnv: source.environment } : {}) });
    }
    await this.#verifyFetchedBase(context, spec, record);
    const featureRef = branchRef(spec.featureBranch);
    const feature = await this.#readRef(context, fs.repository, featureRef, spec.objectFormat, record.operation?.operationId ?? context.operationId);
    if (feature) {
      if (feature !== spec.baseSha || !record.operation || record.operation.step === "initialize" || record.operation.step === "fetch" || record.operation.step === "verify-import") throw new Error("pre-existing or unowned feature ref cannot be adopted");
    } else {
      await this.#git(context, record.operation?.operationId ?? context.operationId, "feature-ref", ["--git-dir", fs.repository, "update-ref", featureRef, spec.baseSha, zeroObjectId(spec.objectFormat)]);
    }
    await this.#verifyRefAndObjects(context, spec, record);
    const worktreeKind = await this.#pathKind(fs.worktree);
    if (worktreeKind === "missing") {
      await this.#git(context, record.operation?.operationId ?? context.operationId, "worktree", ["--git-dir", fs.repository, "worktree", "add", "--no-guess-remote", fs.worktree, spec.featureBranch]);
      await chmod(fs.worktree, 0o700);
    } else {
      await this.#verifyWorktreePair(context, spec, record);
      await chmod(fs.worktree, 0o700);
    }
    await this.#configureSafeRepository(context, spec, record);
    await this.#verifyWorkspace(context, spec, record, spec.baseSha, true);
  }

  async #finishProvisioning(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, record: GitWorkspaceRecord): Promise<ReadyGitWorkspace> {
    const observation = await this.#verifyWorkspace(context, spec, record, spec.baseSha, true);
    const marker = await this.#readOwnershipMarker(this.#paths(spec.runId).controlRoot);
    if (marker.runId !== spec.runId || marker.specFingerprint !== spec.fingerprint || marker.generation !== record.operationGeneration) throw new Error("workspace manifest operation marker does not match");
    const manifestPath = `artifacts/git/${spec.runId}/workspace-manifest.json`;
    const existingManifestReference = await this.#existingContractReference(manifestPath, "urn:squire:git-workspace:v1:workspace-manifest");
    let manifestReference: ContractReference;
    if (existingManifestReference) {
      const existing = await (await this.#validatorPromise).validateManifest(existingManifestReference, { spec: record.spec, runId: spec.runId, specFingerprint: spec.fingerprint });
      const expectedResources = this.#logicalResources(observation.resources);
      if (existing.document.ticketIdentifier !== spec.ticketIdentifier || existing.document.repository.owner !== spec.repository.owner || existing.document.repository.name !== spec.repository.name || existing.document.repository.cloneUrl !== spec.repository.cloneUrl || existing.document.baseBranch !== spec.baseBranch || existing.document.baseSha !== spec.baseSha || existing.document.featureBranch !== spec.featureBranch || existing.document.headSha !== observation.headSha || !sameManifestInfrastructure(existing.document, expectedResources, observation, spec.objectFormat, this.#logicalPath.bind(this))) throw new Error("existing workspace manifest does not match the current operation");
      manifestReference = existingManifestReference;
    } else {
      const manifestDocument = buildWorkspaceManifest({
        spec: record.spec,
        specFingerprint: spec.fingerprint,
        runId: spec.runId,
        ticketIdentifier: spec.ticketIdentifier,
        repository: spec.repository,
        baseBranch: spec.baseBranch,
        baseSha: spec.baseSha,
        featureBranch: spec.featureBranch,
        headSha: observation.headSha,
        objectFormat: spec.objectFormat,
        gitCommonDir: this.#logicalPath(observation.gitCommonDir),
        worktreeGitDir: this.#logicalPath(observation.worktreeGitDir),
        worktree: "/ticket/workspace",
        hooksPath: this.#logicalPath(observation.hooksPath),
        objectDirectory: this.#logicalPath(observation.objectDirectory),
        alternates: null,
        worktreeCount: 1,
        safeConfigDigest: observation.safeConfigDigest,
        resources: this.#logicalResources(observation.resources),
        verifierVersion: this.#verifierVersion,
        verifiedAt: new Date(this.#clock.now()).toISOString(),
      });
      manifestReference = await this.#writer.writeCreateOnly(manifestPath, serializeCanonical(manifestDocument));
      await (await this.#validatorPromise).validateManifest(manifestReference, { spec: record.spec, runId: spec.runId, specFingerprint: spec.fingerprint });
    }
    await this.#authority.assertRunStartAllowed(spec.runId, this.#clock.now());
    const second = await this.#verifyWorkspace(context, spec, record, spec.baseSha, true);
    if (second.headSha !== observation.headSha) throw new Error("Git head changed during workspace manifest publication");
    const committed = await this.#updateRecord(context, snapshot => {
      const current = snapshot.gitWorkspace;
      if (!current || current.stage !== "provisioning" || current.specFingerprint !== spec.fingerprint) throw new StoreConflictError("workspace provisioning ownership changed");
      const { operation: _operation, ...withoutOperation } = current;
      return { ...snapshot, gitWorkspace: { ...withoutOperation, stage: "ready", manifest: manifestReference, headSha: second.headSha, lastVerifiedAt: new Date(this.#clock.now()).toISOString() } as GitWorkspaceRecord };
    });
    const ready = committed.gitWorkspace;
    if (!ready || ready.stage !== "ready") throw new Error("workspace readiness was not persisted");
    await this.#authority.assertRunStartAllowed(spec.runId, this.#clock.now());
    return this.#readyResult(spec, ready);
  }

  async #verifyReady(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, record: GitWorkspaceRecord, expectedHead?: string): Promise<ReadyGitWorkspace> {
    if (record.stage !== "ready" && record.stage !== "retained") throw new Error("workspace is not ready");
    const manifest = await (await this.#validatorPromise).validateManifest(record.manifest, { spec: record.spec, runId: spec.runId, specFingerprint: spec.fingerprint });
    if (manifest.document.ticketIdentifier !== spec.ticketIdentifier || manifest.document.repository.owner !== spec.repository.owner || manifest.document.repository.name !== spec.repository.name || manifest.document.repository.cloneUrl !== spec.repository.cloneUrl || manifest.document.baseBranch !== spec.baseBranch || manifest.document.baseSha !== spec.baseSha || manifest.document.featureBranch !== spec.featureBranch || manifest.document.objectFormat !== spec.objectFormat) throw new Error("workspace manifest binding does not match the immutable spec");
    const observation = await this.#verifyWorkspace(context, spec, record, expectedHead, false);
    const expectedResources = this.#logicalResources(observation.resources);
    if (!sameManifestInfrastructure(manifest.document, expectedResources, observation, spec.objectFormat, this.#logicalPath.bind(this))) throw new Error("workspace manifest no longer matches independent observation");
    if (expectedHead && observation.headSha !== expectedHead) throw new Error("workspace head does not match expected head");
    if (record.bundle && record.bundle.headSha !== observation.headSha) throw new Error("workspace head changed after the persisted bundle publication");
    if (record.bundle) await this.#verifyBundleRecord(context, spec, record.bundle, record.spec, record.manifest);
    // Read-only verification deliberately has no CAS side effect. The
    // persisted head is advanced only by the offline commit path or the
    // bundle reservation/completion path, so callers can safely use this
    // observer inside their own fenced transaction.
    return this.#readyResult(spec, record, observation.headSha);
  }

  async #verifyReadyForExport(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, record: GitWorkspaceRecord, expectedHead: string): Promise<ReadyGitWorkspace> {
    if (record.stage !== "exporting") throw new Error("export record is not active");
    const observation = await this.#verifyWorkspace(context, spec, record, expectedHead, false);
    if (observation.headSha !== expectedHead) throw new Error("export head changed before bundle creation");
    return { runId: spec.runId, spec: record.spec, manifest: record.manifest, featureBranch: spec.featureBranch, headSha: expectedHead, objectFormat: spec.objectFormat, paths: record.paths, ...(record.stage === "exporting" ? {} : {}) };
  }

  async #beginExporting(context: GitLeaseContext, ready: ReadyGitWorkspace, record: GitWorkspaceRecord, expectedHead: string, exportGeneration: number, bundlePath: string, operationId: string): Promise<GitWorkspaceRecord> {
    return (await this.#updateRecord(context, snapshot => {
      const current = snapshot.gitWorkspace;
      if (!current) throw new StoreConflictError("workspace record disappeared before export");
      if (current.stage === "exporting") {
        if (current.expectedHead !== expectedHead || current.bundlePath !== bundlePath || current.exportGeneration !== exportGeneration) throw new StoreConflictError("bundle export identity changed");
        return current;
      }
      if (current.stage !== "ready" || current.headSha !== expectedHead) throw new StoreConflictError("workspace head changed before export reservation");
      return { ...snapshot, gitWorkspace: { runId: current.runId, stage: "exporting", spec: current.spec, specFingerprint: current.specFingerprint, featureBranch: current.featureBranch, paths: current.paths, operationGeneration: current.operationGeneration + 1, manifest: ready.manifest, headSha: expectedHead, expectedHead, exportGeneration, bundlePath, lastVerifiedAt: current.lastVerifiedAt, operation: { operationId, owner: context.preparationOwner, generation: current.operationGeneration + 1, step: "bundle-create", startedAt: new Date(this.#clock.now()).toISOString() } } as GitWorkspaceRecord };
    })).gitWorkspace!;
  }

  async #completeExport(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, exporting: GitWorkspaceRecord, expectedHead: string, exportGeneration: number, bundle: GitBundleRecord): Promise<GitBundleRecord> {
    const after = await this.#verifyReadyForExport(context, spec, exporting, expectedHead);
    if (after.headSha !== expectedHead) throw new Error("Git feature head changed during bundle export");
    const committed = await this.#updateRecord(context, snapshot => {
      const currentRecord = snapshot.gitWorkspace;
      if (!currentRecord || currentRecord.stage !== "exporting" || currentRecord.expectedHead !== expectedHead || currentRecord.exportGeneration !== exportGeneration) throw new StoreConflictError("bundle export ownership changed");
      const { operation: _operation, ...withoutOperation } = currentRecord;
      const next: GitWorkspaceRecord = { ...withoutOperation, stage: "ready", headSha: expectedHead, lastVerifiedAt: new Date(this.#clock.now()).toISOString(), bundle };
      return next;
    });
    const readyRecord = committed.gitWorkspace;
    if (!readyRecord || readyRecord.stage !== "ready" || !readyRecord.bundle) throw new Error("bundle export did not persist a ready record");
    const finalHead = await this.#readFeatureHead(context, spec, `git-export-final-${randomUUID()}`);
    if (finalHead !== expectedHead) throw new Error("feature head changed after bundle publication");
    return readyRecord.bundle;
  }

  async #verifyBundleRecord(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, bundle: GitBundleRecord, specReference: ContractReference, workspaceManifest: ContractReference): Promise<void> {
    const validated = await (await this.#validatorPromise).validateBundle(bundle.manifest, { runId: spec.runId, spec: specReference, workspaceManifest, headSha: bundle.headSha }).catch(error => {
      // The exact spec reference is checked below from the persisted record;
      // this branch avoids fabricating authority when a custom reader returns a
      // malformed document.
      throw error;
    });
    if (bundle.manifest.path !== `artifacts/git/${spec.runId}/bundle-manifest.json` || bundle.manifest.schemaId !== "urn:squire:git-workspace:v1:bundle-manifest" || validated.document.spec.schemaId !== "urn:squire:git-workspace:v1:workspace-spec" || validated.document.workspaceManifest.path !== workspaceManifest.path || validated.document.workspaceManifest.sha256 !== workspaceManifest.sha256 || validated.document.workspaceManifest.schemaId !== workspaceManifest.schemaId) throw new Error("bundle manifest references substituted workspace identity");
    if (validated.document.featureBranch !== spec.featureBranch || validated.document.baseSha !== spec.baseSha || validated.document.objectFormat !== spec.objectFormat || validated.document.bundlePath !== bundle.bundlePath || validated.document.sha256 !== bundle.sha256 || validated.document.byteLength !== bundle.byteLength) throw new Error("bundle manifest binding mismatch");
    const file = await openImmutableFile(path.join(this.#ticketRoot, ...bundle.bundlePath.split("/")), this.#maxBundleBytes, this.#ticketRoot);
    try {
      const digest = await digestDescriptor(file.handle, this.#maxBundleBytes);
      if (digest.sha256 !== bundle.sha256 || digest.byteLength !== bundle.byteLength) throw new Error("persisted Git bundle digest mismatch");
      const verification = await this.#verifyBundleBytes(context, spec, bundle.headSha, file.handle, digest, `git-bundle-reverify-${randomUUID()}`);
      if (verification.refs.length !== 1 || verification.refs[0]?.name !== branchRef(spec.featureBranch) || verification.refs[0]?.oid !== bundle.headSha) throw new Error("persisted Git bundle ref inventory mismatch");
    } finally { await file.handle.close(); }
  }

  async #verifyBundleBytes(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, expectedHead: string, handle: import("node:fs/promises").FileHandle, digest: DescriptorDigest, operationId: string): Promise<{ readonly prerequisites: readonly string[]; readonly refs: readonly { readonly name: string; readonly oid: string }[] }> {
    const descriptor = descriptorPathForGit(handle, 3);
    const verify = await this.#git(context, operationId, "bundle-verify", ["--git-dir", this.#paths(spec.runId).repository, "bundle", "verify", descriptor], { passFileDescriptors: [handle.fd], extraEnv: { GIT_ALLOW_PROTOCOL: "file" } });
    const listed = await this.#git(context, operationId, "bundle-verify", ["--git-dir", this.#paths(spec.runId).repository, "bundle", "list-heads", descriptor], { passFileDescriptors: [handle.fd], extraEnv: { GIT_ALLOW_PROTOCOL: "file" } });
    const refs = parseBundleRefs(listed.stdout, spec.objectFormat);
    assertFullObjectId(expectedHead, spec.objectFormat);
    if (refs.length !== 1 || refs[0]?.name !== branchRef(spec.featureBranch) || refs[0]?.oid !== expectedHead) throw new Error("bundle ref inventory is not exactly the feature branch");
    const prerequisites = parsePrerequisites(`${verify.stdout}\n${verify.stderr}`, spec.objectFormat).filter(value => value !== expectedHead);
    const disposable = path.join(this.#paths(spec.runId).controlRoot, `.bundle-check-${randomUUID()}.git`);
    await this.#assertNoPath(disposable);
    try {
      await assertSafeAncestors(path.dirname(disposable), this.#ticketRoot, false);
      await ensurePrivateDirectory(disposable, this.#ticketRoot);
      await this.#git(context, operationId, "bundle-verify", ["init", "--bare", `--object-format=${spec.objectFormat}`, `--template=${this.#paths(spec.runId).templatePath}`, disposable]);
      await this.#git(context, operationId, "bundle-verify", ["--git-dir", disposable, "fetch", "--no-tags", "--no-recurse-submodules", descriptor, `${branchRef(spec.featureBranch)}:${branchRef(spec.featureBranch)}`], { passFileDescriptors: [handle.fd], extraEnv: { GIT_ALLOW_PROTOCOL: "file" } });
      const baseType = await this.#git(context, operationId, "bundle-verify", ["--git-dir", disposable, "cat-file", "-t", spec.baseSha]);
      const headType = await this.#git(context, operationId, "bundle-verify", ["--git-dir", disposable, "cat-file", "-t", expectedHead]);
      if (baseType.stdout.trim() !== "commit" || headType.stdout.trim() !== "commit") throw new Error("bundle base/head is not a commit");
      const ancestry = await this.#git(context, operationId, "bundle-verify", ["--git-dir", disposable, "merge-base", "--is-ancestor", spec.baseSha, expectedHead], { allowExitCodes: [0, 1] });
      if (ancestry.exitCode !== 0) throw new Error("bundle head is outside the recorded base ancestry");
      await this.#git(context, operationId, "bundle-verify", ["--git-dir", disposable, "fsck", "--full", "--strict", "--no-reflogs"]);
      const format = await this.#git(context, operationId, "bundle-verify", ["--git-dir", disposable, "rev-parse", "--show-object-format"]);
      if (format.stdout.trim() !== spec.objectFormat) throw new Error("bundle object format mismatch");
    } finally { await this.#removeOwnedTemporary(disposable); }
    const after = await digestDescriptor(handle, this.#maxBundleBytes);
    if (after.sha256 !== digest.sha256 || after.byteLength !== digest.byteLength) throw new Error("bundle changed during content verification");
    return { prerequisites, refs };
  }

  async #verifyWorkspace(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, record: GitWorkspaceRecord, expectedHead: string | undefined, requireClean: boolean): Promise<WorkspaceObservation> {
    const fs = this.#paths(spec.runId);
    await this.#authority.assertRunStartAllowed(spec.runId, this.#clock.now());
    const repository = await inspectResource(fs.repository, "directory", true, this.#ticketRoot);
    const worktree = await inspectResource(fs.worktree, "directory", true, this.#ticketRoot);
    const controlRoot = await inspectResource(fs.controlRoot, "directory", true, this.#ticketRoot);
    const artifactRoot = await inspectResource(fs.artifactRoot, "directory", true, this.#ticketRoot);
    const marker = await this.#readOwnershipMarker(fs.controlRoot);
    if (marker.runId !== spec.runId || marker.specFingerprint !== spec.fingerprint || marker.generation > record.operationGeneration) throw new Error("Git workspace ownership marker does not match the persisted operation");
    await this.#assertTrustedControlRoot(fs.controlRoot);
    if (repository.mode !== 0o700 || worktree.mode !== 0o700) throw new Error("Git repository and linked worktree must be private directories");
    const format = (await this.#git(context, record.operation?.operationId ?? context.operationId, "workspace-verify", ["--git-dir", fs.repository, "rev-parse", "--show-object-format"])).stdout.trim();
    if (format !== spec.objectFormat) throw new Error("Git object format does not match workspace spec");
    await this.#verifyRepositorySafety(context, spec, record, false);
    await this.#verifyFetchedBase(context, spec, record);
    await this.#verifyRefAndObjects(context, spec, record);
    const featureHead = await this.#readRef(context, fs.repository, branchRef(spec.featureBranch), spec.objectFormat, record.operation?.operationId ?? context.operationId);
    if (!featureHead) throw new Error("feature ref is missing");
    if (expectedHead && featureHead !== expectedHead) throw new Error("feature head does not match expected head");
    const worktreePair = await this.#verifyWorktreePair(context, spec, record);
    const config = await this.#readAndVerifyConfig(context, spec, record);
    await this.#assertDirectoryEmpty(fs.hooksPath);
    await this.#assertDirectoryEmpty(fs.templatePath);
    const status = await this.#git(context, record.operation?.operationId ?? context.operationId, "workspace-verify", ["status", "--porcelain=v2", "--untracked-files=all", "--no-renames"], { cwd: fs.worktree });
    if (requireClean && status.stdout.length !== 0) throw new Error("initial Git workspace is not clean");
    await this.#authority.assertRunStartAllowed(spec.runId, this.#clock.now());
    const resources: GitWorkspaceResourcesPhysical = { repository, worktree, worktreeGitDir: worktreePair.gitDirIdentity, config: config.identity, hooks: config.hooksIdentity, objects: config.objectsIdentity, alternates: null, artifactRoot, controlRoot };
    return { headSha: featureHead, gitCommonDir: worktreePair.commonDir, worktreeGitDir: worktreePair.gitDir, worktree: fs.worktree, hooksPath: config.hooksPath, objectDirectory: config.objectDirectory, safeConfigDigest: config.digest, resources };
  }

  async #verifyRepositorySafety(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, record: GitWorkspaceRecord, initial: boolean): Promise<void> {
    const fs = this.#paths(spec.runId);
    const configPath = path.join(fs.repository, "config");
    const unsafeFiles = [path.join(fs.repository, "shallow"), path.join(fs.repository, "info", "grafts"), path.join(fs.repository, "objects", "info", "alternates")];
    await this.#assertBareRepositoryTree(fs.repository);
    for (const candidate of unsafeFiles) {
      const kind = await this.#pathKind(candidate);
      if (kind !== "missing") throw new Error(`unsafe Git repository metadata exists: ${candidate}`);
    }
    await this.#assertNoDirectoryEntries(path.join(fs.repository, "objects", "info"), ["alternates", "http-alternates"]);
    const refs = await this.#git(context, record.operation?.operationId ?? context.operationId, "workspace-verify", ["--git-dir", fs.repository, "for-each-ref", "--format=%(refname)%00%(objectname)"]);
    const allowed = new Set([branchRef(spec.featureBranch), INTERNAL_BASE_REF(spec.runId)]);
    const refTokens = refs.stdout.replaceAll("\0", "\n").split("\n").map(value => value.trim()).filter(Boolean);
    if (refTokens.length % 2 !== 0) throw new Error("Git ref inventory contained an incomplete record");
    for (let index = 0; index < refTokens.length; index += 2) {
      const name = refTokens[index];
      const oid = refTokens[index + 1];
      if (!name || !oid || !allowed.has(name)) throw new Error(`unexpected Git ref: ${name ?? "unknown"}`);
      assertFullObjectId(oid, spec.objectFormat);
    }
    const replace = await this.#git(context, record.operation?.operationId ?? context.operationId, "workspace-verify", ["--git-dir", fs.repository, "for-each-ref", "--format=%(refname)", "refs/replace"]);
    if (replace.stdout.trim()) throw new Error("Git replace refs are not allowed");
    const configKind = await this.#pathKind(configPath);
    if (configKind !== "file") throw new Error("Git repository config is missing or not regular");
    if (initial) await inspectResource(configPath, "file", true, this.#ticketRoot);
  }

  async #verifyFetchedBase(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, record: GitWorkspaceRecord): Promise<void> {
    const fs = this.#paths(spec.runId);
    const ref = INTERNAL_BASE_REF(spec.runId);
    const oid = await this.#readRef(context, fs.repository, ref, spec.objectFormat, record.operation?.operationId ?? context.operationId);
    if (!oid || oid !== spec.baseSha) throw new Error("recorded base commit does not exactly match imported base ref");
    const type = await this.#git(context, record.operation?.operationId ?? context.operationId, "verify-import", ["--git-dir", fs.repository, "cat-file", "-t", spec.baseSha]);
    if (type.stdout.trim() !== "commit") throw new Error("recorded base object is not a commit");
    const fsck = await this.#git(context, record.operation?.operationId ?? context.operationId, "verify-import", ["--git-dir", fs.repository, "fsck", "--full", "--strict", "--no-reflogs"]);
    if (/missing|broken|error:/iu.test(fsck.stdout + fsck.stderr)) throw new Error("Git object closure or strict fsck failed");
    const shallow = await this.#git(context, record.operation?.operationId ?? context.operationId, "verify-import", ["--git-dir", fs.repository, "rev-parse", "--is-shallow-repository"], { allowExitCodes: [0, 1] });
    if (shallow.stdout.trim() === "true") throw new Error("shallow Git repository is not allowed");
  }

  async #verifyRefAndObjects(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, record: GitWorkspaceRecord): Promise<void> {
    const fs = this.#paths(spec.runId);
    const feature = await this.#readRef(context, fs.repository, branchRef(spec.featureBranch), spec.objectFormat, record.operation?.operationId ?? context.operationId);
    if (!feature) throw new Error("feature branch ref is missing");
    const type = await this.#git(context, record.operation?.operationId ?? context.operationId, "workspace-verify", ["--git-dir", fs.repository, "cat-file", "-t", feature]);
    if (type.stdout.trim() !== "commit") throw new Error("feature ref does not point to a commit");
    const ancestry = await this.#git(context, record.operation?.operationId ?? context.operationId, "workspace-verify", ["--git-dir", fs.repository, "merge-base", "--is-ancestor", spec.baseSha, feature], { allowExitCodes: [0, 1] });
    if (ancestry.exitCode !== 0) throw new Error("feature branch history is outside the recorded base ancestry");
    const fsck = await this.#git(context, record.operation?.operationId ?? context.operationId, "workspace-verify", ["--git-dir", fs.repository, "fsck", "--full", "--strict", "--no-reflogs"]);
    if (/missing|broken|error:/iu.test(fsck.stdout + fsck.stderr)) throw new Error("feature object closure failed strict fsck");
  }

  async #verifyOwnedRepository(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, record: GitWorkspaceRecord): Promise<void> {
    const fs = this.#paths(spec.runId);
    await inspectResource(fs.repository, "directory", true, this.#ticketRoot);
    const marker = await this.#readOwnershipMarker(fs.controlRoot);
    if (marker.runId !== spec.runId || marker.specFingerprint !== spec.fingerprint || marker.generation !== record.operationGeneration) throw new Error("Git repository ownership marker does not match the current operation");
  }

  async #verifyWorktreePair(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, record: GitWorkspaceRecord): Promise<{ readonly commonDir: string; readonly gitDir: string; readonly gitDirIdentity: ResourceIdentity }> {
    const fs = this.#paths(spec.runId);
    const worktree = await inspectResource(fs.worktree, "directory", true, this.#ticketRoot);
    const dotGit = path.join(fs.worktree, ".git");
    const dotGitIdentity = await inspectResource(dotGit, "file", true, this.#ticketRoot);
    const gitText = (await readExactNoFollow(dotGit, this.#ticketRoot, 16 * 1024)).toString("utf8");
    const match = /^gitdir:\s*(.+)\n$/u.exec(gitText);
    if (!match || !match[1] || match[1].includes("\0")) throw new Error("linked worktree .git metadata is malformed");
    const gitDir = await realpath(path.resolve(path.dirname(dotGit), match[1]));
    const commonDir = await realpath(fs.repository);
    if (gitDir !== path.join(commonDir, "worktrees", path.basename(fs.worktree))) throw new Error("linked worktree gitdir is outside the private common directory");
    await inspectResource(gitDir, "directory", true, this.#ticketRoot);
    await this.#verifyWorktreeMetadata(gitDir, dotGit, spec, fs.worktree);
    const list = await this.#git(context, record.operation?.operationId ?? context.operationId, "workspace-verify", ["--git-dir", fs.repository, "worktree", "list", "--porcelain", "-z"]);
    const entries = parseWorktreeList(list.stdout);
    if (entries.length !== 1) throw new Error("Git repository does not contain exactly one linked worktree");
    const entry = entries[0]!;
    const expectedFeatureHead = await this.#readRef(context, fs.repository, branchRef(spec.featureBranch), spec.objectFormat, record.operation?.operationId ?? context.operationId);
    if (path.resolve(entry.path) !== path.resolve(fs.worktree) || entry.branch !== branchRef(spec.featureBranch) || entry.head !== expectedFeatureHead || entry.detached || entry.locked || entry.prunable) throw new Error("linked worktree metadata is not the exact expected branch/path/head");
    if (dotGitIdentity.linkCount !== 1) throw new Error("linked worktree metadata is hardlinked");
    return { commonDir, gitDir, gitDirIdentity: await inspectResource(gitDir, "directory", true, this.#ticketRoot) };
  }

  async #verifyWorktreeMetadata(gitDir: string, dotGit: string, spec: GitWorkspaceSpecDocument, worktree: string): Promise<void> {
    const entries = await readdir(gitDir);
    const allowed = new Set(["COMMIT_EDITMSG", "HEAD", "ORIG_HEAD", "commondir", "gitdir", "index", "logs", "refs"]);
    if (entries.some(entry => !allowed.has(entry))) throw new Error("linked worktree metadata contains an unknown entry");
    const gitdirIdentity = await inspectResource(path.join(gitDir, "gitdir"), "file", true, this.#ticketRoot);
    const gitdirText = (await readExactNoFollow(path.join(gitDir, "gitdir"), this.#ticketRoot, 16 * 1024)).toString("utf8");
    if (!gitdirText.endsWith("\n") || (await realpath(path.resolve(gitDir, gitdirText.slice(0, -1)))) !== path.resolve(dotGit) || gitdirIdentity.linkCount !== 1) throw new Error("linked worktree gitdir metadata is substituted");
    const commonText = (await readExactNoFollow(path.join(gitDir, "commondir"), this.#ticketRoot, 16 * 1024)).toString("utf8");
    if (commonText !== "../..\n") throw new Error("linked worktree common-dir metadata is substituted");
    const headText = (await readExactNoFollow(path.join(gitDir, "HEAD"), this.#ticketRoot, 16 * 1024)).toString("utf8");
    if (headText !== `ref: ${branchRef(spec.featureBranch)}\n`) throw new Error("linked worktree HEAD is not the exact feature ref");
    await inspectResource(path.join(gitDir, "index"), "file", true, this.#ticketRoot);
    if (entries.includes("COMMIT_EDITMSG")) await inspectResource(path.join(gitDir, "COMMIT_EDITMSG"), "file", true, this.#ticketRoot);
    for (const optional of ["ORIG_HEAD"]) {
      const target = path.join(gitDir, optional);
      if (await this.#pathKind(target) !== "missing") {
        const identity = await inspectResource(target, "file", true, this.#ticketRoot);
        const value = (await readExactNoFollow(target, this.#ticketRoot, 256)).toString("utf8");
        if (identity.linkCount !== 1 || !/^[0-9a-f]+\n$/u.test(value)) throw new Error(`linked worktree ${optional} metadata is malformed`);
        assertFullObjectId(value.slice(0, -1), spec.objectFormat);
      }
    }
    const logs = path.join(gitDir, "logs");
    await inspectResource(logs, "directory", true, this.#ticketRoot);
    const logEntries = await readdir(logs);
    if (logEntries.some(entry => entry !== "HEAD")) throw new Error("linked worktree logs contain an unknown entry");
    if (logEntries.includes("HEAD")) await inspectResource(path.join(logs, "HEAD"), "file", true, this.#ticketRoot);
    const refs = path.join(gitDir, "refs");
    await inspectResource(refs, "directory", true, this.#ticketRoot);
    if ((await readdir(refs)).length !== 0) throw new Error("linked worktree refs are not empty");
    if (path.dirname(path.resolve(dotGit)) !== path.resolve(worktree)) throw new Error("linked worktree path identity is inconsistent");
  }

  async #configureSafeRepository(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, record: GitWorkspaceRecord): Promise<void> {
    const fs = this.#paths(spec.runId);
    const config = path.join(fs.repository, "config");
    await this.#assertConfigIsNotSubstituted(context, spec, record);
    const values: readonly [string, string][] = [
      ["core.bare", "true"], ["core.hooksPath", fs.hooksPath], ["user.name", "Squire"], ["user.email", SAFE_GIT_EMAIL], ["credential.helper", ""],
      ["commit.gpgSign", "false"], ["tag.gpgSign", "false"], ["core.fsmonitor", "false"], ["submodule.recurse", "false"],
      ["fetch.recurseSubmodules", "false"], ["protocol.file.allow", "never"], ["protocol.ext.allow", "never"], ["protocol.ssh.allow", "never"],
      ["transfer.fsckObjects", "true"],
    ];
    for (const [key, value] of values) await this.#git(context, record.operation?.operationId ?? context.operationId, "config", ["config", "--file", config, "--no-includes", "--replace-all", key, value]);
    await chmod(config, 0o600);
    await this.#readAndVerifyConfig(context, spec, record);
  }

  async #assertConfigIsNotSubstituted(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, record: GitWorkspaceRecord): Promise<void> {
    const fs = this.#paths(spec.runId);
    const configPath = path.join(fs.repository, "config");
    const raw = (await readExactNoFollow(configPath, this.#ticketRoot, 256 * 1024)).toString("utf8");
    if (/^\s*\[(?:include|includeIf)\b|^\s*(?:path|gitdir|onbranch)\s*=.*(?:include|\.git)/imu.test(raw)) throw new Error("Git config includes are not allowed");
    if (/(?:filter\.|diff\.|credential\.|url\.|remote\.|alias\.|submodule\.|core\.worktree|core\.sshCommand|uploadpack|receivepack|extensions\.(?!objectformat\s*=))/iu.test(raw)) throw new Error("Git config contains an untrusted feature or external path");
    const list = await this.#git(context, record.operation?.operationId ?? context.operationId, "config", ["config", "--file", configPath, "--no-includes", "--null", "--list"]);
    const expected = this.#expectedConfigValues(fs, spec);
    for (const [key, value] of parseConfigList(list.stdout)) {
      const allowed = expected.get(key.toLowerCase());
      if (!allowed || !allowed.has(value)) throw new Error(`untrusted or unexpected Git config key/value: ${key}`);
    }
  }

  #expectedConfigValues(fs: GitWorkspaceFilesystemPaths, spec: GitWorkspaceSpecDocument): Map<string, Set<string>> {
    const expected = new Map<string, Set<string>>([
      ["core.repositoryformatversion", new Set([spec.objectFormat === "sha256" ? "1" : "0"])], ["core.filemode", new Set(["true", "false"])], ["core.bare", new Set(["true"])], ["core.hookspath", new Set([fs.hooksPath])],
      ["user.name", new Set(["Squire"])], ["user.email", new Set([SAFE_GIT_EMAIL])], ["credential.helper", new Set([""])], ["commit.gpgsign", new Set(["false"])], ["tag.gpgsign", new Set(["false"])],
      ["core.fsmonitor", new Set(["false"])], ["submodule.recurse", new Set(["false"])], ["fetch.recursesubmodules", new Set(["false"])],
      ["protocol.file.allow", new Set(["never"])], ["protocol.ext.allow", new Set(["never"])], ["protocol.ssh.allow", new Set(["never"])], ["transfer.fsckobjects", new Set(["true"])],
    ]);
    if (spec.objectFormat === "sha256") expected.set("extensions.objectformat", new Set(["sha256"]));
    return expected;
  }

  async #readAndVerifyConfig(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, record: GitWorkspaceRecord): Promise<{ readonly identity: ResourceIdentity; readonly hooksIdentity: ResourceIdentity; readonly objectsIdentity: ResourceIdentity; readonly hooksPath: string; readonly objectDirectory: string; readonly digest: string }> {
    const fs = this.#paths(spec.runId);
    const configPath = path.join(fs.repository, "config");
    const configIdentity = await inspectResource(configPath, "file", true, this.#ticketRoot);
    if (configIdentity.mode !== 0o600) throw new Error("Git repository config is not a private file");
    const bytes = await readExactNoFollow(configPath, this.#ticketRoot, 256 * 1024);
    const raw = bytes.toString("utf8");
    if (/^\s*\[(?:include|includeIf)\b|^\s*(?:path|gitdir|onbranch)\s*=.*(?:include|\.git)/imu.test(raw)) throw new Error("Git config includes are not allowed");
    if (/(?:filter\.|diff\.|credential\.|url\.|remote\.|alias\.|submodule\.|core\.worktree|core\.sshCommand|uploadpack|receivepack|extensions\.(?!objectformat\s*=))/iu.test(raw)) throw new Error("Git config contains an untrusted feature or external path");
    const list = await this.#git(context, record.operation?.operationId ?? context.operationId, "config", ["config", "--file", configPath, "--no-includes", "--null", "--list"]);
    const entries = parseConfigList(list.stdout);
    const expected = this.#expectedConfigValues(fs, spec);
    for (const [key, value] of entries) {
      const normalized = key.toLowerCase();
      const allowed = expected.get(normalized);
      if (!allowed || !allowed.has(value)) throw new Error(`untrusted or unexpected Git config key/value: ${key}`);
    }
    for (const [key, allowed] of expected) {
      if (![...entries].some(([candidate, value]) => candidate.toLowerCase() === key && allowed.has(value))) throw new Error(`required safe Git config value is missing: ${key}`);
    }
    const hooksPath = path.resolve(fs.hooksPath);
    const objectsPath = path.resolve(fs.repository, "objects");
    if (hooksPath !== path.resolve(fs.hooksPath) || !hooksPath.startsWith(`${this.#ticketRoot}${path.sep}`) || objectsPath !== path.resolve(fs.repository, "objects")) throw new Error("Git config path escaped the ticket root");
    const hooksIdentity = await inspectResource(hooksPath, "directory", true, this.#ticketRoot);
    const objectsIdentity = await inspectResource(objectsPath, "directory", true, this.#ticketRoot);
    if ((await this.#pathKind(path.join(objectsPath, "info", "alternates"))) !== "missing") throw new Error("Git alternates are not allowed");
    return { identity: configIdentity, hooksIdentity, objectsIdentity, hooksPath, objectDirectory: objectsPath, digest: createHash("sha256").update(bytes).digest("hex") };
  }

  async #writeOwnershipMarker(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, generation: number): Promise<void> {
    const fs = this.#paths(spec.runId);
    const target = path.join(fs.controlRoot, OWNERSHIP_FILE);
    const document = { schemaVersion: 1, kind: OWNERSHIP_KIND, runId: spec.runId, specFingerprint: spec.fingerprint, generation, repository: "/ticket/git/repo.git", worktree: "/ticket/workspace" };
    const bytes = serializeCanonical(document);
    const existing = await this.#pathKind(target);
    if (existing === "missing") {
      await this.#authority.assertRunStartAllowed(spec.runId, this.#clock.now());
      const handle = await openNoFollow(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      try { await handle.writeFile(bytes); await handle.chmod(0o600); await handle.sync(); } finally { await handle.close(); }
      await inspectResource(target, "file", true, this.#ticketRoot);
    } else {
      const actual = await readExactNoFollow(target, this.#ticketRoot, 16 * 1024);
      if (!actual.equals(bytes)) throw new Error("Git workspace ownership marker is substituted");
    }
  }

  async #readOwnershipMarker(controlRoot: string): Promise<{ readonly runId: string; readonly specFingerprint: string; readonly generation: number }> {
    const target = path.join(controlRoot, OWNERSHIP_FILE);
    const identity = await inspectResource(target, "file", true, this.#ticketRoot);
    if (identity.linkCount !== 1 || identity.mode !== 0o600) throw new Error("Git ownership marker is not a private regular file");
    const bytes = await readExactNoFollow(target, this.#ticketRoot, 16 * 1024);
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Git ownership marker is malformed"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Git ownership marker is malformed");
    const value = parsed as Record<string, unknown>;
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["generation", "kind", "repository", "runId", "schemaVersion", "specFingerprint", "worktree"]) || value["kind"] !== OWNERSHIP_KIND || value["schemaVersion"] !== 1 || typeof value["runId"] !== "string" || typeof value["specFingerprint"] !== "string" || !Number.isSafeInteger(value["generation"]) || (value["generation"] as number) < 1 || value["repository"] !== "/ticket/git/repo.git" || value["worktree"] !== "/ticket/workspace" || !serializeCanonical(value).equals(bytes)) throw new Error("Git ownership marker is malformed");
    return { runId: value["runId"], specFingerprint: value["specFingerprint"], generation: value["generation"] as number };
  }

  async #ensureRoots(fs: GitWorkspaceFilesystemPaths, context: GitLeaseContext): Promise<void> {
    await this.#authority.assertRunStartAllowed(fs.ticketRoot === this.#ticketRoot ? context.runId : context.runId, this.#clock.now());
    await ensurePrivateDirectory(fs.gitRoot, this.#ticketRoot);
    await ensurePrivateDirectory(path.join(this.#ticketRoot, "control"), this.#ticketRoot);
    await ensurePrivateDirectory(path.join(this.#ticketRoot, "control", "git"), this.#ticketRoot);
    await ensurePrivateDirectory(fs.controlRoot, this.#ticketRoot);
    await ensurePrivateDirectory(fs.artifactsRoot, this.#ticketRoot);
    await ensurePrivateDirectory(path.join(fs.artifactsRoot, "git"), this.#ticketRoot);
    await ensurePrivateDirectory(fs.artifactRoot, this.#ticketRoot);
  }

  async #assertNoUnownedGitPaths(fs: GitWorkspaceFilesystemPaths): Promise<void> {
    const marker = path.join(fs.controlRoot, OWNERSHIP_FILE);
    if (await this.#pathKind(marker) !== "missing") return;
    for (const target of [fs.repository, fs.worktree]) {
      if (await this.#pathKind(target) !== "missing") throw new Error(`pre-existing unowned Git workspace path: ${target}`);
    }
    if ((await readdir(fs.controlRoot)).length !== 0) throw new Error("pre-existing unowned Git control state");
  }

  async #ensureTemplateAndHooks(fs: GitWorkspaceFilesystemPaths, context: GitLeaseContext): Promise<void> {
    await ensurePrivateDirectory(fs.hooksPath, this.#ticketRoot);
    await ensurePrivateDirectory(fs.templatePath, this.#ticketRoot);
    await this.#assertDirectoryEmpty(fs.hooksPath);
    await this.#assertDirectoryEmpty(fs.templatePath);
    await this.#authority.assertRunStartAllowed(context.runId, this.#clock.now());
  }

  async #updateRecord(context: GitLeaseContext, mutate: (snapshot: RunSnapshot) => RunSnapshot | GitWorkspaceRecord): Promise<RunSnapshot> {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      await this.#renew(context);
      const current = await this.#store.read(context.runId);
      if (!current) throw new Error("run not found");
      try {
        const changed = mutate(current);
        const next = isSnapshot(changed) ? changed : { ...current, gitWorkspace: changed };
        const normalized: RunSnapshot = next.version === current.version + 1 ? next : { ...next, version: current.version + 1 };
        return await this.#store.compareAndSetFenced(context.runId, { version: current.version }, this.#guard(context), () => normalized);
      } catch (error) {
        if (!(error instanceof StoreConflictError)) throw error;
        await this.#renew(context);
      }
    }
    throw new StoreConflictError("Git workspace CAS did not converge within the retry bound");
  }

  async #setCommand(context: GitLeaseContext, operationId: string, step: GitOperationStep, state: "reserved" | "spawning" | "spawned" | "exited" | "unknown", processIdentity?: string): Promise<void> {
    // Read-only verification/status commands run without a lifecycle operation.
    // Do not manufacture a second lifecycle or mutate the snapshot merely to
    // record an observation; provisioning/export commands always have one.
    const before = await this.#store.read(context.runId);
    if (!before?.gitWorkspace) throw new StoreConflictError("Git workspace record is missing");
    if (!before.gitWorkspace.operation) return;
    await this.#updateRecord(context, snapshot => {
      const record = snapshot.gitWorkspace;
      if (!record || !record.operation || record.operation.operationId !== operationId) throw new StoreConflictError("Git operation ownership changed");
      const command = { operationId, step, state, owner: context.preparationOwner, fencingToken: context.lease.fencingToken, ...(processIdentity ? { processIdentity } : {}) } as const;
      return { ...snapshot, gitWorkspace: { ...record, operation: { ...record.operation, step, command } } };
    });
  }

  async #git(context: GitLeaseContext, operationId: string, step: GitOperationStep, args: readonly string[], overrides: Partial<Pick<GitCommandOptions, "cwd" | "allowExitCodes" | "allowNetwork" | "passFileDescriptors" | "extraEnv">> = {}): Promise<GitCommandResult> {
    await this.#authority.assertRunStartAllowed(context.runId, this.#clock.now());
    await this.#setCommand(context, operationId, step, "reserved");
    await this.#setCommand(context, operationId, step, "spawning");
    let spawnPersist: Promise<void> | undefined;
    let spawnFailure: unknown;
    const options: GitCommandOptions = { cwd: this.#ticketRoot, runId: context.runId, ticketRoot: this.#ticketRoot, timeoutMs: this.#commandTimeoutMs, maxOutputBytes: this.#commandOutputBytes, ...overrides, onSpawn: process => { spawnPersist = this.#setCommand(context, operationId, step, "spawned", process.identity).catch(error => { spawnFailure = error; }); } };
    try {
      const result = await this.#command.run(args, options);
      await spawnPersist;
      if (spawnFailure) throw spawnFailure;
      await this.#setCommand(context, operationId, step, "exited", result.processIdentity);
      await this.#authority.assertRunStartAllowed(context.runId, this.#clock.now());
      return result;
    } catch (error) {
      await spawnPersist?.catch(() => undefined);
      if (error instanceof GitCommandError && error.result) {
        await this.#setCommand(context, operationId, step, "exited", error.result.processIdentity).catch(() => undefined);
      } else {
        await this.#setCommand(context, operationId, step, "unknown").catch(() => undefined);
      }
      throw error;
    }
  }

  async #readFeatureHead(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, operationId: string): Promise<string> {
    const value = await this.#readRef(context, this.#paths(spec.runId).repository, branchRef(spec.featureBranch), spec.objectFormat, operationId);
    if (!value) throw new Error("feature ref is missing");
    return value;
  }

  async #readRef(context: GitLeaseContext, repository: string, ref: string, format: GitObjectFormat, operationId: string): Promise<string | undefined> {
    const check = ref.startsWith("refs/heads/") ? assertGitRefFormat : async (value: string, checker: { checkRefFormat(refName: string): Promise<void> }): Promise<void> => { assertValidInternalRefName(value); await checker.checkRefFormat(value); };
    await check(ref, { checkRefFormat: async value => { await this.#git(context, operationId, "workspace-verify", ["--git-dir", repository, "check-ref-format", value]); } });
    const result = await this.#git(context, operationId, "workspace-verify", ["--git-dir", repository, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { allowExitCodes: [0, 128] });
    if (result.exitCode !== 0 || !result.stdout.trim()) return undefined;
    const value = result.stdout.trim();
    assertFullObjectId(value, format);
    if (value.includes("\n")) throw new Error("Git ref output contained duplicate/ambiguous object IDs");
    return value;
  }

  async #block(context: GitLeaseContext, runId: string, error: unknown, code: string): Promise<void> {
    try {
      const message = error instanceof Error ? error.message : String(error);
      await this.#updateRecord(context, snapshot => {
        const current = snapshot.gitWorkspace;
        if (!current || current.stage === "blocked") return snapshot;
        const command = current.operation?.command;
        const unresolved = command && ["spawning", "spawned", "unknown"].includes(command.state);
        const nextBase = unresolved ? current : (() => { const { operation: _operation, ...withoutOperation } = current; return withoutOperation; })();
        return { ...snapshot, gitWorkspace: { ...nextBase, stage: "blocked", ...(unresolved && current.operation ? { operation: current.operation } : {}), error: { code, message: redact(message).replaceAll(this.#ticketRoot, "/ticket"), at: new Date(this.#clock.now()).toISOString() }, evidence: [`control/git/${runId}/operation.json`] } as GitWorkspaceRecord };
      });
    } catch { /* A terminal fence or lost generic lease must remain fail-closed. */ }
  }

  async #renew(context: GitLeaseContext): Promise<void> {
    const renewed = await this.#store.renewLease(context.runId, GIT_LEASE_KEY, context.owner, context.lease.fencingToken, this.#clock.now(), this.#operationLeaseMs);
    if (!renewed) throw new StoreConflictError("Git workspace lease was fenced or expired");
    context.lease.expiresAt = renewed.expiresAt;
  }

  #guard(context: GitLeaseContext): LeaseGuard { return { key: GIT_LEASE_KEY, owner: context.owner, fencingToken: context.lease.fencingToken, now: this.#clock.now() }; }

  #assertExistingRecord(existing: GitWorkspaceRecord | undefined, spec: GitWorkspaceSpecDocument, reference: ContractReference, runId: string): void {
    if (!existing) return;
    this.#assertRecordIdentity(existing, spec, reference);
    if (existing.runId !== runId) throw new Error("Git workspace record run identity mismatch");
  }

  #assertRecordIdentity(record: GitWorkspaceRecord, spec: GitWorkspaceSpecDocument, reference: ContractReference): void {
    if (record.runId !== spec.runId || record.spec.path !== reference.path || record.spec.sha256 !== reference.sha256 || record.spec.schemaId !== reference.schemaId || record.specFingerprint !== spec.fingerprint || record.featureBranch !== spec.featureBranch || record.operationGeneration < 1 || canonicalJson(record.paths) !== canonicalJson(logicalGitWorkspacePaths(spec.runId))) throw new Error("Git workspace immutable identity mismatch");
    const operation = record.operation;
    if (operation) {
      if (typeof operation.operationId !== "string" || operation.operationId.length === 0 || operation.operationId.length > 200 || typeof operation.owner !== "string" || operation.owner !== `git-operation-${operation.operationId}` || !GIT_OPERATION_STEPS.has(operation.step) || operation.generation !== record.operationGeneration || !Number.isSafeInteger(operation.generation) || typeof operation.startedAt !== "string" || !Number.isFinite(Date.parse(operation.startedAt))) throw new Error("Git workspace operation identity is malformed");
      if (operation.command && (typeof operation.command.operationId !== "string" || operation.command.operationId !== operation.operationId || typeof operation.command.owner !== "string" || operation.command.owner !== operation.owner || !GIT_COMMAND_STATES.has(operation.command.state) || !Number.isSafeInteger(operation.command.fencingToken) || operation.command.fencingToken < 1)) throw new Error("Git command allocation identity is malformed");
    }
  }

  #assertLogicalSpecPaths(spec: GitWorkspaceSpecDocument, runId: string): void {
    if (canonicalJson(spec.paths) !== canonicalJson(logicalGitWorkspacePaths(runId))) throw new Error("workspace spec paths are not the fixed logical paths");
  }

  #assertAuthorizedTransport(repository: GitRepositoryIdentity, authorization: GitSourceAuthorization): void {
    if (authorization.localTransport) {
      if (!this.#allowLocalTransport) throw new Error("local Git transport is disabled in production");
      if (!/^(?:file:|[A-Za-z]:[\\/]|\\\\|\/)/u.test(authorization.cloneUrl)) throw new Error("test local transport authorization is not local");
      return;
    }
    assertCredentialFreeHttpsCloneUrl(authorization.cloneUrl, repository.owner, repository.name);
  }

  #readyResult(spec: GitWorkspaceSpecDocument, record: GitWorkspaceRecord, headSha?: string): ReadyGitWorkspace {
    if ((record.stage !== "ready" && record.stage !== "retained") || !record.manifest) throw new Error("record is not ready");
    return { runId: spec.runId, spec: record.spec, manifest: record.manifest, featureBranch: spec.featureBranch, headSha: headSha ?? record.headSha, objectFormat: spec.objectFormat, paths: record.paths, ...(record.bundle ? { bundle: record.bundle } : {}) };
  }

  #logicalPath(physical: string): string {
    const absolute = path.resolve(physical);
    const relative = path.relative(this.#ticketRoot, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Git workspace path escaped ticket root");
    return `/ticket/${relative.split(path.sep).join("/")}`;
  }

  #logicalResource(resource: ResourceIdentity): ResourceIdentity { return { ...resource, path: this.#logicalPath(resource.path) }; }
  #logicalResources(resources: GitWorkspaceResourcesPhysical) { return { repository: this.#logicalResource(resources.repository), worktree: this.#logicalResource(resources.worktree), worktreeGitDir: this.#logicalResource(resources.worktreeGitDir), config: this.#logicalResource(resources.config), hooks: this.#logicalResource(resources.hooks), objects: this.#logicalResource(resources.objects), alternates: null, artifactRoot: this.#logicalResource(resources.artifactRoot), controlRoot: this.#logicalResource(resources.controlRoot) } as const; }

  async #existingContractReference(relativePath: string, schemaId: ContractReference["schemaId"]): Promise<ContractReference | undefined> {
    const physical = path.join(this.#ticketRoot, ...relativePath.split("/"));
    await assertSafeAncestors(path.dirname(physical), this.#ticketRoot, false);
    const kind = await this.#pathKind(physical);
    if (kind === "missing") return undefined;
    if (kind !== "file") throw new GitWorkspaceContractError("existing Git contract is not a regular file");
    const file = await openNoFollow(physical);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600) throw new GitWorkspaceContractError("existing Git contract is not a private regular file");
      if (!Number.isSafeInteger(before.size) || before.size > 16 * 1024 * 1024) throw new GitWorkspaceContractError("existing Git contract exceeds size limit");
      const bytes = Buffer.allocUnsafe(before.size);
      let offset = 0;
      while (offset < before.size) {
        const read = await file.read(bytes, offset, before.size - offset, offset);
        if (read.bytesRead <= 0) throw new GitWorkspaceContractError("existing Git contract ended during bounded read");
        offset += read.bytesRead;
      }
      const after = await file.stat();
      if (!sameStat(before, after)) throw new GitWorkspaceContractError("existing Git contract changed during identity read");
      return { path: relativePath, sha256: sha256Bytes(bytes), schemaId };
    } finally { await file.close(); }
  }

  async #pathKind(target: string): Promise<"file" | "directory" | "symlink" | "other" | "missing"> {
    const info = await lstat(target).catch(error => { if (isMissing(error)) return undefined; throw error; });
    if (!info) return "missing";
    return entryKind(info);
  }

  async #assertNoPath(target: string): Promise<void> {
    const kind = await this.#pathKind(target);
    if (kind !== "missing") throw new Error(`unexpected pre-existing Git workspace path: ${target}`);
  }

  async #assertDirectoryEmpty(directory: string): Promise<void> {
    const kind = await this.#pathKind(directory);
    if (kind !== "directory") throw new Error(`Git trusted directory is not a directory: ${directory}`);
    const entries = await readdir(directory);
    if (entries.length !== 0) throw new Error(`Git trusted directory is not empty: ${directory}`);
  }

  async #assertNoDirectoryEntries(directory: string, forbidden: readonly string[]): Promise<void> {
    const kind = await this.#pathKind(directory);
    if (kind === "missing") return;
    if (kind !== "directory") throw new Error(`Git metadata directory is not a directory: ${directory}`);
    const entries = await readdir(directory);
    for (const name of forbidden) if (entries.includes(name)) throw new Error(`forbidden Git metadata entry: ${name}`);
  }

  async #assertTrustedControlRoot(controlRoot: string): Promise<void> {
    const allowed = new Set([OWNERSHIP_FILE, "hooks", "template"]);
    const entries = await readdir(controlRoot);
    if (entries.some(entry => !allowed.has(entry))) throw new Error("Git control root contains unknown state");
    for (const directory of [path.join(controlRoot, "hooks"), path.join(controlRoot, "template")]) {
      await inspectResource(directory, "directory", true, this.#ticketRoot);
    }
  }

  async #assertBareRepositoryTree(repository: string): Promise<void> {
    const root = await lstat(repository);
    const device = String(root.dev);
    const pending = [repository];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const child = path.join(directory, entry.name);
        const info = await lstat(child);
        if (String(info.dev) !== device) throw new Error(`Git repository tree crosses a filesystem boundary: ${child}`);
        const kind = entryKind(info);
        if ([".promisor", "alternates", "http-alternates", "grafts", "shallow"].includes(entry.name)) throw new Error(`partial or alternate Git metadata is not trusted: ${child}`);
        if (kind === "symlink") throw new Error(`symbolic link in Git repository metadata is not trusted: ${child}`);
        if (kind === "other") throw new Error(`unsupported Git repository metadata entry: ${child}`);
        if (kind === "file") {
          if (info.nlink !== 1) throw new Error(`hardlinked Git repository metadata is not trusted: ${child}`);
        } else pending.push(child);
      }
    }
  }

  async #removeOwnedTemporary(target: string): Promise<void> {
    const kind = await this.#pathKind(target);
    if (kind === "missing") return;
    const name = path.basename(target);
    if (!BUNDLE_STAGING.test(name) && !BUNDLE_CHECK.test(name)) return;
    if (kind === "symlink") { await removeTreeNoFollow(target, undefined, this.#ticketRoot); return; }
    const identity = await inspectResource(target, kind === "directory" ? "directory" : "file", true, this.#ticketRoot);
    await removeTreeNoFollow(target, identity, this.#ticketRoot);
  }

  async #removeEmptyControllerRoot(target: string, runId: string, fence: RunTerminalFence, signal?: AbortSignal): Promise<void> {
    if (target === this.#ticketRoot || target === "/ticket") return;
    const kind = await this.#pathKind(target);
    if (kind === "missing") return;
    if (kind !== "directory") throw new Error(`Git controller root was replaced: ${target}`);
    const entries = await readdir(target);
    if (entries.length !== 0) return;
    const identity = await inspectResource(target, "directory", true, this.#ticketRoot);
    await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
    const beforeRemoval = await inspectResource(target, "directory", true, this.#ticketRoot);
    if (!sameResourceIdentity(identity, beforeRemoval)) throw new Error(`Git controller root changed before removal: ${target}`);
    if (signal?.aborted) throw new Error("Git disposal was aborted");
    try { await rmdir(target); } catch (error) {
      if (isMissing(error) || hasCode(error, "ENOTEMPTY")) return;
      throw error;
    }
    await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
  }

  async #ensureDisposalRoot(fs: GitWorkspaceFilesystemPaths): Promise<void> {
    await ensurePrivateDirectory(fs.disposalRoot, this.#ticketRoot);
  }

  async #assertDisposalDirectory(directory: string, runId: string, token: number): Promise<void> {
    const name = path.basename(directory);
    const match = DISPOSAL_DIRECTORY.exec(name);
    if (!match || match[1] !== runId || Number(match[2]) !== token) throw new Error("Git disposal directory identity is invalid");
    const kind = await this.#pathKind(directory);
    if (kind === "missing") {
      await assertSafeAncestors(path.dirname(directory), this.#ticketRoot, false);
      try { await mkdir(directory, { recursive: false, mode: 0o700 }); } catch (error) { if (!isAlreadyExists(error)) throw error; }
      const handle = await openNoFollow(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
      try { await handle.chmod(0o700); await handle.sync(); } finally { await handle.close(); }
    }
    else if (kind !== "directory") throw new Error("Git disposal directory was replaced");
    const identity = await inspectResource(directory, "directory", true, this.#ticketRoot);
    if (identity.mode !== 0o700) throw new Error("Git disposal directory is not private");
  }

  #physicalPath(logical: string): string {
    if (!logical.startsWith("/ticket/")) throw new Error("logical Git path is not under /ticket");
    return path.join(this.#ticketRoot, ...logical.slice("/ticket/".length).split("/"));
  }

  async #disposeOne(runId: string, fence: RunTerminalFence, target: string, source: string, destination: string, expected: ResourceIdentity | undefined, removed: string[], alreadyAbsent: string[], signal?: AbortSignal, retries = 0): Promise<void> {
    const completion = path.join(path.dirname(destination), `.complete-${target}.json`);
    const sourceKind = await this.#pathKind(source);
    const destinationKind = await this.#pathKind(destination);
    if (sourceKind === "missing" && destinationKind === "missing") {
      if (await this.#hasDisposalCompletion(completion, runId, fence.fencingToken, target, expected)) { alreadyAbsent.push(source); return; }
      throw new Error("Git disposal found neither source nor a proven completed target");
    }
    if (sourceKind === "missing") {
      if (destinationKind !== "directory" && destinationKind !== "file") throw new Error("Git disposal destination is an unsafe replacement");
      if (!expected) throw new Error("Git disposal found an unproved destination");
      const moved = await inspectResource(destination, expected.kind, true, this.#ticketRoot);
      if (!matchesCleanupIdentity(moved, expected)) throw new Error("Git disposal destination identity mismatch");
      await this.#writeDisposalCompletion(completion, runId, fence, target, moved);
      await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
      if (signal?.aborted) throw new Error("Git disposal was aborted");
      await removeTreeNoFollow(destination, moved, this.#ticketRoot);
      await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
      removed.push(source);
      return;
    }
    if (sourceKind !== "directory" && sourceKind !== "file") throw new Error("Git disposal source is not a regular trusted resource");
    if (destinationKind !== "missing") throw new Error("Git disposal found both source and destination; replacement is preserved");
    const sourceIdentity = await inspectResource(source, sourceKind, true, this.#ticketRoot);
    if (expected && !matchesCleanupIdentity(sourceIdentity, expected)) throw new Error("Git disposal source identity mismatch");
    await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
    if (signal?.aborted) throw new Error("Git disposal was aborted");
    try { await renameWithIdentity(source, destination, this.#ticketRoot, sourceIdentity); }
    catch (error) {
      const raced = isMissing(error) || error instanceof GitPathSecurityError && error.message === `disposal destination already exists: ${destination}`;
      if (raced && retries < 3) return await this.#disposeOne(runId, fence, target, source, destination, expected, removed, alreadyAbsent, signal, retries + 1);
      throw error;
    }
    await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
    const moved = await inspectResource(destination, sourceIdentity.kind, true, this.#ticketRoot);
    if (expected && !matchesCleanupIdentity(moved, expected)) throw new Error("Git disposal destination identity mismatch");
    await this.#writeDisposalCompletion(completion, runId, fence, target, moved);
    await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
    if (signal?.aborted) throw new Error("Git disposal was aborted");
    await removeTreeNoFollow(destination, moved, this.#ticketRoot);
    await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
    removed.push(source);
  }

  async #writeDisposalIdentity(target: string, runId: string, fence: RunTerminalFence, manifest: ContractReference, resources: GitWorkspaceManifestDocument["resources"]): Promise<void> {
    const document = serializeCanonical({ schemaVersion: 1, kind: "squire-git-disposal-identity", runId, token: fence.fencingToken, manifest, resources });
    const kind = await this.#pathKind(target);
    if (kind === "missing") {
      await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
      await writeExclusiveFile(target, document, this.#ticketRoot, 0o600);
      await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
      return;
    }
    if (kind !== "file") throw new Error("Git disposal identity is an unsafe replacement");
    const identity = await inspectResource(target, "file", true, this.#ticketRoot);
    if (identity.mode !== 0o600 || !(await readExactNoFollow(target, this.#ticketRoot, 64 * 1024)).equals(document)) throw new Error("Git disposal identity was substituted");
  }

  async #readDisposalIdentity(target: string, runId: string, token: number, manifest: ContractReference): Promise<GitWorkspaceManifestDocument["resources"]> {
    const identity = await inspectResource(target, "file", true, this.#ticketRoot);
    if (identity.mode !== 0o600) throw new Error("Git disposal identity is not private");
    let value: unknown;
    const bytes = await readExactNoFollow(target, this.#ticketRoot, 64 * 1024);
    try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Git disposal identity is not JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Git disposal identity is malformed");
    const document = value as Record<string, unknown>;
    if (JSON.stringify(Object.keys(document).sort()) !== JSON.stringify(["kind", "manifest", "resources", "runId", "schemaVersion", "token"]) || document["schemaVersion"] !== 1 || document["kind"] !== "squire-git-disposal-identity" || document["runId"] !== runId || document["token"] !== token || !document["manifest"] || typeof document["manifest"] !== "object" || Array.isArray(document["manifest"]) || !document["resources"] || typeof document["resources"] !== "object" || Array.isArray(document["resources"]) || !serializeCanonical(document).equals(bytes)) throw new Error("Git disposal identity is malformed");
    const reference = document["manifest"] as Record<string, unknown>;
    if (JSON.stringify(Object.keys(reference).sort()) !== JSON.stringify(["path", "schemaId", "sha256"]) || reference["path"] !== manifest.path || reference["sha256"] !== manifest.sha256 || reference["schemaId"] !== manifest.schemaId) throw new Error("Git disposal identity manifest reference mismatch");
    return parseDisposalResources(document["resources"], runId);
  }

  async #hasDisposalCompletion(target: string, runId: string, token: number, name: string, expected: ResourceIdentity | undefined): Promise<boolean> {
    const kind = await this.#pathKind(target);
    if (kind === "missing") return false;
    if (kind !== "file") throw new Error("Git disposal completion marker is an unsafe replacement");
    const identity = await inspectResource(target, "file", true, this.#ticketRoot);
    if (identity.mode !== 0o600) throw new Error("Git disposal completion marker is not private");
    const document = parseDisposalCompletion(await readExactNoFollow(target, this.#ticketRoot, 16 * 1024));
    if (document.runId !== runId || document.token !== token || document.target !== name || (expected && !matchesCleanupIdentity(document.identity, expected))) throw new Error("Git disposal completion marker identity mismatch");
    return true;
  }

  async #writeDisposalCompletion(target: string, runId: string, fence: RunTerminalFence, name: string, identity: ResourceIdentity): Promise<void> {
    const document = serializeCanonical({ schemaVersion: 1, kind: "squire-git-disposal-complete", runId, token: fence.fencingToken, target: name, identity: { kind: identity.kind, device: identity.device, inode: identity.inode, mode: identity.mode, linkCount: identity.linkCount } });
    const kind = await this.#pathKind(target);
    if (kind === "missing") {
      await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
      await writeExclusiveFile(target, document, this.#ticketRoot, 0o600);
      await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
      return;
    }
    if (kind !== "file") throw new Error("Git disposal completion marker is an unsafe replacement");
    const existing = await inspectResource(target, "file", true, this.#ticketRoot);
    if (existing.mode !== 0o600 || !(await readExactNoFollow(target, this.#ticketRoot, 16 * 1024)).equals(document)) throw new Error("Git disposal completion marker was substituted");
  }

  async #assertPublishingGates(snapshot: RunSnapshot, expectedHead: string): Promise<void> {
    if (snapshot.state !== "publishing") throw new Error("Git bundle export requires publishing workflow state");
    if (snapshot.currentHead !== expectedHead) throw new Error("Git bundle export head is not the persisted workflow head");
    const review = snapshot.gates.review;
    const test = snapshot.gates.test;
    if (!review || !test || review.head !== expectedHead || test.head !== expectedHead || review.implementGeneration !== snapshot.implementGeneration || test.implementGeneration !== snapshot.implementGeneration) throw new Error("Git bundle export requires fresh Review and Test gates");
    for (const gate of [review, test]) {
      const accepted = snapshot.attempts.find(attempt => attempt.phase === gate.phase && attempt.attempt === gate.attempt)?.accepted;
      if (!accepted || accepted.status !== "pass" || accepted.outputHead !== expectedHead || accepted.reference.path !== gate.result.path || accepted.reference.sha256 !== gate.result.sha256 || accepted.reference.schemaId !== gate.result.schemaId) throw new Error("Git bundle gate is not backed by an accepted pass result");
    }
  }
}

export function createGitWorkspaceService(options: GitWorkspaceServiceOptions): GitWorkspaceService { return new GitWorkspaceService(options); }

function parseWorktreeList(value: string): Array<{ path: string; head: string; branch?: string; detached: boolean; locked: boolean; prunable: boolean }> {
  const records: Array<Record<string, string>> = [];
  let current: Record<string, string> = {};
  const tokens = value.split(/\0|\n/gu);
  for (const token of tokens) {
    const line = token.trim();
    if (!line) {
      if (Object.keys(current).length) { records.push(current); current = {}; }
      continue;
    }
    const separator = line.indexOf(" ");
    if (separator < 0) { current[line] = "true"; continue; }
    current[line.slice(0, separator)] = line.slice(separator + 1);
  }
  if (Object.keys(current).length) records.push(current);
  return records.filter(record => !("bare" in record)).map(record => ({ path: record["worktree"] ?? "", head: record["HEAD"] ?? "", ...(record["branch"] ? { branch: record["branch"] } : {}), detached: record["detached"] === "true", locked: "locked" in record, prunable: "prunable" in record }));
}

function parseBundleRefs(value: string, format: GitObjectFormat): readonly { readonly name: string; readonly oid: string }[] {
  const result: Array<{ name: string; oid: string }> = [];
  for (const line of value.split(/\r?\n/gu).map(item => item.trim()).filter(Boolean)) {
    const match = /^(\S+)\s+(refs\/heads\/\S+)$/.exec(line);
    if (!match || !match[1] || !match[2]) throw new Error("Git bundle list-heads contained an unknown field");
    assertFullObjectId(match[1], format);
    result.push({ name: match[2], oid: match[1] });
  }
  if (new Set(result.map(item => item.name)).size !== result.length) throw new Error("Git bundle advertised duplicate refs");
  return result;
}

function parsePrerequisites(value: string, format: GitObjectFormat): readonly string[] {
  const length = objectIdLength(format);
  const matches = value.match(new RegExp(`\\b[0-9a-f]{${length}}\\b`, "gu")) ?? [];
  return [...new Set(matches)].map(item => { assertFullObjectId(item, format); return item; });
}

function parseConfigList(value: string): readonly [string, string][] {
  const entries: Array<[string, string]> = [];
  for (const record of value.split("\0").filter(Boolean)) {
    const newline = record.indexOf("\n");
    const keyStart = 0;
    if (newline < keyStart) throw new Error("Git config output contained an unknown field");
    const key = record.slice(keyStart, newline);
    const entryValue = record.slice(newline + 1);
    if (!key || entries.some(([candidate]) => candidate.toLowerCase() === key.toLowerCase())) throw new Error("Git config output contained duplicate fields");
    entries.push([key, entryValue]);
  }
  return entries;
}

function sameManifestInfrastructure(manifest: GitWorkspaceManifestDocument, resources: GitWorkspaceManifestDocument["resources"], observation: WorkspaceObservation, objectFormat: GitObjectFormat, logicalPath: (value: string) => string): boolean {
  if (manifest.objectFormat !== objectFormat || manifest.gitCommonDir !== logicalPath(observation.gitCommonDir) || manifest.worktreeGitDir !== logicalPath(observation.worktreeGitDir) || manifest.worktree !== "/ticket/workspace" || manifest.hooksPath !== logicalPath(observation.hooksPath) || manifest.objectDirectory !== logicalPath(observation.objectDirectory) || manifest.safeConfigDigest !== observation.safeConfigDigest || manifest.alternates !== null || manifest.worktreeCount !== 1) return false;
  for (const key of ["repository", "worktree", "worktreeGitDir", "config", "hooks", "objects", "artifactRoot", "controlRoot"] as const) {
    const expected = manifest.resources[key];
    const actual = resources[key];
    if (!expected || !actual || expected.path !== actual.path || expected.kind !== actual.kind || expected.device !== actual.device || expected.inode !== actual.inode || expected.mode !== actual.mode || (expected.kind === "file" && (expected.linkCount !== 1 || actual.linkCount !== 1))) return false;
  }
  return true;
}

function isSnapshot(value: RunSnapshot | GitWorkspaceRecord): value is RunSnapshot { return "version" in value && "state" in value && "runId" in value && !("stage" in value); }
function sameRetention(a: GitWorkspaceRetention, b: GitWorkspaceRetention): boolean { return a.outcome === b.outcome && a.workspaceRetainUntil === b.workspaceRetainUntil && a.bundleRetainUntil === b.bundleRetainUntil; }
function assertRetention(policy: GitWorkspaceRetention, now: number): void { if (!policy || !["success", "failure"].includes(policy.outcome) || !Number.isFinite(Date.parse(policy.workspaceRetainUntil)) || !Number.isFinite(Date.parse(policy.bundleRetainUntil))) throw new Error("retention policy is malformed"); if (Date.parse(policy.workspaceRetainUntil) < now || Date.parse(policy.bundleRetainUntil) < now) throw new Error("retention deadline is already elapsed"); }
function assertDisposalRecordShape(record: Extract<GitWorkspaceRecord, { stage: "retained" }>, runId: string): void {
  const spec = record.spec;
  const manifest = record.manifest;
  const featureBranch = record.featureBranch;
  const retention = record.retention;
  if (record.runId !== runId || !spec || typeof spec !== "object" || spec.path !== `artifacts/git/${runId}/workspace-spec.json` || spec.schemaId !== "urn:squire:git-workspace:v1:workspace-spec" || typeof spec.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(spec.sha256) || !manifest || typeof manifest !== "object" || manifest.path !== `artifacts/git/${runId}/workspace-manifest.json` || manifest.schemaId !== "urn:squire:git-workspace:v1:workspace-manifest" || typeof manifest.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(manifest.sha256) || typeof record.specFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(record.specFingerprint) || typeof featureBranch !== "string" || featureBranch !== featureBranch.toLowerCase() || !featureBranch.startsWith("squire/") || canonicalJson(record.paths) !== canonicalJson(logicalGitWorkspacePaths(runId)) || !Number.isSafeInteger(record.operationGeneration) || record.operationGeneration < 1 || !retention || !["success", "failure"].includes(retention.outcome) || !Number.isFinite(Date.parse(retention.workspaceRetainUntil)) || !Number.isFinite(Date.parse(retention.bundleRetainUntil))) throw new Error("Git disposal record identity is malformed");
}
function assertDisposalAuthorization(retention: GitWorkspaceRetention, authorization: GitDisposalAuthorization): void { const now = typeof authorization.now === "number" ? authorization.now : Date.parse(authorization.now); if (!Number.isFinite(now)) throw new Error("disposal authorization time is invalid"); if (authorization.workspaceRetainUntil !== undefined && authorization.workspaceRetainUntil !== retention.workspaceRetainUntil) throw new Error("workspace retention authorization was substituted"); if (authorization.bundleRetainUntil !== undefined && authorization.bundleRetainUntil !== retention.bundleRetainUntil) throw new Error("bundle retention authorization was substituted"); const workspaceAllowed = authorization.disposeWorkspace !== false; const bundleAllowed = authorization.disposeBundle !== false; if (workspaceAllowed && now < Date.parse(retention.workspaceRetainUntil)) throw new Error("workspace retention deadline has not elapsed"); if (bundleAllowed && now < Date.parse(retention.bundleRetainUntil)) throw new Error("bundle retention deadline has not elapsed"); }
function positiveInteger(value: number, label: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`); return value; }
function hasCode(error: unknown, code: string): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code); }
function matchesCleanupIdentity(actual: ResourceIdentity, expected: ResourceIdentity): boolean { return actual.kind === expected.kind && actual.device === expected.device && actual.inode === expected.inode && actual.mode === expected.mode && (actual.kind === "file" ? actual.linkCount === expected.linkCount : true); }
function parseDisposalResources(value: unknown, runId: string): GitWorkspaceManifestDocument["resources"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Git disposal identity resources are malformed");
  const record = value as Record<string, unknown>;
  const names = ["alternates", "artifactRoot", "config", "controlRoot", "hooks", "objects", "repository", "worktree", "worktreeGitDir"];
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(names)) throw new Error("Git disposal identity resources are not closed");
  if (record["alternates"] !== null) throw new Error("Git disposal identity contains an alternate object store");
  const expected: Readonly<Record<"repository" | "worktree" | "worktreeGitDir" | "config" | "hooks" | "objects" | "artifactRoot" | "controlRoot", { path: string; kind: "file" | "directory" }>> = {
    repository: { path: "/ticket/git/repo.git", kind: "directory" },
    worktree: { path: "/ticket/workspace", kind: "directory" },
    worktreeGitDir: { path: "/ticket/git/repo.git/worktrees/workspace", kind: "directory" },
    config: { path: "/ticket/git/repo.git/config", kind: "file" },
    hooks: { path: `/ticket/control/git/${runId}/hooks`, kind: "directory" },
    objects: { path: "/ticket/git/repo.git/objects", kind: "directory" },
    artifactRoot: { path: `/ticket/artifacts/git/${runId}`, kind: "directory" },
    controlRoot: { path: `/ticket/control/git/${runId}`, kind: "directory" },
  };
  const parsed = {} as Partial<Record<keyof typeof expected, ResourceIdentity>>;
  for (const [key, shape] of Object.entries(expected) as Array<[keyof typeof expected, { path: string; kind: "file" | "directory" }]>) parsed[key] = parseDisposalResource(record[key], shape.path, shape.kind);
  return { repository: parsed.repository!, worktree: parsed.worktree!, worktreeGitDir: parsed.worktreeGitDir!, config: parsed.config!, hooks: parsed.hooks!, objects: parsed.objects!, alternates: null, artifactRoot: parsed.artifactRoot!, controlRoot: parsed.controlRoot! };
}

function parseDisposalResource(value: unknown, expectedPath: string, expectedKind: "file" | "directory"): ResourceIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Git disposal identity resource is malformed");
  const record = value as Record<string, unknown>;
  const kind = record["kind"];
  const resourcePath = record["path"];
  const device = record["device"];
  const inode = record["inode"];
  const mode = record["mode"];
  const linkCount = record["linkCount"];
  if (resourcePath !== expectedPath || kind !== expectedKind || typeof device !== "string" || !device || typeof inode !== "string" || !inode || !Number.isSafeInteger(mode) || (mode as number) < 0 || (mode as number) > 0o777 || !Number.isSafeInteger(linkCount) || (linkCount as number) < 1 || canonicalJson(record) !== canonicalJson({ path: expectedPath, kind: expectedKind, device, inode, mode, linkCount })) throw new Error("Git disposal identity resource is malformed");
  return { path: expectedPath, kind: expectedKind, device, inode, mode: mode as number, linkCount: linkCount as number };
}

function parseDisposalCompletion(bytes: Buffer): { readonly runId: string; readonly token: number; readonly target: string; readonly identity: ResourceIdentity } {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Git disposal completion marker is not JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Git disposal completion marker is malformed");
  const document = value as Record<string, unknown>;
  const identity = document["identity"];
  const runId = document["runId"];
  const token = document["token"];
  const target = document["target"];
  if (document["schemaVersion"] !== 1 || document["kind"] !== "squire-git-disposal-complete" || typeof runId !== "string" || !Number.isSafeInteger(token) || (token as number) < 1 || typeof target !== "string" || !/^[A-Za-z0-9._-]{1,200}$/u.test(target) || !identity || typeof identity !== "object" || Array.isArray(identity)) throw new Error("Git disposal completion marker is malformed");
  const raw = identity as Record<string, unknown>;
  const kind = raw["kind"];
  const device = raw["device"];
  const inode = raw["inode"];
  const mode = raw["mode"];
  const linkCount = raw["linkCount"];
  if ((kind !== "file" && kind !== "directory") || typeof device !== "string" || !device || typeof inode !== "string" || !inode || !Number.isSafeInteger(mode) || (mode as number) < 0 || (mode as number) > 0o777 || !Number.isSafeInteger(linkCount) || (linkCount as number) < 1 || canonicalJson(raw) !== canonicalJson({ kind, device, inode, mode, linkCount })) throw new Error("Git disposal completion marker identity is malformed");
  const normalized = { schemaVersion: 1, kind: "squire-git-disposal-complete", runId, token, target, identity: { kind, device, inode, mode, linkCount } };
  if (!serializeCanonical(normalized).equals(bytes)) throw new Error("Git disposal completion marker is not canonical");
  return { runId, token: token as number, target, identity: { path: "", kind, device, inode, mode: mode as number, linkCount: linkCount as number } };
}
function redact(value: string): string { return value.replace(/(?:https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, "https://<redacted>@").slice(0, 2_000); }
