import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { digest } from '../src/contracts.mjs';
import { withProducer } from '../src/producer-context.mjs';
import { recordDeliveryEvidence, readDeliveryEvidence } from '../src/delivery-evidence.mjs';
import { GitHubDelivery } from '../src/delivery.mjs';
const H = 'a'.repeat(40), B = 'b'.repeat(40), T = 'c'.repeat(40), M = 'd'.repeat(40);
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'sqf06-'));
  const root = path.join(directory, 'projects', 'project'); await mkdir(root, { recursive: true });
  const service = { branch: 'main', delivery: { kind: 'github', repository: 'owner/repo', mergeMethod: 'squash', requiredChecks: [{ name: 'test', appId: 1 }] } };
  const config = { id: 'project', services: { app: service }, tickets: [{ id: 'task', service: 'app', title: 'Task', description: 'Offline', acceptance: ['works'] }] };
  const f = { directory, root, service, store: new Store(directory) };
  t.after(async () => { f.store.close(); await rm(directory, { recursive: true, force: true }); });
  f.store.initialize(config);
  f.store.update('project', s => Object.assign(s.tickets[0], { headSha: H, baseSha: B, treeSha: T, generation: 1, branch: 'squire/project/task', projectId: 'project', publication: { number: 1 } }));
  const lease = f.store.lease('controller:project');
  f.scope = f.store.beginProducer('project', 'ticket:task', lease);
  f.ticket = () => f.store.get('project').tickets[0];
  f.run = fn => withProducer({ store: f.store, project: 'project', scopeId: f.scope }, fn);
  f.record = fact => f.run(() => recordDeliveryEvidence(root, f.ticket(), service, fact));
  f.file = ref => path.join(root, 'delivery-evidence', ref.scopeId, ref.file);
  f.reopen = () => { f.store.close(); f.store = new Store(directory); };
  const pr = { number: 1, html_url: 'https://github.com/owner/repo/pull/1', state: 'open', merged: false, head: { sha: H, ref: f.ticket().branch }, base: { sha: B, ref: 'main', repo: { full_name: 'owner/repo' } }, mergeable: true, mergeable_state: 'clean' };
  f.pr = pr; f.check = { id: 10, name: 'test', app: { id: 1 }, head_sha: H, status: 'completed', conclusion: 'success' }; f.calls = [];
  f.client = { pages: async endpoint => endpoint.includes('check-runs') ? [f.check] : f.prExists ? [pr] : [], api: async (endpoint, method = 'GET') => {
    f.calls.push({ endpoint, method });
    if (method === 'POST') { f.prExists = true; if (f.losePR) throw Error('response lost'); return pr; }
    if (method === 'PUT') { pr.merged = true; pr.state = 'closed'; pr.merge_commit_sha = M; if (f.loseMerge) throw Error('response lost'); return { merged: true, sha: M }; }
    if (endpoint.includes('/git/commits/')) return { sha: M, tree: { sha: T }, parents: [{ sha: B }] };
    if (endpoint.includes('/pulls/')) return pr;
    if (endpoint.endsWith('/protection')) return { enforce_admins: { enabled: true }, required_status_checks: { strict: true, checks: [{ context: 'test', app_id: 1 }] } };
    if (endpoint.includes('/rules/')) return [];
    return { permissions: { push: true }, allow_squash_merge: true };
  } };
  f.delivery = new GitHubDelivery({ root, assertCandidate: async () => {}, git: async () => `${H}\trefs/heads/${pr.head.ref}`, remoteHead: async () => B }, f.client);
  return f;
}

test('receipt chain survives reopen and read-only resolution never mutates or spends', async t => {
  const f = await fixture(t), first = await f.record({ kind: 'publication.intent' });
  const second = await f.record({ kind: 'merge.intent', number: 1 }); f.reopen();
  const before = { state: f.store.get('project'), events: f.store.events('project') };
  const receipt = await readDeliveryEvidence(f.root, second, { headSha: H, policyDigest: digest(before.state.config), scopeId: f.scope });
  assert.deepEqual(receipt.previous, first);
  assert.equal((await readDeliveryEvidence(f.root, first)).fact.kind, 'publication.intent');
  assert.deepEqual({ state: f.store.get('project'), events: f.store.events('project') }, before);
  assert.equal(before.state.agentCalls, 0);
  assert.throws(() => f.store.beginProducer('project', 'ticket:task', f.store.lease('other')), { code: 'producer_unresolved' });
});

test('missing, corrupt, wrong candidate/policy/scope and symlink references refuse', async t => {
  const f = await fixture(t), ref = await f.record({ kind: 'publication.intent' });
  for (const expected of [{ headSha: B }, { policyDigest: digest('wrong') }, { scopeId: 'wrong' }]) await assert.rejects(readDeliveryEvidence(f.root, ref, expected), { code: 'delivery_evidence_incomplete' });
  const bytes = await readFile(f.file(ref)); await writeFile(f.file(ref), Buffer.alloc(bytes.length));
  await assert.rejects(readDeliveryEvidence(f.root, ref), { code: 'delivery_evidence_incomplete' });
  await unlink(f.file(ref)); await assert.rejects(readDeliveryEvidence(f.root, ref), { code: 'delivery_evidence_incomplete' });
  const outside = path.join(f.directory, 'outside'); await mkdir(outside); await writeFile(path.join(outside, ref.file), bytes);
  const scopeDirectory = path.dirname(f.file(ref)); await rm(scopeDirectory, { recursive: true });
  await symlink(outside, scopeDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readDeliveryEvidence(f.root, ref), { code: 'delivery_evidence_incomplete' });
});

