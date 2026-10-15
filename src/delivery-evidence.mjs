import path from 'node:path';
import { constants } from 'node:fs';
import { mkdir, lstat, open } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { Blocker, digest, isSha } from './contracts.mjs';
import { producerContext } from './producer-context.mjs';
import { scopeRow, assertOwner } from './operation-store.mjs';
import { publishEvidence } from './job-evidence.mjs';

const LIMIT = 128 * 1024;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = () => new Blocker('delivery_evidence_incomplete', 'Delivery evidence is incomplete; no replay or settlement is authorized');
const readerIO = Object.freeze({ lstat, open });
async function directory(root, scopeId, create = false) {
  if (!uuid(scopeId)) throw invalid();
  let current = root;
  for (const component of ['delivery-evidence', scopeId]) {
    current = path.join(current, component);
    if (create) { try { await mkdir(current, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
  }
  return current;
}
async function readDirectoryIdentity(file, io) {
  const stat = await io.lstat(file, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode };
}
async function readDirectoryIdentities(root, scopeId, io) {
  const evidence = path.join(root, 'delivery-evidence');
  const scope = path.join(evidence, scopeId);
  return [await readDirectoryIdentity(evidence, io), await readDirectoryIdentity(scope, io)];
}
function sameDirectoryIdentities(left, right) {
  return left.length === right.length && left.every((identity, index) =>
    identity.dev === right[index].dev && identity.ino === right[index].ino && identity.mode === right[index].mode);
}
function regularSingleLink(stat, bytes) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size === BigInt(bytes);
}
function sameFileMetadata(left, right) {
  return ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'size', 'mtimeNs', 'ctimeNs']
    .every(key => left[key] === right[key]);
}
function binding(state, ticket, service, scopeId) {
  const current = state.tickets.find(t => t.spec.id === ticket.spec.id);
  if (!current || digest(state.config.services[current.spec.service]) !== digest(service) ||
      ['headSha', 'baseSha', 'treeSha', 'branch', 'generation'].some(k => current[k] !== ticket[k]) ||
      ![ticket.headSha, ticket.baseSha, ticket.treeSha].every(isSha) || !Number.isSafeInteger(ticket.generation) || ticket.generation < 1) throw invalid();
  return { projectId: state.id, ticketId: current.spec.id, service: current.spec.service,
    repository: service.delivery.repository, branch: ticket.branch, generation: ticket.generation,
    headSha: ticket.headSha, baseSha: ticket.baseSha, treeSha: ticket.treeSha,
    policyDigest: digest(state.config), scopeId };
}
// Only the existing producer capability can record. Standalone adapters retain
// their API behavior; the controller always supplies a producer context.
export async function recordDeliveryEvidence(root, ticket, service, fact) {
  if (service.delivery.kind !== 'github') return null;
  const context = producerContext();
  if (!context?.store || context.standalone) return null;
  try {
    if (context.lifecycle.persistenceFailed || path.resolve(root) !== path.join(path.resolve(context.store.directory), 'projects', context.project)) throw invalid();
    const scope = scopeRow(context.store, context.scopeId); assertOwner(context.store, scope);
    if (scope.project !== context.project || scope.lane !== `ticket:${ticket.spec.id}`) throw invalid();
    const state = context.store.get(context.project), identity = binding(state, ticket, service, scope.id);
    if (context.store.db.prepare('SELECT config_hash FROM project WHERE id=?').get(state.id)?.config_hash !== identity.policyDigest) throw invalid();
    const previous = state.tickets.find(t => t.spec.id === ticket.spec.id).deliveryEvidence ?? null;
    if (previous) await readDeliveryEvidence(root, previous);
    const operations = context.store.db.prepare('SELECT id,request_digest,phase,terminal FROM process_operations WHERE scope_id=? ORDER BY id').all(scope.id)
      .map(op => ({ id: op.id, requestDigest: op.request_digest, phase: op.phase, terminalDigest: op.terminal === null ? null : digest(JSON.parse(op.terminal)) }));
    const value = { version: 1, identity, fact, operations, previous };
    const dir = await directory(root, scope.id, true);
    const ref = { scopeId: scope.id, ...await publishEvidence(dir, `${randomUUID()}.json`, value, LIMIT) };
    context.store.update(state.id, next => {
      assertOwner(context.store, scopeRow(context.store, scope.id));
      binding(next, ticket, service, scope.id);
      const target = next.tickets.find(t => t.spec.id === ticket.spec.id);
      if (digest(target.deliveryEvidence ?? null) !== digest(previous)) throw invalid();
      target.deliveryEvidence = ref;
    }, 'delivery.observed', { ticketId: ticket.spec.id, reference: ref, kind: fact.kind });
    return ref;
  } catch (e) { context.lifecycle.persistenceFailed = true; throw invalid(); }
}
// Integrity resolution is read-only. Facts, including successes, never grant
// dispatch, retry, debit, merge, adoption or producer-fence release authority.
export async function readDeliveryEvidence(root, ref, expected = {}, io = readerIO) {
  try {
    if (!ref || !uuid(ref.scopeId) || !uuid(ref.file?.slice(0, -5)) || !ref.file.endsWith('.json') ||
        !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0 || ref.bytes > LIMIT || !/^[a-f0-9]{64}$/.test(ref.sha256)) throw invalid();
    if (!io || typeof io.lstat !== 'function' || typeof io.open !== 'function' || !constants.O_NOFOLLOW) throw invalid();
    const directoriesBefore = await readDirectoryIdentities(root, ref.scopeId, io);
    const file = path.join(root, 'delivery-evidence', ref.scopeId, ref.file);
    const pathBefore = await io.lstat(file, { bigint: true });
    if (!regularSingleLink(pathBefore, ref.bytes)) throw invalid();
    const handle = await io.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes;
    try {
      const handleBefore = await handle.stat({ bigint: true });
      if (!regularSingleLink(handleBefore, ref.bytes) || !sameFileMetadata(pathBefore, handleBefore)) throw invalid();
      // The allocation and every read are bounded by the validated reference size.
      bytes = Buffer.alloc(ref.bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const remaining = bytes.length - offset;
        const result = await handle.read(bytes, offset, remaining, offset);
        if (!result || !Number.isInteger(result.bytesRead) || result.bytesRead <= 0 || result.bytesRead > remaining) throw invalid();
        offset += result.bytesRead;
      }
      const handleAfter = await handle.stat({ bigint: true });
      const pathAfter = await io.lstat(file, { bigint: true });
      if (!regularSingleLink(handleAfter, ref.bytes) || !regularSingleLink(pathAfter, ref.bytes) ||
          !sameFileMetadata(pathBefore, handleAfter) || !sameFileMetadata(handleAfter, pathAfter)) throw invalid();
      const directoriesAfter = await readDirectoryIdentities(root, ref.scopeId, io);
      if (!sameDirectoryIdentities(directoriesBefore, directoriesAfter)) throw invalid();
    } finally { await handle.close(); }
    if (bytes.length !== ref.bytes || hash(bytes) !== ref.sha256) throw invalid();
    const value = JSON.parse(bytes);
    if (value.version !== 1 || value.identity?.scopeId !== ref.scopeId ||
        !value.fact || typeof value.fact.kind !== 'string' || !Array.isArray(value.operations) ||
        Object.entries(expected).some(([k, v]) => value.identity[k] !== v)) throw invalid();
    return value;
  } catch { throw invalid(); }
}
