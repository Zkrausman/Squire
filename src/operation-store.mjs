import { randomUUID } from 'node:crypto';
import { Blocker, digest } from './contracts.mjs';
import { producerContext } from './producer-context.mjs';

export const operationSchema = `
 CREATE TABLE IF NOT EXISTS producer_scopes (
 id TEXT PRIMARY KEY, project TEXT NOT NULL, lane TEXT NOT NULL,
 lease_resource TEXT NOT NULL, lease_owner TEXT NOT NULL, created_at INTEGER NOT NULL,
 outcome TEXT, closed_at INTEGER);
 CREATE UNIQUE INDEX IF NOT EXISTS producer_scope_open ON producer_scopes(project,lane) WHERE closed_at IS NULL;
 CREATE TABLE IF NOT EXISTS producer_resources (scope_id TEXT NOT NULL, resource TEXT NOT NULL, PRIMARY KEY(scope_id,resource));
 CREATE TABLE IF NOT EXISTS producer_calls (job_id TEXT PRIMARY KEY, scope_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS process_operations (
 id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, job_id TEXT, token TEXT NOT NULL,
 directory TEXT NOT NULL, request_digest TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('registered','supervisor','target')),
 terminal TEXT);
 CREATE TRIGGER IF NOT EXISTS immutable_process_terminal BEFORE UPDATE ON process_operations
 WHEN OLD.terminal IS NOT NULL BEGIN SELECT RAISE(ABORT,'immutable process terminal'); END;
 CREATE TRIGGER IF NOT EXISTS immutable_scope_outcome BEFORE UPDATE ON producer_scopes
 WHEN OLD.closed_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'immutable scope outcome'); END;
`;
const blocked = (message, detail = {}) => new Blocker('producer_unresolved', message, detail);
export function scopeRow(store, id) {
 const row = store.db.prepare('SELECT * FROM producer_scopes WHERE id=?').get(id);
 if (!row || row.closed_at !== null) throw blocked('Producer scope is absent or already closed', { scopeId: id });
 return row;
}
export function assertOwner(store, scope) {
 const lease = store.db.prepare('SELECT owner FROM leases WHERE resource=?').get(scope.lease_resource);
 if (!lease || lease.owner !== scope.lease_owner) throw blocked('Producer lease changed; launch and scope closure refused', { scopeId: scope.id });
}
export function beginScope(store, project, lane, lease, resources = []) {
 return store.transaction(() => {
  const held = store.db.prepare(`SELECT id FROM producer_scopes WHERE project=? AND closed_at IS NULL
    AND (lane=? OR lane LIKE 'project:%' OR (? LIKE 'project:%' AND ? != 'project:preflight'))`).get(project, lane, lane, lane);
  if (held) throw blocked('Prior producer outcome is unresolved; replacement work refused', { scopeId: held.id, lane });
  for (const resource of resources) {
   const conflict = store.db.prepare(`SELECT s.id,s.project FROM producer_resources r JOIN producer_scopes s ON s.id=r.scope_id
     WHERE r.resource=? AND s.closed_at IS NULL AND (s.project<>? OR s.lease_owner<>?)`).get(resource, project, lease.owner);
   if (conflict) throw blocked('Repository producer remains held by another controller generation', { scopeId: conflict.id, project: conflict.project });
  }
  const scope = { id: randomUUID(), project, lane, lease_resource: lease.resource, lease_owner: lease.owner };
  assertOwner(store, scope);
  store.db.prepare('INSERT INTO producer_scopes(id,project,lane,lease_resource,lease_owner,created_at) VALUES (?,?,?,?,?,?)')
   .run(scope.id, project, lane, lease.resource, lease.owner, Date.now());
  for (const resource of new Set(resources)) store.db.prepare('INSERT INTO producer_resources VALUES (?,?)').run(scope.id, resource);
  return scope.id;
 });
}
function assertResolvedOperations(store, scopeId) {
 const context = producerContext();
 if (context?.store === store && context.lifecycle?.persistenceFailed) throw blocked('Producer persistence failed; further work remains fenced', { scopeId });
 for (const op of store.db.prepare('SELECT id,terminal FROM process_operations WHERE scope_id=?').all(scopeId)) {
  let terminal; try { terminal = JSON.parse(op.terminal); } catch {}
  if (!terminal || !['terminal','not_started'].includes(terminal.kind) || !Number.isSafeInteger(terminal.endedAt) || terminal.endedAt <= 0 ||
      (terminal.exitCode !== null && !Number.isInteger(terminal.exitCode)) || !/^[a-f0-9]{64}$/.test(terminal.receiptDigest))
   throw blocked('Process outcome is unresolved; producer scope remains held', { scopeId, operationId: op.id });
 }
}
export function reserveCall(store, scopeId, jobId) {
 const scope = scopeRow(store, scopeId); assertOwner(store, scope);
 assertResolvedOperations(store, scopeId);
 store.db.prepare('INSERT INTO producer_calls VALUES (?,?)').run(jobId, scopeId);
}
export function registerOperation(store, scopeId, jobId, id, directory, requestDigest) {
 return store.transaction(() => {
  const scope = scopeRow(store, scopeId); assertOwner(store, scope);
  assertResolvedOperations(store, scopeId);
  if (jobId && store.db.prepare('SELECT scope_id FROM producer_calls WHERE job_id=?').get(jobId)?.scope_id !== scopeId)
   throw blocked('Agent-call reservation is missing', { scopeId });
  const token = randomUUID();
  store.db.prepare('INSERT INTO process_operations VALUES (?,?,?,?,?,?,?,NULL)')
   .run(id, scopeId, jobId ?? null, token, directory, requestDigest, 'registered');
  return { directory: store.directory, id, token };
 });
}
export function claimOperation(store, grant, from, to, requestDigest) {
 if (!((from === 'registered' && to === 'supervisor') || (from === 'supervisor' && to === 'target'))) throw blocked('Invalid launch grant transition');
 return store.transaction(() => {
  const op = operation(store, grant.id);
  if (op.token !== grant.token || op.request_digest !== requestDigest) throw blocked('Process grant or request identity does not match', { operationId: grant.id });
  const scope = scopeRow(store, op.scope_id); assertOwner(store, scope);
  const changed = store.db.prepare('UPDATE process_operations SET phase=? WHERE id=? AND token=? AND phase=? AND terminal IS NULL')
   .run(to, grant.id, grant.token, from).changes;
  if (changed !== 1) throw blocked('Process launch grant was already consumed', { operationId: grant.id });
 });
}
export function operation(store, id) {
 const row = store.db.prepare('SELECT * FROM process_operations WHERE id=?').get(id);
 if (!row) throw blocked('Registered process identity is missing', { operationId: id });
 return row;
}
export function finishOperation(store, grant, phase, record) {
 // Terminal evidence may arrive after lease turnover. It cannot release the scope.
 return store.transaction(() => {
  const op = operation(store, grant.id);
  if (op.token !== grant.token || op.phase !== phase) throw blocked('Terminal writer does not own the launch grant', { operationId: grant.id });
  if (!record || (phase !== 'target' && (phase !== 'registered' || record.kind !== 'not_started')) || !['terminal', 'not_started'].includes(record.kind) || !Number.isSafeInteger(record.endedAt) || record.endedAt <= 0 ||
      !/^[a-f0-9]{64}$/.test(record.receiptDigest) ||
      (record.exitCode !== null && !Number.isInteger(record.exitCode))) throw blocked('Invalid canonical terminal record');
  const canonical = JSON.stringify({ kind: record.kind, exitCode: record.exitCode, endedAt: record.endedAt, receiptDigest: record.receiptDigest });
  if (op.terminal !== null) {
   if (op.terminal !== canonical) throw blocked('Conflicting terminal evidence refused', { operationId: grant.id });
   return;
  }
  store.db.prepare('UPDATE process_operations SET terminal=? WHERE id=? AND terminal IS NULL').run(canonical, grant.id);
 });
}
export function closeScope(store, scopeId, project, state) {
 // Called inside the same transaction as the caller's durable outcome event.
 const scope = scopeRow(store, scopeId); assertOwner(store, scope);
 if (scope.project !== project) throw blocked('Producer project does not match');
 assertResolvedOperations(store, scopeId);
 store.db.prepare('UPDATE producer_scopes SET outcome=?,closed_at=? WHERE id=? AND closed_at IS NULL')
  .run(JSON.stringify({ version: 1, stateDigest: digest(state) }), Date.now(), scopeId);
}
