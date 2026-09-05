import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rmdir, unlink, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { assertRunId } from "../../src/git/identity.js";
import { canonicalBytes } from "../../src/sandbox/identity.js";
import type { Lease, RunPreparationLease, RunTerminalFence } from "../../src/control/domain.js";
import type { RunTeardownRecord } from "../../src/sandbox/domain.js";
import type { RunQuiescenceAuthority } from "../../src/control/workflow-store.js";

interface FileLifecycleState {
  runId: string;
  version: number;
  preparationLeases: RunPreparationLease[];
  teardown?: RunTeardownRecord;
  teardownLease?: Lease;
  teardownLeaseToken?: number;
  terminalFence?: RunTerminalFence;
}

interface LockOwner {
  pid: number;
  startTime: string;
  token: string;
}

interface LockHandle {
  readonly token: string;
  readonly ownerPath: string;
}

const LOCK_WAIT_MS = 10_000;
const STALE_EMPTY_LOCK_MS = 5_000;
const MAX_STATE_BYTES = 1_048_576;
const OWNER_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/u;

/**
 * Cross-process test adapter for the lifecycle transaction contract.
 *
 * This deliberately behaves like a small durable store rather than a
 * best-effort JSON fixture: state is canonical and private, writes are
 * fsync'd before the atomic replacement, and the lock records a PID plus
 * Linux process start time so a crashed/reused PID cannot reclaim a live
 * transaction. It remains test support, not an AIDEV-224 SQLite substitute.
 */
export class FileLifecycleAuthority implements RunQuiescenceAuthority {
  readonly #root: string;
  readonly #statePath: string;
  readonly #lockPath: string;
  readonly #runId: string;

  private constructor(root: string, runId: string) {
    this.#root = root;
    this.#statePath = path.join(root, "lifecycle-state.json");
    this.#lockPath = path.join(root, "lifecycle-state.lock");
    this.#runId = runId;
  }

