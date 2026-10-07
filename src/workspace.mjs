import path from 'node:path';
import { realpathSync } from 'node:fs';
import { mkdir, realpath, access, writeFile } from 'node:fs/promises';
import { Blocker, digest, isSha, pathIsOwned } from './contracts.mjs';
import { runProcess } from './process.mjs';
import { newCandidateCheckpointId } from './candidate-journal.mjs';
import { producerContext } from './producer-context.mjs';

export class GitWorkspace {
  constructor(root) { this.root = root; this.hooks = path.join(root, 'empty-hooks'); }
  async git(cwd, argv, signal, env = {}) {
    await mkdir(this.hooks, { recursive: true });
    const result = await runProcess({ argv: ['git', '-c', `core.hooksPath=${this.hooks}`, '-c', 'commit.gpgSign=false', '-c', 'credential.interactive=false', ...argv], cwd,
      directory: path.join(this.root, 'git-logs'), timeoutSeconds: 120, signal,
      env: { GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Squire', GIT_AUTHOR_EMAIL: 'squire@localhost', GIT_COMMITTER_NAME: 'Squire', GIT_COMMITTER_EMAIL: 'squire@localhost', ...env } });
    if (result.exitCode !== 0 || result.stopped || result.outputExceeded) throw new Blocker('git_failed', `Git ${argv[0]} failed`, { receipt: { ...result, stdout: undefined, stderr: undefined }, stderr: result.stderr.slice(-4000) });
    return result.stdout.replace(/\r?\n$/, '');
  }
  async localAutocrlf(directory, signal) {
    try { return (await this.git(directory, ['config', '--local', '--get', 'core.autocrlf'], signal)).toLowerCase(); }
    catch (error) { if (error.code === 'git_failed') return null; throw error; }
  }
  async localEol(directory, signal) {
    try { return (await this.git(directory, ['config', '--local', '--get', 'core.eol'], signal)).toLowerCase(); }
    catch (error) { if (error.code === 'git_failed') return null; throw error; }
  }
  async normalizeCleanCheckout(directory, expectedHead, expectedTree, signal, before = undefined) {
    const current = before ?? await this.identity(directory, signal);
    if (current.headSha !== expectedHead || current.treeSha !== expectedTree || current.dirty) {
      throw new Blocker('checkout_normalization_blocked', 'Only the exact clean managed checkout can be normalized', current);
    }
    if ((await this.localAutocrlf(directory, signal)) === 'false' && (await this.localEol(directory, signal)) === 'lf') return { ...current, normalized: false };
    await this.git(directory, ['config', '--local', 'core.autocrlf', 'false'], signal);
    await this.git(directory, ['config', '--local', 'core.eol', 'lf'], signal);
    await this.git(directory, ['reset', '--hard', expectedHead], signal);
    // reset may keep a CRLF worktree file when Git considers it equivalent to
    // the index blob. Force tracked paths to materialize using the canonical
    // settings, after the clean exact-head precondition has been established.
    // Recreate the clean index to discard cached stat/conversion information;
    // otherwise even --force may keep a previously normalized CRLF file.
    await this.git(directory, ['read-tree', '--empty'], signal);
    await this.git(directory, ['read-tree', expectedHead], signal);
    await this.git(directory, ['checkout-index', '--force', '--all'], signal);
    const normalized = await this.identity(directory, signal);
    if (normalized.headSha !== expectedHead || normalized.treeSha !== expectedTree || normalized.dirty) {
      throw new Blocker('checkout_normalization_failed', 'Checkout normalization changed candidate identity or left a dirty worktree', normalized);
    }
    return { ...normalized, normalized: true };
  }
  key(service) { const source = path.isAbsolute(service.source) ? realpathSync(service.source) : service.source.replace(/\.git$/, ''); return digest(`${source.toLowerCase()}#${service.branch}`); }
  async preflight(service, signal) {
    await this.git(this.root, ['check-ref-format', `refs/heads/${service.branch}`], signal);
    if (service.delivery.kind === 'local') {
      const bare = await this.git(this.root, ['--git-dir', service.source, 'rev-parse', '--is-bare-repository'], signal);
      if (bare !== 'true') throw new Blocker('unsafe_local_delivery', 'Local delivery requires a bare repository; owner checkouts are never updated.');
    }
    return this.remoteHead(service, signal);
  }
  async remoteHead(service, signal) {
    const lines = await this.git(this.root, ['ls-remote', '--refs', '--', service.source, `refs/heads/${service.branch}`], signal);
    const match = lines.split('\n').filter(l => l.endsWith(`\trefs/heads/${service.branch}`));
    if (match.length !== 1 || !isSha(match[0].split('\t')[0])) throw new Blocker('base_unavailable', `Base ${service.branch} unavailable`);
    return match[0].split('\t')[0];
  }
  async prepare(service, directory, branch, signal) {
    await mkdir(path.dirname(directory), { recursive: true });
    await this.git(this.root, ['clone', '--config', 'core.autocrlf=false', '--config', 'core.eol=lf', '--quiet', '--no-hardlinks', '--no-checkout', '--', service.source, directory], signal);
    await this.git(directory, ['config', '--local', 'core.autocrlf', 'false'], signal);
    await this.git(directory, ['config', '--local', 'core.eol', 'lf'], signal);
    await this.git(directory, ['fetch', '--no-tags', 'origin', service.branch], signal);
    const baseSha = await this.git(directory, ['rev-parse', 'FETCH_HEAD'], signal);
    if (!isSha(baseSha)) throw new Blocker('base_unavailable', 'Expected SHA-1 Git repository');
    await this.git(directory, ['switch', '-c', branch, baseSha], signal);
    await this.assertDirectory(directory); return { directory, baseSha, branch };
  }
  async assertDirectory(directory) {
    const actual = await realpath(directory), root = await realpath(this.root);
    if (!actual.startsWith(`${root}${path.sep}`)) throw new Blocker('workspace_escape', 'Workspace resolved outside project state root');
  }
  async identity(directory, signal) {
    await this.assertDirectory(directory);
    const headSha = await this.git(directory, ['rev-parse', 'HEAD'], signal);
    const treeSha = await this.git(directory, ['rev-parse', 'HEAD^{tree}'], signal);
    const dirty = await this.git(directory, ['status', '--porcelain=v1', '--untracked-files=all'], signal);
    return { headSha, treeSha, dirty };
  }
  async repositoryIdentity(directory, signal) {
    await this.assertDirectory(directory);
    return { topLevel: await this.git(directory, ['rev-parse', '--show-toplevel'], signal),
      gitDir: await this.git(directory, ['rev-parse', '--absolute-git-dir'], signal) };
  }
  async assertCandidate(ticket, signal) {
    const current = await this.identity(ticket.workspace, signal);
    if (current.headSha !== ticket.headSha || current.treeSha !== ticket.treeSha || current.dirty) throw new Blocker('candidate_changed', 'Candidate changed after checkpoint; verification/review must restart', current);
    return this.normalizeCleanCheckout(ticket.workspace, ticket.headSha, ticket.treeSha, signal, current);
  }
  async checkpoint(ticket, service, signal, journal) {
    const context = producerContext();
    const identityBlocker = message => {
      if (context?.lifecycle) context.lifecycle.persistenceFailed = true;
      return new Blocker('candidate_checkpoint_identity', message);
    };
    if (!journal?.store || !context || context.store !== journal.store || context.scopeId !== journal.scopeId ||
        context.project !== journal.projectId || typeof journal.policyDigest !== 'string' ||
        typeof journal.purpose !== 'string') throw identityBlocker('A matching durable producer and candidate journal are required');
    const head = await this.git(ticket.workspace, ['rev-parse', 'HEAD'], signal);
    if (head !== ticket.beforeAgentHead) {
      if (context.lifecycle) context.lifecycle.persistenceFailed = true;
      throw new Blocker('agent_changed_history', 'Agent committed or changed HEAD; controller owns candidate history');
    }
    const branchRef = await this.git(ticket.workspace, ['symbolic-ref', '--quiet', 'HEAD'], signal);
    if (!branchRef.startsWith('refs/heads/') || branchRef !== `refs/heads/${ticket.branch}` ||
        await this.git(ticket.workspace, ['rev-parse', '--verify', branchRef], signal) !== head) {
      throw identityBlocker('Workspace must remain on its exact managed branch and parent');
    }
    const workspaceRoot = await realpath(ticket.workspace);
    const repository = await this.repositoryIdentity(ticket.workspace, signal);
    const repositoryRoot = await realpath(repository.topLevel);
    const gitDir = await realpath(repository.gitDir);
    const gitRelative = path.relative(workspaceRoot, gitDir);
    if (path.resolve(ticket.workspace) !== workspaceRoot || repositoryRoot !== workspaceRoot || !gitRelative || gitRelative === '..' || gitRelative.startsWith(`..${path.sep}`) || path.isAbsolute(gitRelative)) {
      throw identityBlocker('Workspace must use its own managed Git directory');
    }
    await this.git(ticket.workspace, ['add', '-A'], signal);
    const files = (await this.git(ticket.workspace, ['diff', '--cached', '--no-renames', '--name-only', '-z', ticket.baseSha], signal)).split('\0').filter(Boolean);
    if (files.some(file => service.protectedPaths.some(p => { const root = p.replace(/\/+$/, ''); return file === root || file.startsWith(`${root}/`); }))) throw new Blocker('protected_path', 'Candidate modifies a protected policy path', { files });
    if (ticket.spec.execution && files.some(file => !pathIsOwned(file, ticket.spec.execution.ownedPaths))) throw new Blocker('scope_escape', 'Candidate modifies files outside the immutable execution slice ownership', { files, ownedPaths: ticket.spec.execution.ownedPaths });
    // Submodules are not an allowed escape from review/test coverage.
    if ((await this.git(ticket.workspace, ['diff', '--cached', '--raw', ticket.baseSha], signal)).includes('160000')) throw new Blocker('submodule_change', 'Submodule changes require a separately authorized project');
    const change = await this.git(ticket.workspace, ['diff', '--cached', '--no-renames', '--name-only'], signal);
    if (!change) throw new Blocker('no_candidate', 'Agent produced no change; ticket is not silently marked shipped');
    const treeSha = await this.git(ticket.workspace, ['write-tree'], signal);
    if (!isSha(treeSha)) throw identityBlocker('Git did not return a valid staged tree identity');
    const createdAt = Date.now(), frozenDate = `@${Math.floor(createdAt / 1000)} +0000`;
    const commitSha = await this.git(ticket.workspace, ['commit-tree', treeSha, '-p', head, '-m', `${ticket.spec.id}: ${ticket.spec.title}`], signal,
      { GIT_AUTHOR_DATE: frozenDate, GIT_COMMITTER_DATE: frozenDate });
    if (!isSha(commitSha) || await this.git(ticket.workspace, ['rev-parse', `${commitSha}^{tree}`], signal) !== treeSha ||
        await this.git(ticket.workspace, ['rev-parse', `${commitSha}^`], signal) !== head) {
      throw identityBlocker('Prepared commit does not match the exact parent and staged tree');
    }
    const operationId = newCandidateCheckpointId();
    try {
      journal.store.prepareCandidateCheckpoint({ id: operationId, projectId: journal.projectId, ticketId: ticket.spec.id,
        scopeId: journal.scopeId, purpose: journal.purpose, workspace: ticket.workspace, gitDir, generation: ticket.generation,
        branchRef, baseSha: ticket.baseSha, parentSha: head, treeSha, commitSha, policyDigest: journal.policyDigest,
        jobId: journal.jobId ?? null, recoveryId: journal.recoveryId ?? null, files, createdAt });
    } catch (error) {
      if (error.code === 'candidate_checkpoint_identity') throw error;
      throw new Blocker('candidate_checkpoint_intent_failed', 'Candidate intent could not be recorded; branch ref was not changed', { cause: error.message });
    }
    try {
      const beforeRefUpdate = await this.identity(ticket.workspace, signal);
      const currentRepository = await this.repositoryIdentity(ticket.workspace, signal);
      const stagedTree = await this.git(ticket.workspace, ['write-tree'], signal);
      const currentBranch = await this.git(ticket.workspace, ['symbolic-ref', '--quiet', 'HEAD'], signal);
      const currentRef = currentBranch === branchRef ? await this.git(ticket.workspace, ['rev-parse', '--verify', branchRef], signal) : null;
      const unstaged = await this.git(ticket.workspace, ['diff', '--name-only'], signal);
      const untracked = await this.git(ticket.workspace, ['ls-files', '--others', '--exclude-standard'], signal);
      const stagedFiles = (await this.git(ticket.workspace, ['diff', '--cached', '--no-renames', '--name-only', '-z', ticket.baseSha], signal)).split('\0').filter(Boolean);
      if (currentRef !== head) throw new Blocker('candidate_ref_conflict', 'Candidate branch changed after its durable intent; producer remains fenced', { operationId });
      if (path.resolve(currentRepository.topLevel) !== workspaceRoot || path.resolve(currentRepository.gitDir) !== gitDir || beforeRefUpdate.headSha !== head ||
          beforeRefUpdate.treeSha !== (await this.git(ticket.workspace, ['rev-parse', `${head}^{tree}`], signal)) ||
          stagedTree !== treeSha || unstaged || untracked ||
          JSON.stringify(stagedFiles) !== JSON.stringify(files)) {
        throw new Blocker('candidate_checkpoint_identity', 'Workspace, index, branch or candidate paths changed after intent; producer remains fenced', { operationId });
      }
      try {
        await this.git(ticket.workspace, ['--git-dir', gitDir, '--work-tree', workspaceRoot, 'update-ref', branchRef, commitSha, head], signal);
      } catch {
        throw new Blocker('candidate_ref_conflict', 'Candidate branch changed after its durable intent; producer remains fenced', { operationId });
      }
      const identity = await this.identity(ticket.workspace, signal);
      const updatedRepository = await this.repositoryIdentity(ticket.workspace, signal);
      if (path.resolve(updatedRepository.topLevel) !== workspaceRoot || path.resolve(updatedRepository.gitDir) !== gitDir ||
          identity.headSha !== commitSha || identity.treeSha !== treeSha || identity.dirty) {
        throw new Blocker('candidate_checkpoint_identity', `Branch ref did not settle at the prepared candidate; producer remains fenced (${operationId})`);
      }
      return { headSha: identity.headSha, treeSha: identity.treeSha, files, operationId, parentSha: head, branchRef };
    } catch (error) {
      if (context.lifecycle) context.lifecycle.persistenceFailed = true;
      if (['candidate_checkpoint_identity', 'candidate_ref_conflict'].includes(error.code)) throw error;
      throw new Blocker('candidate_checkpoint_unresolved', 'Candidate intent is durable but ref or workspace settlement is unresolved; producer remains fenced', { operationId, cause: error.code ?? 'workspace_failure' });
    }
  }
  async refresh(ticket, service, signal) {
    await this.assertCandidate(ticket, signal);
    await this.git(ticket.workspace, ['fetch', '--no-tags', 'origin', service.branch], signal);
    const baseSha = await this.git(ticket.workspace, ['rev-parse', 'FETCH_HEAD'], signal);
    try { await this.git(ticket.workspace, ['rebase', '--onto', baseSha, ticket.baseSha], signal); }
    catch (e) { await this.git(ticket.workspace, ['rebase', '--abort']).catch(() => {}); throw new Blocker('rebase_conflict', 'New base conflicts with the candidate; explicit conflict repair is required', { cause: e.detail }); }
    const identity = await this.identity(ticket.workspace, signal);
    return { baseSha, headSha: identity.headSha, treeSha: identity.treeSha };
  }
  async conflictWorkspace(ticket, service, directory, signal) {
    const patch = await this.git(ticket.workspace, ['diff', '--binary', ticket.baseSha, ticket.headSha], signal);
    const patchFile = path.join(this.root, `${ticket.spec.id}-${ticket.headSha}.patch`);
    await writeFile(patchFile, `${patch}\n`, { mode: 0o600 });
    const prepared = await this.prepare(service, directory, ticket.branch, signal);
    try { await this.git(directory, ['apply', '--3way', '--index', '--', patchFile], signal); }
    catch (error) {
      // A three-way conflict is expected repair input, not successful application.
      const unmerged = await this.git(directory, ['ls-files', '--unmerged'], signal);
      if (!unmerged) throw new Blocker('patch_failed', 'Candidate could not be staged on updated base', { cause: error.detail, patchFile });
    }
    return { ...prepared, patchFile };
  }
  async mergeWorkspace(service, mergeSha, directory, signal) {
    await mkdir(path.dirname(directory), { recursive: true });
    let exists = true;
    try { await access(directory); }
    catch { exists = false; }
    if (exists) {
      const current = await this.identity(directory, signal);
      if (current.headSha !== mergeSha || current.dirty) throw new Blocker('merge_workspace_dirty', 'Existing delivered checkout is not the exact clean merge candidate', current);
      const treeSha = await this.git(directory, ['rev-parse', `${mergeSha}^{tree}`], signal);
      await this.normalizeCleanCheckout(directory, mergeSha, treeSha, signal, current);
    } else {
      await this.git(this.root, ['clone', '--config', 'core.autocrlf=false', '--config', 'core.eol=lf', '--quiet', '--no-hardlinks', '--no-checkout', '--', service.source, directory], signal);
      await this.git(directory, ['config', '--local', 'core.autocrlf', 'false'], signal);
      await this.git(directory, ['config', '--local', 'core.eol', 'lf'], signal);
    }
    await this.git(directory, ['fetch', '--no-tags', 'origin', service.branch], signal);
    await this.git(directory, ['checkout', '--detach', mergeSha], signal);
    const identity = await this.identity(directory, signal);
    if (identity.headSha !== mergeSha || identity.dirty) throw new Blocker('merge_identity', 'Unable to materialize exact delivered commit');
    return identity;
  }
}
