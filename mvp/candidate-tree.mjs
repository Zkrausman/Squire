/* Derive the exact candidate tree without editing the source or retained run.
 * A temporary, no-checkout clone is the only Git object writer. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
async function git(args) {
  const { stdout } = await execFileAsync('git', args, { timeout: 120_000, maxBuffer: 128 * 1024,
    windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return stdout.trim();
}

/** Verify a persisted terminal Squire patch, then apply it in an isolated index. */
export async function candidateTree({ runDir, sourceRepo, baseSha, runId }) {
  if (![runDir, sourceRepo].every(value => typeof value === 'string' && path.isAbsolute(value))
    || !SHA.test(baseSha ?? '') || typeof runId !== 'string' || !/^squire-[a-z0-9-]{1,80}$/.test(runId))
    throw new TypeError('Invalid candidate identity');
  const resolvedRun = await realpath(runDir);
  const resolvedSource = await realpath(sourceRepo);
  if (resolvedRun === resolvedSource || resolvedRun.startsWith(`${resolvedSource}${path.sep}`))
    throw new Error('Candidate run must be outside source repository');
  const stateFile = path.join(resolvedRun, 'state.json');
  const stateInfo = await lstat(stateFile);
  if (!stateInfo.isFile() || stateInfo.size > 64 * 1024) throw new Error('Candidate state unavailable');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  if (state.runId !== runId || await realpath(state.directory) !== resolvedRun
    || await realpath(state.sourceRepo) !== resolvedSource || state.baseSha !== baseSha
    || state.phase !== 'candidate' || state.candidate?.status !== 'UNVERIFIED'
    || state.candidate?.patch !== 'candidate.patch' || state.candidate?.worktree !== 'candidate')
    throw new Error('Candidate state identity mismatch');
  const patch = path.join(resolvedRun, 'candidate.patch');
  const patchInfo = await lstat(patch);
  if (!patchInfo.isFile() || patchInfo.size === 0 || patchInfo.size > 32 * 1024 * 1024)
    throw new Error('Candidate patch unavailable or unbounded');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(patch)) digest.update(chunk);
  const patchSha256 = digest.digest('hex');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'squire-candidate-tree-'));
  try {
    await git(['clone', '--quiet', '--no-checkout', '--no-hardlinks', '--', resolvedSource, temp]);
    if (await git(['-C', temp, 'rev-parse', '--verify', `${baseSha}^{commit}`]) !== baseSha)
      throw new Error('Candidate base commit unavailable');
    await git(['-C', temp, 'read-tree', baseSha]);
    await git(['-C', temp, 'apply', '--cached', '--binary', '--', patch]);
    const treeSha = await git(['-C', temp, 'write-tree']);
    if (!SHA.test(treeSha)) throw new Error('Candidate tree unavailable');
    // The run's patch is retained evidence: reject edits while computing its tree.
    const final = createHash('sha256');
    for await (const chunk of createReadStream(patch)) final.update(chunk);
    if (final.digest('hex') !== patchSha256) throw new Error('Candidate patch changed during inspection');
    return { runId, baseSha, patchSha256, treeSha };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
