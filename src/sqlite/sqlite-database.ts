import * as fs from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS, MigrationError, SQLITE_APPLICATION_ID, rollbackMigrations, runMigrations, type MigrationRollbackOptions } from "./migrations.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_DATABASE_MODE = 0o600;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_WAL_CHECKPOINT_PAGES = 1_000;

export interface SqliteDatabaseOptions {
  readonly busyTimeoutMs?: number;
  readonly walAutocheckpointPages?: number;
  readonly migrate?: boolean;
  readonly targetVersion?: number;
}
export interface SqliteDatabaseConfig extends SqliteDatabaseOptions { readonly path: string; }

export class SqliteDatabaseError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "SqliteDatabaseError"; }
}
export class SqliteCorruptionError extends SqliteDatabaseError { constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "SqliteCorruptionError"; } }

/** Hardened, single-host SQLite lifecycle.  Only this module owns the native
 * handle; higher layers use bounded transaction callbacks rather than SQL. */
export class SqliteDatabase {
  readonly path: string;
  readonly identity!: string;
  readonly #db!: Database.Database;
  #healthy = true;
  #closed = false;
  readonly #busyTimeoutMs: number;

  constructor(filename: string | SqliteDatabaseConfig, options: SqliteDatabaseOptions = {}) {
    const configured = typeof filename === "string" ? { path: filename, ...options } : { ...filename, ...options };
    this.path = assertDatabasePath(configured.path);
    this.#busyTimeoutMs = boundedPositive(configured.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS, "busy timeout");
    const checkpoint = boundedPositive(configured.walAutocheckpointPages ?? DEFAULT_WAL_CHECKPOINT_PAGES, "WAL checkpoint");
    try {
      ensurePrivateParent(this.path);
      rejectUnsafeExistingDatabase(this.path);
      this.#db = new Database(this.path, { timeout: this.#busyTimeoutMs, fileMustExist: false });
      chmodSyncPrivate(this.path);
      const opened = lstatSync(this.path)!;
      this.identity = `${opened.dev}:${opened.ino}:${this.path}`;
      this.#configure(checkpoint);
      if (configured.migrate !== false) runMigrations(this.#db, configured.targetVersion ?? CURRENT_SCHEMA_VERSION);
      this.quickCheck();
    } catch (error) {
      try { this.#db?.close(); } catch { /* constructor failure */ }
      if (error instanceof SqliteDatabaseError || error instanceof MigrationError) throw error;
      throw new SqliteDatabaseError("unable to open the controller database", { cause: error });
    }
  }

  get healthy(): boolean { return this.#healthy && !this.#closed; }
  /** Called by row codecs when relational/snapshot authority is corrupt. */
  markUnhealthy(): void { this.#healthy = false; }
  get userVersion(): number { this.assertOpen(); return Number(this.#db.pragma("user_version", { simple: true })); }
  get applicationId(): number { this.assertOpen(); return Number(this.#db.pragma("application_id", { simple: true })); }
  get inTransaction(): boolean { return !this.#closed && this.#db.inTransaction; }
  /** A narrow pragma read seam for tests/health evidence. */
  pragma(name: string): unknown { this.assertOpen(); if (!/^[a-z_]+$/u.test(name)) throw new SqliteDatabaseError("unsafe pragma name"); return this.#db.pragma(name); }

  transactionImmediate<T>(operation: () => T): T {
    return this.transaction("BEGIN IMMEDIATE", operation);
  }
  transactionExclusive<T>(operation: () => T): T {
    return this.transaction("BEGIN EXCLUSIVE", operation);
  }
  transaction<T>(begin: "BEGIN IMMEDIATE" | "BEGIN EXCLUSIVE" | "BEGIN", operation: () => T): T {
    this.assertWritable();
    try {
      this.#db.exec(begin);
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try { if (this.#db.inTransaction) this.#db.exec("ROLLBACK"); } catch { /* preserve root error */ }
      this.#markIfCorrupt(error);
      throw error;
    }
  }

  prepare(sql: string): Database.Statement { this.assertOpen(); if (/[;]\s*\S/u.test(sql)) throw new SqliteDatabaseError("prepared statements accept one SQL statement"); return this.#db.prepare(sql); }
  exec(sql: string): void { this.assertWritable(); this.#db.exec(sql); }

  quickCheck(): void {
    this.assertOpen();
    try {
      const result = this.#db.pragma("quick_check") as Array<{ quick_check?: unknown }>;
      if (!Array.isArray(result) || result.length !== 1 || result[0]?.quick_check !== "ok") throw new SqliteCorruptionError("SQLite quick_check failed");
      const foreign = this.#db.pragma("foreign_key_check") as unknown[];
      if (Array.isArray(foreign) && foreign.length > 0) throw new SqliteCorruptionError("SQLite foreign-key check failed");
    } catch (error) {
      this.#markIfCorrupt(error);
      if (error instanceof SqliteDatabaseError) throw error;
      throw new SqliteCorruptionError("SQLite integrity check failed", { cause: error });
    }
  }

  async backup(destination: string): Promise<void> {
    this.assertOpen();
    const target = assertDatabasePath(destination);
    if (target === this.path) throw new SqliteDatabaseError("backup destination equals the live database");
    ensurePrivateParent(target);
    rejectUnsafeExistingDatabase(target);
    try {
      await this.#db.backup(target);
      chmodSyncPrivate(target);
      const backupStat = await stat(target);
      if (!backupStat.isFile() || (backupStat.mode & 0o077) !== 0) throw new SqliteDatabaseError("SQLite backup is not private");
      const verification = new Database(target, { readonly: true });
      try {
        const result = verification.pragma("quick_check") as Array<{ quick_check?: unknown }>;
        if (result[0]?.quick_check !== "ok") throw new SqliteCorruptionError("SQLite backup failed quick_check");
      } finally { verification.close(); }
    } catch (error) { this.#markIfCorrupt(error); throw error; }
  }

  async rollbackTo(targetVersion: number, options: MigrationRollbackOptions): Promise<void> {
    this.assertWritable();
    await rollbackMigrations(this.#db, targetVersion, options);
    this.quickCheck();
  }

  checkpoint(): void {
    this.assertOpen();
    try { this.#db.pragma("wal_checkpoint(TRUNCATE)"); } catch (error) { this.#markIfCorrupt(error); throw error; }
  }

  close(): void {
    if (this.#closed) return;
    try { this.checkpoint(); } catch { /* close must still release native resources */ }
    this.#db.close();
    this.#closed = true;
  }

  #configure(checkpoint: number): void {
    const existingApplicationId = Number(this.#db.pragma("application_id", { simple: true }));
    if (existingApplicationId === 0) this.#db.pragma("application_id = 0x53515245");
    else if (existingApplicationId !== SQLITE_APPLICATION_ID) throw new SqliteDatabaseError("unexpected SQLite application_id");
    this.#db.pragma("foreign_keys = ON");
    const journal = this.#db.pragma("journal_mode = WAL", { simple: true });
    if (String(journal).toLowerCase() !== "wal") throw new SqliteDatabaseError("SQLite WAL mode was not enabled");
    this.#db.pragma("synchronous = FULL");
    this.#db.pragma(`wal_autocheckpoint = ${checkpoint}`);
    this.#db.pragma(`busy_timeout = ${this.#busyTimeoutMs}`);
    if (Number(this.#db.pragma("foreign_keys", { simple: true })) !== 1) throw new SqliteDatabaseError("SQLite foreign_keys pragma was not enabled");
    if (Number(this.#db.pragma("synchronous", { simple: true })) !== 2) throw new SqliteDatabaseError("SQLite synchronous=FULL was not enabled");
  }
  assertOpen(): void {
    if (this.#closed) throw new SqliteDatabaseError("SQLite database is closed");
    if (!this.#healthy) throw new SqliteCorruptionError("SQLite side-effect gate is closed after a database fault");
    try { const current = lstatSync(this.path)!; if (!current.isFile() || current.isSymbolicLink() || `${current.dev}:${current.ino}:${this.path}` !== this.identity) { this.#healthy = false; throw new SqliteCorruptionError("SQLite database identity changed"); } }
    catch (error) { if (error instanceof SqliteDatabaseError) throw error; this.#healthy = false; throw new SqliteCorruptionError("SQLite database identity cannot be verified", { cause: error }); }
  }
  private assertWritable(): void { this.assertOpen(); if (this.#db.readonly) throw new SqliteDatabaseError("SQLite database is read-only"); }
  #markIfCorrupt(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (/SQLITE_CORRUPT|malformed|quick_check|database disk image is corrupt/iu.test(message)) this.#healthy = false;
  }
}

/** Compatibility spelling used by integrations and tests. */
export const SQLiteDatabase = SqliteDatabase;
export function openSqliteDatabase(config: string | SqliteDatabaseConfig, options?: SqliteDatabaseOptions): SqliteDatabase { return new SqliteDatabase(config, options); }
export const createSqliteDatabase = openSqliteDatabase;

function assertDatabasePath(value: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value || path.parse(value).root === value) throw new SqliteDatabaseError("database path must be an absolute non-root path");
  if (value.includes("\0") || /[\r\n]/u.test(value) || value.includes("?") || value.includes("#")) throw new SqliteDatabaseError("database path contains unsafe URI/control characters");
  return value;
}
function ensurePrivateParent(filename: string): void {
  const parent = path.dirname(filename);
  // Synchronous setup is intentional: no caller can observe a half-configured
  // database handle before WAL/foreign-key/mode checks have completed.
  try { mkdirSyncPrivate(parent); } catch (error) { throw new SqliteDatabaseError("database parent cannot be created", { cause: error }); }
  let current = parent;
  let direct = true;
  while (current !== path.parse(current).root) {
    const info = lstatSync(current)!;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new SqliteDatabaseError("database parent is not a directory");
    const mode = Number(info.mode);
    if (direct && (mode & 0o077) !== 0) throw new SqliteDatabaseError("database parent is not private");
    // A sticky system temporary ancestor is acceptable; an arbitrary
    // world-writable ancestor is not.  The configured parent itself remains
    // strictly private.
    if (!direct && (mode & 0o002) !== 0 && (mode & 0o1000) === 0) throw new SqliteDatabaseError("database path crosses an unsafe writable ancestor");
    if (direct && typeof process.getuid === "function" && info.uid !== process.getuid()) throw new SqliteDatabaseError("database parent is not owned by the controller user");
    direct = false;
    current = path.dirname(current);
  }
}
function rejectUnsafeExistingDatabase(filename: string): void {
  try {
    const info = lstatSync(filename)!;
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new SqliteDatabaseError("existing database is not a private regular file");
    if ((Number(info.mode) & 0o077) !== 0) throw new SqliteDatabaseError("existing database has unsafe permissions");
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new SqliteDatabaseError("existing database is not owned by the controller user");
  } catch (error) {
    if (isMissing(error)) return;
    if (error instanceof SqliteDatabaseError) throw error;
    throw new SqliteDatabaseError("cannot inspect the configured database", { cause: error });
  }
}
function mkdirSyncPrivate(directory: string): void {
  // eslint-free synchronous helper avoids an async constructor race.  Inspect
  // an existing path before chmod: chmod(path) would follow a hostile parent
  // symlink on platforms where the kernel permits it.
  try {
    const existing = fs.lstatSync(directory);
    if (existing.isSymbolicLink() || !existing.isDirectory() || (Number(existing.mode) & 0o077) !== 0) throw new SqliteDatabaseError("database parent is not a private directory");
  } catch (error) {
    if (!isMissing(error)) throw error;
    fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  }
  const info = fs.lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || (Number(info.mode) & 0o077) !== 0) throw new SqliteDatabaseError("database parent is not a private directory");
  fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  const after = fs.lstatSync(directory);
  if (after.isSymbolicLink() || !after.isDirectory() || (Number(after.mode) & 0o077) !== 0) throw new SqliteDatabaseError("database parent is not private");
}
function chmodSyncPrivate(filename: string): void {
  fs.chmodSync(filename, PRIVATE_DATABASE_MODE);
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (Number(info.mode) & 0o077) !== 0) throw new SqliteDatabaseError("database file is not private");
}
function lstatSync(filename: string): ReturnType<typeof fs.lstatSync> { return fs.lstatSync(filename); }
function isMissing(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"); }
function boundedPositive(value: number, label: string): number { if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) throw new SqliteDatabaseError(`${label} is outside its bound`); return value; }
