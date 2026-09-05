import { randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Clock, Lease, LeaseGuard, RunSnapshot, RunTerminalFence } from "../control/domain.js";
import type { WorkflowStore } from "../control/workflow-store.js";
import { assertSandboxSemantics, SandboxContractError } from "./contracts.js";
import type { BridgeManager, BridgeRecord } from "./bridge-manager.js";
import type { MeasuredSandboxEvidence, SandboxAttestorPort } from "./attestation.js";
import type { ResolvedSandboxRelease, SandboxReleaseResolver } from "./release-resolver.js";
import type { SandboxDriver } from "./sbx-v039-driver.js";
import type { SbxObservedSandbox } from "./sbx-command.js";
import { assertSandboxRecordMutation } from "./sandbox-record-guard.js";
import type { SandboxIdentityManifest, SandboxLifecycleResult, SandboxNetworkSpec, SandboxRecord, SandboxResourceSpec, SandboxRetentionSpec, SandboxSpecDocument, SandboxOperation, SandboxOperationKind, SandboxOperationIntent } from "./domain.js";
import { assertDigestReference, assertSandboxName, assertSandboxRunId, assertSha256, buildSandboxSpec, canonicalBytes, canonicalJson, deriveBridgeName, deriveSandboxName, sha256Bytes } from "./identity.js";
import { readExactNoFollow, writeExclusiveFile } from "../git/paths.js";

export interface SandboxCreateRequest {
  readonly runId: string;
  readonly ticketIdentifier: string;
  readonly templateName: string;
  readonly templateDigest: string;
  readonly resources?: SandboxResourceSpec;
  readonly network: Omit<SandboxNetworkSpec, "profileDigest"> & { readonly profileDigest?: string };
  readonly retention: SandboxRetentionSpec;
  readonly creationNonce?: string;
  readonly platform?: string;
  readonly architecture?: string;
}
export interface SandboxLifecycleOptions {
  readonly store: WorkflowStore;
  readonly releaseResolver: SandboxReleaseResolver;
  readonly driver: SandboxDriver;
  readonly bridge: BridgeManager;
  readonly attestor: SandboxAttestorPort;
  /** Supplies measured guest plus independent host evidence; it cannot be
   * replaced by a boolean or a guest-only claim. */
  readonly evidence: (context: { readonly runId: string; readonly record: SandboxRecord; readonly signal?: AbortSignal }) => Promise<MeasuredSandboxEvidence>;
  readonly clock: Clock;
  readonly controllerDataRoot: string;
  readonly operationLeaseMs?: number;
  readonly operationTimeoutMs?: number;
}
export interface SandboxRemovalOptions { readonly fence: RunTerminalFence; readonly writersStopped: boolean; readonly signal?: AbortSignal }
export type SandboxLifecyclePort = Pick<SandboxLifecycleService, "create" | "start" | "stop" | "reconcile" | "retain" | "remove">;

export class SandboxLifecycleError extends Error {
  constructor(message: string) { super(message); this.name = "SandboxLifecycleError"; }
}

/** Durable one-sandbox lifecycle. Every mutating command is represented in the
 * RunSnapshot before its side effect and is accepted only after exact identity
 * observation. */
export class SandboxLifecycleService {
  readonly #store: WorkflowStore;
  readonly #resolver: SandboxReleaseResolver;
  readonly #driver: SandboxDriver;
  readonly #bridge: BridgeManager;
  readonly #attestor: SandboxAttestorPort;
  readonly #evidence: SandboxLifecycleOptions["evidence"];
  readonly #clock: Clock;
  readonly #root: string;
  readonly #leaseMs: number;
  readonly #timeoutMs: number;
  constructor(options: SandboxLifecycleOptions) {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new SandboxLifecycleError("sandbox lifecycle options are required");
    if (!path.isAbsolute(options.controllerDataRoot) || path.resolve(options.controllerDataRoot) !== options.controllerDataRoot || options.controllerDataRoot.includes("\0") || options.controllerDataRoot.endsWith(path.sep) || path.parse(options.controllerDataRoot).root === options.controllerDataRoot) throw new SandboxLifecycleError("sandbox controller data root is not canonical");
    if (!options.store || typeof options.store.read !== "function" || typeof options.store.acquireLease !== "function" || typeof options.store.renewLease !== "function" || typeof options.store.releaseLease !== "function" || typeof options.store.compareAndSetFenced !== "function" || !options.releaseResolver || typeof options.releaseResolver.resolve !== "function" || !options.driver || typeof options.driver.inspect !== "function" || typeof options.driver.create !== "function" || typeof options.driver.start !== "function" || typeof options.driver.stop !== "function" || typeof options.driver.remove !== "function" || !options.bridge || typeof options.bridge.read !== "function" || typeof options.bridge.create !== "function" || typeof options.bridge.assertEmpty !== "function" || typeof options.bridge.quarantineAndRemove !== "function" || !options.attestor || typeof options.attestor.attest !== "function" || typeof options.evidence !== "function" || !options.clock || typeof options.clock.now !== "function") throw new SandboxLifecycleError("sandbox lifecycle requires every trusted authority and a resolver-verified release");
    this.#store = options.store; this.#resolver = options.releaseResolver; this.#driver = options.driver; this.#bridge = options.bridge; this.#attestor = options.attestor; this.#evidence = options.evidence; this.#clock = options.clock; this.#root = options.controllerDataRoot; this.#leaseMs = positive(options.operationLeaseMs ?? 30_000, "sandbox operation lease"); this.#timeoutMs = positive(options.operationTimeoutMs ?? 30_000, "sandbox operation timeout");
  }

