import { createHash } from "node:crypto";
import { chmodSync, lstatSync } from "node:fs";
import Database from "better-sqlite3";

export interface SqliteMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly up: string;
  readonly down: string;
}

const UP_1 = `
CREATE TABLE IF NOT EXISTS workflow_runs (
  run_id TEXT PRIMARY KEY,
  linear_issue_id TEXT,
  linear_identifier TEXT,
  linear_team_id TEXT,
  linear_state_id TEXT,
  repository_owner TEXT,
  repository_name TEXT,
  base_branch TEXT,
  base_sha TEXT,
  object_format TEXT,
  normalized_ticket_path TEXT,
  normalized_ticket_sha256 TEXT,
  normalized_ticket_schema_id TEXT,
  contract_feature_branch TEXT,
  physical_feature_branch TEXT,
  intake_idempotency_key TEXT,
  state TEXT NOT NULL CHECK (state IN ('accepted','preparing','planning','implementing','reviewing','testing','publishing','awaiting_approval','approved','failed','cancelled','expired')),
  version INTEGER NOT NULL CHECK (version >= 0),
  implement_generation INTEGER NOT NULL CHECK (implement_generation >= 0),
  process_launches INTEGER NOT NULL CHECK (process_launches >= 0),
  current_head TEXT NOT NULL,
  remediation_review INTEGER NOT NULL CHECK (remediation_review >= 0),
  remediation_test INTEGER NOT NULL CHECK (remediation_test >= 0),
  remediation_total INTEGER NOT NULL CHECK (remediation_total >= 0),
  created_at TEXT,
  updated_at TEXT,
  terminal_at TEXT,
  expires_at TEXT,
  success_retention_until TEXT,
  failure_retention_until TEXT,
  last_error_id TEXT,
  operator_blocked INTEGER NOT NULL DEFAULT 0 CHECK (operator_blocked IN (0,1)),
  reconciliation_generation INTEGER,
  snapshot_json TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_intake_identity ON workflow_runs(linear_issue_id, intake_idempotency_key) WHERE linear_issue_id IS NOT NULL AND intake_idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS ticket_run_locks (
  linear_issue_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(run_id),
  acquired_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS ticket_lock_must_target_active_run
BEFORE INSERT ON ticket_run_locks
WHEN NOT EXISTS (SELECT 1 FROM workflow_runs WHERE run_id = NEW.run_id AND linear_issue_id = NEW.linear_issue_id AND state NOT IN ('approved','failed','cancelled','expired'))
BEGIN SELECT RAISE(ABORT, 'ticket lock must target an active matching run'); END;
CREATE TRIGGER IF NOT EXISTS workflow_run_ledger_cannot_be_deleted
BEFORE DELETE ON workflow_runs
BEGIN SELECT RAISE(ABORT, 'workflow ledger rows are immutable'); END;
CREATE TRIGGER IF NOT EXISTS ticket_lock_cannot_be_substituted
BEFORE UPDATE ON ticket_run_locks
WHEN OLD.linear_issue_id <> NEW.linear_issue_id OR OLD.run_id <> NEW.run_id
BEGIN SELECT RAISE(ABORT, 'ticket lock substitution is forbidden'); END;
CREATE TABLE IF NOT EXISTS workflow_events (
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  from_state TEXT,
  to_state TEXT NOT NULL,
  trigger TEXT NOT NULL,
  request_id TEXT,
  head TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  details_json TEXT NOT NULL,
  PRIMARY KEY(run_id, sequence)
);
CREATE TRIGGER IF NOT EXISTS workflow_events_append_only_update
BEFORE UPDATE ON workflow_events
BEGIN SELECT RAISE(ABORT, 'workflow events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS workflow_events_append_only_delete
BEFORE DELETE ON workflow_events
BEGIN SELECT RAISE(ABORT, 'workflow events are append-only'); END;
CREATE TABLE IF NOT EXISTS sessions (
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
  role TEXT NOT NULL CHECK (role IN ('orchestrator','plan','implement','review','test')),
  session_id TEXT NOT NULL,
  session_file TEXT NOT NULL,
  process_generation INTEGER NOT NULL CHECK (process_generation >= 1),
  process_state TEXT CHECK (process_state IS NULL OR process_state IN ('registered','launching','live','exited','failed')),
  process_identity TEXT,
  registered_at TEXT NOT NULL,
  PRIMARY KEY(run_id, role), UNIQUE(session_id), UNIQUE(session_file)
);
CREATE TABLE IF NOT EXISTS process_allocations (
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
  role TEXT NOT NULL CHECK (role IN ('orchestrator','plan','implement','review','test')),
  owner TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  state TEXT NOT NULL CHECK (state IN ('reserved','spawning','spawned','termination_failed','failed')),
  session_id TEXT,
  session_file TEXT,
  process_identity TEXT,
  allocated_at TEXT NOT NULL,
  PRIMARY KEY(run_id, role)
);
CREATE TABLE IF NOT EXISTS phase_attempts (
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
  phase TEXT NOT NULL CHECK (phase IN ('plan','implement','review','test')),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  handoff_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  input_head TEXT NOT NULL,
  input_json TEXT NOT NULL,
  feedback_json TEXT NOT NULL,
  accepted_result_json TEXT,
  accepted_status TEXT,
  accepted_output_head TEXT,
  accepted_at TEXT,
  completed_at TEXT,
  accepted_generation INTEGER,
  dispatch_json TEXT NOT NULL,
  PRIMARY KEY(run_id, phase, attempt), UNIQUE(run_id, handoff_id), UNIQUE(run_id, operation_key), UNIQUE(run_id, accepted_result_json)
);
CREATE TABLE IF NOT EXISTS gates (
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
  phase TEXT NOT NULL CHECK (phase IN ('review','test')),
  head TEXT NOT NULL,
  result_json TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  implement_generation INTEGER NOT NULL CHECK (implement_generation >= 0),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  PRIMARY KEY(run_id, phase)
);
CREATE TABLE IF NOT EXISTS leases (
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
  lease_key TEXT NOT NULL,
  owner TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, lease_key)
);
CREATE TABLE IF NOT EXISTS lease_token_counters (
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
  lease_key TEXT NOT NULL,
  last_token INTEGER NOT NULL CHECK (last_token >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(run_id, lease_key)
);
CREATE TABLE IF NOT EXISTS preparation_leases (
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
  owner TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
  acquired_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state = 'held'),
  PRIMARY KEY(run_id, owner, fencing_token)
);
CREATE TABLE IF NOT EXISTS terminal_fences (
  run_id TEXT PRIMARY KEY REFERENCES workflow_runs(run_id),
  owner TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
  acquired_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('held','removed'))
);
CREATE TABLE IF NOT EXISTS resource_bindings (
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
  kind TEXT NOT NULL CHECK (kind IN ('linear_issue','sandbox','herdr_workspace','herdr_tab','herdr_root_pane','herdr_runner','git_branch','git_workspace','git_bundle','pi_session','github_pr')),
  scope TEXT NOT NULL,
  role_key TEXT NOT NULL DEFAULT '' CHECK (role_key IN ('','orchestrator','plan','implement','review','test')),
  deterministic_key TEXT NOT NULL,
  deterministic_name TEXT NOT NULL,
  external_id TEXT,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  state TEXT NOT NULL CHECK (state IN ('planned','creating','bound','retained','deleted','blocked')),
  metadata_json TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(run_id, kind, role_key),
  UNIQUE(scope, deterministic_key), UNIQUE(scope, deterministic_name)
);
CREATE UNIQUE INDEX IF NOT EXISTS resource_bindings_external_identity ON resource_bindings(kind, scope, external_id) WHERE external_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS delivery_bindings (
  run_id TEXT PRIMARY KEY REFERENCES workflow_runs(run_id),
  repository_scope TEXT,
  feature_branch TEXT,
  bundle_path TEXT,
  bundle_digest TEXT,
  github_repository_id TEXT,
  github_node_id TEXT,
  pr_number INTEGER,
  pr_node_id TEXT,
  pr_url TEXT,
  observed_head TEXT,
  approval_observation_id TEXT,
  checks_observation_id TEXT,
  UNIQUE(repository_scope, feature_branch), UNIQUE(repository_scope, pr_number), UNIQUE(pr_node_id), UNIQUE(pr_url)
);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_bundle_path_identity ON delivery_bindings(bundle_path) WHERE bundle_path IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS delivery_bundle_digest_identity ON delivery_bindings(bundle_digest) WHERE bundle_digest IS NOT NULL;
CREATE TABLE IF NOT EXISTS webhook_receipts (
  provider TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  event_type TEXT NOT NULL,
  linear_issue_id TEXT,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received','processing','applied','ignored','failed','blocked')),
  owner TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  run_id TEXT,
  last_error_id TEXT,
  PRIMARY KEY(provider, delivery_id)
);
CREATE TABLE IF NOT EXISTS operator_errors (
  error_id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES workflow_runs(run_id),
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  component TEXT NOT NULL,
  retryable INTEGER NOT NULL CHECK (retryable IN (0,1)),
  operator_action_required INTEGER NOT NULL CHECK (operator_action_required IN (0,1)),
  evidence_json TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  first_occurred_at TEXT NOT NULL,
  last_occurred_at TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL CHECK (occurrence_count >= 1),
  resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS operator_errors_fingerprint ON operator_errors(run_id, fingerprint) WHERE resolved_at IS NULL;
CREATE TRIGGER IF NOT EXISTS operator_errors_history_cannot_be_deleted
BEFORE DELETE ON operator_errors
BEGIN SELECT RAISE(ABORT, 'operator error history is append-only'); END;
CREATE TABLE IF NOT EXISTS operator_resolutions (
  error_id TEXT PRIMARY KEY REFERENCES operator_errors(error_id),
  action_id TEXT NOT NULL UNIQUE,
  run_id TEXT REFERENCES workflow_runs(run_id),
  expected_version INTEGER NOT NULL CHECK (expected_version >= 0),
  resource_identity TEXT,
  resolved_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reconciliation_cycles (
  generation INTEGER PRIMARY KEY,
  controller_owner TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('observing','recovering','ready','blocked')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  blocking_error_id TEXT
);
CREATE TABLE IF NOT EXISTS reconciliation_observations (
  generation INTEGER NOT NULL REFERENCES reconciliation_cycles(generation),
  provider TEXT NOT NULL,
  observation_token TEXT,
  digest TEXT,
  complete INTEGER NOT NULL CHECK (complete IN (0,1)),
  observed_at TEXT NOT NULL,
  error_id TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(generation, provider)
);
CREATE TABLE IF NOT EXISTS controller_leases (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
  expires_at INTEGER NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0)
);
CREATE TABLE IF NOT EXISTS cleanup_journal (
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
  resource_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('planned','running','completed','failed')),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  owner TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT,
  PRIMARY KEY(run_id, resource_key, operation)
);
CREATE TABLE IF NOT EXISTS intake_artifact_intents (
  run_id TEXT PRIMARY KEY,
  linear_issue_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  artifact_schema_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('intent','published','committed','quarantined'))
);
`;
const UP_2 = `
CREATE TABLE IF NOT EXISTS webhook_claim_leases (
  provider TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL CHECK (claimed_at >= 0),
  PRIMARY KEY(provider, delivery_id),
  FOREIGN KEY(provider, delivery_id) REFERENCES webhook_receipts(provider, delivery_id) ON DELETE CASCADE
);
INSERT OR IGNORE INTO webhook_claim_leases(provider, delivery_id, claimed_at)
  SELECT provider, delivery_id, CAST(received_at AS INTEGER) FROM webhook_receipts;
CREATE TABLE IF NOT EXISTS reconciliation_decisions (
  generation INTEGER NOT NULL REFERENCES reconciliation_cycles(generation),
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
  provider TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_scope TEXT NOT NULL,
  role_key TEXT NOT NULL DEFAULT '',
  deterministic_key TEXT NOT NULL,
  deterministic_name TEXT NOT NULL,
  planned_external_id TEXT,
  observed_external_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('observe','adopt','create','recover','block','ignore')),
  reason TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  PRIMARY KEY(generation, run_id, provider, resource_kind, resource_scope, role_key, deterministic_key)
);
CREATE TABLE IF NOT EXISTS reconciliation_actions (
  generation INTEGER NOT NULL REFERENCES reconciliation_cycles(generation),
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
  provider TEXT NOT NULL,
  action_key TEXT NOT NULL,
  action TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('planned','running','completed','failed')),
  owner TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT,
  PRIMARY KEY(generation, run_id, provider, action_key)
);
CREATE TABLE IF NOT EXISTS cleanup_resource_journal (
  run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
  resource_kind TEXT NOT NULL,
  resource_scope TEXT NOT NULL,
  role_key TEXT NOT NULL DEFAULT '',
  deterministic_key TEXT NOT NULL,
  deterministic_name TEXT NOT NULL,
  external_id TEXT,
  binding_generation INTEGER NOT NULL CHECK (binding_generation >= 0),
  operation TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('planned','running','completed','failed')),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  owner TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error_message TEXT,
  PRIMARY KEY(run_id, resource_kind, resource_scope, role_key, deterministic_key, operation)
);
`;

