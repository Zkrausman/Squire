/* Read-only GitHub evidence for one already-published PR. Not merge authority.
 * A Squire candidate remains UNVERIFIED until separately bound to the PR head
 * and independently reviewed; this module cannot infer that binding. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { candidateTree } from './candidate-tree.mjs';

const execFileAsync = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const REPO = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
const BRANCH = /^[A-Za-z0-9_.\/-]{1,200}$/;
const ACTIONS_APP_ID = 15368;
const stop = reason => ({ status: 'blocked', reason });

/** Authenticated, bounded, read-only GitHub API transport. No token in argv. */
export async function githubRead(endpoint) {
  const { stdout } = await execFileAsync('gh', ['api', '-X', 'GET', '-H', 'Accept: application/vnd.github+json', endpoint], {
    timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com' },
  });
  return JSON.parse(stdout);
}

function reviewProof(reviews, headSha, author) {
  if (!Array.isArray(reviews) || reviews.length === 100) return 'review_inventory_incomplete';
  const latest = new Map();
  for (const review of reviews) {
    if (!Number.isSafeInteger(review.id) || typeof review.user?.login !== 'string') return 'review_inventory_invalid';
    const key = review.user.login.toLowerCase();
    if (!latest.has(key) || review.id > latest.get(key).id) latest.set(key, review);
  }
  return [...latest.values()].some(review => review.state === 'APPROVED'
    && review.commit_id === headSha && review.user.type === 'User'
    && review.user.login.toLowerCase() !== author.toLowerCase())
    ? null : 'independent_review_unverified';
}

function checksPass(value, sha, required) {
  if (!value || value.total_count !== value.check_runs?.length || !Number.isSafeInteger(value.total_count)
    || value.total_count > 100 || value.total_count < required.length) return false;
  const names = new Set();
  for (const run of value.check_runs) {
    if (typeof run.name !== 'string' || names.has(run.name) || run.head_sha !== sha) return false;
    names.add(run.name);
    if (required.includes(run.name) && (run.app?.id !== ACTIONS_APP_ID || run.app?.slug !== 'github-actions')) return false;
    // A failed, skipped, cancelled, or unfinished check is never a pass.
    if (run.status !== 'completed' || run.conclusion !== 'success') return false;
  }
  return required.every(name => names.has(name));
}

/**
 * Returns evidence only for the exact requested PR head, approved independent
 * GitHub review at that head, passing head and merge checks, and a merge commit
 * currently at the expected base branch tip. Errors and unknowns block.
 * Callers must independently bind candidate patch/test provenance and decide
 * ticket acceptance; this function neither launches nor advances tickets.
 */
export async function inspectSquireDelivery({ runDir, sourceRepo, baseSha, runId, ...github }) {
  try {
    const candidate = await candidateTree({ runDir, sourceRepo, baseSha, runId });
    const result = await inspectGithubDelivery({ ...github, candidateTreeSha: candidate.treeSha });
    return result.status === 'verified_github_evidence'
      ? { ...result, runId, baseSha, patchSha256: candidate.patchSha256 }
      : result;
  } catch { return stop('candidate_binding_unavailable'); }
}

export async function inspectGithubDelivery({ repository, number, headSha, baseBranch, headChecks, mergeChecks, candidateTreeSha, get = githubRead }) {
  if (!REPO.test(repository ?? '') || !Number.isSafeInteger(number) || number < 1
    || !SHA.test(headSha ?? '') || !SHA.test(candidateTreeSha ?? '') || !BRANCH.test(baseBranch ?? '')
    || !Array.isArray(headChecks) || headChecks.length < 1 || headChecks.length > 20
    || !Array.isArray(mergeChecks) || mergeChecks.length < 1 || mergeChecks.length > 20
    || [...headChecks, ...mergeChecks].some(name => typeof name !== 'string' || name.length < 1 || name.length > 120)
    || new Set(headChecks).size !== headChecks.length || new Set(mergeChecks).size !== mergeChecks.length
    || typeof get !== 'function') throw new TypeError('Invalid GitHub delivery policy');
  const prefix = `/repos/${repository}`;
  try {
    const pr = await get(`${prefix}/pulls/${number}`);
    const url = `https://github.com/${repository}/pull/${number}`;
    if (pr?.number !== number || pr.html_url !== url || pr.head?.sha !== headSha
      || pr.head?.repo?.full_name?.toLowerCase() !== repository.toLowerCase()
      || pr.base?.ref !== baseBranch || pr.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase()
      || typeof pr.user?.login !== 'string' || !pr.user.login
      || pr.state !== 'closed' || pr.merged !== true || !SHA.test(pr.merge_commit_sha ?? '')) return stop('pr_identity_or_merge_unverified');
    const mergeSha = pr.merge_commit_sha;
    const [reviews, head, merge, commit, headCommit, branch] = await Promise.all([
      get(`${prefix}/pulls/${number}/reviews?per_page=100`),
      get(`${prefix}/commits/${headSha}/check-runs?per_page=100`),
      get(`${prefix}/commits/${mergeSha}/check-runs?per_page=100`),
      get(`${prefix}/commits/${mergeSha}`),
      get(`${prefix}/commits/${headSha}`),
      get(`${prefix}/git/ref/heads/${encodeURIComponent(baseBranch)}`),
    ]);
    const initialReviewFailure = reviewProof(reviews, headSha, pr.user.login);
    if (initialReviewFailure) return stop(initialReviewFailure);
    if (headCommit?.sha !== headSha || headCommit.commit?.tree?.sha !== candidateTreeSha)
      return stop('candidate_pr_tree_unverified');
    if (!checksPass(head, headSha, headChecks)) return stop('exact_head_checks_unverified');
    if (!checksPass(merge, mergeSha, mergeChecks)) return stop('exact_merge_checks_unverified');
    const mergeCommit = commit?.sha === mergeSha && commit.parents?.length === 2
      && SHA.test(commit.parents[0]?.sha ?? '') && commit.parents[1]?.sha === headSha;
    // Squash merges have one parent. Require the exact reviewed head tree to
    // match the resulting merge tree; otherwise the result is not attributable.
    const squashCommit = commit?.sha === mergeSha && commit.parents?.length === 1
      && SHA.test(commit.parents[0]?.sha ?? '') && SHA.test(commit.commit?.tree?.sha ?? '')
      && headCommit?.sha === headSha && commit.commit.tree.sha === headCommit.commit?.tree?.sha;
    if ((!mergeCommit && !squashCommit) || branch?.object?.sha !== mergeSha)
      return stop('merge_ancestry_or_base_unverified');
    // Re-read the PR after the other requests to reject a changed identity.
    const [again, currentBranch, finalReviews] = await Promise.all([
      get(`${prefix}/pulls/${number}`), get(`${prefix}/git/ref/heads/${encodeURIComponent(baseBranch)}`),
      get(`${prefix}/pulls/${number}/reviews?per_page=100`),
    ]);
    if (again?.head?.sha !== headSha || again?.merge_commit_sha !== mergeSha || again.merged !== true
      || again.html_url !== url || currentBranch?.object?.sha !== mergeSha)
      return stop('pr_changed_during_observation');
    const finalReviewFailure = reviewProof(finalReviews, headSha, pr.user.login);
    if (finalReviewFailure) return stop(finalReviewFailure);
    return { status: 'verified_github_evidence', repository, number, prUrl: url, headSha,
      candidateTreeSha, mergeSha, baseBranch, headChecks: [...headChecks], mergeChecks: [...mergeChecks] };
  } catch { return stop('github_evidence_unavailable'); }
}
