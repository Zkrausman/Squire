import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { digest, isSha } from './contracts.mjs';
import { readDeliveryEvidence } from './delivery-evidence.mjs';
import { inspectionError, inspectionLimits, withInspectionSnapshot } from './inspection-snapshot.mjs';

const LIMITS = Object.freeze({ nodes: 128, referenceBytes: 128 * 1024, referencedBytes: 16 * 1024 * 1024,
  outputBytes: 64 * 1024, traversalMs: 2000 });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const hash256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const shaOrNull = value => value === null || isSha(value);
const safeBranch = value => typeof value === 'string' && value.length <= 200 &&
  /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value) && !value.includes('..') && !value.includes('//') && !value.endsWith('/') && !value.endsWith('.lock');
const safeLabel = value => typeof value === 'string' && value.length <= 80 && /^[A-Za-z0-9][A-Za-z0-9 ._+-]*$/.test(value);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const nullableInteger = value => value === null || Number.isSafeInteger(value);
const refFields = ['scopeId', 'file', 'bytes', 'sha256'];
const requiredCheckName = check => check?.name;

function result({ projectId, ticketId, status, chainIntegrity, reasonCode = null, snapshot = null, identity = null, facts = [] }) {
  return { type: 'squire.delivery-inspection', version: 1, projectId, ticketId, status, chainIntegrity,
    ...(reasonCode ? { reasonCode } : {}), snapshot, identity, acceptance: 'not_evaluated', liveness: 'unknown',
    remoteState: 'not_observed', facts };
}

function unavailable(projectId, ticketId, reasonCode, snapshot = null, identity = null) {
  return result({ projectId, ticketId, status: 'unavailable', chainIntegrity: 'unavailable', reasonCode, snapshot, identity });
}

function incomplete(projectId, ticketId, context, reasonCode, snapshot) {
  return result({ projectId, ticketId, status: 'incomplete', chainIntegrity: 'incomplete', reasonCode,
    snapshot, identity: publicIdentity(context), facts: [] });
}

function publicIdentity(context) {
  if (!context) return null;
  return { headSha: context.headSha, baseSha: context.baseSha, treeSha: context.treeSha,
    generation: context.generation, policyDigest: context.policyDigest };
}

function safeSnapshot(capture) {
  return { kind: 'stable_private_copy', sha256: capture.sha256, capturedAt: capture.capturedAt, bytes: capture.bytes };
}

function tableExists(db, name, columns) {
  const schema = db.prepare('SELECT type,sql FROM sqlite_schema WHERE name=?').get(name);
  if (schema?.type !== 'table' || typeof schema.sql !== 'string' || /^\s*CREATE\s+VIRTUAL\b/i.test(schema.sql)) return false;
  const names = db.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name);
  return columns.every(column => names.includes(column));
}

