import type { Clock, Role, RuntimeResolution, SessionRegistration } from "../control/domain.js";
import type { WorkflowStore } from "../control/workflow-store.js";
import { StoreConflictError } from "../control/workflow-store.js";
import { buildPiCommand, assertSafeResumeArgs, type PiRoleConfig } from "./pi-command.js";
import type { PiProcess, PiProcessFactory, RuntimeResolver } from "./pi-process.js";
import { PiRpcClient, type PiState } from "./pi-rpc-client.js";

export interface RunnerConfig { roles: Record<Role, PiRoleConfig>; workspace?: string; sessionRoot?: string; commandTimeoutMs?: number; processLeaseMs?: number }
export type RegistrationValidator = (registration: SessionRegistration) => Promise<void>;
export type RoleInstructionReader = (canonicalPath: string) => Promise<string>;
interface LiveHandle { process: PiProcess; client: PiRpcClient; runId: string; role: Role; generation: number }

export class PiRunner {
  readonly live = new Map<string, LiveHandle>();
  readonly #resolved = new Map<string, Promise<RuntimeResolution>>();
  #ownerSequence = 0;
  constructor(readonly factory: PiProcessFactory, readonly resolver: RuntimeResolver, readonly store: WorkflowStore, readonly config: RunnerConfig, readonly validateRegistration: RegistrationValidator, readonly readRoleInstructions: RoleInstructionReader, readonly clock: Clock) {}

