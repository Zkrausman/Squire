import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { digest } from '../src/contracts.mjs';
import { withProducer } from '../src/producer-context.mjs';

const requestDigest = digest({ command: 'offline-fixture' });
const terminal = (exitCode = 7) => ({ kind: 'terminal', exitCode, endedAt: 123456, receiptDigest: digest('receipt') });
const blocked = fn => assert.throws(fn, { code: 'producer_unresolved' });
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'squire-operation-store-'));
  const f = { directory, store: new Store(directory) };
  t.after(() => { f.store.close(); rmSync(directory, { recursive: true, force: true }); });
  f.store.initialize({ id: 'project', tickets: [] });
  f.lease = f.store.lease('controller:project');
  f.scope = f.store.beginProducer('project', 'lane-a', f.lease);
  f.reopen = () => { f.store.close(); f.store = new Store(directory); return f.store; };
  f.register = (id = 'operation', scope = f.scope, jobId = null) =>
    f.store.registerProcess(scope, jobId, id, directory, requestDigest);
  f.complete = (scope = f.scope) => f.store.update('project', s => { s.status = 'completed'; }, 'producer.done', {}, scope);
  return f;
}

for (const phase of ['registered', 'supervisor', 'target', 'terminal']) {
  test(`reopening ${phase} evidence never authorizes a replacement scope or spends again`, t => {
    const f = fixture(t), grant = f.register();
    if (phase !== 'registered') f.store.claimProcess(grant, 'registered', 'supervisor', requestDigest);
    if (['target', 'terminal'].includes(phase)) f.store.claimProcess(grant, 'supervisor', 'target', requestDigest);
    if (phase === 'terminal') f.store.finishProcess(grant, 'target', terminal());
    const before = { op: f.store.processOperation(grant.id), state: f.store.get('project'), events: f.store.events('project') };
    for (let i = 0; i < 3; i++) {
      f.reopen();
      blocked(() => f.store.beginProducer('project', 'lane-a', f.lease));
      blocked(() => f.store.assertProducerScopesClear('project'));
      assert.deepEqual(f.store.processOperation(grant.id), before.op);
      assert.deepEqual(f.store.get('project'), before.state);
      assert.deepEqual(f.store.events('project'), before.events);
    }
  });
}

test('request mismatch, foreign token, and duplicate supervisor/target claims cannot consume a fresh grant', t => {
  const f = fixture(t), grant = f.register();
  blocked(() => f.store.claimProcess(grant, 'registered', 'supervisor', digest('different request')));
  blocked(() => f.store.claimProcess({ ...grant, token: 'foreign' }, 'registered', 'supervisor', requestDigest));
  assert.equal(f.store.processOperation(grant.id).phase, 'registered');
  f.store.claimProcess(grant, 'registered', 'supervisor', requestDigest);
  f.reopen();
  blocked(() => f.store.claimProcess(grant, 'registered', 'supervisor', requestDigest));
  f.store.claimProcess(grant, 'supervisor', 'target', requestDigest);
  f.reopen();
  blocked(() => f.store.claimProcess(grant, 'supervisor', 'target', requestDigest));
  assert.equal(f.store.processOperation(grant.id).phase, 'target');
});

test('phase progression cannot skip or reset either one-use launch grant', t => {
  const f = fixture(t), grant = f.register();
  blocked(() => f.store.claimProcess(grant, 'registered', 'target', requestDigest));
  blocked(() => f.store.claimProcess(grant, 'registered', 'registered', requestDigest));
  f.store.claimProcess(grant, 'registered', 'supervisor', requestDigest);
  blocked(() => f.store.claimProcess(grant, 'supervisor', 'registered', requestDigest));
  f.store.claimProcess(grant, 'supervisor', 'target', requestDigest);
  blocked(() => f.store.claimProcess(grant, 'target', 'supervisor', requestDigest));
});

test('nonzero terminal is immutable; exact duplicate is idempotent and conflicting/error-close evidence refuses', t => {
  const f = fixture(t), grant = f.register();
  f.store.claimProcess(grant, 'registered', 'supervisor', requestDigest);
  f.store.claimProcess(grant, 'supervisor', 'target', requestDigest);
  f.store.finishProcess(grant, 'target', terminal(23));
  f.reopen();
  f.store.finishProcess(grant, 'target', terminal(23));
  blocked(() => f.store.finishProcess(grant, 'target', terminal(0)));
  blocked(() => f.store.finishProcess(grant, 'target', { ...terminal(23), kind: 'not_started' }));
  blocked(() => f.store.finishProcess({ ...grant, token: 'foreign' }, 'target', terminal(23)));
  assert.equal(JSON.parse(f.store.processOperation(grant.id).terminal).exitCode, 23);
  assert.throws(() => f.store.db.prepare('UPDATE process_operations SET terminal=NULL WHERE id=?').run(grant.id), /immutable/);
  f.complete();
  assert.doesNotThrow(() => f.store.assertProducerScopesClear('project'));
  assert.throws(() => f.store.db.prepare('UPDATE producer_scopes SET outcome=NULL WHERE id=?').run(f.scope), /immutable/);
});

