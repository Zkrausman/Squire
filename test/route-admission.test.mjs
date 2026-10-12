import test from './standalone.mjs';
import assert from 'node:assert/strict';
import { evaluateRouteAdmission, routeRequirementsDigest } from '../src/route-admission.mjs';

const sha1 = 'a'.repeat(40);
const sha256 = value => value.repeat(64);
const capabilityNames = ['workspace-write', 'spawn', 'cancel-and-settle'];

function fixture() {
  const requirements = {
    version: 1,
    route: { kind: 'codex', authentication: 'subscription' },
    role: 'implement',
    baseSha: sha1,
    tool: { name: 'codex', version: 'fixture-1', fingerprint: sha256('b') },
    fingerprint: sha256('c'),
    requiredCapabilities: [...capabilityNames],
    cleanupDeadlineMs: 1000
  };
  const observation = {
    version: 1,
    receiptId: 'probe-1',
    requirementsDigest: routeRequirementsDigest(requirements),
    route: { kind: 'codex', authentication: 'subscription' },
    role: requirements.role,
    baseSha: requirements.baseSha,
    tool: { available: true, ...requirements.tool },
    fingerprint: requirements.fingerprint,
    capabilities: capabilityNames.map((name, index) => ({
      name,
      status: 'passed',
      evidenceKind: 'observed',
      operation: `probe-${index + 1}`,
      operationId: `operation-${index + 1}`,
      receiptDigest: sha256(String(index + 1)),
      fingerprint: requirements.fingerprint
    })),
    cleanup: {
      status: 'passed',
      evidenceKind: 'observed',
      operationId: 'cleanup-1',
      receiptDigest: sha256('d'),
      fingerprint: requirements.fingerprint,
      durationMs: 40,
      deadlineMs: requirements.cleanupDeadlineMs
    }
  };
  return { requirements, observation };
}

const codes = result => result.blockers.map(item => item.code);

test('complete synthetic same-boundary evidence is eligible without granting dispatch authority', () => {
  const { requirements, observation } = fixture();
  const result = evaluateRouteAdmission(requirements, observation);
  assert.deepEqual(result, { eligible: true, blockers: [] });
  assert.equal(Object.hasOwn(result, 'admitted'), false);
  assert.equal(Object.hasOwn(result, 'dispatch'), false);
});

test('wrong base or role blocks the route evidence', () => {
  const base = fixture();
  base.observation.baseSha = 'e'.repeat(40);
  assert.ok(codes(evaluateRouteAdmission(base.requirements, base.observation)).includes('route_base_mismatch'));

  const role = fixture();
  role.observation.role = 'review';
  assert.ok(codes(evaluateRouteAdmission(role.requirements, role.observation)).includes('route_role_mismatch'));
});

test('missing or changed tool blocks even when the rest of the observation matches', () => {
  const missing = fixture();
  missing.observation.tool.available = false;
  assert.ok(codes(evaluateRouteAdmission(missing.requirements, missing.observation)).includes('route_tool_missing'));

  const changed = fixture();
  changed.observation.tool.fingerprint = sha256('e');
  assert.ok(codes(evaluateRouteAdmission(changed.requirements, changed.observation)).includes('route_tool_mismatch'));
});

test('denied, unknown, and declaration-only capability evidence never passes a required capability', () => {
  for (const [status, evidenceKind, expectedCode] of [
    ['denied', 'observed', 'route_capability_denied'],
    ['unknown', 'observed', 'route_capability_unavailable'],
    ['passed', 'declared', 'route_capability_not_observed']
  ]) {
    const { requirements, observation } = fixture();
    observation.capabilities[0].status = status;
    observation.capabilities[0].evidenceKind = evidenceKind;
    assert.ok(codes(evaluateRouteAdmission(requirements, observation)).includes(expectedCode));
  }
});

test('a process receipt without per-capability observations cannot satisfy requirements', () => {
  const { requirements, observation } = fixture();
  observation.capabilities = [];
  observation.processReceipt = { exitCode: 0, receiptDigest: sha256('f') };
  const result = evaluateRouteAdmission(requirements, observation);
  assert.equal(result.eligible, false);
  assert.ok(codes(result).includes('route_evidence_unsupported'));
  assert.ok(codes(result).includes('route_capability_missing'));
});

test('missing receipt identity is not treated as a complete observation', () => {
  const { requirements, observation } = fixture();
  delete observation.receiptId;
  assert.ok(codes(evaluateRouteAdmission(requirements, observation)).includes('route_receipt_missing'));
});

test('changed boundary fingerprints invalidate capability and cleanup evidence', () => {
  const { requirements, observation } = fixture();
  observation.fingerprint = sha256('e');
  const result = evaluateRouteAdmission(requirements, observation);
  assert.equal(result.eligible, false);
  assert.ok(codes(result).includes('route_fingerprint_changed'));
});

test('failed or out-of-bound cleanup blocks the route', () => {
  const failed = fixture();
  failed.observation.cleanup.status = 'failed';
  assert.ok(codes(evaluateRouteAdmission(failed.requirements, failed.observation)).includes('route_cleanup_failed'));

  const late = fixture();
  late.observation.cleanup.durationMs = 1001;
  assert.ok(codes(evaluateRouteAdmission(late.requirements, late.observation)).includes('route_cleanup_unbounded'));
});

test('unsupported route, version, or missing evidence fails closed', () => {
  const unsupported = fixture();
  unsupported.requirements.route.kind = 'other-runtime';
  assert.ok(codes(evaluateRouteAdmission(unsupported.requirements, unsupported.observation)).includes('route_runtime_unsupported'));

  const stale = fixture();
  stale.observation.version = 2;
  assert.ok(codes(evaluateRouteAdmission(stale.requirements, stale.observation)).includes('route_evidence_unsupported'));

  assert.deepEqual(evaluateRouteAdmission(undefined, fixture().observation), { eligible: false, blockers: [{ code: 'route_evidence_missing' }] });
});

test('requirements digest is key-order independent and changes with admission inputs', () => {
  const { requirements } = fixture();
  const reordered = {
    cleanupDeadlineMs: requirements.cleanupDeadlineMs,
    requiredCapabilities: [...requirements.requiredCapabilities],
    fingerprint: requirements.fingerprint,
    tool: { fingerprint: requirements.tool.fingerprint, version: requirements.tool.version, name: requirements.tool.name },
    baseSha: requirements.baseSha,
    role: requirements.role,
    route: { authentication: 'subscription', kind: 'codex' },
    version: requirements.version
  };
  assert.equal(routeRequirementsDigest(reordered), routeRequirementsDigest(requirements));
  assert.notEqual(routeRequirementsDigest({ ...requirements, role: 'review' }), routeRequirementsDigest(requirements));
});
