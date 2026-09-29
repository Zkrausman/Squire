import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Controller } from '../src/controller.mjs';
import { fixture, FixtureRuntime, ticket, git, statusUntil } from './support.mjs';

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