const DOWN_1 = `
DROP TABLE IF EXISTS intake_artifact_intents;
DROP TABLE IF EXISTS cleanup_journal;
DROP TABLE IF EXISTS controller_leases;
DROP TABLE IF EXISTS reconciliation_observations;
DROP TABLE IF EXISTS reconciliation_cycles;
DROP TABLE IF EXISTS operator_resolutions;
DROP TABLE IF EXISTS operator_errors;
DROP TABLE IF EXISTS webhook_receipts;
DROP TABLE IF EXISTS delivery_bindings;
DROP TABLE IF EXISTS resource_bindings;
DROP TABLE IF EXISTS terminal_fences;
DROP TABLE IF EXISTS preparation_leases;
DROP TABLE IF EXISTS lease_token_counters;
DROP TABLE IF EXISTS leases;
DROP TABLE IF EXISTS gates;
DROP TABLE IF EXISTS phase_attempts;
DROP TABLE IF EXISTS process_allocations;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS workflow_events;
DROP TABLE IF EXISTS ticket_run_locks;
DROP TABLE IF EXISTS workflow_runs;
`;

export const CURRENT_SCHEMA_VERSION = 2;
export const SQLITE_APPLICATION_ID = 0x53515245;
const DOWN_2 = `
DROP TABLE IF EXISTS cleanup_resource_journal;
DROP TABLE IF EXISTS reconciliation_actions;
DROP TABLE IF EXISTS reconciliation_decisions;
DROP TABLE IF EXISTS webhook_claim_leases;
`;

