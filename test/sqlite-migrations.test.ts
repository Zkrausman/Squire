import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CURRENT_SCHEMA_VERSION, SqliteDatabase, SqliteDatabaseError } from "../src/index.js";

async function tempDb(): Promise<{ root: string; file: string }> { const root = await mkdtemp(path.join(tmpdir(), "squire-sqlite-")); await chmod(root, 0o700); return { root, file: path.join(root, "controller.db") }; }

test("SQLite opens private WAL/full-sync storage and survives explicit checkpoint/restart", async () => {
  const { root, file } = await tempDb();
  try {
    const db = new SqliteDatabase({ path: file });
    assert.equal(db.userVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(db.applicationId, 0x53515245);
    assert.equal((db.pragma("foreign_keys") as Array<{ foreign_keys: number }>)[0]?.foreign_keys, 1);
    assert.equal((db.pragma("journal_mode") as Array<{ journal_mode: string }>)[0]?.journal_mode, "wal");
    assert.equal((db.pragma("synchronous") as Array<{ synchronous: number }>)[0]?.synchronous, 2);
    db.checkpoint(); db.close();
    const restarted = new SqliteDatabase(file);
    assert.equal(restarted.userVersion, CURRENT_SCHEMA_VERSION);
    restarted.close();
    const mode = (await readFile(file)).length;
    assert.ok(mode > 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("SQLite rejects a symlinked or permissive existing database", async () => {
  const { root, file } = await tempDb();
  try {
    const db = new SqliteDatabase(file); db.close();
    await chmod(file, 0o644);
    assert.throws(() => new SqliteDatabase(file), SqliteDatabaseError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("migration rollback makes a verified backup and re-upgrades without workflow rows", async () => {
  const { root, file } = await tempDb();
  try {
    const db = new SqliteDatabase(file);
    const backup = path.join(root, "backup.db");
    await db.rollbackTo(0, { backupPath: backup, operatorToken: "operator-test-token" });
    assert.equal(db.userVersion, 0);
    db.close();
    const upgraded = new SqliteDatabase(file);
    assert.equal(upgraded.userVersion, CURRENT_SCHEMA_VERSION);
    upgraded.close();
    const backupDb = new SqliteDatabase({ path: backup, migrate: false });
    assert.equal(backupDb.userVersion, CURRENT_SCHEMA_VERSION);
    backupDb.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
