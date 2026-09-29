import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectGithubDelivery } from '../github-delivery-evidence.mjs';

const headSha = 'a'.repeat(40), mergeSha = 'b'.repeat(40), baseSha = 'c'.repeat(40), tree = 'd'.repeat(40);
const policy = { repository: 'owner/project', number: 4, headSha, candidateTreeSha: tree, baseBranch: 'main',
  headChecks: ['Test'], mergeChecks: ['Test'] };
const prefix = '/repos/owner/project';
function fixture() {
  const pr = { number: 4, html_url: 'https://github.com/owner/project/pull/4', state: 'closed', merged: true,
    head: { sha: headSha, repo: { full_name: 'owner/project' } },
    base: { ref: 'main', repo: { full_name: 'owner/project' } }, merge_commit_sha: mergeSha,
    user: { login: 'implementer' } };
  const check = sha => ({ total_count: 1, check_runs: [{ name: 'Test', head_sha: sha, status: 'completed', conclusion: 'success', app: { id: 15368, slug: 'github-actions' } }] });
  return new Map([
    [`${prefix}/pulls/4`, pr],
    [`${prefix}/pulls/4/reviews?per_page=100`, [{ id: 1, state: 'APPROVED', commit_id: headSha, user: { login: 'reviewer', type: 'User' } }]],
    [`${prefix}/commits/${headSha}/check-runs?per_page=100`, check(headSha)],
    [`${prefix}/commits/${mergeSha}/check-runs?per_page=100`, check(mergeSha)],
    [`${prefix}/commits/${mergeSha}`, { sha: mergeSha, parents: [{ sha: baseSha }, { sha: headSha }], commit: { tree: { sha: tree } } }],
    [`${prefix}/commits/${headSha}`, { sha: headSha, commit: { tree: { sha: tree } } }],
    [`${prefix}/git/ref/heads/main`, { object: { sha: mergeSha } }],
  ]);
}
async function inspect(map) { return inspectGithubDelivery({ ...policy, get: async endpoint => {
  if (!map.has(endpoint)) throw Error('missing fixture');
  return map.get(endpoint);
} }); }

test('verified merge commit, independent head review, exact head and merge checks', async () => {
  const result = await inspect(fixture());
  assert.equal(result.status, 'verified_github_evidence');
  assert.equal(result.mergeSha, mergeSha);
});

test('verified squash requires exact reviewed tree equality', async () => {
  const map = fixture();
  map.get(`${prefix}/commits/${mergeSha}`).parents = [{ sha: baseSha }];
  assert.equal((await inspect(map)).status, 'verified_github_evidence');
  map.get(`${prefix}/commits/${mergeSha}`).commit.tree.sha = 'e'.repeat(40);
  assert.equal((await inspect(map)).reason, 'merge_ancestry_or_base_unverified');
});

test('stale, self, or dismissed review cannot pass', async () => {
  const map = fixture();
  const key = `${prefix}/pulls/4/reviews?per_page=100`;
  map.get(key)[0].commit_id = baseSha;
  assert.equal((await inspect(map)).reason, 'independent_review_unverified');
  map.get(key)[0].commit_id = headSha;
  map.get(key)[0].user.login = 'implementer';
  assert.equal((await inspect(map)).reason, 'independent_review_unverified');
  map.get(key)[0].user.login = 'reviewer';
  map.get(key).push({ id: 2, state: 'DISMISSED', commit_id: headSha, user: { login: 'reviewer', type: 'User' } });
  assert.equal((await inspect(map)).reason, 'independent_review_unverified');
});

test('unknown, skipped and wrong-head checks fail closed', async () => {
  const map = fixture();
  const key = `${prefix}/commits/${headSha}/check-runs?per_page=100`;
  map.get(key).check_runs[0].conclusion = 'skipped';
  assert.equal((await inspect(map)).reason, 'exact_head_checks_unverified');
  map.get(key).check_runs[0].conclusion = 'success';
  map.get(key).check_runs[0].head_sha = baseSha;
  assert.equal((await inspect(map)).reason, 'exact_head_checks_unverified');
  map.get(key).check_runs[0].head_sha = headSha;
  map.get(key).check_runs[0].app.id = 999;
  assert.equal((await inspect(map)).reason, 'exact_head_checks_unverified');
  map.delete(key);
  assert.equal((await inspect(map)).reason, 'github_evidence_unavailable');
});

test('PR head tree must equal the independently computed Squire candidate tree', async () => {
  const map = fixture();
  map.get(`${prefix}/commits/${headSha}`).commit.tree.sha = 'e'.repeat(40);
  assert.equal((await inspect(map)).reason, 'candidate_pr_tree_unverified');
});

test('changed PR identity or moved base blocks', async () => {
  const map = fixture();
  map.get(`${prefix}/git/ref/heads/main`).object.sha = baseSha;
  assert.equal((await inspect(map)).reason, 'merge_ancestry_or_base_unverified');
  map.get(`${prefix}/git/ref/heads/main`).object.sha = mergeSha;
  map.get(`${prefix}/pulls/4`).head.sha = baseSha;
  assert.equal((await inspect(map)).reason, 'pr_identity_or_merge_unverified');
});

test('ambiguous review inventory and duplicate check names block', async () => {
  const map = fixture();
  const reviewKey = `${prefix}/pulls/4/reviews?per_page=100`;
  map.set(reviewKey, Array.from({ length: 100 }, (_, id) => ({ id, state: 'APPROVED', commit_id: headSha,
    user: { login: `reviewer${id}`, type: 'User' } })));
  assert.equal((await inspect(map)).reason, 'review_inventory_incomplete');
  map.set(reviewKey, fixture().get(reviewKey));
  const checkKey = `${prefix}/commits/${headSha}/check-runs?per_page=100`;
  map.get(checkKey).check_runs.push({ ...map.get(checkKey).check_runs[0] });
  map.get(checkKey).total_count = 2;
  assert.equal((await inspect(map)).reason, 'exact_head_checks_unverified');
});

test('approval dismissed between observations blocks delivery', async () => {
  const map = fixture();
  let reads = 0;
  const endpoint = `${prefix}/pulls/4/reviews?per_page=100`;
  const result = await inspectGithubDelivery({ ...policy, get: async path => {
    if (path === endpoint && ++reads === 2) return [{ id: 2, state: 'DISMISSED', commit_id: headSha,
      user: { login: 'reviewer', type: 'User' } }];
    return map.get(path);
  } });
  assert.equal(result.reason, 'independent_review_unverified');
});

test('base changing between observation and final recheck blocks', async () => {
  const map = fixture();
  let reads = 0;
  const result = await inspectGithubDelivery({ ...policy, get: async endpoint => {
    if (endpoint === `${prefix}/git/ref/heads/main` && ++reads === 2) return { object: { sha: baseSha } };
    return map.get(endpoint);
  } });
  assert.equal(result.reason, 'pr_changed_during_observation');
});

test('rejects empty or duplicate check policy before network', async () => {
  await assert.rejects(() => inspectGithubDelivery({ ...policy, headChecks: [] }), /policy/);
  await assert.rejects(() => inspectGithubDelivery({ ...policy, mergeChecks: ['Test', 'Test'] }), /policy/);
});
