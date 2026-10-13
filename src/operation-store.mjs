import { randomUUID } from 'node:crypto';
import { Blocker, digest } from './contracts.mjs';
import { producerContext } from './producer-context.mjs';
import { compareSettlementContract, settlementContractDigest, SQF04_DESIGN_SHA256 } from './settlement-contract.mjs';

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
 CREATE TABLE IF NOT EXISTS process_inventory_seals (
 scope_id TEXT PRIMARY KEY, payload TEXT NOT NULL, seal_digest TEXT NOT NULL, created_at INTEGER NOT NULL);
 CREATE TRIGGER IF NOT EXISTS immutable_inventory_seal_insert BEFORE INSERT ON process_inventory_seals
 WHEN EXISTS(SELECT 1 FROM process_inventory_seals WHERE scope_id=NEW.scope_id)
 BEGIN SELECT RAISE(ABORT,'immutable process inventory seal'); END;
 CREATE TRIGGER IF NOT EXISTS immutable_inventory_seal_update BEFORE UPDATE ON process_inventory_seals
 BEGIN SELECT RAISE(ABORT,'immutable process inventory seal'); END;
 CREATE TRIGGER IF NOT EXISTS immutable_inventory_seal_delete BEFORE DELETE ON process_inventory_seals
 BEGIN SELECT RAISE(ABORT,'immutable process inventory seal'); END;
 CREATE TRIGGER IF NOT EXISTS sealed_operation_insert BEFORE INSERT ON process_operations
 WHEN EXISTS(SELECT 1 FROM process_inventory_seals WHERE scope_id=NEW.scope_id)
 OR EXISTS(SELECT 1 FROM process_operations o JOIN process_inventory_seals s ON s.scope_id=o.scope_id WHERE o.id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'sealed process inventory'); END;
 CREATE TRIGGER IF NOT EXISTS sealed_operation_update BEFORE UPDATE ON process_operations
 WHEN EXISTS(SELECT 1 FROM process_inventory_seals WHERE scope_id=OLD.scope_id OR scope_id=NEW.scope_id)
 OR EXISTS(SELECT 1 FROM process_operations r JOIN process_inventory_seals s ON s.scope_id=r.scope_id WHERE r.id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'sealed process inventory'); END;
 CREATE TRIGGER IF NOT EXISTS sealed_operation_delete BEFORE DELETE ON process_operations
 WHEN EXISTS(SELECT 1 FROM process_inventory_seals WHERE scope_id=OLD.scope_id)
 BEGIN SELECT RAISE(ABORT,'sealed process inventory'); END;
 CREATE TRIGGER IF NOT EXISTS sealed_call_insert BEFORE INSERT ON producer_calls
 WHEN EXISTS(SELECT 1 FROM process_inventory_seals WHERE scope_id=NEW.scope_id)
 OR EXISTS(SELECT 1 FROM producer_calls c JOIN process_inventory_seals s ON s.scope_id=c.scope_id WHERE c.job_id=NEW.job_id)
 BEGIN SELECT RAISE(ABORT,'sealed process inventory'); END;
 CREATE TRIGGER IF NOT EXISTS sealed_call_update BEFORE UPDATE ON producer_calls
 WHEN EXISTS(SELECT 1 FROM process_inventory_seals WHERE scope_id=OLD.scope_id OR scope_id=NEW.scope_id)
 OR EXISTS(SELECT 1 FROM producer_calls r JOIN process_inventory_seals s ON s.scope_id=r.scope_id WHERE r.job_id=NEW.job_id)
 BEGIN SELECT RAISE(ABORT,'sealed process inventory'); END;
 CREATE TRIGGER IF NOT EXISTS sealed_call_delete BEFORE DELETE ON producer_calls
 WHEN EXISTS(SELECT 1 FROM process_inventory_seals WHERE scope_id=OLD.scope_id)
 BEGIN SELECT RAISE(ABORT,'sealed process inventory'); END;
 CREATE TRIGGER IF NOT EXISTS sealed_scope_insert BEFORE INSERT ON producer_scopes
 WHEN EXISTS(SELECT 1 FROM process_inventory_seals WHERE scope_id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'sealed scope has no settlement authority'); END;
 CREATE TRIGGER IF NOT EXISTS sealed_scope_update BEFORE UPDATE ON producer_scopes
 WHEN EXISTS(SELECT 1 FROM process_inventory_seals WHERE scope_id=OLD.id OR scope_id=NEW.id)
 BEGIN SELECT RAISE(ABORT,'sealed scope has no settlement authority'); END;
 CREATE TRIGGER IF NOT EXISTS sealed_scope_delete BEFORE DELETE ON producer_scopes
 WHEN EXISTS(SELECT 1 FROM process_inventory_seals WHERE scope_id=OLD.id)
 BEGIN SELECT RAISE(ABORT,'sealed scope has no settlement authority'); END;
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
function assertUnsealed(store, scopeId) {
 if (store.db.prepare('SELECT scope_id FROM process_inventory_seals WHERE scope_id=?').get(scopeId))
  throw blocked('Sealed process inventory cannot reserve, launch, close or import an outcome', { scopeId });
}
export function reserveCall(store, scopeId, jobId) {
 const scope = scopeRow(store, scopeId); assertOwner(store, scope); assertUnsealed(store, scopeId);
 assertResolvedOperations(store, scopeId);
 store.db.prepare('INSERT INTO producer_calls VALUES (?,?)').run(jobId, scopeId);
}
export function registerOperation(store, scopeId, jobId, id, directory, requestDigest) {
 return store.transaction(() => {
  const scope = scopeRow(store, scopeId); assertOwner(store, scope); assertUnsealed(store, scopeId);
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
  const scope = scopeRow(store, op.scope_id); assertOwner(store, scope); assertUnsealed(store, op.scope_id);
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
 const scope = scopeRow(store, scopeId); assertOwner(store, scope); assertUnsealed(store, scopeId);
 if (scope.project !== project) throw blocked('Producer project does not match');
 assertResolvedOperations(store, scopeId);
 store.db.prepare('UPDATE producer_scopes SET outcome=?,closed_at=? WHERE id=? AND closed_at IS NULL')
  .run(JSON.stringify({ version: 1, stateDigest: digest(state) }), Date.now(), scopeId);
}


function inventoryPayload(store, scope) {
 const rows = store.db.prepare('SELECT id,job_id,request_digest,phase,terminal FROM process_operations WHERE scope_id=? ORDER BY id LIMIT 101').all(scope.id);
 const calls = store.db.prepare('SELECT job_id FROM producer_calls WHERE scope_id=? ORDER BY job_id LIMIT 101').all(scope.id);
 const text = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !value.includes('\0');
 const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
 if (!rows.length || rows.length > 100 || calls.length > 100 || calls.some(c => !text(c.job_id))) throw blocked('Complete bounded process inventory is unavailable', { scopeId: scope.id });
 assertResolvedOperations(store, scope.id);
 const operations = rows.map(row => {
  const terminal = JSON.parse(row.terminal);
  if (Object.keys(terminal).length !== 4 || !['kind', 'exitCode', 'endedAt', 'receiptDigest'].every(key => Object.hasOwn(terminal, key)) || !text(row.id) || !hash(row.request_digest) || !((row.phase === 'target' && terminal.kind === 'terminal') || (row.phase === 'registered' && terminal.kind === 'not_started')) ||
      (row.job_id !== null && (!text(row.job_id) || !calls.some(c => c.job_id === row.job_id)))) throw blocked('Process inventory identity or reservation is incomplete', { scopeId: scope.id });
  return { operationId: row.id, jobId: row.job_id, requestDigest: row.request_digest, phase: row.phase,
   terminal: { kind: terminal.kind, exitCode: terminal.exitCode, endedAt: terminal.endedAt, receiptDigest: terminal.receiptDigest } };
 });
 if (calls.some(c => !operations.some(o => o.jobId === c.job_id))) throw blocked('Reserved call has no covered registered operation', { scopeId: scope.id });
 return { version: 1, designSha256: SQF04_DESIGN_SHA256, scope: { id: scope.id, project: scope.project, lane: scope.lane, leaseOwnerDigest: digest(scope.lease_owner) },
  reservations: calls.map(c => c.job_id), operations };
}
function sealedReference(row, payload) {
 return { scopeId: row.scope_id, sealDigest: row.seal_digest, createdAt: row.created_at,
  operations: payload.operations.map(o => ({ operationId: o.operationId, requestDigest: o.requestDigest, settlementDigest: o.terminal.receiptDigest })),
  launchGate: 'closed', admission: 'not_evaluated', settlement: 'not_evaluated', import: 'not_evaluated' };
}
/** Explicit opt-in fence only. Captures canonical direct-terminal references, NOT
 * full descendant settlement. No controller activation, import, debit or refund.
 * Any sealed scope stays held: this slice provides no closure/release API. */
export function sealInventory(store, scopeId) {
 return store.transaction(() => {
  const scope = scopeRow(store, scopeId); assertOwner(store, scope);
  const context = producerContext();
  if (context?.store !== store || context.scopeId !== scopeId || context.project !== scope.project || context.lifecycle?.persistenceFailed)
   throw blocked('Inventory seal requires the current healthy producer context', { scopeId });
  const payload = inventoryPayload(store, scope), sealDigest = settlementContractDigest(payload);
  if (!sealDigest) throw blocked('Process inventory exceeds its JSON reference bound', { scopeId });
  let row = store.db.prepare('SELECT * FROM process_inventory_seals WHERE scope_id=?').get(scopeId);
  if (row) {
   if (row.seal_digest !== sealDigest || settlementContractDigest(JSON.parse(row.payload)) !== sealDigest) throw blocked('Conflicting process inventory seal refused', { scopeId });
  } else {
   const createdAt = Date.now();
   store.db.prepare('INSERT INTO process_inventory_seals VALUES (?,?,?,?)').run(scopeId, JSON.stringify(payload), sealDigest, createdAt);
   row = { scope_id: scopeId, seal_digest: sealDigest, created_at: createdAt };
  }
  const currentScope = scopeRow(store, scopeId); assertOwner(store, currentScope);
  if (context.project !== currentScope.project || context.scopeId !== currentScope.id || context.lifecycle?.persistenceFailed || currentScope.lease_resource !== scope.lease_resource ||
      settlementContractDigest(inventoryPayload(store, currentScope)) !== sealDigest) throw blocked('Process inventory or scope changed during seal persistence', { scopeId });
  return sealedReference(row, payload);
 });
}
/** Non-admitting comparison against a current durable inventory seal. Scope,
 * reservation and request associations come from the store; candidate/policy,
 * observer and host metadata remain supplied assertions, never trusted proof.
 * Reading or matching this record cannot import, close a scope or release gates. */
export function compareSealedInventory(store, scopeId, requirements, receipt, priorProjection = null) {
 const unknown = code => ({ status: 'unknown', admission: 'not_evaluated', settlement: 'not_evaluated', import: 'not_evaluated', replay: 'not_evaluated', blockers: [code] });
 try {
  return store.transaction(() => {
   const scope = scopeRow(store, scopeId); assertOwner(store, scope);
   const row = store.db.prepare('SELECT * FROM process_inventory_seals WHERE scope_id=?').get(scopeId);
   if (!row) return unknown('durable_inventory_seal_missing');
   const payload = JSON.parse(row.payload), current = inventoryPayload(store, scope);
   if (settlementContractDigest(payload) !== row.seal_digest || settlementContractDigest(current) !== row.seal_digest) return unknown('durable_inventory_changed');
   const reference = sealedReference(row, payload), binding = requirements?.binding;
   const operation = payload.operations.find(o => o.operationId === binding?.operationId);
   if (binding?.project !== scope.project || scope.lane !== `ticket:${binding?.ticket}` || !operation || operation.jobId !== binding?.job ||
       operation.requestDigest !== binding?.requestDigest || !payload.reservations.includes(binding?.job)) return unknown('durable_job_or_scope_binding_changed');
   const durableScope = { sealDigest: reference.sealDigest, operations: reference.operations };
   // Check the caller's expected seal too; silently replacing it would hide drift.
   const expectedScope = requirements?.scope;
   const orderedScope = value => value && Array.isArray(value.operations) ? { ...value, operations: [...value.operations].sort((a, b) => a?.operationId < b?.operationId ? -1 : a?.operationId > b?.operationId ? 1 : 0) } : value;
   if (settlementContractDigest(orderedScope(expectedScope)) !== settlementContractDigest(orderedScope(durableScope))) return unknown('expected_inventory_seal_changed');
   return compareSettlementContract(requirements, receipt, priorProjection);
  });
 } catch { return unknown('durable_inventory_unavailable'); }
}
