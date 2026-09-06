import type { ContractReference, Lease, Role, RunTerminalFence } from "../control/domain.js";

export const SANDBOX_SCHEMA_VERSION = 1 as const;
export const SANDBOX_KIND = "squire-sandbox-spec" as const;
export const SANDBOX_RELEASE_KIND = "squire-sandbox-release-manifest" as const;
export const SANDBOX_ATTESTATION_KIND = "squire-sandbox-attestation" as const;
export const SANDBOX_TRANSFER_KIND = "squire-sandbox-transfer-manifest" as const;
export const SBX_V039_VERSION = "0.39.0" as const;

export type SandboxLifecycleState =
  | "reserving"
  | "creating"
  | "created"
  | "starting"
  | "attesting"
  | "ready"
  | "stopping"
  | "stopped"
  | "retained"
  | "removing"
  | "removed"
  | "blocked";

export type SandboxOperationKind = "reserve" | "create" | "start" | "stop" | "reconcile" | "remove" | "transfer" | "attest";
export type SandboxOperationIntent = "create" | "start" | "stop" | "remove" | "cp-import" | "cp-export" | "inspect" | "attest";
export type SandboxNetworkMode = "allow-all" | "allowlist" | "deny-all";
export type SandboxDiskEnforcement = "native" | "quota-composed" | "unsupported";

export interface SandboxNetworkSpec {
  readonly mode: SandboxNetworkMode;
  readonly allowedHosts: readonly string[];
  /** SHA-256 of the canonical effective policy, not a mutable policy name. */
  readonly profileDigest: string;
}

export interface SandboxDiskBudget {
  readonly enforcement: SandboxDiskEnforcement;
  /** Present only when the tuple has an independently proven bound. */
  readonly ticketQuotaBytes?: number;
  readonly bridgeQuotaBytes?: number;
  readonly writableTmpfsBytes?: number;
  /** Native v0.39.0 option, if the external harness proves it. */
  readonly nativeLimitBytes?: number;
  readonly proof?: ContractReference;
  /** Required when enforcement is unsupported. */
  readonly unsupportedReason?: string;
}

export interface SandboxResourceSpec {
  readonly cpus: number;
  readonly memoryMiB: number;
  readonly disk: SandboxDiskBudget;
}

export interface SandboxBridgeSpec {
  readonly name: string;
  readonly logicalPath: "/ticket/bridge";
  readonly quotaBytes: number;
  /** Host ledger reference; it is never a mounted bridge file. */
  readonly identityReference: string;
}

export interface SandboxRetentionSpec {
  readonly successUntil: string;
  readonly failureUntil: string;
  readonly artifactUntil: string;
}

export interface SandboxSpecDocument {
  readonly schemaVersion: typeof SANDBOX_SCHEMA_VERSION;
  readonly kind: typeof SANDBOX_KIND;
  readonly runId: string;
  readonly ticketIdentifier: string;
  readonly sandboxName: string;
  readonly template: {
    readonly name: string;
    readonly digest: string;
    readonly reference: string;
  };
  readonly resources: SandboxResourceSpec;
  readonly network: SandboxNetworkSpec;
  readonly bridge: SandboxBridgeSpec;
  readonly retention: SandboxRetentionSpec;
  readonly creationNonce: string;
  /** SHA-256 over the canonical document with fingerprint omitted. */
  readonly fingerprint: string;
}

export interface SandboxResourceTuple extends SandboxResourceSpec {
  readonly tupleId: string;
}

export interface SandboxReleaseEvidence {
  readonly kind: "host-conformance" | "resource" | "network" | "identity" | "removal" | "provenance";
  readonly platform: string;
  readonly architecture: string;
  readonly path: string;
  readonly sha256: string;
  readonly hostOnly: true;
}

export interface SandboxReleaseManifestDocument {
  readonly schemaVersion: typeof SANDBOX_SCHEMA_VERSION;
  readonly kind: typeof SANDBOX_RELEASE_KIND;
  readonly releaseId: string;
  readonly sbxVersion: typeof SBX_V039_VERSION;
  readonly platform: string;
  readonly architecture: string;
  readonly sbxBinary: {
    readonly path: string;
    readonly sha256: string;
    readonly versionOutput: string;
    readonly helpDigest: string;
  };
  readonly template: {
    readonly reference: string;
    readonly digest: string;
    readonly configDigest: string;
    readonly helperDigests: readonly string[];
  };
  readonly runtimeCompatibility: {
    readonly pi: { readonly minimum: string; readonly maximum: string };
    readonly llmWiki: { readonly minimum: string; readonly maximum: string };
  };
  readonly supportedResources: readonly SandboxResourceTuple[];
  readonly bridgeQuotaBytes: number;
  readonly networkProfileDigest: string;
  readonly conformanceEvidence: readonly SandboxReleaseEvidence[];
  readonly provenance: {
    readonly buildReference: string;
    readonly sbomReference: string;
  };
  readonly promotion: {
    readonly state: "validated" | "blocked";
    readonly algorithm: "sha256-hmac" | "ed25519";
    readonly keyId: string;
    readonly signature: string;
  };
}