test('lease turnover blocks new registration, launch, reservation and closure but retains late terminal evidence', t => {
  const f = fixture(t), grant = f.register();
  f.store.claimProcess(grant, 'registered', 'supervisor', requestDigest);
  f.store.claimProcess(grant, 'supervisor', 'target', requestDigest);
  f.lease();
  const replacement = f.store.lease('controller:project');
  blocked(() => f.register('replacement'));
  blocked(() => f.store.reserveProducerCall(f.scope, 'replacement-job'));
  blocked(() => f.store.claimProcess(grant, 'supervisor', 'target', requestDigest));
  f.store.finishProcess(grant, 'target', terminal());
  blocked(() => f.complete());
  for (let i = 0; i < 3; i++) {
    f.reopen();
    blocked(() => f.store.beginProducer('project', 'lane-a', replacement));
    blocked(() => f.complete());
    assert.deepEqual(JSON.parse(f.store.processOperation(grant.id).terminal), terminal());
    assert.equal(f.store.get('project').agentCalls, 0);
    assert.equal(f.store.get('project').status, 'queued');
  }
});

test('call reservation, debit and outbox roll back together at a deterministic persistence barrier', t => {
  const f = fixture(t);
  const reserve = jobId => f.store.update('project', s => {
    f.store.reserveProducerCall(f.scope, jobId); s.agentCalls++;
  }, 'job.started', { jobId });
  f.store.db.exec("CREATE TRIGGER fail_job_event BEFORE INSERT ON events WHEN json_extract(NEW.data,'$.type')='job.started' BEGIN SELECT RAISE(ABORT,'injected event persistence failure'); END");
  assert.throws(() => reserve('job'), /injected event persistence failure/);
  f.reopen();
  assert.equal(f.store.get('project').agentCalls, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM producer_calls').get().count, 0);
  assert.equal(f.store.events('project').length, 1);
  blocked(() => f.register('unreserved', f.scope, 'job'));
  f.store.db.exec('DROP TRIGGER fail_job_event');
  reserve('job');
  assert.throws(() => reserve('job'), /UNIQUE/);
  f.register('reserved', f.scope, 'job');
  blocked(() => reserve('another-job'));
  f.reopen();
  assert.equal(f.store.get('project').agentCalls, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM producer_calls').get().count, 1);
  assert.equal(f.store.events('project').filter(e => e.type === 'job.started').length, 1);
});

test('terminal persistence failure preserves the launch fence through reopen', t => {
  const f = fixture(t), grant = f.register();
  f.store.claimProcess(grant, 'registered', 'supervisor', requestDigest);
  f.store.claimProcess(grant, 'supervisor', 'target', requestDigest);
  f.store.db.exec("CREATE TRIGGER fail_terminal BEFORE UPDATE OF terminal ON process_operations BEGIN SELECT RAISE(ABORT,'injected terminal persistence failure'); END");
  assert.throws(() => f.store.finishProcess(grant, 'target', terminal()), /injected terminal persistence failure/);
  for (let i = 0; i < 3; i++) {
    f.reopen();
    blocked(() => f.store.claimProcess(grant, 'supervisor', 'target', requestDigest));
    blocked(() => f.complete());
    blocked(() => f.store.beginProducer('project', 'lane-a', f.lease));
    assert.equal(f.store.processOperation(grant.id).terminal, null);
    assert.equal(f.store.get('project').agentCalls, 0);
  }
});

test('failed scope-outcome persistence rolls back caller state and event while retaining terminal evidence', t => {
  const f = fixture(t), grant = f.register();
  f.store.finishProcess(grant, 'registered', { ...terminal(null), kind: 'not_started' });
  f.store.db.exec("CREATE TRIGGER fail_outcome BEFORE UPDATE OF outcome ON producer_scopes BEGIN SELECT RAISE(ABORT,'injected outcome persistence failure'); END");
  const before = f.store.get('project'), evidence = f.store.processOperation(grant.id);
  assert.throws(() => f.complete(), /injected outcome persistence failure/);
  for (let i = 0; i < 3; i++) {
    f.reopen();
    assert.deepEqual(f.store.get('project'), before);
    assert.deepEqual(f.store.processOperation(grant.id), evidence);
    assert.equal(f.store.events('project').length, 1);
    blocked(() => f.store.beginProducer('project', 'lane-a', f.lease));
    blocked(() => f.store.claimProcess(grant, 'registered', 'supervisor', requestDigest));
  }
});

test('an unresolved lane does not prevent an independent lane from recording its own durable outcome', t => {
  const f = fixture(t), first = f.register('lane-a-operation');
  const scopeB = f.store.beginProducer('project', 'lane-b', f.lease);
  const second = f.register('lane-b-operation', scopeB);
  f.store.finishProcess(second, 'registered', { ...terminal(null), kind: 'not_started' });
  f.complete(scopeB);
  f.reopen();
  assert.equal(f.store.processOperation(first.id).terminal, null);
  assert.notEqual(f.store.processOperation(second.id).terminal, null);
  assert.doesNotThrow(() => f.store.beginProducer('project', 'lane-b', f.lease));
  blocked(() => f.store.beginProducer('project', 'lane-a', f.lease));
  blocked(() => withProducer({ store: f.store, scopeId: f.scope }, () => f.store.assertProducerScopesClear('project')));
});

for (const [label, evidence] of Object.entries({
  invalidJson: '{', missingFields: JSON.stringify({ kind: 'terminal' }),
  badTimestamp: JSON.stringify({ ...terminal(), endedAt: 'yesterday' }),
  badExitCode: JSON.stringify({ ...terminal(), exitCode: 'zero' }),
  badDigest: JSON.stringify({ ...terminal(), receiptDigest: 'not-a-digest' })
})) {
  test(`malformed persisted canonical evidence (${label}) keeps scope and caller outcome held`, t => {
    const f = fixture(t), grant = f.register();
    f.store.db.prepare('UPDATE process_operations SET terminal=? WHERE id=?').run(evidence, grant.id);
    for (let i = 0; i < 3; i++) {
      f.reopen();
      blocked(() => f.complete());
      blocked(() => f.store.beginProducer('project', 'lane-a', f.lease));
      assert.equal(f.store.processOperation(grant.id).terminal, evidence);
      assert.equal(f.store.get('project').status, 'queued');
      assert.equal(f.store.get('project').agentCalls, 0);
    }
  });
}

test('registration persistence failure keeps the already spent reservation and scope held', t => {
  const f = fixture(t);
  f.store.update('project', state => {
    f.store.reserveProducerCall(f.scope, 'spent-job'); state.agentCalls++;
  }, 'job.started', { jobId: 'spent-job' });
  f.store.db.exec("CREATE TRIGGER fail_registration BEFORE INSERT ON process_operations BEGIN SELECT RAISE(ABORT,'injected registration persistence failure'); END");
  assert.throws(() => f.register('never-launched', f.scope, 'spent-job'), /injected registration persistence failure/);
  for (let i = 0; i < 3; i++) {
    f.reopen();
    blocked(() => f.store.beginProducer('project', 'lane-a', f.lease));
    blocked(() => f.store.processOperation('never-launched'));
    assert.equal(f.store.get('project').agentCalls, 1);
    assert.equal(f.store.db.prepare('SELECT scope_id FROM producer_calls WHERE job_id=?').get('spent-job').scope_id, f.scope);
    assert.equal(f.store.events('project').filter(e => e.type === 'job.started').length, 1);
  }
});

test('a reservation from another lane cannot authorize a process', t => {
  const f = fixture(t), secondScope = f.store.beginProducer('project', 'lane-b', f.lease);
  f.store.update('project', state => { f.store.reserveProducerCall(f.scope, 'job-a'); state.agentCalls++; });
  blocked(() => f.register('cross-lane', secondScope, 'job-a'));
  blocked(() => f.store.processOperation('cross-lane'));
  assert.equal(f.store.get('project').agentCalls, 1);
});

test('invalid terminal writers and malformed records never erase unresolved evidence', t => {
  const f = fixture(t), grant = f.register();
  blocked(() => f.store.finishProcess(grant, 'registered', terminal()));
  blocked(() => f.store.finishProcess(grant, 'registered', null));
  f.store.claimProcess(grant, 'registered', 'supervisor', requestDigest);
  blocked(() => f.store.finishProcess(grant, 'registered', { ...terminal(null), kind: 'not_started' }));
  f.store.claimProcess(grant, 'supervisor', 'target', requestDigest);
  for (const record of [null, {}, { ...terminal(), endedAt: 0 }, { ...terminal(), exitCode: '0' }, { ...terminal(), receiptDigest: '' }]) {
    blocked(() => f.store.finishProcess(grant, 'target', record));
    assert.equal(f.store.processOperation(grant.id).terminal, null);
  }
  blocked(() => f.complete());
  assert.equal(f.store.get('project').status, 'queued');
  assert.equal(f.store.events('project').length, 1);
});
