import { createHash } from 'node:crypto';

export const SQF04_DESIGN_SHA256 = '46a69d0d60a29b5c85ba774a23ce19c5e17649a0c223fb2036c83b86f8626a1c';
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 2048 && !value.includes('\0');
const integer = value => Number.isSafeInteger(value) && value >= 0;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const keys = (value, fields) => record(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
function canonical(value, depth = 0, seen = new Set()) {
  if (depth > 32) throw new TypeError('Receipt nesting limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if ((!record(value) && !Array.isArray(value)) || seen.has(value)) throw new TypeError('JSON receipt required');
  if (Array.isArray(value) && value.length > 256) throw new TypeError('Receipt array limit');
  seen.add(value);
  const result = Array.isArray(value) ? value.map(item => canonical(item, depth + 1, seen))
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], depth + 1, seen)]));
  seen.delete(value);
  return result;
}
function encoded(value) {
  const result = JSON.stringify(canonical(value));
  if (Buffer.byteLength(result, 'utf8') > 128 * 1024) throw new TypeError('Receipt byte limit');
  return result;
}
/** A content reference only: this digest authenticates neither producer nor host observations. */
export function settlementContractDigest(value) {
  try { return createHash('sha256').update(encoded(value)).digest('hex'); } catch { return null; }
}
const bindingFields = ['project', 'ticket', 'job', 'generation', 'candidateSha', 'policyDigest', 'operationId', 'requestDigest'];
const identityFields = ['bootId', 'unitName', 'invocationId', 'controlGroup', 'cgroupIdentity', 'anchorIdentity'];
const deadlineFields = ['startedAtMs', 'execByMs', 'stopByMs', 'observeByMs', 'finalCleanupByMs'];
const authorityFields = ['managerDigest', 'migrationDigest', 'observerDigest', 'anchorDigest', 'pidViewDigest', 'policyDigest', 'launchBarrierDigest'];
const anchorFields = ['pid', 'startTicks', 'pidNamespace'];
function anchor(value) {
  return keys(value, anchorFields) && integer(value.pid) && value.pid > 0 && typeof value.startTicks === 'string' && /^[0-9]+$/.test(value.startTicks) && text(value.pidNamespace);
}
function binding(value) {
  return keys(value, bindingFields) && ['project', 'ticket', 'job', 'operationId'].every(key => text(value[key])) && integer(value.generation) && value.generation > 0 &&
    typeof value.candidateSha === 'string' && /^[a-f0-9]{40}$/.test(value.candidateSha) && ['policyDigest', 'requestDigest'].every(key => hash(value[key]));
}
function identity(value) {
  return keys(value, identityFields) && identityFields.filter(key => key !== 'anchorIdentity').every(key => text(value[key])) && anchor(value.anchorIdentity);
}
function deadlines(value) {
  return keys(value, deadlineFields) && deadlineFields.every(key => integer(value[key])) && value.execByMs > value.startedAtMs &&
    value.stopByMs >= value.execByMs && value.observeByMs >= value.stopByMs && value.finalCleanupByMs >= value.observeByMs;
}
function scope(value, operationId) {
  return keys(value, ['sealDigest', 'operations']) && hash(value.sealDigest) && Array.isArray(value.operations) && value.operations.length > 0 && value.operations.length <= 100 &&
    value.operations.every(item => keys(item, ['operationId', 'requestDigest', 'settlementDigest']) && text(item.operationId) && hash(item.requestDigest) && hash(item.settlementDigest)) &&
    new Set(value.operations.map(item => item.operationId)).size === value.operations.length && value.operations.some(item => item.operationId === operationId);
}
const same = (a, b) => encoded(a) === encoded(b);
const scopeReference = value => ({ sealDigest: value.sealDigest, operations: [...value.operations].sort((a, b) => a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0) });

/**
 * Compare supplied JSON contract metadata only. Never performs I/O, authenticates
 * receipts, authorizes a launch/import, settles a worker or changes accounting.
 * Even contract_matches requires separate trusted provenance and live acceptance.
 * priorProjection is a supplied snapshot, not a store transaction/replay guarantee.
 */
