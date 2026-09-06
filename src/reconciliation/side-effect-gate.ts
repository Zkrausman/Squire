import { SIDE_EFFECT_PERMIT_BRAND, type RunSideEffectGuard, type SideEffectPermit } from "../control/domain.js";
import { StoreConflictError } from "../control/workflow-store.js";

export interface GateGeneration { readonly generation: number; readonly controllerOwner: string; readonly fencingToken: number; readonly issuedAt: number; readonly runIds: ReadonlySet<string>; readonly databaseIdentity?: string; }

/** In-memory capability cache backed by the durable reconciliation cycle.  It
 * starts closed on every process and is invalidated on takeover/blocked runs. */
export class ReconciledSideEffectGate implements RunSideEffectGuard {
  #generation: GateGeneration | undefined;
  #permits = new Map<string, SideEffectPermit>();
  #authority: (() => boolean) | undefined;
  setAuthority(authority: () => boolean): void { this.#authority = authority; }
  open(generation: GateGeneration): void {
    if (!Number.isSafeInteger(generation.generation) || generation.generation < 0 || !generation.controllerOwner || !Number.isSafeInteger(generation.fencingToken)) throw new StoreConflictError("invalid reconciliation permit generation");
    this.#generation = { ...generation, runIds: new Set(generation.runIds) };
    this.#permits.clear();
  }
  invalidate(): void { this.#generation = undefined; this.#permits.clear(); }
  require(runId: string): SideEffectPermit {
    const generation = this.#generation;
    if (!generation || !generation.runIds.has(runId) || (this.#authority && !this.#authority())) throw new StoreConflictError("startup reconciliation has not issued a side-effect permit");
    const prior = this.#permits.get(runId); if (prior) { this.assertValid(runId, prior); return prior; }
    const permit = { runId, databaseIdentity: generation.databaseIdentity ?? "sqlite", reconciliationGeneration: generation.generation, controllerOwner: generation.controllerOwner, fencingToken: generation.fencingToken, issuedAt: generation.issuedAt, [SIDE_EFFECT_PERMIT_BRAND]: true as const } as SideEffectPermit;
    this.#permits.set(runId, permit);
    return permit;
  }
  assertValid(runId: string, permit: SideEffectPermit): void {
    const generation = this.#generation;
    if (!generation || (this.#authority && !this.#authority()) || !permit || permit !== this.#permits.get(runId) || permit.runId !== runId || permit[ SIDE_EFFECT_PERMIT_BRAND ] !== true || permit.reconciliationGeneration !== generation.generation || permit.controllerOwner !== generation.controllerOwner || permit.fencingToken !== generation.fencingToken || permit.databaseIdentity !== (generation.databaseIdentity ?? "sqlite")) throw new StoreConflictError("side-effect permit is stale or fenced");
  }
  /** Alias used by adapter composition code. */
  assertPermit(runId: string, permit: SideEffectPermit): void { this.assertValid(runId, permit); }
  get ready(): boolean { if (!this.#generation) return false; try { return !this.#authority || this.#authority(); } catch { return false; } }
}
export const SideEffectGate = ReconciledSideEffectGate;
