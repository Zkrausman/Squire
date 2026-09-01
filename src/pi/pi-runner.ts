import { randomUUID } from "node:crypto";
import type { Clock, Lease, LeaseGuard, ProcessAllocation, Role, RuntimeResolution, SessionRegistration } from "../control/domain.js";
import type { WorkflowStore } from "../control/workflow-store.js";
import { StoreConflictError } from "../control/workflow-store.js";
import { buildPiCommand, assertSafeResumeArgs, type PiRoleConfig } from "./pi-command.js";
import type { PiProcess, PiProcessFactory, RuntimeResolver } from "./pi-process.js";
import { PiRpcClient, type PiState } from "./pi-rpc-client.js";

export interface RunnerConfig {
  roles: Record<Role, PiRoleConfig>;
  workspace?: string;
  sessionRoot?: string;
  commandTimeoutMs?: number;
  processLeaseMs?: number;
  allocationStepTimeoutMs?: number;
  allocationTimeoutMs?: number;
}
export type RegistrationValidator = (registration: SessionRegistration, signal?: AbortSignal) => Promise<void>;
export type RoleInstructionReader = (canonicalPath: string, signal?: AbortSignal) => Promise<string>;
interface LiveHandle { process: PiProcess; client: PiRpcClient; runId: string; role: Role; generation: number }
interface AllocationLease extends Lease { runId: string; deadlineAt: number; ttlMs: number; stepTimeoutMs: number }

export class ProcessLeaseError extends Error {
  constructor(message: string) { super(message); this.name = "ProcessLeaseError"; }
}

export class PiRunner {
  readonly live = new Map<string, LiveHandle>();
  readonly #resolved = new Map<string, Promise<RuntimeResolution>>();
  #ownerSequence = 0;
  constructor(readonly factory: PiProcessFactory, readonly resolver: RuntimeResolver, readonly store: WorkflowStore, readonly config: RunnerConfig, readonly validateRegistration: RegistrationValidator, readonly readRoleInstructions: RoleInstructionReader, readonly clock: Clock) {}

