import test from './standalone.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Controller } from '../src/controller.mjs';
import { digest, publicProjectContract, validateConfig, MAX_PUBLIC_CONTRACT_BYTES } from '../src/contracts.mjs';
import { fixture, ticket, FixtureRuntime } from './support.mjs';

const goal = 'Public widget contract.\nUse the declared JSON schema: {"required":["widgetId"]}.\n';
const approved = { goal, publicContract: { sha256: digest(goal) } };

test('planner, implementation, repair and each fresh review receive identical pinned public bytes', { timeout: 90000 }, async t => {
  const f = await fixture(t, [], { ...approved, tickets: undefined });
  const seen = []; let reject = true;
  const runtime = new FixtureRuntime(async (job, _runtime, sessionRef) => {
    seen.push({ role: job.role, metadata: job.publicContract, instructions: job.instructions });
    if (job.role === 'plan') return { outcome: 'completed', sessionRef, result: { tickets: [ticket('a')] } };
    if (job.role === 'review' && reject) {
      reject = false;
      return { outcome: 'completed', sessionRef, result: { headSha: /HEAD ([a-f0-9]{40})/.exec(job.instructions)[1], verdict: 'fail', summary: 'Fixture repair needed', findings: [{ priority: 'P2', file: 'feature-a.mjs', line: 1, message: 'Revise the requested widget implementation' }] } };
    }
  });
  const result = await new Controller(f.store, f.config.id, { runtime }).run();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.deepEqual(seen.map(x => x.role), ['plan', 'implement', 'review', 'implement', 'review']);
  const expected = { sha256: digest(goal), bytes: Buffer.byteLength(goal) };
  for (const call of seen) {
    assert.deepEqual(call.metadata, expected);
    assert.equal(call.instructions.split(goal).length - 1, 1, 'exact public bytes occur once, including planner');
    assert.match(call.instructions, /only the current ticket authorizes changes/);
    assert.match(call.instructions, /does not grant additional ownership/);
  }
  const events = f.store.events(f.config.id).filter(e => e.type === 'job.started');
  assert.equal(events.length, seen.length);
  assert.ok(events.every(e => e.publicContract.sha256 === digest(goal) && e.publicContract.bytes === Buffer.byteLength(goal)));
  assert.equal(result.tickets[0].repairs, 1);
  assert.equal(result.tickets[0].reviewAttempts, 2);
  assert.ok(result.tickets[0].verification.passed && result.tickets[0].postmerge.passed);
});

test('public declaration accepts no private file paths, directories or worker-selected attachments', async t => {
  const f = await fixture(t);
  for (const attack of [
    { sha256: digest(goal), path: '/private/answers.json' },
    { sha256: digest(goal), path: '../private/answers.json' },
    { sha256: digest(goal), files: ['private/answers.json'] },
    { sha256: digest(goal), root: f.root },
    { sha256: digest(goal), content: 'unapproved bytes' }
  ]) {
    assert.throws(() => validateConfig({ ...structuredClone(f.config), goal, publicContract: attack }), /Unknown publicContract field/);
  }
  assert.deepEqual(publicProjectContract(approved), { text: goal, sha256: digest(goal), bytes: Buffer.byteLength(goal) });
});

test('missing bytes, missing pin, wrong hash and oversized UTF-8 public context fail closed', () => {
  for (const invalid of [
    { publicContract: approved.publicContract },
    { goal, publicContract: {} },
    { goal, publicContract: { sha256: '0'.repeat(64) } },
    { goal: '', publicContract: { sha256: digest('') } },
    { goal: '界'.repeat(12000), publicContract: { sha256: digest('界'.repeat(12000)) } }
  ]) assert.throws(() => publicProjectContract(invalid), e => e.code === 'invalid_config');
  assert.ok(Buffer.byteLength('界'.repeat(12000)) > MAX_PUBLIC_CONTRACT_BYTES);
});

