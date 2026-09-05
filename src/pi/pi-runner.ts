import { randomUUID } from "node:crypto";
import { ROLES, type Clock, type Lease, type LeaseGuard, type ProcessAllocation, type Role, type RunTerminalFence, type RuntimeResolution, type SessionRegistration } from "../control/domain.js";
import type { GitWorkspaceReadiness } from "../git/domain.js";
import { StoreConflictError, type RunQuiescenceAuthority, type WorkflowStore } from "../control/workflow-store.js";
import { buildPiCommand, assertSafeResumeArgs } from "./pi-command.js";
import { normalizeRoleConfig, normalizeWikiProfile, type PiRoleConfig, type PiWikiProfileInput } from "./pi-configuration.js";
import { createDefaultPiAgentDirectoryMaterializer, type MaterializedPiAgentDirectory, type PiAgentDirectoryMaterializerPort, type PiAgentDirectoryRequest, type PiAgentDirectoryTeardownResult } from "./pi-agent-directory.js";
import type { PiProcess, PiProcessFactory, ProcessIdentityResolver, ProcessLaunch, RuntimeResolver } from "./pi-process.js";
import { PiRpcClient, type PiState } from "./pi-rpc-client.js";
import { assertRunId } from "../git/identity.js";
import { canonicalJson } from "../sandbox/identity.js";

export interface RunnerConfig {
  roles: Record<Role, PiRoleConfig>;
  /** Top-level project-wiki background profile; normalized to Luna/high by default. */
  wiki?: PiWikiProfileInput;
  /** Descriptive alias accepted by integrations that call it a profile. */
  wikiProfile?: PiWikiProfileInput;
  /** Trusted run-scoped filesystem preparation port. */
  materializer?: PiAgentDirectoryMaterializerPort;
  /** Durable workflow authority that gates every role start and teardown. */
  runLifecycleAuthority?: RunQuiescenceAuthority;
  /** Every production and test composition must supply AIDEV-222 readiness. */
  workspaceReadiness: GitWorkspaceReadiness;
  workspace?: string;
  sessionRoot?: string;
  commandTimeoutMs?: number;
  processLeaseMs?: number;
  allocationStepTimeoutMs?: number;
  allocationTimeoutMs?: number;
  cleanupGraceMs?: number;
  /** Optional run/sandbox composition; the existing allocation authority stays here. */
  sandboxProcessFactory?: (context: { readonly runId: string; readonly role: Role; readonly generation: number; readonly runtime: RuntimeResolution; readonly launch: ProcessLaunch }) => PiProcessFactory;
}
export type RegistrationValidator = (registration: SessionRegistration, signal?: AbortSignal) => Promise<void>;
export type RoleInstructionReader = (canonicalPath: string, signal?: AbortSignal) => Promise<string>;
interface LiveHandle { process: PiProcess; client: PiRpcClient; runId: string; role: Role; generation: number }
interface AllocatingHandle { process: PiProcess; runId: string; role: Role; generation: number; owner: string; fencingToken: number }
interface AllocationLease extends Lease { runId: string; deadlineAt: number; ttlMs: number; stepTimeoutMs: number; activeOperations: Set<Promise<unknown>>; callerSignal?: AbortSignal }

export class ProcessLeaseError extends Error {
  constructor(message: string) { super(message); this.name = "ProcessLeaseError"; }
}

export class PiRunner {
  readonly live = new Map<string, LiveHandle>();
  readonly allocating = new Map<string, AllocatingHandle>();
  readonly #resolved = new Map<string, Promise<RuntimeResolution>>();
  /** In-flight preparation sharing only; settled results are never trusted from this map. */
  readonly #materializing = new Map<string, { fingerprint: string; promise: Promise<MaterializedPiAgentDirectory> }>();
  readonly #trackedProcesses = new WeakSet<PiProcess>();
  readonly #defaultMaterializer: PiAgentDirectoryMaterializerPort;
  readonly #runLifecycleAuthority: RunQuiescenceAuthority;
  #ownerSequence = 0;
  constructor(readonly factory: PiProcessFactory, readonly resolver: RuntimeResolver, readonly store: WorkflowStore, readonly config: RunnerConfig, readonly validateRegistration: RegistrationValidator, readonly readRoleInstructions: RoleInstructionReader, readonly clock: Clock, readonly processIdentities?: ProcessIdentityResolver) {
    if (!config.workspaceReadiness) throw new Error("PiRunner requires Git workspace readiness");
    this.#runLifecycleAuthority = config.runLifecycleAuthority ?? store;
    this.#defaultMaterializer = createDefaultPiAgentDirectoryMaterializer(config.workspace, this.#runLifecycleAuthority);
  }

