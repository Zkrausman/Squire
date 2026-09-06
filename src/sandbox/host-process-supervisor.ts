import { createHash, randomUUID } from "node:crypto";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { access, lstat, mkdir, open, readFile, readlink, readdir, realpath, rename, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { closeSync, constants, fstatSync, openSync, readFileSync, readlinkSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import type { SbxCommand } from "./sbx-command.js";
import { assertSbxCommand, commandFingerprint, SbxCommandError } from "./sbx-command.js";
import { assertSha256, canonicalBytes, canonicalJson, sha256Bytes } from "./identity.js";
import { fsyncDirectory, openNoFollowWithin, readExactNoFollow, writeExclusiveFile } from "../git/paths.js";

export interface HostProcessReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
  on(event: "end", listener: () => void): this;
}
export interface HostProcessWritable {
  write(data: Uint8Array | string): boolean;
  end?(): void;
}

export interface HostChildProcess {
  /** Durable ledger command ID, when this handle was created by the supervisor. */
  readonly commandId?: string;
  readonly identity: string;
  readonly pid: number;
  readonly startTime: string;
  readonly executable: string;
  readonly executableDigest: string;
  readonly stdin: HostProcessWritable;
  readonly stdout: HostProcessReadable;
  readonly stderr: HostProcessReadable;
  readonly exitCode: number | null;
  readonly exitSignal: string | null;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): this;
  kill(signal: "SIGTERM" | "SIGKILL"): boolean;
  waitForExit(timeoutMs: number): Promise<void>;
}

export interface HostProcessIntent {
  readonly commandId: string;
  readonly commandFingerprint: string;
  readonly executable: string;
  readonly executableDigest: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environmentDigest: string;
  readonly state: "intent" | "spawned" | "exited" | "unknown";
  readonly identity?: string;
  readonly pid?: number;
  readonly startTime?: string;
  readonly exitCode?: number | null;
  readonly startedAt: string;
}

export interface HostProcessLedger {
  persistIntent(intent: HostProcessIntent): Promise<void>;
  persistSpawned(intent: HostProcessIntent, process: HostChildProcess): Promise<void>;
  persistExited(intent: HostProcessIntent, process: HostChildProcess): Promise<void>;
  persistUnknown(intent: HostProcessIntent, process?: HostChildProcess): Promise<void>;
  read(commandId: string): Promise<HostProcessIntent | undefined>;
  findByIdentity(identity: string): Promise<HostProcessIntent | undefined>;
}

/** In-memory only; useful for deterministic driver tests, never a production default. */
export class InMemoryHostProcessLedger implements HostProcessLedger {
  readonly records = new Map<string, HostProcessIntent>();
  async persistIntent(intent: HostProcessIntent): Promise<void> { assertLedgerIntent(intent); this.assertNewOrSame(intent); this.records.set(intent.commandId, structuredClone(intent)); }
  async persistSpawned(intent: HostProcessIntent, process: HostChildProcess): Promise<void> { assertLedgerIntent(intent); assertProcessMatchesIntent(intent, process); const next = { ...intent, state: "spawned" as const, identity: process.identity, pid: process.pid, startTime: process.startTime }; assertLedgerIntent(next); this.persistTransition(next); }
  async persistExited(intent: HostProcessIntent, process: HostChildProcess): Promise<void> { assertLedgerIntent(intent); assertProcessMatchesIntent(intent, process); if (process.exitCode === null) throw new SbxCommandError("cannot persist a host process as exited before observing exit"); const next = { ...intent, state: "exited" as const, identity: process.identity, pid: process.pid, startTime: process.startTime, exitCode: process.exitCode }; assertLedgerIntent(next); this.persistTransition(next); }
  async persistUnknown(intent: HostProcessIntent, process?: HostChildProcess): Promise<void> { assertLedgerIntent(intent); if (process) assertProcessMatchesIntent(intent, process); const next = { ...intent, state: "unknown" as const, ...(process ? { identity: process.identity, pid: process.pid, startTime: process.startTime } : {}) }; assertLedgerIntent(next); this.persistTransition(next); }
  private persistTransition(next: HostProcessIntent): void { const existing = this.records.get(next.commandId); if (existing) { if (canonicalBytes(existing).equals(canonicalBytes(next))) return; if (existing.state === "exited" && next.state === "unknown") return; if (!validLedgerTransition(existing.state, next.state)) throw new SbxCommandError(`host process ledger transition ${existing.state} -> ${next.state} is invalid`); if (!sameCommandIntent(existing, next)) throw new SbxCommandError("host process intent identity changed"); } this.records.set(next.commandId, structuredClone(next)); }
  async read(commandId: string): Promise<HostProcessIntent | undefined> { const value = this.records.get(commandId); return value ? structuredClone(value) : undefined; }
  async findByIdentity(identity: string): Promise<HostProcessIntent | undefined> { for (const value of this.records.values()) if (value.identity === identity) return structuredClone(value); return undefined; }
  private assertNewOrSame(intent: HostProcessIntent): void { const existing = this.records.get(intent.commandId); if (existing && !canonicalBytes(existing).equals(canonicalBytes(intent))) throw new SbxCommandError("host process command intent was substituted"); }
}

export interface FileHostProcessLedgerOptions { readonly root: string }
/** Small file-backed ledger used by crash/restart tests. Each command has one
 * create-once JSON record; callers must never overwrite a different intent. */