export interface SandboxObservedIdentity {
  readonly sandboxId: string;
  readonly sandboxName: string;
  readonly vmId: string;
  readonly templateDigest: string;
  readonly bridgeName: string;
  readonly bridgeIdentity: {
    readonly device: string;
    readonly inode: string;
    readonly mode: number;
    readonly linkCount: number;
    readonly quotaBytes: number;
  };
}

export interface SandboxAttestationDocument {
  readonly schemaVersion: typeof SANDBOX_SCHEMA_VERSION;
  readonly kind: typeof SANDBOX_ATTESTATION_KIND;
  readonly runId: string;
  readonly sandboxName: string;
  readonly specFingerprint: string;
  readonly releaseId: string;
  readonly templateDigest: string;
  readonly observed: SandboxObservedIdentity;
  readonly bootId: string;
  readonly resources: {
    readonly requested: SandboxResourceSpec;
    readonly cpuOnline: number;
    readonly memoryMaxBytes: number;
    readonly disk: {
      readonly enforcement: SandboxDiskEnforcement;
      readonly statfsBytes: number;
      readonly quotaBytes?: number;
      readonly enospcObserved: boolean;
      readonly proofDigest: string;
    };
  };
  readonly principals: {
    readonly controllerUid: number;
    readonly controllerGid: number;
    readonly agentUid: number;
    readonly agentGid: number;
    readonly distinct: true;
    readonly sudoAbsent: true;
    readonly rootfulDockerSocketAbsent: true;
    readonly supervisorSocketProtected: true;
  };
  readonly mounts: {
    readonly namespace: string;
    readonly ticketDevice: string;
    readonly ticketInode: string;
    readonly mountInfoDigest: string;
    readonly forbiddenMountsAbsent: true;
    readonly nestedMountsAbsent: true;
  };
  readonly sockets: {
    readonly rootlessDocker: string;
    readonly controllerSocketsAbsent: true;
    readonly hostSocketsAbsent: true;
  };
  readonly network: {
    readonly profileDigest: string;
    readonly allowedHttpsCorrelationDigest: string;
    readonly deniedProbeDigest: string;
    readonly hostObservation: ContractReference;
  };
  readonly credentials: {
    readonly effectiveEnvironmentDigest: string;
    readonly forbiddenNamesAbsent: true;
    readonly canaryHmacDigest: string;
  };
  readonly canaries: {
    readonly principalDigest: string;
    readonly mountDigest: string;
    readonly dockerDigest: string;
    readonly persistenceDigest: string;
    readonly isolationDigest: string;
  };
  readonly creationGeneration: number;
  readonly attestedAt: string;
  readonly fingerprint: string;
}

export type SandboxTransferDirection = "import" | "export";
export interface SandboxTransferManifestDocument {
  readonly schemaVersion: typeof SANDBOX_SCHEMA_VERSION;
  readonly kind: typeof SANDBOX_TRANSFER_KIND;
  readonly direction: SandboxTransferDirection;
  readonly runId: string;
  readonly sandboxName: string;
  readonly sandboxId: string;
  readonly specFingerprint: string;
  readonly bootId: string;
  readonly source: { readonly logicalPath: string; readonly side: "host" | "sandbox" };
  readonly destination: { readonly logicalPath: string; readonly side: "host" | "sandbox" };
  readonly byteLength: number;
  readonly sha256: string;
  readonly expectedGit?: {
    readonly objectFormat: "sha1" | "sha256";
    readonly baseSha: string;
    readonly repository?: string;
    readonly bundle?: string;
  };
  readonly transferGeneration: number;
  readonly sourceVerified: true;
  readonly destinationVerified: true;
  readonly bridgeUsed: false;
  readonly createdAt: string;
  readonly fingerprint: string;
}

export interface SandboxProcessIdentity {
  readonly sandboxName: string;
  readonly sandboxId: string;
  readonly bootId: string;
  readonly allocationId: string;
  readonly generation: number;
  readonly pid: number;
  readonly procStartTime: string;
  readonly uid: number;
  readonly argvDigest: string;
}

export interface SandboxHostChildIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly executable: string;
  readonly executableDigest: string;
  readonly identity: string;
}

export interface SandboxOperation {
  readonly kind: SandboxOperationKind;
  readonly intent: SandboxOperationIntent;
  readonly owner: string;
  readonly fencingToken: number;
  readonly generation: number;
  readonly deadlineAt: number;
  readonly startedAt: string;
  readonly child?: SandboxHostChildIdentity;
  readonly lastObservedState?: string;
}

