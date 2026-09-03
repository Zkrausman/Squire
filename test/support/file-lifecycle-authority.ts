import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunPreparationLease, RunTerminalFence } from "../../src/control/domain.js";
import type { RunQuiescenceAuthority } from "../../src/control/workflow-store.js";

interface FileLifecycleState {
  runId: string;
  version: number;
  preparationLeases: RunPreparationLease[];
  terminalFence?: RunTerminalFence;
}

/** Cross-process test adapter for the lifecycle transaction contract. */
export class FileLifecycleAuthority implements RunQuiescenceAuthority {
  readonly #statePath: string;
  readonly #lockPath: string;
  readonly #runId: string;

  private constructor(root: string, runId: string) {
    this.#statePath = path.join(root, "lifecycle-state.json");
    this.#lockPath = path.join(root, "lifecycle-state.lock");
    this.#runId = runId;
  }

  static async open(root: string, runId: string): Promise<FileLifecycleAuthority> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const authority = new FileLifecycleAuthority(root, runId);
    try {
      await readFile(authority.#statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(authority.#statePath, `${JSON.stringify({ runId, version: 0, preparationLeases: [] })}\n`, { flag: "wx", mode: 0o600 });
    }
    return authority;
  }

  async assertRunStartAllowed(runId: string): Promise<void> {
    const state = await this.#read();
    if (state.runId !== runId) throw new Error("run identity changed");
    if (state.terminalFence) throw new Error("run has a permanent terminal fence");
  }

  async acquireRunPreparationLease(runId: string, owner: string, now = Date.now()): Promise<RunPreparationLease> {
    return this.#update(state => {
      this.#assertRun(state, runId);
      if (state.terminalFence) throw new Error("run has a permanent terminal fence");
      const lease: RunPreparationLease = { runId, owner, fencingToken: state.version + 1, acquiredAt: new Date(now).toISOString(), state: "held" };
      state.preparationLeases.push(lease);
      state.version += 1;
      return { result: structuredClone(lease), state };
    });
  }

  async releaseRunPreparationLease(runId: string, lease: RunPreparationLease): Promise<void> {
    await this.#update(state => {
      this.#assertRun(state, runId);
      const remaining = state.preparationLeases.filter(candidate => candidate.owner !== lease.owner || candidate.fencingToken !== lease.fencingToken);
      if (remaining.length === state.preparationLeases.length) return { result: undefined, state };
      state.preparationLeases = remaining;
      state.version += 1;
      return { result: undefined, state };
    });
  }

  async acquireRunTerminalFence(runId: string, owner: string, now = Date.now()): Promise<RunTerminalFence> {
    return this.#update(state => {
      this.#assertRun(state, runId);
      this.#assertQuiescent(state);
      if (state.terminalFence) return { result: structuredClone(state.terminalFence), state };
      const fence: RunTerminalFence = { runId, owner, fencingToken: state.version + 1, acquiredAt: new Date(now).toISOString(), state: "held" };
      state.terminalFence = fence;
      state.version += 1;
      return { result: structuredClone(fence), state };
    });
  }

  async assertRunTeardownQuiescent(runId: string, fence: RunTerminalFence): Promise<void> {
    const state = await this.#read();
    this.#assertRun(state, runId);
    const persisted = state.terminalFence;
    if (fence.state !== "held" || !persisted || persisted.state !== "held" || persisted.runId !== fence.runId || persisted.owner !== fence.owner || persisted.fencingToken !== fence.fencingToken) throw new Error("terminal fence ownership changed");
    this.#assertQuiescent(state);
  }

  async completeRunTeardown(runId: string, fence: RunTerminalFence): Promise<void> {
    await this.#update(state => {
      this.#assertRun(state, runId);
      const persisted = state.terminalFence;
      if (!persisted || persisted.runId !== fence.runId || persisted.owner !== fence.owner || persisted.fencingToken !== fence.fencingToken) throw new Error("terminal fence ownership changed");
      if (persisted.state === "removed") return { result: undefined, state };
      this.#assertQuiescent(state);
      state.terminalFence = { ...persisted, state: "removed" };
      state.version += 1;
      return { result: undefined, state };
    });
  }

  async #read(): Promise<FileLifecycleState> {
    return JSON.parse(await readFile(this.#statePath, "utf8")) as FileLifecycleState;
  }

  async #update<T>(mutate: (state: FileLifecycleState) => { result: T; state: FileLifecycleState }): Promise<T> {
    for (;;) {
      try {
        await mkdir(this.#lockPath, { recursive: false, mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await new Promise(resolve => setTimeout(resolve, 2));
      }
    }
    try {
      const state = await this.#read();
      const updated = mutate(structuredClone(state));
      const temporary = `${this.#statePath}.tmp-${randomUUID()}`;
      await writeFile(temporary, `${JSON.stringify(updated.state)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, this.#statePath);
      return updated.result;
    } finally {
      try { await rmdir(this.#lockPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  #assertRun(state: FileLifecycleState, runId: string): void {
    if (state.runId !== this.#runId || runId !== this.#runId) throw new Error("run identity changed");
  }

  #assertQuiescent(state: FileLifecycleState): void {
    if (state.preparationLeases.some(lease => lease.state === "held")) throw new Error("workflow is not durably quiescent: preparation lease remains");
  }
}