function snapshotCapture(db, projectId, ticketId, capture) {
  const snapshot = safeSnapshot(capture);
  if (!tableExists(db, 'project', ['id', 'state'])) return { issue: 'unsafe_state', snapshot };
  const rows = db.prepare(`SELECT CASE WHEN length(CAST(state AS BLOB))<=? THEN state ELSE NULL END AS state,
      CASE WHEN length(CAST(state AS BLOB))>? THEN 1 ELSE 0 END AS oversized FROM project WHERE id=? LIMIT 2`)
    .all(inspectionLimits.stateBytes, inspectionLimits.stateBytes, projectId);
  if (rows.length === 0) return { issue: 'project_missing', snapshot };
  if (rows.length !== 1) return { issue: 'unsafe_state', snapshot };
  const [row] = rows;
  if (row.oversized || typeof row.state !== 'string') return { issue: 'unsafe_state', snapshot };
  let state;
  try { state = JSON.parse(row.state); } catch { return { issue: 'unsafe_state', snapshot }; }
  if (!object(state) || state.id !== projectId || !object(state.config) || state.config.id !== projectId ||
      !object(state.config.services) || !Array.isArray(state.tickets) || state.tickets.length > inspectionLimits.rows) {
    return { issue: 'unsafe_state', snapshot };
  }
  const matches = state.tickets.filter(ticket => ticket?.spec?.id === ticketId);
  if (matches.length === 0) return { issue: 'ticket_missing', snapshot };
  if (matches.length !== 1) return { issue: 'ticket_ambiguous', snapshot };
  const ticket = matches[0], serviceId = ticket.spec?.service, service = state.config.services[serviceId];
  const delivery = service?.delivery, repository = delivery?.repository, checks = delivery?.requiredChecks;
  const configuredChecks = service?.checks;
  if (!identifier(serviceId) || !object(service) || delivery?.kind !== 'github' || typeof repository !== 'string' ||
      repository.length > 200 || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !Array.isArray(checks) ||
      checks.length < 1 || checks.length > 30 || checks.some(check => !object(check) || typeof check.name !== 'string' ||
        check.name.length < 1 || check.name.length > 200 || !positiveInteger(check.appId) || check.appId > 2147483647) ||
      new Set(checks.map(requiredCheckName)).size !== checks.length || !Array.isArray(configuredChecks) ||
      configuredChecks.length < 1 || configuredChecks.length > 30 || configuredChecks.some(check => !object(check) ||
        typeof check.name !== 'string' || check.name.length < 1 || check.name.length > 200) ||
      new Set(configuredChecks.map(check => check.name)).size !== configuredChecks.length) return { issue: 'unsafe_state', snapshot };
  const fields = ['headSha', 'baseSha', 'treeSha'];
  for (const field of fields) if (ticket[field] != null && !isSha(ticket[field])) return { issue: 'unsafe_state', snapshot };
  const generation = ticket.generation == null ? null : ticket.generation;
  const branch = ticket.branch == null ? null : ticket.branch;
  if (generation !== null && (!Number.isSafeInteger(generation) || generation < 1) ||
      branch !== null && !safeBranch(branch)) return { issue: 'unsafe_state', snapshot };
  const reference = ticket.deliveryEvidence;
  if (reference == null) return { issue: 'anchor_missing', snapshot, context: {
    serviceId, repository, requiredChecks: checks.map(({ name, appId }) => ({ name, appId })),
    configuredChecks: configuredChecks.map(({ name }) => name),
    headSha: ticket.headSha ?? null, baseSha: ticket.baseSha ?? null, treeSha: ticket.treeSha ?? null,
    generation, branch, policyDigest: digest(state.config), anchor: null
  } };
  if (!validReference(reference)) return { issue: 'anchor_legacy', snapshot, context: {
    serviceId, repository, requiredChecks: checks.map(({ name, appId }) => ({ name, appId })),
    configuredChecks: configuredChecks.map(({ name }) => name),
    headSha: ticket.headSha ?? null, baseSha: ticket.baseSha ?? null, treeSha: ticket.treeSha ?? null,
    generation, branch, policyDigest: digest(state.config), anchor: null
  } };
  return { snapshot, context: { serviceId, repository, requiredChecks: checks.map(({ name, appId }) => ({ name, appId })),
    configuredChecks: configuredChecks.map(({ name }) => name),
    headSha: ticket.headSha ?? null, baseSha: ticket.baseSha ?? null, treeSha: ticket.treeSha ?? null,
    generation, branch, policyDigest: digest(state.config), anchor: { ...reference } } };
}

function validReference(reference) {
  return object(reference) && Object.keys(reference).sort().join(',') === [...refFields].sort().join(',') &&
    uuid(reference.scopeId) && typeof reference.file === 'string' && /^[a-f0-9-]{36}\.json$/.test(reference.file) &&
    uuid(reference.file.slice(0, -5)) && Number.isSafeInteger(reference.bytes) && reference.bytes > 0 &&
    reference.bytes <= LIMITS.referenceBytes && hash256(reference.sha256);
}

function validIdentity(identity, reference, selected) {
  return object(identity) && identifier(identity.projectId) && identity.projectId === selected.projectId &&
    identifier(identity.ticketId) && identity.ticketId === selected.ticketId && identifier(identity.service) &&
    identity.service === selected.context.serviceId && typeof identity.repository === 'string' &&
    identity.repository.length <= 200 && /^[\w.-]+\/[\w.-]+$/.test(identity.repository) &&
    identity.repository === selected.context.repository && safeBranch(identity.branch) &&
    positiveInteger(identity.generation) && isSha(identity.headSha) && isSha(identity.baseSha) && isSha(identity.treeSha) &&
    hash256(identity.policyDigest) && uuid(identity.scopeId) && identity.scopeId === reference.scopeId;
}

function identityMatchesCurrent(identity, context) {
  return context.headSha !== null && context.baseSha !== null && context.treeSha !== null &&
    context.generation !== null && context.branch !== null && identity.headSha === context.headSha &&
    identity.baseSha === context.baseSha && identity.treeSha === context.treeSha &&
    identity.generation === context.generation && identity.branch === context.branch &&
    identity.policyDigest === context.policyDigest;
}