test('failed projection retains immutable artifact, rolls back reference/event and fences closure', async t => {
  const f = await fixture(t);
  f.store.db.exec("CREATE TRIGGER fail_delivery BEFORE INSERT ON events WHEN json_extract(NEW.data,'$.type')='delivery.observed' BEGIN SELECT RAISE(ABORT,'injected'); END");
  await f.run(async () => {
    await assert.rejects(recordDeliveryEvidence(f.root, f.ticket(), f.service, { kind: 'publication.intent' }), { code: 'delivery_evidence_incomplete' });
    assert.throws(() => f.store.update('project', () => {}, 'done', {}, f.scope), { code: 'producer_unresolved' });
  });
  assert.equal(f.ticket().deliveryEvidence, undefined); f.reopen();
  assert.throws(() => f.store.assertProducerScopesClear('project'), { code: 'producer_unresolved' });
  assert.equal(f.store.events('project').filter(e => e.type === 'delivery.observed').length, 0);
});

test('wrong producer lane or changed durable candidate blocks recording before remote mutation', async t => {
  const f = await fixture(t), stale = f.ticket();
  f.store.update('project', s => { s.tickets[0].headSha = B; });
  await f.run(() => assert.rejects(f.delivery.publish(stale, f.service), { code: 'delivery_evidence_incomplete' }));
  assert.equal(f.calls.length, 0);
  const other = f.store.beginProducer('project', 'other', f.store.lease('independent'));
  await withProducer({ store: f.store, project: 'project', scopeId: other }, () => assert.rejects(recordDeliveryEvidence(f.root, f.ticket(), f.service, { kind: 'publication.intent' }), { code: 'delivery_evidence_incomplete' }));
});

for (const [label, change, expected] of [
  ['success', {}, 'ready'], ['skipped', { conclusion: 'skipped' }, 'failed'], ['not run', { status: 'queued', conclusion: null }, 'pending'], ['wrong app', { app: { id: 2 } }, 'pending'], ['wrong head', { head_sha: B }, 'pending']
]) test(`durable selected check preserves ${label} gate`, async t => {
  const f = await fixture(t); Object.assign(f.check, change);
  const result = await f.run(() => f.delivery.inspect(f.ticket(), f.service)); assert.equal(result.state, expected);
  const receipt = await readDeliveryEvidence(f.root, f.ticket().deliveryEvidence);
  assert.equal(receipt.fact.kind, 'ci.selected');
  assert.equal(receipt.fact.selected?.id ?? null, ['wrong app', 'wrong head'].includes(label) ? null : 10);
});

test('lost publication response resolves the unique exact PR without another POST', async t => {
  const f = await fixture(t); f.losePR = true;
  await f.run(() => assert.rejects(f.delivery.publish(f.ticket(), f.service), /response lost/));
  const published = await f.run(() => f.delivery.publish(f.ticket(), f.service));
  assert.equal(published.headSha, H); assert.equal(f.calls.filter(c => c.method === 'POST').length, 1);
  assert.equal((await readDeliveryEvidence(f.root, f.ticket().deliveryEvidence)).fact.kind, 'publication.observed');
});

test('lost merge response resolves exact ancestry without a second PUT and retains intents', async t => {
  const f = await fixture(t); f.loseMerge = true;
  const result = await f.run(() => f.delivery.merge(f.ticket(), f.service));
  assert.equal(result.mergeSha, M); assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
  let ref = f.ticket().deliveryEvidence, kinds = [];
  while (ref) { const value = await readDeliveryEvidence(f.root, ref); kinds.push(value.fact.kind); ref = value.previous; }
  assert.ok(kinds.includes('merge.intent')); assert.equal(kinds[0], 'merge.verified');
  assert.equal((await f.run(() => f.delivery.merge(f.ticket(), f.service))).mergeSha, M);
  assert.equal(f.calls.filter(c => c.method === 'PUT').length, 1);
});

test('already merged publication requires verified tree and preserves normal publication shape', async t => {
  const f = await fixture(t); f.prExists = true; Object.assign(f.pr, { state: 'closed', merged: true, merge_commit_sha: M });
  assert.equal((await f.run(() => f.delivery.publish(f.ticket(), f.service))).number, 1);
  assert.equal((await readDeliveryEvidence(f.root, f.ticket().deliveryEvidence)).fact.kind, 'merge.verified');
  assert.equal(f.calls.filter(c => c.method !== 'GET').length, 0);
});

for (const passed of [true, false]) test(`controller records postmerge ${passed ? 'success' : 'failure'} before its existing gate`, async t => {
  const { Controller } = await import('../src/controller.mjs');
  const f = await fixture(t);
  f.store.update('project', s => { s.tickets[0].status = 'postmerge'; s.tickets[0].mergeSha = M; });
  // Exercise the production postmerge consumer with offline workspace/verifier
  // seams; admission is outside this fixture and never dispatches a worker.
  const controller = Object.assign(Object.create(Controller.prototype), {
    store: f.store, id: 'project', root: f.root, config: f.store.get('project').config,
    deliveryFactory: () => f.delivery, assertActive: async () => {}, ensureTicketPreparation: async () => {},
    workspace: { mergeWorkspace: async () => ({ treeSha: T }), identity: async () => ({ headSha: M, treeSha: T, dirty: false }) },
    verifier: { setup: async () => {}, run: async () => ({ passed, results: [{ name: 'test', status: passed ? 'passed' : 'failed', exitCode: passed ? 0 : 1 }] }) }
  });
  await f.run(() => controller.produceStep('task'));
  assert.equal(f.ticket().status, passed ? 'shipped' : 'blocked');
  assert.equal((await readDeliveryEvidence(f.root, f.ticket().deliveryEvidence)).fact.passed, passed);
  assert.equal(f.store.get('project').agentCalls, 0);
});
