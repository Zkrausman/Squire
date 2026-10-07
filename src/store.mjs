import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Blocker, digest, isSha, VERSION, validateConfig, validateReview } from './contracts.mjs';

import { producerContext } from './producer-context.mjs';
import * as operations from './operation-store.mjs';

const correctionFields = ['ticketId', 'expectedHeadSha', 'outcome', 'instructions', 'checklist'];
const checklistFields = ['id', 'assertion', 'steps', 'evidence'];
const fulfillmentFields = ['ticketId', 'sourceProjectId', 'sourceTicketId', 'expectedHeadSha'];
const continuationFields = ['ticketId', 'expectedHeadSha', 'instructions'];
const partialRecoveryFields = ['ticketId', 'expectedWorkspace', 'expectedBaseSha', 'expectedBeforeAgentHead'];
const interruptedCandidateFields = ['ticketId', 'expectedWorkspace', 'expectedBaseSha', 'expectedBeforeAgentHead', 'expectedHeadSha', 'expectedTreeSha', 'expectedCorrectionAdmissionId', 'expectedCorrectionDigest', 'expectedBlockerDigest', 'expectedProcessReceiptDigest'];
const agentBudgetFields = ['expectedMaxAgentCalls', 'newMaxAgentCalls', 'reason'];
const isLivePid = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const requireValue = (condition, message, code = 'invalid_correction') => {
  if (!condition) throw new Blocker(code, message);
};
const boundedText = (value, label, max) => requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0'), `${label} must be nonempty text <= ${max} characters`);

function validateContinuation(input) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'Continuation must be an object', 'invalid_continuation');
  for (const key of Object.keys(input)) requireValue(continuationFields.includes(key), `Unknown continuation field: ${key}`, 'invalid_continuation');
  for (const key of continuationFields) requireValue(Object.hasOwn(input, key), `Missing continuation field: ${key}`, 'invalid_continuation');
  requireValue(typeof input.ticketId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(input.ticketId), 'Invalid ticketId', 'invalid_continuation');
  requireValue(isSha(input.expectedHeadSha), 'expectedHeadSha must be a 40 character lowercase Git SHA', 'invalid_continuation');
  boundedText(input.instructions, 'instructions', 4000);
}

function validatePartialRecovery(input) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'Partial recovery request must be an object', 'invalid_partial_recovery');
  for (const key of Object.keys(input)) requireValue(partialRecoveryFields.includes(key), `Unknown partial recovery field: ${key}`, 'invalid_partial_recovery');
  for (const key of partialRecoveryFields) requireValue(Object.hasOwn(input, key), `Missing partial recovery field: ${key}`, 'invalid_partial_recovery');
  requireValue(typeof input.ticketId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(input.ticketId), 'Invalid ticketId', 'invalid_partial_recovery');
  boundedText(input.expectedWorkspace, 'expectedWorkspace', 4096);
  requireValue(path.isAbsolute(input.expectedWorkspace), 'expectedWorkspace must be an absolute managed workspace path', 'invalid_partial_recovery');
  requireValue(isSha(input.expectedBaseSha), 'expectedBaseSha must be a Git SHA', 'invalid_partial_recovery');
  requireValue(isSha(input.expectedBeforeAgentHead), 'expectedBeforeAgentHead must be a Git SHA', 'invalid_partial_recovery');
}

function validateInterruptedCandidate(input) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'Interrupted candidate request must be an object', 'invalid_interrupted_candidate');
  for (const key of Object.keys(input)) requireValue(interruptedCandidateFields.includes(key), `Unknown interrupted candidate field: ${key}`, 'invalid_interrupted_candidate');
  for (const key of interruptedCandidateFields) requireValue(Object.hasOwn(input, key), `Missing interrupted candidate field: ${key}`, 'invalid_interrupted_candidate');
  requireValue(typeof input.ticketId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(input.ticketId), 'Invalid ticketId', 'invalid_interrupted_candidate');
  boundedText(input.expectedWorkspace, 'expectedWorkspace', 4096);
  requireValue(path.isAbsolute(input.expectedWorkspace), 'expectedWorkspace must be an absolute managed workspace path', 'invalid_interrupted_candidate');
  for (const key of ['expectedBaseSha', 'expectedBeforeAgentHead', 'expectedHeadSha', 'expectedTreeSha'])
    requireValue(isSha(input[key]), `${key} must be a 40 character lowercase Git SHA`, 'invalid_interrupted_candidate');
  for (const key of ['expectedCorrectionDigest', 'expectedBlockerDigest', 'expectedProcessReceiptDigest'])
    requireValue(isDigest(input[key]), `${key} must be a 64 character lowercase SHA-256 digest`, 'invalid_interrupted_candidate');
  boundedText(input.expectedCorrectionAdmissionId, 'expectedCorrectionAdmissionId', 100);
}

function validateAgentBudgetIncrease(input) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'Agent budget request must be an object', 'invalid_agent_budget');
  for (const key of Object.keys(input)) requireValue(agentBudgetFields.includes(key), `Unknown agent budget field: ${key}`, 'invalid_agent_budget');
  for (const key of agentBudgetFields) requireValue(Object.hasOwn(input, key), `Missing agent budget field: ${key}`, 'invalid_agent_budget');
  requireValue(Number.isSafeInteger(input.expectedMaxAgentCalls) && input.expectedMaxAgentCalls >= 1 && input.expectedMaxAgentCalls <= 1000,
    'expectedMaxAgentCalls must be an integer from 1 to 1000', 'invalid_agent_budget');
  requireValue(Number.isSafeInteger(input.newMaxAgentCalls) && input.newMaxAgentCalls >= 1 && input.newMaxAgentCalls <= 100,
    'newMaxAgentCalls must be an integer from 1 to 100', 'invalid_agent_budget');
  boundedText(input.reason, 'reason', 2000);
}

function validateCorrection(correction, execution, allowEmptyChecklist = false) {
  requireValue(correction && typeof correction === 'object' && !Array.isArray(correction), 'Correction must be an object');
  for (const key of Object.keys(correction)) requireValue(correctionFields.includes(key), `Unknown correction field: ${key}`);
  for (const key of correctionFields) requireValue(Object.hasOwn(correction, key), `Missing correction field: ${key}`);
  requireValue(typeof correction.ticketId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(correction.ticketId), 'Invalid ticketId');
  requireValue(isSha(correction.expectedHeadSha), 'expectedHeadSha must be a 40 character lowercase Git SHA');
  boundedText(correction.outcome, 'outcome', 2000);
  boundedText(correction.instructions, 'instructions', 4000);
  requireValue(execution.checklist.length >= 1 && execution.checklist.length <= 10, 'Immutable base checklist must contain 1..10 criteria');
  const additionalCap = Math.min(2, 10 - execution.checklist.length);
  requireValue(Array.isArray(correction.checklist) && correction.checklist.length >= (allowEmptyChecklist ? 0 : 1) && correction.checklist.length <= additionalCap && correction.checklist.length + execution.checklist.length <= 10,
    `checklist must add ${allowEmptyChecklist ? '0' : '1'}..${additionalCap} criteria (combined review limit is 10)`);
  const ids = new Set(execution.checklist.map(item => item.id));
  for (const [index, item] of correction.checklist.entries()) {
    requireValue(item && typeof item === 'object' && !Array.isArray(item), `checklist[${index}] must be an object`);
    for (const key of Object.keys(item)) requireValue(checklistFields.includes(key), `Unknown checklist field: ${key}`);
    for (const key of checklistFields) requireValue(Object.hasOwn(item, key), `Missing checklist field: ${key}`);
    requireValue(typeof item.id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(item.id), `Invalid checklist[${index}].id`);
    requireValue(!ids.has(item.id), `Duplicate checklist criterion id ${item.id}`); ids.add(item.id);
    boundedText(item.assertion, `checklist[${index}].assertion`, 2000);
    requireValue(Array.isArray(item.steps) && item.steps.length >= 1 && item.steps.length <= 10, `checklist[${index}].steps must contain 1..10 items`);
    item.steps.forEach((step, stepIndex) => boundedText(step, `checklist[${index}].steps[${stepIndex}]`, 2000));
    boundedText(item.evidence, `checklist[${index}].evidence`, 2000);
  }
}

function validateFulfillmentInput(input) {
  requireValue(input && typeof input === 'object' && !Array.isArray(input), 'Fulfillment must be an object', 'invalid_fulfillment');
  for (const key of Object.keys(input)) requireValue(fulfillmentFields.includes(key), `Unknown fulfillment field: ${key}`, 'invalid_fulfillment');
  for (const key of fulfillmentFields) requireValue(Object.hasOwn(input, key), `Missing fulfillment field: ${key}`, 'invalid_fulfillment');
  for (const key of ['ticketId', 'sourceProjectId', 'sourceTicketId']) requireValue(typeof input[key] === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(input[key]), `Invalid ${key}`, 'invalid_fulfillment');
  requireValue(isSha(input.expectedHeadSha), 'expectedHeadSha must be a 40 character lowercase Git SHA', 'invalid_fulfillment');
}

