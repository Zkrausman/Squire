import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { Clock, ContractReference, Lease, LeaseGuard, RunPreparationLease, RunSnapshot, RunTerminalFence } from "../control/domain.js";
import { StoreConflictError, type RunQuiescenceAuthority, type WorkflowStore } from "../control/workflow-store.js";
import { SafeArtifactReader, type ImmutableArtifactReader } from "../control/safe-artifact-reader.js";
import { buildBundleManifest, buildWorkspaceManifest, buildWorkspaceSpec, canonicalJson, FileGitContractWriter, GitWorkspaceContractError, GitWorkspaceContractValidator, serializeCanonical, sha256Bytes, type GitContractArtifactWriter } from "./contracts.js";
import { descriptorPathForGit, digestDescriptor, openImmutableFile, copyDescriptorToExclusive, type DescriptorDigest } from "./bundle-reader.js";
import { assertBaseBranch, assertCredentialFreeHttpsCloneUrl, assertFullObjectId, assertGitRefFormat, assertValidInternalRefName, assertRepositoryPart, assertRunId, assertTicketIdentifier, branchRef, deriveFeatureBranch, objectIdLength, zeroObjectId } from "./identity.js";
import { assertSafeAncestors, assertTicketRoot, chmodDirectoryNoFollow, chmodFileNoFollow, createGitWorkspaceFilesystemPaths, descriptorChildPath, ensurePrivateDirectory, entryKind, fsyncDirectory, GitPathSecurityError, inspectResource, isAlreadyExists, isMissing, logicalGitWorkspacePaths, openNoFollow, openNoFollowAt, readExactNoFollow, removeEmptyDirectoryNoFollow, removeTreeNoFollow, renameWithIdentity, sameResourceIdentity, sameStat, writeExclusiveFile, type GitWorkspaceFilesystemPaths, type RemovalChildIdentity } from "./paths.js";
import { GitCommandError, GitCommandRunner, GitCommandUncertainError, type GitChildProcess, type GitCommandOptions, type GitCommandResult, type GitCommandRunnerOptions } from "./git-command.js";
import { RejectingRepositorySourceAuthorizer, buildGitHttpsResolveConfig } from "./source-authorizer.js";
import { assertTrustedFilesystemOperation, authenticateTrustedFilesystemAuthority, type TrustedFilesystemIsolationAuthority } from "./trusted-isolation.js";
import type { GitBundleManifestDocument, GitBundleRecord, GitDisposalAuthorization, GitDisposalResult, GitObjectFormat, GitOperationStep, GitRepositoryIdentity, GitWorkspaceManifestDocument, GitWorkspaceReadiness, GitWorkspaceRecord, GitWorkspaceRetention, GitWorkspaceServicePort, GitWorkspaceSpecDocument, GitWorkspaceStatus, GitWorkspaceCommit, ReadyGitWorkspace, ResourceIdentity } from "./domain.js";

