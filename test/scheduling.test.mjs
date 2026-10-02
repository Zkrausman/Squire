import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { Controller } from '../src/controller.mjs';
import { fixture, FixtureRuntime, ticket, git, statusUntil } from './support.mjs';

const execution = id => ({ version: 1, outcome: `Callable feature ${id}`, ownedPaths: [`feature-${id}.mjs`], contextPaths: [], invariants: ['Existing features remain correct'], checklist: [{ id: 'addition', assertion: 'Adds numeric inputs', steps: ['Run behavior check'], evidence: 'behavior check and feature export' }], stopWhen: 'Attempt ceiling reached', maxAttempts: 2 });

test('structured disjoint slices overlap implementation and retain fresh gates after moving base', { timeout: 180000 }, async t => {
  const specs = ['a', 'b'].map(id => ({ ...ticket(id), execution: execution(id) }));
  const f = await fixture(t, specs); let active = 0, max = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const runtime = new FixtureRuntime(async job => {
    if (job.role === 'implement') {
      active++; max = Math.max(max, active); if (active === 2) release();
      let timer; await Promise.race([barrier, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Independent slices did not run concurrently')), 10000); })]).finally(() => clearTimeout(timer));
      active--;
    }
    if (job.role === 'review') return { outcome: 'completed', sessionRef: `review-${job.id}`, result: { headSha: /HEAD ([a-f0-9]{40})/.exec(job.instructions)[1], verdict: 'pass', summary: 'Observed behavior check', findings: [], checklist: [{ id: 'addition', verdict: 'pass', evidence: 'Trusted behavior check passed on feature export' }] } };
  });
  const result = await new Controller(f.store, f.config.id, { runtime }).run();
  assert.equal(max, 2); assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.ok(result.tickets.every(x => x.checklistEvidence.headSha === x.mergeSha && x.review.headSha === x.headSha && x.postmerge.passed));
  const final = git(f.root, '--git-dir', f.source, 'ls-tree', '--name-only', 'main');
  assert.match(final, /feature-a.mjs/); assert.match(final, /feature-b.mjs/);
});

test('structured slice cannot deliver edits outside its declared ownership', { timeout: 90000 }, async t => {
  const f = await fixture(t, [{ ...ticket('a'), execution: execution('b') }]);
  const result = await new Controller(f.store, f.config.id, { runtime: new FixtureRuntime() }).run();
  assert.equal(result.tickets[0].blocker.code, 'scope_escape');
  assert.equal(git(f.root, '--git-dir', f.source, 'rev-list', '--count', 'main'), '1');
});

test('overlapping structured ownership serializes agents', { timeout: 120000 }, async t => {
  const specs = ['a', 'b'].map(id => ({ ...ticket(id), execution: { ...execution(id), ownedPaths: ['feature-a.mjs', 'feature-b.mjs'] } }));
  const f = await fixture(t, specs); let active = 0, max = 0;
  const runtime = new FixtureRuntime(async job => {
    if (job.role === 'implement') { active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 100)); active--; }
    if (job.role === 'review') return { outcome: 'completed', sessionRef: `review-${job.id}`, result: { headSha: /HEAD ([a-f0-9]{40})/.exec(job.instructions)[1], verdict: 'pass', summary: 'Observed behavior', findings: [], checklist: [{ id: 'addition', verdict: 'pass', evidence: 'Behavior check on feature' }] } };
  });
  const result = await new Controller(f.store, f.config.id, { runtime }).run();
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(max, 1);
});

test('slice attempt ceiling blocks narrow failure without stopping an independent slice', { timeout: 120000 }, async t => {
  const specs = ['a', 'b'].map(id => ({ ...ticket(id), execution: { ...execution(id), maxAttempts: 1 } }));
  const f = await fixture(t, specs);
  const runtime = new FixtureRuntime(async job => {
    if (job.role === 'implement' && /\na: Feature/.test(job.instructions)) {
      await writeFile(path.join(job.workspace, 'feature-a.mjs'), 'export const add=(a,b)=>a-b;');
      return { outcome: 'completed', sessionRef: 'bad-slice', result: 'Bad fixture' };
    }
    if (job.role === 'review') return { outcome: 'completed', sessionRef: `review-${job.id}`, result: { headSha: /HEAD ([a-f0-9]{40})/.exec(job.instructions)[1], verdict: 'pass', summary: 'Observed behavior', findings: [], checklist: [{ id: 'addition', verdict: 'pass', evidence: 'Behavior check on feature' }] } };
  });
  const result = await new Controller(f.store, f.config.id, { runtime }).run();
  assert.equal(result.tickets[0].blocker.code, 'slice_budget'); assert.equal(result.tickets[0].attempts, 1);
  assert.equal(result.tickets[1].status, 'shipped');
});

test('independent repositories execute concurrently but services sharing a repository serialize', { timeout: 180000 }, async t => {
  for (const independent of [true, false]) {
    const f = await fixture(t, [ticket('a'), ticket('b', [], 'other')], ({ root, source, check }) => {
      const second = independent ? path.join(root, 'second.git') : source;
      if (independent) git(root, 'clone', '--bare', source, second);
      const service = source => ({ source, branch: 'main', delivery: { kind: 'local' }, checks: [{ name: 'behavior', argv: [process.execPath, check], timeoutSeconds: 10 }] });
      return { services: { app: service(source), other: service(second) } };
    });
    let active = 0, max = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    const runtime = new FixtureRuntime(async job => {
      if (job.role !== 'implement') return;
      active++; max = Math.max(max, active);
      if (independent) {
        if (active === 2) release();
        let timer; await Promise.race([barrier, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected parallel repository worker')), 10000); })]).finally(() => clearTimeout(timer));
      } else await new Promise(resolve => setTimeout(resolve, 50));
      active--;
    });
    const result = await new Controller(f.store, f.config.id, { runtime }).run();
    assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(max, independent ? 2 : 1);
    if (!independent) assert.equal(result.tickets[1].baseSha, result.tickets[0].mergeSha);
  }
});
test('brief planning is durable, subscription capacity waits, then generated tickets run', { timeout: 120000 }, async t => {
  const f = await fixture(t, [], { goal: 'Add one callable arithmetic feature', tickets: undefined }); let limited = true;
  const runtime = new FixtureRuntime(async job => {
    if (job.role === 'plan') {
      if (limited) { limited = false; return { outcome: 'waiting_capacity', retryAt: Date.now() + 60000 }; }
      return { outcome: 'completed', sessionRef: 'planner', result: { tickets: [ticket('a')] } };
    }
  });
  const controller = new Controller(f.store, f.config.id, { runtime });
  const waiting = await controller.run(undefined, { wait: false }); assert.equal(waiting.status, 'waiting_capacity'); assert.equal(waiting.tickets.length, 0);
  f.store.update(f.config.id, state => { state.planRetryAt = 0; });
  const result = await controller.run(); assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.plan.sessionRef, 'planner');
});
test('edits after passing gates block publication; missing review cannot authorize merge', { timeout: 90000 }, async t => {
  const f = await fixture(t), runtime = new FixtureRuntime(), controller = new Controller(f.store, f.config.id, { runtime });
  await statusUntil(f.store, controller, 'publishing');
  controller.change('a', ticket => { ticket.review = null; });
  await controller.step('a'); assert.equal(controller.current('a').blocker.code, 'missing_evidence');
  assert.equal(git(f.root, '--git-dir', f.source, 'rev-list', '--count', 'main'), '1');
});
