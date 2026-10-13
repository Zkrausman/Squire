import test from './standalone.mjs';
import assert from 'node:assert/strict';
import { evaluateRouteAdmission, routeRequirementsDigest, buildWorkerPolicyIntent, compareWorkerPolicyMapping } from '../src/route-admission.mjs';

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


function mappingFixture() {
  const intent = buildWorkerPolicyIntent({ role: 'implement', workspace: '/fixture/workspace', directory: '/fixture/job', command: ['codex'], platform: 'linux' });
  const binding = { project: 'p', ticket: 't', job: 'j', generation: 1, role: 'implement', source: 'fixture-source', baseSha: sha1, headSha: sha1, treeSha: sha1, workspace: intent.workspace, workspaceClean: true };
  const tool = { version: '0.160.0', executableSha256: sha256('b'), releaseSourceSha: sha1 };
  const expected = { version: 1, binding, tool, workerProducerId: 'worker-producer', helperProducerId: 'helper-producer' };
  const worker = { version: 1, intentDigest: routeRequirementsDigest(intent), binding: structuredClone(binding), tool: structuredClone(tool), producer: { id: 'worker-producer', operationId: 'worker-op', receiptDigest: sha256('c') },
    loader: { ignoreUserConfig: true, ignoreProjectConfig: false, ignoreRules: false, layersDigest: sha256('d'), requirementsDigest: sha256('e'), projectLayersDigest: sha256('f'), execpolicyDigest: sha256('1') },
    state: { permissionProfile: { type: 'managed', file_system: { type: 'restricted', entries: [{ path: { type: 'special', value: { kind: 'root' } }, access: 'read' }, { path: { type: 'path', path: 'file:///fixture/workspace/.git' }, access: 'deny', missing_path_behavior: 'skip' }] }, network: 'restricted' }, sandboxCwd: 'file:///fixture/workspace', codexLinuxSandboxExe: '/fixture/codex', useLegacyLandlock: false },
    environment: { policyDigest: sha256('2'), inheritedDigest: sha256('3'), overrides: structuredClone(intent.env) },
    network: { configurationDigest: sha256('4'), requirementsDigest: sha256('5'), caRoots: [] }, backend: { platform: 'linux', helperSha256: sha256('6') }, transformations: [] };
  const helper = structuredClone(worker); helper.producer = { ...worker.producer, id: 'helper-producer', operationId: 'helper-op' };
  return { intent, expected, worker, helper };
}
const compare = f => compareWorkerPolicyMapping(f.intent, f.expected, f.worker, f.helper);

test('complete synthetic mapping matches content only and never grants admission or parity', () => {
  const result = compare(mappingFixture());
  assert.deepEqual(result, { state: 'mapping_matches', admission: 'not_evaluated', missing: [], mismatches: [] });
  for (const key of ['eligible', 'dispatch', 'parity', 'capability', 'cleanup']) assert.equal(Object.hasOwn(result, key), false);
});

test('mapping requires complete provenance even when intent and raw state match', () => {
  for (const field of ['producer', 'loader', 'environment', 'network', 'backend']) {
    const f = mappingFixture(); delete f.helper[field]; assert.equal(compare(f).state, 'unknown', field);
  }
  for (const field of ['projectLayersDigest', 'execpolicyDigest', 'requirementsDigest']) {
    const f = mappingFixture(); delete f.worker.loader[field]; assert.equal(compare(f).state, 'unknown', field);
  }
  const f = mappingFixture(); f.worker.network.configurationDigest = null; f.helper.network.configurationDigest = null;
  assert.equal(compare(f).state, 'unknown');
  assert.equal(compareWorkerPolicyMapping(f.intent, undefined, f.worker, f.helper).state, 'unknown');
});

test('mapping refuses wrong identities, stale generations, producer, tools and environment', () => {
  for (const change of [
    f => { f.helper.binding.role = 'review'; }, f => { f.helper.binding.source = 'other'; },
    f => { f.helper.binding.baseSha = 'e'.repeat(40); }, f => { f.helper.binding.treeSha = 'e'.repeat(40); },
    f => { f.helper.binding.generation++; }, f => { f.helper.binding.workspace = '/other'; },
    f => { f.helper.tool.executableSha256 = sha256('e'); }, f => { f.helper.tool.releaseSourceSha = 'e'.repeat(40); },
    f => { f.helper.producer.id = 'unrecognized'; }, f => { f.helper.environment.inheritedDigest = sha256('e'); },
    f => { f.helper.environment.overrides.TMPDIR = '/other'; }
  ]) { const f = mappingFixture(); change(f); assert.equal(compare(f).state, 'mismatch'); }
  const f = mappingFixture(); f.helper.tool.version = '0.161.0'; assert.equal(compare(f).state, 'unknown');
});

