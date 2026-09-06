import type { SideEffectPermit } from "../control/domain.js";
import type { GitWorkspaceRecord } from "../git/domain.js";

export const RECONCILIATION_PROVIDERS = ["linear", "sandbox", "herdr", "process", "git", "github"] as const;
export type ReconciliationProvider = (typeof RECONCILIATION_PROVIDERS)[number];
export interface BoundedObservation<T = unknown> {
  readonly provider: ReconciliationProvider;
  readonly complete: true;
  readonly observationToken: string;
  readonly observedAt: string;
  readonly digest: string;
  readonly items: readonly T[];
  readonly conflicts?: readonly string[];
}
export interface IncompleteObservation {
  readonly provider: ReconciliationProvider;
  readonly complete: false;
  readonly observationToken?: string;
  readonly observedAt: string;
  readonly digest?: string;
  readonly items?: readonly unknown[];
  readonly error: string;
}
export type ProviderObservation<T = unknown> = BoundedObservation<T> | IncompleteObservation;
export interface ReconciliationReadContext { readonly generation: number; readonly controllerOwner: string; readonly fencingToken: number; readonly runIds: readonly string[]; readonly maxItems: number; readonly signal?: AbortSignal; }
export interface ReconciliationRecoveryContext extends ReconciliationReadContext { readonly permit?: SideEffectPermit; }
export interface ReadOnlyReconciliationPort<T = unknown> { observe(context: ReconciliationReadContext): Promise<ProviderObservation<T>>; }
export interface PermitSideEffectPort {
  readonly provider: ReconciliationProvider;
  recover(context: ReconciliationRecoveryContext): Promise<void>;
}
export interface LinearReconciliationPort extends ReadOnlyReconciliationPort { readonly provider: "linear"; }
export interface SandboxReconciliationPort extends ReadOnlyReconciliationPort { readonly provider: "sandbox"; }
export interface HerdrReconciliationPort extends ReadOnlyReconciliationPort { readonly provider: "herdr"; }
export interface ProcessReconciliationPort extends ReadOnlyReconciliationPort { readonly provider: "process"; }
export interface GitReconciliationPort extends ReadOnlyReconciliationPort<GitWorkspaceRecord | unknown> { readonly provider: "git"; }
export interface GithubReconciliationPort extends ReadOnlyReconciliationPort { readonly provider: "github"; }
export interface ReconciliationProviders {
  readonly linear: LinearReconciliationPort;
  readonly sandbox: SandboxReconciliationPort;
  readonly herdr: HerdrReconciliationPort;
  readonly process: ProcessReconciliationPort;
  readonly git: GitReconciliationPort;
  readonly github: GithubReconciliationPort;
}
export interface LinearMutationPort { setState(issueId: string, stateId: string, permit: SideEffectPermit): Promise<void>; }
export interface ResourceMutationRequest { readonly runId: string; readonly deterministicKey: string; readonly deterministicName: string; readonly operationGeneration: number; readonly externalId?: string; readonly metadata: Readonly<Record<string, unknown>>; }
export interface ResourceDeletionRequest { readonly runId: string; readonly deterministicKey: string; readonly externalId: string; readonly operationGeneration: number; }
export interface SandboxMutationPort { createOrAdopt(input: ResourceMutationRequest, permit: SideEffectPermit): Promise<Readonly<Record<string, unknown>>>; delete(input: ResourceDeletionRequest, permit: SideEffectPermit): Promise<void>; }
export interface HerdrMutationPort { createOrAdopt(input: ResourceMutationRequest & { readonly role: "orchestrator" | "plan" | "implement" | "review" | "test" }, permit: SideEffectPermit): Promise<Readonly<Record<string, unknown>>>; delete(input: ResourceDeletionRequest & { readonly role: "orchestrator" | "plan" | "implement" | "review" | "test" }, permit: SideEffectPermit): Promise<void>; }
export interface ProcessRecoveryPort { terminateExact(runId: string, identity: string, permit: SideEffectPermit): Promise<void>; }
export interface GitRecoveryRequest { readonly runId: string; readonly specFingerprint: string; readonly operationId: string; readonly expectedHead?: string; }
export interface GitRecoveryPort { recoverExact(input: GitRecoveryRequest, permit: SideEffectPermit): Promise<void>; }
export interface GithubObservationPort extends GithubReconciliationPort {}
/** Strict future-ticket seams. These declarations intentionally have no default
 * adapters or implementations in AIDEV-224. */
export interface PublicationPort { publish(input: { readonly runId: string; readonly repository: string; readonly featureBranch: string; readonly bundlePath: string; readonly bundleDigest: string }, permit: SideEffectPermit): Promise<{ readonly deliveryId: string }>; }
export interface ApprovalObservationPort { observe(input: { readonly runId: string; readonly repository: string; readonly featureBranch: string }, permit: SideEffectPermit): Promise<{ readonly observedHead: string; readonly approved: boolean; readonly observationId: string }>; }
export interface OperatorControlPort { resolve(input: { readonly runId: string; readonly errorId: string; readonly expectedVersion: number; readonly actionId: string }, permit: SideEffectPermit): Promise<void>; }

export function assertCompleteObservation<T>(observation: ProviderObservation<T>, provider: ReconciliationProvider): asserts observation is BoundedObservation<T> {
  if (observation.provider !== provider) throw new Error(`reconciliation provider identity mismatch: ${provider}`);
  if (!observation.complete || typeof observation.observationToken !== "string" || observation.observationToken.length === 0 || observation.observationToken.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(observation.observationToken) || typeof observation.digest !== "string" || !/^[0-9a-f]{64}$/u.test(observation.digest) || typeof observation.observedAt !== "string" || !Number.isFinite(Date.parse(observation.observedAt)) || !Array.isArray(observation.items)) throw new Error(`${provider} inventory is incomplete or unbounded`);
  if (observation.items.length > 100_000 || observation.conflicts !== undefined && (!Array.isArray(observation.conflicts) || observation.conflicts.length > 1_000 || observation.conflicts.some(conflict => typeof conflict !== "string" || conflict.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(conflict)))) throw new Error(`${provider} inventory exceeds its bound`);
}