export interface SandboxIdentityManifest {
  readonly schemaVersion: typeof SANDBOX_SCHEMA_VERSION;
  readonly kind: "squire-sandbox-identity-manifest";
  readonly runId: string;
  readonly sandboxName: string;
  readonly sandboxId: string;
  readonly vmId: string;
  readonly releaseId: string;
  readonly templateDigest: string;
  readonly specFingerprint: string;
  readonly bridge: {
    readonly name: string;
    readonly hostPath: string;
    readonly logicalPath: "/ticket/bridge";
    readonly device: string;
    readonly inode: string;
    readonly mode: number;
    readonly linkCount: number;
    readonly quotaBytes: number;
  };
  readonly generation: number;
  readonly bootId?: string;
}

export interface SandboxRecord {
  readonly runId: string;
  readonly spec: ContractReference;
  readonly specFingerprint: string;
  readonly templateDigest: string;
  readonly sandboxName: string;
  readonly bridgeName: string;
  readonly releaseId: string;
  readonly lifecycle: SandboxLifecycleState;
  readonly operationGeneration: number;
  readonly operation?: SandboxOperation;
  readonly identity?: SandboxIdentityManifest;
  readonly attestation?: ContractReference;
  readonly attestationDigest?: string;
  readonly bootId?: string;
  readonly transferGeneration: number;
  readonly retention?: {
    readonly outcome: "success" | "failure";
    readonly retainUntil: string;
    readonly artifactUntil: string;
  };
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly at: string;
    readonly evidence: readonly ContractReference[];
  };
}

export interface RunTeardownRecord {
  readonly runId: string;
  readonly owner: string;
  readonly generation: number;
  readonly state: "draining" | "fenced" | "removing" | "completed" | "blocked";
  readonly reason: "retention" | "terminal" | "operator";
  readonly requestedAt: string;
  readonly fence?: RunTerminalFence;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly at: string;
  };
}

export interface SandboxLease extends Lease {
  readonly runId: string;
  readonly deadlineAt: number;
  readonly ttlMs: number;
}

export interface SandboxLifecycleResult {
  readonly runId: string;
  readonly sandbox: SandboxRecord;
  readonly attestation?: SandboxAttestationDocument;
}

export interface RoleAttachmentDescriptorPort {
  get(runId: string, role: Role): Promise<RoleAttachmentDescriptor>;
}

export interface HerdrTopologyAcceptanceProbePort {
  probe(request: { readonly runId: string; readonly sandboxName: string; readonly expectedRoles: readonly Role[] }, signal?: AbortSignal): Promise<{ readonly hostOnly: true; readonly pass: boolean; readonly evidence: ContractReference }>;
}

export interface RoleAttachmentDescriptor {
  readonly runId: string;
  readonly role: Role;
  readonly sandboxName: string;
  readonly sandboxId: string;
  readonly bootId: string;
  readonly allocationId: string;
  readonly generation: number;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly runnerCommand: readonly string[];
}

export interface ExternalAcceptanceProbeRequest {
  readonly schemaVersion: 1;
  readonly kind: "squire-sandbox-host-probe-request";
  readonly requestId: string;
  readonly runId: string;
  readonly sandboxName: string;
  readonly releaseId: string;
  readonly platform: string;
  readonly architecture: string;
  readonly probes: readonly string[];
  readonly requestedAt: string;
}

export interface ExternalAcceptanceProbeResult {
  readonly schemaVersion: 1;
  readonly kind: "squire-sandbox-host-probe-result";
  readonly requestId: string;
  readonly runId: string;
  readonly sandboxName: string;
  readonly releaseId: string;
  readonly platform: string;
  readonly architecture: string;
  readonly status: "pass" | "fail";
  readonly hostOnly: true;
  readonly evidence: readonly ContractReference[];
  readonly completedAt: string;
}

export const SANDBOX_LIFECYCLE_STATES: readonly SandboxLifecycleState[] = [
  "reserving", "creating", "created", "starting", "attesting", "ready", "stopping", "stopped", "retained", "removing", "removed", "blocked",
];

export const SANDBOX_OPERATION_KINDS: readonly SandboxOperationKind[] = ["reserve", "create", "start", "stop", "reconcile", "remove", "transfer", "attest"];

export function isSandboxTerminalLifecycle(state: SandboxLifecycleState): boolean {
  return state === "removed" || state === "blocked";
}

export function isSandboxReady(record: SandboxRecord): boolean {
  return record.lifecycle === "ready" && record.attestation !== undefined && record.identity !== undefined && record.operation === undefined;
}
