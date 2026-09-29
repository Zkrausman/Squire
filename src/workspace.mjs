import path from 'node:path';
import { realpathSync } from 'node:fs';
import { mkdir, realpath, access, writeFile } from 'node:fs/promises';
import { Blocker, digest, isSha } from './contracts.mjs';
import { runProcess } from './process.mjs';

export class GitWorkspace {
  constructor(root) { this.root = root; this.hooks = path.join(root, 'empty-hooks'); }
  async git(cwd, argv, signal) {
    await mkdir(this.hooks, { recursive: true });
    const result = await runProcess({ argv: ['git', '-c', `core.hooksPath=${this.hooks}`, '-c', 'commit.gpgSign=false', '-c', 'credential.interactive=false', ...argv], cwd,
      directory: path.join(this.root, 'git-logs'), timeoutSeconds: 120, signal,
      env: { GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Squire', GIT_AUTHOR_EMAIL: 'squire@localhost', GIT_COMMITTER_NAME: 'Squire', GIT_COMMITTER_EMAIL: 'squire@localhost' } });
    if (result.exitCode !== 0 || result.stopped || result.outputExceeded) throw new Blocker('git_failed', `Git ${argv[0]} failed`, { receipt: { ...result, stdout: undefined, stderr: undefined }, stderr: result.stderr.slice(-4000) });
    return result.stdout.trim();
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
    await this.git(this.root, ['clone', '--quiet', '--no-hardlinks', '--no-checkout', '--', service.source, directory], signal);
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
  async assertCandidate(ticket, signal) {
    const current = await this.identity(ticket.workspace, signal);
    if (current.headSha !== ticket.headSha || current.treeSha !== ticket.treeSha || current.dirty) throw new Blocker('candidate_changed', 'Candidate changed after checkpoint; verification/review must restart', current);
    return current;
  }
  async checkpoint(ticket, service, signal) {
    const head = await this.git(ticket.workspace, ['rev-parse', 'HEAD'], signal);
    if (head !== ticket.beforeAgentHead) throw new Blocker('agent_changed_history', 'Agent committed or changed HEAD; controller owns candidate history');
    await this.git(ticket.workspace, ['add', '-A'], signal);
    const files = (await this.git(ticket.workspace, ['diff', '--cached', '--name-only', '-z', ticket.baseSha], signal)).split('\0').filter(Boolean);
    if (files.some(file => service.protectedPaths.some(p => { const root = p.replace(/\/+$/, ''); return file === root || file.startsWith(`${root}/`); }))) throw new Blocker('protected_path', 'Candidate modifies a protected policy path', { files });
    // Submodules are not an allowed escape from review/test coverage.
    if ((await this.git(ticket.workspace, ['diff', '--cached', '--raw', ticket.baseSha], signal)).includes('160000')) throw new Blocker('submodule_change', 'Submodule changes require a separately authorized project');
    const change = await this.git(ticket.workspace, ['diff', '--cached', '--name-only'], signal);
    if (!change) throw new Blocker('no_candidate', 'Agent produced no change; ticket is not silently marked shipped');
    await this.git(ticket.workspace, ['commit', '-m', `${ticket.spec.id}: ${ticket.spec.title}`], signal);
    const identity = await this.identity(ticket.workspace, signal);
    return { headSha: identity.headSha, treeSha: identity.treeSha, files };
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
    try { await access(directory); }
    catch { await this.git(this.root, ['clone', '--quiet', '--no-hardlinks', '--no-checkout', '--', service.source, directory], signal); }
    await this.git(directory, ['fetch', '--no-tags', 'origin', service.branch], signal);
    await this.git(directory, ['checkout', '--detach', mergeSha], signal);
    const identity = await this.identity(directory, signal);
    if (identity.headSha !== mergeSha || identity.dirty) throw new Blocker('merge_identity', 'Unable to materialize exact delivered commit');
    return identity;
  }
}