test('live goal/hash drift or removal blocks each dispatch before spending a call', async t => {
  const f = await fixture(t, [ticket('a')], approved);
  const runtime = new FixtureRuntime(), controller = new Controller(f.store, f.config.id, { runtime });
  for (const role of ['plan', 'implement', 'review']) {
    for (const mutate of [
      config => { config.goal += ' altered'; },
      config => { delete config.goal; },
      config => { delete config.publicContract; },
      config => { config.publicContract.sha256 = 'f'.repeat(64); },
      config => { config.goal = 'replacement'; config.publicContract.sha256 = digest(config.goal); }
    ]) {
      f.store.update(f.config.id, state => { state.config.goal = goal; state.config.publicContract = structuredClone(approved.publicContract); mutate(state.config); });
      await assert.rejects(() => controller.callAgent(role, f.seed, path.join(f.root, 'blocked-job'), 'Scoped ticket', undefined), e => e.code === 'public_contract_drift');
      assert.equal(f.store.get(f.config.id).agentCalls, 0);
    }
  }
  assert.equal(runtime.calls.length, 0);
  assert.equal(f.store.events(f.config.id).filter(e => e.type === 'job.started').length, 0);
});

test('unapproved goals remain planner-only with no contract metadata', async t => {
  const legacyGoal = 'Legacy planner-only goal';
  const f = await fixture(t, [], { goal: legacyGoal, tickets: undefined });
  const runtime = new FixtureRuntime(async (job, _runtime, sessionRef) => {
    assert.equal(job.publicContract, undefined);
    if (job.role === 'plan') return { outcome: 'completed', sessionRef, result: { tickets: [ticket('a')] } };
  });
  const result = await new Controller(f.store, f.config.id, { runtime }).run();
  assert.equal(result.status, 'completed');
  assert.deepEqual(runtime.calls.map(call => call.role), ['plan', 'implement', 'review']);
  assert.equal(runtime.calls[0].instructions.split(legacyGoal).length - 1, 1);
  assert.ok(runtime.calls.slice(1).every(call => !call.instructions.includes(legacyGoal)));
  assert.ok(f.store.events(f.config.id).filter(e => e.type === 'job.started').every(e => !e.publicContract));
});

test('malformed public declarations fail project validation', async t => {
  const f = await fixture(t);
  for (const declaration of [null, [], 'pin', {}, { sha256: 1 },
    { sha256: 'a'.repeat(63) }, { sha256: 'a'.repeat(65) }, { sha256: 'A'.repeat(64) }]) {
    assert.throws(() => validateConfig({ ...structuredClone(f.config), goal, publicContract: declaration }), e => e.code === 'invalid_config');
  }
});

test('public context preserves exact bytes at UTF-8 and character limits', () => {
  const atByteLimit = '界'.repeat(10922) + 'ab';
  assert.equal(Buffer.byteLength(atByteLimit), MAX_PUBLIC_CONTRACT_BYTES);
  for (const text of [atByteLimit, 'a'.repeat(16000), '  exact public bytes\n']) {
    const contract = publicProjectContract({ goal: text, publicContract: { sha256: digest(text) } });
    assert.equal(contract.text, text);
    assert.equal(contract.bytes, Buffer.byteLength(text));
    assert.ok(Object.isFrozen(contract));
  }
  for (const text of [atByteLimit + 'a', 'a'.repeat(16001), 'invalid\0goal']) {
    assert.throws(() => publicProjectContract({ goal: text, publicContract: { sha256: digest(text) } }), e => e.code === 'invalid_config');
  }
});

test('controller-local and coordinated contract replacement fail before dispatch', async t => {
  const f = await fixture(t, [ticket('a')], approved);
  const runtime = new FixtureRuntime(), controller = new Controller(f.store, f.config.id, { runtime });
  for (const role of ['plan', 'implement', 'review']) {
    for (const mutate of [
      config => { config.goal += ' changed'; },
      config => { delete config.publicContract; },
      config => { config.publicContract.path = '/unapproved/attachment'; },
      config => { config.goal = 'replacement'; config.publicContract.sha256 = digest(config.goal); }
    ]) {
      controller.config = structuredClone(f.config);
      mutate(controller.config);
      await assert.rejects(() => controller.callAgent(role, f.seed, path.join(f.root, 'blocked-job'), 'Scoped ticket', undefined), e => e.code === 'public_contract_drift');
      assert.equal(f.store.get(f.config.id).agentCalls, 0);
    }
    f.store.update(f.config.id, state => { state.config = structuredClone(controller.config); });
    await assert.rejects(() => controller.callAgent(role, f.seed, path.join(f.root, 'blocked-job'), 'Scoped ticket', undefined), e => e.code === 'public_contract_drift');
    f.store.update(f.config.id, state => { state.config = structuredClone(f.config); });
  }
  assert.equal(runtime.calls.length, 0);
  assert.equal(f.store.events(f.config.id).filter(e => e.type === 'job.started').length, 0);
});
