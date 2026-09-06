import { createHash } from "node:crypto";
import type { ReconciliationStatus, RunSnapshot, SideEffectPermit } from "../control/domain.js";
import { StoreConflictError } from "../control/workflow-store.js";
import { SqliteIntakeStore, type ControllerLease, type ReconciliationObservationRecord } from "../sqlite/sqlite-intake-store.js";
import { assertCompleteObservation, RECONCILIATION_PROVIDERS, type BoundedObservation, type ProviderObservation, type ReconciliationProvider, type ReconciliationProviders, type ReconciliationReadContext } from "./ports.js";
import { ReconciledSideEffectGate } from "./side-effect-gate.js";
import { validatePublishedNormalizedTicket } from "../intake/normalized-ticket-artifact.js";
import type { NormalizedTicketArtifactWriter } from "../intake/domain.js";

export interface StartupReconcilerOptions { readonly ledger: SqliteIntakeStore; readonly providers: ReconciliationProviders; readonly gate?: ReconciledSideEffectGate; readonly clock?: { now(): number }; readonly controllerOwner: string; readonly leaseMs?: number; readonly maxItems?: number; readonly maxDurationMs?: number; readonly artifactVerifier?: (run: RunSnapshot) => Promise<void>; readonly artifactWriter?: NormalizedTicketArtifactWriter; }
export interface StartupReconciliationResult { readonly status: "ready" | "blocked"; readonly generation: number; readonly observations: Readonly<Record<ReconciliationProvider, ProviderObservation>>; readonly permits: readonly SideEffectPermit[]; readonly blockingErrorId?: string; }

/** Mandatory two-pass startup barrier.  It deliberately has no successful
 * default when a provider is absent or only partially inventories its state. */
