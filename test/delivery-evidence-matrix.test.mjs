import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient, GitHubDelivery } from '../src/delivery.mjs';

const H = 'a'.repeat(40), B = 'b'.repeat(40), T = 'c'.repeat(40), M = 'd'.repeat(40), S = 'e'.repeat(40);
const prefix = 'repos/owner/repo';
const requiredChecks = [{ name: 'linux', appId: 15368 }, { name: 'windows', appId: 15368 }];
const service = { branch: 'main', delivery: { repository: 'owner/repo', requiredChecks, mergeMethod: 'squash' } };
const ticket = { headSha: H, baseSha: B, treeSha: T, branch: 'squire/project/task', publication: { number: 1 } };
const run = (name, sha = H, overrides = {}) => ({ id: 10, name, app: { id: 15368 }, head_sha: sha, status: 'completed', conclusion: 'success', ...overrides });
const pageUrl = (endpoint, page) => `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`;

// Only api is replaced: every pagination call exercises the production paginator.
// Unexpected requests fail immediately, including any accidental mutation.
function scriptedClient(steps) {
  const client = new GitHubClient('.');
  const requests = [];
  client.api = async (endpoint, method = 'GET', body) => {
    const actual = { endpoint, method, body };
    requests.push(actual);
    const step = steps[requests.length - 1];
    assert.ok(step, `Unexpected request ${method} ${endpoint}`);
    assert.deepEqual(actual, { endpoint: step.endpoint, method: step.method ?? 'GET', body: step.body });
    if (step.error) throw step.error;
    return structuredClone(step.result);
  };
  return { client, requests, done: () => assert.equal(requests.length, steps.length) };
}

test('pages preserves order, query parameters, and partial or empty termination', async () => {
  for (const field of [undefined, 'check_runs']) {
    for (const tail of [[], [{ id: 100 }]]) {
      const endpoint = field ? `${prefix}/commits/${H}/check-runs?filter=all` : `${prefix}/pulls`;
      const first = Array.from({ length: 100 }, (_, id) => ({ id }));
      const wrap = values => field ? { [field]: values } : values;
      const f = scriptedClient([first, tail].map((values, i) => ({ endpoint: pageUrl(endpoint, i + 1), result: wrap(values) })));
      assert.deepEqual(await f.client.pages(endpoint, field), [...first, ...tail]);
      f.done();
    }
    const f = scriptedClient([{ endpoint: pageUrl('empty', 1), result: field ? { [field]: [] } : [] }]);
    assert.deepEqual(await f.client.pages('empty', field), []);
    f.done();
  }
});

test('pages rejects malformed later pages and propagates API failures without returning partial evidence', async () => {
  for (const field of [undefined, 'check_runs']) {
    for (const malformed of [null, {}, { check_runs: null }, { check_runs: 'invalid' }]) {
      const full = Array.from({ length: 100 }, (_, id) => ({ id }));
      const f = scriptedClient([
        { endpoint: pageUrl('evidence', 1), result: field ? { [field]: full } : full },
        { endpoint: pageUrl('evidence', 2), result: malformed }
      ]);
      await assert.rejects(f.client.pages('evidence', field), { code: 'github_result' });
      f.done();
    }
  }
  const error = new Error('offline fixture transport loss');
  const f = scriptedClient([{ endpoint: pageUrl('evidence', 1), result: Array(100).fill({}) }, { endpoint: pageUrl('evidence', 2), error }]);
  await assert.rejects(f.client.pages('evidence'), e => e === error);
  f.done();
});

test('pages accepts a partial twentieth page but rejects twenty full pages without a twenty-first request', async () => {
  for (const lastSize of [99, 100]) {
    const steps = Array.from({ length: 20 }, (_, i) => ({ endpoint: pageUrl('bounded', i + 1), result: Array.from({ length: i === 19 ? lastSize : 100 }, (_, j) => i * 100 + j) }));
    const f = scriptedClient(steps);
    if (lastSize === 100) await assert.rejects(f.client.pages('bounded'), { code: 'github_result', message: 'GitHub evidence exceeds pagination bound' });
    else assert.deepEqual(await f.client.pages('bounded'), Array.from({ length: 1999 }, (_, i) => i));
    f.done();
  }
});

const pull = (overrides = {}) => ({ state: 'open', merged: false, head: { sha: H, ref: ticket.branch }, base: { sha: B, ref: 'main', repo: { full_name: 'owner/repo' } }, mergeable: true, mergeable_state: 'clean', ...overrides });
const getPull = result => ({ endpoint: `${prefix}/pulls/1`, result });
const commit = (sha = M, parents = [B, H], overrides = {}) => ({ sha, tree: { sha: T }, parents: parents.map(sha => ({ sha })), ...overrides });
const getCommit = (sha, result) => ({ endpoint: `${prefix}/git/commits/${sha}`, result });
const checkPages = (sha, pages) => pages.map((check_runs, i) => ({ endpoint: pageUrl(`${prefix}/commits/${sha}/check-runs`, i + 1), result: { check_runs } }));
const policy = () => [
  { endpoint: prefix, result: { permissions: { push: true }, allow_squash_merge: true } },
  { endpoint: `${prefix}/branches/main/protection`, result: { enforce_admins: { enabled: true }, required_status_checks: { strict: true, checks: requiredChecks.map(c => ({ context: c.name, app_id: c.appId })) } } },
  { endpoint: `${prefix}/rules/branches/main`, result: [] }
];
function fixture(steps) {
  const f = scriptedClient(steps);
  let remoteReads = 0;
  const delivery = new GitHubDelivery({ root: '.', remoteHead: async () => { remoteReads++; return B; } }, f.client);
  return { ...f, delivery, remoteReads: () => remoteReads };
}

