import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSettlementContract, settlementContractDigest, SQF04_DESIGN_SHA256 } from '../src/settlement-contract.mjs';
const h = char => char.repeat(64);
function fixture() {
  const binding = { project: 'p', ticket: 'SQF04', job: 'j', generation: 1, candidateSha: 'a'.repeat(40), policyDigest: h('a'), operationId: 'worker', requestDigest: h('b') };
  const anchorIdentity = { pid: 123, startTicks: '456', pidNamespace: 'pid:host' };
  const identity = { bootId: 'boot', unitName: 'squire-worker.service', invocationId: 'invocation', controlGroup: '/system.slice/squire-worker.service', cgroupIdentity: 'dev:inode', anchorIdentity };
  const deadlines = { startedAtMs: 10, execByMs: 100, stopByMs: 110, observeByMs: 120, finalCleanupByMs: 130 };
  const scope = { sealDigest: h('c'), operations: [{ operationId: 'worker', requestDigest: h('b'), settlementDigest: h('d') }, { operationId: 'catalog', requestDigest: h('e'), settlementDigest: h('f') }] };
  const requirements = { version: 1, designSha256: SQF04_DESIGN_SHA256, binding, identity, deadlines, scope };
  const receipt = structuredClone({ ...requirements,
    authority: Object.fromEntries(['managerDigest', 'migrationDigest', 'observerDigest', 'anchorDigest', 'pidViewDigest', 'policyDigest', 'launchBarrierDigest'].map(key => [key, h('a')])),
    boundary: { status: 'frozen_anchor_only', type: 'domain', frozen: 1, populated: 1, members: [anchorIdentity], subgroups: [], snapshotDigest: h('d'), observedAtMs: 115, prunedBeforeSnapshot: false },
    directTerminal: { status: 'terminal', operationId: 'worker', terminalDigest: h('e'), observedAtMs: 105 },
    teardown: { status: 'terminal', protocol: 'teardown_only', anchorIdentity, terminalDigest: h('f'), workloadEmptyDigest: h('d'), observedAtMs: 125, prunedBeforeTerminal: false }, launchGate: 'closed' });
  return { requirements, receipt };
}
function nonAdmitting(result) {
  assert.equal(result.admission, 'not_evaluated'); assert.equal(result.settlement, 'not_evaluated'); assert.equal(result.import, 'not_evaluated');
}
test('matching supplied contract is always non-admitting, pure and design-bound', () => {
  const { requirements, receipt } = fixture(); const before = structuredClone({ requirements, receipt });
  const result = compareSettlementContract(requirements, receipt);
  assert.equal(result.status, 'contract_matches'); assert.equal(result.replay, 'unseen'); nonAdmitting(result);
  assert.deepEqual({ requirements, receipt }, before);
  assert.equal(SQF04_DESIGN_SHA256, '46a69d0d60a29b5c85ba774a23ce19c5e17649a0c223fb2036c83b86f8626a1c');
});
const negatives = [
 ['missing authority', r => { delete r.authority.managerDigest; }], ['unknown PID view', r => { r.authority.pidViewDigest = null; }],
 ['missing policy provenance', r => { r.authority.policyDigest = null; }], ['changed policy', r => { r.authority.policyDigest = h('b'); }],
 ['missing launch barrier', r => { r.authority.launchBarrierDigest = null; }], ['missing isolation', r => { r.authority.anchorDigest = null; }],
 ['future version', r => { r.version = 2; }], ['wrong design', r => { r.designSha256 = h('a'); }],
 ['wrong job', r => { r.binding.job = 'other'; }], ['wrong candidate', r => { r.binding.candidateSha = 'b'.repeat(40); }],
 ['wrong boot', r => { r.identity.bootId = 'newboot'; }], ['wrong invocation', r => { r.identity.invocationId = 'other'; }],
 ['wrong cgroup', r => { r.identity.cgroupIdentity = 'new:inode'; }], ['wrong anchor birth', r => { r.boundary.members[0].startTicks = '999'; }],
 ['pruned before snapshot', r => { r.boundary.prunedBeforeSnapshot = true; }], ['boundary missing', r => { r.boundary = null; }],
 ['not frozen', r => { r.boundary.frozen = 0; }], ['threaded domain', r => { r.boundary.type = 'threaded'; }],
 ['raw populated zero is not anchor proof', r => { r.boundary.populated = 0; r.boundary.members = []; }],
 ['unidentified member', r => { r.boundary.members[0].pid = 0; }], ['extra live descendant', r => { r.boundary.members.push({ pid: 124, startTicks: '777', pidNamespace: 'pid:host' }); }],
 ['unexpected subgroup', r => { r.boundary.subgroups.push('child'); }], ['main exit only', r => { r.teardown = null; }],
 ['interrupted teardown', r => { r.teardown.status = 'unknown'; }], ['hard-stop pruning', r => { r.teardown.prunedBeforeTerminal = true; }],
 ['teardown can spawn', r => { r.teardown.protocol = 'normal'; }], ['wrong teardown anchor', r => { r.teardown.anchorIdentity.pid = 999; }],
 ['wrong snapshot reference', r => { r.teardown.workloadEmptyDigest = h('b'); }], ['deadline reset', r => { r.deadlines.execByMs++; }],
 ['snapshot late', r => { r.boundary.observedAtMs = 121; }], ['teardown late', r => { r.teardown.observedAtMs = 131; }],
 ['wrong terminal operation', r => { r.directTerminal.operationId = 'other'; }], ['time reversed', r => { r.teardown.observedAtMs = 114; }],
 ['inventory addition', r => { r.scope.operations.push({ operationId: 'sibling', requestDigest: h('a'), settlementDigest: h('b') }); }],
 ['inventory omission', r => { r.scope.operations.pop(); }], ['inventory duplicate', r => { r.scope.operations.push(r.scope.operations[0]); }],
 ['inventory receipt changed', r => { r.scope.operations[1].settlementDigest = h('a'); }], ['seal changed', r => { r.scope.sealDigest = h('a'); }],
 ['launch gate open', r => { r.launchGate = 'open'; }], ['unsupported field', r => { r.nativeAccepted = true; }],
];
for (const [name, mutate] of negatives) test(name, () => {
  const { requirements, receipt } = fixture(); mutate(receipt);
  const result = compareSettlementContract(requirements, receipt); assert.notEqual(result.status, 'contract_matches'); assert.ok(result.blockers.length); nonAdmitting(result);
});
test('replay classification never imports, mutates a projection or changes accounting', () => {
  const { requirements, receipt } = fixture();
  const projection = { binding: structuredClone(requirements.binding), sealDigest: requirements.scope.sealDigest, receiptDigest: settlementContractDigest(receipt) };
  const before = structuredClone(projection);
  const result = compareSettlementContract(requirements, receipt, projection);
  assert.equal(result.replay, 'same_receipt'); assert.equal(result.status, 'contract_matches'); nonAdmitting(result); assert.deepEqual(projection, before);
  receipt.teardown.terminalDigest = h('b');
  const conflict = compareSettlementContract(requirements, receipt, projection);
  assert.equal(conflict.replay, 'conflicting_receipt'); assert.equal(conflict.status, 'mismatch'); nonAdmitting(conflict);
  assert.deepEqual(projection, before);
});
test('malformed projection and invalid requirements stay unknown', () => {
 const {requirements,receipt}=fixture();
 assert.equal(compareSettlementContract(requirements,receipt,{}).status,'unknown');
 requirements.scope.operations=[]; assert.notEqual(compareSettlementContract(requirements,receipt).status,'contract_matches');
});
test('canonical references are key-order stable; inventory order is irrelevant', () => {
 const {requirements,receipt}=fixture(); receipt.scope.operations.reverse();
 assert.equal(compareSettlementContract(requirements,receipt).status,'contract_matches');
 assert.equal(settlementContractDigest({a:1,b:2}),settlementContractDigest({b:2,a:1}));
});
test('non-JSON, cyclic, future, overdeep and UTF-8 oversized evidence stays unknown', () => {
 const {requirements,receipt}=fixture(); const cyclic={};cyclic.self=cyclic;
 let deep={};for(let i=0;i<34;i++)deep={nested:deep};
 for(const input of [null,[],undefined,cyclic,deep,{x:'界'.repeat(50000)}, {x:NaN}]) {
  const result=compareSettlementContract(requirements,input);assert.equal(result.status,'unknown');nonAdmitting(result);
 }
 assert.equal(settlementContractDigest(cyclic),null);assert.equal(settlementContractDigest({x:'界'.repeat(50000)}),null);
});