export class StartupReconciler {
  readonly #ledger: SqliteIntakeStore;
  readonly #providers: ReconciliationProviders;
  readonly #gate: ReconciledSideEffectGate;
  readonly #clock: { now(): number };
  readonly #owner: string;
  readonly #leaseMs: number;
  readonly #maxItems: number;
  readonly #maxDurationMs: number;
  readonly #artifactVerifier: ((run: RunSnapshot) => Promise<void>) | undefined;
  constructor(options: StartupReconcilerOptions) {
    this.#ledger = options.ledger; this.#providers = options.providers; this.#gate = options.gate ?? new ReconciledSideEffectGate(); this.#clock = options.clock ?? { now: () => Date.now() }; this.#owner = boundedOwner(options.controllerOwner); this.#leaseMs = boundedPositive(options.leaseMs ?? 30_000, 86_400_000); this.#artifactVerifier = options.artifactVerifier ?? (options.artifactWriter ? async run => { const reference = run.identity!.normalizedTicket; const verified = await validatePublishedNormalizedTicket(reference, options.artifactWriter!); if (verified.document.runId !== run.runId || verified.document.ticket.id !== run.identity!.linearIssueId || verified.document.ticket.identifier !== run.identity!.linearIdentifier || verified.document.ticket.teamId !== run.identity!.linearTeamId || verified.document.ticket.stateId !== run.identity!.linearStateId || verified.document.repository.owner !== run.identity!.repositoryOwner || verified.document.repository.name !== run.identity!.repositoryName || verified.document.repository.baseBranch !== run.identity!.baseBranch || verified.document.repository.baseSha !== run.identity!.baseSha || verified.document.repository.featureBranch !== run.identity!.contractFeatureBranch) throw new StoreConflictError("normalized-ticket artifact derivation disagrees with the durable run identity"); } : undefined); this.#maxItems = boundedPositive(options.maxItems ?? 100_000, 100_000); this.#maxDurationMs = boundedPositive(options.maxDurationMs ?? 60_000, 600_000);
    for (const provider of RECONCILIATION_PROVIDERS) if (!this.#providers[provider] || typeof this.#providers[provider].observe !== "function") throw new StoreConflictError(`reconciliation requires a concrete ${provider} observation port`);
  }
  get gate(): ReconciledSideEffectGate { return this.#gate; }

  async reconcile(signal?: AbortSignal): Promise<StartupReconciliationResult> {
    this.#gate.invalidate();
    const now = this.#clock.now();
    const lease = this.#ledger.acquireControllerLease(this.#owner, now, this.#leaseMs);
    if (!lease) throw new StoreConflictError("another controller owns the startup reconciliation lease");
    const startedAt = new Date(now).toISOString();
    this.#ledger.beginReconciliation(lease, startedAt);
    const ledgerIssue = this.#ledger.validateLedgerConsistency();
    if (ledgerIssue) return this.#blocked(lease, {} as Readonly<Record<ReconciliationProvider, ProviderObservation>>, ledgerIssue, startedAt);
    const runs = this.#ledger.listRunsForReconciliation();
    const artifactIssue = await this.#validateArtifacts(runs);
    if (artifactIssue) return this.#blocked(lease, {} as Readonly<Record<ReconciliationProvider, ProviderObservation>>, artifactIssue, startedAt);
    const context: ReconciliationReadContext = { generation: lease.generation, controllerOwner: lease.owner, fencingToken: lease.fencingToken, runIds: runs.map(run => run.runId), maxItems: this.#maxItems, ...(signal ? { signal } : {}) };
    const first = await this.#observeAll(lease, context);
    const firstComplete = await this.#persistObservations(lease, first, startedAt);
    if (!firstComplete.ok) return this.#blocked(lease, first, firstComplete.reason, startedAt);
    const firstResourceIssue = resourceCoverageIssue(runs, first);
    if (firstResourceIssue) return this.#blocked(lease, first, firstResourceIssue, startedAt);
    if (this.#ledger.hasUnresolvedGlobalSecurityErrors()) return this.#blocked(lease, first, "unresolved global security operator error remains", startedAt);
    for (const run of runs) if (run.operatorBlocked && !this.#ledger.hasUnresolvedOperatorErrors(run.runId)) this.#ledger.clearOperatorBlockAfterReconciliation(run.runId, new Date(this.#clock.now()).toISOString());
    const initiallyBlocked = this.#ledger.listRunsForReconciliation().find(run => run.operatorBlocked === true);
    if (initiallyBlocked) return this.#blocked(lease, first, `run ${initiallyBlocked.runId} remains operator blocked`, startedAt);
    if (!this.#leaseStillOwned(lease)) return this.#blocked(lease, first, "controller lease expired during initial observation", startedAt);
    await this.#annotateRuns(runs, { generation: lease.generation, status: "recovering", controllerOwner: lease.owner, fencingToken: lease.fencingToken, startedAt });
    // Recovery is deliberately after every first-pass observation has been
    // committed. A provider may only perform its exact, idempotent recovery
    // seam; no generic create/adopt fallback is installed here.
    for (const providerName of RECONCILIATION_PROVIDERS) {
      const provider = this.#providers[providerName];
      if ("recover" in provider && typeof provider.recover === "function") await provider.recover({ ...context });
      if (!this.#leaseStillOwned(lease)) return this.#blocked(lease, first, "controller lease was fenced during recovery", startedAt);
    }
    const secondContext: ReconciliationReadContext = { ...context };
    const second = await this.#observeAll(lease, secondContext);
    const secondComplete = await this.#persistObservations(lease, second, new Date(this.#clock.now()).toISOString());
    if (!secondComplete.ok) return this.#blocked(lease, second, secondComplete.reason, startedAt);
    const secondResourceIssue = resourceCoverageIssue(this.#ledger.listRunsForReconciliation(), second);
    if (secondResourceIssue) return this.#blocked(lease, second, secondResourceIssue, startedAt);
    const unstable = RECONCILIATION_PROVIDERS.find(provider => first[provider].complete && second[provider].complete && (first[provider].observationToken !== second[provider].observationToken || first[provider].digest !== second[provider].digest));
    if (unstable) return this.#blocked(lease, second, `${unstable} inventory changed between reconciliation passes`, startedAt);
    if (!this.#leaseStillOwned(lease)) return this.#blocked(lease, second, "controller lease expired before ready commit", startedAt);
    this.#ledger.resolveReconciliationBlockErrors(new Date(this.#clock.now()).toISOString());
    for (const run of this.#ledger.listNonterminalRuns()) if (run.operatorBlocked) this.#ledger.clearOperatorBlockAfterReconciliation(run.runId, new Date(this.#clock.now()).toISOString());
    if (this.#ledger.hasUnresolvedGlobalOperatorErrors()) return this.#blocked(lease, second, "unresolved global operator error remains", startedAt);
    const blockedRun = this.#ledger.listNonterminalRuns().find(run => run.operatorBlocked === true);
    if (blockedRun) return this.#blocked(lease, second, `run ${blockedRun.runId} remains operator blocked`, startedAt);
    const completedAt = new Date(this.#clock.now()).toISOString();
    this.#ledger.finishReconciliation(lease, "ready", completedAt, undefined, this.#clock.now());
    await this.#annotateRuns(this.#ledger.listNonterminalRuns(), { generation: lease.generation, status: "ready", controllerOwner: lease.owner, fencingToken: lease.fencingToken, startedAt, completedAt });
    this.#gate.setAuthority(() => this.#ledger.controllerLeaseIsCurrent(lease.owner, lease.fencingToken, lease.generation, this.#clock.now()));
    const readyRuns = this.#ledger.listRunsForReconciliation().filter(run => !run.operatorBlocked);
    this.#gate.open({ generation: lease.generation, controllerOwner: lease.owner, fencingToken: lease.fencingToken, issuedAt: this.#clock.now(), databaseIdentity: this.#ledger.database.identity, runIds: new Set(readyRuns.map(run => run.runId)) });
    const permits = readyRuns.map(run => this.#gate.require(run.runId));
    return { status: "ready", generation: lease.generation, observations: second, permits };
  }
  start(signal?: AbortSignal): Promise<StartupReconciliationResult> { return this.reconcile(signal); }

  async #validateArtifacts(runs: readonly RunSnapshot[]): Promise<string | undefined> {
    for (const run of runs) {
      if (!run.identity) continue;
      if (!this.#artifactVerifier) return `normalized-ticket artifact verifier is not configured for run ${run.runId}`;
      try { await withTimeout(this.#artifactVerifier(run), this.#maxDurationMs); } catch (error) { return `normalized-ticket artifact for run ${run.runId} failed exact verification: ${boundedError(error)}`; }
    }
    return undefined;
  }
  async #observeAll(lease: ControllerLease, context: ReconciliationReadContext): Promise<Readonly<Record<ReconciliationProvider, ProviderObservation>>> {
    const entries = await Promise.all(RECONCILIATION_PROVIDERS.map(async providerName => {
      try {
        const observed = await withTimeout(this.#providers[providerName].observe(context), this.#maxDurationMs);
        return [providerName, normalizeObservation(providerName, observed, this.#maxItems)] as const;
      } catch (error) {
        return [providerName, { provider: providerName, complete: false, observedAt: new Date(this.#clock.now()).toISOString(), error: boundedError(error) } satisfies ProviderObservation] as const;
      }
    }));
    return Object.fromEntries(entries) as Readonly<Record<ReconciliationProvider, ProviderObservation>>;
  }
  async #persistObservations(lease: ControllerLease, observations: Readonly<Record<ReconciliationProvider, ProviderObservation>>, observedAt: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    let failure: string | undefined;
    for (const provider of RECONCILIATION_PROVIDERS) {
      const observation = observations[provider];
      const record: ReconciliationObservationRecord = { provider, ...(observation.observationToken ? { observationToken: observation.observationToken } : {}), ...(observation.digest ? { digest: observation.digest } : {}), complete: observation.complete, observedAt: observation.observedAt || observedAt, payload: observation };
      try { this.#ledger.recordReconciliationObservation(lease, record, this.#clock.now()); } catch (error) { failure ??= `${provider} observation could not be persisted: ${boundedError(error)}`; }
      if (!observation.complete) failure ??= `${provider} inventory was incomplete: ${"error" in observation ? observation.error : "unknown"}`;
      if (observation.complete && observation.conflicts?.length) failure ??= `${provider} inventory reported an identity conflict`;
    }
    return failure ? { ok: false, reason: failure } : { ok: true };
  }
  async #annotateRuns(runs: readonly RunSnapshot[], status: ReconciliationStatus): Promise<void> {
    for (const run of runs) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await this.#ledger.workflow.read(run.runId); if (!current) break;
        try { await this.#ledger.workflow.compareAndSet(run.runId, { version: current.version, state: current.state, currentHead: current.currentHead }, snapshot => ({ ...snapshot, version: snapshot.version + 1, reconciliation: status })); break; }
        catch (error) { if (!(error instanceof StoreConflictError)) throw error; }
      }
    }
  }
  #leaseStillOwned(lease: ControllerLease): boolean { return Boolean(this.#ledger.renewControllerLease(lease, this.#clock.now(), this.#leaseMs)); }
  async #blocked(lease: ControllerLease, observations: Readonly<Record<ReconciliationProvider, ProviderObservation>>, reason: string, startedAt: string): Promise<StartupReconciliationResult> {
    void startedAt;
    const now = new Date(this.#clock.now()).toISOString();
    const error = this.#ledger.recordOperatorError({ code: "reconciliation_blocked", message: reason, component: "startup-reconciler", retryable: true, operatorActionRequired: true, evidence: [], now });
    for (const run of this.#ledger.listNonterminalRuns()) this.#ledger.recordOperatorError({ runId: run.runId, code: "reconciliation_blocked", message: reason, component: "startup-reconciler", retryable: true, operatorActionRequired: true, evidence: [], now });
    this.#ledger.finishReconciliation(lease, "blocked", new Date(this.#clock.now()).toISOString(), error.errorId, this.#clock.now());
    this.#gate.invalidate();
    return { status: "blocked", generation: lease.generation, observations, permits: [], blockingErrorId: error.errorId };
  }
}
export const StartupReconciliationService = StartupReconciler;

function normalizeObservation(provider: ReconciliationProvider, value: ProviderObservation, maxItems: number): ProviderObservation {
  if (!value || typeof value !== "object") return { provider, complete: false, observedAt: new Date().toISOString(), error: "provider returned no observation" };
  const observation = { ...value, provider } as ProviderObservation;
  if (typeof observation.observedAt !== "string" || observation.observedAt.length > 64 || !Number.isFinite(Date.parse(observation.observedAt))) return { provider, complete: false, observedAt: new Date().toISOString(), error: "provider returned an invalid observation timestamp" };
  if (observation.complete) {
    assertCompleteObservation(observation, provider);
    if (observation.items.length > maxItems) throw new Error("provider inventory exceeds the configured bound");
    return observation;
  }
  if (observation.items && observation.items.length > maxItems) return { provider, complete: false, observedAt: observation.observedAt, error: "provider inventory exceeds the configured bound" };
  if (observation.observationToken !== undefined && (typeof observation.observationToken !== "string" || observation.observationToken.length > 512 || /[\u0000-\u001f\u007f\r\n]/u.test(observation.observationToken))) return { provider, complete: false, observedAt: observation.observedAt, error: "provider returned an invalid observation token" };
  if (observation.digest !== undefined && (typeof observation.digest !== "string" || !/^[0-9a-f]{64}$/u.test(observation.digest))) return { provider, complete: false, observedAt: observation.observedAt, error: "provider returned an invalid observation digest" };
  if (typeof observation.error !== "string" || observation.error.length > 512) return { provider, complete: false, observedAt: observation.observedAt, error: "provider returned an invalid bounded error" };
  return observation;
}
function boundedOwner(value: string): string { if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f\r\n]/u.test(value)) throw new StoreConflictError("controller owner is invalid"); return value; }
function boundedPositive(value: number, maximum: number): number { if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new StoreConflictError("reconciliation bound is invalid"); return value; }
function boundedError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 512); }
function resourceCoverageIssue(runs: readonly RunSnapshot[], observations: Readonly<Record<ReconciliationProvider, ProviderObservation>>): string | undefined {
  for (const run of runs) for (const resource of run.resources ?? []) {
    if (resource.state === "deleted") continue;
    const provider = providerForResource(resource.kind);
    if (!provider) continue;
    if (resource.state === "planned" && !resource.externalId) continue;
    const observation = observations[provider];
    if (!observation.complete) continue;
    const candidates = observation.items.filter(item => isResourceCandidate(item, resource, run.runId));
    if (candidates.length !== 1) return `${provider} resource ${resource.deterministicKey} is missing, duplicated, or ambiguous after a persisted intent for run ${run.runId}`;
    const candidate = candidates[0]!;
    const candidateId = resourceId(candidate);
    if (resource.externalId && candidateId !== resource.externalId) return `${provider} resource ${resource.deterministicKey} has a conflicting external identity`;
  }
  return undefined;
}
function providerForResource(kind: NonNullable<RunSnapshot["resources"]>[number]["kind"]): ReconciliationProvider | undefined { if (kind === "linear_issue") return "linear"; if (kind === "sandbox") return "sandbox"; if (kind.startsWith("herdr_")) return "herdr"; if (kind === "pi_session") return "process"; if (kind.startsWith("git_")) return "git"; if (kind === "github_pr") return "github"; return undefined; }
function isResourceCandidate(value: unknown, resource: NonNullable<RunSnapshot["resources"]>[number], runId: string): boolean { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const item = value as Record<string, unknown>; const kind = item["kind"] ?? item["resourceKind"]; const observedRunId = item["runId"]; const scope = item["scope"]; const key = item["deterministicKey"]; const name = item["deterministicName"]; const id = item["externalId"] ?? item["id"]; if (typeof id !== "string" || id.length < 1 || id.length > 512) return false; if (observedRunId !== undefined && observedRunId !== runId && observedRunId !== undefined) return false; if (kind !== undefined && kind !== resource.kind) return false; if (scope !== undefined && scope !== resource.scope) return false; if (key !== undefined && key !== resource.deterministicKey) return false; if (name !== undefined && name !== resource.deterministicName) return false; return id === resource.externalId || key === resource.deterministicKey || name === resource.deterministicName; }
function resourceId(value: unknown): string | undefined { if (!value || typeof value !== "object" || Array.isArray(value)) return undefined; const item = value as Record<string, unknown>; const id = item["externalId"] ?? item["id"]; return typeof id === "string" ? id : undefined; }
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> { let timer: NodeJS.Timeout | undefined; try { return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("provider observation timed out")), timeoutMs); })]); } finally { if (timer) clearTimeout(timer); } }
void createHash;