function identityKey(identity) {
  return JSON.stringify([identity.projectId, identity.ticketId, identity.service, identity.repository,
    identity.headSha, identity.baseSha, identity.treeSha, identity.generation, identity.branch, identity.policyDigest]);
}

function invalidFact() { throw new Error('invalid_fact'); }
function projectCheckStatus(value) {
  return ['queued', 'in_progress', 'completed', 'requested', 'waiting', 'pending'].includes(value) ? value : 'unknown';
}
function projectConclusion(value) {
  if (value === null) return null;
  return ['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'skipped',
    'neutral', 'startup_failure'].includes(value) ? value : 'unknown';
}

function projectFact(fact, identity, context) {
  if (!object(fact) || typeof fact.kind !== 'string') invalidFact();
  switch (fact.kind) {
    case 'publication.intent':
      return { kind: fact.kind, slot: 'kind', evidence: {} };
    case 'publication.observed': {
      if (!positiveInteger(fact.number) || !isSha(fact.headSha) || !safeBranch(fact.branch) ||
          !shaOrNull(fact.baseSha) || !safeBranch(fact.baseBranch) ||
          typeof fact.repository !== 'string' || fact.repository.length > 200 ||
          !/^[\w.-]+\/[\w.-]+$/.test(fact.repository) || fact.repository !== identity.repository ||
          !['open', 'closed'].includes(fact.state) || typeof fact.merged !== 'boolean' || !shaOrNull(fact.mergeSha) ||
          fact.headSha !== identity.headSha || fact.branch !== identity.branch) invalidFact();
      return { kind: fact.kind, slot: 'kind', evidence: { number: fact.number, headSha: fact.headSha,
        baseSha: fact.baseSha, baseMatchesIdentity: fact.baseSha === identity.baseSha, merged: fact.merged,
        mergeSha: fact.mergeSha } };
    }
    case 'ci.merge_candidate': {
      if (!isSha(fact.sha) || !shaOrNull(fact.treeSha) || !Array.isArray(fact.parents) || fact.parents.length > 8 ||
          fact.parents.some(parent => !isSha(parent))) invalidFact();
      const syntheticMatch = fact.treeSha === identity.treeSha && fact.parents.length === 2 &&
        fact.parents[0] === identity.baseSha && fact.parents[1] === identity.headSha;
      return { kind: fact.kind, slot: 'kind', evidence: { sha: fact.sha, treeSha: fact.treeSha,
        parentCount: fact.parents.length, matchesSyntheticMergeIdentity: syntheticMatch }, syntheticMatch };
    }
    case 'ci.selected': {
      if (!object(fact.required) || typeof fact.required.name !== 'string' || fact.required.name.length < 1 ||
          fact.required.name.length > 200 || !positiveInteger(fact.required.appId) || fact.required.appId > 2147483647) invalidFact();
      const configured = context.requiredChecks.find(item => item.name === fact.required.name && item.appId === fact.required.appId);
      if (identityMatchesCurrent(identity, context) && !configured) invalidFact();
      const label = configured && safeLabel(configured.name) ? configured.name : 'not_reported';
      let selected = null, selectedAssessment = 'no_selection';
      if (fact.selected !== null) {
        const value = fact.selected;
        if (!object(value) || !positiveInteger(value.id) || typeof value.name !== 'string' || value.name !== fact.required.name ||
            !positiveInteger(value.appId) || value.appId !== fact.required.appId || !isSha(value.headSha) ||
            typeof value.status !== 'string' || value.status.length > 64 ||
            !(value.conclusion === null || (typeof value.conclusion === 'string' && value.conclusion.length <= 64))) invalidFact();
        selected = { id: value.id, appId: value.appId, headSha: value.headSha,
          status: projectCheckStatus(value.status), conclusion: projectConclusion(value.conclusion) };
        selectedAssessment = value.headSha === identity.headSha ? 'candidate_head' : 'unresolved_synthetic_head';
      } else if (fact.selected !== null) invalidFact();
      return { kind: fact.kind, slot: `required:${fact.required.name}:${fact.required.appId}`,
        evidence: { requiredCheck: { label, appId: fact.required.appId },
          selected, selectedAssessment }, selectedHeadSha: selected?.headSha ?? null };
    }
    case 'merge.intent':
      if (!positiveInteger(fact.number) || !isSha(fact.headSha) || fact.headSha !== identity.headSha ||
          !['merge', 'squash'].includes(fact.method)) invalidFact();
      return { kind: fact.kind, slot: 'kind', evidence: { number: fact.number, headSha: fact.headSha, method: fact.method } };
    case 'merge.verified': {
      if (!isSha(fact.mergeSha) || !isSha(fact.treeSha) || fact.treeSha !== identity.treeSha ||
          !Array.isArray(fact.parents) || fact.parents.some(parent => !isSha(parent))) invalidFact();
      const ancestry = fact.parents.length === 1 && fact.parents[0] === identity.baseSha ? 'squash' :
        fact.parents.length === 2 && fact.parents[0] === identity.baseSha && fact.parents[1] === identity.headSha ? 'merge' : null;
      if (!ancestry) invalidFact();
      return { kind: fact.kind, slot: 'kind', evidence: { mergeSha: fact.mergeSha, treeSha: fact.treeSha, ancestry } };
    }
    case 'postmerge.observed': {
      if (!isSha(fact.mergeSha) || !isSha(fact.treeSha) || fact.treeSha !== identity.treeSha ||
          !object(fact.after) || !isSha(fact.after.headSha) || !isSha(fact.after.treeSha) ||
          typeof fact.after.dirty !== 'boolean' || typeof fact.passed !== 'boolean' ||
          !Array.isArray(fact.results) || fact.results.length > 30) invalidFact();
      const checks = fact.results.map((check, index) => {
        if (!object(check) || typeof check.name !== 'string' || check.name.length < 1 || check.name.length > 200 ||
            typeof check.passed !== 'boolean' || !nullableInteger(check.exitCode) ||
            typeof check.stopped !== 'boolean' || typeof check.timedOut !== 'boolean' ||
            typeof check.outputExceeded !== 'boolean') invalidFact();
        const failedToLaunch = Boolean(check.launchError);
        const consistent = (check.exitCode === 0 && !check.stopped && !check.timedOut && !check.outputExceeded && !failedToLaunch) === check.passed;
        if (!consistent) invalidFact();
        return { label: safeLabel(check.name) && context.configuredChecks.includes(check.name)
          ? check.name : 'not_reported', slot: index + 1, passed: check.passed, exitCode: check.exitCode };
      });
      return { kind: fact.kind, slot: 'kind', evidence: { mergeSha: fact.mergeSha, treeSha: fact.treeSha,
        passed: fact.passed, after: { headSha: fact.after.headSha, treeSha: fact.after.treeSha,
          headMatchesMerge: fact.after.headSha === fact.mergeSha, treeMatchesIdentity: fact.after.treeSha === identity.treeSha,
          dirty: fact.after.dirty }, checks } };
    }
    default:
      invalidFact();
  }
}

