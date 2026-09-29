import path from 'node:path';
import { Blocker, isSha } from './contracts.mjs';
import { runProcess } from './process.mjs';

export class GitHubClient {
  constructor(root) { this.root = root; }
  async api(endpoint, method = 'GET', body) {
    const argv = ['gh', 'api', '--hostname', 'github.com', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28', '--method', method, endpoint];
    if (body !== undefined) argv.push('--input', '-');
    const result = await runProcess({ argv, cwd: this.root, directory: path.join(this.root, 'github-logs'), timeoutSeconds: 60, input: body === undefined ? '' : JSON.stringify(body) });
    if (result.exitCode !== 0 || result.stopped || result.outputExceeded) {
      const error = new Blocker('github_unavailable', `GitHub ${method} ${endpoint} failed`, { stderr: result.stderr.slice(-2000) });
      error.httpStatus = Number(/HTTP (\d{3})/.exec(result.stderr)?.[1]); throw error;
    }
    if (!result.stdout.trim()) return null;
    try { return JSON.parse(result.stdout); } catch { throw new Blocker('github_result', 'GitHub returned invalid JSON'); }
  }
  async pages(endpoint, field) {
    const values = [];
    for (let page = 1; page <= 20; page++) {
      const result = await this.api(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const items = field ? result?.[field] : result;
      if (!Array.isArray(items)) throw new Blocker('github_result', 'GitHub pagination result invalid');
      values.push(...items); if (items.length < 100) return values;
    }
    throw new Blocker('github_result', 'GitHub evidence exceeds pagination bound');
  }
}

export class LocalDelivery {
  constructor(workspace) { this.workspace = workspace; }
  async preflight(service) { return this.workspace.preflight(service); }
  async publish(ticket, service, signal) {
    await this.workspace.assertCandidate(ticket, signal);
    const remote = await this.workspace.git(ticket.workspace, ['ls-remote', '--refs', 'origin', `refs/heads/${ticket.branch}`], signal);
    const existingSha = remote.split('\t')[0];
    if (remote && existingSha !== ticket.headSha && existingSha !== ticket.publication?.headSha) throw new Blocker('publication_conflict', 'Local publication branch changed unexpectedly');
    if (existingSha !== ticket.headSha) await this.workspace.git(ticket.workspace, ['push', `--force-with-lease=refs/heads/${ticket.branch}:${remote ? existingSha : ''}`, 'origin', `${ticket.headSha}:refs/heads/${ticket.branch}`], signal);
    return { kind: 'local', branch: ticket.branch, headSha: ticket.headSha };
  }
  async inspect(ticket) { return { state: 'ready', headSha: ticket.headSha }; }
  async merge(ticket, service, signal) {
    const current = await this.workspace.remoteHead(service, signal);
    if (current === ticket.headSha) return { mergeSha: ticket.headSha, treeSha: ticket.treeSha };
    if (current !== ticket.baseSha) return { state: 'base_moved' };
    try { await this.workspace.git(this.workspace.root, ['--git-dir', service.source, 'update-ref', `refs/heads/${service.branch}`, ticket.headSha, ticket.baseSha], signal); }
    catch (e) { if (await this.workspace.remoteHead(service) !== ticket.baseSha) return { state: 'base_moved' }; throw e; }
    return { mergeSha: ticket.headSha, treeSha: ticket.treeSha };
  }
}

export class GitHubDelivery {
  constructor(workspace, client = new GitHubClient(workspace.root)) { this.workspace = workspace; this.client = client; }
  prefix(service) { return `repos/${service.delivery.repository}`; }
  async preflight(service) {
    const prefix = this.prefix(service);
    const repository = await this.client.api(prefix);
    if (repository.archived || repository.disabled || !repository.permissions?.push) throw new Blocker('github_policy', 'GitHub repository must be active and writable');
    let protection;
    try { protection = await this.client.api(`${prefix}/branches/${encodeURIComponent(service.branch)}/protection`); }
    catch (e) { throw new Blocker('github_policy', 'Initial GitHub adapter requires strict branch protection enforced for administrators; rulesets/merge queues need a future adapter capability.', { cause: e.detail }); }
    if (!protection.required_status_checks?.strict || !protection.enforce_admins?.enabled) throw new Blocker('github_policy', 'Require up-to-date status checks and enforce branch protection for administrators');
    const protectedChecks = protection.required_status_checks.checks ?? protection.required_status_checks.contexts?.map(context => ({ context }));
    for (const expected of service.delivery.requiredChecks) if (!protectedChecks?.some(c => c.context === expected.name && (c.app_id == null || c.app_id === expected.appId))) throw new Blocker('github_policy', `Required check ${expected.name} is absent from server branch protection`);
    const method = service.delivery.mergeMethod ?? 'squash';
    if (method === 'squash' && !repository.allow_squash_merge || method === 'merge' && !repository.allow_merge_commit) throw new Blocker('github_policy', `Repository does not permit ${method} merges`);
    // A mandatory merge queue cannot be driven by the synchronous merge endpoint.
    const rules = await this.client.api(`${prefix}/rules/branches/${encodeURIComponent(service.branch)}`);
    if (!Array.isArray(rules) || rules.some(r => r.type === 'merge_queue')) throw new Blocker('github_policy', 'Merge queues are not supported by the initial adapter; it will not bypass one');
    return { protected: true, method };
  }
  async publish(ticket, service, signal) {
    await this.workspace.assertCandidate(ticket, signal);
    const remote = await this.workspace.git(ticket.workspace, ['ls-remote', '--refs', 'origin', `refs/heads/${ticket.branch}`], signal);
    const existingSha = remote.split('\t')[0];
    if (remote && existingSha !== ticket.headSha && existingSha !== ticket.publication?.headSha) throw new Blocker('publication_conflict', 'Stable publication branch has an unexpected head');
    if (existingSha !== ticket.headSha) await this.workspace.git(ticket.workspace, ['push', `--force-with-lease=refs/heads/${ticket.branch}:${remote ? existingSha : ''}`, 'origin', `${ticket.headSha}:refs/heads/${ticket.branch}`], signal);
    const prefix = this.prefix(service), owner = service.delivery.repository.split('/')[0];
    const prs = await this.client.pages(`${prefix}/pulls?state=all&head=${encodeURIComponent(`${owner}:${ticket.branch}`)}&base=${encodeURIComponent(service.branch)}`);
    const matching = prs.filter(pr => pr.head?.ref === ticket.branch && pr.base?.ref === service.branch);
    if (matching.length > 1) throw new Blocker('publication_conflict', 'Multiple PRs match the stable ticket branch');
    let pr = matching[0];
    if (pr && pr.state === 'closed') throw new Blocker('publication_conflict', 'Ticket PR was already closed; reconcile its outcome before retrying publication');
    if (!pr) pr = await this.client.api(`${prefix}/pulls`, 'POST', {
      title: `${ticket.spec.id}: ${ticket.spec.title}`, head: ticket.branch, base: service.branch, draft: false,
      body: `## Result\n\n${ticket.spec.description}\n\n## Acceptance\n\n${ticket.spec.acceptance.map(a => `- ${a}`).join('\n')}\n\nVerified and freshly reviewed by Squire at \`${ticket.headSha}\`.\nProject: ${ticket.projectId}. Controller evidence is retained in its private state directory.`
    });
    if (!Number.isSafeInteger(pr.number) || pr.head?.sha !== ticket.headSha) throw new Blocker('publication_identity', 'Published PR does not match verified candidate');
    return { kind: 'github', number: pr.number, url: pr.html_url, branch: ticket.branch, headSha: ticket.headSha };
  }
  async pull(ticket, service) {
    const pr = await this.client.api(`${this.prefix(service)}/pulls/${ticket.publication.number}`);
    if (pr.head?.sha !== ticket.headSha || pr.head?.ref !== ticket.branch || pr.base?.ref !== service.branch || pr.base?.repo?.full_name?.toLowerCase() !== service.delivery.repository.toLowerCase()) throw new Blocker('publication_identity', 'PR identity changed since verification');
    if (pr.state === 'closed' && !pr.merged) throw new Blocker('publication_closed', 'PR closed without merging');
    return pr;
  }
  async inspect(ticket, service) {
    const pr = await this.pull(ticket, service);
    if (pr.merged) return { state: 'merged', ...await this.verifyMerge(ticket, service, pr.merge_commit_sha) };
    if (pr.base?.sha && pr.base.sha !== ticket.baseSha) return { state: 'base_moved' };
    const checks = await this.client.pages(`${this.prefix(service)}/commits/${ticket.headSha}/check-runs`, 'check_runs');
    let mergeChecks = [];
    if (isSha(pr.merge_commit_sha)) {
      mergeChecks = await this.client.pages(`${this.prefix(service)}/commits/${pr.merge_commit_sha}/check-runs`, 'check_runs');
      if (mergeChecks.length) {
        const candidate = await this.client.api(`${this.prefix(service)}/git/commits/${pr.merge_commit_sha}`);
        if (candidate.sha !== pr.merge_commit_sha || candidate.tree?.sha !== ticket.treeSha || candidate.parents?.length !== 2 || candidate.parents[0].sha !== ticket.baseSha || candidate.parents[1].sha !== ticket.headSha) return { state: 'base_moved' };
      }
    }
    for (const expected of service.delivery.requiredChecks) {
      const matching = (runs, sha) => runs.filter(c => c.name === expected.name && c.app?.id === expected.appId && c.head_sha === sha).sort((a, b) => b.id - a.id);
      const mergeMatches = matching(mergeChecks, pr.merge_commit_sha);
      const matches = mergeMatches.length ? mergeMatches : matching(checks, ticket.headSha);
      const check = matches[0];
      if (!check || check.status !== 'completed') return { state: 'pending', reason: `Waiting for ${expected.name}` };
      if (check.conclusion !== 'success') return { state: 'failed', reason: `${expected.name}: ${check.conclusion}`, checkUrl: check.html_url };
    }
    if (pr.mergeable_state === 'behind') return { state: 'base_moved' };
    if (pr.mergeable === null || pr.mergeable_state === 'unknown') return { state: 'pending', reason: 'GitHub computing mergeability' };
    if (pr.mergeable === false || pr.mergeable_state === 'dirty') throw new Blocker('merge_conflict', 'GitHub reports merge conflict');
    return { state: 'ready', headSha: ticket.headSha };
  }
  async verifyMerge(ticket, service, mergeSha) {
    if (!isSha(mergeSha)) throw new Blocker('merge_identity', 'Merged commit SHA missing');
    const commit = await this.client.api(`${this.prefix(service)}/git/commits/${mergeSha}`);
    const parents = commit.parents?.map(p => p.sha);
    const ancestry = (service.delivery.mergeMethod ?? 'squash') === 'squash' ? parents?.length === 1 && parents[0] === ticket.baseSha : parents?.length === 2 && parents[0] === ticket.baseSha && parents[1] === ticket.headSha;
    if (commit.sha !== mergeSha || commit.tree?.sha !== ticket.treeSha || !ancestry) throw new Blocker('merge_identity', 'Merge tree or ancestry differs from verified candidate/base', { mergeSha, actualTree: commit.tree?.sha });
    return { mergeSha, treeSha: commit.tree.sha };
  }
  async merge(ticket, service, signal) {
    // Reconcile first: previous request may have merged before receipt persistence.
    const pr = await this.pull(ticket, service);
    if (pr.merged) return this.verifyMerge(ticket, service, pr.merge_commit_sha);
    await this.preflight(service);
    if (await this.workspace.remoteHead(service, signal) !== ticket.baseSha) return { state: 'base_moved' };
    const gate = await this.inspect(ticket, service);
    if (gate.state !== 'ready') return gate;
    let response;
    try { response = await this.client.api(`${this.prefix(service)}/pulls/${ticket.publication.number}/merge`, 'PUT', { sha: ticket.headSha, merge_method: service.delivery.mergeMethod ?? 'squash' }); }
    catch (e) {
      const again = await this.pull(ticket, service);
      if (again.merged) return this.verifyMerge(ticket, service, again.merge_commit_sha);
      if (await this.workspace.remoteHead(service, signal) !== ticket.baseSha) return { state: 'base_moved' };
      throw e;
    }
    if (!response.merged) throw new Blocker('merge_rejected', 'GitHub did not confirm merge', response);
    return this.verifyMerge(ticket, service, response.sha);
  }
}
