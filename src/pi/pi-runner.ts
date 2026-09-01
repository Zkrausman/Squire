import type { Role, RuntimeResolution, SessionRegistration } from "../control/domain.js";
import type { WorkflowStore } from "../control/workflow-store.js";
import { StoreConflictError } from "../control/workflow-store.js";
import { buildPiCommand, assertSafeResumeArgs, type PiRoleConfig } from "./pi-command.js";
import type { PiProcess, PiProcessFactory, RuntimeResolver } from "./pi-process.js";
import { PiRpcClient, type PiState } from "./pi-rpc-client.js";

export interface RunnerConfig { roles: Record<Role, PiRoleConfig>; workspace?: string; sessionRoot?: string; commandTimeoutMs?: number }
export type RegistrationValidator = (registration: SessionRegistration) => Promise<void>;
export type RoleInstructionReader = (canonicalPath: string) => Promise<string>;
export class PiRunner {
  readonly live = new Map<Role, { process: PiProcess; client: PiRpcClient }>();
  readonly #resolved = new Map<string, Promise<RuntimeResolution>>();
  constructor(readonly factory: PiProcessFactory, readonly resolver: RuntimeResolver, readonly store: WorkflowStore, readonly config: RunnerConfig, readonly validateRegistration: RegistrationValidator, readonly readRoleInstructions: RoleInstructionReader) {}
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
    if (this.live.has(role)) throw new Error("role already has a live process");
    const runtime = await this.resolveRuntime(runId);
    const existing = await this.store.getSession(runId, role);
    if (existing) await this.validateRegistration(existing);
    const instructions = await this.readRoleInstructions(this.config.roles[role].instructionsPath);
    if (instructions.length === 0) throw new Error("role instructions are empty");
    const spec = buildPiCommand({ role, config: this.config.roles[role], instructions, piBinary: runtime.pi.executable, ...(this.config.workspace ? { workspace: this.config.workspace } : {}), ...(this.config.sessionRoot ? { sessionRoot: this.config.sessionRoot } : {}), ...(existing ? { registration: existing } : {}) });
    if (existing) assertSafeResumeArgs(spec.args, existing.sessionFile);
    const process = await this.factory.spawn(spec); const client = new PiRpcClient(process, { commandTimeoutMs: this.config.commandTimeoutMs ?? 5_000 }); this.live.set(role, { process, client });
    try {
      const state = await client.getState();
      if (state.model?.provider !== this.config.roles[role].provider || state.model?.id !== this.config.roles[role].model) throw new Error("Pi handshake model mismatch");
      if (existing && (state.sessionId !== existing.sessionId || state.sessionFile !== existing.sessionFile)) throw new Error("Pi resume handshake identity mismatch");
      if (!existing) await this.#registerFirstSession(registrationFromState(runId, role, state, 1, runtime.resolvedAt));
      return { process, client, state, runtime };
    } catch (error) { this.live.delete(role); process.kill("SIGTERM"); throw error; }
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
  release(role: Role): void { this.live.delete(role); }
}
export function registrationFromState(runId: string, role: Role, state: PiState, generation: number, registeredAt: string): SessionRegistration {
  if (!state.sessionId || !state.sessionFile) throw new Error("Pi state omitted session identity");
  return { runId, role, sessionId: state.sessionId, sessionFile: state.sessionFile, processGeneration: generation, registeredAt };
}