const effectiveChecklist = ticket => [
  ...(ticket.spec.execution?.checklist ?? []),
  ...(ticket.correctionAdmission?.checklist ?? [])
];
function failedVerificationReceipt(receipt, headSha, treeSha, checks, policyDigest) {
  if (!receipt || receipt.passed !== false || receipt.headSha !== headSha || receipt.treeSha !== treeSha ||
      receipt.policyDigest !== policyDigest || !Array.isArray(receipt.results) || receipt.results.length < 1 ||
      receipt.results.length > checks.length) return false;
  let failed = false;
  for (let index = 0; index < receipt.results.length; index++) {
    const result = receipt.results[index], check = checks[index];
    const expectedArgv = check.argv[0] === 'node' ? [process.execPath, ...check.argv.slice(1)] : check.argv;
    if (!result || result.name !== check.name || typeof result.passed !== 'boolean' ||
        !Array.isArray(result.argv) || !same(result.argv, expectedArgv) ||
        !Number.isSafeInteger(result.exitCode) || result.exitCode < 0 || result.stopped !== false || result.timedOut !== false ||
        result.outputExceeded !== false || (result.launchError !== undefined && result.launchError !== null)) return false;
    if (result.passed !== (result.exitCode === 0) || failed) return false;
    if (!result.passed) {
      if (index !== receipt.results.length - 1) return false;
      failed = true;
    }
  }
  return failed;
}
const canonical = value => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));