export function compareSettlementContract(requirements, receipt, priorProjection = null) {
  const blockers = [];
  let mismatch = false;
  let replay = 'not_evaluated';
  const add = (code, different = false) => { if (!blockers.includes(code)) blockers.push(code); mismatch ||= different; };
  const result = () => ({ status: blockers.length ? (mismatch ? 'mismatch' : 'unknown') : 'contract_matches',
    admission: 'not_evaluated', settlement: 'not_evaluated', import: 'not_evaluated', replay, blockers });
  try {
    encoded(requirements); encoded(receipt); encoded(priorProjection);
    if (!keys(requirements, ['version', 'designSha256', 'binding', 'identity', 'deadlines', 'scope']) ||
        !keys(receipt, ['version', 'designSha256', 'binding', 'identity', 'deadlines', 'authority', 'boundary', 'directTerminal', 'teardown', 'scope', 'launchGate'])) {
      add('evidence_shape_unsupported'); return result();
    }
    if (requirements.version !== 1 || receipt.version !== 1 || requirements.designSha256 !== SQF04_DESIGN_SHA256 || receipt.designSha256 !== SQF04_DESIGN_SHA256) add('design_or_version_unsupported');
    for (const [name, validate] of [['binding', binding], ['identity', identity], ['deadlines', deadlines]]) {
      if (!validate(requirements[name]) || !validate(receipt[name])) add(`${name}_unknown`);
      else if (!same(requirements[name], receipt[name])) add(`${name}_changed`, true);
    }
    if (!keys(receipt.authority, authorityFields) || !authorityFields.every(key => hash(receipt.authority[key]))) add('authority_or_pid_view_unknown');
    else if (receipt.authority.policyDigest !== requirements.binding?.policyDigest) add('effective_policy_changed', true);
    const boundary = receipt.boundary;
    const boundaryFields = ['status', 'type', 'frozen', 'populated', 'members', 'subgroups', 'snapshotDigest', 'observedAtMs', 'prunedBeforeSnapshot'];
    if (!keys(boundary, boundaryFields) || boundary.status !== 'frozen_anchor_only' || boundary.type !== 'domain' || boundary.frozen !== 1 || boundary.populated !== 1 ||
        !Array.isArray(boundary.members) || boundary.members.length !== 1 || !anchor(boundary.members[0]) || !Array.isArray(boundary.subgroups) || boundary.subgroups.length !== 0 ||
        !hash(boundary.snapshotDigest) || !integer(boundary.observedAtMs) || boundary.prunedBeforeSnapshot !== false) add('workload_empty_snapshot_unknown');
    else if (!anchor(requirements.identity?.anchorIdentity) || !same(boundary.members[0], requirements.identity.anchorIdentity)) add('anchor_identity_changed', true);
    const terminal = receipt.directTerminal;
    if (!keys(terminal, ['status', 'operationId', 'terminalDigest', 'observedAtMs']) || terminal.status !== 'terminal' || !hash(terminal.terminalDigest) || !integer(terminal.observedAtMs)) add('direct_terminal_unknown');
    else if (terminal.operationId !== requirements.binding?.operationId) add('direct_terminal_operation_changed', true);
    const teardown = receipt.teardown;
    if (!keys(teardown, ['status', 'protocol', 'anchorIdentity', 'terminalDigest', 'workloadEmptyDigest', 'observedAtMs', 'prunedBeforeTerminal']) ||
        teardown.status !== 'terminal' || teardown.protocol !== 'teardown_only' || !anchor(teardown.anchorIdentity) || !hash(teardown.terminalDigest) ||
        !hash(teardown.workloadEmptyDigest) || !integer(teardown.observedAtMs) || teardown.prunedBeforeTerminal !== false) add('anchor_teardown_unknown');
    else {
      if (!anchor(requirements.identity?.anchorIdentity) || !same(teardown.anchorIdentity, requirements.identity.anchorIdentity)) add('teardown_identity_changed', true);
      if (teardown.workloadEmptyDigest !== boundary?.snapshotDigest) add('teardown_snapshot_changed', true);
    }
    if (!deadlines(requirements.deadlines) || !integer(terminal?.observedAtMs) || !integer(boundary?.observedAtMs) || !integer(teardown?.observedAtMs) ||
        terminal.observedAtMs < requirements.deadlines.startedAtMs || terminal.observedAtMs > requirements.deadlines.stopByMs ||
        boundary.observedAtMs < terminal.observedAtMs || boundary.observedAtMs > requirements.deadlines.observeByMs ||
        teardown.observedAtMs < boundary.observedAtMs || teardown.observedAtMs > requirements.deadlines.finalCleanupByMs) add('absolute_deadline_or_order_unknown');
    if (!scope(requirements.scope, requirements.binding?.operationId) || !scope(receipt.scope, requirements.binding?.operationId)) add('operation_inventory_unknown');
    else {
      if (!same(scopeReference(requirements.scope), scopeReference(receipt.scope))) add('operation_inventory_changed', true);
      if (receipt.scope.operations.find(item => item.operationId === requirements.binding.operationId).requestDigest !== requirements.binding.requestDigest ||
          requirements.scope.operations.find(item => item.operationId === requirements.binding.operationId).requestDigest !== requirements.binding.requestDigest) add('scope_request_changed', true);
    }
    if (receipt.launchGate !== 'closed') add('launch_gate_unknown');
    if (priorProjection === null) replay = 'unseen';
    else if (!keys(priorProjection, ['binding', 'sealDigest', 'receiptDigest']) || !binding(priorProjection.binding) || !hash(priorProjection.sealDigest) || !hash(priorProjection.receiptDigest)) add('projection_snapshot_unknown');
    else if (!binding(requirements.binding) || !same(priorProjection.binding, requirements.binding) || priorProjection.sealDigest !== requirements.scope?.sealDigest || priorProjection.receiptDigest !== settlementContractDigest(receipt)) {
      replay = 'conflicting_receipt'; add('projection_conflict', true);
    } else replay = 'same_receipt';
    return result();
  } catch { add('json_evidence_unsupported'); return result(); }
}
