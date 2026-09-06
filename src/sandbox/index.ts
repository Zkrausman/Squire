/** Narrow AIDEV-223 composition surface. Raw sbx argv, bridge paths, guest
 * protocol, release-signing, and test fakes remain internal modules. */
export type {
  SandboxLifecycleState, SandboxOperationKind, SandboxOperationIntent, SandboxNetworkMode, SandboxDiskEnforcement,
  SandboxNetworkSpec, SandboxDiskBudget, SandboxResourceSpec, SandboxBridgeSpec, SandboxRetentionSpec,
  SandboxSpecDocument, SandboxResourceTuple, SandboxReleaseEvidence, SandboxReleaseManifestDocument,
  SandboxObservedIdentity, SandboxAttestationDocument, SandboxTransferDirection, SandboxTransferManifestDocument,
  SandboxProcessIdentity, SandboxHostChildIdentity, SandboxOperation, SandboxIdentityManifest, SandboxRecord,
  RunTeardownRecord, SandboxLease, SandboxLifecycleResult, RoleAttachmentDescriptor, RoleAttachmentDescriptorPort, HerdrTopologyAcceptanceProbePort, ExternalAcceptanceProbeRequest,
  ExternalAcceptanceProbeResult,
} from "./domain.js";
export { SandboxContractError, SandboxContractValidator, assertSandboxSemantics, sandboxSemanticErrors } from "./contracts.js";
export type { SandboxSchemaName, SandboxSchemaId, ValidatedSandboxDocument } from "./contracts.js";
export { SandboxReleaseResolver, canonicalTemplateReference, selectResourceTuple, sameResourceTuple, assertRuntimeCompatibility, versionInRange } from "./release-resolver.js";
export type { SandboxReleaseSelection, SandboxReleaseResolverOptions, ResolvedSandboxRelease, SandboxBinaryObservation } from "./release-resolver.js";
export { SandboxLifecycleService, SandboxLifecycleError } from "./lifecycle-service.js";
export type { SandboxCreateRequest, SandboxLifecycleOptions, SandboxRemovalOptions, SandboxLifecyclePort, SandboxTransferReservation } from "./lifecycle-service.js";
export { SandboxRecoveryService, SandboxRecoveryError } from "./recovery.js";
export type { SandboxRecoveryDisposition, SandboxRecoveryObservation } from "./recovery.js";
export type { SandboxAttestorPort, MeasuredSandboxEvidence, SandboxAttestationInput, SandboxNetworkCanaryEvidence, SandboxCredentialEvidence } from "./attestation.js";
export { MeasuredSandboxAttestor, SandboxAttestationError } from "./attestation.js";
export { SandboxTransferService, SandboxTransferError, createSandboxTransferService } from "./transfer-service.js";
export type { RepositorySeedArtifact, RepositorySeedArtifactPort, TrustedRetentionStore, SandboxTransferContext, TransferResult, SandboxTransferServiceOptions } from "./transfer-service.js";
export { SandboxGitWorkspaceProxy, SandboxGitWorkspaceProxyError, createSandboxGitWorkspaceProxy } from "./git-workspace-proxy.js";
export type { SandboxGitWorkspaceProxyPort, SandboxImmutableBundleImportDescriptor, SandboxGitWorkspaceComposition } from "./git-workspace-proxy.js";
export { SandboxRetentionExporter, RetentionExportError } from "./retention-export.js";
export type { RetainedSandboxFile, RetentionExportResult } from "./retention-export.js";
export { SandboxPiProcessFactory, SandboxPiProcess, SandboxProcessIdentityResolver, SandboxPiProcessError, roleAttachmentDescriptor } from "./pi-process-factory.js";
export type { SandboxPiProcessFactoryOptions, SandboxPiProcessFactoryPort, RoleAttachmentDescriptorInput } from "./pi-process-factory.js";
export type { WorkflowStoreRpcPort, GuestWorkflowSnapshot } from "./workflow-store-rpc.js";
export { buildRoleAttachmentDescriptor, SandboxRoleAttachmentRegistry, RoleAttachmentError } from "./role-attachment.js";
export { SandboxTeardownCoordinator, TeardownCoordinatorError } from "./teardown-coordinator.js";
export type { SandboxTeardownComponents, TeardownCoordinatorOptions, SandboxTeardownPort } from "./teardown-coordinator.js";
export { buildHostProbeRequest, validateHostProbeRequest, validateHostProbeResult, hostProbeArtifactDigest, HOST_PROBE_NAMES, HostAcceptanceError } from "./host-acceptance.js";
export type { HostProbeName } from "./host-acceptance.js";
export { buildHostObserverRequest, validateHostObserverRequest, validateHostObserverInput, validateHostObserverResult, buildHostConformanceEvidence, validateHostConformanceEvidence, hostConformanceEvidenceDigest, HOST_CONFORMANCE_SCHEMA_ID, HOST_OBSERVER_PHASES, HostConformanceError } from "./host-conformance.js";
export type { HostObserverIdentity, HostObserverPaths, HostObserverInput, HostObserverRequest, HostObserverResult, HostConformanceEvidence, HostObserverPhase } from "./host-conformance.js";
export { validateNetworkAuditResult, networkAuditDigest, SandboxNetworkAuditError } from "./network-audit.js";
export type { SandboxNetworkAuditPort, SandboxNetworkAuditRequest, SandboxNetworkAuditResult } from "./network-audit.js";
export { verifyRootlessDocker, RootlessDockerVerificationError } from "./docker-verifier.js";
export type { RootlessDockerObservation } from "./docker-verifier.js";
export { SandboxResourceVerifier, ResourceVerificationError, effectiveCpuCount, validateDiskFillProbe, diskProbeDigest } from "./resource-verifier.js";
export type { CgroupResourceObservation, ResourceVerification, DiskFillProbeResult } from "./resource-verifier.js";
