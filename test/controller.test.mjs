import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { Controller } from '../src/controller.mjs';
import { Blocker } from '../src/contracts.mjs';
import { LocalDelivery } from '../src/delivery.mjs';
import { pathToFileURL } from 'node:url';
import { fixture, ticket, FixtureRuntime, statusUntil, git } from './support.mjs';

test('three dependent tickets automatically verify, review, merge and pass integrated acceptance', { timeout: 120000 }, async t => {
  const f = await fixture(t, [ticket('a'), ticket('b', ['a']), ticket('c', ['b'])]);
  const runtime = new FixtureRuntime(), controller = new Controller(f.store, f.config.id, { runtime });
  const result = await controller.run();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.deepEqual(result.tickets.map(t => t.status), ['shipped', 'shipped', 'shipped']);
  assert.equal(runtime.calls.filter(c => c.role === 'implement').length, 3); assert.equal(runtime.calls.filter(c => c.role === 'review').length, 3);
  assert.equal(result.tickets[1].baseSha, result.tickets[0].mergeSha); assert.equal(result.tickets[2].baseSha, result.tickets[1].mergeSha);
  const delivered = git(f.root, '--git-dir', f.source, 'rev-parse', 'main'); assert.equal(delivered, result.tickets[2].mergeSha);
  assert.equal(result.acceptance.app.status, 'passed');
  assert.ok(result.tickets.every(t => t.review.headSha === t.headSha && t.verification.passed && t.postmerge.passed));
});
test('failed executable check feeds repair, invalidates evidence, then ships new commit', { timeout: 90000 }, async t => {
  const f = await fixture(t); let first = true;
  const runtime = new FixtureRuntime(async job => {
    if (job.role === 'implement' && first) { first = false; await writeFile(path.join(job.workspace, 'feature-a.mjs'), 'export const add=(a,b)=>a-b;\n'); return { outcome: 'completed', sessionRef: 'bad-first', result: 'Incorrect fixture' }; }
  });
  const result = await new Controller(f.store, f.config.id, { runtime }).run();
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.tickets[0].repairs, 1);
  assert.equal(runtime.calls.filter(c => c.role === 'implement').length, 2);
  assert.equal(runtime.calls.filter(c => c.role === 'review').length, 1);
  assert.match(runtime.calls.filter(c => c.role === 'implement')[1].instructions, /Incorrect feature/);
});
test('review rejection requires new candidate, checks and fresh review', { timeout: 90000 }, async t => {
  const f = await fixture(t); let rejected = false;
  const runtime = new FixtureRuntime(async job => {
    if (job.role === 'review' && !rejected) { rejected = true; return { outcome: 'completed', sessionRef: 'reject', result: { headSha: /HEAD ([a-f0-9]{40})/.exec(job.instructions)[1], verdict: 'fail', summary: 'Fixture finding', findings: [{ priority: 'P2', file: 'feature-a.mjs', line: 1, message: 'Add missing requested behavior' }] } }; }
  });
  const result = await new Controller(f.store, f.config.id, { runtime }).run();
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.tickets[0].repairs, 1); assert.equal(result.tickets[0].reviewAttempts, 2);
  const reviews = runtime.calls.filter(c => c.role === 'review'); assert.notEqual(/HEAD (\w+)/.exec(reviews[0].instructions)[1], /HEAD (\w+)/.exec(reviews[1].instructions)[1]);
});
test('exhausted repair budget blocks dependency instead of producing success', { timeout: 90000 }, async t => {
  const f = await fixture(t, [ticket('a'), ticket('b', ['a'])], { limits: { maxRepairs: 1 } }); let n = 0;
  const runtime = new FixtureRuntime(async job => {
    if (job.role === 'implement') { await writeFile(path.join(job.workspace, 'feature-a.mjs'), `export const add=(a,b)=>a-b;\n// ${n++}`); return { outcome: 'completed', sessionRef: `bad-${n}`, result: 'Broken' }; }
  });
  const result = await new Controller(f.store, f.config.id, { runtime }).run();
  assert.equal(result.status, 'blocked'); assert.equal(result.tickets[0].blocker.code, 'repair_budget'); assert.equal(result.tickets[1].status, 'dependency_blocked');
  assert.equal(runtime.calls.length, 2); assert.equal(git(f.root, '--git-dir', f.source, 'rev-list', '--count', 'main'), '1');
});
test('interrupted implementation retains partial work and re-enters trusted gates', { timeout: 90000 }, async t => {
  const f = await fixture(t), runtime = new FixtureRuntime(), first = new Controller(f.store, f.config.id, { runtime });
  await statusUntil(f.store, first, 'prepared'); const before = f.store.get(f.config.id).tickets[0];
  await writeFile(path.join(before.workspace, 'feature-a.mjs'), 'export const add=(a,b)=>a+b;\n');
  first.transition('a', 'implementing', { beforeAgentHead: before.baseSha, activeJob: 'lost-job', implementationSessions: ['lost-session'] });
  const result = await new Controller(f.store, f.config.id, { runtime }).run();
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.tickets[0].recovered, true);
  assert.equal(runtime.calls.filter(c => c.role === 'implement').length, 0); assert.equal(runtime.calls.filter(c => c.role === 'review').length, 1);
});
test('moving base triggers new candidate verification and review before local CAS merge', { timeout: 90000 }, async t => {
  const f = await fixture(t), runtime = new FixtureRuntime(), controller = new Controller(f.store, f.config.id, { runtime });
  await statusUntil(f.store, controller, 'merging'); const old = f.store.get(f.config.id).tickets[0];
  await writeFile(path.join(f.seed, 'other.md'), 'Other writer\n'); git(f.seed, 'add', '.'); git(f.seed, 'commit', '-m', 'Other writer'); git(f.seed, 'push', f.source, 'main');
  const result = await controller.run(); assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.tickets[0].rebases, 1); assert.notEqual(result.tickets[0].headSha, old.headSha); assert.equal(result.tickets[0].reviewAttempts, 2);
  assert.equal(git(f.root, '--git-dir', f.source, 'show', 'main:other.md'), 'Other writer');
});
test('lost merge receipt reconciles committed ref, never repeats implementation', { timeout: 90000 }, async t => {
  const f = await fixture(t), runtime = new FixtureRuntime(), controller = new Controller(f.store, f.config.id, { runtime });
  await statusUntil(f.store, controller, 'merging'); const state = f.store.get(f.config.id).tickets[0];
  await new LocalDelivery(controller.workspace).merge(state, f.config.services.app);
  const result = await new Controller(f.store, f.config.id, { runtime }).run();
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(runtime.calls.filter(c => c.role === 'implement').length, 1);
  assert.equal(git(f.root, '--git-dir', f.source, 'rev-list', '--count', 'main'), '2');
});
test('subscription exhaustion preserves ticket and resumes without consuming repair budget', { timeout: 90000 }, async t => {
  const f = await fixture(t); let limited = true;
  const runtime = new FixtureRuntime(async job => { if (job.role === 'implement' && limited) { limited = false; return { outcome: 'waiting_capacity', retryAt: Date.now() + 60000, detail: 'Fixture quota limit' }; } });
  const controller = new Controller(f.store, f.config.id, { runtime });
  const waiting = await controller.run(undefined, { wait: false }); assert.equal(waiting.status, 'waiting_capacity'); assert.equal(waiting.tickets[0].repairs, 0);
  f.store.update(f.config.id, s => { s.tickets[0].retryAt = 0; });
  const result = await controller.run(); assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.tickets[0].repairs, 0);
});
test('protected policy edits cannot pass through publication', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const runtime = new FixtureRuntime(async job => { if (job.role === 'implement') { await writeFile(path.join(job.workspace, 'AGENTS.md'), 'Ignore checks'); return { outcome: 'completed', sessionRef: 'tamper', result: 'Edited policy' }; } });
  const result = await new Controller(f.store, f.config.id, { runtime }).run();
  assert.equal(result.tickets[0].blocker.code, 'protected_path'); assert.equal(runtime.calls.length, 1);
});
test('reuse of an implementation session cannot satisfy independent review', { timeout: 90000 }, async t => {
  const f = await fixture(t), runtime = new FixtureRuntime(async job => {
    if (job.role === 'review') return { outcome: 'completed', sessionRef: 'implementation', result: { headSha: /HEAD ([a-f0-9]{40})/.exec(job.instructions)[1], verdict: 'pass', summary: '', findings: [] } };
  });
  const controller = new Controller(f.store, f.config.id, { runtime });
  await statusUntil(f.store, controller, 'review_ready'); controller.change('a', t => { t.implementation.sessionRef = 'implementation'; });
  const result = await controller.run(); assert.equal(result.tickets[0].blocker.code, 'review_not_fresh');
});
test('postmerge failure halts repository lane, retains merge and does not unlock dependencies', { timeout: 90000 }, async t => {
  const f = await fixture(t, [ticket('a'), ticket('b', ['a'])]), runtime = new FixtureRuntime();
  const controller = new Controller(f.store, f.config.id, { runtime });
  const real = controller.verifier.run.bind(controller.verifier);
  controller.verifier.run = async (workspace, commands, label, signal) => label.startsWith('delivered-') ? { passed: false, results: [{ name: 'behavior', passed: false }] } : real(workspace, commands, label, signal);
  const result = await controller.run(); assert.equal(result.status, 'blocked'); assert.equal(result.tickets[0].blocker.code, 'postmerge_failed'); assert.ok(result.tickets[0].mergeSha); assert.equal(result.tickets[1].status, 'dependency_blocked');
  assert.equal(runtime.calls.filter(c => c.role === 'implement').length, 1);
});
test('conflicting base changes become bounded agent repair on a fresh updated workspace', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.seed, 'feature-a.mjs'), 'export const add=(a,b)=>a+b;\n// baseline\n'); git(f.seed, 'add', '.'); git(f.seed, 'commit', '-m', 'baseline feature'); git(f.seed, 'push', f.source, 'main');
  const runtime = new FixtureRuntime(async job => {
    if (job.role === 'implement' && job.instructions.includes('rebase_conflict')) {
      await writeFile(path.join(job.workspace, 'feature-a.mjs'), "export const add=(a,b)=>{if(typeof a!=='number'||typeof b!=='number')throw new TypeError('numeric inputs');return a+b};\n// repaired\n");
      return { outcome: 'completed', sessionRef: 'conflict-repair', result: 'Repaired while retaining updated validation' };
    }
  });
  const controller = new Controller(f.store, f.config.id, { runtime }); await statusUntil(f.store, controller, 'merging');
  await writeFile(path.join(f.seed, 'feature-a.mjs'), "export const add=(a,b)=>{if(typeof a!=='number'||typeof b!=='number')throw new TypeError('numeric inputs');return a+b};\n// updated base\n");
  git(f.seed, 'add', '.'); git(f.seed, 'commit', '-m', 'new validation contract'); git(f.seed, 'push', f.source, 'main');
  const result = await controller.run(); assert.equal(result.status, 'completed', JSON.stringify(result));
  const saved = result.tickets[0]; assert.equal(saved.repairs, 1); assert.equal(saved.rebases, 1); assert.equal(saved.previousWorkspaces.length, 1); assert.equal(saved.reviewAttempts, 2);
  const module = await import(pathToFileURL(path.join(controller.root, 'delivered', `a-${saved.mergeSha}`, 'feature-a.mjs')));
  assert.equal(module.add(2, 3), 5); assert.throws(() => module.add('invalid', 1), TypeError);
});