test('latest reruns on either evidence commit block merge even when older success is on the first page', async () => {
  for (const sha of [H, M]) {
    for (const newest of [{ status: 'completed', conclusion: 'failure' }, { status: 'in_progress', conclusion: null }]) {
      const first = [run('linux', sha), run('windows', sha), ...Array.from({ length: 98 }, (_, i) => run(`optional-${i}`, sha))];
      const rerun = run('windows', sha, { id: 20, ...newest });
      const pr = pull(sha === M ? { merge_commit_sha: M } : {});
      const steps = [getPull(pr), ...policy(), getPull(pr), ...checkPages(H, sha === H ? [first, [rerun]] : [[run('linux'), run('windows')]])];
      if (sha === M) steps.push(...checkPages(M, [first, [rerun]]), getCommit(M, commit()));
      const f = fixture(steps);
      assert.deepEqual(await f.delivery.merge(ticket, service), newest.status === 'completed' ? { state: 'failed', reason: 'windows: failure', checkUrl: undefined } : { state: 'pending', reason: 'Waiting for windows' });
      assert.equal(f.requests.filter(r => r.method === 'PUT').length, 0);
      assert.equal(f.remoteReads(), 1);
      f.done();
    }
  }
});

test('mixed required check sets use verified merge evidence per check and exact head fallback', async () => {
  const cases = [
    { head: [run('windows')], merge: [run('linux', M)], state: 'ready' },
    { head: [run('windows')], merge: [run('linux', M), run('optional', M)], state: 'ready' },
    { head: [run('windows', H, { head_sha: S })], merge: [run('linux', M)], state: 'pending' },
    { head: [run('windows', H, { app: { id: 999 } })], merge: [run('linux', M)], state: 'pending' },
    { head: [], merge: [run('linux', M)], state: 'pending' },
    { head: [run('windows')], merge: [run('linux', M), run('windows', M, { conclusion: 'failure' })], state: 'failed' },
    { head: [run('windows')], merge: [run('linux', M), run('windows', M, { status: 'queued', conclusion: null })], state: 'pending' },
    { head: [run('windows')], merge: [run('linux', M), run('windows', M, { app: { id: 999 }, conclusion: 'failure' })], state: 'ready' }
  ];
  for (const c of cases) {
    const f = fixture([getPull(pull({ merge_commit_sha: M })), ...checkPages(H, [c.head]), ...checkPages(M, [c.merge]), getCommit(M, commit())]);
    assert.equal((await f.delivery.inspect(ticket, service)).state, c.state);
    assert.equal(f.remoteReads(), 0);
    f.done();
  }
});

test('synthetic merge evidence rejects mismatched commit identity, tree and ordered parents', async () => {
  for (const candidate of [commit(S), commit(M, [H, B]), commit(M, [B]), commit(M, [B, H, S]), commit(M, [B, H], { tree: { sha: S } })]) {
    const f = fixture([getPull(pull({ merge_commit_sha: M })), ...checkPages(H, [[run('linux'), run('windows')]]), ...checkPages(M, [[run('linux', M)]]), getCommit(M, candidate)]);
    assert.deepEqual(await f.delivery.inspect(ticket, service), { state: 'base_moved' });
    f.done();
  }
});

test('lost merge response reconciles verified merged commit and repeated calls never issue another PUT', async () => {
  const error = new Error('merge response lost');
  const merged = pull({ state: 'closed', merged: true, merge_commit_sha: S });
  const result = commit(S, [B]);
  const f = fixture([
    getPull(pull()), ...policy(), getPull(pull()), ...checkPages(H, [[run('linux'), run('windows')]]),
    { endpoint: `${prefix}/pulls/1/merge`, method: 'PUT', body: { sha: H, merge_method: 'squash' }, error },
    getPull(merged), getCommit(S, result), getPull(merged), getCommit(S, result)
  ]);
  for (let attempt = 0; attempt < 2; attempt++) assert.deepEqual(await f.delivery.merge(ticket, service), { mergeSha: S, treeSha: T });
  assert.equal(f.requests.filter(r => r.method === 'PUT').length, 1);
  assert.equal(f.remoteReads(), 1);
  f.done();
});

test('lost response cannot bless an unverified merged commit or retry an unconfirmed mutation', async () => {
  for (const outcome of ['open', 'wrong-sha', 'wrong-tree', 'wrong-parent']) {
    const error = new Error('merge response lost');
    const steps = [getPull(pull()), ...policy(), getPull(pull()), ...checkPages(H, [[run('linux'), run('windows')]]),
      { endpoint: `${prefix}/pulls/1/merge`, method: 'PUT', body: { sha: H, merge_method: 'squash' }, error }];
    if (outcome === 'open') steps.push(getPull(pull()));
    else steps.push(getPull(pull({ state: 'closed', merged: true, merge_commit_sha: S })), getCommit(S,
      outcome === 'wrong-sha' ? commit(M, [B]) : outcome === 'wrong-tree' ? commit(S, [B], { tree: { sha: M } }) : commit(S, [H])));
    const f = fixture(steps);
    await assert.rejects(f.delivery.merge(ticket, service), e => outcome === 'open' ? e === error : e.code === 'merge_identity');
    assert.equal(f.requests.filter(r => r.method === 'PUT').length, 1);
    assert.equal(f.remoteReads(), outcome === 'open' ? 2 : 1);
    f.done();
  }
});