export interface GitSourceAuthorization {
  /** The URL is normally the same credential-free HTTPS URL in the spec. */
  readonly cloneUrl: string;
  /** A test-only local transport may be supplied by an explicitly trusted test authorizer. */
  readonly localTransport?: boolean;
  /** The exact public address set authorized for this HTTPS connection. */
  readonly resolvedAddresses?: readonly string[];
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
  /** Runtime-authenticated authority issued by trusted filesystem composition. */
  readonly filesystemAuthority: TrustedFilesystemIsolationAuthority;
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

interface DisposalArtifactChildProof {
  readonly name: string;
  readonly identity: Omit<ResourceIdentity, "path">;
  readonly byteLength: number;
  readonly sha256: string;
}

interface DisposalArtifactBundleProof {
  readonly bundlePath: string;
  readonly manifestPath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly objectFormat: GitObjectFormat;
  readonly featureBranch: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly prerequisites: readonly string[];
  readonly refs: readonly { readonly name: string; readonly oid: string }[];
}

interface DisposalArtifactProof {
  readonly root: Omit<ResourceIdentity, "path">;
  readonly children: readonly DisposalArtifactChildProof[];
  readonly bundle?: DisposalArtifactBundleProof;
}

interface DisposalContractSnapshots {
  readonly spec: string;
  readonly manifest: string;
  readonly bundle?: string;
}

interface DisposalIdentityDocument {
  readonly schemaVersion: 1;
  readonly kind: "squire-git-disposal-identity";
  readonly runId: string;
  readonly token: number;
  readonly manifest: ContractReference;
  readonly resources: GitWorkspaceManifestDocument["resources"];
  readonly contracts: DisposalContractSnapshots;
  readonly artifacts: DisposalArtifactProof;
}

type GitInvoker = (args: readonly string[], overrides?: Partial<Pick<GitCommandOptions, "allowExitCodes" | "allowNetwork" | "passFileDescriptors" | "extraEnv">>) => Promise<GitCommandResult>;

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

/** Trusted Git workspace component. It owns only its exact Git/artifact/control
 * paths; the run lifecycle fence is always supplied by the merged authority.
 * Production side effects also require the runtime-authenticated authority
 * issued by trusted filesystem composition; this component never infers that
 * filesystem proof itself. */
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
  readonly #filesystemAuthority: TrustedFilesystemIsolationAuthority;
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
    authenticateTrustedFilesystemAuthority(options.filesystemAuthority, this.#ticketRoot);
    this.#filesystemAuthority = options.filesystemAuthority;
    this.#sourceAuthorizer = options.sourceAuthorizer ?? options.repositorySourceAuthorizer ?? new RejectingRepositorySourceAuthorizer();
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
    await this.#assertFilesystemIsolation();
    const paths = logicalGitWorkspacePaths(input.runId);
    const document = buildWorkspaceSpec(input, paths);
    // Approval is required before an immutable spec is published; provision
    // repeats it because the source policy/DNS decision is time-sensitive.
    const source = await this.#sourceAuthorizer.authorize(document.repository);
    try { this.#assertAuthorizedTransport(document.repository, source); }
    finally { await source.release?.(); }
    await this.#assertFilesystemIsolation();
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
          const transport = this.#assertAuthorizedTransport(document.repository, source);
          await this.#provisionFilesystem(context, document, record, source, transport);
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
      // The reservation is a store operation; all following pathname reads
      // and artifact mutations are guarded by the runtime filesystem fence.
      await this.#assertFilesystemIsolation();
      const destination = path.join(this.#ticketRoot, ...bundleRelativePath.split("/"));
      const destinationKind = await this.#pathKind(destination);
      if (destinationKind !== "missing") {
        if (record.stage !== "exporting") throw new Error("pre-existing Git bundle cannot be adopted");
        await this.#assertFilesystemIsolation();
        const existingFile = await openImmutableFile(destination, this.#maxBundleBytes, this.#ticketRoot);
        try {
          const existingInfo = await existingFile.handle.stat();
          if ((existingInfo.mode & 0o777) !== 0o400) throw new Error("existing Git bundle does not have the required immutable mode");
          const existingDigest = await digestDescriptor(existingFile.handle, this.#maxBundleBytes);
          const existingVerification = await this.#verifyBundleBytes(context, spec, expectedHead, existingFile.handle, existingDigest, exporting.operation?.operationId ?? operationId);
          const existingManifestPath = `artifacts/git/${runId}/bundle-manifest.json`;
          const existingManifestReference = await this.#existingContractReference(existingManifestPath, "urn:squire:git-workspace:v1:bundle-manifest");
          let manifestReference: ContractReference;
          if (existingManifestReference) {
            const existingManifest = await (await this.#validatorPromise).validateBundle(existingManifestReference, { runId, spec: record.spec, workspaceManifest: ready.manifest, headSha: expectedHead });
            if (existingManifest.document.bundlePath !== bundleRelativePath || existingManifest.document.sha256 !== existingDigest.sha256 || existingManifest.document.byteLength !== existingDigest.byteLength || existingManifest.document.exportGeneration !== exporting.exportGeneration || canonicalJson(existingManifest.document.prerequisites) !== canonicalJson(existingVerification.prerequisites) || canonicalJson(existingManifest.document.refs) !== canonicalJson(existingVerification.refs)) throw new Error("existing Git bundle manifest does not match the persisted export");
            manifestReference = existingManifestReference;
          } else {
            const existingManifestDocument = buildBundleManifest({ spec: record.spec, workspaceManifest: ready.manifest, runId, featureBranch: spec.featureBranch, baseSha: spec.baseSha, headSha: expectedHead, bundlePath: bundleRelativePath, byteLength: existingDigest.byteLength, sha256: existingDigest.sha256, objectFormat: spec.objectFormat, prerequisites: existingVerification.prerequisites, refs: existingVerification.refs, exportGeneration: exporting.exportGeneration, verifiedAt: new Date(this.#clock.now()).toISOString() });
            await this.#assertFilesystemIsolation();
            manifestReference = await this.#writer.writeCreateOnly(existingManifestPath, serializeCanonical(existingManifestDocument));
            await (await this.#validatorPromise).validateBundle(manifestReference, { runId, spec: record.spec, workspaceManifest: ready.manifest, headSha: expectedHead });
          }
          const existingResource = await inspectResource(destination, "file", true, this.#ticketRoot);
          const existingBundle: GitBundleRecord = { manifest: manifestReference, bundlePath: bundleRelativePath, byteLength: existingDigest.byteLength, sha256: existingDigest.sha256, objectFormat: spec.objectFormat, featureBranch: spec.featureBranch, baseSha: spec.baseSha, headSha: expectedHead, resource: { ...existingResource, path: `/ticket/${bundleRelativePath}` }, exportGeneration: exporting.exportGeneration };
          return await this.#completeExport(context, spec, exporting, expectedHead, exporting.exportGeneration, existingBundle);
        } finally { await existingFile.handle.close(); }
      }
      const staging = path.join(fs.artifactRoot, `.bundle-${randomUUID()}.tmp`);
      if (!BUNDLE_STAGING.test(path.basename(staging))) throw new Error("invalid bundle staging identity");
      await this.#assertNoPath(staging);
      let opened: Awaited<ReturnType<typeof openImmutableFile>> | undefined;
      let stagingHandle: Awaited<ReturnType<typeof openNoFollow>> | undefined;
      let digest: DescriptorDigest | undefined;
      try {
        // Git's bundle command otherwise opens/truncates a pathname after the
        // no-path check. Create the staging inode exclusively first and pass
        // its held descriptor to Git, so a late hardlink/symlink replacement
        // cannot redirect bundle creation.
        await this.#assertFilesystemIsolation();
        stagingHandle = await openNoFollow(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, this.#ticketRoot, 0o600);
        const stagingDescriptor = descriptorPathForGit(stagingHandle, 3);
        await this.#git(context, exporting.operation?.operationId ?? operationId, "bundle-create", ["--git-dir", fs.repository, "bundle", "create", stagingDescriptor, branchRef(spec.featureBranch)], { passFileDescriptors: [stagingHandle.fd] });
        await stagingHandle.sync();
        await stagingHandle.close();
        stagingHandle = undefined;
        opened = await openImmutableFile(staging, this.#maxBundleBytes, this.#ticketRoot);
        digest = await digestDescriptor(opened.handle, this.#maxBundleBytes);
        if (digest.byteLength <= 0) throw new Error("Git bundle is empty");
        const bundleVerification = await this.#verifyBundleBytes(context, spec, expectedHead, opened.handle, digest, exporting.operation?.operationId ?? operationId);
        if (bundleVerification.refs.length !== 1 || bundleVerification.refs[0]?.name !== branchRef(spec.featureBranch) || bundleVerification.refs[0]?.oid !== expectedHead) throw new Error("Git bundle advertised an unexpected ref");
        await this.#assertFilesystemIsolation();
        await copyDescriptorToExclusive(opened.handle, destination, this.#ticketRoot, digest);
        const destinationFile = await openImmutableFile(destination, this.#maxBundleBytes, this.#ticketRoot);
        try {
          const destinationDigest = await digestDescriptor(destinationFile.handle, this.#maxBundleBytes);
          if (destinationDigest.sha256 !== digest.sha256 || destinationDigest.byteLength !== digest.byteLength) throw new Error("published Git bundle digest mismatch");
          const destinationVerification = await this.#verifyBundleBytes(context, spec, expectedHead, destinationFile.handle, destinationDigest, exporting.operation?.operationId ?? operationId);
          if (canonicalJson(destinationVerification.refs) !== canonicalJson(bundleVerification.refs) || canonicalJson(destinationVerification.prerequisites) !== canonicalJson(bundleVerification.prerequisites)) throw new Error("published Git bundle content verification differs from the held source descriptor");
        } finally { await destinationFile.handle.close(); }
        const destinationResource = await inspectResource(destination, "file", true, this.#ticketRoot);
        if (destinationResource.mode !== 0o400) throw new Error("published Git bundle is not owner-non-writable");
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
          if (existingManifest.document.bundlePath !== bundleRelativePath || existingManifest.document.sha256 !== digest.sha256 || existingManifest.document.byteLength !== digest.byteLength || existingManifest.document.exportGeneration !== exportGeneration || canonicalJson(existingManifest.document.prerequisites) !== canonicalJson(bundleVerification.prerequisites) || canonicalJson(existingManifest.document.refs) !== canonicalJson(bundleVerification.refs)) throw new Error("existing Git bundle manifest does not match the current export");
          manifestReference = existingManifestReference;
        } else {
          await this.#assertFilesystemIsolation();
          manifestReference = await this.#writer.writeCreateOnly(manifestRelativePath, serializeCanonical(manifestDocument));
          await (await this.#validatorPromise).validateBundle(manifestReference, { runId, spec: record.spec, workspaceManifest: ready.manifest, headSha: expectedHead });
        }
        const bundle: GitBundleRecord = { manifest: manifestReference, bundlePath: bundleRelativePath, byteLength: digest.byteLength, sha256: digest.sha256, objectFormat: spec.objectFormat, featureBranch: spec.featureBranch, baseSha: spec.baseSha, headSha: expectedHead, resource: { ...destinationResource, path: `/ticket/${bundleRelativePath}` }, exportGeneration };
        return await this.#completeExport(context, spec, exporting, expectedHead, exportGeneration, bundle);
      } catch (error) {
        await this.#block(context, runId, error, "bundle_export_failed");
        throw error;
      } finally {
        try {
          await opened?.handle.close();
        } finally {
          try {
            await stagingHandle?.close();
          } finally {
            await this.#removeOwnedTemporary(staging);
          }
        }
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
      const operationRecord = await this.#beginOfflineCommit(context, current.gitWorkspace, message);
      await this.#verifyReady(context, spec, operationRecord);
      const fs = this.#paths(runId);
      // If a controller crashed after Git created the commit but before the
      // final CAS, the changed physical head is the durable idempotency proof;
      // do not create a second commit with the same message.
      const commitOperationId = operationRecord.operation?.operationId ?? context.operationId;
      const beforeHead = await this.#readFeatureHead(context, spec, commitOperationId);
      let output = "";
      if (beforeHead === operationRecord.headSha) {
        await this.#git(context, commitOperationId, "workspace-verify", ["add", "--all"], { cwd: fs.worktree });
        const result = await this.#git(context, commitOperationId, "workspace-verify", ["commit", "--no-verify", "--no-gpg-sign", "-m", message], { cwd: fs.worktree });
        output = result.stdout;
      }
      const headSha = await this.#readFeatureHead(context, spec, commitOperationId);
      const latest = await this.#store.read(runId);
      if (!latest?.gitWorkspace || latest.gitWorkspace.stage !== "ready" || latest.gitWorkspace.bundle) throw new Error("Git workspace changed while committing");
      await this.#verifyWorkspace(context, spec, latest.gitWorkspace, headSha, true);
      await this.#updateRecord(context, snapshot => {
        const record = snapshot.gitWorkspace;
        if (!record || record.stage !== "ready" || record.bundle || record.operation?.operationId !== operationRecord.operation?.operationId) throw new StoreConflictError("Git workspace changed before commit head persistence");
        const { operation: _operation, ...withoutOperation } = record;
        return { ...snapshot, gitWorkspace: { ...withoutOperation, headSha, lastVerifiedAt: new Date(this.#clock.now()).toISOString() } as GitWorkspaceRecord };
      });
      return { runId, headSha, output };
    } catch (error) {
      await this.#block(context, runId, error, "commit_failed");
      throw error;
    } finally { await this.#release(context); }
  }

  async #beginOfflineCommit(context: GitLeaseContext, record: Extract<GitWorkspaceRecord, { stage: "ready" }>, message: string): Promise<Extract<GitWorkspaceRecord, { stage: "ready" }>> {
    const messageSha256 = sha256Bytes(Buffer.from(message, "utf8"));
    if (record.operation) {
      if (record.operation.step !== "workspace-verify" || record.operation.intent?.kind !== "offline-commit" || record.operation.intent.messageSha256 !== messageSha256) throw new StoreConflictError("another Git operation owns the workspace");
      return record;
    }
    const operationId = context.operationId;
    const operation = { operationId, owner: `git-operation-${operationId}`, generation: record.operationGeneration, step: "workspace-verify" as const, intent: { kind: "offline-commit" as const, messageSha256 }, startedAt: new Date(this.#clock.now()).toISOString() };
    const updated = await this.#updateRecord(context, snapshot => {
      const current = snapshot.gitWorkspace;
      if (!current || current.stage !== "ready" || current.bundle || current.operation) throw new StoreConflictError("Git workspace changed before offline commit intent");
      return { ...snapshot, gitWorkspace: { ...current, operation } as GitWorkspaceRecord };
    });
    if (!updated.gitWorkspace || updated.gitWorkspace.stage !== "ready") throw new Error("offline commit intent was not persisted");
    return updated.gitWorkspace;
  }

  async disposeUnderTerminalFence(runId: string, fence: RunTerminalFence, authorization: GitDisposalAuthorization, signal?: AbortSignal): Promise<GitDisposalResult> {
    assertRunId(runId);
    await this.#assertFilesystemIsolation(signal);
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
    // authorization.now is untrusted scheduler input. Only this service's
    // injected clock can authorize crossing persisted retention deadlines.
    const trustedNow = this.#clock.now();
    assertDisposalAuthorization(record.retention, authorization, trustedNow);
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
    let artifacts: DisposalArtifactProof;
    let contracts: DisposalContractSnapshots;
    if (manifestKind !== "missing") {
      if (manifestKind !== "file") throw new Error("Git workspace manifest is an unsafe replacement");
      const validator = await this.#validatorPromise;
      const specDocument = (await validator.validateSpec(record.spec, { runId, fingerprint: record.specFingerprint })).document;
      const manifestDocument = (await validator.validateManifest(record.manifest, { spec: record.spec, runId, specFingerprint: record.specFingerprint })).document;
      this.#assertRecordIdentity(record, specDocument, record.spec);
      if (!manifestMatchesSpec(manifestDocument, specDocument)) throw new Error("retained workspace manifest does not match the immutable spec");
      resources = manifestDocument.resources;
      // This is an independent retained-evidence check, not just a directory
      // identity check. It authenticates every create-only contract and runs
      // the full bundle verifier before any disposal move is attempted.
      artifacts = await this.#buildDisposalArtifactProof(specDocument, record, resources, disposal);
      contracts = await this.#captureDisposalContracts(record);
      const authenticatedResources = await this.#validateDisposalContractSnapshots(contracts, record);
      if (canonicalJson(authenticatedResources) !== canonicalJson(resources)) throw new Error("disposal contract snapshot does not match the retained manifest");
      this.#assertDisposalArtifactProofRecord(artifacts, record, resources);
      await this.#writeDisposalIdentity(identityPath, runId, fence, record.manifest, resources, contracts, artifacts);
    } else {
      const identity = await this.#readDisposalIdentity(identityPath, runId, fence.fencingToken, record.manifest);
      artifacts = identity.artifacts;
      contracts = identity.contracts;
      resources = await this.#validateDisposalContractSnapshots(contracts, record);
      this.#assertDisposalArtifactProofRecord(artifacts, record, resources);
      if (canonicalJson(resources) !== canonicalJson(identity.resources)) throw new Error("disposal journal resources do not match its authenticated manifest snapshot");
      const relocatedArtifacts = path.join(disposal, "artifacts");
      const relocatedKind = await this.#pathKind(relocatedArtifacts);
      if (relocatedKind === "directory") {
        // The journal is recovery metadata, not authority by itself. Once the
        // original manifest pathname is gone, re-authenticate the moved
        // create-only contracts and require their resource snapshot to match
        // the authenticated snapshot before using it for any other deletion.
        await this.#verifyDisposalArtifactTarget(relocatedArtifacts, artifacts);
        const relocatedResources = await this.#readRelocatedDisposalManifest(relocatedArtifacts, record);
        if (canonicalJson(relocatedResources) !== canonicalJson(resources)) throw new Error("relocated workspace manifest does not match the authenticated disposal snapshot");
      } else if (relocatedKind !== "missing") throw new Error("relocated Git artifact root is an unsafe replacement");
    }
    const targets: Array<{ name: string; source: string; expected: ResourceIdentity | undefined; enabled: boolean; verify?: (target: string) => Promise<void>; removalChildren?: readonly RemovalChildIdentity[] }> = targetKeys.map(target => {
      const resource = resources[target.key];
      return { name: target.name, source: target.source, expected: resource ? { ...resource, path: this.#physicalPath(resource.path) } : undefined, enabled: target.enabled, ...(target.key === "artifactRoot" ? { verify: (targetPath: string) => this.#verifyDisposalArtifactTarget(targetPath, artifacts), removalChildren: artifacts.children.map(child => ({ name: child.name, ...child.identity })) } : {}) };
    });
    for (const target of targets) {
      if (!target.enabled) continue;
      await this.#disposeOne(runId, fence, target.name, target.source, path.join(disposal, target.name), target.expected, removed, alreadyAbsent, signal, 0, target.verify, target.removalChildren);
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
    await this.#assertFilesystemIsolation();
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

  async #provisionFilesystem(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, record: GitWorkspaceRecord, source: GitSourceAuthorization, transportResolve: readonly string[]): Promise<void> {
    if (record.stage !== "provisioning") throw new Error("provisioning record changed");
    // Source authorization is an external, potentially slow boundary. Recheck
    // the authenticated filesystem immediately before the first local write.
    await this.#assertFilesystemIsolation();
    const fs = this.#paths(spec.runId);
    await this.#ensureRoots(fs, context);
    await this.#assertNoUnownedGitPaths(fs);
    await this.#writeOwnershipMarker(context, spec, record.operationGeneration);
    await this.#ensureTemplateAndHooks(fs, context);
    const repositoryKind = await this.#pathKind(fs.repository);
    if (repositoryKind === "missing") {
      await this.#git(context, record.operation?.operationId ?? context.operationId, "initialize", ["init", "--bare", `--object-format=${spec.objectFormat}`, `--template=${fs.templatePath}`, fs.repository]);
      await this.#assertFilesystemIsolation();
      await chmodDirectoryNoFollow(fs.repository, this.#ticketRoot, 0o700);
      await this.#authority.assertRunStartAllowed(spec.runId, this.#clock.now());
      await inspectResource(fs.repository, "directory", true, this.#ticketRoot);
    } else {
      await this.#verifyOwnedRepository(context, spec, record);
      await this.#assertFilesystemIsolation();
      await chmodDirectoryNoFollow(fs.repository, this.#ticketRoot, 0o700);
    }
    await this.#verifyRepositorySafety(context, spec, record, true);
    const baseRef = INTERNAL_BASE_REF(spec.runId);
    const imported = await this.#readRef(context, fs.repository, baseRef, spec.objectFormat, record.operation?.operationId ?? context.operationId);
    if (!imported) {
      const operationId = record.operation?.operationId ?? context.operationId;
      if (!source.localTransport) await this.#assertHttpsResolveSupport(context, operationId);
      const transportArgs = transportResolve.flatMap(value => ["-c", value]);
      await this.#git(context, operationId, "fetch", [...transportArgs, "-c", "http.followRedirects=false", "--git-dir", fs.repository, "fetch", "--no-tags", "--no-recurse-submodules", "--no-auto-gc", "--no-write-fetch-head", source.cloneUrl, `refs/heads/${spec.baseBranch}:${baseRef}`], { allowNetwork: source.localTransport !== true, ...(source.localTransport ? { extraEnv: { GIT_ALLOW_PROTOCOL: "file" } } : source.environment ? { extraEnv: source.environment } : {}) });
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
      await this.#assertFilesystemIsolation();
      await chmodDirectoryNoFollow(fs.worktree, this.#ticketRoot, 0o700);
    } else {
      await this.#verifyWorktreePair(context, spec, record);
      await this.#assertFilesystemIsolation();
      await chmodDirectoryNoFollow(fs.worktree, this.#ticketRoot, 0o700);
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
      await this.#assertFilesystemIsolation();
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
    return { runId: spec.runId, spec: record.spec, manifest: record.manifest, featureBranch: spec.featureBranch, headSha: expectedHead, objectFormat: spec.objectFormat, paths: record.paths };
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
    await this.#assertFilesystemIsolation();
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
      const info = await file.handle.stat();
      const actualResource: ResourceIdentity = { path: `/ticket/${bundle.bundlePath}`, kind: "file", device: String(info.dev), inode: String(info.ino), mode: info.mode & 0o777, linkCount: info.nlink };
      if (!sameBundleResource(actualResource, bundle.resource, bundle.bundlePath) || (info.mode & 0o222) !== 0) throw new Error("persisted Git bundle identity or permissions mismatch");
      const digest = await digestDescriptor(file.handle, this.#maxBundleBytes);
      if (digest.sha256 !== bundle.sha256 || digest.byteLength !== bundle.byteLength) throw new Error("persisted Git bundle digest mismatch");
      const verification = await this.#verifyBundleBytes(context, spec, bundle.headSha, file.handle, digest, `git-bundle-reverify-${randomUUID()}`);
      if (verification.refs.length !== 1 || verification.refs[0]?.name !== branchRef(spec.featureBranch) || verification.refs[0]?.oid !== bundle.headSha) throw new Error("persisted Git bundle ref inventory mismatch");
      if (canonicalJson(verification.prerequisites) !== canonicalJson(validated.document.prerequisites) || canonicalJson(verification.refs) !== canonicalJson(validated.document.refs)) throw new Error("persisted Git bundle verification metadata mismatch");
    } finally { await file.handle.close(); }
  }

  async #verifyBundleBytes(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, expectedHead: string, handle: import("node:fs/promises").FileHandle, digest: DescriptorDigest, operationId: string): Promise<{ readonly prerequisites: readonly string[]; readonly refs: readonly { readonly name: string; readonly oid: string }[] }> {
    return this.#verifyBundleBytesWithInvoker(spec, expectedHead, handle, digest, this.#paths(spec.runId).controlRoot, (args, overrides) => this.#git(context, operationId, "bundle-verify", args, overrides));
  }

  async #verifyBundleBytesOffline(spec: GitWorkspaceSpecDocument, expectedHead: string, handle: import("node:fs/promises").FileHandle, digest: DescriptorDigest, scratchRoot: string): Promise<{ readonly prerequisites: readonly string[]; readonly refs: readonly { readonly name: string; readonly oid: string }[] }> {
    return this.#verifyBundleBytesWithInvoker(spec, expectedHead, handle, digest, scratchRoot, (args, overrides) => this.#runOfflineGit(spec.runId, args, overrides));
  }

  async #runOfflineGit(runId: string, args: readonly string[], overrides: Partial<Pick<GitCommandOptions, "allowExitCodes" | "allowNetwork" | "passFileDescriptors" | "extraEnv">> = {}): Promise<GitCommandResult> {
    await this.#assertFilesystemIsolation();
    return this.#command.run(args, { cwd: this.#ticketRoot, runId, ticketRoot: this.#ticketRoot, timeoutMs: this.#commandTimeoutMs, maxOutputBytes: this.#commandOutputBytes, ...overrides });
  }

  async #verifyBundleBytesWithInvoker(spec: GitWorkspaceSpecDocument, expectedHead: string, handle: import("node:fs/promises").FileHandle, digest: DescriptorDigest, scratchRoot: string, invoke: GitInvoker): Promise<{ readonly prerequisites: readonly string[]; readonly refs: readonly { readonly name: string; readonly oid: string }[] }> {
    await this.#assertFilesystemIsolation();
    const descriptor = descriptorPathForGit(handle, 3);
    const disposable = path.join(scratchRoot, `.bundle-check-${randomUUID()}.git`);
    await this.#assertNoPath(disposable);
    try {
      await assertSafeAncestors(path.dirname(disposable), this.#ticketRoot, false);
      await ensurePrivateDirectory(disposable, this.#ticketRoot);
      await invoke(["init", "--bare", `--object-format=${spec.objectFormat}`, disposable]);
      // Verify and enumerate against the disposal-owned scratch repository. It
      // is deliberately not the run repository: workspace-first retention may
      // already have removed that repository and its control root.
      const verify = await invoke(["--git-dir", disposable, "bundle", "verify", descriptor], { allowExitCodes: [0, 1], passFileDescriptors: [handle.fd], extraEnv: { GIT_ALLOW_PROTOCOL: "file" } });
      if (verify.exitCode !== 0) throw new Error("retained Git bundle has prerequisites unavailable after workspace disposal");
      const listed = await invoke(["--git-dir", disposable, "bundle", "list-heads", descriptor], { passFileDescriptors: [handle.fd], extraEnv: { GIT_ALLOW_PROTOCOL: "file" } });
      const refs = parseBundleRefs(listed.stdout, spec.objectFormat);
      assertFullObjectId(expectedHead, spec.objectFormat);
      if (refs.length !== 1 || refs[0]?.name !== branchRef(spec.featureBranch) || refs[0]?.oid !== expectedHead) throw new Error("bundle ref inventory is not exactly the feature branch");
      const prerequisites = parsePrerequisites(`${verify.stdout}\n${verify.stderr}`, spec.objectFormat).filter(value => value !== expectedHead);
      await invoke(["--git-dir", disposable, "fetch", "--no-tags", "--no-recurse-submodules", descriptor, `${branchRef(spec.featureBranch)}:${branchRef(spec.featureBranch)}`], { passFileDescriptors: [handle.fd], extraEnv: { GIT_ALLOW_PROTOCOL: "file" } });
      const baseType = await invoke(["--git-dir", disposable, "cat-file", "-t", spec.baseSha]);
      const headType = await invoke(["--git-dir", disposable, "cat-file", "-t", expectedHead]);
      if (baseType.stdout.trim() !== "commit" || headType.stdout.trim() !== "commit") throw new Error("bundle base/head is not a commit");
      const ancestry = await invoke(["--git-dir", disposable, "merge-base", "--is-ancestor", spec.baseSha, expectedHead], { allowExitCodes: [0, 1] });
      if (ancestry.exitCode !== 0) throw new Error("bundle head is outside the recorded base ancestry");
      await invoke(["--git-dir", disposable, "fsck", "--full", "--strict", "--no-reflogs"]);
      const format = await invoke(["--git-dir", disposable, "rev-parse", "--show-object-format"]);
      if (format.stdout.trim() !== spec.objectFormat) throw new Error("bundle object format mismatch");
      const after = await digestDescriptor(handle, this.#maxBundleBytes);
      if (after.sha256 !== digest.sha256 || after.byteLength !== digest.byteLength) throw new Error("bundle changed during content verification");
      return { prerequisites, refs };
    } finally { await this.#removeOwnedTemporary(disposable); }
  }

  async #verifyWorkspace(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, record: GitWorkspaceRecord, expectedHead: string | undefined, requireClean: boolean): Promise<WorkspaceObservation> {
    await this.#assertFilesystemIsolation();
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
    const entries = await this.#readTrustedDirectory(gitDir);
    const allowed = new Set(["COMMIT_EDITMSG", "HEAD", "ORIG_HEAD", "commondir", "gitdir", "index", "logs", "refs"]);
    if (entries.some(entry => !allowed.has(entry.name))) throw new Error("linked worktree metadata contains an unknown entry");
    const gitdirIdentity = await inspectResource(path.join(gitDir, "gitdir"), "file", true, this.#ticketRoot);
    const gitdirText = (await readExactNoFollow(path.join(gitDir, "gitdir"), this.#ticketRoot, 16 * 1024)).toString("utf8");
    if (!gitdirText.endsWith("\n") || (await realpath(path.resolve(gitDir, gitdirText.slice(0, -1)))) !== path.resolve(dotGit) || gitdirIdentity.linkCount !== 1) throw new Error("linked worktree gitdir metadata is substituted");
    const commonText = (await readExactNoFollow(path.join(gitDir, "commondir"), this.#ticketRoot, 16 * 1024)).toString("utf8");
    if (commonText !== "../..\n") throw new Error("linked worktree common-dir metadata is substituted");
    const headText = (await readExactNoFollow(path.join(gitDir, "HEAD"), this.#ticketRoot, 16 * 1024)).toString("utf8");
    if (headText !== `ref: ${branchRef(spec.featureBranch)}\n`) throw new Error("linked worktree HEAD is not the exact feature ref");
    await inspectResource(path.join(gitDir, "index"), "file", true, this.#ticketRoot);
    if (entries.some(entry => entry.name === "COMMIT_EDITMSG")) await inspectResource(path.join(gitDir, "COMMIT_EDITMSG"), "file", true, this.#ticketRoot);
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
    const logEntries = await this.#readTrustedDirectory(logs);
    if (logEntries.some(entry => entry.name !== "HEAD")) throw new Error("linked worktree logs contain an unknown entry");
    if (logEntries.some(entry => entry.name === "HEAD")) await inspectResource(path.join(logs, "HEAD"), "file", true, this.#ticketRoot);
    const refs = path.join(gitDir, "refs");
    await inspectResource(refs, "directory", true, this.#ticketRoot);
    if ((await this.#readTrustedDirectory(refs)).length !== 0) throw new Error("linked worktree refs are not empty");
    if (path.dirname(path.resolve(dotGit)) !== path.resolve(worktree)) throw new Error("linked worktree path identity is inconsistent");
  }

  async #configureSafeRepository(context: GitLeaseContext, spec: GitWorkspaceSpecDocument, record: GitWorkspaceRecord): Promise<void> {
    await this.#assertFilesystemIsolation();
    const fs = this.#paths(spec.runId);
    const config = path.join(fs.repository, "config");
    await this.#assertConfigIsNotSubstituted(context, spec, record);
    const lines = [
      "[core]",
      `repositoryformatversion = ${spec.objectFormat === "sha256" ? "1" : "0"}`,
      "filemode = true",
      "bare = true",
      `hooksPath = ${gitConfigValue(fs.hooksPath)}`,
      "fsmonitor = false",
      "[user]",
      "name = Squire",
      `email = ${SAFE_GIT_EMAIL}`,
      "[credential]",
      "helper =",
      "[commit]",
      "gpgSign = false",
      "[tag]",
      "gpgSign = false",
      "[submodule]",
      "recurse = false",
      "[fetch]",
      "recurseSubmodules = false",
      '[protocol "file"]',
      "allow = never",
      '[protocol "ext"]',
      "allow = never",
      '[protocol "ssh"]',
      "allow = never",
      "[transfer]",
      "fsckObjects = true",
      ...(spec.objectFormat === "sha256" ? ["[extensions]", "objectFormat = sha256"] : []),
      "",
    ].join("\n");
    const expectedBytes = Buffer.from(lines, "utf8");
    await this.#assertFilesystemIsolation();
    const identity = await inspectResource(config, "file", true, this.#ticketRoot);
    const handle = await openNoFollow(config, constants.O_RDWR, this.#ticketRoot);
    try {
      const before = await handle.stat();
      if (before.dev.toString() !== identity.device || before.ino.toString() !== identity.inode || before.nlink !== 1) throw new Error("Git config changed before descriptor rewrite");
      await handle.truncate(0);
      await handle.writeFile(expectedBytes);
      await handle.chmod(0o600);
      await handle.sync();
      const after = await handle.stat();
      if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== before.nlink || after.size !== expectedBytes.length || (after.mode & 0o777) !== 0o600) throw new Error("Git config changed during descriptor rewrite");
    } finally { await handle.close(); }
    await fsyncDirectory(path.dirname(config), this.#ticketRoot);
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
    await this.#assertFilesystemIsolation();
    const fs = this.#paths(spec.runId);
    const target = path.join(fs.controlRoot, OWNERSHIP_FILE);
    const document = { schemaVersion: 1, kind: OWNERSHIP_KIND, runId: spec.runId, specFingerprint: spec.fingerprint, generation, repository: "/ticket/git/repo.git", worktree: "/ticket/workspace" };
    const bytes = serializeCanonical(document);
    const existing = await this.#pathKind(target);
    if (existing === "missing") {
      await this.#authority.assertRunStartAllowed(spec.runId, this.#clock.now());
      await this.#assertFilesystemIsolation();
      const handle = await openNoFollow(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, this.#ticketRoot, 0o600);
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
    await this.#assertFilesystemIsolation();
    await this.#authority.assertRunStartAllowed(context.runId, this.#clock.now());
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
    if ((await this.#readTrustedDirectory(fs.controlRoot)).length !== 0) throw new Error("pre-existing unowned Git control state");
  }

  async #ensureTemplateAndHooks(fs: GitWorkspaceFilesystemPaths, context: GitLeaseContext): Promise<void> {
    await this.#assertFilesystemIsolation();
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
    const before = await this.#store.read(context.runId);
    if (!before?.gitWorkspace) throw new StoreConflictError("Git workspace record is missing");
    await this.#updateRecord(context, snapshot => {
      const record = snapshot.gitWorkspace;
      if (!record) throw new StoreConflictError("Git workspace record is missing");
      const operation = record.operation ?? { operationId, owner: context.preparationOwner, generation: record.operationGeneration, step, startedAt: new Date(this.#clock.now()).toISOString() };
      if (operation.operationId !== operationId || operation.owner !== context.preparationOwner) throw new StoreConflictError("Git operation ownership changed");
      const command = { operationId, step, state, owner: context.preparationOwner, fencingToken: context.lease.fencingToken, ...(processIdentity ? { processIdentity } : {}) } as const;
      return { ...snapshot, gitWorkspace: { ...record, operation: { ...operation, step, command } } };
    });
  }

  async #clearEphemeralOperation(context: GitLeaseContext, operationId: string): Promise<void> {
    await this.#updateRecord(context, snapshot => {
      const record = snapshot.gitWorkspace;
      const operation = record?.operation;
      if (!record || !operation || operation.operationId !== operationId) return snapshot;
      if (operation.command && ["spawning", "spawned", "unknown"].includes(operation.command.state)) return snapshot;
      const { operation: _operation, ...withoutOperation } = record;
      return { ...snapshot, gitWorkspace: withoutOperation };
    });
  }

  async #git(context: GitLeaseContext, operationId: string, step: GitOperationStep, args: readonly string[], overrides: Partial<Pick<GitCommandOptions, "cwd" | "allowExitCodes" | "allowNetwork" | "passFileDescriptors" | "extraEnv">> = {}): Promise<GitCommandResult> {
    await this.#authority.assertRunStartAllowed(context.runId, this.#clock.now());
    const before = await this.#store.read(context.runId);
    const ephemeral = !before?.gitWorkspace?.operation;
    await this.#setCommand(context, operationId, step, "reserved");
    await this.#setCommand(context, operationId, step, "spawning");
    let spawnPersist: Promise<void> | undefined;
    let spawnFailure: unknown;
    let spawnedIdentity: string | undefined;
    const options: GitCommandOptions = {
      cwd: this.#ticketRoot,
      runId: context.runId,
      ticketRoot: this.#ticketRoot,
      timeoutMs: this.#commandTimeoutMs,
      maxOutputBytes: this.#commandOutputBytes,
      ...overrides,
      onSpawn: process => {
        // GitCommandRunner awaits this callback. A child is therefore never
        // considered settled until its exact identity is durably bound to the
        // persisted operation; a failed CAS is retained as unresolved.
        spawnedIdentity = process.identity;
        spawnPersist = this.#setCommand(context, operationId, step, "spawned", process.identity);
        return spawnPersist.catch(error => { spawnFailure = error; throw error; });
      },
      onObservedExit: (process, result) => this.#setCommand(context, operationId, step, "exited", process.identity).catch(error => { spawnFailure = error; throw error; }),
    };
    try {
      await this.#assertFilesystemIsolation(options.signal);
      const result = await this.#command.run(args, options);
      await spawnPersist;
      if (spawnFailure) throw spawnFailure;
      await this.#authority.assertRunStartAllowed(context.runId, this.#clock.now());
      return result;
    } catch (error) {
      await spawnPersist?.catch(() => undefined);
      if (error instanceof GitCommandError && error.result) {
        await this.#setCommand(context, operationId, step, "exited", error.result.processIdentity).catch(() => undefined);
      } else {
        const observedIdentity = (error instanceof GitCommandError ? error.result?.processIdentity : undefined) ?? spawnedIdentity;
        await this.#setCommand(context, operationId, step, "unknown", observedIdentity).catch(() => undefined);
      }
      throw error;
    } finally {
      if (ephemeral) await this.#clearEphemeralOperation(context, operationId);
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
        // This is a logical locator for authoritative WorkflowStore state,
        // not a pathname that could be mistaken for an unpersisted file.
        return { ...snapshot, gitWorkspace: { ...nextBase, stage: "blocked", ...(unresolved && current.operation ? { operation: current.operation } : {}), error: { code, message: redact(message).replaceAll(this.#ticketRoot, "/ticket"), at: new Date(this.#clock.now()).toISOString() }, evidence: unresolved ? ["workflow-state:gitWorkspace.operation"] : ["workflow-state:gitWorkspace"] } as GitWorkspaceRecord };
      });
    } catch { /* A terminal fence or lost generic lease must remain fail-closed. */ }
  }

  async #renew(context: GitLeaseContext): Promise<void> {
    await this.#assertFilesystemIsolation();
    const renewed = await this.#store.renewLease(context.runId, GIT_LEASE_KEY, context.owner, context.lease.fencingToken, this.#clock.now(), this.#operationLeaseMs);
    if (!renewed) throw new StoreConflictError("Git workspace lease was fenced or expired");
    context.lease.expiresAt = renewed.expiresAt;
  }

  #guard(context: GitLeaseContext): LeaseGuard { return { key: GIT_LEASE_KEY, owner: context.owner, fencingToken: context.lease.fencingToken, now: this.#clock.now() }; }

  async #assertFilesystemIsolation(signal?: AbortSignal): Promise<void> {
    await assertTrustedFilesystemOperation(this.#filesystemAuthority, this.#ticketRoot, signal);
  }

  #assertExistingRecord(existing: GitWorkspaceRecord | undefined, spec: GitWorkspaceSpecDocument, reference: ContractReference, runId: string): void {
    if (!existing) return;
    this.#assertRecordIdentity(existing, spec, reference);
    if (existing.runId !== runId) throw new Error("Git workspace record run identity mismatch");
  }

  #assertRecordIdentity(record: GitWorkspaceRecord, spec: GitWorkspaceSpecDocument, reference: ContractReference): void {
    if (record.runId !== spec.runId || record.spec.path !== reference.path || record.spec.sha256 !== reference.sha256 || record.spec.schemaId !== reference.schemaId || record.specFingerprint !== spec.fingerprint || record.featureBranch !== spec.featureBranch || record.operationGeneration < 1 || canonicalJson(record.paths) !== canonicalJson(logicalGitWorkspacePaths(spec.runId))) throw new Error("Git workspace immutable identity mismatch");
    const operation = record.operation;
    const bundle = "bundle" in record ? record.bundle : undefined;
    if ((operation !== undefined && (!operation || typeof operation !== "object" || Array.isArray(operation))) || (bundle !== undefined && (!bundle || typeof bundle !== "object" || Array.isArray(bundle)))) throw new Error("Git workspace persisted state is malformed");
    if (bundle && (!isBundleResourceShape(bundle.resource, bundle.bundlePath) || !bundle.manifest || bundle.manifest.path !== `artifacts/git/${spec.runId}/bundle-manifest.json` || bundle.manifest.schemaId !== "urn:squire:git-workspace:v1:bundle-manifest" || typeof bundle.manifest.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(bundle.manifest.sha256) || bundle.bundlePath !== `artifacts/git/${spec.runId}/${bundle.headSha}.bundle` || bundle.objectFormat !== spec.objectFormat || bundle.featureBranch !== spec.featureBranch || bundle.baseSha !== spec.baseSha || !/^[0-9a-f]{40,64}$/u.test(bundle.headSha) || !/^[0-9a-f]{64}$/u.test(bundle.sha256) || !Number.isSafeInteger(bundle.byteLength) || bundle.byteLength <= 0 || !Number.isSafeInteger(bundle.exportGeneration) || bundle.exportGeneration < 1)) throw new Error("Git bundle record identity is malformed");
    if (operation) {
      if (typeof operation.operationId !== "string" || operation.operationId.length === 0 || operation.operationId.length > 200 || typeof operation.owner !== "string" || operation.owner !== `git-operation-${operation.operationId}` || !GIT_OPERATION_STEPS.has(operation.step) || operation.generation !== record.operationGeneration || !Number.isSafeInteger(operation.generation) || typeof operation.startedAt !== "string" || !Number.isFinite(Date.parse(operation.startedAt))) throw new Error("Git workspace operation identity is malformed");
      if (operation.intent && (operation.intent.kind !== "offline-commit" || typeof operation.intent.messageSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(operation.intent.messageSha256))) throw new Error("Git operation intent identity is malformed");
      if (operation.command && (typeof operation.command.operationId !== "string" || operation.command.operationId !== operation.operationId || typeof operation.command.owner !== "string" || operation.command.owner !== operation.owner || !GIT_COMMAND_STATES.has(operation.command.state) || !Number.isSafeInteger(operation.command.fencingToken) || operation.command.fencingToken < 1 || (operation.command.processIdentity !== undefined && (typeof operation.command.processIdentity !== "string" || operation.command.processIdentity.length < 1 || operation.command.processIdentity.length > 300 || /[\u0000-\u001f\u007f\r\n]/u.test(operation.command.processIdentity))) || (["spawned", "exited", "unknown"].includes(operation.command.state) && typeof operation.command.processIdentity !== "string"))) throw new Error("Git command allocation identity is malformed");
    }
  }

  #assertLogicalSpecPaths(spec: GitWorkspaceSpecDocument, runId: string): void {
    if (canonicalJson(spec.paths) !== canonicalJson(logicalGitWorkspacePaths(runId))) throw new Error("workspace spec paths are not the fixed logical paths");
  }

  async #assertHttpsResolveSupport(context: GitLeaseContext, operationId: string): Promise<void> {
    const result = await this.#git(context, operationId, "fetch", ["help", "--config"]);
    if (!result.stdout.split("\n").some(line => line.trim() === "http.curloptResolve")) throw new Error("Git binary does not support mandatory HTTPS address pinning");
  }

  #assertAuthorizedTransport(repository: GitRepositoryIdentity, authorization: GitSourceAuthorization): readonly string[] {
    if (!authorization || typeof authorization.cloneUrl !== "string" || authorization.cloneUrl.length === 0 || authorization.cloneUrl.length > 2048 || /[\u0000-\u001f\u007f\r\n]/u.test(authorization.cloneUrl)) throw new Error("approved Git source URL is malformed");
    if (authorization.localTransport !== undefined && typeof authorization.localTransport !== "boolean") throw new Error("approved Git source transport flag is malformed");
    if (authorization.resolvedAddresses !== undefined && !Array.isArray(authorization.resolvedAddresses)) throw new Error("approved Git source address set is malformed");
    if (authorization.environment !== undefined && (!authorization.environment || typeof authorization.environment !== "object" || Array.isArray(authorization.environment))) throw new Error("approved Git source environment is malformed");
    if (authorization.release !== undefined && typeof authorization.release !== "function") throw new Error("approved Git source release hook is malformed");
    for (const [key, value] of Object.entries(authorization.environment ?? {})) {
      if (typeof value !== "string") throw new Error(`approved Git source environment value is malformed: ${key}`);
      if (key === "GIT_ALLOW_PROTOCOL" && value !== "https") throw new Error("approved Git source may not widen the HTTPS protocol allowlist");
      if (key !== "GIT_ALLOW_PROTOCOL" && key !== "GIT_HTTP_USER_AGENT") throw new Error(`approved Git source environment is not allowlisted: ${key}`);
    }
    if (authorization.localTransport) {
      if (!this.#allowLocalTransport) throw new Error("local Git transport is disabled in production");
      if (!/^(?:file:|[A-Za-z]:[\\/]|\\\\|\/)/u.test(authorization.cloneUrl)) throw new Error("test local transport authorization is not local");
      return [];
    }
    const approved = assertCredentialFreeHttpsCloneUrl(authorization.cloneUrl, repository.owner, repository.name);
    const requested = assertCredentialFreeHttpsCloneUrl(repository.cloneUrl, repository.owner, repository.name);
    if (approved.url.toString() !== requested.url.toString() || authorization.cloneUrl !== repository.cloneUrl) throw new Error("approved Git source is not bound to the immutable repository URL");
    return buildGitHttpsResolveConfig(repository, authorization.resolvedAddresses ?? []);
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
    const file = await openNoFollow(physical, constants.O_RDONLY, this.#ticketRoot);
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

  async #readTrustedDirectory(directory: string): Promise<readonly import("node:fs").Dirent[]> {
    const handle = await openNoFollow(directory, constants.O_RDONLY | constants.O_DIRECTORY, this.#ticketRoot);
    try {
      const before = await handle.stat();
      const entries = await readdir(`/proc/self/fd/${handle.fd}`, { withFileTypes: true });
      const after = await handle.stat();
      if (!before.isDirectory() || !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode) throw new Error(`trusted directory changed during enumeration: ${directory}`);
      return entries;
    } finally { await handle.close(); }
  }

  async #assertNoPath(target: string): Promise<void> {
    const kind = await this.#pathKind(target);
    if (kind !== "missing") throw new Error(`unexpected pre-existing Git workspace path: ${target}`);
  }

  async #assertDirectoryEmpty(directory: string): Promise<void> {
    const kind = await this.#pathKind(directory);
    if (kind !== "directory") throw new Error(`Git trusted directory is not a directory: ${directory}`);
    const entries = await this.#readTrustedDirectory(directory);
    if (entries.length !== 0) throw new Error(`Git trusted directory is not empty: ${directory}`);
  }

  async #assertNoDirectoryEntries(directory: string, forbidden: readonly string[]): Promise<void> {
    const kind = await this.#pathKind(directory);
    if (kind === "missing") return;
    if (kind !== "directory") throw new Error(`Git metadata directory is not a directory: ${directory}`);
    const entries = await this.#readTrustedDirectory(directory);
    for (const name of forbidden) if (entries.some(entry => entry.name === name)) throw new Error(`forbidden Git metadata entry: ${name}`);
  }

  async #assertTrustedControlRoot(controlRoot: string): Promise<void> {
    const allowed = new Set([OWNERSHIP_FILE, "hooks", "template"]);
    const entries = await this.#readTrustedDirectory(controlRoot);
    if (entries.some(entry => !allowed.has(entry.name))) throw new Error("Git control root contains unknown state");
    for (const directory of [path.join(controlRoot, "hooks"), path.join(controlRoot, "template")]) {
      await inspectResource(directory, "directory", true, this.#ticketRoot);
    }
  }

  async #assertBareRepositoryTree(repository: string): Promise<void> {
    const root = await inspectResource(repository, "directory", true, this.#ticketRoot);
    const rootHandle = await openNoFollow(repository, constants.O_RDONLY | constants.O_DIRECTORY, this.#ticketRoot);
    try {
      const opened = await rootHandle.stat();
      if (opened.dev.toString() !== root.device || opened.ino.toString() !== root.inode || (opened.mode & 0o777) !== root.mode) throw new Error("Git repository root changed during descriptor acquisition");
      await this.#scanRepositoryDirectory(rootHandle, repository, root.device, 0);
    } finally { await rootHandle.close(); }
  }

  async #scanRepositoryDirectory(directory: import("node:fs/promises").FileHandle, displayPath: string, device: string, depth: number): Promise<void> {
    if (depth > 64) throw new Error("Git repository metadata is too deep");
    const entries = await readdir(`/proc/self/fd/${directory.fd}`, { withFileTypes: true });
    if (entries.length > 100_000) throw new Error("Git repository metadata directory is too large");
    for (const entry of entries) {
      const child = descriptorChildPath(directory, entry.name);
      if ([".promisor", "alternates", "http-alternates", "grafts", "shallow"].includes(entry.name)) throw new Error(`partial or alternate Git metadata is not trusted: ${path.join(displayPath, entry.name)}`);
      const info = await lstat(child);
      if (String(info.dev) !== device) throw new Error(`Git repository tree crosses a filesystem boundary: ${path.join(displayPath, entry.name)}`);
      const kind = entryKind(info);
      if (kind === "symlink") throw new Error(`symbolic link in Git repository metadata is not trusted: ${path.join(displayPath, entry.name)}`);
      if (kind === "other") throw new Error(`unsupported Git repository metadata entry: ${path.join(displayPath, entry.name)}`);
      if (kind === "file") {
        if (info.nlink !== 1) throw new Error(`hardlinked Git repository metadata is not trusted: ${path.join(displayPath, entry.name)}`);
        continue;
      }
      const childDirectory = await openNoFollowAt(directory, entry.name, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        const childInfo = await childDirectory.stat();
        if (childInfo.dev.toString() !== info.dev.toString() || childInfo.ino.toString() !== info.ino.toString() || childInfo.mode !== info.mode || childInfo.nlink !== info.nlink) throw new Error(`Git repository directory changed during inspection: ${path.join(displayPath, entry.name)}`);
        await this.#scanRepositoryDirectory(childDirectory, path.join(displayPath, entry.name), device, depth + 1);
      } finally { await childDirectory.close(); }
    }
  }

  async #removeOwnedTemporary(target: string): Promise<void> {
    await this.#assertFilesystemIsolation();
    const kind = await this.#pathKind(target);
    if (kind === "missing") return;
    const name = path.basename(target);
    if (!BUNDLE_STAGING.test(name) && !BUNDLE_CHECK.test(name)) return;
    if (kind === "symlink") {
      await this.#assertFilesystemIsolation();
      await removeTreeNoFollow(target, undefined, this.#ticketRoot);
      return;
    }
    const identity = await inspectResource(target, kind === "directory" ? "directory" : "file", true, this.#ticketRoot);
    await this.#assertFilesystemIsolation();
    await removeTreeNoFollow(target, identity, this.#ticketRoot);
  }

  async #removeEmptyControllerRoot(target: string, runId: string, fence: RunTerminalFence, signal?: AbortSignal): Promise<void> {
    if (target === this.#ticketRoot || target === "/ticket") return;
    await this.#assertFilesystemIsolation(signal);
    const kind = await this.#pathKind(target);
    if (kind === "missing") return;
    if (kind !== "directory") throw new Error(`Git controller root was replaced: ${target}`);
    const entries = await this.#readTrustedDirectory(target);
    if (entries.length !== 0) return;
    const identity = await inspectResource(target, "directory", true, this.#ticketRoot);
    await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
    const beforeRemoval = await inspectResource(target, "directory", true, this.#ticketRoot);
    if (!sameResourceIdentity(identity, beforeRemoval)) throw new Error(`Git controller root changed before removal: ${target}`);
    if (signal?.aborted) throw new Error("Git disposal was aborted");
    await this.#assertFilesystemIsolation(signal);
    await removeEmptyDirectoryNoFollow(target, this.#ticketRoot, identity);
    await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
  }

  async #ensureDisposalRoot(fs: GitWorkspaceFilesystemPaths): Promise<void> {
    await this.#assertFilesystemIsolation();
    await ensurePrivateDirectory(fs.disposalRoot, this.#ticketRoot);
  }

  async #assertDisposalDirectory(directory: string, runId: string, token: number): Promise<void> {
    await this.#assertFilesystemIsolation();
    const name = path.basename(directory);
    const match = DISPOSAL_DIRECTORY.exec(name);
    if (!match || match[1] !== runId || Number(match[2]) !== token) throw new Error("Git disposal directory identity is invalid");
    const kind = await this.#pathKind(directory);
    if (kind === "missing") await ensurePrivateDirectory(directory, this.#ticketRoot, 0o700);
    else if (kind !== "directory") throw new Error("Git disposal directory was replaced");
    const identity = await chmodDirectoryNoFollow(directory, this.#ticketRoot, 0o700);
    if (identity.mode !== 0o700) throw new Error("Git disposal directory is not private");
  }

  #physicalPath(logical: string): string {
    if (!logical.startsWith("/ticket/")) throw new Error("logical Git path is not under /ticket");
    return path.join(this.#ticketRoot, ...logical.slice("/ticket/".length).split("/"));
  }

  async #buildDisposalArtifactProof(spec: GitWorkspaceSpecDocument, record: Extract<GitWorkspaceRecord, { stage: "retained" }>, resources: GitWorkspaceManifestDocument["resources"], scratchRoot: string): Promise<DisposalArtifactProof> {
    await this.#assertFilesystemIsolation();
    const fs = this.#paths(spec.runId);
    const root = await inspectResource(fs.artifactRoot, "directory", true, this.#ticketRoot);
    const expectedRoot = resources.artifactRoot;
    if (expectedRoot.path !== `/ticket/artifacts/git/${spec.runId}` || expectedRoot.kind !== "directory" || !matchesCleanupIdentity(root, { ...expectedRoot, path: root.path })) throw new Error("retained artifact root identity does not match the workspace manifest");
    if (record.bundle) await this.#verifyBundleRecordOffline(spec, record.bundle, record.spec, record.manifest, scratchRoot);
    const expectedNames = new Set(["workspace-spec.json", "workspace-manifest.json", ...(record.bundle ? ["bundle-manifest.json", path.basename(record.bundle.bundlePath)] : [])]);
    const rootHandle = await openNoFollow(fs.artifactRoot, constants.O_RDONLY | constants.O_DIRECTORY, this.#ticketRoot);
    const children: DisposalArtifactChildProof[] = [];
    try {
      const openedRoot = await rootHandle.stat();
      if (openedRoot.dev.toString() !== root.device || openedRoot.ino.toString() !== root.inode || (openedRoot.mode & 0o777) !== root.mode || openedRoot.nlink !== root.linkCount) throw new Error("retained artifact root changed during descriptor acquisition");
      const entries = await readdir(`/proc/self/fd/${rootHandle.fd}`, { withFileTypes: true });
      if (entries.length !== expectedNames.size || entries.some(entry => !expectedNames.has(entry.name))) throw new Error("retained artifact root contains unexpected or missing evidence");
      for (const entry of entries) {
        if (!entry.isFile()) throw new Error(`retained artifact is not a regular file: ${entry.name}`);
        const maxBytes = record.bundle && entry.name === path.basename(record.bundle.bundlePath) ? this.#maxBundleBytes : 16 * 1024 * 1024;
        const file = await openNoFollowAt(rootHandle, entry.name, constants.O_RDONLY);
        try {
          const info = await file.stat();
          if (!info.isFile() || info.nlink !== 1) throw new Error(`retained artifact is not a single-link regular file: ${entry.name}`);
          const digest = await digestDescriptor(file, maxBytes);
          if (record.bundle && entry.name === path.basename(record.bundle.bundlePath) && (info.mode & 0o222) !== 0) throw new Error("retained Git bundle is owner-writable");
          children.push({ name: entry.name, identity: { kind: "file", device: String(info.dev), inode: String(info.ino), mode: info.mode & 0o777, linkCount: info.nlink }, byteLength: digest.byteLength, sha256: digest.sha256 });
        } finally { await file.close(); }
      }
    } finally { await rootHandle.close(); }
    return { root: { kind: "directory", device: root.device, inode: root.inode, mode: root.mode, linkCount: root.linkCount }, children: children.sort((a, b) => a.name.localeCompare(b.name)), ...(record.bundle ? { bundle: await this.#disposalBundleProof(spec, record.bundle, scratchRoot) } : {}) };
  }

  async #disposalBundleProof(spec: GitWorkspaceSpecDocument, bundle: GitBundleRecord, scratchRoot: string): Promise<DisposalArtifactBundleProof> {
    // #verifyBundleRecordOffline already authenticated the manifest binding and
    // descriptor. Journal the independently rechecked content inventory so a
    // crash after a move cannot turn an altered retained bundle into a clean
    // disposal retry.
    const verification = await this.#readAndVerifyBundleDescriptorOffline(spec, bundle, scratchRoot);
    return { bundlePath: bundle.bundlePath, manifestPath: bundle.manifest.path, byteLength: bundle.byteLength, sha256: bundle.sha256, objectFormat: bundle.objectFormat, featureBranch: bundle.featureBranch, baseSha: bundle.baseSha, headSha: bundle.headSha, prerequisites: verification.prerequisites, refs: verification.refs };
  }

  async #verifyBundleRecordOffline(spec: GitWorkspaceSpecDocument, bundle: GitBundleRecord, specReference: ContractReference, workspaceManifest: ContractReference, scratchRoot: string): Promise<void> {
    await this.#assertFilesystemIsolation();
    const validated = await (await this.#validatorPromise).validateBundle(bundle.manifest, { runId: spec.runId, spec: specReference, workspaceManifest, headSha: bundle.headSha });
    if (bundle.manifest.path !== `artifacts/git/${spec.runId}/bundle-manifest.json` || validated.document.bundlePath !== bundle.bundlePath || validated.document.sha256 !== bundle.sha256 || validated.document.byteLength !== bundle.byteLength || validated.document.featureBranch !== spec.featureBranch || validated.document.baseSha !== spec.baseSha || validated.document.objectFormat !== spec.objectFormat) throw new Error("retained bundle manifest binding mismatch");
    const verification = await this.#readAndVerifyBundleDescriptorOffline(spec, bundle, scratchRoot);
    if (canonicalJson(verification.refs) !== canonicalJson(validated.document.refs) || canonicalJson(verification.prerequisites) !== canonicalJson(validated.document.prerequisites)) throw new Error("retained bundle verification metadata mismatch");
  }

  async #readAndVerifyBundleDescriptorOffline(spec: GitWorkspaceSpecDocument, bundle: GitBundleRecord, scratchRoot: string): Promise<{ readonly prerequisites: readonly string[]; readonly refs: readonly { readonly name: string; readonly oid: string }[] }> {
    await this.#assertFilesystemIsolation();
    const file = await openImmutableFile(path.join(this.#ticketRoot, ...bundle.bundlePath.split("/")), this.#maxBundleBytes, this.#ticketRoot);
    try {
      const info = await file.handle.stat();
      const actualResource: ResourceIdentity = { path: `/ticket/${bundle.bundlePath}`, kind: "file", device: String(info.dev), inode: String(info.ino), mode: info.mode & 0o777, linkCount: info.nlink };
      if (!sameBundleResource(actualResource, bundle.resource, bundle.bundlePath) || (info.mode & 0o222) !== 0) throw new Error("retained Git bundle identity or permissions mismatch");
      const digest = await digestDescriptor(file.handle, this.#maxBundleBytes);
      if (digest.sha256 !== bundle.sha256 || digest.byteLength !== bundle.byteLength) throw new Error("retained Git bundle digest mismatch");
      const verification = await this.#verifyBundleBytesOffline(spec, bundle.headSha, file.handle, digest, scratchRoot);
      if (verification.refs.length !== 1 || verification.refs[0]?.name !== branchRef(spec.featureBranch) || verification.refs[0]?.oid !== bundle.headSha) throw new Error("retained Git bundle ref inventory mismatch");
      return verification;
    } finally { await file.handle.close(); }
  }

  #assertDisposalArtifactProofRecord(proof: DisposalArtifactProof, record: Extract<GitWorkspaceRecord, { stage: "retained" }>, resources: GitWorkspaceManifestDocument["resources"]): void {
    const expectedRoot = resources.artifactRoot;
    if (expectedRoot.path !== `/ticket/artifacts/git/${record.runId}` || expectedRoot.kind !== "directory" || proof.root.kind !== "directory" || proof.root.device !== expectedRoot.device || proof.root.inode !== expectedRoot.inode || proof.root.mode !== expectedRoot.mode || proof.root.linkCount !== expectedRoot.linkCount) throw new Error("disposal artifact proof root is not bound to the retained manifest");
    const expectedNames = new Set(["workspace-spec.json", "workspace-manifest.json", ...(record.bundle ? ["bundle-manifest.json", path.basename(record.bundle.bundlePath)] : [])]);
    if (proof.children.length !== expectedNames.size || proof.children.some(child => !expectedNames.has(child.name))) throw new Error("disposal artifact proof is not bound to the retained record");
    const childDigests = new Map(proof.children.map(child => [child.name, child.sha256]));
    if (childDigests.get("workspace-spec.json") !== record.spec.sha256 || childDigests.get("workspace-manifest.json") !== record.manifest.sha256 || (record.bundle && childDigests.get("bundle-manifest.json") !== record.bundle.manifest.sha256)) throw new Error("disposal artifact proof does not bind persisted contract bytes");
    if (record.bundle) {
      const bundle = proof.bundle;
      if (!bundle || bundle.bundlePath !== record.bundle.bundlePath || bundle.manifestPath !== record.bundle.manifest.path || bundle.byteLength !== record.bundle.byteLength || bundle.sha256 !== record.bundle.sha256 || bundle.objectFormat !== record.bundle.objectFormat || bundle.featureBranch !== record.bundle.featureBranch || bundle.baseSha !== record.bundle.baseSha || bundle.headSha !== record.bundle.headSha || !isBundleResourceShape(record.bundle.resource, record.bundle.bundlePath)) throw new Error("disposal bundle proof is not bound to the retained record");
    } else if (proof.bundle) throw new Error("disposal proof contains an unexpected retained bundle");
    if (proof.bundle) {
      const recordBundle = record.bundle;
      if (!recordBundle) throw new Error("disposal proof contains an unexpected retained bundle");
      const child = proof.children.find(candidate => candidate.name === path.basename(proof.bundle!.bundlePath));
      if (!child || child.byteLength !== proof.bundle.byteLength || child.sha256 !== proof.bundle.sha256 || !sameBundleResource({ path: `/ticket/${recordBundle.bundlePath}`, ...child.identity }, recordBundle.resource, recordBundle.bundlePath) || (child.identity.mode & 0o222) !== 0) throw new Error("disposal proof does not bind the retained bundle bytes");
    }
  }

  async #verifyDisposalArtifactTarget(target: string, proof: DisposalArtifactProof): Promise<void> {
    await this.#assertFilesystemIsolation();
    const root = await inspectResource(target, "directory", true, this.#ticketRoot);
    if (root.device !== proof.root.device || root.inode !== proof.root.inode || root.mode !== proof.root.mode || root.linkCount !== proof.root.linkCount) throw new Error("disposal artifact root identity changed");
    const rootHandle = await openNoFollow(target, constants.O_RDONLY | constants.O_DIRECTORY, this.#ticketRoot);
    try {
      const openedRoot = await rootHandle.stat();
      if (openedRoot.dev.toString() !== proof.root.device || openedRoot.ino.toString() !== proof.root.inode || (openedRoot.mode & 0o777) !== proof.root.mode || openedRoot.nlink !== proof.root.linkCount) throw new Error("disposal artifact root changed during verification");
      const entries = await readdir(`/proc/self/fd/${rootHandle.fd}`, { withFileTypes: true });
      const expected = new Map(proof.children.map(child => [child.name, child]));
      if (entries.length !== proof.children.length || entries.some(entry => !entry.isFile() || !expected.has(entry.name))) throw new Error("disposal artifact children changed");
      for (const child of proof.children) {
        const maxBytes = proof.bundle?.bundlePath && child.name === path.basename(proof.bundle.bundlePath) ? this.#maxBundleBytes : 16 * 1024 * 1024;
        const file = await openNoFollowAt(rootHandle, child.name, constants.O_RDONLY);
        try {
          const info = await file.stat();
          if (!info.isFile() || String(info.dev) !== child.identity.device || String(info.ino) !== child.identity.inode || (info.mode & 0o777) !== child.identity.mode || info.nlink !== child.identity.linkCount) throw new Error(`disposal artifact child identity changed: ${child.name}`);
          const digest = await digestDescriptor(file, maxBytes);
          if (digest.byteLength !== child.byteLength || digest.sha256 !== child.sha256) throw new Error(`disposal artifact child digest changed: ${child.name}`);
        } finally { await file.close(); }
      }
    } finally { await rootHandle.close(); }
  }

  async #disposeOne(runId: string, fence: RunTerminalFence, target: string, source: string, destination: string, expected: ResourceIdentity | undefined, removed: string[], alreadyAbsent: string[], signal?: AbortSignal, retries = 0, verifyTarget?: (target: string) => Promise<void>, removalChildren?: readonly RemovalChildIdentity[]): Promise<void> {
    await this.#assertFilesystemIsolation(signal);
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
      await verifyTarget?.(destination);
      await this.#writeDisposalCompletion(completion, runId, fence, target, moved);
      await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
      await this.#assertFilesystemIsolation(signal);
      if (signal?.aborted) throw new Error("Git disposal was aborted");
      await verifyTarget?.(destination);
      await removeTreeNoFollow(destination, moved, this.#ticketRoot, removalChildren, ...(signal ? [{ signal }] : []));
      await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
      removed.push(source);
      return;
    }
    if (sourceKind !== "directory" && sourceKind !== "file") throw new Error("Git disposal source is not a regular trusted resource");
    if (destinationKind !== "missing") throw new Error("Git disposal found both source and destination; replacement is preserved");
    const sourceIdentity = await inspectResource(source, sourceKind, true, this.#ticketRoot);
    if (expected && !matchesCleanupIdentity(sourceIdentity, expected)) throw new Error("Git disposal source identity mismatch");
    await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
    await this.#assertFilesystemIsolation(signal);
    if (signal?.aborted) throw new Error("Git disposal was aborted");
    try { await renameWithIdentity(source, destination, this.#ticketRoot, sourceIdentity); }
    catch (error) {
      const raced = isMissing(error) || error instanceof GitPathSecurityError && error.message === `disposal destination already exists: ${destination}`;
      if (raced && retries < 3) return await this.#disposeOne(runId, fence, target, source, destination, expected, removed, alreadyAbsent, signal, retries + 1, verifyTarget, removalChildren);
      throw error;
    }
    await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
    const moved = await inspectResource(destination, sourceIdentity.kind, true, this.#ticketRoot);
    if (expected && !matchesCleanupIdentity(moved, expected)) throw new Error("Git disposal destination identity mismatch");
    await verifyTarget?.(destination);
    await this.#writeDisposalCompletion(completion, runId, fence, target, moved);
    await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
    await this.#assertFilesystemIsolation(signal);
    if (signal?.aborted) throw new Error("Git disposal was aborted");
    await verifyTarget?.(destination);
    await removeTreeNoFollow(destination, moved, this.#ticketRoot, removalChildren, ...(signal ? [{ signal }] : []));
    await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
    removed.push(source);
  }

  async #writeDisposalIdentity(target: string, runId: string, fence: RunTerminalFence, manifest: ContractReference, resources: GitWorkspaceManifestDocument["resources"], contracts: DisposalContractSnapshots, artifacts: DisposalArtifactProof): Promise<void> {
    await this.#assertFilesystemIsolation();
    const document = serializeCanonical({ schemaVersion: 1, kind: "squire-git-disposal-identity", runId, token: fence.fencingToken, manifest, resources, contracts, artifacts });
    const kind = await this.#pathKind(target);
    if (kind === "missing") {
      await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
      await this.#assertFilesystemIsolation();
      await writeExclusiveFile(target, document, this.#ticketRoot, 0o600);
      await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
      return;
    }
    if (kind !== "file") throw new Error("Git disposal identity is an unsafe replacement");
    const identity = await inspectResource(target, "file", true, this.#ticketRoot);
    if (identity.mode !== 0o600 || !(await readExactNoFollow(target, this.#ticketRoot, 64 * 1024)).equals(document)) throw new Error("Git disposal identity was substituted");
  }

  async #captureDisposalContracts(record: Extract<GitWorkspaceRecord, { stage: "retained" }>): Promise<DisposalContractSnapshots> {
    await this.#assertFilesystemIsolation();
    const read = async (reference: ContractReference): Promise<string> => (await readExactNoFollow(path.join(this.#ticketRoot, ...reference.path.split("/")), this.#ticketRoot, 16 * 1024 * 1024)).toString("base64");
    return { spec: await read(record.spec), manifest: await read(record.manifest), ...(record.bundle ? { bundle: await read(record.bundle.manifest) } : {}) };
  }

  async #validateDisposalContractSnapshots(contracts: DisposalContractSnapshots, record: Extract<GitWorkspaceRecord, { stage: "retained" }>): Promise<GitWorkspaceManifestDocument["resources"]> {
    const validator = await this.#validatorPromise;
    const read = (encoded: string, reference: ContractReference, schemaId: "urn:squire:git-workspace:v1:workspace-spec" | "urn:squire:git-workspace:v1:workspace-manifest" | "urn:squire:git-workspace:v1:bundle-manifest"): GitWorkspaceSpecDocument | GitWorkspaceManifestDocument | GitBundleManifestDocument => {
      const bytes = decodeDisposalContract(encoded);
      if (sha256Bytes(bytes) !== reference.sha256) throw new Error("disposal contract snapshot digest mismatch");
      return validator.validateBytes(schemaId, bytes);
    };
    const spec = read(contracts.spec, record.spec, "urn:squire:git-workspace:v1:workspace-spec") as GitWorkspaceSpecDocument;
    if (spec.runId !== record.runId || spec.fingerprint !== record.specFingerprint) throw new Error("disposal spec snapshot binding mismatch");
    this.#assertRecordIdentity(record, spec, record.spec);
    const manifest = read(contracts.manifest, record.manifest, "urn:squire:git-workspace:v1:workspace-manifest") as GitWorkspaceManifestDocument;
    if (manifest.runId !== record.runId || manifest.spec.path !== record.spec.path || manifest.spec.sha256 !== record.spec.sha256 || manifest.spec.schemaId !== record.spec.schemaId || manifest.specFingerprint !== record.specFingerprint || !manifestMatchesSpec(manifest, spec)) throw new Error("disposal manifest snapshot binding mismatch");
    if (record.bundle) {
      if (!contracts.bundle) throw new Error("disposal bundle contract snapshot is missing");
      const bundle = read(contracts.bundle, record.bundle.manifest, "urn:squire:git-workspace:v1:bundle-manifest") as GitBundleManifestDocument;
      if (bundle.runId !== record.runId || bundle.spec.path !== record.spec.path || bundle.spec.sha256 !== record.spec.sha256 || bundle.workspaceManifest.path !== record.manifest.path || bundle.workspaceManifest.sha256 !== record.manifest.sha256 || bundle.bundlePath !== record.bundle.bundlePath || bundle.sha256 !== record.bundle.sha256 || bundle.byteLength !== record.bundle.byteLength || bundle.headSha !== record.bundle.headSha) throw new Error("disposal bundle snapshot binding mismatch");
    } else if (contracts.bundle !== undefined) throw new Error("unexpected disposal bundle contract snapshot");
    return manifest.resources;
  }

  async #readRelocatedDisposalManifest(artifactRoot: string, record: Extract<GitWorkspaceRecord, { stage: "retained" }>): Promise<GitWorkspaceManifestDocument["resources"]> {
    await this.#assertFilesystemIsolation();
    const validator = await this.#validatorPromise;
    const readContract = async <T extends GitWorkspaceSpecDocument | GitWorkspaceManifestDocument | GitBundleManifestDocument>(name: string, reference: ContractReference, schemaId: "urn:squire:git-workspace:v1:workspace-spec" | "urn:squire:git-workspace:v1:workspace-manifest" | "urn:squire:git-workspace:v1:bundle-manifest"): Promise<T> => {
      const target = path.join(artifactRoot, name);
      const bytes = await readExactNoFollow(target, this.#ticketRoot, 16 * 1024 * 1024);
      if (sha256Bytes(bytes) !== reference.sha256) throw new Error(`relocated Git contract digest mismatch: ${name}`);
      return validator.validateBytes<T>(schemaId, bytes);
    };
    const spec = await readContract<GitWorkspaceSpecDocument>("workspace-spec.json", record.spec, "urn:squire:git-workspace:v1:workspace-spec");
    if (spec.runId !== record.runId || spec.fingerprint !== record.specFingerprint) throw new Error("relocated workspace spec binding mismatch");
    const manifest = await readContract<GitWorkspaceManifestDocument>("workspace-manifest.json", record.manifest, "urn:squire:git-workspace:v1:workspace-manifest");
    if (manifest.runId !== record.runId || manifest.spec.path !== record.spec.path || manifest.spec.sha256 !== record.spec.sha256 || manifest.spec.schemaId !== record.spec.schemaId || manifest.specFingerprint !== record.specFingerprint || !manifestMatchesSpec(manifest, spec)) throw new Error("relocated workspace manifest binding mismatch");
    if (record.bundle) {
      const bundle = await readContract<GitBundleManifestDocument>("bundle-manifest.json", record.bundle.manifest, "urn:squire:git-workspace:v1:bundle-manifest");
      if (bundle.runId !== record.runId || bundle.spec.path !== record.spec.path || bundle.spec.sha256 !== record.spec.sha256 || bundle.workspaceManifest.path !== record.manifest.path || bundle.workspaceManifest.sha256 !== record.manifest.sha256 || bundle.bundlePath !== record.bundle.bundlePath || bundle.sha256 !== record.bundle.sha256 || bundle.byteLength !== record.bundle.byteLength || bundle.headSha !== record.bundle.headSha) throw new Error("relocated bundle manifest binding mismatch");
    }
    return manifest.resources;
  }

  async #readDisposalIdentity(target: string, runId: string, token: number, manifest: ContractReference): Promise<{ readonly resources: GitWorkspaceManifestDocument["resources"]; readonly contracts: DisposalContractSnapshots; readonly artifacts: DisposalArtifactProof }> {
    await this.#assertFilesystemIsolation();
    const identity = await inspectResource(target, "file", true, this.#ticketRoot);
    if (identity.mode !== 0o600) throw new Error("Git disposal identity is not private");
    let value: unknown;
    const bytes = await readExactNoFollow(target, this.#ticketRoot, 64 * 1024);
    try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Git disposal identity is not JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Git disposal identity is malformed");
    const document = value as Record<string, unknown>;
    if (JSON.stringify(Object.keys(document).sort()) !== JSON.stringify(["artifacts", "contracts", "kind", "manifest", "resources", "runId", "schemaVersion", "token"]) || document["schemaVersion"] !== 1 || document["kind"] !== "squire-git-disposal-identity" || document["runId"] !== runId || document["token"] !== token || !document["manifest"] || typeof document["manifest"] !== "object" || Array.isArray(document["manifest"]) || !document["resources"] || typeof document["resources"] !== "object" || Array.isArray(document["resources"]) || !document["contracts"] || typeof document["contracts"] !== "object" || Array.isArray(document["contracts"]) || !document["artifacts"] || typeof document["artifacts"] !== "object" || Array.isArray(document["artifacts"]) || !serializeCanonical(document).equals(bytes)) throw new Error("Git disposal identity is malformed");
    const reference = document["manifest"] as Record<string, unknown>;
    if (JSON.stringify(Object.keys(reference).sort()) !== JSON.stringify(["path", "schemaId", "sha256"]) || reference["path"] !== manifest.path || reference["sha256"] !== manifest.sha256 || reference["schemaId"] !== manifest.schemaId) throw new Error("Git disposal identity manifest reference mismatch");
    return { resources: parseDisposalResources(document["resources"], runId), contracts: parseDisposalContractSnapshots(document["contracts"]), artifacts: parseDisposalArtifactProof(document["artifacts"], runId) };
  }

  async #hasDisposalCompletion(target: string, runId: string, token: number, name: string, expected: ResourceIdentity | undefined): Promise<boolean> {
    await this.#assertFilesystemIsolation();
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
    await this.#assertFilesystemIsolation();
    const document = serializeCanonical({ schemaVersion: 1, kind: "squire-git-disposal-complete", runId, token: fence.fencingToken, target: name, identity: { kind: identity.kind, device: identity.device, inode: identity.inode, mode: identity.mode, linkCount: identity.linkCount } });
    const kind = await this.#pathKind(target);
    if (kind === "missing") {
      await this.#authority.assertRunTeardownQuiescent(runId, fence, this.#clock.now());
      await this.#assertFilesystemIsolation();
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

function manifestMatchesSpec(manifest: GitWorkspaceManifestDocument, spec: GitWorkspaceSpecDocument): boolean {
  return manifest.runId === spec.runId && manifest.ticketIdentifier === spec.ticketIdentifier && manifest.repository.owner === spec.repository.owner && manifest.repository.name === spec.repository.name && manifest.repository.cloneUrl === spec.repository.cloneUrl && manifest.baseBranch === spec.baseBranch && manifest.baseSha === spec.baseSha && manifest.featureBranch === spec.featureBranch && manifest.objectFormat === spec.objectFormat && manifest.specFingerprint === spec.fingerprint;
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
  if (record.runId !== runId || !spec || typeof spec !== "object" || spec.path !== `artifacts/git/${runId}/workspace-spec.json` || spec.schemaId !== "urn:squire:git-workspace:v1:workspace-spec" || typeof spec.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(spec.sha256) || !manifest || typeof manifest !== "object" || manifest.path !== `artifacts/git/${runId}/workspace-manifest.json` || manifest.schemaId !== "urn:squire:git-workspace:v1:workspace-manifest" || typeof manifest.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(manifest.sha256) || typeof record.specFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(record.specFingerprint) || typeof featureBranch !== "string" || featureBranch !== featureBranch.toLowerCase() || !featureBranch.startsWith("squire/") || canonicalJson(record.paths) !== canonicalJson(logicalGitWorkspacePaths(runId)) || !Number.isSafeInteger(record.operationGeneration) || record.operationGeneration < 1 || record.operation !== undefined || !retention || !["success", "failure"].includes(retention.outcome) || !Number.isFinite(Date.parse(retention.workspaceRetainUntil)) || !Number.isFinite(Date.parse(retention.bundleRetainUntil))) throw new Error("Git disposal record identity is malformed");
}
function assertDisposalAuthorization(retention: GitWorkspaceRetention, authorization: GitDisposalAuthorization, trustedNow: number): void { if (!Number.isFinite(trustedNow)) throw new Error("trusted disposal clock is invalid"); if (authorization.workspaceRetainUntil !== undefined && authorization.workspaceRetainUntil !== retention.workspaceRetainUntil) throw new Error("workspace retention authorization was substituted"); if (authorization.bundleRetainUntil !== undefined && authorization.bundleRetainUntil !== retention.bundleRetainUntil) throw new Error("bundle retention authorization was substituted"); const workspaceAllowed = authorization.disposeWorkspace !== false; const bundleAllowed = authorization.disposeBundle !== false; if (workspaceAllowed && trustedNow < Date.parse(retention.workspaceRetainUntil)) throw new Error("workspace retention deadline has not elapsed"); if (bundleAllowed && trustedNow < Date.parse(retention.bundleRetainUntil)) throw new Error("bundle retention deadline has not elapsed"); }
function gitConfigValue(value: string): string {
  if (!/[\s#;"\\]/u.test(value)) return value;
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
function positiveInteger(value: number, label: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`); return value; }
function matchesCleanupIdentity(actual: ResourceIdentity, expected: ResourceIdentity): boolean { return actual.kind === expected.kind && actual.device === expected.device && actual.inode === expected.inode && actual.mode === expected.mode && (actual.kind === "file" ? actual.linkCount === expected.linkCount : true); }
function isBundleResourceShape(resource: ResourceIdentity | undefined, relativePath: string): resource is ResourceIdentity { return Boolean(resource && typeof resource.path === "string" && resource.path === `/ticket/${relativePath}` && resource.kind === "file" && typeof resource.device === "string" && resource.device.length > 0 && typeof resource.inode === "string" && resource.inode.length > 0 && Number.isSafeInteger(resource.mode) && resource.mode === 0o400 && Number.isSafeInteger(resource.linkCount) && resource.linkCount === 1); }
function sameBundleResource(actual: ResourceIdentity, expected: ResourceIdentity | undefined, relativePath: string): boolean { return isBundleResourceShape(expected, relativePath) && actual.path === expected.path && actual.kind === expected.kind && actual.device === expected.device && actual.inode === expected.inode && actual.mode === expected.mode && actual.linkCount === expected.linkCount; }
function parseDisposalArtifactProof(value: unknown, runId: string): DisposalArtifactProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Git disposal artifact proof is malformed");
  const document = value as Record<string, unknown>;
  const keys = Object.keys(document).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["children", "root", ...(document["bundle"] !== undefined ? ["bundle"] : [])].sort()) || !Array.isArray(document["children"]) || !document["root"] || typeof document["root"] !== "object" || Array.isArray(document["root"])) throw new Error("Git disposal artifact proof is malformed");
  const root = parseDisposalIdentityWithoutPath(document["root"], "directory");
  const children: DisposalArtifactChildProof[] = [];
  for (const value of document["children"] as unknown[]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Git disposal artifact child proof is malformed");
    const child = value as Record<string, unknown>;
    if (JSON.stringify(Object.keys(child).sort()) !== JSON.stringify(["byteLength", "identity", "name", "sha256"]) || typeof child["name"] !== "string" || !/^[A-Za-z0-9._-]+$/u.test(child["name"]) || children.some(existing => existing.name === child["name"]) || !Number.isSafeInteger(child["byteLength"]) || (child["byteLength"] as number) <= 0 || (child["byteLength"] as number) > DEFAULT_MAX_BUNDLE_BYTES || typeof child["sha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(child["sha256"])) throw new Error("Git disposal artifact child proof is malformed");
    children.push({ name: child["name"], identity: parseDisposalIdentityWithoutPath(child["identity"], "file"), byteLength: child["byteLength"] as number, sha256: child["sha256"] });
  }
  if (children.length === 0) throw new Error("Git disposal artifact proof has no children");
  let bundle: DisposalArtifactBundleProof | undefined;
  if (document["bundle"] !== undefined) {
    const raw = document["bundle"];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Git disposal bundle proof is malformed");
    const value = raw as Record<string, unknown>;
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["baseSha", "bundlePath", "byteLength", "featureBranch", "headSha", "manifestPath", "objectFormat", "prerequisites", "refs", "sha256"]) || value["bundlePath"] !== `artifacts/git/${runId}/${value["headSha"]}.bundle` || value["manifestPath"] !== `artifacts/git/${runId}/bundle-manifest.json` || (value["objectFormat"] !== "sha1" && value["objectFormat"] !== "sha256") || typeof value["featureBranch"] !== "string" || typeof value["baseSha"] !== "string" || typeof value["headSha"] !== "string" || !Number.isSafeInteger(value["byteLength"]) || (value["byteLength"] as number) <= 0 || typeof value["sha256"] !== "string" || !/^[0-9a-f]{64}$/u.test(value["sha256"]) || !Array.isArray(value["prerequisites"]) || !Array.isArray(value["refs"])) throw new Error("Git disposal bundle proof is malformed");
    const format = value["objectFormat"] as GitObjectFormat;
    assertFullObjectId(value["baseSha"] as string, format); assertFullObjectId(value["headSha"] as string, format);
    const prerequisites = (value["prerequisites"] as unknown[]).map(item => { if (typeof item !== "string") throw new Error("Git disposal bundle prerequisite is malformed"); return assertFullObjectId(item, format); });
    const refs = (value["refs"] as unknown[]).map(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Git disposal bundle ref is malformed");
      const ref = item as Record<string, unknown>;
      if (JSON.stringify(Object.keys(ref).sort()) !== JSON.stringify(["name", "oid"]) || typeof ref["name"] !== "string" || typeof ref["oid"] !== "string") throw new Error("Git disposal bundle ref is malformed");
      return { name: ref["name"], oid: assertFullObjectId(ref["oid"], format) };
    });
    if (refs.length !== 1 || refs[0]?.name !== `refs/heads/${value["featureBranch"]}` || refs[0]?.oid !== value["headSha"]) throw new Error("Git disposal bundle ref proof is malformed");
    bundle = { bundlePath: value["bundlePath"] as string, manifestPath: value["manifestPath"] as string, byteLength: value["byteLength"] as number, sha256: value["sha256"] as string, objectFormat: format, featureBranch: value["featureBranch"] as string, baseSha: value["baseSha"] as string, headSha: value["headSha"] as string, prerequisites, refs };
  }
  return { root, children: children.sort((a, b) => a.name.localeCompare(b.name)), ...(bundle ? { bundle } : {}) };
}

function parseDisposalIdentityWithoutPath(value: unknown, expectedKind: "file" | "directory"): Omit<ResourceIdentity, "path"> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Git disposal artifact identity is malformed");
  const identity = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify(["device", "inode", "kind", "linkCount", "mode"]) || identity["kind"] !== expectedKind || typeof identity["device"] !== "string" || !identity["device"] || typeof identity["inode"] !== "string" || !identity["inode"] || !Number.isSafeInteger(identity["mode"]) || (identity["mode"] as number) < 0 || (identity["mode"] as number) > 0o777 || !Number.isSafeInteger(identity["linkCount"]) || (identity["linkCount"] as number) < 1) throw new Error("Git disposal artifact identity is malformed");
  return { kind: expectedKind, device: identity["device"], inode: identity["inode"], mode: identity["mode"] as number, linkCount: identity["linkCount"] as number };
}

function parseDisposalContractSnapshots(value: unknown): DisposalContractSnapshots {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Git disposal contract snapshots are malformed");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["manifest", "spec", ...(record["bundle"] !== undefined ? ["bundle"] : [])].sort()) || typeof record["spec"] !== "string" || typeof record["manifest"] !== "string" || record["bundle"] !== undefined && typeof record["bundle"] !== "string") throw new Error("Git disposal contract snapshots are malformed");
  const spec = assertDisposalContractEncoding(record["spec"]);
  const manifest = assertDisposalContractEncoding(record["manifest"]);
  const bundle = record["bundle"] === undefined ? undefined : assertDisposalContractEncoding(record["bundle"] as string);
  return { spec, manifest, ...(bundle !== undefined ? { bundle } : {}) };
}

function assertDisposalContractEncoding(value: string): string {
  if (value.length === 0 || value.length > 32 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value) || Buffer.from(value, "base64").toString("base64") !== value) throw new Error("Git disposal contract snapshot encoding is malformed");
  return value;
}

function decodeDisposalContract(value: string): Buffer { assertDisposalContractEncoding(value); return Buffer.from(value, "base64"); }

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