export const MIGRATIONS: readonly SqliteMigration[] = Object.freeze([
  { version: 1, name: "initial-workflow-ledger", up: UP_1, down: DOWN_1, checksum: createHash("sha256").update(`1\ninitial-workflow-ledger\n${UP_1}\n${DOWN_1}`, "utf8").digest("hex") },
  { version: 2, name: "reconciliation-and-exact-cleanup", up: UP_2, down: DOWN_2, checksum: createHash("sha256").update(`2\nreconciliation-and-exact-cleanup\n${UP_2}\n${DOWN_2}`, "utf8").digest("hex") },
]);

export class MigrationError extends Error { constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "MigrationError"; } }

export function migrationForVersion(version: number): SqliteMigration | undefined { return MIGRATIONS.find(migration => migration.version === version); }

export function runMigrations(db: Database.Database, targetVersion = CURRENT_SCHEMA_VERSION): void {
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 0 || targetVersion > CURRENT_SCHEMA_VERSION) throw new MigrationError("unsupported migration target version");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const application = Number(db.pragma("user_version", { simple: true }));
  if (!Number.isSafeInteger(application) || application < 0) throw new MigrationError("invalid SQLite user_version");
  if (application > CURRENT_SCHEMA_VERSION) throw new MigrationError("database was created by a newer controller");
  const rows = db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all() as Array<{ version: number; name: string; checksum: string }>;
  for (const row of rows) {
    const migration = migrationForVersion(row.version);
    if (!migration || migration.name !== row.name || migration.checksum !== row.checksum) throw new MigrationError(`migration checksum drift at version ${row.version}`);
  }
  if (application !== rows.length && !(application === 0 && rows.length === 0)) throw new MigrationError("SQLite user_version and migration history disagree");
  if (application > targetVersion) throw new MigrationError("automatic downgrade is forbidden; use the operator rollback API");
  for (const migration of MIGRATIONS) {
    if (migration.version <= application || migration.version > targetVersion) continue;
    try {
      db.exec("BEGIN EXCLUSIVE");
      db.exec(migration.up);
      db.prepare("INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      db.pragma(`user_version = ${migration.version}`);
      db.exec("COMMIT");
    } catch (error) {
      try { if (db.inTransaction) db.exec("ROLLBACK"); } catch { /* preserve original migration failure */ }
      throw new MigrationError(`migration ${migration.version} failed`, { cause: error });
    }
  }
  if (targetVersion === CURRENT_SCHEMA_VERSION) {
    const finalVersion = Number(db.pragma("user_version", { simple: true }));
    if (finalVersion !== CURRENT_SCHEMA_VERSION) throw new MigrationError("migration did not reach the requested schema version");
  }
}

