import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { candidateTree } from '../candidate-tree.mjs';
import { inspectSquireDelivery } from '../github-delivery-evidence.mjs';

function git(dir, ...args) { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim(); }
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'squire-binding-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRepo = path.join(root, 'source');
  const runDir = path.join(root, 'run');
  await mkdir(sourceRepo); await mkdir(runDir);
  git(sourceRepo, 'init', '--quiet');
  git(sourceRepo, 'config', 'user.name', 'Fixture');
  git(sourceRepo, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(path.join(sourceRepo, 'file.txt'), 'original\n');
  git(sourceRepo, 'add', '.'); git(sourceRepo, 'commit', '--quiet', '-m', 'base');
  const baseSha = git(sourceRepo, 'rev-parse', 'HEAD');
  const candidate = path.join(runDir, 'candidate');
  git(root, 'clone', '--quiet', sourceRepo, candidate);
  await writeFile(path.join(candidate, 'file.txt'), 'changed\n');
  await writeFile(path.join(candidate, 'new.txt'), 'untracked\n');
  git(candidate, 'add', '--intent-to-add', '--all');
  await writeFile(path.join(runDir, 'candidate.patch'), execFileSync('git',
    ['-C', candidate, 'diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', baseSha, '--']));
  const runId = 'squire-123-abcdef';
  await writeFile(path.join(runDir, 'state.json'), JSON.stringify({ runId, directory: runDir,
    sourceRepo, baseSha, phase: 'candidate', candidate: { status: 'UNVERIFIED', patch: 'candidate.patch', worktree: 'candidate' } }));
  return { sourceRepo, runDir, baseSha, runId, candidate };
}

test('isolated Git index binds retained patch to an exact tree without changing source', async t => {
  const input = await fixture(t);
  const before = git(input.sourceRepo, 'status', '--porcelain');
  const result = await candidateTree(input);
  assert.match(result.patchSha256, /^[a-f0-9]{64}$/);
  assert.match(result.treeSha, /^[a-f0-9]{40}$/);
  assert.equal(git(input.sourceRepo, 'status', '--porcelain'), before);
  assert.equal(await readFile(path.join(input.sourceRepo, 'file.txt'), 'utf8'), 'original\n');
  const expected = path.join(path.dirname(input.sourceRepo), 'expected');
  git(path.dirname(input.sourceRepo), 'clone', '--quiet', input.sourceRepo, expected);
  await writeFile(path.join(expected, 'file.txt'), 'changed\n');
  await writeFile(path.join(expected, 'new.txt'), 'untracked\n');
  git(expected, 'add', '--all');
  assert.equal(result.treeSha, git(expected, 'write-tree'));
});

test('composite gate binds a real retained patch tree to a mocked reviewed PR', async t => {
  const input = await fixture(t);
  const candidate = await candidateTree(input);
  git(input.candidate, 'add', '--all');
  git(input.candidate, 'config', 'user.name', 'Fixture');
  git(input.candidate, 'config', 'user.email', 'fixture@example.invalid');
  git(input.candidate, 'commit', '--quiet', '-m', 'fixture candidate');
  const headSha = git(input.candidate, 'rev-parse', 'HEAD');
  const mergeSha = 'f'.repeat(40), repo = 'owner/project';
  const pr = { number: 4, html_url: `https://github.com/${repo}/pull/4`, state: 'closed', merged: true,
    head: { sha: headSha, repo: { full_name: repo } }, base: { ref: 'main', repo: { full_name: repo } },
    merge_commit_sha: mergeSha, user: { login: 'author' } };
  const check = sha => ({ total_count: 1, check_runs: [{ name: 'Test', head_sha: sha,
    status: 'completed', conclusion: 'success', app: { id: 15368, slug: 'github-actions' } }] });
  const api = new Map([
    [`/repos/${repo}/pulls/4`, pr],
    [`/repos/${repo}/pulls/4/reviews?per_page=100`, [{ id: 1, state: 'APPROVED', commit_id: headSha,
      user: { login: 'reviewer', type: 'User' } }]],
    [`/repos/${repo}/commits/${headSha}/check-runs?per_page=100`, check(headSha)],
    [`/repos/${repo}/commits/${mergeSha}/check-runs?per_page=100`, check(mergeSha)],
    [`/repos/${repo}/commits/${headSha}`, { sha: headSha, commit: { tree: { sha: candidate.treeSha } } }],
    [`/repos/${repo}/commits/${mergeSha}`, { sha: mergeSha, parents: [{ sha: input.baseSha }, { sha: headSha }],
      commit: { tree: { sha: candidate.treeSha } } }],
    [`/repos/${repo}/git/ref/heads/main`, { object: { sha: mergeSha } }],
  ]);
  const options = { ...input, repository: repo, number: 4, headSha, baseBranch: 'main',
    headChecks: ['Test'], mergeChecks: ['Test'], get: async endpoint => api.get(endpoint) };
  const result = await inspectSquireDelivery(options);
  assert.equal(result.status, 'verified_github_evidence');
  assert.equal(result.patchSha256, candidate.patchSha256);
  api.get(`/repos/${repo}/commits/${headSha}`).commit.tree.sha = 'e'.repeat(40);
  assert.equal((await inspectSquireDelivery(options)).reason, 'candidate_pr_tree_unverified');
});

test('missing, failed, or mismatched retained candidate never binds', async t => {
  const input = await fixture(t);
  const statePath = path.join(input.runDir, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.phase = 'failed';
  await writeFile(statePath, JSON.stringify(state));
  await assert.rejects(() => candidateTree(input), /identity mismatch/);
  const outcome = await inspectSquireDelivery({ ...input, repository: 'owner/project', number: 1,
    headSha: 'a'.repeat(40), baseBranch: 'main', headChecks: ['Test'], mergeChecks: ['Test'],
    get: async () => { throw Error('must not query GitHub'); } });
  assert.equal(outcome.reason, 'candidate_binding_unavailable');
});