  static async open(root: string, runId: string): Promise<FileLifecycleAuthority> {
    assertCanonicalRoot(root);
    assertRunId(runId);
    try { await mkdir(root, { recursive: false, mode: 0o700 }); }
    catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
    await assertPrivateDirectory(root);
    const authority = new FileLifecycleAuthority(root, runId);
    try {
      const state = await authority.#read();
      if (state.runId !== runId) throw new Error("lifecycle state is bound to a different run");
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
      const initial: FileLifecycleState = { runId, version: 0, preparationLeases: [] };
      try { await authority.#writeState(initial, true); }
      catch (writeError) {
        if (!isCode(writeError, "EEXIST")) throw writeError;
        // Another controller may have initialized the state between the read
        // and the exclusive write. Validate the winner instead of accepting
        // an unbound or partially written file.
        const state = await authority.#read();
        if (state.runId !== runId) throw new Error("lifecycle state is bound to a different run");
      }
    }
    return authority;
  }

  async assertRunStartAllowed(runId: string): Promise<void> {
    const state = await this.#read();
    this.#assertRun(state, runId);
    if (state.terminalFence || state.teardown) throw new Error("run has a permanent terminal fence (teardown drain)");
  }

  async acquireRunPreparationLease(runId: string, owner: string, now = Date.now()): Promise<RunPreparationLease> {
    return this.#update(state => {
      this.#assertRun(state, runId);
      assertOwner(owner); assertTimestamp(now);
      if (state.terminalFence || state.teardown) throw new Error("run has a permanent terminal fence (teardown drain)");
      const lease: RunPreparationLease = { runId, owner, fencingToken: state.version + 1, acquiredAt: new Date(now).toISOString(), state: "held" };
      state.preparationLeases.push(lease);
      state.version += 1;
      return { result: structuredClone(lease), state };
    });
  }

  async releaseRunPreparationLease(runId: string, lease: RunPreparationLease): Promise<void> {
    await this.#update(state => {
      this.#assertRun(state, runId);
      if (!lease || lease.runId !== runId || lease.state !== "held" || !OWNER_PATTERN.test(lease.owner) || !Number.isSafeInteger(lease.fencingToken) || lease.fencingToken <= 0) throw new Error("preparation lease identity is invalid");
      const remaining = state.preparationLeases.filter(candidate => candidate.owner !== lease.owner || candidate.fencingToken !== lease.fencingToken);
      if (remaining.length === state.preparationLeases.length) return { result: undefined, state };
      state.preparationLeases = remaining;
      state.version += 1;
      return { result: undefined, state };
    });
  }

  async beginRunTeardown(runId: string, owner: string, reason: RunTeardownRecord["reason"] = "retention", now = Date.now()): Promise<RunTeardownRecord> {
    return this.#update(state => {
      this.#assertRun(state, runId);
      assertOwner(owner); assertTimestamp(now);
      if (!["retention", "terminal", "operator"].includes(reason)) throw new Error("teardown reason is invalid");
      if (state.teardown) {
        if (state.teardown.reason !== reason) throw new Error("teardown reason changed for the durable drain");
        return { result: structuredClone(state.teardown), state };
      }
      if (state.terminalFence?.state === "removed") throw new Error("run has been removed");
      const teardown: RunTeardownRecord = { runId, owner, generation: 1, state: "draining", reason, requestedAt: new Date(now).toISOString() };
      state.teardown = teardown; state.version += 1;
      return { result: structuredClone(teardown), state };
    });
  }

  async acquireRunTeardownLease(runId: string, owner: string, now = Date.now(), ttlMs = 30_000): Promise<Lease | undefined> {
    return this.#update(state => {
      this.#assertRun(state, runId);
      if (!state.teardown || state.teardown.state === "blocked" || state.teardown.state === "completed" || state.terminalFence?.state === "removed") return { result: undefined, state };
      if (!OWNER_PATTERN.test(owner) || !Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 300_000 || now < 0) return { result: undefined, state };
      const current = state.teardownLease;
      if (current && current.expiresAt > now) return { result: current.owner === owner ? structuredClone(current) : undefined, state };
      const next: Lease = { key: "teardown", owner, fencingToken: (state.teardownLeaseToken ?? current?.fencingToken ?? 0) + 1, expiresAt: now + ttlMs };
      state.teardownLeaseToken = next.fencingToken;
      state.teardownLease = next;
      state.version += 1;
      return { result: structuredClone(next), state };
    });
  }

  async renewRunTeardownLease(runId: string, owner: string, fencingToken: number, now = Date.now(), ttlMs = 30_000): Promise<Lease | undefined> {
    return this.#update(state => {
      this.#assertRun(state, runId);
      const current = state.teardownLease;
      if (!state.teardown || state.teardown.state === "blocked" || state.teardown.state === "completed" || state.terminalFence?.state === "removed" || !current || current.key !== "teardown" || current.owner !== owner || current.fencingToken !== fencingToken || current.expiresAt <= now || !OWNER_PATTERN.test(owner) || !Number.isSafeInteger(fencingToken) || fencingToken <= 0 || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 300_000) return { result: undefined, state };
      const next = { ...current, expiresAt: now + ttlMs };
      state.teardownLease = next;
      state.version += 1;
      return { result: structuredClone(next), state };
    });
  }

  async releaseRunTeardownLease(runId: string, owner: string, fencingToken: number): Promise<void> {
    await this.#update(state => {
      this.#assertRun(state, runId);
      if (!OWNER_PATTERN.test(owner) || !Number.isSafeInteger(fencingToken) || fencingToken <= 0) throw new Error("teardown lease identity is invalid");
      if (state.teardownLease?.owner === owner && state.teardownLease.fencingToken === fencingToken) {
        delete state.teardownLease;
        state.version += 1;
      }
      return { result: undefined, state };
    });
  }

  async blockRunTeardown(runId: string, owner: string, error: { readonly code: string; readonly message: string }, now = Date.now()): Promise<RunTeardownRecord> {
    return this.#update(state => {
      this.#assertRun(state, runId);
      if (!state.teardown) throw new Error("teardown intent is absent");
      if (state.teardown.state === "blocked") return { result: structuredClone(state.teardown), state };
      if (state.teardown.state === "completed" || state.teardown.owner !== owner || !error || !/^[A-Za-z0-9._:-]{1,128}$/u.test(error.code) || typeof error.message !== "string" || error.message.length === 0 || error.message.length > 1_000 || /[\u0000-\u001f\u007f\r\n]/u.test(error.message) || !Number.isSafeInteger(now) || now < 0) throw new Error("teardown block ownership or error is invalid");
      state.teardown = { ...state.teardown, state: "blocked", error: { code: error.code, message: error.message, at: new Date(now).toISOString() } };
      state.version += 1;
      return { result: structuredClone(state.teardown), state };
    });
  }

  async acquireRunTerminalFence(runId: string, owner: string, now = Date.now()): Promise<RunTerminalFence> {
    return this.#update(state => {
      this.#assertRun(state, runId);
      assertOwner(owner); assertTimestamp(now);
      if (state.teardown?.state === "blocked" || state.teardown?.state === "completed") throw new Error("teardown is durably blocked or completed");
      this.#assertQuiescent(state);
      if (state.terminalFence) {
        if (state.terminalFence.runId !== runId || state.terminalFence.state !== "held") throw new Error("terminal fence ownership changed");
        return { result: structuredClone(state.terminalFence), state };
      }
      const fence: RunTerminalFence = { runId, owner, fencingToken: state.version + 1, acquiredAt: new Date(now).toISOString(), state: "held" };
      state.terminalFence = fence;
      state.teardown = { ...(state.teardown ?? { runId, owner, generation: 1, state: "draining" as const, reason: "terminal" as const, requestedAt: new Date(now).toISOString() }), state: "fenced" as const, fence };
      state.version += 1;
      return { result: structuredClone(fence), state };
    });
  }

  async assertRunTeardownQuiescent(runId: string, fence: RunTerminalFence): Promise<void> {
    const state = await this.#read();
    this.#assertRun(state, runId);
    const persisted = state.terminalFence;
    if (state.teardown?.state === "blocked" || state.teardown?.state === "completed" || fence.runId !== runId || fence.state !== "held" || !persisted || persisted.state !== "held" || persisted.runId !== fence.runId || persisted.owner !== fence.owner || persisted.fencingToken !== fence.fencingToken) throw new Error("terminal fence ownership changed");
    this.#assertQuiescent(state);
  }

  async completeRunTeardown(runId: string, fence: RunTerminalFence): Promise<void> {
    await this.#update(state => {
      this.#assertRun(state, runId);
      const persisted = state.terminalFence;
      if (fence.runId !== runId || !persisted || persisted.runId !== fence.runId || persisted.owner !== fence.owner || persisted.fencingToken !== fence.fencingToken) throw new Error("terminal fence ownership changed");
      if (persisted.state === "removed") return { result: undefined, state };
      if (state.teardown?.state === "blocked" || state.teardown?.state === "completed" || fence.state !== "held" || persisted.state !== "held") throw new Error("terminal fence ownership changed");
      this.#assertQuiescent(state);
      const removed = { ...persisted, state: "removed" as const };
      state.terminalFence = removed;
      if (state.teardown) state.teardown = { ...state.teardown, state: "completed" as const, fence: removed };
      state.version += 1;
      return { result: undefined, state };
    });
  }

  async #read(): Promise<FileLifecycleState> {
    const handle = await open(this.#statePath, constants.O_RDONLY | constants.O_NOFOLLOW!);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > MAX_STATE_BYTES) throw new Error("lifecycle state is not a private bounded regular file");
      const bytes = await handle.readFile();
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      assertStoredState(parsed);
      if (!Buffer.from(canonicalBytes(parsed)).equals(bytes)) throw new Error("lifecycle state is not canonically serialized");
      return structuredClone(parsed);
    } finally { await handle.close(); }
  }

  async #writeState(state: FileLifecycleState, allowMissing = false): Promise<void> {
    assertStoredState(state);
    const bytes = canonicalBytes(state);
    const current = await lstat(this.#statePath).catch(error => { if (isCode(error, "ENOENT")) return undefined; throw error; });
    if (!current && allowMissing) {
      let initialHandle: FileHandle | undefined;
      try {
        initialHandle = await open(this.#statePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW!, 0o600);
        await initialHandle.writeFile(bytes); await initialHandle.chmod(0o600); await initialHandle.sync();
      } finally { await initialHandle?.close(); }
      const directory = await open(this.#root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW!);
      try { await directory.sync(); } finally { await directory.close(); }
      return;
    }
    if (!current || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || (current.mode & 0o077) !== 0) throw new Error("lifecycle state target is not a private regular file");
    const temporary = `${this.#statePath}.tmp-${randomUUID()}`;
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW!, 0o600);
      await handle.writeFile(bytes); await handle.chmod(0o600); await handle.sync();
      await rename(temporary, this.#statePath);
      const directory = await open(this.#root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW!);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await unlink(temporary).catch(unlinkError => { if (!isCode(unlinkError, "ENOENT")) throw unlinkError; });
      throw error;
    } finally { await handle?.close(); }
  }

  async #acquireLock(): Promise<LockHandle> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      const token = randomUUID();
      try {
        await mkdir(this.#lockPath, { recursive: false, mode: 0o700 });
        const ownerPath = path.join(this.#lockPath, "owner.json");
        const owner: LockOwner = { pid: process.pid, startTime: await processStartTime(process.pid), token };
        await writeFile(ownerPath, canonicalBytes(owner), { flag: "wx", mode: 0o600 });
        await assertPrivateFile(ownerPath);
        return { token, ownerPath };
      } catch (error) {
        if (!isCode(error, "EEXIST")) {
          // If the owner file failed after mkdir, only remove an empty lock
          // directory. Never recursively clean a lock path.
          await rmdir(this.#lockPath).catch(removeError => { if (!isCode(removeError, "ENOENT") && !isCode(removeError, "ENOTEMPTY")) throw removeError; });
          throw error;
        }
        await this.#reclaimDeadLock();
        if (Date.now() >= deadline) throw new Error("lifecycle state lock acquisition timed out");
        await new Promise(resolve => setTimeout(resolve, 2));
      }
    }
  }

  async #reclaimDeadLock(): Promise<void> {
    const info = await lstat(this.#lockPath).catch(error => { if (isCode(error, "ENOENT")) return undefined; throw error; });
    if (!info) return;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("lifecycle lock is not a private directory");
    const ownerPath = path.join(this.#lockPath, "owner.json");
    const owner = await readLockOwner(ownerPath);
    if (!owner) {
      if (Date.now() - info.mtimeMs < STALE_EMPTY_LOCK_MS) return;
      try { await rmdir(this.#lockPath); } catch (error) { if (!isCode(error, "ENOENT") && !isCode(error, "ENOTEMPTY")) throw error; }
      return;
    }
    if (await isProcessAlive(owner)) return;
    const currentOwner = await readLockOwner(ownerPath);
    if (!currentOwner || currentOwner.token !== owner.token || currentOwner.pid !== owner.pid || currentOwner.startTime !== owner.startTime) return;
    await unlink(ownerPath).catch(error => { if (!isCode(error, "ENOENT")) throw error; });
    try { await rmdir(this.#lockPath); } catch (error) { if (!isCode(error, "ENOENT") && !isCode(error, "ENOTEMPTY")) throw error; }
  }

  async #releaseLock(lock: LockHandle): Promise<void> {
    const owner = await readLockOwner(lock.ownerPath);
    if (!owner || owner.token !== lock.token || owner.pid !== process.pid) throw new Error("lifecycle lock ownership changed");
    await unlink(lock.ownerPath);
    await rmdir(this.#lockPath);
  }

  async #update<T>(mutate: (state: FileLifecycleState) => { result: T; state: FileLifecycleState }): Promise<T> {
    const lock = await this.#acquireLock();
    let result: T | undefined;
    let failure: unknown;
    try {
      const state = await this.#read();
      const updated = mutate(structuredClone(state));
      assertStoredState(updated.state);
      if (updated.state.version !== state.version && updated.state.version !== state.version + 1) throw new Error("lifecycle state version changed by an invalid amount");
      await this.#writeState(updated.state);
      result = updated.result;
    } catch (error) { failure = error; }
    try { await this.#releaseLock(lock); }
    catch (error) { failure = failure ? new AggregateError([failure, error], "lifecycle lock release failed") : error; }
    if (failure) throw failure;
    return result as T;
  }

  #assertRun(state: FileLifecycleState, runId: string): void {
    if (state.runId !== this.#runId || runId !== this.#runId) throw new Error("run identity changed");
  }

  #assertQuiescent(state: FileLifecycleState): void {
    if (state.preparationLeases.some(lease => lease.state === "held")) throw new Error("workflow is not durably quiescent: preparation lease remains");
  }
}

function assertCanonicalRoot(root: string): void {
  if (typeof root !== "string" || !path.isAbsolute(root) || path.resolve(root) !== root || root === path.parse(root).root || root.endsWith(path.sep) || root.includes("\\") || root.includes("//") || /[\u0000-\u001f\u007f\r\n]/u.test(root)) throw new Error("lifecycle authority root is not canonical");
}

async function assertPrivateDirectory(target: string): Promise<void> {
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("lifecycle authority root is not a private directory");
}

async function assertPrivateFile(target: string): Promise<void> {
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0) throw new Error("lifecycle lock owner is not a private regular file");
}

async function processStartTime(pid: number): Promise<string> {
  if (process.platform !== "linux") throw new Error("durable lifecycle lock recovery requires Linux process identity");
  const text = await readFile(`/proc/${pid}/stat`, "utf8");
  const end = text.lastIndexOf(")");
  if (end < 0) throw new Error("Linux process identity is malformed");
  const fields = text.slice(end + 2).trim().split(/\s+/u);
  const start = fields[19];
  if (!start) throw new Error("Linux process start identity is unavailable");
  return start;
}

async function isProcessAlive(owner: LockOwner): Promise<boolean> {
  if (owner.pid <= 0 || owner.pid > 4_194_304 || !Number.isSafeInteger(owner.pid)) return false;
  let observed: string;
  try { observed = await processStartTime(owner.pid); }
  catch (error) { if (isCode(error, "ENOENT")) return false; return true; }
  if (observed !== owner.startTime) return false;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return !isCode(error, "ESRCH"); }
}

async function readLockOwner(ownerPath: string): Promise<LockOwner | undefined> {
  try {
    const handle = await open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW!);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || info.size > 4_096) throw new Error("lifecycle lock owner is unsafe");
      const bytes = await handle.readFile();
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("lifecycle lock owner is malformed");
      const value = parsed as Record<string, unknown>;
      const pid = value["pid"];
      const startTime = value["startTime"];
      const token = value["token"];
      if (Object.keys(value).sort().join(",") !== "pid,startTime,token" || typeof pid !== "number" || !Number.isSafeInteger(pid) || typeof startTime !== "string" || !/^[0-9]+$/u.test(startTime) || typeof token !== "string" || !/^[0-9a-f-]{36}$/iu.test(token) || !Buffer.from(canonicalBytes(parsed)).equals(bytes)) throw new Error("lifecycle lock owner is malformed");
      return { pid, startTime, token };
    } finally { await handle.close(); }
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function assertStoredState(value: unknown): asserts value is FileLifecycleState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("lifecycle state is malformed");
  const state = value as Record<string, unknown>;
  const keys = Object.keys(state).sort();
  const allowed = ["preparationLeases", "runId", "teardown", "teardownLease", "teardownLeaseToken", "terminalFence", "version"];
  if (keys.some(key => !allowed.includes(key)) || new Set(keys).size !== keys.length) throw new Error("lifecycle state has an unknown field");
  const runId = state["runId"];
  const version = state["version"];
  const preparationLeases = state["preparationLeases"];
  try { assertRunId(runId as string); } catch { throw new Error("lifecycle state run identity is invalid"); }
  if (!Number.isSafeInteger(version) || (version as number) < 0 || !Array.isArray(preparationLeases)) throw new Error("lifecycle state version or lease list is invalid");
  for (const lease of preparationLeases) assertPreparationLease(lease);
  if (state["teardown"] !== undefined) assertTeardown(state["teardown"]);
  if (state["teardownLease"] !== undefined) assertLease(state["teardownLease"]);
  const teardownLeaseToken = state["teardownLeaseToken"];
  if (teardownLeaseToken !== undefined && (!Number.isSafeInteger(teardownLeaseToken) || (teardownLeaseToken as number) <= 0)) throw new Error("teardown lease token is invalid");
  if (state["terminalFence"] !== undefined) assertFence(state["terminalFence"]);
}

function assertPreparationLease(value: unknown): asserts value is RunPreparationLease {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("preparation lease is malformed");
  const item = value as Record<string, unknown>;
  const state = item["state"]; const owner = item["owner"]; const fencingToken = item["fencingToken"]; const acquiredAt = item["acquiredAt"];
  if (Object.keys(item).sort().join(",") !== "acquiredAt,fencingToken,owner,runId,state" || state !== "held" || typeof owner !== "string" || !OWNER_PATTERN.test(owner) || !Number.isSafeInteger(fencingToken) || (fencingToken as number) <= 0 || typeof acquiredAt !== "string") throw new Error("preparation lease is malformed");
}

function assertLease(value: unknown): asserts value is Lease {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("lease is malformed");
  const item = value as Record<string, unknown>;
  const key = item["key"]; const owner = item["owner"]; const fencingToken = item["fencingToken"]; const expiresAt = item["expiresAt"];
  if (Object.keys(item).sort().join(",") !== "expiresAt,fencingToken,key,owner" || key !== "teardown" || typeof owner !== "string" || !OWNER_PATTERN.test(owner) || !Number.isSafeInteger(fencingToken) || (fencingToken as number) <= 0 || !Number.isSafeInteger(expiresAt) || (expiresAt as number) < 0) throw new Error("lease is malformed");
}

function assertFence(value: unknown): asserts value is RunTerminalFence {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("terminal fence is malformed");
  const item = value as Record<string, unknown>;
  const state = item["state"]; const owner = item["owner"]; const fencingToken = item["fencingToken"]; const acquiredAt = item["acquiredAt"];
  if (Object.keys(item).sort().join(",") !== "acquiredAt,fencingToken,owner,runId,state" || (state !== "held" && state !== "removed") || typeof owner !== "string" || !OWNER_PATTERN.test(owner) || !Number.isSafeInteger(fencingToken) || (fencingToken as number) <= 0 || typeof acquiredAt !== "string") throw new Error("terminal fence is malformed");
}

function assertTeardown(value: unknown): asserts value is RunTeardownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("teardown record is malformed");
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).sort();
  const required = ["error", "fence", "generation", "owner", "reason", "requestedAt", "runId", "state"];
  const owner = item["owner"]; const generation = item["generation"]; const reason = item["reason"]; const state = item["state"]; const requestedAt = item["requestedAt"];
  if (keys.some(key => !required.includes(key)) || new Set(keys).size !== keys.length || typeof owner !== "string" || !OWNER_PATTERN.test(owner) || !Number.isSafeInteger(generation) || (generation as number) <= 0 || !["retention", "terminal", "operator"].includes(String(reason)) || !["draining", "fenced", "removing", "completed", "blocked"].includes(String(state)) || typeof requestedAt !== "string") throw new Error("teardown record is malformed");
  if (item["fence"] !== undefined) assertFence(item["fence"]);
  const error = item["error"];
  if (error !== undefined) {
    if (!error || typeof error !== "object" || Array.isArray(error)) throw new Error("teardown error is malformed");
    const errorRecord = error as Record<string, unknown>;
    if (Object.keys(errorRecord).sort().join(",") !== "at,code,message" || typeof errorRecord["code"] !== "string" || typeof errorRecord["message"] !== "string" || typeof errorRecord["at"] !== "string") throw new Error("teardown error is malformed");
  }
}

function assertOwner(owner: string): void { if (!OWNER_PATTERN.test(owner)) throw new Error("owner identity is invalid"); }
function assertTimestamp(now: number): void { if (!Number.isSafeInteger(now) || now < 0) throw new Error("timestamp is invalid"); }
function isCode(error: unknown, code: string, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 3) return false;
  if ("code" in error && (error as { code?: unknown }).code === code) return true;
  if ("cause" in error) return isCode((error as { cause?: unknown }).cause, code, depth + 1);
  return false;
}
