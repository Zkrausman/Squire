import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { digest, validateConfig } from '../src/contracts.mjs';
import { withProducer } from '../src/producer-context.mjs';
import { GitWorkspace } from '../src/workspace.mjs';

export const git = (cwd, ...argv) => execFileSync('git', ['-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=', ...argv], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost' } }).trim();
export const ticket = (id, dependsOn = [], service = 'app') => ({ id, service, title: `Feature ${id}`, description: `Add independently callable feature ${id}.`, acceptance: ['The feature adds two numeric inputs correctly.'], dependsOn });
export async function fixture(t, specs = [ticket('a')], extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'squire-test-'));
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    const resolved = await realpath(root);
    const relative = path.relative(await realpath(os.tmpdir()), resolved);
    if (path.isAbsolute(relative) || relative.includes(path.sep) || !relative.startsWith('squire-test-')) throw new Error('Unsafe fixture cleanup path');
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const seed = path.join(root, 'seed'), source = path.join(root, 'source.git'), stateDir = path.join(root, 'state');
  await mkdir(seed);
  git(seed, 'init', '-b', 'main'); await writeFile(path.join(seed, 'README.md'), '# Fixture service\n');
  await writeFile(path.join(seed, '.gitignore'), 'node_modules/\n'); git(seed, 'add', '.'); git(seed, 'commit', '-m', 'baseline');
  git(root, 'clone', '--bare', seed, source);
  const check = path.join(root, 'check.mjs');
  await writeFile(check, `import {readdir} from 'node:fs/promises'; import {pathToFileURL} from 'node:url'; import path from 'node:path';
for (const file of (await readdir(process.cwd())).filter(f=>f.startsWith('feature-')&&f.endsWith('.mjs'))) {
 const {add}=await import(pathToFileURL(path.join(process.cwd(),file))); if(add(2,3)!==5 || add(-3,2)!==-1) throw new Error('Incorrect feature '+file);
}`);
  const additions = typeof extra === 'function' ? await extra({ root, seed, source, stateDir, check }) : extra;
  const config = validateConfig({ version: 1, id: 'fixture', stateDir, tickets: specs,
    services: { app: { source, branch: 'main', delivery: { kind: 'local' }, checks: [{ name: 'behavior', argv: [process.execPath, check], timeoutSeconds: 10 }] } },
    limits: { maxParallel: 2, agentTimeoutSeconds: 30, ciTimeoutSeconds: 30, rateLimitBackoffSeconds: 1 }, ...additions });
  const store = new Store(stateDir); store.initialize(config); cleanup.push(() => store.close());
  return { root, seed, source, stateDir, config, store, check, addCleanup: fn => cleanup.push(fn) };
}
export class FixtureRuntime {
  version = 1;
  capabilities = { roles: ['plan', 'implement', 'review'], freshSession: true, subscription: true, artifacts: 'workspace', resume: false };
  calls = []; counts = new Map();
  constructor(handler) { this.handler = handler; }
  async preflight() { return { authentication: 'fixture-not-live' }; }
  async execute(job) {
    this.calls.push({ role: job.role, workspace: job.workspace, instructions: job.instructions, id: job.id });
    const sessionRef = randomUUID(); job.onEvent?.({ version: 1, type: 'thread.started', sessionRef });
    const override = await this.handler?.(job, this, sessionRef);
    if (override) return override;
    if (job.role === 'implement') {
      const id = /\n([\w-]+): Feature/.exec(job.instructions)?.[1];
      const count = (this.counts.get(id) ?? 0) + 1; this.counts.set(id, count);
      await writeFile(path.join(job.workspace, `feature-${id}.mjs`), `export const add = (a,b) => a+b;\n// attempt ${count}\n`);
      return { outcome: 'completed', sessionRef, result: 'Implemented', usage: { input_tokens: 10, output_tokens: 10 } };
    }
    if (job.role === 'review') {
      const headSha = /HEAD ([a-f0-9]{40})/.exec(job.instructions)?.[1];
      return { outcome: 'completed', sessionRef, result: { headSha, verdict: 'pass', summary: 'Fixture review', findings: [] } };
    }
    throw new Error('Fixture planner needs explicit handler');
  }
}
export async function statusUntil(store, controller, status, id = 'a') {
  for (let i = 0; i < 30; i++) {
    if (store.get('fixture').tickets.find(t => t.spec.id === id).status === status) return;
    await controller.step(id);
  }
  throw new Error(`Did not reach ${status}: ${JSON.stringify(store.get('fixture'))}`);
}

// Build a prior candidate through the same durable journal path used by the
// controller. Tests that need an existing candidate must not use raw git commit.
export async function checkpointFixtureCandidate(f, workspace, ticketState, service) {
  const id = f.config.id, ticketId = ticketState.spec.id, jobId = randomUUID();
  const before = await workspace.identity(ticketState.workspace);
  const current = { ...f.store.get(id).tickets.find(item => item.spec.id === ticketId), ...ticketState,
    status: 'implementing', beforeAgentHead: before.headSha, headSha: before.headSha, treeSha: before.treeSha,
    activeJob: jobId, generation: ticketState.generation ?? 1 };
  f.store.update(id, state => { state.tickets.find(item => item.spec.id === ticketId) && Object.assign(state.tickets.find(item => item.spec.id === ticketId), current); });
  const release = f.store.lease(`controller:${id}`);
  try {
    const scopeId = f.store.beginProducer(id, `ticket:${ticketId}`, release, [workspace.key(service)]);
    return await withProducer({ store: f.store, project: id, scopeId }, async () => {
      f.store.reserveProducerCall(scopeId, jobId);
      const candidate = await workspace.checkpoint(current, service, undefined, { store: f.store, projectId: id, scopeId,
        purpose: 'implementation', policyDigest: digest(f.config), jobId, recoveryId: null });
      f.store.update(id, state => {
        const saved = state.tickets.find(item => item.spec.id === ticketId);
        Object.assign(saved, candidate, { candidateCheckpointId: candidate.operationId, status: 'verifying', activeJob: null,
          implementation: { jobId, sessionRef: 'fixture-checkpoint', usage: {} } });
      }, 'ticket.transition', { ticket: ticketId, status: 'verifying' }, null, candidate.operationId);
      f.store.update(id, () => {}, 'producer.completed', { scopeId, lane: `ticket:${ticketId}` }, scopeId);
      return candidate;
    });
  } finally { release(); }
}
