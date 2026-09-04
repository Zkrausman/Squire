import type { ContractReference, RunTerminalFence } from "../control/domain.js";

export type GitObjectFormat = "sha1" | "sha256";
export type GitWorkspaceStage = "provisioning" | "ready" | "exporting" | "retained" | "blocked";

/** The logical paths are intentionally fixed.  A test may map /ticket to a fresh
 * temporary root, but a production spec can never name a host checkout. */
export interface GitWorkspacePaths {
  readonly repository: "/ticket/git/repo.git";
  readonly worktree: "/ticket/workspace";
  readonly artifactRoot: string;
  readonly controlRoot: string;
}

export interface GitRepositoryIdentity {
  readonly owner: string;
  readonly name: string;
  readonly cloneUrl: string;
}

export interface GitWorkspaceSpecDocument {
  readonly schemaVersion: 1;
  readonly kind: "squire-git-workspace-spec";
  readonly runId: string;
  readonly ticketIdentifier: string;
  readonly repository: GitRepositoryIdentity;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly objectFormat: GitObjectFormat;
  readonly featureBranch: string;
  readonly paths: GitWorkspacePaths;
  readonly createdAt: string;
  /** SHA-256 over canonical JSON with this field omitted. */
  readonly fingerprint: string;
}

export interface GitWorkspaceSpecInput {
  readonly runId: string;
  readonly ticketIdentifier: string;
  readonly repository: GitRepositoryIdentity;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly objectFormat: GitObjectFormat;
  readonly createdAt?: string;
}

export type GitOperationStep =
  | "initialize"
  | "fetch"
  | "verify-import"
  | "feature-ref"
  | "worktree"
  | "config"
  | "workspace-verify"
  | "bundle-create"
  | "bundle-verify"
  | "bundle-publish"
  | "retention"
  | "dispose";

export type GitCommandAllocationState = "reserved" | "spawning" | "spawned" | "exited" | "unknown";

/** A Git child is owned by the operation, not by a second workflow lifecycle. */
export interface GitCommandAllocation {
  readonly operationId: string;
  readonly step: GitOperationStep;
  readonly state: GitCommandAllocationState;
  readonly owner: string;
  readonly fencingToken: number;
  readonly processIdentity?: string;
}

export interface GitOperationState {
  readonly operationId: string;
  readonly owner: string;
  readonly generation: number;
  readonly step: GitOperationStep;
  /** A controller-side intent is persisted before a side-effecting Git call. */
  readonly intent?: {
    readonly kind: "offline-commit";
    readonly messageSha256: string;
  };
  readonly command?: GitCommandAllocation;
  readonly startedAt: string;
}

export interface ResourceIdentity {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly linkCount: number;
}

export interface GitWorkspaceResources {
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

export interface GitWorkspaceManifestDocument {
  readonly schemaVersion: 1;
  readonly kind: "squire-git-workspace-manifest";
  readonly spec: ContractReference;
  readonly specFingerprint: string;
  readonly runId: string;
  readonly ticketIdentifier: string;
  readonly repository: GitRepositoryIdentity;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly featureBranch: string;
  readonly headSha: string;
  readonly objectFormat: GitObjectFormat;
  readonly gitCommonDir: string;
  readonly worktreeGitDir: string;
  readonly worktree: string;
  readonly hooksPath: string;
  readonly objectDirectory: string;
  readonly alternates: null;
  readonly worktreeCount: 1;
  readonly safeConfigDigest: string;
  readonly resources: GitWorkspaceResources;
  readonly verifierVersion: string;
  readonly verifiedAt: string;
}

export interface GitBundleManifestDocument {
  readonly schemaVersion: 1;
  readonly kind: "squire-git-bundle-manifest";
  readonly spec: ContractReference;
  readonly workspaceManifest: ContractReference;
  readonly runId: string;
  readonly featureBranch: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly bundlePath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly objectFormat: GitObjectFormat;
  readonly prerequisites: readonly string[];
  readonly refs: readonly { readonly name: string; readonly oid: string }[];
  readonly exportGeneration: number;
  readonly verifiedAt: string;
}

export interface GitBundleRecord {
  readonly manifest: ContractReference;
  readonly bundlePath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly objectFormat: GitObjectFormat;
  readonly featureBranch: string;
  readonly baseSha: string;
  readonly headSha: string;
  /** Physical identity captured at create-once publication; it is not contract authority but prevents same-byte inode substitution during retained cleanup. */
  readonly resource: ResourceIdentity;
  readonly exportGeneration: number;
}

export interface GitWorkspaceRetention {
  readonly outcome: "success" | "failure";
  readonly workspaceRetainUntil: string;
  readonly bundleRetainUntil: string;
}

export interface GitWorkspaceRecordBase {
  readonly runId: string;
  readonly spec: ContractReference;
  readonly specFingerprint: string;
  readonly featureBranch: string;
  readonly paths: GitWorkspacePaths;
  readonly operationGeneration: number;
  readonly operation?: GitOperationState;
}

export interface GitWorkspaceProvisioningRecord extends GitWorkspaceRecordBase {
  readonly stage: "provisioning";
}

export interface GitWorkspaceReadyRecord extends GitWorkspaceRecordBase {
  readonly stage: "ready";
  readonly manifest: ContractReference;
  readonly headSha: string;
  readonly lastVerifiedAt: string;
  readonly bundle?: GitBundleRecord;
}

export interface GitWorkspaceExportingRecord extends GitWorkspaceRecordBase {
  readonly stage: "exporting";
  readonly manifest: ContractReference;
  readonly headSha: string;
  readonly expectedHead: string;
  readonly exportGeneration: number;
  readonly bundlePath: string;
  readonly lastVerifiedAt: string;
}

export interface GitWorkspaceRetainedRecord extends GitWorkspaceRecordBase {
  readonly stage: "retained";
  readonly manifest: ContractReference;
  readonly headSha: string;
  readonly lastVerifiedAt: string;
  readonly retention: GitWorkspaceRetention;
  readonly bundle?: GitBundleRecord;
}

export interface GitWorkspaceBlockedRecord extends GitWorkspaceRecordBase {
  readonly stage: "blocked";
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly at: string;
  };
  readonly evidence: readonly string[];
}