export class FileHostProcessLedger implements HostProcessLedger {
  readonly #root: string;
  constructor(options: FileHostProcessLedgerOptions) { if (!options || typeof options.root !== "string" || !path.isAbsolute(options.root) || path.resolve(options.root) !== options.root || path.parse(options.root).root === options.root || options.root.includes("\0") || /[\u0000-\u001f\u007f\r\n]/u.test(options.root) || options.root.endsWith(path.sep)) throw new SbxCommandError("host process ledger root is not canonical"); this.#root = options.root; }
  async persistIntent(intent: HostProcessIntent): Promise<void> { await this.#write(intent, "intent"); }
  async persistSpawned(intent: HostProcessIntent, process: HostChildProcess): Promise<void> { assertProcessMatchesIntent(intent, process); await this.#write({ ...intent, state: "spawned", identity: process.identity, pid: process.pid, startTime: process.startTime }, "spawned"); }
  async persistExited(intent: HostProcessIntent, process: HostChildProcess): Promise<void> { assertProcessMatchesIntent(intent, process); if (process.exitCode === null) throw new SbxCommandError("cannot persist a host process as exited before observing exit"); await this.#write({ ...intent, state: "exited", identity: process.identity, pid: process.pid, startTime: process.startTime, exitCode: process.exitCode }, "exited"); }
  async persistUnknown(intent: HostProcessIntent, process?: HostChildProcess): Promise<void> { if (process) assertProcessMatchesIntent(intent, process); await this.#write({ ...intent, state: "unknown", ...(process ? { identity: process.identity, pid: process.pid, startTime: process.startTime } : {}) }, "unknown"); }
  async read(commandId: string): Promise<HostProcessIntent | undefined> {
    if (!/^[a-z][a-z0-9_-]{0,127}$/u.test(commandId)) throw new SbxCommandError("host process command ID is invalid");
    await this.#assertRoot();
    const target = path.join(this.#root, `${commandId}.json`);
    let info;
    try { info = await lstat(target); }
    catch (error) { if (isCode(error, "ENOENT")) return undefined; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600 || info.size > 4 * 1024 * 1024) throw new SbxCommandError("host process ledger record is not a bounded private regular file");
    try {
      const bytes = await readExactNoFollow(target, this.#root, 4 * 1024 * 1024);
      if (!bytes.equals(canonicalBytes(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))))) throw new SbxCommandError("host process ledger record is not canonically serialized");
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      assertLedgerIntent(value);
      return value;
    } catch (error) { throw error instanceof SbxCommandError ? error : new SbxCommandError(`host process ledger record cannot be read safely: ${error instanceof Error ? error.message : String(error)}`); }
  }
  async findByIdentity(identity: string): Promise<HostProcessIntent | undefined> {
    if (!parseHostProcessIdentity(identity)) throw new SbxCommandError("host process identity is malformed");
    await this.#assertRoot();
    const rootHandle = await openNoFollowWithin(this.#root, this.#root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      for (const entry of await readdir(`/proc/self/fd/${rootHandle.fd}`, { withFileTypes: true })) {
        const name = entry.name;
        if (!/^[a-z][a-z0-9_-]{0,127}\.json$/u.test(name)) continue;
        const target = path.join(this.#root, name);
        try {
          const info = await lstat(target);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600 || info.size > 4 * 1024 * 1024) throw new SbxCommandError("host process ledger contains a non-private record");
          const bytes = await readExactNoFollow(target, this.#root, 4 * 1024 * 1024);
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          const value = JSON.parse(text) as unknown;
          if (!bytes.equals(canonicalBytes(value))) throw new SbxCommandError("host process ledger record is not canonically serialized");
          assertLedgerIntent(value); if (value.identity === identity) return value;
        } catch (error) { if (isCode(error, "ENOENT")) continue; throw error instanceof SbxCommandError ? error : new SbxCommandError(`host process ledger record cannot be read safely: ${error instanceof Error ? error.message : String(error)}`); }
      }
      return undefined;
    } finally { await rootHandle.close(); }
  }
  async #write(intent: HostProcessIntent, transition: "intent" | "spawned" | "exited" | "unknown"): Promise<void> {
    assertLedgerIntent(intent);
    if (!/^[a-z][a-z0-9_-]{0,127}$/u.test(intent.commandId)) throw new SbxCommandError("host process command ID is invalid");
    await this.#assertRoot();
    await this.#withLock(async () => {
      const target = path.join(this.#root, `${intent.commandId}.json`);
      let existing: HostProcessIntent | undefined;
      try { existing = await this.read(intent.commandId); } catch (error) { if (!isCode(error, "ENOENT")) throw error; }
      if (!existing) {
        await writeExclusiveFile(target, canonicalBytes(intent), this.#root, 0o600);
        return;
      }
      if (!sameCommandIntent(existing, intent)) throw new SbxCommandError("host process intent identity changed");
      if (canonicalBytes(existing).equals(canonicalBytes(intent))) return;
      if (existing.state === transition) throw new SbxCommandError(`host process ledger already records a different ${transition} state`);
      if (!validLedgerTransition(existing.state, transition)) {
        if (existing.state === "exited" && transition === "unknown") return;
        throw new SbxCommandError(`host process ledger transition ${existing.state} -> ${transition} is invalid`);
      }
      const bytes = canonicalBytes(intent);
      // Never truncate the live record in place: a crash between truncate and
      // write would turn an owned child into an unverifiable empty record.
      // Publish a private, fsync'd replacement and then fsync the ledger root.
      const temporary = path.join(this.#root, `.${intent.commandId}.tmp-${randomUUID()}.json`);
      try {
        await writeExclusiveFile(temporary, bytes, this.#root, 0o600);
        const before = await lstat(target);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || (before.mode & 0o7777) !== 0o600) throw new SbxCommandError("host process ledger record was replaced during transition");
        await rename(temporary, target);
        await fsyncDirectory(this.#root, this.#root);
        const after = await lstat(target);
        if (!after.isFile() || after.nlink !== 1 || (after.mode & 0o7777) !== 0o600 || after.size !== bytes.length) throw new SbxCommandError("host process ledger transition was not durably written at its exact identity");
        const published = await readExactNoFollow(target, this.#root, 4 * 1024 * 1024);
        if (!published.equals(bytes)) throw new SbxCommandError("host process ledger transition bytes changed after publication");
      } catch (error) {
        await unlink(temporary).catch(unlinkError => { if (!isCode(unlinkError, "ENOENT")) throw unlinkError; });
        throw error;
      }
    });
  }
  async #assertRoot(): Promise<void> {
    await assertNoSymlinkAncestors(this.#root);
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.#root);
    if (!rootInfo.isDirectory() || (rootInfo.mode & 0o7777) !== 0o700 || rootInfo.nlink < 2) throw new SbxCommandError("host process ledger root is not a private directory");
  }

  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.#assertRoot();
    const lock = path.join(this.#root, ".ledger.lock");
    const deadline = Date.now() + 10_000;
    let owner: LedgerLockHandle | undefined;
    for (;;) {
      try { owner = await acquireLedgerLock(lock); break; }
      catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        await reclaimLedgerLock(lock);
        if (Date.now() >= deadline) throw new SbxCommandError("host process ledger lock acquisition timed out");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    let result: T | undefined; let failure: unknown;
    try { result = await operation(); }
    catch (error) { failure = error; }
    try { await releaseLedgerLock(lock, owner!); }
    catch (error) { failure = failure ? new AggregateError([failure, error], "host process ledger lock release failed") : error; }
    if (failure) throw failure;
    return result as T;
  }
}

function sameCommandIntent(left: HostProcessIntent, right: HostProcessIntent): boolean {
  return left.commandId === right.commandId && left.commandFingerprint === right.commandFingerprint && left.executable === right.executable && left.executableDigest === right.executableDigest && left.cwd === right.cwd && left.environmentDigest === right.environmentDigest && JSON.stringify(left.argv) === JSON.stringify(right.argv);
}

function validLedgerTransition(current: HostProcessIntent["state"], next: HostProcessIntent["state"]): boolean {
  if (current === "intent") return next === "spawned" || next === "unknown";
  if (current === "spawned") return next === "exited" || next === "unknown";
  if (current === "unknown") return next === "unknown" || next === "exited";
  return current === next;
}

function assertLedgerIntent(value: unknown): asserts value is HostProcessIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SbxCommandError("host process ledger record is malformed");
  const record = value as Record<string, unknown>; const state = record["state"];
  const base = ["argv", "commandFingerprint", "commandId", "cwd", "environmentDigest", "executable", "executableDigest", "startedAt", "state"];
  const required = state === "intent" ? base : state === "spawned" ? [...base, "identity", "pid", "startTime"] : state === "exited" ? [...base, "exitCode", "identity", "pid", "startTime"] : state === "unknown" ? base : [];
  if (required.length === 0 || !hasExactKeys(record, required) && !(state === "unknown" && hasExactKeys(record, [...base, "identity", "pid", "startTime"]))) throw new SbxCommandError("host process ledger record fields are not closed for its state");
  if (typeof record["commandId"] !== "string" || !/^[a-z][a-z0-9_-]{0,127}$/u.test(record["commandId"]) || typeof record["commandFingerprint"] !== "string" || !/^[0-9a-f]{64}$/u.test(record["commandFingerprint"]) || typeof record["environmentDigest"] !== "string" || !/^[0-9a-f]{64}$/u.test(record["environmentDigest"]) || typeof record["executable"] !== "string" || !isCanonicalHostPath(record["executable"]) || typeof record["executableDigest"] !== "string" || !/^[0-9a-f]{64}$/u.test(record["executableDigest"]) || typeof record["cwd"] !== "string" || !isCanonicalHostPath(record["cwd"], true) || !Array.isArray(record["argv"]) || record["argv"].length === 0 || record["argv"].length > 128 || record["argv"].some(item => typeof item !== "string" || item.length === 0 || item.length > 2_048 || /[\u0000-\u001f\u007f\r\n]/u.test(item)) || !["intent", "spawned", "exited", "unknown"].includes(state as string) || typeof record["startedAt"] !== "string" || !Number.isFinite(Date.parse(record["startedAt"])) || new Date(record["startedAt"] as string).toISOString() !== record["startedAt"]) throw new SbxCommandError("host process ledger record is malformed");
  if (state !== "intent" && state !== "unknown" && (typeof record["identity"] !== "string" || !/^host-child:\d+:\d+:[0-9a-f]{64}$/u.test(record["identity"]))) throw new SbxCommandError("host process ledger identity is malformed");
  if (state === "unknown" && record["identity"] !== undefined && (typeof record["identity"] !== "string" || !/^host-child:\d+:\d+:[0-9a-f]{64}$/u.test(record["identity"]))) throw new SbxCommandError("host process ledger identity is malformed");
  if (state !== "intent" && state !== "unknown" && (!Number.isSafeInteger(record["pid"]) || Number(record["pid"]) <= 0 || Number(record["pid"]) > 4_194_304 || typeof record["startTime"] !== "string" || !/^\d{1,32}$/u.test(record["startTime"]))) throw new SbxCommandError("host process ledger process identity is malformed");
  if (state === "unknown" && record["pid"] !== undefined && (!Number.isSafeInteger(record["pid"]) || Number(record["pid"]) <= 0 || Number(record["pid"]) > 4_194_304 || typeof record["startTime"] !== "string" || !/^\d{1,32}$/u.test(record["startTime"]))) throw new SbxCommandError("host process ledger process identity is malformed");
  if (record["identity"] !== undefined && record["pid"] !== undefined) { const identity = parseHostProcessIdentity(record["identity"] as string); if (!identity || identity.pid !== record["pid"] || identity.startTime !== record["startTime"] || identity.executableDigest !== record["executableDigest"] || (state !== "intent" && state !== "unknown" && identity.executableDigest !== digestFromIdentity(record["identity"] as string))) throw new SbxCommandError("host process ledger identity is not bound to its process fields"); }
  if (state === "exited" && record["exitCode"] !== null && (!Number.isSafeInteger(record["exitCode"]) || Number(record["exitCode"]) < 0 || Number(record["exitCode"]) > 255)) throw new SbxCommandError("host process ledger exit code is malformed");
}
function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(record).sort().join("\0") === [...keys].sort().join("\0"); }
function isCanonicalHostPath(value: unknown, allowRoot = false): value is string { return typeof value === "string" && value.length >= 1 && value.length <= 4_096 && path.isAbsolute(value) && path.resolve(value) === value && (allowRoot || value !== path.parse(value).root) && (allowRoot && value === path.parse(value).root || !value.endsWith(path.sep)) && !value.includes("//") && !value.includes("\\") && !value.split(path.sep).some(part => part === "." || part === "..") && !/[\u0000-\u001f\u007f\r\n]/u.test(value); }
function environmentDigest(value: Readonly<Record<string, string>>): string { return sha256Bytes(Buffer.from(canonicalJson(value), "utf8")); }
function assertProcessMatchesIntent(intent: HostProcessIntent, process: HostChildProcess): void { if (!process || process.commandId !== undefined && process.commandId !== intent.commandId || process.executable !== intent.executable || process.executableDigest !== intent.executableDigest || !assertHostProcessIdentity(process) || process.executableDigest !== digestFromIdentity(process.identity) || process.identity !== `host-child:${process.pid}:${process.startTime}:${process.executableDigest}`) throw new SbxCommandError("host process identity does not match its durable command intent"); }
function digestFromIdentity(identity: string): string { const match = /^host-child:\d+:\d+:([0-9a-f]{64})$/u.exec(identity); if (!match) throw new SbxCommandError("host process identity is malformed"); return match[1]!; }
function assertHostProcessIdentity(process: Pick<HostChildProcess, "pid" | "startTime">): boolean { return Number.isSafeInteger(process.pid) && process.pid > 0 && process.pid <= 4_194_304 && typeof process.startTime === "string" && /^\d{1,32}$/u.test(process.startTime); }

class ChildHostProcess implements HostChildProcess {
  readonly commandId: string;
  readonly identity: string;
  readonly pid: number;
  readonly startTime: string;
  readonly executable: string;
  readonly executableDigest: string;
  readonly stdin: HostProcessWritable;
  readonly stdout: HostProcessReadable;
  readonly stderr: HostProcessReadable;
  exitCode: number | null = null;
  exitSignal: string | null = null;
  readonly #child: ChildProcess;
  readonly #listeners = new Set<(code: number | null, signal: string | null) => void>();
  constructor(child: ChildProcess, commandId: string, executable: string, startTime: string, executableDigest: string) {
    if (!child.stdin || !child.stdout || !child.stderr || !child.pid) throw new SbxCommandError("host child did not expose bounded stdio or PID");
    this.#child = child; this.commandId = commandId; this.pid = child.pid; this.startTime = startTime; this.executable = executable; this.executableDigest = executableDigest;
    this.stdin = child.stdin;
    this.stdout = child.stdout; this.stderr = child.stderr;
    this.identity = `host-child:${this.pid}:${this.startTime}:${this.executableDigest}`;
    const settle = (code: number | null, signal: string | null): void => { if (this.exitCode !== null) return; this.exitSignal = signal; this.exitCode = code ?? (signal === "SIGTERM" ? 143 : 1); for (const listener of this.#listeners) listener(this.exitCode, signal); this.#listeners.clear(); };
    child.once("exit", (code, signal) => settle(code, signal));
    child.once("error", () => settle(1, this.exitSignal));
    if (child.exitCode !== null) settle(child.exitCode, child.signalCode);
  }
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): this { if (event === "exit") { if (this.exitCode !== null) queueMicrotask(() => listener(this.exitCode, this.exitSignal)); else this.#listeners.add(listener); } return this; }
  kill(signal: "SIGTERM" | "SIGKILL"): boolean { return this.#child.kill(signal); }
  async waitForExit(timeoutMs: number): Promise<void> { if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new SbxCommandError("host child exit timeout is invalid"); if (this.exitCode !== null) return; await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => { this.#listeners.delete(onExit); reject(new SbxCommandError("host child exit observation timed out")); }, timeoutMs); timer.unref?.(); const onExit = (): void => { clearTimeout(timer); resolve(); }; this.on("exit", onExit); }); }
}

export interface HostProcessSupervisorOptions {
  /** Required in production; InMemoryHostProcessLedger is an explicit test seam. */
  readonly ledger?: HostProcessLedger;
  /** Test-only escape hatch for exercising durable ownership with a non-sbx
   * executable. It is rejected for file-backed/production ledgers. */
  readonly testOnlyAllowNonSbxCommand?: boolean;
  readonly maxOutputBytes?: number;
  readonly defaultTimeoutMs?: number;
  readonly verifyExecutable?: (command: SbxCommand) => Promise<void>;
}

export interface SbxCommandResult {
  readonly commandId: string;
  readonly commandFingerprint: string;
  readonly argv: readonly string[];
  readonly executable: string;
  readonly processIdentity: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawn/exec adapter for sbx. It never invokes a shell and does not inherit
 * ambient environment. Command intent and exact child identity are durable
 * before command ownership is exposed to lifecycle code. */
export class HostProcessSupervisor {
  readonly #ledger: HostProcessLedger;
  readonly #maxOutputBytes: number;
  readonly #defaultTimeoutMs: number;
  readonly #verifyExecutable: ((command: SbxCommand) => Promise<void>) | undefined;
  readonly #testOnlyAllowNonSbxCommand: boolean;
  constructor(options: HostProcessSupervisorOptions = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options) || !options.ledger || (options.verifyExecutable !== undefined && typeof options.verifyExecutable !== "function") || (options.testOnlyAllowNonSbxCommand !== undefined && typeof options.testOnlyAllowNonSbxCommand !== "boolean")) throw new SbxCommandError("a durable host process ledger is required; in-memory ownership is test-only");
    if (options.testOnlyAllowNonSbxCommand === true && !(options.ledger instanceof InMemoryHostProcessLedger)) throw new SbxCommandError("non-sbx command test mode requires the explicit in-memory ledger");
    this.#ledger = options.ledger;
    this.#testOnlyAllowNonSbxCommand = options.testOnlyAllowNonSbxCommand === true;
    this.#maxOutputBytes = boundedPositiveInteger(options.maxOutputBytes ?? 4 * 1024 * 1024, 64 * 1024 * 1024, "host command output limit");
    this.#defaultTimeoutMs = boundedPositiveInteger(options.defaultTimeoutMs ?? 30_000, 300_000, "host command timeout");
    this.#verifyExecutable = options.verifyExecutable;
  }

  async spawn(command: SbxCommand, signal?: AbortSignal, onSpawn?: (process: HostChildProcess) => void | Promise<void>): Promise<HostChildProcess> {
    try { assertSbxCommand(command); } catch (error) { if (!this.#testOnlyAllowNonSbxCommand) throw error instanceof SbxCommandError ? error : new SbxCommandError(error instanceof Error ? error.message : "host command is invalid"); }
    if (signal?.aborted) throw new SbxCommandError("host command was aborted before spawn");
    await this.#verify(command);
    if (signal?.aborted) throw new SbxCommandError("host command was aborted before intent persistence");
    const commandId = `sbx-${randomUUID()}`;
    const intent: HostProcessIntent = { commandId, commandFingerprint: commandFingerprint(command), executable: command.executable, executableDigest: command.executableSha256, argv: [...command.argv], cwd: command.cwd, environmentDigest: environmentDigest(command.environment), state: "intent", startedAt: new Date().toISOString() };
    await this.#ledger.persistIntent(intent);
    let child: ChildProcess;
    try {
      if (signal?.aborted) { await this.#ledger.persistUnknown(intent); throw new SbxCommandError("host command was aborted before child spawn"); }
      child = spawnChild(command.executable, [...command.argv], { cwd: command.cwd, env: { ...command.environment }, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      // Install an error observer before the first asynchronous identity
      // probe. Otherwise a failed exec can emit an unhandled child error
      // while the controller is still hashing/proving the executable.
      child.once("error", () => undefined);
    }
    catch (error) { await this.#ledger.persistUnknown(intent).catch(() => undefined); throw new SbxCommandError(`host command could not be spawned: ${error instanceof Error ? error.message : String(error)}`); }
    let startTime: string;
    let executableDigest: string;
    try {
      // Capture identity synchronously immediately after spawn. A short-lived
      // sbx command may already be a zombie by the time an asynchronous /proc
      // read runs, but its exact identity remains available until reaping.
      startTime = processStartTimeSync(child.pid!);
      const executable = readProcExecutableSync(child.pid!);
      const promotedExecutable = realpathSync(command.executable);
      if (command.executable !== promotedExecutable || executable !== promotedExecutable) throw new SbxCommandError("spawned sbx child executable path differs from the promoted path");
      executableDigest = hashFileSync(executable);
      if (executableDigest !== command.executableSha256) throw new SbxCommandError("spawned sbx child executable differs from the promoted digest");
      assertProcessArgvSync(child.pid!, command.argv, command.executable);
    }
    catch (error) {
      await this.#ledger.persistUnknown(intent).catch(() => undefined);
      child.kill("SIGKILL");
      await waitRawChildExit(child, 2_000).catch(() => undefined);
      throw new SbxCommandError(`host child start identity could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
    }
    const wrapped = new ChildHostProcess(child, commandId, command.executable, startTime, executableDigest);
    try {
      await this.#ledger.persistSpawned(intent, wrapped);
      await onSpawn?.(wrapped);
    } catch (error) {
      await this.#ledger.persistUnknown(intent, wrapped).catch(() => undefined);
      if (wrapped.exitCode === null) wrapped.kill("SIGKILL");
      try { await wrapped.waitForExit(2_000); } catch { /* durable unknown remains */ }
      throw error;
    }
    const onAbort = (): void => { if (wrapped.exitCode === null) wrapped.kill("SIGTERM"); };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    wrapped.on("exit", () => { signal?.removeEventListener("abort", onAbort); void this.#ledger.persistExited(intent, wrapped).catch(() => undefined); });
    return wrapped;
  }

  async run(command: SbxCommand, options: { readonly timeoutMs?: number; readonly allowExitCodes?: readonly number[]; readonly signal?: AbortSignal; readonly onSpawn?: (process: HostChildProcess) => void | Promise<void> } = {}): Promise<SbxCommandResult> {
    if (!command || typeof command !== "object" || Array.isArray(command) || !options || typeof options !== "object" || Array.isArray(options)) throw new SbxCommandError("host command input is malformed");
    const timeoutMs = boundedPositiveInteger(options.timeoutMs ?? this.#defaultTimeoutMs, 300_000, "host command timeout");
    const allowExitCodes = options.allowExitCodes ?? [0];
    if (!Array.isArray(allowExitCodes) || allowExitCodes.length === 0 || allowExitCodes.some(code => !Number.isSafeInteger(code) || code < 0 || code > 255)) throw new SbxCommandError("host command exit-code allowlist is invalid");
    let child: HostChildProcess | undefined;
    let stdout = ""; let stderr = ""; let outputBytes = 0; let outputError: Error | undefined;
    const stdoutDecoder = new TextDecoder("utf-8", { fatal: true });
    const stderrDecoder = new TextDecoder("utf-8", { fatal: true });
    const collect = (target: "stdout" | "stderr") => (chunk: Buffer | string): void => {
      if (outputError) return;
      try {
        const value = typeof chunk === "string" ? chunk : (target === "stdout" ? stdoutDecoder : stderrDecoder).decode(chunk, { stream: true });
        const nextLength = outputBytes + Buffer.byteLength(value, "utf8");
        if (nextLength > this.#maxOutputBytes) { outputError = new SbxCommandError("host command output exceeded its bounded limit"); if (child?.exitCode === null) child.kill("SIGTERM"); return; }
        outputBytes = nextLength;
        if (target === "stdout") stdout += value; else stderr += value;
      } catch (error) { outputError = new SbxCommandError(`host command output was not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`); if (child?.exitCode === null) child.kill("SIGTERM"); }
    };
    child = await this.spawn(command, options.signal, async process => { process.stdout.on("data", collect("stdout")); process.stderr.on("data", collect("stderr")); await options.onSpawn?.(process); });
    let exit: { readonly exitCode: number | null; readonly signal: string | null };
    try { exit = await observeHostExit(child, timeoutMs, options.signal); }
    catch (error) {
      if (child.commandId) {
        const intent = await this.#ledger.read(child.commandId).catch(() => undefined);
        if (intent) {
          if (child.exitCode === null) await this.#ledger.persistUnknown(intent, child).catch(() => undefined);
          else await this.#ledger.persistExited(intent, child).catch(() => undefined);
        }
      }
      throw error;
    }
    try {
      const stdoutTail = stdoutDecoder.decode();
      const stderrTail = stderrDecoder.decode();
      const tailBytes = Buffer.byteLength(stdoutTail, "utf8") + Buffer.byteLength(stderrTail, "utf8");
      if (outputBytes + tailBytes > this.#maxOutputBytes) outputError ??= new SbxCommandError("host command output exceeded its bounded limit");
      else { outputBytes += tailBytes; stdout += stdoutTail; stderr += stderrTail; }
    }
    catch (error) { outputError ??= new SbxCommandError(`host command output was not valid UTF-8: ${error instanceof Error ? error.message : String(error)}`); }
    if (child.commandId) {
      const recorded = await this.#ledger.read(child.commandId);
      if (!recorded) throw new SbxCommandError("host command exited without a durable ledger record");
      await this.#ledger.persistExited(recorded, child);
    }
    const result: SbxCommandResult = { commandId: child.commandId ?? `sbx-${child.identity}`, commandFingerprint: commandFingerprint(command), argv: [...command.argv], executable: command.executable, processIdentity: child.identity, exitCode: exit.exitCode, signal: exit.signal, stdout, stderr };
    if (outputError) throw outputError;
    if (options.signal?.aborted) throw new SbxCommandError("host command was aborted");
    if (!Array.isArray(options.allowExitCodes ?? [0]) || (options.allowExitCodes ?? [0]).some(code => !Number.isSafeInteger(code) || code < 0 || code > 255)) throw new SbxCommandError("host command exit-code allowlist is invalid");
    if (!allowExitCodes.includes(exit.exitCode ?? -1)) throw new SbxCommandError(`sbx command failed with exit ${exit.exitCode ?? "unknown"}`);
    return result;
  }

  async resolve(identity: string): Promise<HostChildProcess | undefined> {
    const parsed = parseHostProcessIdentity(identity);
    if (!parsed) throw new SbxCommandError("host process identity is malformed");
    const ledger = await this.#ledger.findByIdentity(identity);
    if (!ledger || (ledger.state !== "spawned" && ledger.state !== "unknown") || ledger.identity !== identity || ledger.pid !== parsed.pid || ledger.startTime !== parsed.startTime) return undefined;
    if (process.platform !== "linux") throw new SbxCommandError("host process identity resolution is unsupported on this platform");
    try {
      await access(`/proc/${parsed.pid}`, constants.F_OK);
      const start = await processStartTime(parsed.pid);
      const executable = await readProcExecutable(parsed.pid);
      const promotedExecutable = await realpath(ledger.executable);
      const digest = await hashFile(executable);
      if (executable !== promotedExecutable || start !== parsed.startTime || digest !== parsed.executableDigest) return undefined;
      await assertProcessArgv(parsed.pid, ledger.argv, ledger.executable);
      return new ResolvedHostProcess(parsed.pid, parsed.startTime, ledger.executable, parsed.executableDigest, ledger.argv);
    } catch { return undefined; }
  }

  async terminate(process: HostChildProcess, graceMs = this.#defaultTimeoutMs): Promise<void> {
    const boundedGraceMs = boundedPositiveInteger(graceMs, 300_000, "host child termination grace");
    if (!process || !parseHostProcessIdentity(process.identity)) throw new SbxCommandError("host child termination requires a durable process identity");
    if (process.exitCode !== null) return;
    const intent = process.commandId ? await this.#ledger.read(process.commandId) : await this.#ledger.findByIdentity(process.identity);
    if (!intent || (intent.state !== "spawned" && intent.state !== "unknown") || intent.identity !== process.identity || intent.pid !== process.pid || intent.startTime !== process.startTime || intent.executable !== process.executable || intent.executableDigest !== process.executableDigest) throw new SbxCommandError("host child is not owned by its durable command ledger");
    await assertLiveProcessIdentity(process, intent.argv);
    const termDelivered = process.kill("SIGTERM");
    if (!termDelivered && process.exitCode === null) {
      await assertLiveProcessIdentity(process, intent.argv);
      const killDelivered = process.kill("SIGKILL");
      if (!killDelivered && process.exitCode === null) throw new SbxCommandError("host child kill signal was not delivered");
    }
    try { await process.waitForExit(boundedGraceMs); }
    catch {
      if (process.exitCode === null) {
        await assertLiveProcessIdentity(process, intent.argv);
        const killDelivered = process.kill("SIGKILL");
        if (!killDelivered && process.exitCode === null) throw new SbxCommandError("host child kill signal was not delivered");
      }
      await process.waitForExit(boundedGraceMs);
    }
    if (process.exitCode === null) throw new SbxCommandError("host child termination was not observed");
    await this.#ledger.persistExited(intent, process);
  }

  async #verify(command: SbxCommand): Promise<void> {
    assertSha256(command.executableSha256, "sbx executable digest");
    // Hash the executable before every spawn. An optional release verifier is
    // an additional policy check, never a bypass for the byte identity proof.
    try {
      const resolved = await realpath(command.executable);
      const resolvedCwd = await realpath(command.cwd);
      if (resolved !== command.executable || resolvedCwd !== command.cwd || !pathCleanHost(command.executable) || !pathCleanHost(command.cwd, true)) throw new SbxCommandError("sbx executable or cwd path must be canonical non-symlink paths");
      await assertNoSymlinkAncestors(command.executable);
      await assertNoSymlinkAncestors(command.cwd);
      const digest = await hashFile(command.executable);
      if (digest !== command.executableSha256) throw new SbxCommandError("sbx executable digest differs from the release");
    } catch (error) {
      if (error instanceof SbxCommandError) throw error;
      throw new SbxCommandError(`sbx executable identity cannot be verified: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (this.#verifyExecutable) await this.#verifyExecutable(command);
  }
}

export function parseHostProcessIdentity(value: string): { readonly pid: number; readonly startTime: string; readonly executableDigest: string } | undefined {
  const match = typeof value === "string" && value.length <= 256 ? /^host-child:(\d{1,10}):(\d{1,32}):([0-9a-f]{64})$/u.exec(value) : null;
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 4_194_304) return undefined;
  return { pid, startTime: match[2]!, executableDigest: match[3]! };
}

export async function processStartTime(pid: number | null | undefined): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid === null || pid === undefined || pid <= 0 || pid > 4_194_304) throw new SbxCommandError("host child did not have a usable PID");
  if (process.platform !== "linux") throw new SbxCommandError("durable host process start-time evidence is unsupported on this platform");
  return parseProcessStartTime(await readFile(`/proc/${pid}/stat`, "utf8"));
}

function processStartTimeSync(pid: number | null | undefined): string {
  if (!Number.isSafeInteger(pid) || pid === null || pid === undefined || pid <= 0 || pid > 4_194_304) throw new SbxCommandError("host child did not have a usable PID");
  if (process.platform !== "linux") throw new SbxCommandError("durable host process start-time evidence is unsupported on this platform");
  return parseProcessStartTime(readFileSync(`/proc/${pid}/stat`, "utf8"));
}

function parseProcessStartTime(stat: string): string {
  const close = stat.lastIndexOf(")");
  if (close < 0) throw new SbxCommandError("host process stat output is malformed");
  const fields = stat.slice(close + 2).trim().split(/\s+/u);
  const start = fields[19]; // field 22 overall; fields begin at state (field 3).
  if (!start || !/^\d+$/u.test(start)) throw new SbxCommandError("host process start-time evidence is malformed");
  return start;
}

async function readProcExecutable(pid: number): Promise<string> {
  const link = await readlink(`/proc/${pid}/exe`).catch(() => undefined);
  if (link) return link;
  throw new SbxCommandError("host process executable identity is unavailable");
}
function readProcExecutableSync(pid: number): string {
  try { return readlinkSync(`/proc/${pid}/exe`); }
  catch { throw new SbxCommandError("host process executable identity is unavailable"); }
}
async function assertProcessArgv(pid: number, argv: readonly string[], executable?: string): Promise<void> {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 128 || argv.some(item => typeof item !== "string" || item.length === 0 || item.length > 2_048 || /[\u0000-\u001f\u007f\r\n]/u.test(item)) || executable !== undefined && (!path.isAbsolute(executable) || !pathCleanHost(executable))) throw new SbxCommandError("host process argv identity is invalid");
  if (executable === undefined) throw new SbxCommandError("host process executable identity is required for argv verification");
  const expected = expectedProcArgv(executable, argv);
  const actual = await readFile(`/proc/${pid}/cmdline`);
  if (!actual.equals(expected)) throw new SbxCommandError("host process argv identity changed");
}
function assertProcessArgvSync(pid: number, argv: readonly string[], executable: string): void {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 128 || argv.some(item => typeof item !== "string" || item.length === 0 || item.length > 2_048 || /[\u0000-\u001f\u007f\r\n]/u.test(item)) || !path.isAbsolute(executable) || !pathCleanHost(executable)) throw new SbxCommandError("host process argv identity is invalid");
  if (!readFileSync(`/proc/${pid}/cmdline`).equals(expectedProcArgv(executable, argv))) throw new SbxCommandError("host process argv identity changed");
}
function expectedProcArgv(executable: string, argv: readonly string[]): Buffer {
  return Buffer.concat([Buffer.from(executable, "utf8"), Buffer.from([0]), ...argv.map(item => Buffer.concat([Buffer.from(item, "utf8"), Buffer.from([0])]))]);
}

async function hashFile(file: string): Promise<string> {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) throw new SbxCommandError("executable path is invalid");
  const resolved = await realpath(file).catch(error => { throw new SbxCommandError(`executable path cannot be resolved: ${error instanceof Error ? error.message : String(error)}`); });
  if (!path.isAbsolute(resolved) || !pathCleanHost(resolved)) throw new SbxCommandError("resolved executable path is not canonical");
  const handle = await openNoFollowHost(resolved);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > 256 * 1024 * 1024 || (info.mode & 0o022) !== 0) throw new SbxCommandError("executable is not a bounded, privately owned regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, info.size)));
    let offset = 0;
    while (offset < info.size) {
      const read = await handle.read(buffer, 0, Math.min(buffer.length, info.size - offset), offset);
      if (read.bytesRead <= 0) throw new SbxCommandError("executable ended during identity hashing");
      hash.update(buffer.subarray(0, read.bytesRead)); offset += read.bytesRead;
    }
    const after = await handle.stat();
    const resolvedAfter = await realpath(file).catch(() => "");
    if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || resolvedAfter !== resolved) throw new SbxCommandError("executable changed during identity hashing");
    return hash.digest("hex");
  } finally { await handle.close(); }
}

function hashFileSync(file: string): string {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0") || process.platform !== "linux" || constants.O_NOFOLLOW === undefined) throw new SbxCommandError("secure executable hashing is unsupported on this platform");
  let resolved: string;
  try { resolved = realpathSync(file); } catch (error) { throw new SbxCommandError(`executable path cannot be resolved: ${error instanceof Error ? error.message : String(error)}`); }
  if (!path.isAbsolute(resolved) || !pathCleanHost(resolved)) throw new SbxCommandError("resolved executable path is not canonical");
  let fd: number | undefined;
  try {
    fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > 256 * 1024 * 1024 || (info.mode & 0o022) !== 0) throw new SbxCommandError("executable is not a bounded, privately owned regular file");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, info.size)));
    let offset = 0;
    while (offset < info.size) {
      const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, info.size - offset), offset);
      if (bytes <= 0) throw new SbxCommandError("executable ended during identity hashing");
      hash.update(buffer.subarray(0, bytes)); offset += bytes;
    }
    const after = fstatSync(fd);
    if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || realpathSync(file) !== resolved) throw new SbxCommandError("executable changed during identity hashing");
    return hash.digest("hex");
  } catch (error) {
    throw error instanceof SbxCommandError ? error : new SbxCommandError(`executable cannot be hashed without following links: ${error instanceof Error ? error.message : String(error)}`);
  } finally { if (fd !== undefined) closeSync(fd); }
}

class ResolvedHostProcess implements HostChildProcess {
  readonly identity: string;
  readonly pid: number;
  readonly startTime: string;
  readonly executable: string;
  readonly executableDigest: string;
  readonly stdin: HostProcessWritable = { write: () => false };
  readonly stdout: HostProcessReadable = new NullReadable();
  readonly stderr: HostProcessReadable = new NullReadable();
  exitCode: number | null = null;
  exitSignal: string | null = null;
  readonly #listeners = new Set<(code: number | null, signal: string | null) => void>();
  readonly #argv: readonly string[];
  constructor(pid: number, startTime: string, executable: string, executableDigest: string, argv: readonly string[]) {
    this.pid = pid; this.startTime = startTime; this.executable = executable; this.executableDigest = executableDigest; this.#argv = Object.freeze([...argv]);
    this.identity = `host-child:${pid}:${startTime}:${executableDigest}`;
  }
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): this { if (event === "exit") { if (this.exitCode !== null) queueMicrotask(() => listener(this.exitCode, this.exitSignal)); else this.#listeners.add(listener); } return this; }
  kill(signal: "SIGTERM" | "SIGKILL"): boolean { if (this.exitCode !== null) return false; try { process.kill(this.pid, signal); this.exitSignal = signal; return true; } catch (error) { if (isCode(error, "ESRCH")) { this.#settle(0, signal); return true; } return false; } }
  async waitForExit(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + boundedPositiveInteger(timeoutMs, 300_000, "resolved host child exit timeout");
    while (this.exitCode === null && Date.now() < deadline) {
      const state = await exactProcessState(this.pid, this.startTime, this.executable, this.executableDigest, this.#argv);
      if (state === "exited") { this.#settle(0, this.exitSignal); break; }
      if (state === "changed") throw new SbxCommandError("resolved host child identity changed before exit could be observed");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (this.exitCode === null) throw new SbxCommandError("resolved host child exit was not observed");
  }
  #settle(code: number, signal: string | null): void { if (this.exitCode !== null) return; this.exitCode = code; this.exitSignal = signal; for (const listener of this.#listeners) listener(code, signal); this.#listeners.clear(); }
}

class NullReadable implements HostProcessReadable {
  on(_event: "data" | "end", _listener: ((chunk: Buffer | string) => void) | (() => void)): this { return this; }
}

async function exactProcessState(pid: number, startTime: string, executable: string, executableDigest: string, argv: readonly string[]): Promise<"alive" | "exited" | "changed"> {
  try {
    const currentStart = await processStartTime(pid);
    if (currentStart !== startTime) return "changed";
    const currentExecutable = await readProcExecutable(pid);
    if (currentExecutable !== executable || await hashFile(currentExecutable) !== executableDigest) return "changed";
    await assertProcessArgv(pid, argv, currentExecutable);
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return "changed";
    return stat.slice(close + 2).trim().startsWith("Z", 0) ? "exited" : "alive";
  } catch (error) {
    if (isCode(error, "ENOENT") || isCode(error, "ESRCH")) return "exited";
    throw new SbxCommandError(`resolved host child liveness is unknown: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function exactProcessStillAlive(pid: number, startTime: string, executable: string, executableDigest: string, argv: readonly string[]): Promise<boolean> {
  return (await exactProcessState(pid, startTime, executable, executableDigest, argv)) === "alive";
}

async function assertLiveProcessIdentity(child: Pick<HostChildProcess, "pid" | "startTime" | "executable" | "executableDigest">, argv: readonly string[]): Promise<void> {
  if (globalThis.process.platform === "win32") throw new SbxCommandError("live host process identity verification is unsupported on this platform");
  try {
    const startTime = await processStartTime(child.pid);
    const executable = await readProcExecutable(child.pid);
    const digest = await hashFile(executable);
    await assertProcessArgv(child.pid, argv, child.executable);
    if (executable !== child.executable || startTime !== child.startTime || digest !== child.executableDigest || !(await exactProcessStillAlive(child.pid, child.startTime, child.executable, child.executableDigest, argv))) throw new SbxCommandError("host process identity changed before termination");
  } catch (error) {
    if (error instanceof SbxCommandError) throw error;
    throw new SbxCommandError(`host process identity could not be verified before termination: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function openNoFollowHost(file: string): Promise<FileHandle> {
  if (process.platform !== "linux" || constants.O_NOFOLLOW === undefined) throw new SbxCommandError("secure executable hashing is unsupported on this platform");
  try { return await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { throw new SbxCommandError(`executable cannot be opened without following links: ${error instanceof Error ? error.message : String(error)}`); }
}

async function waitRawChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.removeListener("exit", onExit); reject(new SbxCommandError("raw host child exit was not observed")); }, timeoutMs);
    const onExit = (): void => { clearTimeout(timer); resolve(); };
    child.once("exit", onExit);
  });
}

async function observeHostExit(child: HostChildProcess, timeoutMs: number, signal?: AbortSignal): Promise<{ readonly exitCode: number | null; readonly signal: string | null }> {
  if (signal?.aborted) {
    if (child.exitCode === null) child.kill("SIGTERM");
    try { await child.waitForExit(Math.min(timeoutMs, 2_000)); }
    catch { if (child.exitCode === null) child.kill("SIGKILL"); await child.waitForExit(Math.min(timeoutMs, 2_000)); }
    throw new SbxCommandError("host command was aborted");
  }
  if (child.exitCode !== null) return { exitCode: child.exitCode, signal: child.exitSignal };
  let exit: { exitCode: number | null; signal: string | null } | undefined;
  const exited = new Promise<void>(resolve => child.on("exit", (code, signalName) => { exit = { exitCode: code, signal: signalName }; resolve(); }));
  let aborted = false;
  let timedOut = false;
  const onAbort = (): void => { aborted = true; if (child.exitCode === null) child.kill("SIGTERM"); };
  signal?.addEventListener("abort", onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>(resolve => { timer = setTimeout(() => { timedOut = true; if (child.exitCode === null) child.kill("SIGTERM"); resolve(); }, timeoutMs); timer.unref?.(); });
  try {
    await Promise.race([exited, timeout]);
    if (!exit && child.exitCode === null) {
      try { await child.waitForExit(Math.min(timeoutMs, 2_000)); } catch { child.kill("SIGKILL"); await child.waitForExit(Math.min(timeoutMs, 2_000)); }
      exit = { exitCode: child.exitCode, signal: child.exitSignal };
    }
    if (aborted) throw new SbxCommandError("host command was aborted");
    if (timedOut) throw new SbxCommandError("host command timed out");
    if (!exit) exit = { exitCode: child.exitCode, signal: child.exitSignal };
    if (exit.exitCode === null) throw new SbxCommandError("host command exit was not observed");
    return exit;
  } finally { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
}

async function assertNoSymlinkAncestors(target: string): Promise<void> {
  const root = path.parse(target).root; let current = root;
  const parts = target.slice(root.length).split(path.sep).filter(Boolean);
  // The target itself may be a regular file (for executable verification) or
  // is checked separately after creation (for a ledger directory).
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    const info = await lstat(current).catch(error => { if (isCode(error, "ENOENT")) return undefined; throw error; });
    if (info && (info.isSymbolicLink() || !info.isDirectory())) throw new SbxCommandError("host process path has an unsafe ancestor");
  }
}
interface LedgerLockOwner { readonly pid: number; readonly startTime: string; readonly token: string }
interface LedgerLockHandle { readonly token: string; readonly ownerPath: string }

async function acquireLedgerLock(lock: string): Promise<LedgerLockHandle> {
  await mkdir(lock, { recursive: false, mode: 0o700 });
  const ownerPath = path.join(lock, "owner.json");
  const owner: LedgerLockOwner = { pid: process.pid, startTime: await processStartTime(process.pid), token: randomUUID() };
  try {
    await writeExclusiveFile(ownerPath, canonicalBytes(owner), lock, 0o600);
  } catch (error) {
    await rmdir(lock).catch(removeError => { if (!isCode(removeError, "ENOENT") && !isCode(removeError, "ENOTEMPTY")) throw removeError; });
    throw error;
  }
  return { token: owner.token, ownerPath };
}

async function readLedgerLockOwner(ownerPath: string): Promise<LedgerLockOwner | undefined> {
  try {
    const bytes = await readExactNoFollow(ownerPath, path.dirname(ownerPath), 4_096);
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value) || !hasExactKeys(value as Record<string, unknown>, ["pid", "startTime", "token"])) throw new SbxCommandError("host process ledger lock owner is malformed");
    const record = value as Record<string, unknown>;
    if (typeof record["pid"] !== "number" || !Number.isSafeInteger(record["pid"]) || (record["pid"] as number) <= 0 || typeof record["startTime"] !== "string" || !/^\d+$/u.test(record["startTime"]) || typeof record["token"] !== "string" || !/^[0-9a-f-]{36}$/iu.test(record["token"]) || !bytes.equals(canonicalBytes(value))) throw new SbxCommandError("host process ledger lock owner is malformed");
    return { pid: record["pid"], startTime: record["startTime"], token: record["token"] };
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

async function ledgerOwnerAlive(owner: LedgerLockOwner): Promise<boolean> {
  let start: string;
  try { start = await processStartTime(owner.pid); }
  catch (error) { if (isCode(error, "ENOENT")) return false; return true; }
  if (start !== owner.startTime) return false;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return !isCode(error, "ESRCH"); }
}

async function reclaimLedgerLock(lock: string): Promise<void> {
  const info = await lstat(lock).catch(error => { if (isCode(error, "ENOENT")) return undefined; throw error; });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new SbxCommandError("host process ledger lock is not a private directory");
  const ownerPath = path.join(lock, "owner.json");
  const owner = await readLedgerLockOwner(ownerPath);
  if (!owner) {
    if (Date.now() - info.mtimeMs < 5_000) return;
    await rmdir(lock).catch(error => { if (!isCode(error, "ENOENT") && !isCode(error, "ENOTEMPTY")) throw error; });
    return;
  }
  if (await ledgerOwnerAlive(owner)) return;
  const check = await readLedgerLockOwner(ownerPath);
  if (!check || check.token !== owner.token || check.pid !== owner.pid || check.startTime !== owner.startTime) return;
  await unlink(ownerPath).catch(error => { if (!isCode(error, "ENOENT")) throw error; });
  await rmdir(lock).catch(error => { if (!isCode(error, "ENOENT") && !isCode(error, "ENOTEMPTY")) throw error; });
}

async function releaseLedgerLock(lock: string, handle: LedgerLockHandle): Promise<void> {
  const owner = await readLedgerLockOwner(handle.ownerPath);
  if (!owner || owner.token !== handle.token || owner.pid !== process.pid) throw new SbxCommandError("host process ledger lock ownership changed");
  await unlink(handle.ownerPath);
  await rmdir(lock);
}

function positiveInteger(value: number, label: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new SbxCommandError(`${label} must be a positive integer`); return value; }
function boundedPositiveInteger(value: number, maximum: number, label: string): number { const result = positiveInteger(value, label); if (result > maximum) throw new SbxCommandError(`${label} exceeds its bound`); return result; }
function isCode(error: unknown, code: string, depth = 0): boolean {
  if (!error || typeof error !== "object" || depth > 3) return false;
  if ("code" in error && (error as { code?: unknown }).code === code) return true;
  if ("cause" in error) return isCode((error as { cause?: unknown }).cause, code, depth + 1);
  return false;
}
function pathCleanHost(value: string, allowRoot = false): boolean { return (value.length > 1 || allowRoot) && path.isAbsolute(value) && path.normalize(value) === value && (!value.endsWith(path.sep) || allowRoot && value === path.parse(value).root) && !value.includes("//") && !value.includes("\\") && !/[\u0000-\u001f\u007f\r\n]/u.test(value); }
void assertSha256;