test('opaque policy rules retain order, deny entries, missing-path behavior and backend', () => {
  for (const change of [
    f => { f.helper.state.permissionProfile.file_system.entries.reverse(); },
    f => { f.helper.state.permissionProfile.file_system.entries.pop(); },
    f => { delete f.helper.state.permissionProfile.file_system.entries[1].missing_path_behavior; },
    f => { f.helper.state.permissionProfile.file_system.entries[0].path.value.kind = 'project_roots'; },
    f => { f.helper.state.useLegacyLandlock = true; }, f => { f.helper.backend.helperSha256 = sha256('e'); },
    f => { f.helper.network.caRoots = ['/fixture/ca']; }, f => { f.helper.network.requirementsDigest = sha256('e'); },
    f => { f.helper.loader.layersDigest = sha256('e'); }
  ]) { const f = mappingFixture(); change(f); assert.equal(compare(f).state, 'mismatch'); }
});

test('unsupported, transformed, inferred or malformed state stays unknown', () => {
  for (const change of [
    f => { f.helper.state.permissionProfile = { type: 'external', network: 'restricted' }; },
    f => { f.helper.state.permissionProfile = { type: 'disabled' }; },
    f => { f.helper.transformations = ['external-to-read-only']; },
    f => { delete f.helper.state.useLegacyLandlock; }, f => { f.helper.state.permissionProfile.file_system = {}; },
    f => { f.helper.state.sandboxCwd = '/fixture/../workspace'; },
    f => { f.worker.binding.workspaceClean = false; }, f => { f.helper.extra = 'unsupported'; },
    f => { f.intent.env.TMPDIR = '/other'; }, f => { f.helper.state.permissionProfile.self = f.helper.state.permissionProfile; }
  ]) { const f = mappingFixture(); change(f); assert.equal(compare(f).state, 'unknown'); }
});


test('missing selector payloads, unsupported special paths and malformed rule shapes stay unknown', () => {
  for (const selector of [{ type: 'path' }, { type: 'glob_pattern' }, { type: 'special' }, { type: 'special', value: {} },
    { type: 'special', value: { kind: 'unknown', path: ':future' } }, { type: 'path', path: 'relative' },
    { type: 'glob_pattern', pattern: '' }]) {
    const f = mappingFixture(); f.worker.state.permissionProfile.file_system.entries[1].path = selector;
    f.helper.state = structuredClone(f.worker.state); assert.equal(compare(f).state, 'unknown');
  }
  const glob = mappingFixture(); glob.worker.state.permissionProfile.file_system.entries[1].path = { type: 'glob_pattern', pattern: '/fixture/**/private' };
  glob.helper.state = structuredClone(glob.worker.state); assert.equal(compare(glob).state, 'mapping_matches');
  glob.helper.state.permissionProfile.file_system.entries[1].path.pattern = '/fixture/**/other'; assert.equal(compare(glob).state, 'mismatch');
  const f = mappingFixture(); f.worker.state.permissionProfile.file_system.entries[1].missing_path_behavior = 'error';
  f.helper.state = structuredClone(f.worker.state); assert.equal(compare(f).state, 'unknown');
});

test('mapping record bound uses UTF-8 bytes for opaque multibyte policy content', () => {
  const f = mappingFixture(); const entries = f.worker.state.permissionProfile.file_system.entries;
  for (let i = 0; i < 16; i++) entries.push({ path: { type: 'glob_pattern', pattern: '/fixture/' + '界'.repeat(3000) + i }, access: 'deny' });
  f.helper.state = structuredClone(f.worker.state);
  assert.ok(JSON.stringify(f.worker).length < 128 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(f.worker), 'utf8') > 128 * 1024);
  assert.equal(compare(f).state, 'unknown');
});