  resolveRuntime(runId: string): Promise<RuntimeResolution> {
    const existing = this.#resolved.get(runId); if (existing) return existing;
    const resolution = this.#resolveAndRecord(runId); this.#resolved.set(runId, resolution); return resolution;
  }
  async #resolveAndRecord(runId: string): Promise<RuntimeResolution> {
    const snapshot = await this.store.read(runId); if (!snapshot) throw new Error("run not found");
    if (snapshot.runtimeResolution) return snapshot.runtimeResolution;
    const observed = await this.resolver.resolve(runId);
    try { return (await this.store.recordRuntime(runId, { version: snapshot.version }, observed)).runtimeResolution!; }
    catch (error) { if (!(error instanceof StoreConflictError)) throw error; const raced = await this.store.read(runId); if (!raced?.runtimeResolution) throw error; return raced.runtimeResolution; }
  }

  async launch(runId: string, role: Role): Promise<{ process: PiProcess; client: PiRpcClient; state: PiState; runtime: RuntimeResolution }> {
    const key = `${runId}:${role}`;
    const owned = this.live.get(key);
    if (owned?.process.exitCode === null) throw new Error("role already has a live process");
    if (owned) this.live.delete(key);
    const owner = `runner-${++this.#ownerSequence}`;
    const leaseKey = `process:${role}`;
    const lease = await this.store.acquireLease(runId, leaseKey, owner, this.clock.now(), this.config.processLeaseMs ?? 30_000);
    if (!lease) throw new Error("role process lease is held");
    let claimed: SessionRegistration | undefined;
    let process: PiProcess | undefined;
    try {
      const runtime = await this.resolveRuntime(runId);
      const existing = await this.store.getSession(runId, role);
      if (existing) {
        await this.validateRegistration(existing);
        claimed = await this.#claimGeneration(existing);
      }
      const instructions = await this.readRoleInstructions(this.config.roles[role].instructionsPath);
      if (instructions.length === 0) throw new Error("role instructions are empty");
      const spec = buildPiCommand({ role, config: this.config.roles[role], instructions, piBinary: runtime.pi.executable, ...(this.config.workspace ? { workspace: this.config.workspace } : {}), ...(this.config.sessionRoot ? { sessionRoot: this.config.sessionRoot } : {}), ...(claimed ? { registration: claimed } : {}) });
      if (claimed) assertSafeResumeArgs(spec.args, claimed.sessionFile);
      process = await this.factory.spawn(spec);
      const client = new PiRpcClient(process, { commandTimeoutMs: this.config.commandTimeoutMs ?? 5_000 });
      const generation = claimed?.processGeneration ?? 1;
      this.live.set(key, { process, client, runId, role, generation });
      client.on("protocol_error", () => { void this.#markProcess(runId, role, generation, process!.identity, "failed"); });
      process.on("exit", () => { void this.#markProcess(runId, role, generation, process!.identity, "exited").finally(() => { if (this.live.get(key)?.process === process) this.live.delete(key); }); });
      const state = await client.getState();
      if (state.model?.provider !== this.config.roles[role].provider || state.model?.id !== this.config.roles[role].model) throw new Error("Pi handshake model mismatch");
      if (claimed && (state.sessionId !== claimed.sessionId || state.sessionFile !== claimed.sessionFile)) throw new Error("Pi resume handshake identity mismatch");
      if (!claimed) {
        const registration = registrationFromState(runId, role, state, generation, runtime.resolvedAt, process.identity, "live");
        await this.#registerFirstSession(registration);
      } else await this.#markProcess(runId, role, generation, process.identity, "live");
      return { process, client, state, runtime };
    } catch (error) {
      if (process?.exitCode === null) process.kill("SIGTERM");
      if (claimed) await this.#markProcess(runId, role, claimed.processGeneration, process?.identity, "failed").catch(() => undefined);
      throw error;
    } finally { await this.store.releaseLease(runId, leaseKey, owner, lease.fencingToken); }
  }

  async #claimGeneration(existing: SessionRegistration): Promise<SessionRegistration> {
    for (;;) {
      const current = await this.store.read(existing.runId); if (!current) throw new Error("run not found");
      const session = current.sessions[existing.role]; if (!session) throw new Error("registered session disappeared");
      if (session.processState === "live" || session.processState === "launching") throw new Error("registered role still owns a live process generation");
      const { processIdentity: _previousIdentity, ...sessionWithoutIdentity } = session;
      const claimed = { ...sessionWithoutIdentity, processGeneration: session.processGeneration + 1, processState: "launching" as const };
      try {
        await this.store.compareAndSet(existing.runId, { version: current.version }, snapshot => ({ ...snapshot, version: snapshot.version + 1, sessions: { ...snapshot.sessions, [existing.role]: claimed } }));
        return claimed;
      } catch (error) { if (!(error instanceof StoreConflictError)) throw error; }
    }
  }

  async #markProcess(runId: string, role: Role, generation: number, identity: string | undefined, state: "live" | "exited" | "failed"): Promise<void> {
    for (;;) {
      const current = await this.store.read(runId); if (!current) return;
      const session = current.sessions[role];
      if (!session || session.processGeneration !== generation) return;
      if (state === "exited" && session.processState === "failed") return;
      if (state === "exited" && identity && session.processIdentity && session.processIdentity !== identity) return;
      const next = { ...session, processState: state, ...(identity ? { processIdentity: identity } : {}) };
      try { await this.store.compareAndSet(runId, { version: current.version }, snapshot => ({ ...snapshot, version: snapshot.version + 1, sessions: { ...snapshot.sessions, [role]: next } })); return; }
      catch (error) { if (!(error instanceof StoreConflictError)) throw error; }
    }
  }

  async #registerFirstSession(registration: SessionRegistration): Promise<void> {
    await this.validateRegistration(registration);
    for (;;) {
      const current = await this.store.read(registration.runId); if (!current) throw new Error("run not found");
      const existing = current.sessions[registration.role];
      if (existing) { if (existing.sessionId !== registration.sessionId || existing.sessionFile !== registration.sessionFile) throw new Error("conflicting role session registration"); return; }
      try { await this.store.registerSession(registration.runId, { version: current.version }, registration); return; }
      catch (error) { if (!(error instanceof StoreConflictError)) throw error; }
    }
  }

  release(runId: string, role: Role): void {
    const key = `${runId}:${role}`; const owned = this.live.get(key);
    if (owned?.process.exitCode === null) throw new Error("cannot release ownership of a live process");
    this.live.delete(key);
  }
}

export function registrationFromState(runId: string, role: Role, state: PiState, generation: number, registeredAt: string, processIdentity?: string, processState: SessionRegistration["processState"] = "registered"): SessionRegistration {
  if (!state.sessionId || !state.sessionFile) throw new Error("Pi state omitted session identity");
  return { runId, role, sessionId: state.sessionId, sessionFile: state.sessionFile, processGeneration: generation, processState, ...(processIdentity ? { processIdentity } : {}), registeredAt };
}