// One transactional state envelope plus separate cursor-addressed outbox events.
// Synchronous transactions serialize mutations from concurrent repository lanes.
export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 }); this.directory = directory;
    this.db = new DatabaseSync(path.join(directory, 'squire.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY, config_hash TEXT NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (resource TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL);`);
    this.db.exec(operations.operationSchema);
  }
  ownsProducerLease(resource) {
    const context = producerContext();
    if (context?.store !== this || !context.scopeId) return false;
    const scope = this.db.prepare('SELECT lease_resource,lease_owner,closed_at FROM producer_scopes WHERE id=?').get(context.scopeId);
    return scope?.closed_at === null && scope.lease_resource === resource &&
      this.db.prepare('SELECT owner FROM leases WHERE resource=?').get(resource)?.owner === scope.lease_owner;
  }
  assertProducerScopesClear(project, except = producerContext()?.store === this ? producerContext().scopeId : null) {
    const held = this.db.prepare('SELECT id,lane FROM producer_scopes WHERE project=? AND closed_at IS NULL AND id IS NOT ?').all(project, except);
    if (held.length) throw new Blocker('producer_unresolved', 'Unrecorded producer outcomes remain fenced', { scopes: held });
  }
  producerHolds(project, owner) {
    return this.db.prepare('SELECT id,lane FROM producer_scopes WHERE project=? AND closed_at IS NULL AND lease_owner<>?').all(project, owner);
  }
  beginProducer(project, lane, lease, resources = []) { return operations.beginScope(this, project, lane, lease, resources); }
  reserveProducerCall(scopeId, jobId) { return operations.reserveCall(this, scopeId, jobId); }
  registerProcess(scopeId, jobId, id, directory, requestDigest) { return operations.registerOperation(this, scopeId, jobId, id, directory, requestDigest); }
  claimProcess(grant, from, to, requestDigest) { return operations.claimOperation(this, grant, from, to, requestDigest); }
  finishProcess(grant, phase, record) { return operations.finishOperation(this, grant, phase, record); }
  processOperation(id) { return operations.operation(this, id); }
  close() { this.db.close(); }
  initialize(config) {
    const previous = this.db.prepare('SELECT config_hash FROM project WHERE id=?').get(config.id);
    const hash = digest(config);
    if (previous && previous.config_hash !== hash) throw new Blocker('config_changed', 'Project policy changed. Use a new project ID/state directory; an active queue cannot silently change authority.');
    if (previous) return this.get(config.id);
    const state = { version: VERSION, id: config.id, config, processProtocol: 1, status: 'queued', paused: false, createdAt: Date.now(), agentCalls: 0, planningAttempt: 0,
      tickets: (config.tickets ?? []).map(spec => ({ spec, status: 'queued', attempts: 0, repairs: 0, rebases: 0 })), acceptance: {}, blocker: null };
    this.transaction(() => { this.db.prepare('INSERT INTO project VALUES (?,?,?)').run(config.id, hash, JSON.stringify(state)); this.emit(config.id, 'project.created', { status: 'queued' }); });
    return state;
  }
  transaction(fn) { try { this.db.exec('BEGIN IMMEDIATE'); const value = fn(); this.db.exec('COMMIT'); return value; } catch (e) {
    const context = producerContext();
    if (context?.store === this) context.lifecycle.persistenceFailed = true;
    e.storeTransactionFailed = true;
    try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original persistence/validation failure. */ }
    throw e;
  } }
  get(id) { const row = this.db.prepare('SELECT state FROM project WHERE id=?').get(id); if (!row) throw new Blocker('not_found', `Project ${id} not found`); return JSON.parse(row.state); }
  list() { return this.db.prepare('SELECT id FROM project').all().map(r => this.get(r.id)); }
  update(id, fn, type, detail = {}, completedScope = null) {
    const result = this.transaction(() => {
      const state = this.get(id); fn(state); state.updatedAt = Date.now();
      this.db.prepare('UPDATE project SET state=? WHERE id=?').run(JSON.stringify(state), id);
      if (type) this.emit(id, type, detail);
      if (completedScope) {
        if (producerContext()?.lifecycle?.persistenceFailed) throw new Blocker('producer_unresolved', 'Producer persistence failed; outcome remains fenced');
        operations.closeScope(this, completedScope, id, state);
      }
      return state;
    });
    if (completedScope && producerContext()?.scopeId === completedScope) producerContext().lifecycle.scopeClosed = true;
    return result;
  }
  emit(id, type, detail) { this.db.prepare('INSERT INTO events(project,data) VALUES (?,?)').run(id, JSON.stringify({ version: VERSION, project: id, type, at: Date.now(), ...detail })); }
  events(id, cursor = 0, limit = 200) { return this.db.prepare('SELECT cursor,data FROM events WHERE project=? AND cursor>? ORDER BY cursor LIMIT ?').all(id, cursor, limit).map(r => ({ cursor: Number(r.cursor), ...JSON.parse(r.data) })); }
  lease(resource) {
    const owner = randomUUID();
    this.transaction(() => {
      const held = this.db.prepare('SELECT * FROM leases WHERE resource=?').get(resource);
      if (held) {
        let alive = true; try { process.kill(held.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
        if (alive) throw new Blocker('lease_busy', `Another live controller owns ${resource}`, { pid: held.pid });
        this.db.prepare('DELETE FROM leases WHERE resource=?').run(resource);
      }
      this.db.prepare('INSERT INTO leases VALUES (?,?,?)').run(resource, owner, process.pid);
    });
    const release = () => { this.db.prepare('DELETE FROM leases WHERE resource=? AND owner=?').run(resource, owner); };
    release.resource = resource; release.owner = owner; return release;
  }
  pause(id) { return this.update(id, s => { s.paused = true; }, 'project.paused'); }
  configureRuntime(expectedConfig, runtime) {
    return this.transaction(() => {
      const state = this.get(expectedConfig.id);
      this.assertProducerScopesClear(state.id);
      if (!state.paused) throw new Blocker('runtime_change_busy', 'Pause the project before changing model routing');
      const held = this.db.prepare('SELECT pid FROM leases WHERE resource=?').get(`controller:${state.id}`);
      if (held && !this.ownsProducerLease(`controller:${state.id}`)) {
        let alive = true; try { process.kill(held.pid, 0); } catch (e) { alive = e.code !== 'ESRCH'; }
        if (alive) throw new Blocker('runtime_change_busy', 'Wait for the paused controller to settle before changing model routing');
      }
      if (digest(state.config) !== digest(expectedConfig)) throw new Blocker('config_changed', 'Expected configuration does not match durable policy');
      for (const key of ['kind', 'authentication', 'command']) if (digest(runtime[key] ?? null) !== digest(state.config.runtime[key] ?? null)) throw new Blocker('invalid_config', 'Model routing changes cannot change runtime authority');
      const config = validateConfig({ ...state.config, runtime });
      state.config = config;
      // Keep all counters, candidates, merge identities and old receipts. Require fresh review after routing changes.
      for (const ticket of state.tickets) if (ticket.headSha && !ticket.mergeSha && ['verifying', 'review_ready', 'reviewing', 'publishing', 'waiting_ci', 'merging'].includes(ticket.status)) {
        ticket.status = 'verifying'; ticket.review = null; ticket.verification = null;
      }
      state.updatedAt = Date.now();
      this.db.prepare('UPDATE project SET config_hash=?,state=? WHERE id=?').run(digest(config), JSON.stringify(state), state.id);
      this.emit(state.id, 'project.runtime_configured', { runtime });
      return state;
    });
  }
  configureAgentBudget(expectedConfig, increase) {
    const config = validateConfig(structuredClone(expectedConfig));
    validateAgentBudgetIncrease(increase);
    return this.transaction(() => {
      const state = this.get(config.id);
      this.assertProducerScopesClear(state.id);
      const projectRow = this.db.prepare('SELECT config_hash FROM project WHERE id=?').get(config.id);
      if (!projectRow || projectRow.config_hash !== digest(state.config) || digest(config) !== projectRow.config_hash) {
        throw new Blocker('config_changed', 'Expected configuration does not match durable project policy');
      }
      if (!state.paused) throw new Blocker('agent_budget_busy', 'Pause the project before increasing its agent-call budget');
      const leaseKey = `controller:${state.id}`;
      const held = this.db.prepare('SELECT pid FROM leases WHERE resource=?').get(leaseKey);
      if (held && !this.ownsProducerLease(`controller:${state.id}`) && isLivePid(held.pid)) throw new Blocker('agent_budget_busy', 'Wait for the paused controller to settle before increasing its agent-call budget', { pid: held.pid });
      if (held && !this.ownsProducerLease(leaseKey)) this.db.prepare('DELETE FROM leases WHERE resource=?').run(leaseKey);
      if (state.tickets.some(ticket => ticket.activeJob || ['implementing', 'reviewing'].includes(ticket.status))) {
        throw new Blocker('agent_budget_busy', 'Wait for active ticket jobs to settle before increasing the agent-call budget');
      }
      if (state.agentBudgetIncrease) throw new Blocker('agent_budget_already_increased', 'This project already used its one lifetime agent-call budget increase');

      const oldMaxAgentCalls = state.config.limits.maxAgentCalls;
      if (increase.expectedMaxAgentCalls !== oldMaxAgentCalls) throw new Blocker('agent_budget_mismatch', 'expectedMaxAgentCalls does not match the durable project budget');
      if (increase.newMaxAgentCalls <= oldMaxAgentCalls) throw new Blocker('agent_budget_invalid', 'newMaxAgentCalls must be greater than the current cap');
      if (increase.newMaxAgentCalls <= state.agentCalls) throw new Blocker('agent_budget_invalid', 'newMaxAgentCalls must exceed the agent calls already spent');

      const updatedConfig = validateConfig({ ...state.config, limits: { ...state.config.limits, maxAgentCalls: increase.newMaxAgentCalls } });
      const increasedAt = Date.now();
      const audit = {
        increasedAt, oldMaxAgentCalls, newMaxAgentCalls: increase.newMaxAgentCalls,
        spentAgentCalls: state.agentCalls, reason: increase.reason,
        configDigestBefore: projectRow.config_hash, configDigestAfter: digest(updatedConfig)
      };
      state.config = updatedConfig;
      state.agentBudgetIncrease = audit;
      state.updatedAt = increasedAt;
      this.db.prepare('UPDATE project SET config_hash=?,state=? WHERE id=?').run(digest(updatedConfig), JSON.stringify(state), state.id);
      this.emit(state.id, 'project.agent_budget_increased', audit);
      return { configured: true, project: state.id, ...audit, config: updatedConfig };
    });
  }
  authorizeCorrection(expectedConfig, correction) {
    const config = validateConfig(structuredClone(expectedConfig));
    return this.transaction(() => {
      const state = this.get(config.id);
      this.assertProducerScopesClear(state.id);
      const projectRow = this.db.prepare('SELECT config_hash FROM project WHERE id=?').get(config.id);
      if (!projectRow || projectRow.config_hash !== digest(state.config) || digest(config) !== projectRow.config_hash) {
        throw new Blocker('config_changed', 'Expected configuration does not match durable project policy');
      }
      if (!state.paused) throw new Blocker('correction_busy', 'Pause the project before authorizing a correction');

      const leaseKey = `controller:${state.id}`;
      const held = this.db.prepare('SELECT pid FROM leases WHERE resource=?').get(leaseKey);
      if (held && !this.ownsProducerLease(`controller:${state.id}`) && isLivePid(held.pid)) throw new Blocker('correction_busy', 'Wait for the paused controller to settle before authorizing a correction', { pid: held.pid });
      if (held && !this.ownsProducerLease(leaseKey)) this.db.prepare('DELETE FROM leases WHERE resource=?').run(leaseKey);
      if (state.tickets.some(ticket => ticket.activeJob || ['implementing', 'reviewing'].includes(ticket.status))) {
        throw new Blocker('correction_busy', 'Wait for active ticket jobs to settle before authorizing a correction');
      }

      const ticket = state.tickets.find(item => item.spec.id === correction?.ticketId);
      if (!ticket) throw new Blocker('not_found', `Ticket ${correction?.ticketId ?? ''} unavailable`);
      if (ticket.correctionAdmission) throw new Blocker('correction_already_admitted', 'This ticket has already received its one lifetime correction admission');
      if (!ticket.spec.execution) throw new Blocker('correction_ineligible', 'Corrections require a structured execution contract');
      if (ticket.status !== 'blocked' || !['repair_budget', 'slice_budget'].includes(ticket.blocker?.code)) {
        throw new Blocker('correction_ineligible', 'Ticket must be blocked by repair_budget or slice_budget');
      }
      if (ticket.mergeSha || ticket.publication || ticket.shippedAt || ticket.status === 'postmerge') {
        throw new Blocker('correction_ineligible', 'Merged, shipped or published tickets cannot receive a corrective admission');
      }
      if (!isSha(ticket.headSha) || ticket.headSha !== correction.expectedHeadSha) {
        throw new Blocker('correction_head_mismatch', 'expectedHeadSha does not match the blocked candidate');
      }
      if (!isSha(ticket.treeSha)) throw new Blocker('correction_evidence_mismatch', 'A complete exact candidate tree identity is required');
      if (!ticket.implementation || typeof ticket.implementation.sessionRef !== 'string' || !ticket.implementation.sessionRef ||
          typeof ticket.implementation.jobId !== 'string' || !ticket.implementation.jobId ||
          (ticket.recovered && ticket.interruptedContinuation?.status !== 'completed')) {
        throw new Blocker('correction_evidence_mismatch', 'A completed implementation receipt is required; recovered partial candidates are ineligible');
      }

      const review = ticket.review?.verdict === 'fail' ? ticket.review :
        ticket.review == null ? ticket.lastFailedReview : null;
      const reviewIsExactFailure = review?.verdict === 'fail' && review.headSha === ticket.headSha &&
        typeof review.sessionRef === 'string' && !!review.sessionRef && typeof review.jobId === 'string' && !!review.jobId &&
        Array.isArray(review.findings) && (review.findings.length > 0 || review.checklist?.some(item => item.verdict === 'fail'));
      if (reviewIsExactFailure) validateReview(review, ticket.headSha, ticket.spec.execution);
      const service = config.services[ticket.spec.service];
      const originalVerification = structuredClone(ticket.verification ?? null);
      const verificationIsExactFailure = failedVerificationReceipt(originalVerification, ticket.headSha, ticket.treeSha, service.checks, digest(service.checks));
      if (!reviewIsExactFailure && !verificationIsExactFailure) {
        throw new Blocker('correction_evidence_mismatch', 'A failed fresh review of the exact blocked candidate or exact-policy application verification receipt is required');
      }
      const emptySaturatedReview = correction.checklist?.length === 0 && ticket.spec.execution.checklist.length === 10 && reviewIsExactFailure;
      const proofType = reviewIsExactFailure && (correction.checklist?.length > 0 || emptySaturatedReview) ? 'failed_review' :
        verificationIsExactFailure ? 'failed_verification' : 'failed_review';
      const allowEmptyChecklist = emptySaturatedReview ||
        (proofType === 'failed_verification' && [8, 10].includes(ticket.spec.execution.checklist.length));
      validateCorrection(correction, ticket.spec.execution,
        allowEmptyChecklist);

      const admittedAt = Date.now();
      const admissionId = randomUUID();
      const originalReview = structuredClone(reviewIsExactFailure ? review : ticket.review ?? ticket.lastFailedReview ?? null);
      const originalBlocker = structuredClone(ticket.blocker);
      const reviewDigest = originalReview ? digest(originalReview) : null;
      const verificationDigest = verificationIsExactFailure ? digest(originalVerification) : null;
      const record = {
        admissionId, admittedAt,
        outcome: correction.outcome,
        instructions: correction.instructions,
        checklist: structuredClone(correction.checklist),
        evidence: {
          configDigest: projectRow.config_hash,
          contractDigest: digest(ticket.spec.execution),
          headSha: ticket.headSha,
          treeSha: ticket.treeSha ?? null,
          baseSha: ticket.baseSha ?? null,
          generation: ticket.generation ?? null,
          workspace: ticket.workspace ?? null,
          proofType,
          reviewDigest,
          originalReview,
          lastFailedReview: structuredClone(ticket.lastFailedReview ?? null),
          verificationDigest,
          originalVerification,
          originalBlocker,
          counters: { attempts: ticket.attempts, repairs: ticket.repairs, rebases: ticket.rebases }
        },
        ceilings: { implementAttempts: ticket.attempts + 1, repairs: ticket.repairs + 1 }
      };
      ticket.correctionAdmission = record;
      if (reviewIsExactFailure) ticket.lastFailedReview = originalReview;
      ticket.status = 'repairing';
      ticket.blocker = null;
      const actualFailure = reviewIsExactFailure ? {
        kind: 'failed_review', reviewDigest, headSha: ticket.headSha, summary: review.summary,
        findings: review.findings, checklist: review.checklist ?? []
      } : {
        kind: 'failed_verification', verificationDigest, headSha: ticket.headSha, treeSha: ticket.treeSha,
        policyDigest: originalVerification.policyDigest,
        failedChecks: originalVerification.results.filter(result => !result.passed).map(result => ({ name: result.name, exitCode: result.exitCode, failureTail: result.failureTail ?? '' }))
      };
      ticket.repairReason = {
        code: 'authorized_correction',
        message: `One bounded corrective attempt was explicitly admitted after ${proofType === 'failed_review' ? 'an exact-head failed review' : 'an exact-head application verification failure'}.`,
        actualFailure,
        outcome: record.outcome,
        instructions: record.instructions
      };
      ticket.review = null;
      ticket.verification = null;
      ticket.retryAt = 0;
      ticket.pollAt = 0;
      delete ticket.activeJob;

      // Let dependents re-evaluate after this ticket is repaired. propagate()
      // will put them back in dependency_blocked if the prerequisite still fails.
      for (const dependent of state.tickets) if (dependent.status === 'dependency_blocked' && dependent.blocker?.code === 'dependency') {
        dependent.status = 'queued'; dependent.blocker = null; dependent.retryAt = 0;
      }
      state.blocker = null;
      state.updatedAt = admittedAt;
      this.db.prepare('UPDATE project SET state=? WHERE id=?').run(JSON.stringify(state), state.id);
      this.emit(state.id, 'ticket.correction_authorized', {
        ticket: ticket.spec.id, admissionId, headSha: ticket.headSha,
        blocker: originalBlocker.code, proofType, reviewDigest, verificationDigest,
        configDigest: record.evidence.configDigest, implementAttemptCeiling: record.ceilings.implementAttempts,
        repairCeiling: record.ceilings.repairs
      });
      return { admitted: true, project: state.id, ticket: ticket.spec.id, admissionId, headSha: ticket.headSha, status: ticket.status, admittedAt };
    });
  }
  authorizeInterruptedRecovery(expectedConfig, request) {
    const config = validateConfig(structuredClone(expectedConfig));
    validatePartialRecovery(request);
    return this.transaction(() => {
      const state = this.get(config.id);
      this.assertProducerScopesClear(state.id);
      const projectRow = this.db.prepare('SELECT config_hash FROM project WHERE id=?').get(config.id);
      if (!projectRow || projectRow.config_hash !== digest(state.config) || digest(config) !== projectRow.config_hash) {
        throw new Blocker('config_changed', 'Expected configuration does not match durable project policy');
      }
      if (!state.paused) throw new Blocker('partial_recovery_busy', 'Pause the project before recovering a timed-out implementation');
      const leaseKey = `controller:${state.id}`;
      const held = this.db.prepare('SELECT pid FROM leases WHERE resource=?').get(leaseKey);
      if (held && !this.ownsProducerLease(`controller:${state.id}`) && isLivePid(held.pid)) throw new Blocker('partial_recovery_busy', 'Wait for the paused controller to settle before recovering partial implementation work', { pid: held.pid });
      if (held && !this.ownsProducerLease(leaseKey)) this.db.prepare('DELETE FROM leases WHERE resource=?').run(leaseKey);
      const ticket = state.tickets.find(item => item.spec.id === request.ticketId);
      if (!ticket) throw new Blocker('not_found', `Ticket ${request.ticketId} unavailable`);
      if (ticket.partialRecovery) throw new Blocker('partial_recovery_already_used', 'This ticket already has a partial implementation recovery record');
      if (state.tickets.some(item => item.activeJob || ['implementing', 'reviewing', 'recovering_partial'].includes(item.status))) {
        throw new Blocker('partial_recovery_busy', 'Wait for all ticket jobs and recovery checkpoints to settle');
      }
      if (!ticket.spec.execution) throw new Blocker('partial_recovery_ineligible', 'Partial implementation recovery requires a structured execution contract');
      if (ticket.status !== 'blocked' || ticket.blocker?.code !== 'runtime_failed') {
        throw new Blocker('partial_recovery_ineligible', 'Ticket must be blocked after a runtime_failed implementation');
      }
      if (ticket.implementation != null || ticket.mergeSha || ticket.publication || ticket.shippedAt || ticket.postmerge) {
        throw new Blocker('partial_recovery_ineligible', 'Completed implementation or delivered tickets cannot use partial implementation recovery');
      }
      if (ticket.recovered || ticket.interruptedContinuation) throw new Blocker('partial_recovery_already_used', 'Recovered or continued candidates cannot use partial implementation recovery');
      if (ticket.workspace !== request.expectedWorkspace || ticket.baseSha !== request.expectedBaseSha ||
          ticket.beforeAgentHead !== request.expectedBeforeAgentHead || !isSha(ticket.baseSha) || !isSha(ticket.beforeAgentHead) ||
          !Number.isSafeInteger(ticket.attempts) || ticket.attempts < 1 || !Number.isSafeInteger(ticket.repairs) || ticket.repairs < 0) {
        throw new Blocker('partial_recovery_identity_mismatch', 'Workspace, base, before-agent identity, and attempt counters must match durable ticket state');
      }
      if ((ticket.headSha != null || ticket.treeSha != null) &&
          (ticket.headSha !== ticket.beforeAgentHead || !isSha(ticket.treeSha))) {
        throw new Blocker('partial_recovery_identity_mismatch', 'Existing candidate identity does not match the exact pre-implementation head');
      }
      const processReceipt = ticket.blocker.detail?.receipt;
      const argv = processReceipt?.argv;
      const sandboxIndex = Array.isArray(argv) ? argv.indexOf('--sandbox') : -1;
      if (!processReceipt || !(processReceipt.stopped === true || processReceipt.timedOut === true) || processReceipt.outputExceeded === true ||
          (processReceipt.launchError !== undefined && processReceipt.launchError !== null) || !Array.isArray(argv) || !argv.includes('exec') ||
          sandboxIndex < 0 || argv[sandboxIndex + 1] !== 'workspace-write' ||
          (ticket.blocker.role !== undefined && ticket.blocker.role !== 'implement')) {
        throw new Blocker('partial_recovery_evidence_mismatch', 'A stopped or timed-out implementation receipt with workspace-write sandbox evidence is required');
      }

      const recoveryId = randomUUID(), authorizedAt = Date.now();
      const record = {
        recoveryId, status: 'authorized', authorizedAt,
        evidence: {
          configDigest: projectRow.config_hash, contractDigest: digest(ticket.spec.execution),
          workspace: ticket.workspace, baseSha: ticket.baseSha, beforeAgentHead: ticket.beforeAgentHead,
          priorCandidate: { headSha: ticket.headSha ?? null, treeSha: ticket.treeSha ?? null },
          blocker: structuredClone(ticket.blocker), blockerDigest: digest(ticket.blocker),
          processReceipt: structuredClone(processReceipt), processReceiptDigest: digest(processReceipt),
          counters: { attempts: ticket.attempts, repairs: ticket.repairs, rebases: ticket.rebases ?? 0,
            reviewAttempts: ticket.reviewAttempts ?? 0, agentCalls: state.agentCalls }
        }
      };
      ticket.partialRecovery = record;
      ticket.status = 'recovering_partial';
      state.updatedAt = authorizedAt;
      this.db.prepare('UPDATE project SET state=? WHERE id=?').run(JSON.stringify(state), state.id);
      this.emit(state.id, 'ticket.partial_recovery_authorized', {
        ticket: ticket.spec.id, recoveryId, workspace: ticket.workspace, baseSha: ticket.baseSha,
        beforeAgentHead: ticket.beforeAgentHead, processReceiptDigest: record.evidence.processReceiptDigest
      });
      return { authorized: true, project: state.id, ticket: ticket.spec.id, recoveryId, workspace: ticket.workspace,
        baseSha: ticket.baseSha, beforeAgentHead: ticket.beforeAgentHead };
    });
  }
  completeInterruptedRecovery(id, ticketId, recoveryId, candidate, beforeIdentity) {
    requireValue(candidate && isSha(candidate.headSha) && isSha(candidate.treeSha) && Array.isArray(candidate.files) &&
      beforeIdentity && isSha(beforeIdentity.headSha) && isSha(beforeIdentity.treeSha) && typeof beforeIdentity.dirty === 'string' && beforeIdentity.dirty,
    'Checkpoint candidate and observed partial workspace identities are incomplete', 'partial_recovery_identity_mismatch');
    return this.update(id, state => {
      const ticket = state.tickets.find(item => item.spec.id === ticketId);
      if (!ticket || ticket.status !== 'recovering_partial' || ticket.partialRecovery?.recoveryId !== recoveryId || ticket.partialRecovery.status !== 'authorized') {
        throw new Blocker('partial_recovery_state_mismatch', 'Partial recovery authorization is missing or already settled');
      }
      if (ticket.workspace !== ticket.partialRecovery.evidence.workspace || ticket.baseSha !== ticket.partialRecovery.evidence.baseSha ||
          ticket.beforeAgentHead !== ticket.partialRecovery.evidence.beforeAgentHead || ticket.headSha != null && ticket.headSha !== ticket.beforeAgentHead ||
          beforeIdentity.headSha !== ticket.beforeAgentHead || ticket.headSha != null && beforeIdentity.treeSha !== ticket.treeSha) {
        throw new Blocker('partial_recovery_identity_mismatch', 'Durable workspace identity changed during partial recovery');
      }
      ticket.headSha = candidate.headSha; ticket.treeSha = candidate.treeSha;
      ticket.recovered = true; ticket.status = 'blocked'; delete ticket.activeJob;
      Object.assign(ticket.partialRecovery, { status: 'completed', completedAt: Date.now(), beforeIdentity: structuredClone(beforeIdentity), candidate: structuredClone(candidate) });
      state.updatedAt = ticket.partialRecovery.completedAt;
    }, 'ticket.partial_recovery_completed', { ticket: ticketId, recoveryId, headSha: candidate.headSha, treeSha: candidate.treeSha });
  }
  failInterruptedRecovery(id, ticketId, recoveryId, error) {
    return this.update(id, state => {
      const ticket = state.tickets.find(item => item.spec.id === ticketId);
      if (!ticket || ticket.status !== 'recovering_partial' || ticket.partialRecovery?.recoveryId !== recoveryId || ticket.partialRecovery.status !== 'authorized') {
        throw new Blocker('partial_recovery_state_mismatch', 'Partial recovery authorization is missing or already settled');
      }
      ticket.status = 'blocked'; delete ticket.activeJob;
      ticket.partialRecovery.status = 'failed'; ticket.partialRecovery.failedAt = Date.now();
      ticket.partialRecovery.failure = { code: error?.code ?? 'unexpected_error', message: String(error?.message ?? error).slice(0, 2000) };
      state.updatedAt = ticket.partialRecovery.failedAt;
    }, 'ticket.partial_recovery_failed', { ticket: ticketId, recoveryId, code: error?.code ?? 'unexpected_error' });
  }
  authorizeInterruptedCandidateVerification(expectedConfig, request) {
    const config = validateConfig(structuredClone(expectedConfig));
    validateInterruptedCandidate(request);
    return this.transaction(() => {
      const state = this.get(config.id);
      this.assertProducerScopesClear(state.id);
      const projectRow = this.db.prepare('SELECT config_hash FROM project WHERE id=?').get(config.id);
      if (!projectRow || projectRow.config_hash !== digest(state.config) || digest(config) !== projectRow.config_hash) {
        throw new Blocker('config_changed', 'Expected configuration does not match durable project policy');
      }
      if (!state.paused) throw new Blocker('interrupted_candidate_busy', 'Pause the project before checkpointing an interrupted candidate');
      const leaseKey = `controller:${state.id}`;
      const held = this.db.prepare('SELECT pid FROM leases WHERE resource=?').get(leaseKey);
      if (held && !this.ownsProducerLease(`controller:${state.id}`) && isLivePid(held.pid)) throw new Blocker('interrupted_candidate_busy', 'Wait for the paused controller to settle before checkpointing an interrupted candidate', { pid: held.pid });
      if (held && !this.ownsProducerLease(leaseKey)) this.db.prepare('DELETE FROM leases WHERE resource=?').run(leaseKey);

      const ticket = state.tickets.find(item => item.spec.id === request.ticketId);
      if (!ticket) throw new Blocker('not_found', `Ticket ${request.ticketId} unavailable`);
      if (ticket.interruptedCandidateVerification) throw new Blocker('interrupted_candidate_already_used', 'This ticket already used its one interrupted-candidate verification checkpoint');
      if (state.tickets.some(item => item.activeJob || ['implementing', 'reviewing', 'recovering_partial', 'recovering_candidate'].includes(item.status))) {
        throw new Blocker('interrupted_candidate_busy', 'Wait for all ticket jobs and recovery checkpoints to settle');
      }
      if (!ticket.spec.execution || ticket.status !== 'blocked' || ticket.blocker?.code !== 'runtime_failed' || ticket.blocker?.role !== 'implement') {
        throw new Blocker('interrupted_candidate_ineligible', 'A structured ticket blocked by a failed implementation runtime is required');
      }
      const correctionCeilings = ticket.correctionAdmission?.ceilings;
      if (!ticket.correctionAdmission || ticket.correctionAdmission.admissionId !== request.expectedCorrectionAdmissionId ||
          digest(ticket.correctionAdmission) !== request.expectedCorrectionDigest ||
          !Number.isSafeInteger(ticket.attempts) || !Number.isSafeInteger(ticket.repairs) ||
          !Number.isSafeInteger(correctionCeilings?.implementAttempts) || !Number.isSafeInteger(correctionCeilings?.repairs) ||
          ticket.attempts !== correctionCeilings.implementAttempts || ticket.repairs !== correctionCeilings.repairs) {
        throw new Blocker('interrupted_candidate_evidence_mismatch', 'The exact one-time correction admission must already be fully consumed');
      }
      if (!ticket.implementation || typeof ticket.implementation.sessionRef !== 'string' || !ticket.implementation.sessionRef ||
          typeof ticket.implementation.jobId !== 'string' || !ticket.implementation.jobId) {
        throw new Blocker('interrupted_candidate_evidence_mismatch', 'Prior completed implementation metadata must be present and preserved');
      }
      if (ticket.mergeSha || ticket.publication || ticket.shippedAt || ticket.postmerge || ticket.status === 'postmerge') {
        throw new Blocker('interrupted_candidate_ineligible', 'Merged, shipped, published or postmerge tickets cannot recover an interrupted candidate');
      }
      if (ticket.workspace !== request.expectedWorkspace || ticket.baseSha !== request.expectedBaseSha ||
          ticket.beforeAgentHead !== request.expectedBeforeAgentHead || ticket.headSha !== request.expectedHeadSha ||
          ticket.treeSha !== request.expectedTreeSha || ticket.headSha !== ticket.beforeAgentHead ||
          !isSha(ticket.baseSha) || !isSha(ticket.beforeAgentHead) || !isSha(ticket.treeSha)) {
        throw new Blocker('interrupted_candidate_identity_mismatch', 'Workspace, base, pre-agent, current head and tree must match the blocked candidate exactly');
      }
      const receipt = ticket.blocker.detail?.receipt, argv = receipt?.argv;
      const execIndex = Array.isArray(argv) ? argv.indexOf('exec') : -1;
      const sandboxIndex = Array.isArray(argv) ? argv.indexOf('--sandbox') : -1;
      const workspaceIndex = Array.isArray(argv) ? argv.indexOf('-C') : -1;
      if (!receipt || !(receipt.stopped === true || receipt.timedOut === true) || receipt.outputExceeded !== false ||
          (receipt.launchError !== undefined && receipt.launchError !== null) ||
          !Number.isFinite(receipt.startedAt) || !Number.isFinite(receipt.endedAt) || receipt.endedAt < receipt.startedAt ||
          !Array.isArray(argv) || execIndex < 0 || argv[execIndex + 1] !== '--ignore-user-config' || argv[execIndex + 2] !== '--json' ||
          argv[execIndex + 3] !== '--ephemeral' || sandboxIndex < 0 || argv[sandboxIndex + 1] !== 'workspace-write' ||
          workspaceIndex < 0 || typeof argv[workspaceIndex + 1] !== 'string' || path.resolve(argv[workspaceIndex + 1]) !== path.resolve(ticket.workspace) ||
          (request.expectedBlockerDigest !== digest(ticket.blocker) || request.expectedProcessReceiptDigest !== digest(receipt))) {
        throw new Blocker('interrupted_candidate_evidence_mismatch', 'A matching stopped or timed-out implementation receipt for this workspace is required');
      }

      const recoveryId = randomUUID(), authorizedAt = Date.now();
      const record = {
        recoveryId, status: 'authorized', authorizedAt, implementationCompleted: false,
        evidence: {
          configDigest: projectRow.config_hash, contractDigest: digest(ticket.spec.execution), spec: structuredClone(ticket.spec),
          workspace: ticket.workspace, baseSha: ticket.baseSha, beforeAgentHead: ticket.beforeAgentHead,
          priorCandidate: { headSha: ticket.headSha, treeSha: ticket.treeSha },
          correctionAdmissionId: ticket.correctionAdmission.admissionId, correctionDigest: digest(ticket.correctionAdmission),
          correctionAdmission: structuredClone(ticket.correctionAdmission),
          blocker: structuredClone(ticket.blocker), blockerDigest: digest(ticket.blocker),
          processReceipt: structuredClone(receipt), processReceiptDigest: digest(receipt),
          counters: { attempts: ticket.attempts, repairs: ticket.repairs, rebases: ticket.rebases ?? 0,
            reviewAttempts: ticket.reviewAttempts ?? 0, agentCalls: state.agentCalls },
          implementation: structuredClone(ticket.implementation), implementationSessions: structuredClone(ticket.implementationSessions ?? []),
          review: structuredClone(ticket.review ?? null), verification: structuredClone(ticket.verification ?? null),
          lastFailedReview: structuredClone(ticket.lastFailedReview ?? null), repairReason: structuredClone(ticket.repairReason ?? null),
          retryHistory: structuredClone(ticket.retryHistory ?? []),
          interruptedContinuation: structuredClone(ticket.interruptedContinuation ?? null), partialRecovery: structuredClone(ticket.partialRecovery ?? null)
        }
      };
      ticket.interruptedCandidateVerification = record;
      ticket.status = 'recovering_candidate';
      state.updatedAt = authorizedAt;
      this.db.prepare('UPDATE project SET state=? WHERE id=?').run(JSON.stringify(state), state.id);
      this.emit(state.id, 'ticket.interrupted_candidate_verification_authorized', {
        ticket: ticket.spec.id, recoveryId, correctionAdmissionId: record.evidence.correctionAdmissionId,
        headSha: ticket.headSha, treeSha: ticket.treeSha, processReceiptDigest: record.evidence.processReceiptDigest
      });
      return { authorized: true, project: state.id, ticket: ticket.spec.id, recoveryId,
        workspace: ticket.workspace, beforeAgentHead: ticket.beforeAgentHead, expectedHeadSha: ticket.headSha, expectedTreeSha: ticket.treeSha };
    });
  }
  completeInterruptedCandidateVerification(id, ticketId, recoveryId, candidate, beforeIdentity) {
    requireValue(candidate && isSha(candidate.headSha) && isSha(candidate.treeSha) && Array.isArray(candidate.files) &&
      beforeIdentity && isSha(beforeIdentity.headSha) && isSha(beforeIdentity.treeSha) && typeof beforeIdentity.dirty === 'string' && beforeIdentity.dirty,
    'Checkpoint candidate and observed interrupted workspace identities are incomplete', 'interrupted_candidate_identity_mismatch');
    return this.update(id, state => {
      const ticket = state.tickets.find(item => item.spec.id === ticketId), record = ticket?.interruptedCandidateVerification;
      if (!ticket || ticket.status !== 'recovering_candidate' || record?.recoveryId !== recoveryId || record.status !== 'authorized') {
        throw new Blocker('interrupted_candidate_state_mismatch', 'Interrupted-candidate authorization is missing or already settled');
      }
      if (ticket.workspace !== record.evidence.workspace || ticket.baseSha !== record.evidence.baseSha ||
          ticket.beforeAgentHead !== record.evidence.beforeAgentHead || ticket.headSha !== record.evidence.priorCandidate.headSha ||
          ticket.treeSha !== record.evidence.priorCandidate.treeSha || ticket.correctionAdmission?.admissionId !== record.evidence.correctionAdmissionId ||
          digest(ticket.correctionAdmission) !== record.evidence.correctionDigest || digest(ticket.blocker) !== record.evidence.blockerDigest ||
          beforeIdentity.headSha !== record.evidence.beforeAgentHead || beforeIdentity.treeSha !== record.evidence.priorCandidate.treeSha ||
          candidate.headSha === beforeIdentity.headSha || candidate.treeSha === beforeIdentity.treeSha) {
        throw new Blocker('interrupted_candidate_identity_mismatch', 'Durable ticket or workspace identity changed during interrupted-candidate checkpoint');
      }
      ticket.headSha = candidate.headSha; ticket.treeSha = candidate.treeSha;
      ticket.status = 'verifying'; ticket.review = null; ticket.verification = null; ticket.blocker = null; delete ticket.activeJob;
      Object.assign(record, { status: 'completed', completedAt: Date.now(), beforeIdentity: structuredClone(beforeIdentity), candidate: structuredClone(candidate) });
      state.updatedAt = record.completedAt;
    }, 'ticket.interrupted_candidate_verification_completed', { ticket: ticketId, recoveryId, headSha: candidate.headSha, treeSha: candidate.treeSha });
  }
  failInterruptedCandidateVerification(id, ticketId, recoveryId, error) {
    return this.update(id, state => {
      const ticket = state.tickets.find(item => item.spec.id === ticketId), record = ticket?.interruptedCandidateVerification;
      if (!ticket || ticket.status !== 'recovering_candidate' || record?.recoveryId !== recoveryId || record.status !== 'authorized') {
        throw new Blocker('interrupted_candidate_state_mismatch', 'Interrupted-candidate authorization is missing or already settled');
      }
      ticket.status = 'blocked'; delete ticket.activeJob;
      record.status = 'failed'; record.failedAt = Date.now();
      record.failure = { code: error?.code ?? 'unexpected_error', message: String(error?.message ?? error).slice(0, 2000) };
      state.updatedAt = record.failedAt;
    }, 'ticket.interrupted_candidate_verification_failed', { ticket: ticketId, recoveryId, code: error?.code ?? 'unexpected_error' });
  }
  continueInterrupted(expectedConfig, continuation) {
    const config = validateConfig(structuredClone(expectedConfig));
    validateContinuation(continuation);
    return this.transaction(() => {
      const state = this.get(config.id);
      this.assertProducerScopesClear(state.id);
      const row = this.db.prepare('SELECT config_hash FROM project WHERE id=?').get(config.id);
      if (!row || row.config_hash !== digest(state.config) || digest(config) !== row.config_hash) {
        throw new Blocker('config_changed', 'Expected configuration does not match durable project policy');
      }
      if (!state.paused) throw new Blocker('continuation_busy', 'Pause the project before continuing an interrupted attempt');
      const leaseKey = `controller:${state.id}`;
      const held = this.db.prepare('SELECT pid FROM leases WHERE resource=?').get(leaseKey);
      if (held && !this.ownsProducerLease(`controller:${state.id}`) && isLivePid(held.pid)) throw new Blocker('continuation_busy', 'Wait for the paused controller to settle before continuing an attempt', { pid: held.pid });
      if (held && !this.ownsProducerLease(leaseKey)) this.db.prepare('DELETE FROM leases WHERE resource=?').run(leaseKey);
      if (state.tickets.some(ticket => ticket.activeJob || ['implementing', 'reviewing'].includes(ticket.status))) {
        throw new Blocker('continuation_busy', 'Wait for active ticket jobs to settle before continuing an attempt');
      }

      const ticket = state.tickets.find(item => item.spec.id === continuation.ticketId);
      if (!ticket) throw new Blocker('not_found', `Ticket ${continuation.ticketId} unavailable`);
      if (ticket.interruptedContinuation) throw new Blocker('continuation_already_used', 'This ticket already used its one lifetime interrupted-attempt continuation');
      if (!ticket.spec.execution) throw new Blocker('continuation_ineligible', 'Interrupted continuation requires a structured execution contract');
      if (ticket.status !== 'blocked' || !['repair_budget', 'slice_budget', 'unexpectedinfra', 'unexpected_infra', 'unexpected_error', 'runtime_failed'].includes(ticket.blocker?.code)) {
        throw new Blocker('continuation_ineligible', 'Ticket must be blocked by repair_budget, slice_budget, or an unexpected infrastructure failure');
      }
      if (ticket.mergeSha || ticket.publication || ticket.shippedAt || ticket.postmerge) {
        throw new Blocker('continuation_ineligible', 'Merged, shipped, published, or postmerge tickets cannot continue an interrupted attempt');
      }
      if (!ticket.recovered || ticket.implementation != null) {
        throw new Blocker('continuation_ineligible', 'Continuation requires a recovered partial candidate without completed implementation metadata');
      }
      if (!isSha(ticket.headSha) || ticket.headSha !== continuation.expectedHeadSha || !isSha(ticket.treeSha) ||
          !isSha(ticket.baseSha) || !isSha(ticket.beforeAgentHead) || typeof ticket.workspace !== 'string' || !ticket.workspace ||
          !Number.isSafeInteger(ticket.attempts) || ticket.attempts < 1 || !Number.isSafeInteger(ticket.repairs) || ticket.repairs < 0) {
        throw new Blocker('continuation_identity_mismatch', 'Expected head and complete partial candidate identity are required');
      }

      const admittedAt = Date.now(), continuationId = randomUUID();
      const partialReview = structuredClone(ticket.review ?? ticket.lastFailedReview ?? null);
      const partialVerification = structuredClone(ticket.verification ?? null);
      const originalBlocker = structuredClone(ticket.blocker);
      const record = {
        continuationId, admittedAt, instructions: continuation.instructions, status: 'authorized',
        logicalAttempt: ticket.attempts,
        partial: {
          headSha: ticket.headSha, treeSha: ticket.treeSha, baseSha: ticket.baseSha,
          beforeAgentHead: ticket.beforeAgentHead, workspace: ticket.workspace, generation: ticket.generation ?? null,
          review: partialReview, verification: partialVerification, blocker: originalBlocker,
          counters: { attempts: ticket.attempts, repairs: ticket.repairs, rebases: ticket.rebases, reviewAttempts: ticket.reviewAttempts ?? 0 }
        }
      };
      ticket.interruptedContinuation = record;
      ticket.status = 'continuing';
      ticket.blocker = null;
      ticket.repairReason = {
        code: 'interrupted_continuation',
        message: 'Continue the same logical implementation attempt from its recovered partial candidate.',
        actualPartialReview: partialReview,
        actualPartialVerification: partialVerification,
        instructions: record.instructions
      };
      ticket.review = null;
      ticket.verification = null;
      ticket.retryAt = 0;
      ticket.pollAt = 0;

      for (const dependent of state.tickets) if (dependent.status === 'dependency_blocked' && dependent.blocker?.code === 'dependency') {
        dependent.status = 'queued'; dependent.blocker = null; dependent.retryAt = 0;
      }
      state.updatedAt = admittedAt;
      this.db.prepare('UPDATE project SET state=? WHERE id=?').run(JSON.stringify(state), state.id);
      this.emit(state.id, 'ticket.interrupted_continuation_authorized', {
        ticket: ticket.spec.id, continuationId, headSha: ticket.headSha,
        blocker: originalBlocker.code, logicalAttempt: ticket.attempts,
        partialReviewDigest: partialReview ? digest(partialReview) : null
      });
      return { continued: true, project: state.id, ticket: ticket.spec.id, continuationId, headSha: ticket.headSha, status: ticket.status, admittedAt };
    });
  }
  adoptCorrectiveDelivery(expectedConfig, fulfillment) {
    const config = validateConfig(structuredClone(expectedConfig));
    validateFulfillmentInput(fulfillment);
    return this.transaction(() => {
      const state = this.get(config.id);
      this.assertProducerScopesClear(state.id);
      const targetRow = this.db.prepare('SELECT config_hash FROM project WHERE id=?').get(config.id);
      if (!targetRow || targetRow.config_hash !== digest(state.config) || digest(config) !== targetRow.config_hash) {
        throw new Blocker('config_changed', 'Expected target configuration does not match durable project policy');
      }
      if (!state.paused) throw new Blocker('fulfillment_busy', 'Pause the target project before adopting a corrective delivery');
      const leaseKey = `controller:${state.id}`;
      const held = this.db.prepare('SELECT pid FROM leases WHERE resource=?').get(leaseKey);
      if (held && !this.ownsProducerLease(`controller:${state.id}`) && isLivePid(held.pid)) throw new Blocker('fulfillment_busy', 'Wait for the paused target controller to settle before adoption', { pid: held.pid });
      if (held && !this.ownsProducerLease(leaseKey)) this.db.prepare('DELETE FROM leases WHERE resource=?').run(leaseKey);
      if (state.tickets.some(ticket => ticket.activeJob || ['implementing', 'reviewing'].includes(ticket.status))) {
        throw new Blocker('fulfillment_busy', 'Wait for active target ticket jobs to settle before adoption');
      }

      const target = state.tickets.find(ticket => ticket.spec.id === fulfillment.ticketId);
      if (!target) throw new Blocker('not_found', `Target ticket ${fulfillment.ticketId} unavailable`);
      if (target.correctiveFulfillment) throw new Blocker('fulfillment_already_adopted', 'This target ticket already has a lifetime corrective-delivery adoption');
      if (!target.spec.execution) throw new Blocker('fulfillment_ineligible', 'Adoption requires a structured target execution contract');
      if (target.status !== 'blocked' || !['repair_budget', 'slice_budget'].includes(target.blocker?.code)) {
        throw new Blocker('fulfillment_ineligible', 'Target must be blocked by repair_budget or slice_budget');
      }
      if (!isSha(target.headSha) || target.headSha !== fulfillment.expectedHeadSha) {
        throw new Blocker('fulfillment_head_mismatch', 'expectedHeadSha does not match the blocked target candidate');
      }
      if (target.mergeSha || target.publication || target.shippedAt || target.postmerge || target.status === 'postmerge') {
        throw new Blocker('fulfillment_ineligible', 'Merged, shipped, published, or postmerge targets cannot adopt another delivery');
      }

      if (fulfillment.sourceProjectId === state.id) throw new Blocker('fulfillment_source_invalid', 'Source project must differ from the target project');
      const sourceState = this.get(fulfillment.sourceProjectId);
      this.assertProducerScopesClear(sourceState.id);
      const sourceRow = this.db.prepare('SELECT config_hash FROM project WHERE id=?').get(fulfillment.sourceProjectId);
      if (!sourceRow || sourceRow.config_hash !== digest(sourceState.config)) throw new Blocker('fulfillment_source_invalid', 'Source project configuration receipt is inconsistent');
      const source = sourceState.tickets.find(ticket => ticket.spec.id === fulfillment.sourceTicketId);
      if (!source) throw new Blocker('not_found', `Source ticket ${fulfillment.sourceTicketId} unavailable`);
      if (source.correctiveFulfillment) throw new Blocker('fulfillment_source_used', 'A previously fulfilled ticket cannot fulfill another target');

      const alreadyUsed = this.db.prepare('SELECT state FROM project').all().some(row => {
        const project = JSON.parse(row.state);
        return project.tickets.some(ticket => ticket.correctiveFulfillment?.source?.projectId === fulfillment.sourceProjectId &&
          ticket.correctiveFulfillment?.source?.ticketId === fulfillment.sourceTicketId);
      });
      if (alreadyUsed) throw new Blocker('fulfillment_source_used', 'This source ticket already fulfills another target');
      if (source.status !== 'shipped' || !isSha(source.headSha) || !isSha(source.mergeSha) || !isSha(source.treeSha) || !isSha(source.baseSha) ||
          typeof source.workspace !== 'string' || !source.workspace || typeof source.branch !== 'string' || !source.branch ||
          !Number.isSafeInteger(source.generation) || !source.implementation?.sessionRef || !source.implementation?.jobId) {
        throw new Blocker('fulfillment_source_unshipped', 'Source must be a Squire-shipped ticket with exact head, merge, and tree identities');
      }
      if (!source.spec.execution) throw new Blocker('fulfillment_source_unverified', 'Source ticket must have a structured execution contract');

      const targetService = state.config.services[target.spec.service];
      const sourceService = sourceState.config.services[source.spec.service];
      if (!sourceService || !targetService) throw new Blocker('fulfillment_authority_mismatch', 'Source and target service definitions are unavailable');
      for (const field of ['source', 'branch', 'delivery', 'checks', 'protectedPaths']) {
        if (!same(sourceService[field] ?? null, targetService[field] ?? null)) {
          throw new Blocker('fulfillment_authority_mismatch', `Source and target service authority differs: ${field}`);
        }
      }
      if (!same(sourceService.setup ?? [], targetService.setup ?? []) || !same(sourceState.config.runtime, state.config.runtime)) {
        throw new Blocker('fulfillment_authority_mismatch', 'Source and target setup or runtime authority differs');
      }

      const targetOwned = [...target.spec.execution.ownedPaths].sort();
      const sourceOwned = [...source.spec.execution.ownedPaths].sort();
      if (!same(sourceOwned, targetOwned)) throw new Blocker('fulfillment_scope_mismatch', 'Source ownedPaths must exactly match the original target scope');
      const sourceCriteria = new Map(effectiveChecklist(source).map(item => [item.id, item]));
      for (const criterion of effectiveChecklist(target)) {
        if (!sourceCriteria.has(criterion.id) || !same(sourceCriteria.get(criterion.id), criterion)) {
          throw new Blocker('fulfillment_criteria_mismatch', `Source does not preserve target criterion ${criterion.id} exactly`);
        }
      }

      if (source.review?.verdict !== 'pass' || source.review.headSha !== source.headSha ||
          typeof source.review.sessionRef !== 'string' || !source.review.sessionRef || typeof source.review.jobId !== 'string' || !source.review.jobId ||
          source.review.sessionRef === source.implementation?.sessionRef || source.implementationSessions?.includes(source.review.sessionRef) ||
          source.review.sessionRef === target.implementation?.sessionRef || target.implementationSessions?.includes(source.review.sessionRef)) {
        throw new Blocker('fulfillment_source_unverified', 'Source requires a fresh passing review of its exact candidate');
      }
      const sourceExecution = { ...source.spec.execution, checklist: effectiveChecklist(source) };
      validateReview(source.review, source.headSha, sourceExecution);
      if (source.verification?.passed !== true || source.verification.headSha !== source.headSha ||
          source.verification.treeSha !== source.treeSha || source.verification.policyDigest !== digest(sourceService.checks) ||
          source.postmerge?.passed !== true || source.postmerge.headSha !== source.mergeSha || source.postmerge.treeSha !== source.treeSha) {
        throw new Blocker('fulfillment_source_unverified', 'Source exact-head verification and postmerge receipts must pass and match its merge tree');
      }
      const evidence = source.checklistEvidence;
      if (!evidence || evidence.headSha !== source.mergeSha || evidence.reviewedHeadSha !== source.headSha ||
          evidence.contractDigest !== digest(source.spec.execution) || !same(evidence.items, source.review.checklist) ||
          !same(evidence.verification, source.verification.results) || !same(evidence.postmerge, source.postmerge.results) ||
          (source.correctionAdmission && (evidence.correctionAdmissionId !== source.correctionAdmission.admissionId ||
            !same(evidence.correctionChecklist, source.correctionAdmission.checklist)))) {
        throw new Blocker('fulfillment_source_unverified', 'Source checklist evidence does not match its durable review, contract, verification, and postmerge receipts');
      }

      const adoptedAt = Date.now();
      const sourceReceipt = {
        projectId: fulfillment.sourceProjectId, ticketId: fulfillment.sourceTicketId,
        configDigest: sourceRow.config_hash, specDigest: digest(source.spec),
        headSha: source.headSha, mergeSha: source.mergeSha, treeSha: source.treeSha, baseSha: source.baseSha,
        workspace: source.workspace, branch: source.branch, generation: source.generation,
        counters: { attempts: source.attempts, repairs: source.repairs, rebases: source.rebases, reviewAttempts: source.reviewAttempts ?? 0 },
        implementationDigest: digest(source.implementation ?? null), implementationSessionsDigest: digest(source.implementationSessions ?? []),
        reviewDigest: digest(source.review), verificationDigest: digest(source.verification),
        postmergeDigest: digest(source.postmerge), checklistEvidenceDigest: digest(evidence), shippedAt: source.shippedAt ?? null
      };
      target.correctiveFulfillment = {
        adoptedAt, source: sourceReceipt, receiptDigest: digest(sourceReceipt),
        target: {
          originalSpec: structuredClone(target.spec), specDigest: digest(target.spec),
          candidate: { headSha: target.headSha, treeSha: target.treeSha ?? null, baseSha: target.baseSha ?? null, workspace: target.workspace ?? null, generation: target.generation ?? null },
          identity: { branch: target.branch ?? null, implementation: structuredClone(target.implementation ?? null), implementationSessions: structuredClone(target.implementationSessions ?? []) },
          review: structuredClone(target.review ?? null), lastFailedReview: structuredClone(target.lastFailedReview ?? null),
          verification: structuredClone(target.verification ?? null), blocker: structuredClone(target.blocker),
          repairReason: structuredClone(target.repairReason ?? null),
          counters: { attempts: target.attempts, repairs: target.repairs, rebases: target.rebases, reviewAttempts: target.reviewAttempts ?? 0, runtimeRetries: target.runtimeRetries ?? 0 },
          correctionAdmission: structuredClone(target.correctionAdmission ?? null)
        }
      };
      target.headSha = source.headSha;
      target.mergeSha = source.mergeSha;
      target.treeSha = source.treeSha;
      target.baseSha = source.baseSha;
      target.workspace = source.workspace;
      target.branch = source.branch;
      target.generation = source.generation;
      target.implementation = structuredClone(source.implementation);
      target.implementationSessions = structuredClone(source.implementationSessions ?? []);
      target.review = structuredClone(source.review);
      target.verification = structuredClone(source.verification);
      target.postmerge = structuredClone(source.postmerge);
      target.checklistEvidence = structuredClone(evidence);
      target.blocker = null;
      target.status = 'shipped';
      target.shippedAt = adoptedAt;

      for (const dependent of state.tickets) if (dependent.status === 'dependency_blocked' && dependent.blocker?.code === 'dependency') {
        dependent.status = 'queued'; dependent.blocker = null; dependent.retryAt = 0;
      }
      state.updatedAt = adoptedAt;
      this.db.prepare('UPDATE project SET state=? WHERE id=?').run(JSON.stringify(state), state.id);
      this.emit(state.id, 'ticket.corrective_delivery_adopted', {
        ticket: target.spec.id, sourceProject: fulfillment.sourceProjectId, sourceTicket: fulfillment.sourceTicketId,
        sourceHeadSha: source.headSha, mergeSha: source.mergeSha, treeSha: source.treeSha,
        receiptDigest: target.correctiveFulfillment.receiptDigest
      });
      return { adopted: true, project: state.id, ticket: target.spec.id, sourceProject: fulfillment.sourceProjectId,
        sourceTicket: fulfillment.sourceTicketId, headSha: source.headSha, mergeSha: source.mergeSha, treeSha: source.treeSha,
        receiptDigest: target.correctiveFulfillment.receiptDigest, adoptedAt };
    });
  }
  resume(id, retry = false, ticketIds = null) {
    return this.update(id, s => {
      this.assertProducerScopesClear(id);
      if (s.tickets.some(ticket => ticket.partialRecovery?.status === 'authorized')) {
        throw new Blocker('partial_recovery_busy', 'Finish the authorized partial-recovery checkpoint before resuming the project');
      }
      if (ticketIds !== null && (!retry || !Array.isArray(ticketIds) || !ticketIds.length || new Set(ticketIds).size !== ticketIds.length || ticketIds.some(id => !s.tickets.some(t => t.spec.id === id)))) {
        throw new Blocker('invalid_retry', 'Selective retry requires --retry and unique existing ticket IDs');
      }
      if (retry && s.tickets.some(ticket => (ticketIds === null || ticketIds.includes(ticket.spec.id)) && ticket.interruptedCandidateVerification)) {
        throw new Blocker('interrupted_candidate_already_used', 'Interrupted-candidate verification has a one-time checkpoint; use normal resume and do not retry or re-checkpoint it');
      }
      s.paused = false;
      if (retry) {
        for (const t of s.tickets) {
          if (ticketIds !== null && !ticketIds.includes(t.spec.id)) continue;
          if (['blocked', 'dependency_blocked', 'waiting_capacity'].includes(t.status)) {
            t.retryHistory = [...(t.retryHistory ?? []), { at: Date.now(), status: t.status, headSha: t.headSha ?? null, blocker: structuredClone(t.blocker ?? null), attempts: t.attempts, repairs: t.repairs }];
            if (t.blocker?.code === 'postmerge_failed') t.status = 'postmerge';
            else if (t.mergeSha) t.status = 'postmerge';
            else if (t.headSha) t.status = 'verifying';
            else if (t.workspace && t.beforeAgentHead && t.blocker?.message === 'Subprocess ended without durable receipt') t.status = 'recovering';
            else t.status = 'queued';
            t.retryAt = 0; delete t.blocker;
          }
        }
        for (const a of Object.values(s.acceptance)) if (a.status === 'failed') a.status = 'queued';
        s.blocker = null; s.status = 'queued';
      }
    }, 'project.resumed', { retry, ...(ticketIds !== null ? { ticketIds } : {}) });
  }
}