function directoryStamp(filename) {
  const stat = lstatSync(filename, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_directory');
  return `${stat.dev}:${stat.ino}:${stat.mode}`;
}

function artifactRoot(stateDir, projectId) {
  const root = realpathSync(stateDir);
  const projectParent = path.join(root, 'projects');
  const projectRoot = path.join(projectParent, projectId);
  const stamps = [root, projectParent, projectRoot].map(directoryStamp);
  return { root, projectRoot, stamps };
}

function verifyArtifactRoot(root) {
  const stamps = [root.root, path.join(root.root, 'projects'), root.projectRoot].map(directoryStamp);
  if (stamps.some((stamp, index) => stamp !== root.stamps[index])) throw new Error('changed_directory');
}

function classifyAndProject(records, context) {
  const seen = new Set();
  const candidates = records.filter(record => record.kind === 'ci.merge_candidate' && record.syntheticMatch)
    .map(record => ({ sha: record.evidence.sha, identity: identityKey(record.identity) }));
  return records.map(record => {
    const currentIdentity = identityMatchesCurrent(record.identity, context);
    const key = `${record.kind}:${record.slot}`;
    let currentness = 'historical';
    if (currentIdentity) {
      if (seen.has(key)) currentness = 'superseded';
      else {
        seen.add(key);
        currentness = 'current';
      }
    }
    if (record.kind === 'ci.selected' && record.selectedHeadSha && record.selectedHeadSha !== record.identity.headSha) {
      const retained = candidates.some(candidate => candidate.sha === record.selectedHeadSha &&
        candidate.identity === identityKey(record.identity));
      if (!retained) invalidFact();
      record.evidence.selectedAssessment = 'matching_synthetic_merge';
    }
    return { kind: record.kind, currentness, evidence: record.evidence };
  });
}

function snapshotIssueReason(issue) {
  return ({ unsafe_state: 'unsafe_state', project_missing: 'project_missing', ticket_missing: 'ticket_missing',
    ticket_ambiguous: 'ticket_ambiguous', anchor_missing: 'anchor_missing', anchor_legacy: 'anchor_legacy' })[issue] ?? 'snapshot_unavailable';
}

/**
 * Resolve retained delivery receipts without opening the source database. The optional
 * reader/clock pair is a narrow deterministic test seam; the CLI does not expose it.
 */
export async function inspectDelivery({ id, stateDir, ticketId }, { reader = readDeliveryEvidence,
  clock = () => performance.now() } = {}) {
  if (!identifier(id) || typeof stateDir !== 'string' || stateDir.length > 4096 || stateDir.includes('\0') ||
      !path.isAbsolute(stateDir) || !identifier(ticketId) || typeof reader !== 'function' || typeof clock !== 'function') {
    throw inspectionError('inspection_input');
  }
  let fixedRoot;
  try { fixedRoot = artifactRoot(stateDir, id); }
  catch { return unavailable(id, ticketId, 'artifact_root_unavailable'); }

  let selected;
  try {
    selected = withInspectionSnapshot(fixedRoot.root, (db, capture) => snapshotCapture(db, id, ticketId, capture));
  } catch (error) {
    const reasonCode = error?.code === 'inspection_project' ? 'project_missing' :
      error?.code === 'inspection_limit' ? 'snapshot_limit' : 'snapshot_unavailable';
    return unavailable(id, ticketId, reasonCode);
  }
  if (selected.issue) return unavailable(id, ticketId, snapshotIssueReason(selected.issue), selected.snapshot,
    publicIdentity(selected.context));
  const context = selected.context, snapshot = selected.snapshot;
  try { verifyArtifactRoot(fixedRoot); }
  catch { return incomplete(id, ticketId, context, 'artifact_root_changed', snapshot); }

  const started = clock(), deadline = started + LIMITS.traversalMs;
  let reference = context.anchor, bytesRead = 0;
  const visited = new Set(), records = [];
  try {
    while (reference !== null) {
      if (clock() > deadline) return incomplete(id, ticketId, context, 'time_limit_exceeded', snapshot);
      if (records.length >= LIMITS.nodes) return incomplete(id, ticketId, context, 'node_limit_exceeded', snapshot);
      if (!validReference(reference)) throw new Error('bad_reference');
      bytesRead += reference.bytes;
      if (bytesRead > LIMITS.referencedBytes) return incomplete(id, ticketId, context, 'byte_limit_exceeded', snapshot);
      const key = `${reference.scopeId}/${reference.file}`;
      if (visited.has(key)) throw new Error('cycle');
      visited.add(key);
      const receipt = await reader(fixedRoot.projectRoot, reference);
      if (clock() > deadline) return incomplete(id, ticketId, context, 'time_limit_exceeded', snapshot);
      verifyArtifactRoot(fixedRoot);
      if (!object(receipt) || receipt.version !== 1 || !validIdentity(receipt.identity, reference, { projectId: id, ticketId, context }) ||
          !Object.hasOwn(receipt, 'previous')) throw new Error('bad_receipt');
      const projected = projectFact(receipt.fact, receipt.identity, context);
      records.push({ ...projected, identity: receipt.identity });
      reference = receipt.previous;
      if (reference !== null && !validReference(reference)) throw new Error('bad_previous');
    }
    verifyArtifactRoot(fixedRoot);
    if (clock() > deadline) return incomplete(id, ticketId, context, 'time_limit_exceeded', snapshot);
    const facts = classifyAndProject(records, context);
    const output = result({ projectId: id, ticketId, status: 'resolved', chainIntegrity: 'verified',
      snapshot, identity: publicIdentity(context), facts });
    if (Buffer.byteLength(JSON.stringify(output)) > LIMITS.outputBytes) {
      return incomplete(id, ticketId, context, 'output_limit_exceeded', snapshot);
    }
    return output;
  } catch {
    return incomplete(id, ticketId, context, 'chain_incomplete', snapshot);
  }
}

export const inspectDeliveryLimits = LIMITS;