export interface MigrationRollbackOptions { readonly backupPath: string; readonly operatorToken?: string; }
export class SqliteMigrationRunner {
  constructor(readonly database: Database.Database) {}
  migrate(targetVersion = CURRENT_SCHEMA_VERSION): void { runMigrations(this.database, targetVersion); }
  rollback(targetVersion: number, options: MigrationRollbackOptions): Promise<void> { return rollbackMigrations(this.database, targetVersion, options); }
}

export async function rollbackMigrations(db: Database.Database, targetVersion: number, options: MigrationRollbackOptions): Promise<void> {
  if (options.operatorToken !== undefined && options.operatorToken.length < 8) throw new MigrationError("operator rollback authorization is too short");
  if (!options.backupPath || !options.backupPath.startsWith("/")) throw new MigrationError("rollback requires an absolute backup path");
  try { const existing = lstatSync(options.backupPath); if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1 || (Number(existing.mode) & 0o077) !== 0) throw new MigrationError("rollback backup path is not a private regular file"); } catch (error) { if (!isMissing(error)) throw error; }
  const current = Number(db.pragma("user_version", { simple: true }));
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 0 || targetVersion >= current) throw new MigrationError("rollback target is not lower than current version");
  const rows = db.prepare("SELECT COUNT(*) AS count FROM workflow_runs").get() as { count: number };
  if (Number(rows.count) > 0) throw new MigrationError("destructive rollback is forbidden while workflow rows exist");
  try {
    await db.backup(options.backupPath);
    chmodSync(options.backupPath, 0o600);
    const backupInfo = lstatSync(options.backupPath)!;
    if (!backupInfo.isFile() || backupInfo.nlink !== 1 || (Number(backupInfo.mode) & 0o077) !== 0) throw new MigrationError("SQLite rollback backup is not a private regular file");
    const backup = new Database(options.backupPath, { readonly: true });
    try { const check = backup.pragma("quick_check") as Array<{ quick_check?: unknown }>; if (check.length !== 1 || check[0]?.quick_check !== "ok") throw new MigrationError("SQLite rollback backup failed quick_check"); } finally { backup.close(); }
  } catch (error) { if (error instanceof MigrationError) throw error; throw new MigrationError("SQLite rollback backup failed", { cause: error }); }
  try {
    db.exec("BEGIN EXCLUSIVE");
    for (let version = current; version > targetVersion; version -= 1) {
      const migration = migrationForVersion(version);
      if (!migration) throw new MigrationError(`missing migration ${version}`);
      db.exec(migration.down);
      db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(version);
      db.pragma(`user_version = ${version - 1}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    try { if (db.inTransaction) db.exec("ROLLBACK"); } catch { /* preserve original */ }
    throw new MigrationError("migration rollback failed", { cause: error });
  }
}

function isMissing(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"); }