export type GitWorkspaceRecord =
  | GitWorkspaceProvisioningRecord
  | GitWorkspaceReadyRecord
  | GitWorkspaceExportingRecord
  | GitWorkspaceRetainedRecord
  | GitWorkspaceBlockedRecord;

export interface ReadyGitWorkspace {
  readonly runId: string;
  readonly spec: ContractReference;
  readonly manifest: ContractReference;
  readonly featureBranch: string;
  readonly headSha: string;
  readonly objectFormat: GitObjectFormat;
  readonly paths: GitWorkspacePaths;
  readonly bundle?: GitBundleRecord;
}

export interface GitDisposalAuthorization {
  /**
   * An advisory scheduler observation. It is deliberately not trusted for
   * deadline evaluation; disposal always uses the service's injected Clock.
   */
  readonly now?: number | string;
  readonly workspaceRetainUntil?: string;
  readonly bundleRetainUntil?: string;
  readonly disposeWorkspace?: boolean;
  readonly disposeBundle?: boolean;
}

export interface GitDisposalResult {
  readonly runId: string;
  readonly fence: Pick<RunTerminalFence, "owner" | "fencingToken">;
  readonly removed: readonly string[];
  readonly alreadyAbsent: readonly string[];
}

export interface GitWorkspaceReadiness {
  verify(runId: string, expectedHead?: string): Promise<ReadyGitWorkspace>;
}

export interface GitWorkspaceStatus {
  readonly runId: string;
  readonly headSha: string;
  readonly porcelain: string;
}

export interface GitWorkspaceCommit {
  readonly runId: string;
  readonly headSha: string;
  readonly output: string;
}

export interface GitWorkspaceOfflinePort {
  status(runId: string): Promise<GitWorkspaceStatus>;
  offlineStatus(runId: string): Promise<GitWorkspaceStatus>;
  commit(runId: string, message: string): Promise<GitWorkspaceCommit>;
}

export interface GitWorkspaceServicePort extends GitWorkspaceReadiness, GitWorkspaceOfflinePort {
  createSpec(input: GitWorkspaceSpecInput): Promise<ContractReference>;
  provision(runId: string, spec: ContractReference, owner: string): Promise<ReadyGitWorkspace>;
  observeHead(runId?: string): Promise<string>;
  exportBundle(runId: string, expectedHead: string, owner: string): Promise<GitBundleRecord>;
  markRetained(runId: string, policy: GitWorkspaceRetention, owner: string): Promise<GitWorkspaceRecord>;
  recover(runId: string, owner: string): Promise<GitWorkspaceRecord>;
  disposeUnderTerminalFence(
    runId: string,
    fence: RunTerminalFence,
    authorization: GitDisposalAuthorization,
    signal?: AbortSignal,
  ): Promise<GitDisposalResult>;
}