  resolveRuntime(runId: string): Promise<RuntimeResolution> { return this.#getOrResolveRuntime(runId); }

  async launch(runId: string, role: Role): Promise<{ process: PiProcess; client: PiRpcClient; state: PiState; runtime: RuntimeResolution }> {
    const key = `${runId}:${role}`;
    const owned = this.live.get(key);
    if (owned?.process.exitCode === null) throw new Error("role already has a live process");
    if (owned) this.live.delete(key);
    const owner = `runner-${randomUUID()}-${++this.#ownerSequence}`;
    const leaseKey = `process:${role}`;
    const processLeaseMs = positiveInteger(this.config.processLeaseMs ?? 30_000, "process lease");
    const stepTimeoutMs = positiveInteger(this.config.allocationStepTimeoutMs ?? Math.max(1, Math.floor(processLeaseMs / 2)), "allocation step timeout");
    const roleTimeoutSeconds = positiveInteger(this.config.roles[role]!.timeoutSeconds ?? 0, `role timeout for ${role}`);
    const defaultAllocationMs = Math.max(roleTimeoutSeconds * 1_000, stepTimeoutMs * 10);
    const allocationTimeoutMs = positiveInteger(this.config.allocationTimeoutMs ?? defaultAllocationMs, "allocation timeout");
    const startedAt = this.clock.now();
    const acquired = await this.store.acquireLease(runId, leaseKey, owner, startedAt, Math.min(processLeaseMs, allocationTimeoutMs));
    if (!acquired) throw new Error("role process lease is held");
    const lease: AllocationLease = { ...acquired, runId, deadlineAt: startedAt + allocationTimeoutMs, ttlMs: processLeaseMs, stepTimeoutMs };
    let claimed: SessionRegistration | undefined;
    let firstAllocation = false;
    let process: PiProcess | undefined;
    try {
      const existing = await this.#step("session lookup", lease, () => this.store.getSession(runId, role));
      if (existing) {
        await this.#step("session validation", lease, signal => this.validateRegistration(existing, signal));
        claimed = await this.#step("generation claim", lease, () => this.#claimGeneration(existing, lease));
      } else {
        await this.#step("first-session allocation reservation", lease, () => this.#reserveFirstAllocation(runId, role, lease));
        firstAllocation = true;
      }
      const runtime = await this.#step("runtime resolution", lease, signal => this.#getOrResolveRuntime(runId, lease, signal));
      const instructions = await this.#step("role instruction read", lease, signal => this.readRoleInstructions(this.config.roles[role].instructionsPath, signal));
      if (instructions.length === 0) throw new Error("role instructions are empty");
      const spec = buildPiCommand({ role, config: this.config.roles[role], instructions, piBinary: runtime.pi.executable, ...(this.config.workspace ? { workspace: this.config.workspace } : {}), ...(this.config.sessionRoot ? { sessionRoot: this.config.sessionRoot } : {}), ...(claimed ? { registration: claimed } : {}) });
      if (claimed) assertSafeResumeArgs(spec.args, claimed.sessionFile);
      if (firstAllocation) await this.#step("spawn intent", lease, () => this.#setFirstAllocation(runId, role, lease, "spawning"));
      process = await this.#step("process spawn", lease, signal => this.factory.spawn(spec, signal));
      if (firstAllocation) await this.#step("spawn ownership claim", lease, () => this.#setFirstAllocation(runId, role, lease, "spawned", process!.identity));
      const client = new PiRpcClient(process, { commandTimeoutMs: this.config.commandTimeoutMs ?? 5_000 });
      const generation = claimed?.processGeneration ?? 1;
      this.live.set(key, { process, client, runId, role, generation });
      client.on("protocol_error", () => { void this.#markProcess(runId, role, generation, process!.identity, "failed"); });
      process.on("exit", () => { void this.#markProcess(runId, role, generation, process!.identity, "exited").finally(() => { if (this.live.get(key)?.process === process) this.live.delete(key); }); });
      const state = await this.#step("Pi handshake", lease, () => client.getState());
      if (state.model?.provider !== this.config.roles[role].provider || state.model?.id !== this.config.roles[role].model) throw new Error("Pi handshake model mismatch");
      if (claimed && (state.sessionId !== claimed.sessionId || state.sessionFile !== claimed.sessionFile)) throw new Error("Pi resume handshake identity mismatch");
      if (!claimed) {
        const registration = registrationFromState(runId, role, state, generation, runtime.resolvedAt, process.identity, "live");
        await this.#step("first-session validation", lease, signal => this.validateRegistration(registration, signal));
        await this.#step("first-session registration", lease, () => this.#registerFirstSession(registration, lease));
      } else {
        await this.#step("live generation persistence", lease, () => this.#markProcessFenced(runId, role, generation, process!.identity, "live", lease));
      }
      return { process, client, state, runtime };
    } catch (error) {
      if (process?.exitCode === null) process.kill("SIGTERM");
      if (claimed) await this.#markProcessFenced(runId, role, claimed.processGeneration, process?.identity, "failed", lease).catch(() => undefined);
      if (firstAllocation && !process) await this.#clearReservedAllocation(runId, role, lease).catch(() => undefined);
      throw error;
    } finally {
      await this.store.releaseLease(runId, leaseKey, owner, lease.fencingToken);
    }
  }

  async #getOrResolveRuntime(runId: string, lease?: AllocationLease, signal?: AbortSignal): Promise<RuntimeResolution> {
    const existing = this.#resolved.get(runId); if (existing) return existing;
    const resolution = this.#resolveAndRecord(runId, lease, signal);
    this.#resolved.set(runId, resolution);
    try { return await resolution; }
    catch (error) { if (this.#resolved.get(runId) === resolution) this.#resolved.delete(runId); throw error; }
  }

  async #resolveAndRecord(runId: string, lease?: AllocationLease, signal?: AbortSignal): Promise<RuntimeResolution> {
    let snapshot = await this.store.read(runId); if (!snapshot) throw new Error("run not found");
    if (snapshot.runtimeResolution) return snapshot.runtimeResolution;
    const observed = await this.resolver.resolve(runId, signal);
    if (signal?.aborted) throw new Error("runtime resolution aborted");
    for (;;) {
      snapshot = await this.store.read(runId); if (!snapshot) throw new Error("run not found");
      if (snapshot.runtimeResolution) return snapshot.runtimeResolution;
      try {
        const recorded = lease
          ? await this.store.recordRuntimeFenced(runId, { version: snapshot.version }, this.#guard(lease), observed)
          : await this.store.recordRuntime(runId, { version: snapshot.version }, observed);
        return recorded.runtimeResolution!;
      } catch (error) {
        if (!(error instanceof StoreConflictError)) throw error;
        const raced = await this.store.read(runId); if (raced?.runtimeResolution) return raced.runtimeResolution;
        if (lease) await this.#renew(lease);
      }
    }
  }

  async #reserveFirstAllocation(runId: string, role: Role, lease: AllocationLease): Promise<void> {
    for (;;) {
      const current = await this.store.read(runId); if (!current) throw new Error("run not found");
      if (current.sessions[role]) throw new StoreConflictError("role session appeared during first allocation");
      const prior = current.processAllocations?.[role];
      if (prior && (prior.owner !== lease.owner || prior.fencingToken !== lease.fencingToken) && prior.state !== "reserved") throw new StoreConflictError("prior first-session spawn requires reconciliation");
      const allocation: ProcessAllocation = { role, owner: lease.owner, fencingToken: lease.fencingToken, state: "reserved", allocatedAt: new Date(this.clock.now()).toISOString() };
      try {
        await this.store.compareAndSetFenced(runId, { version: current.version }, this.#guard(lease), snapshot => ({ ...snapshot, version: snapshot.version + 1, processAllocations: { ...snapshot.processAllocations, [role]: allocation } }));
        return;
      } catch (error) { if (!(error instanceof StoreConflictError)) throw error; await this.#renew(lease); }
    }
  }

  async #setFirstAllocation(runId: string, role: Role, lease: AllocationLease, state: "spawning" | "spawned", processIdentity?: string): Promise<void> {
    for (;;) {
      const current = await this.store.read(runId); if (!current) throw new Error("run not found");
      const allocation = current.processAllocations?.[role];
      if (!allocation || allocation.owner !== lease.owner || allocation.fencingToken !== lease.fencingToken) throw new ProcessLeaseError("first-session allocation ownership was fenced");
      if (state === "spawning" && allocation.state !== "reserved") throw new StoreConflictError("invalid first-session spawn intent");
      if (state === "spawned" && allocation.state !== "spawning") throw new StoreConflictError("invalid first-session spawn claim");
      const next = { ...allocation, state, ...(processIdentity ? { processIdentity } : {}) };
      try {
        await this.store.compareAndSetFenced(runId, { version: current.version }, this.#guard(lease), snapshot => ({ ...snapshot, version: snapshot.version + 1, processAllocations: { ...snapshot.processAllocations, [role]: next } }));
        return;
      } catch (error) { if (!(error instanceof StoreConflictError)) throw error; await this.#renew(lease); }
    }
  }

  async #clearReservedAllocation(runId: string, role: Role, lease: AllocationLease): Promise<void> {
    for (;;) {
      const current = await this.store.read(runId); if (!current) return;
      const allocation = current.processAllocations?.[role];
      if (!allocation || allocation.owner !== lease.owner || allocation.fencingToken !== lease.fencingToken || allocation.state !== "reserved") return;
      const processAllocations = { ...current.processAllocations }; delete processAllocations[role];
      try { await this.store.compareAndSetFenced(runId, { version: current.version }, this.#guard(lease), snapshot => ({ ...snapshot, version: snapshot.version + 1, processAllocations })); return; }
      catch (error) { if (!(error instanceof StoreConflictError)) throw error; await this.#renew(lease); }
    }
  }

  async #claimGeneration(existing: SessionRegistration, lease: AllocationLease): Promise<SessionRegistration> {
    for (;;) {
      const current = await this.store.read(existing.runId); if (!current) throw new Error("run not found");
      const session = current.sessions[existing.role]; if (!session) throw new Error("registered session disappeared");
      if (session.processState === "live" || session.processState === "launching") throw new Error("registered role still owns a live process generation");
      const { processIdentity: _previousIdentity, ...sessionWithoutIdentity } = session;
      const claimed = { ...sessionWithoutIdentity, processGeneration: session.processGeneration + 1, processState: "launching" as const };
      try {
        await this.store.compareAndSetFenced(existing.runId, { version: current.version }, this.#guard(lease), snapshot => ({ ...snapshot, version: snapshot.version + 1, sessions: { ...snapshot.sessions, [existing.role]: claimed } }));
        return claimed;
      } catch (error) { if (!(error instanceof StoreConflictError)) throw error; await this.#renew(lease); }
    }
  }

  async #markProcess(runId: string, role: Role, generation: number, identity: string | undefined, state: "live" | "exited" | "failed"): Promise<void> {
    await this.#mutateProcess(runId, role, generation, identity, state);
  }

  async #markProcessFenced(runId: string, role: Role, generation: number, identity: string | undefined, state: "live" | "exited" | "failed", lease: AllocationLease): Promise<void> {
    await this.#mutateProcess(runId, role, generation, identity, state, lease);
  }

  async #mutateProcess(runId: string, role: Role, generation: number, identity: string | undefined, state: "live" | "exited" | "failed", lease?: AllocationLease): Promise<void> {
    for (;;) {
      const current = await this.store.read(runId); if (!current) return;
      const session = current.sessions[role];
      if (!session || session.processGeneration !== generation) return;
      if (state === "exited" && session.processState === "failed") return;
      if (state === "exited" && identity && session.processIdentity && session.processIdentity !== identity) return;
      const next = { ...session, processState: state, ...(identity ? { processIdentity: identity } : {}) };
      try {
        const mutate = (snapshot: typeof current) => ({ ...snapshot, version: snapshot.version + 1, sessions: { ...snapshot.sessions, [role]: next } });
        if (lease) await this.store.compareAndSetFenced(runId, { version: current.version }, this.#guard(lease), mutate);
        else await this.store.compareAndSet(runId, { version: current.version }, mutate);
        return;
      } catch (error) { if (!(error instanceof StoreConflictError)) throw error; if (lease) await this.#renew(lease); }
    }
  }

  async #registerFirstSession(registration: SessionRegistration, lease: AllocationLease): Promise<void> {
    for (;;) {
      const current = await this.store.read(registration.runId); if (!current) throw new Error("run not found");
      const existing = current.sessions[registration.role];
      if (existing) { if (existing.sessionId !== registration.sessionId || existing.sessionFile !== registration.sessionFile) throw new Error("conflicting role session registration"); return; }
      const conflictingIdentity = Object.values(current.sessions).find(session => session?.sessionId === registration.sessionId || session?.sessionFile === registration.sessionFile);
      if (conflictingIdentity) throw new Error("conflicting session identity registration");
      const allocation = current.processAllocations?.[registration.role];
      if (!allocation || allocation.owner !== lease.owner || allocation.fencingToken !== lease.fencingToken || allocation.state !== "spawned" || allocation.processIdentity !== registration.processIdentity) throw new ProcessLeaseError("first-session registration lost spawned allocation ownership");
      try { await this.store.registerSessionFenced(registration.runId, { version: current.version }, this.#guard(lease), registration); return; }
      catch (error) { if (!(error instanceof StoreConflictError)) throw error; await this.#renew(lease); }
    }
  }

  async #step<T>(name: string, lease: AllocationLease, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    await this.#renew(lease);
    const remaining = lease.deadlineAt - this.clock.now();
    if (remaining <= 0) throw new ProcessLeaseError("process allocation deadline expired");
    const timeoutMs = Math.min(lease.stepTimeoutMs, remaining);
    const controller = new AbortController();
    const wait = this.clock.sleep(timeoutMs, controller.signal).catch(error => {
      if (controller.signal.aborted) return new Promise<void>(() => undefined);
      throw error;
    });
    const timeout: Promise<T> = wait.then(() => { controller.abort(); throw new Error(`${name} exceeded bounded allocation step`); });
    try {
      const result = await Promise.race([operation(controller.signal), timeout]);
      controller.abort();
      await this.#renew(lease);
      return result;
    } catch (error) {
      controller.abort();
      await this.#renew(lease).catch(renewalError => { throw renewalError; });
      throw error;
    }
  }

  async #renew(lease: AllocationLease): Promise<void> {
    const now = this.clock.now();
    const remaining = lease.deadlineAt - now;
    if (remaining <= 0) throw new ProcessLeaseError("process allocation deadline expired");
    const ttlMs = Math.min(remaining, Math.max(lease.ttlMs, lease.stepTimeoutMs + 1));
    const renewed = await this.store.renewLease(lease.runId, lease.key, lease.owner, lease.fencingToken, now, ttlMs);
    if (!renewed) throw new ProcessLeaseError("process allocation lease was fenced or expired");
    lease.expiresAt = renewed.expiresAt;
  }

  #guard(lease: AllocationLease): LeaseGuard { return { key: lease.key, owner: lease.owner, fencingToken: lease.fencingToken, now: this.clock.now() }; }

  release(runId: string, role: Role): void {
    const key = `${runId}:${role}`; const owned = this.live.get(key);
    if (owned?.process.exitCode === null) throw new Error("cannot release ownership of a live process");
    this.live.delete(key);
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
