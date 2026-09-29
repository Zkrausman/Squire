import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubDelivery } from '../src/delivery.mjs';
const H = 'a'.repeat(40), B = 'b'.repeat(40), T = 'c'.repeat(40), M = 'd'.repeat(40);
const service = { source: 'https://github.com/owner/repo', branch: 'main', delivery: { kind: 'github', repository: 'owner/repo', requiredChecks: [{ name: 'test', appId: 15368 }], mergeMethod: 'squash' } };
const ticket = { headSha: H, baseSha: B, treeSha: T, branch: 'squire/project/task', publication: { number: 1 } };
test('test-merge checks require exact reviewed base, head and tree', async () => {
  const options = { mergeCandidate: true, pr: { merge_commit_sha: M, base: { sha: B, ref: 'main', repo: { full_name: 'owner/repo' } } }, checks: [{ id: 10, name: 'test', app: { id: 15368 }, head_sha: M, status: 'completed', conclusion: 'success' }] };
  assert.equal((await fake(options).delivery.inspect(ticket, service)).state, 'ready');
  assert.equal((await fake({ ...options, parent: H }).delivery.inspect(ticket, service)).state, 'base_moved');
  assert.equal((await fake({ ...options, tree: B }).delivery.inspect(ticket, service)).state, 'base_moved');
});
function fake(options = {}) {
  const requests = [];
  const pr = { number: 1, state: 'open', merged: false, head: { sha: H, ref: ticket.branch }, base: { ref: 'main', repo: { full_name: 'owner/repo' } }, mergeable: true, mergeable_state: 'clean', ...options.pr };
  const workspace = { root: '.', remoteHead: async () => options.base ?? B };
  const client = { api: async (endpoint, method = 'GET', body) => {
    requests.push({ endpoint, method, body });
    if (endpoint === 'repos/owner/repo') return { permissions: { push: true }, allow_squash_merge: true };
    if (endpoint.endsWith('/protection')) return { enforce_admins: { enabled: !options.adminBypass }, required_status_checks: { strict: !options.loose, checks: [{ context: 'test', app_id: 15368 }] } };
    if (endpoint.includes('/rules/branches/')) return options.queue ? [{ type: 'merge_queue' }] : [];
    if (endpoint.endsWith('/merge')) { if (options.mergeError) throw options.mergeError; pr.merged = true; pr.merge_commit_sha = M; return { merged: true, sha: M }; }
    if (endpoint.includes('/git/commits/')) return { sha: M, tree: { sha: options.tree ?? T }, parents: options.mergeCandidate ? [{ sha: options.parent ?? B }, { sha: H }] : [{ sha: options.parent ?? B }] };
    if (endpoint.includes('/pulls/')) return pr;
    throw new Error(`Unexpected ${endpoint}`);
  }, pages: async endpoint => endpoint.includes('check-runs') ? (options.headChecks && endpoint.includes(H) ? options.headChecks : options.checks ?? [{ id: 10, name: 'test', app: { id: 15368 }, head_sha: H, status: 'completed', conclusion: 'success' }]) : [] };
  return { delivery: new GitHubDelivery(workspace, client), requests, pr };
}
test('GitHub fails closed on wrong head, absent checks, skipped checks and spoofed app', async () => {
  await assert.rejects(() => fake({ pr: { head: { sha: B, ref: ticket.branch } } }).delivery.inspect(ticket, service), e => e.code === 'publication_identity');
  assert.equal((await fake({ checks: [] }).delivery.inspect(ticket, service)).state, 'pending');
  assert.equal((await fake({ checks: [{ id: 10, name: 'test', app: { id: 15368 }, head_sha: H, status: 'completed', conclusion: 'skipped' }] }).delivery.inspect(ticket, service)).state, 'failed');
  assert.equal((await fake({ checks: [{ id: 10, name: 'test', app: { id: 999 }, head_sha: H, status: 'completed', conclusion: 'success' }] }).delivery.inspect(ticket, service)).state, 'pending');
});
test('GitHub requires strict server policy, including administrators, and never bypasses queue', async () => {
  for (const options of [{ loose: true }, { adminBypass: true }, { queue: true }]) await assert.rejects(() => fake(options).delivery.preflight(service), e => e.code === 'github_policy');
  assert.equal((await fake().delivery.preflight(service)).protected, true);
});
test('merge pins exact head and verifies merged tree AND reviewed base ancestry', async () => {
  const f = fake(); const merged = await f.delivery.merge(ticket, service);
  assert.equal(merged.mergeSha, M); assert.equal(f.requests.find(r => r.method === 'PUT').body.sha, H);
  assert.equal((await fake({ base: M }).delivery.merge(ticket, service)).state, 'base_moved');
  await assert.rejects(() => fake({ tree: B }).delivery.merge(ticket, service), e => e.code === 'merge_identity');
  await assert.rejects(() => fake({ parent: M }).delivery.merge(ticket, service), e => e.code === 'merge_identity');
});
test('already-merged PR reconciles without another merge request', async () => {
  const f = fake({ pr: { state: 'closed', merged: true, merge_commit_sha: M } });
  assert.equal((await f.delivery.merge(ticket, service)).mergeSha, M); assert.equal(f.requests.filter(r => r.method === 'PUT').length, 0);
});
test('optional merge checks do not suppress required head checks; required merge failure takes precedence', async () => {
  const options = { mergeCandidate: true, pr: { merge_commit_sha: M }, headChecks: [{ id: 10, name: 'test', app: { id: 15368 }, head_sha: H, status: 'completed', conclusion: 'success' }], checks: [{ id: 20, name: 'optional', app: { id: 15368 }, head_sha: M, status: 'completed', conclusion: 'success' }] };
  assert.equal((await fake(options).delivery.inspect(ticket, service)).state, 'ready');
  assert.equal((await fake({ ...options, checks: [{ ...options.checks[0], name: 'test', conclusion: 'failure' }] }).delivery.inspect(ticket, service)).state, 'failed');
});