  resolveRuntime(runId: string): Promise<RuntimeResolution> { return this.#getOrResolveRuntime(runId); }

  async #getOrMaterialize(runId: string, runtime: RuntimeResolution, wikiProfile: PiWikiProfileInput, signal?: AbortSignal): Promise<MaterializedPiAgentDirectory> {
    const materializer = this.config.materializer ?? (runtime.llmWiki.root ? this.#defaultMaterializer : undefined);
    if (!materializer) throw new Error("Pi agent-directory materializer is required when runtime resolution has no local wiki root");
    const fingerprint = canonicalJson({ runtime, wikiProfile, ...(this.config.workspace ? { workspace: this.config.workspace } : {}) });
    const previous = this.#materializing.get(runId);
    if (previous) {
      if (signal?.aborted) throw new Error("Pi agent-directory materialization was aborted");
      if (previous.fingerprint !== fingerprint) throw new Error("conflicting Pi agent-directory materialization request");
      return previous.promise;
    }
    const request: PiAgentDirectoryRequest = {
      runId,
      runtime,
      wikiProfile,
      ...(this.config.workspace ? { workspace: this.config.workspace } : {}),
      ...(signal ? { signal } : {}),
    };
    const promise = materializer.materialize(request);
    this.#materializing.set(runId, { fingerprint, promise });
    const clear = (): void => {
      if (this.#materializing.get(runId)?.promise === promise) this.#materializing.delete(runId);
    };
    void promise.then(clear, clear);
    return await promise;
  }

  async #verifyMaterialization(
    runId: string,
    runtime: RuntimeResolution,
    wikiProfile: PiWikiProfileInput,
    materialized: MaterializedPiAgentDirectory,
    signal?: AbortSignal,
  ): Promise<void> {
    const materializer = this.config.materializer ?? (runtime.llmWiki.root ? this.#defaultMaterializer : undefined);
    if (!materializer) throw new Error("Pi agent-directory materializer is required when runtime resolution has no local wiki root");
    const request: PiAgentDirectoryRequest = {
      runId,
      runtime,
      wikiProfile,
      ...(this.config.workspace ? { workspace: this.config.workspace } : {}),
      ...(signal ? { signal } : {}),
    };
    if (materializer.verify) {
      await materializer.verify(request, materialized);
      return;
    }
    const refreshed = await this.#getOrMaterialize(runId, runtime, wikiProfile, signal);
    if (canonicalJson(refreshed) !== canonicalJson(materialized)) throw new Error("Pi agent-directory changed during pre-spawn verification");
  }

  /** Explicit cleanup seam for retry/restart; callers must not treat an unknown identity as exited. */
  async reconcileProcessAllocation(runId: string, role: Role, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error("process allocation reconciliation was aborted");
    const key = `${runId}:${role}`;
    const snapshot = await this.store.read(runId); if (!snapshot) throw new Error("run not found");
    const allocation = snapshot.processAllocations?.[role]; const session = snapshot.sessions[role];
    if (allocation && (!allocation.processIdentity || (allocation.state !== "termination_failed" && allocation.state !== "failed"))) throw new StoreConflictError("process allocation is not actionable for termination recovery");
    if (allocation?.state === "failed") {
      await this.#recoverFailedAllocation(runId, role, allocation.owner, allocation.fencingToken, allocation.generation, undefined);
      const allocating = this.allocating.get(key); if (allocating && allocating.process.exitCode !== null) this.allocating.delete(key);
      const live = this.live.get(key); if (live && live.process.exitCode !== null) this.live.delete(key);
      return;
    }
    const registered = !allocation && session && (session.processState === "live" || session.processState === "launching") ? session : undefined;
    if (!allocation && !registered) return;
    const processIdentity = allocation?.processIdentity ?? registered?.processIdentity;
    if (!processIdentity) throw new StoreConflictError("registered live process has no actionable durable identity");
    const generation = allocation?.generation ?? registered!.processGeneration;
    let process = this.allocating.get(key)?.process ?? this.live.get(key)?.process;
    if (!process) process = await this.#resolveProcessIdentity(processIdentity, signal);
    if (!process) throw new Error("durable process identity could not be resolved; process ownership remains blocked");
    if (process.identity !== processIdentity) throw new Error("process identity resolver returned a mismatched handle");
    this.#trackAllocating(key, { process, runId, role, generation, owner: allocation?.owner ?? `registered:${registered!.sessionId}`, fencingToken: allocation?.fencingToken ?? -1 });
    try { await this.#terminate(process, signal); }
    catch (error) {
      if (process.exitCode === null) {
        if (allocation) await this.#retainUnresolvedAllocation(runId, role, allocation.owner, allocation.fencingToken, generation, process.identity);
        else await this.#verifyRegisteredProcessOwnership(runId, role, generation, process.identity);
      }
      throw error;
    }
    if (allocation) {
      await this.#recoverFailedAllocation(runId, role, allocation.owner, allocation.fencingToken, generation, process);
      const remaining = (await this.store.read(runId))?.processAllocations?.[role];
      if (remaining?.state === "failed" && !remaining.sessionId) await this.#recoverFailedAllocation(runId, role, remaining.owner, remaining.fencingToken, remaining.generation, process);
    } else await this.#markProcess(runId, role, generation, process.identity, "failed");
    if (this.allocating.get(key)?.process === process) this.allocating.delete(key);
    if (this.live.get(key)?.process === process) this.live.delete(key);
    if (!allocation) await this.#verifyRegisteredProcessCleaned(runId, role, generation, process.identity);
  }

  async launch(runId: string, role: Role, signal?: AbortSignal): Promise<{ process: PiProcess; client: PiRpcClient; state: PiState; runtime: RuntimeResolution; agentDir?: string }> {
    if (signal?.aborted) throw new Error("Pi launch was aborted");
    await this.#runLifecycleAuthority.assertRunStartAllowed(runId, this.clock.now());
    await this.config.workspaceReadiness.verify(runId);
    const key = `${runId}:${role}`;
    const pending = this.allocating.get(key);
    if (pending) throw new Error("role already has an unresolved allocating process");
    const owned = this.live.get(key);
    if (owned?.process.exitCode === null) throw new Error("role already has a live process");
    if (owned) this.live.delete(key);
    const owner = `runner-${randomUUID()}-${++this.#ownerSequence}`;
    const leaseKey = `process:${role}`;
    const processLeaseMs = positiveInteger(this.config.processLeaseMs ?? 30_000, "process lease");
    const stepTimeoutMs = positiveInteger(this.config.allocationStepTimeoutMs ?? Math.max(1, Math.floor(processLeaseMs / 2)), "allocation step timeout");
    const roleConfig = normalizeRoleConfig(role, this.config.roles[role]!);
    const roleTimeoutSeconds = positiveInteger(roleConfig.timeoutSeconds ?? 0, `role timeout for ${role}`);
    const allocationTimeoutMs = positiveInteger(this.config.allocationTimeoutMs ?? Math.max(roleTimeoutSeconds * 1_000, stepTimeoutMs * 12), "allocation timeout");
    const startedAt = this.clock.now();
    const acquired = await this.store.acquireLease(runId, leaseKey, owner, startedAt, Math.min(processLeaseMs, allocationTimeoutMs));
    if (!acquired) throw new Error("role process lease is held");
    const lease: AllocationLease = { ...acquired, runId, deadlineAt: startedAt + allocationTimeoutMs, ttlMs: processLeaseMs, stepTimeoutMs, activeOperations: new Set(), ...(signal ? { callerSignal: signal } : {}) };
    let released = false;
    let claimed: SessionRegistration | undefined;
    let generation: number | undefined;
    let process: PiProcess | undefined;
    try {
      await this.#step("stale allocation recovery", lease, () => this.#recoverReservedPredecessor(runId, role, lease));
      const existing = await this.#step("session lookup", lease, () => this.store.getSession(runId, role));
      if (existing) {
        await this.#step("session validation", lease, signal => this.validateRegistration(existing, signal));
        generation = existing.processGeneration + 1;
        await this.#step("resumed allocation reservation", lease, () => this.#reserveAllocation(runId, role, generation!, lease, existing));
        claimed = await this.#step("generation claim", lease, () => this.#claimGeneration(existing, generation!, lease), value => { claimed = value; });
      } else {
        generation = 1;
        await this.#step("first-session allocation reservation", lease, () => this.#reserveAllocation(runId, role, generation!, lease));
      }
      const runtime = await this.#step("runtime resolution", lease, signal => this.#getOrResolveRuntime(runId, lease, signal));
      const wikiProfile = normalizeWikiProfile(this.config.wikiProfile ?? this.config.wiki);
      const materialized = await this.#step("Pi agent-directory materialization", lease, signal => this.#getOrMaterialize(runId, runtime, wikiProfile, signal));
      const instructions = await this.#step("role instruction read", lease, signal => this.readRoleInstructions(roleConfig.instructionsPath, signal));
      if (instructions.length === 0) throw new Error("role instructions are empty");
      await this.#step("spawn intent", lease, () => this.#setAllocation(runId, role, lease, "spawning"));
      const verifiedMaterialized = await this.#step(
        "Pi agent-directory integrity verification",
        lease,
        signal => this.#verifyMaterialization(runId, runtime, wikiProfile, materialized, signal),
      ).then(() => materialized);
      const spec = buildPiCommand({
        role,
        config: roleConfig,
        instructions,
        piBinary: runtime.pi.executable,
        ...(this.config.workspace ? { workspace: this.config.workspace } : {}),
        ...(this.config.sessionRoot ? { sessionRoot: this.config.sessionRoot } : {}),
        ...(claimed ? { registration: claimed } : {}),
        agentDir: verifiedMaterialized.agentDir,
        homeDir: verifiedMaterialized.homeDir,
        wikiHomeDir: verifiedMaterialized.wikiHomeDir,
        trustedExtensionPaths: verifiedMaterialized.trustedExtensionPaths,
      });
      if (claimed) assertSafeResumeArgs(spec.args, claimed.sessionFile);
      const ownProcess = (value: PiProcess): void => {
        if (process && process !== value) throw new Error("process factory returned inconsistent process identity");
        process = value;
        this.#trackAllocating(key, { process: value, runId, role, generation: generation!, owner, fencingToken: lease.fencingToken });
      };
      process = await this.#step("process spawn", lease, async signal => {
        // Recheck inside the final bounded spawn step, after all potentially
        // mutable materialization/instruction work and immediately before the
        // child factory is allowed to create a process.
        await this.config.workspaceReadiness.verify(runId);
        const selectedFactory = this.config.sandboxProcessFactory?.({ runId, role, generation: generation!, runtime, launch: spec }) ?? this.factory;
        return selectedFactory.spawn(spec, signal, ownProcess);
      }, ownProcess);
      await this.#step("spawn ownership claim", lease, () => this.#setAllocation(runId, role, lease, "spawned", process!.identity));
      const client = new PiRpcClient(process, { commandTimeoutMs: this.config.commandTimeoutMs ?? 5_000 });
      this.live.set(key, { process, client, runId, role, generation });
      if (this.allocating.get(key)?.process === process) this.allocating.delete(key);
      client.on("protocol_error", () => { void this.#markProcess(runId, role, generation!, process!.identity, "failed"); });
      const state = await this.#step("Pi handshake", lease, signal => client.getState(signal));
      if (state.model?.provider !== roleConfig.provider || state.model?.id !== roleConfig.model) throw new Error("Pi handshake model mismatch");
      if (state.thinkingLevel !== roleConfig.thinking) throw new Error("Pi handshake thinking level mismatch");
      if (claimed && (state.sessionId !== claimed.sessionId || state.sessionFile !== claimed.sessionFile)) throw new Error("Pi resume handshake identity mismatch");
      if (!claimed) {
        const registration = registrationFromState(runId, role, state, generation, runtime.resolvedAt, process.identity, "live");
        await this.#step("first-session validation", lease, signal => this.validateRegistration(registration, signal));
        await this.#step("first-session registration", lease, () => this.#registerFirstSession(registration, lease));
      } else {
        await this.#step("live generation persistence", lease, () => this.#completeResumedGeneration(runId, role, generation!, process!.identity, lease));
      }
      await this.#drainAllocationOperations(lease);
      return { process, client, state, runtime, agentDir: materialized.agentDir };
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      try { if (process) await this.#terminate(process); }
      catch (terminationError) { if (process?.exitCode === null) cleanupErrors.push(terminationError); }
      if (process?.exitCode === null) {

        try { await this.#retainUnresolvedAllocation(runId, role, owner, lease.fencingToken, generation!, process.identity); }
        catch (retentionError) { cleanupErrors.push(retentionError); }
      } else {
        try {
          await this.#recoverFailedAllocation(runId, role, owner, lease.fencingToken, generation, process);
          if (this.allocating.get(key)?.process === process) this.allocating.delete(key);
          if (this.live.get(key)?.process === process) this.live.delete(key);
        } catch (recoveryError) { cleanupErrors.push(recoveryError); }
      }
      if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "process allocation failed and cleanup could not converge");
      throw error;
    } finally {
      if (!released) {
        released = true;
        if (lease.activeOperations.size === 0) await this.store.releaseLease(runId, leaseKey, owner, lease.fencingToken);
        else void this.#releaseAfterOperations(lease, runId, leaseKey, owner).catch(() => undefined);
      }
    }
  }

  async #getOrResolveRuntime(runId: string, lease?: AllocationLease, signal?: AbortSignal): Promise<RuntimeResolution> {
    if (signal?.aborted) throw new Error("runtime resolution aborted");
    const existing = this.#resolved.get(runId); if (existing) return existing;
    const resolution = this.#resolveAndRecord(runId, lease, signal); this.#resolved.set(runId, resolution);
    try { return await resolution; }
    catch (error) { if (this.#resolved.get(runId) === resolution) this.#resolved.delete(runId); throw error; }
  }

  async #resolveAndRecord(runId: string, lease?: AllocationLease, signal?: AbortSignal): Promise<RuntimeResolution> {
    let snapshot = await this.store.read(runId); if (!snapshot) throw new Error("run not found");
    if (snapshot.runtimeResolution) return snapshot.runtimeResolution;
    const observed = await this.resolver.resolve(runId, signal); if (signal?.aborted) throw new Error("runtime resolution aborted");
    for (;;) {
      snapshot = await this.store.read(runId); if (!snapshot) throw new Error("run not found");
      if (snapshot.runtimeResolution) return snapshot.runtimeResolution;
      try {
        const recorded = lease ? await this.store.recordRuntimeFenced(runId, { version: snapshot.version }, this.#guard(lease), observed) : await this.store.recordRuntime(runId, { version: snapshot.version }, observed);
        return recorded.runtimeResolution!;
      } catch (error) {
        if (!(error instanceof StoreConflictError)) throw error;
        const raced = await this.store.read(runId); if (raced?.runtimeResolution) return raced.runtimeResolution;
        if (lease) await this.#renew(lease);
      }
    }
  }

  async #recoverReservedPredecessor(runId: string, role: Role, lease: AllocationLease): Promise<void> {
    for (;;) {
      const current = await this.store.read(runId); if (!current) throw new Error("run not found");
      const allocation = current.processAllocations?.[role]; if (!allocation) return;
      if (allocation.owner === lease.owner && allocation.fencingToken === lease.fencingToken) return;
      if (allocation.state !== "reserved") throw new StoreConflictError("prior process spawn requires reconciliation");
      const sessions = { ...current.sessions }; const session = sessions[role];
      if (allocation.sessionId && session?.sessionId === allocation.sessionId && session.processGeneration === allocation.generation && session.processState === "launching") sessions[role] = { ...session, processState: "failed" };
      const processAllocations = { ...current.processAllocations }; delete processAllocations[role];
      try { await this.store.compareAndSetFenced(runId, { version: current.version }, this.#guard(lease), snapshot => ({ ...snapshot, version: snapshot.version + 1, sessions, processAllocations })); return; }
      catch (error) { if (!(error instanceof StoreConflictError)) throw error; await this.#renew(lease); }
    }
  }

  async #reserveAllocation(runId: string, role: Role, generation: number, lease: AllocationLease, session?: SessionRegistration): Promise<void> {
    for (;;) {
      const current = await this.store.read(runId); if (!current) throw new Error("run not found");
      if (current.processAllocations?.[role]) throw new StoreConflictError("role already has a process allocation");
      const persisted = current.sessions[role];
      if (session) {
        if (!persisted || persisted.sessionId !== session.sessionId || persisted.sessionFile !== session.sessionFile || persisted.processGeneration + 1 !== generation || persisted.processState === "live" || persisted.processState === "launching") throw new StoreConflictError("registered session changed before allocation reservation");
      } else if (persisted) throw new StoreConflictError("role session appeared during first allocation");
      const allocation: ProcessAllocation = { role, owner: lease.owner, fencingToken: lease.fencingToken, generation, state: "reserved", allocatedAt: new Date(this.clock.now()).toISOString(), ...(session ? { sessionId: session.sessionId, sessionFile: session.sessionFile } : {}) };
      try { await this.store.compareAndSetFenced(runId, { version: current.version }, this.#guard(lease), snapshot => ({ ...snapshot, version: snapshot.version + 1, processAllocations: { ...snapshot.processAllocations, [role]: allocation } })); return; }
      catch (error) { if (!(error instanceof StoreConflictError)) throw error; await this.#renew(lease); }
    }
  }

  async #setAllocation(runId: string, role: Role, lease: AllocationLease, state: "spawning" | "spawned", processIdentity?: string): Promise<void> {
    for (;;) {
      const current = await this.store.read(runId); if (!current) throw new Error("run not found");
      const allocation = current.processAllocations?.[role];
      if (!allocation || allocation.owner !== lease.owner || allocation.fencingToken !== lease.fencingToken) throw new ProcessLeaseError("process allocation ownership was fenced");
      if (state === "spawning" && allocation.state !== "reserved") throw new StoreConflictError("invalid spawn intent");
      if (state === "spawned" && allocation.state !== "spawning") throw new StoreConflictError("invalid spawn claim");
      const next = { ...allocation, state, ...(processIdentity ? { processIdentity } : {}) };
      try { await this.store.compareAndSetFenced(runId, { version: current.version }, this.#guard(lease), snapshot => ({ ...snapshot, version: snapshot.version + 1, processAllocations: { ...snapshot.processAllocations, [role]: next } })); return; }
      catch (error) { if (!(error instanceof StoreConflictError)) throw error; await this.#renew(lease); }
    }
  }

  async #claimGeneration(existing: SessionRegistration, generation: number, lease: AllocationLease): Promise<SessionRegistration> {
    for (;;) {
      const current = await this.store.read(existing.runId); if (!current) throw new Error("run not found");
      const session = current.sessions[existing.role]; const allocation = current.processAllocations?.[existing.role];
      if (!session || session.sessionId !== existing.sessionId || session.sessionFile !== existing.sessionFile || session.processGeneration + 1 !== generation) throw new Error("registered session changed before generation claim");
      if (session.processState === "live" || session.processState === "launching") throw new Error("registered role still owns a live process generation");
      if (!allocation || allocation.owner !== lease.owner || allocation.fencingToken !== lease.fencingToken || allocation.generation !== generation || allocation.state !== "reserved") throw new ProcessLeaseError("generation claim lacks current reserved allocation");
      const { processIdentity: _previousIdentity, ...sessionWithoutIdentity } = session;
      const claimed = { ...sessionWithoutIdentity, processGeneration: generation, processState: "launching" as const };
      try { await this.store.compareAndSetFenced(existing.runId, { version: current.version }, this.#guard(lease), snapshot => ({ ...snapshot, version: snapshot.version + 1, sessions: { ...snapshot.sessions, [existing.role]: claimed } })); return claimed; }
      catch (error) { if (!(error instanceof StoreConflictError)) throw error; await this.#renew(lease); }
    }
  }

  async #completeResumedGeneration(runId: string, role: Role, generation: number, identity: string, lease: AllocationLease): Promise<void> {
    for (;;) {
      const current = await this.store.read(runId); if (!current) throw new Error("run not found");
      const session = current.sessions[role]; const allocation = current.processAllocations?.[role];
      if (!session || session.processGeneration !== generation || session.processState !== "launching") throw new StoreConflictError("claimed generation changed before live persistence");
      if (!allocation || allocation.owner !== lease.owner || allocation.fencingToken !== lease.fencingToken || allocation.generation !== generation || allocation.state !== "spawned" || allocation.processIdentity !== identity) throw new ProcessLeaseError("live generation lacks current spawned allocation");
      const processAllocations = { ...current.processAllocations }; delete processAllocations[role];
      try { await this.store.compareAndSetFenced(runId, { version: current.version }, this.#guard(lease), snapshot => ({ ...snapshot, version: snapshot.version + 1, sessions: { ...snapshot.sessions, [role]: { ...session, processState: "live", processIdentity: identity } }, processAllocations })); return; }
      catch (error) { if (!(error instanceof StoreConflictError)) throw error; await this.#renew(lease); }
    }
  }

  async #markProcess(runId: string, role: Role, generation: number, identity: string | undefined, state: "live" | "exited" | "failed"): Promise<void> {
    for (let attempts = 0; attempts < 16; attempts += 1) {
      const current = await this.store.read(runId); if (!current || current.terminalFence || current.teardown) return;
      const session = current.sessions[role]; if (!session || session.processGeneration !== generation) return;
      if (state === "exited" && session.processState === "failed") return;
      if (identity && session.processIdentity && session.processIdentity !== identity) return;
      const next = { ...session, processState: state, ...(identity ? { processIdentity: identity } : {}) };
      try { await this.store.compareAndSet(runId, { version: current.version }, snapshot => ({ ...snapshot, version: snapshot.version + 1, sessions: { ...snapshot.sessions, [role]: next } })); return; }
      catch (error) { if (!(error instanceof StoreConflictError)) throw error; }
    }
    throw new StoreConflictError("process exit persistence did not converge within retry bound");
  }

  async #registerFirstSession(registration: SessionRegistration, lease: AllocationLease): Promise<void> {
    for (;;) {
      const current = await this.store.read(registration.runId); if (!current) throw new Error("run not found");
      const existing = current.sessions[registration.role];
      if (existing) { if (existing.sessionId !== registration.sessionId || existing.sessionFile !== registration.sessionFile) throw new Error("conflicting role session registration"); return; }
      if (Object.values(current.sessions).some(session => session?.sessionId === registration.sessionId || session?.sessionFile === registration.sessionFile)) throw new Error("conflicting session identity registration");
      const allocation = current.processAllocations?.[registration.role];
      if (!allocation || allocation.owner !== lease.owner || allocation.fencingToken !== lease.fencingToken || allocation.generation !== registration.processGeneration || allocation.sessionId || allocation.state !== "spawned" || allocation.processIdentity !== registration.processIdentity) throw new ProcessLeaseError("first-session registration lost spawned allocation ownership");
      try { await this.store.registerSessionFenced(registration.runId, { version: current.version }, this.#guard(lease), registration); return; }
      catch (error) { if (!(error instanceof StoreConflictError)) throw error; await this.#renew(lease); }
    }
  }

  #trackAllocating(key: string, handle: AllocatingHandle): void {
    const live = this.live.get(key);
    if (!live || live.process !== handle.process) this.allocating.set(key, handle);
    if (this.#trackedProcesses.has(handle.process)) return;
    this.#trackedProcesses.add(handle.process);
    handle.process.on("exit", () => { void this.#settleTrackedExit(key, handle); });
  }

  async #settleTrackedExit(key: string, handle: AllocatingHandle): Promise<void> {
    try {
      const current = await this.store.read(handle.runId);
      const allocation = current?.processAllocations?.[handle.role];
      const exactAllocation = allocation?.owner === handle.owner && allocation.fencingToken === handle.fencingToken && allocation.generation === handle.generation;
      if (exactAllocation) {
        await this.#recoverFailedAllocation(handle.runId, handle.role, handle.owner, handle.fencingToken, handle.generation, handle.process);
        const remaining = (await this.store.read(handle.runId))?.processAllocations?.[handle.role];
        if (remaining?.state === "failed" && !remaining.sessionId) await this.#recoverFailedAllocation(handle.runId, handle.role, remaining.owner, remaining.fencingToken, remaining.generation, handle.process);
      } else await this.#markProcess(handle.runId, handle.role, handle.generation, handle.process.identity, "exited");
      if (this.allocating.get(key)?.process === handle.process) this.allocating.delete(key);
      if (this.live.get(key)?.process === handle.process) this.live.delete(key);
    } catch { /* Preserve the exited handle so explicit reconciliation can retry persistence. */ }
  }

  async #retainUnresolvedAllocation(runId: string, role: Role, failedOwner: string, failedToken: number, generation: number, processIdentity: string): Promise<void> {
    for (let attempts = 0; attempts < 16; attempts += 1) {
      const current = await this.store.read(runId); if (!current) throw new Error("run not found");
      try {
        const retained = await this.store.retainProcessAllocation(runId, { version: current.version }, { role, failedOwner, failedFencingToken: failedToken, generation, processIdentity });
        const allocation = retained.processAllocations?.[role];
        const durableAllocation = allocation?.owner === failedOwner && allocation.fencingToken === failedToken && allocation.generation === generation && allocation.state === "termination_failed" && allocation.processIdentity === processIdentity;
        const session = retained.sessions[role];
        const durableSession = session?.processGeneration === generation && session.processIdentity === processIdentity && (session.processState === "launching" || session.processState === "live");
        if (durableAllocation || durableSession) return;
        throw new StoreConflictError("unresolved process identity was not retained by its exact owner");
      } catch (error) { if (!(error instanceof StoreConflictError)) throw error; }
    }
    throw new StoreConflictError("unresolved process retention did not converge within retry bound");
  }

  async #verifyRegisteredProcessOwnership(runId: string, role: Role, generation: number, processIdentity: string): Promise<void> {
    const current = await this.store.read(runId); if (!current) throw new Error("run not found");
    const session = current.sessions[role];
    if (!session || session.processGeneration !== generation || session.processIdentity !== processIdentity || (session.processState !== "live" && session.processState !== "launching")) throw new StoreConflictError("registered process ownership changed during termination recovery");
  }

  async #verifyRegisteredProcessCleaned(runId: string, role: Role, generation: number, processIdentity: string): Promise<void> {
    const current = await this.store.read(runId); if (!current) throw new Error("run not found");
    const session = current.sessions[role];
    if (session?.processGeneration === generation && session.processIdentity === processIdentity && (session.processState === "failed" || session.processState === "exited")) return;
    throw new StoreConflictError("registered process generation changed before cleanup could be persisted");
  }

  async #recoverFailedAllocation(runId: string, role: Role, failedOwner: string, failedToken: number, generation: number | undefined, process: PiProcess | undefined): Promise<void> {
    if (process?.exitCode === null) throw new Error("cannot recover allocation while spawned process remains live");
    for (let attempts = 0; attempts < 16; attempts += 1) {
      const current = await this.store.read(runId); if (!current) return;
      try {
        await this.store.recoverProcessAllocation(runId, { version: current.version }, { role, failedOwner, failedFencingToken: failedToken, ...(generation !== undefined ? { generation } : {}), ...(process ? { processIdentity: process.identity } : {}), processExited: process ? process.exitCode !== null : true });
        return;
      } catch (error) { if (!(error instanceof StoreConflictError)) throw error; }
    }
    throw new StoreConflictError("process allocation cleanup did not converge within retry bound");
  }

  async #resolveProcessIdentity(identity: string, signal?: AbortSignal): Promise<PiProcess | undefined> {
    if (!this.processIdentities) return undefined;
    if (signal?.aborted) throw new Error("process identity resolution was aborted");
    const timeoutMs = positiveInteger(this.config.cleanupGraceMs ?? this.config.commandTimeoutMs ?? 5_000, "cleanup grace");
    const controller = new AbortController();
    let rejectAbort!: (error: Error) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = (): void => { controller.abort(); rejectAbort(new Error("process identity resolution was aborted")); };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const wait = this.clock.sleep(timeoutMs, controller.signal).catch(error => { if (controller.signal.aborted) return new Promise<void>(() => undefined); throw error; });
    try {
      return await Promise.race([
        this.processIdentities.resolve(identity, controller.signal),
        wait.then(() => { controller.abort(); throw new Error("process identity resolution timed out"); }),
        aborted,
      ]);
    }
    finally { controller.abort(); signal?.removeEventListener("abort", onAbort); }
  }

  async #terminate(process: PiProcess, signal?: AbortSignal): Promise<void> {
    if (process.exitCode !== null) return;
    if (signal?.aborted) throw new Error("process termination was aborted");
    const graceMs = positiveInteger(this.config.cleanupGraceMs ?? this.config.commandTimeoutMs ?? 5_000, "cleanup grace");
    let aborted = false;
    const waitForExit = async (): Promise<void> => {
      let onAbort!: () => void;
      const abort = new Promise<never>((_, reject) => { onAbort = () => { aborted = true; reject(new Error("process termination was aborted")); }; signal?.addEventListener("abort", onAbort, { once: true }); });
      try { await Promise.race([process.waitForExit(graceMs), abort]); }
      finally { signal?.removeEventListener("abort", onAbort); }
    };

    // A false return from kill() is not proof that the process is gone. Still
    // make the bounded escalation attempt so a stale owner cannot leave an
    // actionable process behind merely because SIGTERM was refused.
    const termDelivered = process.kill("SIGTERM");
    if (process.exitCode === null && !termDelivered) {
      const killDelivered = process.kill("SIGKILL");
      if (process.exitCode === null && !killDelivered) {
        try { await process.waitForExit(graceMs); }
        catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`spawned process kill signal was not delivered; ${detail}`);
        }
      }
    }
    if (process.exitCode === null) {
      try { await waitForExit(); }
      catch (error) {
        if (process.exitCode === null) {
          const killDelivered = process.kill("SIGKILL");
          if (!killDelivered && process.exitCode === null) {
            try { await process.waitForExit(graceMs); }
            catch (killError) {
              const detail = killError instanceof Error ? killError.message : String(killError);
              throw new Error(`spawned process kill signal was not delivered; ${detail}`);
            }
          } else if (process.exitCode === null) await process.waitForExit(graceMs);
        } else if (error instanceof Error) {
          // The process exited while the graceful wait was settling. Preserve
          // cancellation as a failure even though the exit is now observed.
          if (/process termination was aborted/u.test(error.message)) throw error;
        }
      }
    }
    if (process.exitCode === null) throw new Error("spawned process did not terminate during allocation cleanup");
    if (aborted || signal?.aborted) throw new Error("process termination was aborted");
  }

  async #step<T>(name: string, lease: AllocationLease, operation: (signal: AbortSignal) => Promise<T>, onSettled?: (value: T) => void): Promise<T> {
    if (lease.callerSignal?.aborted) throw new Error("Pi allocation was aborted");
    await this.#renew(lease);
    const startedAt = this.clock.now();
    const remaining = lease.deadlineAt - startedAt; if (remaining <= 0) throw new ProcessLeaseError("process allocation deadline expired");
    const duration = Math.min(lease.stepTimeoutMs, remaining);
    const deadline = startedAt + duration;
    const controller = new AbortController();
    const wait = this.clock.sleep(duration, controller.signal).catch(error => { if (controller.signal.aborted) return new Promise<void>(() => undefined); throw error; });
    const timeout: Promise<T> = wait.then(() => { controller.abort(); throw new Error(`${name} exceeded bounded allocation step`); });
    let rejectCaller!: (error: Error) => void;
    const callerAbort = new Promise<never>((_, reject) => { rejectCaller = reject; });
    const onCallerAbort = (): void => { controller.abort(); rejectCaller(new Error("Pi allocation was aborted")); };
    lease.callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    if (lease.callerSignal?.aborted) onCallerAbort();
    const operationPromise = Promise.resolve().then(() => operation(controller.signal));
    const settled = operationPromise.then(() => undefined, () => undefined);
    lease.activeOperations.add(settled);
    void settled.then(() => lease.activeOperations.delete(settled));
    try {
      const result = await Promise.race([operationPromise, timeout, callerAbort]);
      // A clock can advance inside an operation (for example, a durable store
      // callback may settle just as the lease timer fires). Treat that result
      // as late even if Promise.race observed it first; otherwise settlement
      // would be scheduler-dependent and a stale owner could continue.
      if (this.clock.now() >= deadline) throw new Error(`${name} exceeded bounded allocation step`);
      onSettled?.(result);
      controller.abort();
      await this.#renew(lease);
      lease.callerSignal?.removeEventListener("abort", onCallerAbort);
      return result;
    } catch (error) {
      lease.callerSignal?.removeEventListener("abort", onCallerAbort);
      controller.abort();
      await this.#renew(lease).catch(renewalError => { throw renewalError; });
      throw error;
    }
  }

  async #drainAllocationOperations(lease: AllocationLease): Promise<void> {
    while (lease.activeOperations.size > 0) await Promise.all([...lease.activeOperations]);
  }

  async #releaseAfterOperations(lease: AllocationLease, runId: string, key: string, owner: string): Promise<void> {
    await this.#drainAllocationOperations(lease);
    await this.store.releaseLease(runId, key, owner, lease.fencingToken);
  }

  async #renew(lease: AllocationLease): Promise<void> {
    const now = this.clock.now(); const remaining = lease.deadlineAt - now;
    if (remaining <= 0) throw new ProcessLeaseError("process allocation deadline expired");
    const renewed = await this.store.renewLease(lease.runId, lease.key, lease.owner, lease.fencingToken, now, Math.min(remaining, Math.max(lease.ttlMs, lease.stepTimeoutMs + 1)));
    if (!renewed) throw new ProcessLeaseError("process allocation lease was fenced or expired");
    lease.expiresAt = renewed.expiresAt;
  }

  #guard(lease: AllocationLease): LeaseGuard { return { key: lease.key, owner: lease.owner, fencingToken: lease.fencingToken, now: this.clock.now() }; }

  release(runId: string, role: Role): void {
    const key = `${runId}:${role}`;
    if (this.allocating.has(key)) throw new Error("cannot release ownership of an unresolved allocating process");
    const owned = this.live.get(key);
    if (owned?.process.exitCode === null) throw new Error("cannot release ownership of a live process");
    this.live.delete(key);
  }

  /** Reaps every exact role allocation after the shared durable drain has
   * stopped new work. This method never acquires or completes the terminal
   * fence; the aggregate sandbox coordinator owns those transitions. */
  async reapRunProcesses(runId: string, signal?: AbortSignal): Promise<void> {
    assertRunId(runId);
    if (signal?.aborted) throw new Error("run process reap was aborted");
    const failures: unknown[] = [];
    for (const role of ROLES) {
      if (signal?.aborted) throw new Error("run process reap was aborted");
      try { await this.reconcileProcessAllocation(runId, role, signal); }
      catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, "one or more exact run processes could not be reaped");
    const snapshot = await this.store.read(runId);
    if (!snapshot) throw new Error("run not found");
    if (Object.values(snapshot.processAllocations ?? {}).some(Boolean) || Object.values(snapshot.sessions).some(session => session?.processState === "live" || session?.processState === "launching")) throw new Error("run process reap completed without durable quiescence");
    for (const [key, handle] of this.allocating) if (handle.runId === runId && handle.process.exitCode === null) throw new Error(`run process remains live: ${key}`);
    for (const [key, handle] of this.live) if (handle.runId === runId && handle.process.exitCode === null) throw new Error(`run process remains live: ${key}`);
  }

  /**
   * Run-teardown integration for the retained preparation lifecycle. The
   * The durable lifecycle authority fences the run before the materializer
   * performs cleanup; this check prevents this runner from initiating teardown
   * while it still owns a live or unresolved role process.
   */
  async disposeRunAgentDirectoryUnderTerminalFence(runId: string, fence: RunTerminalFence, signal?: AbortSignal): Promise<PiAgentDirectoryTeardownResult> {
    assertRunId(runId);
    if (!fence || fence.runId !== runId || fence.state !== "held" || !Number.isSafeInteger(fence.fencingToken) || fence.fencingToken <= 0) throw new Error("Pi agent-directory disposal requires the exact held terminal fence");
    for (const handle of this.allocating.values()) {
      if (handle.runId === runId) throw new Error("cannot tear down Pi agent directory while a role allocation is unresolved");
    }
    for (const handle of this.live.values()) {
      if (handle.runId === runId && handle.process.exitCode === null) throw new Error("cannot tear down Pi agent directory while a role process is live");
    }
    const materializer = this.config.materializer ?? this.#defaultMaterializer;
    if (!materializer.disposeUnderTerminalFence) throw new Error("Pi agent-directory materializer does not provide fence-aware component teardown");
    return materializer.disposeUnderTerminalFence(runId, fence, signal);
  }

  async teardownRunAgentDirectory(runId: string, signal?: AbortSignal): Promise<PiAgentDirectoryTeardownResult> {
    for (const handle of this.allocating.values()) {
      if (handle.runId === runId) throw new Error("cannot tear down Pi agent directory while a role allocation is unresolved");
    }
    for (const handle of this.live.values()) {
      if (handle.runId === runId && handle.process.exitCode === null) throw new Error("cannot tear down Pi agent directory while a role process is live");
    }
    const materializer = this.config.materializer ?? this.#defaultMaterializer;
    if (!materializer.teardown) throw new Error("Pi agent-directory materializer does not provide trusted teardown");
    const fence = await this.#runLifecycleAuthority.acquireRunTerminalFence(runId, `runner-teardown-${randomUUID()}`, this.clock.now());
    if (materializer.disposeUnderTerminalFence) return materializer.disposeUnderTerminalFence(runId, fence, signal);
    // Legacy materializers own only their component cleanup and do not receive
    // the already-held fence. Never complete the workflow here: an aggregate
    // coordinator must still dispose Git, the sandbox, transfers, and secrets.
    return materializer.teardown
      ? materializer.teardown(runId, signal)
      : Promise.reject(new Error("Pi agent-directory materializer has no component teardown operation"));
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function registrationFromState(runId: string, role: Role, state: PiState, generation: number, registeredAt: string, processIdentity?: string, processState: SessionRegistration["processState"] = "registered"): SessionRegistration {
  if (!state.sessionId || !state.sessionFile) throw new Error("Pi state omitted session identity");
  return { runId, role, sessionId: state.sessionId, sessionFile: state.sessionFile, processGeneration: generation, processState, ...(processIdentity ? { processIdentity } : {}), registeredAt };
}