  async create(request: SandboxCreateRequest, signal?: AbortSignal): Promise<SandboxLifecycleResult> {
    assertCreateRequestShape(request);
    assertSandboxRunId(request.runId);
    const release = await this.#resolver.resolve({ templateName: request.templateName, templateDigest: request.templateDigest, ...(request.resources ? { resources: request.resources } : {}), ...(request.network.profileDigest ? { networkProfileDigest: request.network.profileDigest } : {}), ...(request.platform ? { platform: request.platform } : {}), ...(request.architecture ? { architecture: request.architecture } : {}) });
    const resources = request.resources ?? release.resourceTuple;
    if (!sameResourceTuple(resources, release.resourceTuple)) throw new SandboxLifecycleError("sandbox resource request is not the externally proven release tuple");
    if (release.release.releaseId !== this.#driver.release.release.releaseId || release.templateReference !== this.#driver.release.templateReference || release.sbxExecutable !== this.#driver.release.sbxExecutable || canonicalJson(release.resourceTuple) !== canonicalJson(this.#driver.release.resourceTuple)) throw new SandboxLifecycleError("sandbox driver is bound to a different resolved release or resource tuple");
    if (release.release.bridgeQuotaBytes !== release.resourceTuple.disk.bridgeQuotaBytes && release.resourceTuple.disk.enforcement === "quota-composed") throw new SandboxLifecycleError("release bridge quota does not match its proven resource tuple");
    const spec = buildSandboxSpec({ runId: request.runId, ticketIdentifier: request.ticketIdentifier, template: { name: request.templateName, digest: request.templateDigest, reference: release.templateReference }, resources, network: request.network, bridgeQuotaBytes: release.release.bridgeQuotaBytes, retention: request.retention, ...(request.creationNonce ? { creationNonce: request.creationNonce } : {}) });
    if (spec.network.profileDigest !== release.release.networkProfileDigest) throw new SandboxLifecycleError("sandbox network policy is not the resolved release policy");
    return this.#withLease(request.runId, async (owner, lease, operationSignal) => {
      try {
      // A retry resumes the immutable first spec instead of generating a new
      // nonce/retention document for the same run.
      const existing = await this.#store.read(request.runId);
      if (existing?.sandbox) {
        const persisted = await this.#readSpec(existing.sandbox);
        assertCreateRequestMatchesPersisted(request, persisted);
        return this.#createUnderLease(persisted, existing.sandbox.spec, release, owner, lease, operationSignal);
      }
      // Publishing the immutable spec is the first side effect and therefore
      // occurs only after the shared drain/lease gate has admitted the run.
      const specReference = await this.#writeLedgerContract(request.runId, "spec", "artifacts", spec, "urn:squire:sandbox:v1:sandbox-spec");
      return this.#createUnderLease(spec, specReference, release, owner, lease, operationSignal);
      } catch (error) {
        await this.#blockCurrent(request.runId, lease, error);
        throw asLifecycleError(error);
      }
    }, signal);
  }

  async start(runId: string, signal?: AbortSignal): Promise<SandboxLifecycleResult> {
    assertSandboxRunId(runId);
    return this.#withLease(runId, async (owner, lease, operationSignal) => {
      try { return await this.#startUnderLease(runId, owner, lease, operationSignal); }
      catch (error) { await this.#blockCurrent(runId, lease, error); throw asLifecycleError(error); }
    }, signal);
  }

  async stop(runId: string, signal?: AbortSignal): Promise<SandboxLifecycleResult> {
    assertSandboxRunId(runId);
    return this.#withLease(runId, async (owner, lease, operationSignal) => {
      let record: SandboxRecord | undefined;
      try {
        record = await this.#requireRecord(runId);
        if (record.lifecycle === "stopped" || record.lifecycle === "created" || record.lifecycle === "retained") return { runId, sandbox: record };
        if (record.lifecycle !== "ready") throw new SandboxLifecycleError(`sandbox cannot stop from ${record.lifecycle}`);
        record = await this.#transition(runId, record, "stopping", this.#operation(owner, lease.fencingToken, "stop", "stop", record.operationGeneration + 1), {}, lease);
        const observed = await this.#requireObserved(record, operationSignal);
        const stopped = observed.status === "running" ? await this.#driver.stop(observed, operationSignal) : observed;
        if (stopped.status !== "stopped" && stopped.status !== "created") throw new SandboxLifecycleError("exact sandbox stop was not observed");
        record = await this.#transition(runId, record, "stopped", undefined, {}, lease);
        return { runId, sandbox: record };
      } catch (error) { await this.#blockCurrent(runId, lease, error, record); throw asLifecycleError(error); }
    }, signal);
  }

  async reconcile(runId: string, signal?: AbortSignal): Promise<SandboxLifecycleResult | undefined> {
    assertSandboxRunId(runId);
    return this.#withLease(runId, async (owner, lease, operationSignal) => {
      let record: SandboxRecord | undefined;
      try {
      record = await this.#requireRecord(runId);
      if (record.lifecycle === "removed") return { runId, sandbox: record };
      if (record.lifecycle === "blocked") throw new SandboxLifecycleError("blocked sandbox requires operator identity review");
      const observed = await this.#driver.inspect(record.sandboxName, operationSignal);
      if (!observed) {
        if (record.lifecycle === "creating" && record.operation?.intent === "create") {
          const spec = await this.#readSpec(record);
          const bridge = await this.#bridge.read(runId);
          if (!bridge) throw new SandboxLifecycleError("sandbox create intent has no exact bridge to retry");
          this.#assertBridge(spec, bridge);
          const created = await this.#driver.create(spec, bridge.path, operationSignal);
          if (created.status === "unknown" || (created.status !== "created" && created.status !== "stopped" && created.status !== "running") || created.name !== spec.sandboxName || created.templateDigest !== spec.template.digest || !created.id || !created.vmId) throw new SandboxLifecycleError("sandbox create retry returned an unrecognized identity");
          const next = await this.#transition(runId, record, "created", undefined, { identity: this.#identityManifest(spec, created, bridge, record.operationGeneration + 1), ...(created.bootId ? { bootId: created.bootId } : {}) }, lease);
          if (created.status !== "running") return { runId, sandbox: next };
          return this.#startFromObserved(runId, next, created, owner, lease, operationSignal);
        }
        throw new SandboxLifecycleError("exact sandbox is absent or its state is unknown");
      }
      this.#assertObserved(record, observed);
      if (record.lifecycle === "creating" && (observed.status === "created" || observed.status === "stopped" || observed.status === "running")) {
        if (!record.identity) throw new SandboxLifecycleError("same-name sandbox cannot be adopted without a persisted exact identity");
        const bridge = await this.#bridge.read(runId); if (!bridge) throw new SandboxLifecycleError("matching sandbox has no exact bridge metadata");
        const spec = await this.#readSpec(record);
        this.#assertBridge(spec, bridge);
        const next = await this.#transition(runId, record, "created", undefined, { identity: this.#identityManifest(spec, observed, bridge, record.operationGeneration + 1), ...(observed.bootId ? { bootId: observed.bootId } : {}) }, lease);
        if (observed.status !== "running") return { runId, sandbox: next };
        return this.#startFromObserved(runId, next, observed, owner, lease, operationSignal);
      }
      if (record.lifecycle === "starting" || record.lifecycle === "attesting" || record.lifecycle === "ready") return this.#startFromObserved(runId, record, observed, owner, lease, operationSignal);
      if (observed.status === "running" && (record.lifecycle === "created" || record.lifecycle === "stopped" || record.lifecycle === "retained")) return this.#startFromObserved(runId, record, observed, owner, lease, operationSignal);
      if (observed.status === "stopped" && record.lifecycle === "stopping") return { runId, sandbox: await this.#transition(runId, record, "stopped", undefined, {}, lease) };
      if ((observed.status === "created" && record.lifecycle === "created") || (observed.status === "stopped" && (record.lifecycle === "stopped" || record.lifecycle === "retained"))) return { runId, sandbox: record };
      throw new SandboxLifecycleError("sandbox lifecycle and exact observed state cannot be reconciled safely");
      } catch (error) { await this.#blockCurrent(runId, lease, error, record); throw asLifecycleError(error); }
    }, signal);
  }

  async retain(runId: string, outcome: "success" | "failure", signal?: AbortSignal): Promise<SandboxLifecycleResult> {
    assertSandboxRunId(runId);
    if (outcome !== "success" && outcome !== "failure") throw new SandboxLifecycleError("sandbox retention outcome is not allowlisted");
    return this.#withLease(runId, async (owner, lease, operationSignal) => {
      let current: SandboxRecord | undefined;
      try {
        if (operationSignal.aborted) throw new SandboxLifecycleError("sandbox retention was aborted");
        current = await this.#requireRecord(runId);
        if (current.lifecycle === "retained") return { runId, sandbox: current };
        if (current.lifecycle !== "ready" && current.lifecycle !== "stopped" && current.lifecycle !== "created") throw new SandboxLifecycleError(`sandbox cannot enter retention from ${current.lifecycle}`);
        const spec = await this.#readSpec(current);
        const retainUntil = outcome === "success" ? spec.retention.successUntil : spec.retention.failureUntil;
        const next = await this.#transition(runId, current, "retained", undefined, { retention: { outcome, retainUntil, artifactUntil: spec.retention.artifactUntil } }, lease);
        void owner;
        return { runId, sandbox: next };
      } catch (error) { await this.#blockCurrent(runId, lease, error, current); throw asLifecycleError(error); }
    }, signal);
  }

  /** Removal is a component step, not the global completion operation. The
   * caller must already own the one terminal fence and must prove writers are
   * stopped; this method never calls completeRunTeardown. */
  async remove(runId: string, options: SandboxRemovalOptions): Promise<SandboxLifecycleResult> {
    assertSandboxRunId(runId);
    if (!options || typeof options !== "object" || Array.isArray(options) || !options.fence || typeof options.fence !== "object" || options.writersStopped !== true || options.fence.state !== "held") throw new SandboxLifecycleError("sandbox removal requires the held terminal fence and stopped writers");
    await this.#store.assertRunTeardownQuiescent(runId, options.fence, this.#clock.now());
    let record = await this.#requireRecord(runId);
    if (record.lifecycle === "removed") return { runId, sandbox: record };
    if (record.lifecycle === "blocked") throw new SandboxLifecycleError("blocked sandbox identity cannot be destructively removed");
    const removalWasAlreadyAttempted = record.lifecycle === "removing" && record.operation?.kind === "remove";
    record = await this.#transitionTeardown(runId, record, options.fence, "removing", this.#operation(options.fence.owner, options.fence.fencingToken, "remove", "remove", record.lifecycle === "removing" ? record.operationGeneration : record.operationGeneration + 1));
    try {
      const observed = await this.#observeRemovalTarget(record.sandboxName, options.signal);
      if (!observed && !removalWasAlreadyAttempted) throw new SandboxLifecycleError("exact sandbox was absent before a persisted removal attempt");
      if (observed) {
        this.#assertObserved(record, observed);
        const stopped = observed.status === "running" ? await this.#driver.stop(observed, options.signal) : observed;
        if (stopped.status === "running") throw new SandboxLifecycleError("sandbox remained running at exact removal boundary");
        await this.#driver.remove(stopped, options.signal);
        const residual = await this.#observeRemovalTarget(record.sandboxName, options.signal);
        if (residual) throw new SandboxLifecycleError("sandbox removal was not observed at the exact identity boundary");
      }
      await this.#store.assertRunTeardownQuiescent(runId, options.fence, this.#clock.now());
      await this.#bridge.quarantineAndRemove(runId, { writersStopped: true, ...(options.signal ? { signal: options.signal } : {}) });
      await this.#store.assertRunTeardownQuiescent(runId, options.fence, this.#clock.now());
      record = await this.#transitionTeardown(runId, record, options.fence, "removed", undefined);
      return { runId, sandbox: record };
    } catch (error) {
      await this.#markBlockedTeardown(runId, record, options.fence, error);
      throw error instanceof SandboxLifecycleError ? error : new SandboxLifecycleError(error instanceof Error ? error.message : String(error));
    }
  }

  async #createUnderLease(spec: SandboxSpecDocument, specReference: { path: string; sha256: string; schemaId: string }, release: ResolvedSandboxRelease, owner: string, lease: Lease, signal?: AbortSignal): Promise<SandboxLifecycleResult> {
    const existing = await this.#store.read(spec.runId);
    if (existing?.sandbox) {
      this.#assertRecordSpec(existing.sandbox, spec, release);
      if (existing.sandbox.lifecycle === "ready" || existing.sandbox.lifecycle === "created" || existing.sandbox.lifecycle === "stopped" || existing.sandbox.lifecycle === "retained") return { runId: spec.runId, sandbox: existing.sandbox };
      if (existing.sandbox.lifecycle === "blocked" || existing.sandbox.lifecycle === "removing" || existing.sandbox.lifecycle === "removed") throw new SandboxLifecycleError(`sandbox create cannot continue from ${existing.sandbox.lifecycle}`);
    }
    let record = existing?.sandbox;
    if (!record) {
      record = { runId: spec.runId, spec: specReference, specFingerprint: spec.fingerprint, templateDigest: spec.template.digest, sandboxName: spec.sandboxName, bridgeName: spec.bridge.name, releaseId: release.release.releaseId, lifecycle: "reserving", operationGeneration: 1, transferGeneration: 0 };
      await this.#insertRecord(spec.runId, record, lease);
    }
    record = await this.#transition(spec.runId, record, "creating", this.#operation(owner, lease.fencingToken, "create", "create", record.lifecycle === "creating" ? record.operationGeneration : record.operationGeneration + 1), {}, lease);
    let bridge: BridgeRecord | undefined;
    try {
      bridge = await this.#bridge.read(spec.runId) ?? await this.#bridge.create(spec.runId, spec.bridge.quotaBytes);
      this.#assertBridge(spec, bridge);
      await this.#bridge.assertEmpty(spec.runId);
      const preexisting = await this.#driver.inspect(spec.sandboxName, signal);
      if (preexisting) {
        if (!record.identity) throw new SandboxLifecycleError("deterministic sandbox name is occupied without a persisted exact identity");
        this.#assertObserved(record, preexisting);
      }
        const observed = preexisting ?? await this.#driver.create(spec, bridge.path, signal);
      if (observed.name !== spec.sandboxName || observed.templateDigest !== spec.template.digest || !observed.id || !observed.vmId || observed.status === "unknown" || (observed.status !== "created" && observed.status !== "stopped" && observed.status !== "running")) throw new SandboxLifecycleError("sandbox create returned an unrecognized or substituted identity");
      record = await this.#transition(spec.runId, record, "created", undefined, { identity: this.#identityManifest(spec, observed, bridge, record.operationGeneration + 1), ...(observed.bootId ? { bootId: observed.bootId } : {}) }, lease);
      return { runId: spec.runId, sandbox: record };
    } catch (error) {
      await this.#markBlocked(spec.runId, record, error, lease);
      throw error instanceof SandboxLifecycleError ? error : new SandboxLifecycleError(error instanceof Error ? error.message : String(error));
    }
  }

  async #startUnderLease(runId: string, owner: string, lease: Lease, signal?: AbortSignal): Promise<SandboxLifecycleResult> {
    const record = await this.#requireRecord(runId);
    if (record.lifecycle === "ready") {
      const observed = await this.#driver.inspect(record.sandboxName, signal); if (!observed) throw new SandboxLifecycleError("ready sandbox disappeared"); this.#assertObserved(record, observed); if (observed.status === "running" && observed.bootId === record.bootId) return this.#startFromObserved(runId, record, observed, owner, lease, signal); if (observed.status !== "running") return this.#startFromObserved(runId, record, observed, owner, lease, signal);
    }
    if (record.lifecycle !== "created" && record.lifecycle !== "stopped" && record.lifecycle !== "retained" && record.lifecycle !== "ready") throw new SandboxLifecycleError(`sandbox cannot start from ${record.lifecycle}`);
    const observed = await this.#driver.inspect(record.sandboxName, signal); if (!observed) throw new SandboxLifecycleError("sandbox identity is absent before start"); this.#assertObserved(record, observed);
    return this.#startFromObserved(runId, record, observed, owner, lease, signal);
  }

  async #startFromObserved(runId: string, initial: SandboxRecord, observed: SbxObservedSandbox, owner: string, lease: Lease, signal?: AbortSignal): Promise<SandboxLifecycleResult> {
    let record = initial;
    try {
    if (record.lifecycle === "starting") record = await this.#transition(runId, record, "starting", this.#operation(owner, lease.fencingToken, "start", "start", record.operationGeneration), {}, lease);
    else if (record.lifecycle === "attesting") record = await this.#transition(runId, record, "attesting", this.#operation(owner, lease.fencingToken, "attest", "attest", record.operationGeneration), {}, lease);
    else record = await this.#transition(runId, record, "starting", this.#operation(owner, lease.fencingToken, "start", "start", record.operationGeneration + 1), {}, lease);
    let running = observed.status === "running" ? observed : await this.#driver.start(observed, signal);
    if (running.status !== "running" || !running.bootId) throw new SandboxLifecycleError("sandbox start did not produce a running boot identity");
    const policy = await this.#driver.policy(signal);
    const specForPolicy = await this.#readSpec(record);
    if (policy.digest !== specForPolicy.network.profileDigest || policy.mode !== specForPolicy.network.mode || canonicalJson(policy.allowedHosts) !== canonicalJson(specForPolicy.network.allowedHosts) || policy.source !== "host") throw new SandboxLifecycleError("sandbox network policy is not the exact host-observed release policy");
    const bridge = await this.#bridge.read(runId); if (!bridge) throw new SandboxLifecycleError("sandbox start has no exact bridge metadata");
    this.#assertBridge(specForPolicy, bridge);
    const runningIdentity = record.identity; if (!runningIdentity) throw new SandboxLifecycleError("sandbox attestation has no persisted creation identity");
    record = await this.#transition(runId, record, "attesting", this.#operation(owner, lease.fencingToken, "attest", "attest", record.operationGeneration + (record.lifecycle === "attesting" ? 0 : 1)), { identity: { ...runningIdentity, sandboxId: running.id, vmId: running.vmId, bootId: running.bootId }, bootId: running.bootId }, lease);
    const spec = await this.#readSpec(record);
      const resolvedRelease = await this.#resolver.resolve({ templateName: spec.template.name, templateDigest: spec.template.digest, resources: spec.resources, networkProfileDigest: spec.network.profileDigest });
      if (resolvedRelease.release.releaseId !== record.releaseId || resolvedRelease.templateReference !== this.#driver.release.templateReference || resolvedRelease.sbxExecutable !== this.#driver.release.sbxExecutable || canonicalJson(resolvedRelease.resourceTuple) !== canonicalJson(this.#driver.release.resourceTuple)) throw new SandboxLifecycleError("sandbox driver and persisted release identities differ during attestation");
      const attestation = await this.#attestor.attest({ runId, spec, release: resolvedRelease, observed: running, bridge, creationGeneration: record.operationGeneration, evidence: await this.#attestorEvidence(runId, record, signal) }, signal);
      assertSandboxSemantics("urn:squire:sandbox:v1:sandbox-attestation", attestation);
      const reference = await this.#writeLedgerContract(runId, `attestation-${record.operationGeneration}`, "evidence", attestation, "urn:squire:sandbox:v1:sandbox-attestation");
      record = await this.#transition(runId, record, "ready", undefined, { identity: { ...record.identity!, sandboxId: running.id, vmId: running.vmId, bootId: running.bootId }, attestation: reference, attestationDigest: reference.sha256, bootId: running.bootId }, lease);
      return { runId, sandbox: record, attestation };
    } catch (error) {
      await this.#markBlocked(runId, record, error, lease);
      throw error instanceof SandboxLifecycleError ? error : new SandboxLifecycleError(error instanceof Error ? error.message : String(error));
    }
  }

  /** The attestor is the release-specific measured evidence source. Keeping it
   * behind a port means a fake driver cannot accidentally manufacture host
   * observations in production composition. */
  async #attestorEvidence(runId: string, record: SandboxRecord, signal?: AbortSignal): Promise<MeasuredSandboxEvidence> {
    return this.#evidence({ runId, record, ...(signal ? { signal } : {}) });
  }

  async #withLease<T>(runId: string, operation: (owner: string, lease: Lease, signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
    if (callerSignal?.aborted) throw new SandboxLifecycleError("sandbox lifecycle operation was aborted before lease acquisition");
    await this.#store.assertRunStartAllowed(runId, this.#clock.now());
    const owner = `sandbox-${randomUUID()}`;
    const acquired = await this.#store.acquireLease(runId, "sandbox", owner, this.#clock.now(), this.#leaseMs);
    if (!acquired) throw new SandboxLifecycleError("sandbox lifecycle lease is held or the run is draining");
    const operationController = new AbortController();
    let abortFailure: SandboxLifecycleError | undefined;
    const abort = (failure: SandboxLifecycleError): void => { if (!abortFailure) abortFailure = failure; if (!operationController.signal.aborted) operationController.abort(); };
    const onCallerAbort = (): void => abort(new SandboxLifecycleError("sandbox lifecycle operation was aborted"));
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    if (callerSignal?.aborted) onCallerAbort();
    let renewal = Promise.resolve();
    let leaseLost: SandboxLifecycleError | undefined;
    const renewalInterval = Math.max(10, Math.min(1_000, Math.floor(this.#leaseMs / 3)));
    const heartbeat = setInterval(() => {
      renewal = renewal.then(async () => {
        if (leaseLost) return;
        try {
          const next = await this.#store.renewLease(runId, acquired.key, owner, acquired.fencingToken, this.#clock.now(), this.#leaseMs);
          if (!next || next.owner !== owner || next.fencingToken !== acquired.fencingToken) {
            leaseLost = new SandboxLifecycleError("sandbox lifecycle lease was lost during the operation");
            abort(leaseLost);
          }
        } catch (error) {
          leaseLost = new SandboxLifecycleError(`sandbox lifecycle lease renewal failed: ${error instanceof Error ? error.message : String(error)}`);
          abort(leaseLost);
        }
      });
    }, renewalInterval);
    heartbeat.unref?.();
    let timeout: NodeJS.Timeout | undefined;
    let operationPromise: Promise<T>;
    try { operationPromise = Promise.resolve(operation(owner, acquired, operationController.signal)); }
    catch (error) { operationPromise = Promise.reject(error); }
    // A timed-out/non-cooperative operation may still be executing. Keep its
    // lease until settlement so a late filesystem/driver mutation cannot run
    // under a freshly acquired owner. The lease naturally expires if it never
    // settles; its exact release is scheduled only after it does.
    let operationSettled = false;
    void operationPromise.then(() => { operationSettled = true; }, () => { operationSettled = true; });
    void operationPromise.catch(() => undefined);
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const failure = new SandboxLifecycleError("sandbox lifecycle operation exceeded its bounded deadline");
        abort(failure); reject(failure);
      }, this.#timeoutMs);
      timeout.unref?.();
    });
    let failure: unknown;
    try {
      const result = await Promise.race([operationPromise, deadline]);
      await renewal;
      if (leaseLost || abortFailure) throw leaseLost ?? abortFailure;
      return result;
    } catch (error) { failure = error; throw error; }
    finally {
      if (timeout) clearTimeout(timeout);
      clearInterval(heartbeat);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      await renewal;
      const release = async (throwFailure: boolean): Promise<void> => {
        try { await this.#store.releaseLease(runId, acquired.key, owner, acquired.fencingToken); }
        catch (error) { if (throwFailure) throw error; }
      };
      if (operationSettled) await release(failure === undefined);
      else {
        void operationPromise.then(
          async () => { await renewal; await release(false); },
          async () => { await renewal; await release(false); },
        ).catch(() => undefined);
      }
    }
  }

  async #requireRecord(runId: string): Promise<SandboxRecord> { const snapshot = await this.#store.read(runId); if (!snapshot) throw new SandboxLifecycleError("run not found"); if (!snapshot.sandbox) throw new SandboxLifecycleError("sandbox record is absent"); try { assertSandboxRecordMutation(snapshot.sandbox, snapshot.sandbox, runId); } catch (error) { throw new SandboxLifecycleError(error instanceof Error ? error.message : "sandbox record is malformed"); } return snapshot.sandbox; }
  async #blockCurrent(runId: string, lease: Lease, error: unknown, known?: SandboxRecord): Promise<void> {
    const current = known ?? (await this.#store.read(runId))?.sandbox;
    if (!current || current.lifecycle === "blocked" || current.lifecycle === "removed") return;
    await this.#markBlocked(runId, current, error, lease);
  }
  async #insertRecord(runId: string, record: SandboxRecord, lease: Lease): Promise<void> { const snapshot = await this.#store.read(runId); if (!snapshot) throw new SandboxLifecycleError("run not found"); assertSandboxRecordMutation(undefined, record, runId); await this.#store.compareAndSetFenced(runId, { version: snapshot.version }, this.#leaseGuard(lease), current => ({ ...current, version: current.version + 1, sandbox: record })); }
  async #transition(runId: string, previous: SandboxRecord, lifecycle: SandboxRecord["lifecycle"], operation?: SandboxOperation, patch: Partial<SandboxRecord> = {}, lease?: Lease): Promise<SandboxRecord> {
    const snapshot = await this.#store.read(runId); if (!snapshot?.sandbox) throw new SandboxLifecycleError("sandbox record disappeared during transition");
    if (snapshot.sandbox.specFingerprint !== previous.specFingerprint || snapshot.sandbox.operationGeneration !== previous.operationGeneration) throw new SandboxLifecycleError("sandbox transition owner observed a stale record");
    const { operation: _previousOperation, ...withoutOperation } = snapshot.sandbox;
    const next: SandboxRecord = { ...withoutOperation, ...patch, lifecycle, operationGeneration: lifecycle === snapshot.sandbox.lifecycle ? snapshot.sandbox.operationGeneration : snapshot.sandbox.operationGeneration + 1, ...(operation ? { operation } : {}) };
    assertSandboxRecordMutation(snapshot.sandbox, next, runId);
    const guard = lease ? this.#leaseGuard(lease) : snapshot.sandbox.operation ? { key: "sandbox", owner: snapshot.sandbox.operation.owner, fencingToken: snapshot.sandbox.operation.fencingToken, now: this.#clock.now() } : undefined;
    if (!guard) throw new SandboxLifecycleError("sandbox transition lacks durable lease ownership");
    return (await this.#store.compareAndSetFenced(runId, { version: snapshot.version }, guard, current => ({ ...current, version: current.version + 1, sandbox: next }))).sandbox!;
  }
  async #transitionTeardown(runId: string, previous: SandboxRecord, fence: RunTerminalFence, lifecycle: SandboxRecord["lifecycle"], operation?: SandboxOperation, patch: Partial<SandboxRecord> = {}): Promise<SandboxRecord> {
    const snapshot = await this.#store.read(runId); if (!snapshot?.sandbox || !this.#store.compareAndSetTeardown) throw new SandboxLifecycleError("workflow store has no fenced teardown CAS surface");
    if (snapshot.sandbox.specFingerprint !== previous.specFingerprint || snapshot.sandbox.operationGeneration !== previous.operationGeneration) throw new SandboxLifecycleError("sandbox teardown transition observed a stale record");
    const { operation: _previousOperation, ...withoutOperation } = snapshot.sandbox;
    const next: SandboxRecord = { ...withoutOperation, ...patch, lifecycle, operationGeneration: lifecycle === snapshot.sandbox.lifecycle ? snapshot.sandbox.operationGeneration : snapshot.sandbox.operationGeneration + 1, ...(operation ? { operation } : {}) };
    assertSandboxRecordMutation(snapshot.sandbox, next, runId);
    return (await this.#store.compareAndSetTeardown(runId, { version: snapshot.version }, fence, current => ({ ...current, version: current.version + 1, sandbox: next }))).sandbox!;
  }
  async #markBlocked(runId: string, previous: SandboxRecord, error: unknown, lease?: Lease): Promise<void> { try { await this.#transition(runId, previous, "blocked", undefined, { error: errorRecord(error) }, lease); } catch { /* Preserve the original failure; reconciliation remains fail-closed. */ } }
  async #markBlockedTeardown(runId: string, previous: SandboxRecord, fence: RunTerminalFence, error: unknown): Promise<void> { try { await this.#transitionTeardown(runId, previous, fence, "blocked", undefined, { error: errorRecord(error) }); } catch { /* A failed fenced CAS is itself a blocked teardown condition. */ } }
  async #readSpec(record: SandboxRecord): Promise<SandboxSpecDocument> {
    const expectedPath = `artifacts/sandbox/${record.runId}/spec.json`;
    if (record.spec.path !== expectedPath || record.spec.schemaId !== "urn:squire:sandbox:v1:sandbox-spec") throw new SandboxLifecycleError("sandbox spec ledger reference is not the fixed immutable path");
    const target = path.join(this.#root, "sandbox-ledger", record.runId, "spec.json");
    await ensurePrivateDirectory(path.dirname(target));
    const info = await lstat(target).catch(error => { throw new SandboxLifecycleError(`sandbox spec ledger is unavailable: ${error instanceof Error ? error.message : String(error)}`); });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > 4 * 1024 * 1024) throw new SandboxLifecycleError("sandbox spec ledger is not a bounded private regular file");
    let bytes: Buffer;
    try { bytes = await readExactNoFollow(target, this.#root, 4 * 1024 * 1024); }
    catch (error) { throw new SandboxLifecycleError(`sandbox spec ledger is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch (error) { throw new SandboxLifecycleError(`sandbox spec ledger is not JSON: ${error instanceof Error ? error.message : String(error)}`); }
    if (!bytes.equals(canonicalBytes(parsed)) || sha256Bytes(bytes) !== record.spec.sha256) throw new SandboxLifecycleError("sandbox spec ledger identity or serialization changed");
    const value = parsed as SandboxSpecDocument;
    if (value.fingerprint !== record.specFingerprint) throw new SandboxLifecycleError("sandbox spec ledger fingerprint changed");
    try { assertSandboxSemantics("urn:squire:sandbox:v1:sandbox-spec", value); } catch (error) { throw new SandboxLifecycleError(error instanceof Error ? error.message : String(error)); }
    return value;
  }
  async #writeLedgerContract(runId: string, stem: string, logicalRoot: "artifacts" | "evidence", value: object, schemaId: string): Promise<{ path: string; sha256: string; schemaId: string }> {
    const ledgerRoot = path.join(this.#root, "sandbox-ledger"); const directory = path.join(ledgerRoot, runId);
    await ensurePrivateDirectory(this.#root); await ensurePrivateDirectory(ledgerRoot); await ensurePrivateDirectory(directory);
    const file = stem === "spec" ? path.join(directory, "spec.json") : path.join(directory, `${stem}.json`); const bytes = canonicalBytes(value);
    try { await writeExclusiveFile(file, bytes, this.#root, 0o600); }
    catch (error) {
      const exists = await lstat(file).then(() => true).catch(cause => { if (isCode(cause, "ENOENT")) return false; throw cause; });
      if (!exists) throw new SandboxLifecycleError(`sandbox ledger contract could not be created: ${error instanceof Error ? error.message : String(error)}`);
    }
    let actual: Buffer;
    try { actual = await readExactNoFollow(file, this.#root, 4 * 1024 * 1024); }
    catch (error) { throw new SandboxLifecycleError(`sandbox ledger contract is unavailable: ${error instanceof Error ? error.message : String(error)}`); }
    if (!actual.equals(bytes)) throw new SandboxLifecycleError("immutable sandbox ledger contract was substituted");
    return { path: `${logicalRoot}/sandbox/${runId}/${path.basename(file)}`, sha256: sha256Bytes(bytes), schemaId };
  }
  async #requireObserved(record: SandboxRecord, signal?: AbortSignal): Promise<SbxObservedSandbox> { const observed = await this.#driver.inspect(record.sandboxName, signal); if (!observed) throw new SandboxLifecycleError("exact sandbox observation is absent"); this.#assertObserved(record, observed); return observed; }
  async #observeRemovalTarget(name: string, signal?: AbortSignal): Promise<SbxObservedSandbox | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal?.aborted) throw new SandboxLifecycleError("sandbox removal observation was aborted");
      const observed = await this.#driver.inspect(name, signal);
      if (observed) return observed;
      if (attempt < 2) await abortableDelay(10 * (attempt + 1), signal);
    }
    return undefined;
  }
  #assertObserved(record: SandboxRecord, observed: SbxObservedSandbox): void { assertObservedShape(observed); if (!record.identity || observed.name !== record.sandboxName || observed.templateDigest !== record.templateDigest || observed.id !== record.identity.sandboxId || observed.vmId !== record.identity.vmId || observed.id === "" || observed.vmId === "") throw new SandboxLifecycleError("sandbox observation is not the persisted exact identity"); }
  #assertRecordSpec(record: SandboxRecord, spec: SandboxSpecDocument, release: ResolvedSandboxRelease): void { if (record.spec.path !== `artifacts/sandbox/${spec.runId}/spec.json` || record.spec.schemaId !== "urn:squire:sandbox:v1:sandbox-spec" || record.specFingerprint !== spec.fingerprint || record.templateDigest !== spec.template.digest || record.sandboxName !== deriveSandboxName(spec.runId) || record.bridgeName !== deriveBridgeName(spec.runId) || record.releaseId !== release.release.releaseId || record.spec.sha256 !== sha256Bytes(canonicalBytes(spec))) throw new SandboxLifecycleError("existing sandbox record is bound to a different immutable spec"); }
  #assertBridge(spec: SandboxSpecDocument, bridge: BridgeRecord): void { if (bridge.runId !== spec.runId || bridge.name !== spec.bridge.name || bridge.path !== this.#bridge.bridgePath(spec.runId) || bridge.logicalPath !== "/ticket/bridge" || bridge.quotaBytes !== spec.bridge.quotaBytes || bridge.identityReference !== spec.bridge.identityReference || bridge.identity.path !== bridge.path || bridge.quota.path !== bridge.path || bridge.quota.quotaBytes !== bridge.quotaBytes) throw new SandboxLifecycleError("sandbox bridge identity is not the exact spec-bound untrusted bridge"); }
  #identityManifest(spec: SandboxSpecDocument, observed: SbxObservedSandbox, bridge: BridgeRecord, generation: number): SandboxIdentityManifest { return { schemaVersion: 1, kind: "squire-sandbox-identity-manifest", runId: spec.runId, sandboxName: observed.name, sandboxId: observed.id, vmId: observed.vmId, releaseId: this.#driver.release.release.releaseId, templateDigest: spec.template.digest, specFingerprint: spec.fingerprint, bridge: { name: bridge.name, hostPath: bridge.path, logicalPath: "/ticket/bridge", device: bridge.identity.device, inode: bridge.identity.inode, mode: bridge.identity.mode & 0o777, linkCount: bridge.identity.linkCount, quotaBytes: bridge.quotaBytes }, generation, ...(observed.bootId ? { bootId: observed.bootId } : {}) }; }
  #operation(owner: string, fencingToken: number, kind: SandboxOperationKind, intent: SandboxOperationIntent, generation: number): SandboxOperation { return { kind, intent, owner, fencingToken, generation, deadlineAt: this.#clock.now() + this.#timeoutMs, startedAt: new Date(this.#clock.now()).toISOString() }; }
  #leaseGuard(lease: Lease): LeaseGuard { return { key: "sandbox", owner: lease.owner, fencingToken: lease.fencingToken, now: this.#clock.now() }; }
}

function assertCreateRequestShape(request: SandboxCreateRequest): void {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new SandboxLifecycleError("sandbox create request is required");
  const record = request as unknown as Record<string, unknown>;
  const required = ["network", "retention", "runId", "templateDigest", "templateName", "ticketIdentifier"];
  const optional = ["architecture", "creationNonce", "platform", "resources"];
  if (Object.keys(record).some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !Object.hasOwn(record, key)) || !safeText(record["ticketIdentifier"], 256) || !safeText(record["templateName"], 256) || !safeText(record["templateDigest"], 128) || typeof record["network"] !== "object" || record["network"] === null || Array.isArray(record["network"]) || typeof record["retention"] !== "object" || record["retention"] === null || Array.isArray(record["retention"])) throw new SandboxLifecycleError("sandbox create request is malformed");
  assertDigestReference(record["templateDigest"], "sandbox create template digest");
  const network = record["network"] as Record<string, unknown>;
  if (Object.keys(network).some(key => !["allowedHosts", "mode", "profileDigest"].includes(key)) || !Object.hasOwn(network, "allowedHosts") || !Object.hasOwn(network, "mode") || !["allow-all", "allowlist", "deny-all"].includes(network["mode"] as string) || !Array.isArray(network["allowedHosts"]) || network["allowedHosts"].length > 128 || network["allowedHosts"].some(host => !safeText(host, 256))) throw new SandboxLifecycleError("sandbox create network policy is malformed");
  if (network["profileDigest"] !== undefined) { if (typeof network["profileDigest"] !== "string") throw new SandboxLifecycleError("sandbox create network profile digest is malformed"); assertSha256(network["profileDigest"], "sandbox create network profile digest"); }
  const retention = record["retention"] as Record<string, unknown>;
  if (Object.keys(retention).sort().join("\0") !== ["artifactUntil", "failureUntil", "successUntil"].sort().join("\0") || !Object.values(retention).every(value => typeof value === "string" && value.length <= 64)) throw new SandboxLifecycleError("sandbox create retention policy is malformed");
  if (record["resources"] !== undefined && (!record["resources"] || typeof record["resources"] !== "object" || Array.isArray(record["resources"]))) throw new SandboxLifecycleError("sandbox create resource request is malformed");
  for (const key of ["architecture", "creationNonce", "platform"]) if (record[key] !== undefined && !safeText(record[key], 256)) throw new SandboxLifecycleError(`sandbox create ${key} is malformed`);
}
function safeText(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f\r\n]/u.test(value); }
function sameResourceTuple(left: SandboxResourceSpec, right: SandboxResourceSpec): boolean { return left.cpus === right.cpus && left.memoryMiB === right.memoryMiB && canonicalJson(left.disk) === canonicalJson(right.disk); }
function assertCreateRequestMatchesPersisted(request: SandboxCreateRequest, persisted: SandboxSpecDocument): void {
  const requestedNetwork = { mode: request.network.mode, allowedHosts: [...request.network.allowedHosts] };
  const persistedNetwork = { mode: persisted.network.mode, allowedHosts: [...persisted.network.allowedHosts] };
  if (persisted.runId !== request.runId || persisted.ticketIdentifier !== request.ticketIdentifier || persisted.template.name !== request.templateName || persisted.template.digest !== request.templateDigest || canonicalJson(persistedNetwork) !== canonicalJson(requestedNetwork) || (request.network.profileDigest !== undefined && persisted.network.profileDigest !== request.network.profileDigest) || canonicalJson(persisted.retention) !== canonicalJson(request.retention) || (request.resources !== undefined && !sameResourceTuple(persisted.resources, request.resources)) || (request.creationNonce !== undefined && persisted.creationNonce !== request.creationNonce)) throw new SandboxLifecycleError("sandbox retry request differs from the immutable persisted spec");
}
function assertObservedShape(observed: SbxObservedSandbox): void {
  if (!observed || typeof observed !== "object" || Array.isArray(observed)) throw new SandboxLifecycleError("sandbox observation is malformed");
  const value = observed as unknown as Record<string, unknown>;
  const keys = Object.hasOwn(value, "bootId") ? ["bootId", "id", "name", "status", "templateDigest", "vmId"] : ["id", "name", "status", "templateDigest", "vmId"];
  if (Object.keys(value).sort().join("\0") !== keys.sort().join("\0") || !safeText(value["name"], 512) || !safeText(value["id"], 512) || !safeText(value["vmId"], 512) || !["created", "running", "stopped", "unknown"].includes(value["status"] as string) || typeof value["templateDigest"] !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value["templateDigest"] as string) || Object.hasOwn(value, "bootId") && (value["status"] !== "running" || !safeText(value["bootId"], 512))) throw new SandboxLifecycleError("sandbox observation is malformed");
}
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new SandboxLifecycleError("sandbox lifecycle delay was aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(new SandboxLifecycleError("sandbox lifecycle delay was aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function positive(value: number, label: string): number { if (!Number.isSafeInteger(value) || value <= 0 || value > 300_000) throw new SandboxLifecycleError(`${label} is outside its bounded range`); return value; }
function asLifecycleError(error: unknown): SandboxLifecycleError { return error instanceof SandboxLifecycleError ? error : new SandboxLifecycleError(error instanceof Error ? error.message : String(error)); }
function errorRecord(error: unknown): NonNullable<SandboxRecord["error"]> { const message = error instanceof Error ? error.message : String(error); return { code: error instanceof SandboxContractError ? "contract" : "lifecycle", message: message.slice(0, 1_000), at: new Date().toISOString(), evidence: [] }; }
function isCode(error: unknown, code: string): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code); }
async function ensurePrivateDirectory(target: string): Promise<void> {
  const root = path.parse(target).root;
  if (!path.isAbsolute(target) || path.resolve(target) !== target || target.endsWith(path.sep) || target === root || target.includes("\0")) throw new SandboxLifecycleError("sandbox ledger directory is not canonical");
  const parts = target.slice(root.length).split(path.sep).filter(Boolean); let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    await mkdir(current, { recursive: false, mode: 0o700 }).catch(error => { if (!isCode(error, "EEXIST")) throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new SandboxLifecycleError("sandbox ledger directory contains a symbolic-link ancestor");
  }
  const info = await lstat(target);
  if ((info.mode & 0o777) !== 0o700 || info.nlink < 2) throw new SandboxLifecycleError("sandbox ledger directory is not private");
}
void assertSandboxName;
void assertSandboxRecordMutation;
