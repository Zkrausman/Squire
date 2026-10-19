import test from 'node:test';
import assert from 'node:assert/strict';
import {runDirectChildAcceptance, DIRECT_CHILD_CASES} from './support/direct-child-acceptance.mjs';
import {spec} from './fixtures.mjs';

function fakeClock(dropInner = false, skipAbort = false) {
  let time = 0, order = 0; const timers = [];
  const clock = {now: () => time, schedule(delay, callback) {
    const item = {at: time + delay, callback, order: order++, canceled: (dropInner && delay !== 3000) || (skipAbort && delay === 20)}; timers.push(item);
    return () => { item.canceled = true; };
  }};
  async function flush() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
  return {clock, async advance(target) {
    await flush(); let count = 0;
    while (true) {
      const item = timers.filter(t => !t.canceled && t.at <= target).sort((a,b) => a.at-b.at || a.order-b.order)[0];
      if (!item) break;
      if (++count > 10000) throw new Error('fake clock loop');
      item.canceled = true; time = item.at; item.callback(); await flush();
    }
    time = target; await flush();
  }};
}
const jobs = () => ({exit: {...spec(), task_scope: '/fixture/native-exit', max_wall_clock_sec: 1, max_steps: 1},
  abort: {...spec(), job_id: '12345678-1234-4abc-8def-123456789abd', task_scope: '/fixture/native-abort', max_wall_clock_sec: 1, max_steps: 1}});
function fixture(config = {}) {
  const time = fakeClock(config.dropInner, config.skipAbort); const requests = [], signals = []; let liveJobs = 0;
  const port = {spawn(job, invocation, events) {
    if (liveJobs !== 0) throw new Error('overlapping fixture jobs');
    const index = requests.length; requests.push({job, invocation});
    if (config.spawnFailure) throw new Error('PRIVATE_LAUNCH_MESSAGE');
    liveJobs++; let live = 1, exited = false; const pid = 4321 + index, identity = Object.freeze({});
    function exit(code, signal) { if (exited) return; exited = true; live = 0; liveJobs--; events.onExit({code, signal}); }
    time.clock.schedule(0, () => events.onSpawn({pid}));
    if (index === 0) time.clock.schedule(10, () => exit(config.badExit ? 0 : 7, null));
    else time.clock.schedule(config.lateSelfExit ? 2000 : 250, () => exit(0, null));
    return {pid, identity, observe: () => ({job_id: job.job_id, pgid: pid, identity, live_count: live,
      coverage_complete: !config.unknownCoverage, signal_safe: true}),
    sendSignal(signal) {
      signals.push({index, signal});
      if (config.signalDenial) throw Object.assign(new Error('PRIVATE_DENIAL'), {code: 'EPERM'});
      time.clock.schedule(0, () => exit(null, signal)); return true;
    }, release() {}};
  }};
  const input = {executable: '/fixture/node24', jobs: jobs(), port, clock: time.clock};
  return {time, requests, signals, input};
}

test('direct-child harness runs the exact inert programs sequentially under fake operations', async () => {
  const f = fixture(); const pending = runDirectChildAcceptance(f.input); await f.time.advance(500); const result = await pending;
  assert.equal(result.status, 'PASS'); assert.equal(result.runtime_qualification, 'NOT_ESTABLISHED_BY_HARNESS');
  assert.deepEqual(f.requests.map(r => r.invocation.args), DIRECT_CHILD_CASES.map(item => ['-e', item.program]));
  for (const request of f.requests) {
    assert.deepEqual(request.invocation.stdio, ['ignore', 'ignore', 'ignore']);
    assert.deepEqual({...request.invocation.env}, {TMPDIR: request.job.task_scope, LANG: 'C', TZ: 'UTC'});
  }
  assert.equal(result.cases[0].observation.process_exit_code, 7); assert.equal(result.cases[1].observation.canceled, true);
  assert.deepEqual(f.signals, [{index: 1, signal: 'SIGTERM'}]);
  assert.throws(() => { result.cases[0].status = 'FAIL'; }, TypeError);
});
test('wrong native exit stops before the second case without retrying', async () => {
  const f = fixture({badExit: true}); const pending = runDirectChildAcceptance(f.input); await f.time.advance(500); const result = await pending;
  assert.equal(result.status, 'FAIL'); assert.equal(f.requests.length, 1); assert.equal(result.cases[1].status, 'NOT_REACHED');
});
test('unknown coverage stops without promoting cleanup or starting another case', async () => {
  const f = fixture({unknownCoverage: true}); const pending = runDirectChildAcceptance(f.input); await f.time.advance(500); const result = await pending;
  assert.equal(result.status, 'FAIL'); assert.equal(result.cases[0].observation.settlement_status, null);
  assert.equal(f.requests.length, 1); assert.equal(result.cases[1].status, 'NOT_REACHED');
});
test('signal denial retains partial metadata, dispatches no fallback and does not retain private errors', async () => {
  const f = fixture({signalDenial: true}); const pending = runDirectChildAcceptance(f.input); await f.time.advance(500); const result = await pending;
  assert.equal(result.status, 'FAIL'); assert.equal(result.cases[1].observation.termination_reason, 'signal_failed');
  assert.deepEqual(f.signals, [{index: 1, signal: 'SIGTERM'}]);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false); assert.equal(JSON.stringify(result).includes('process.exit'), false);
});
test('a spawn exception is not retried and prevents the second case', async () => {
  const f = fixture({spawnFailure: true}); const pending = runDirectChildAcceptance(f.input); await f.time.advance(10); const result = await pending;
  assert.equal(result.status, 'FAIL'); assert.equal(f.requests.length, 1); assert.equal(result.cases[1].status, 'NOT_REACHED');
  assert.equal(JSON.stringify(result).includes('PRIVATE_LAUNCH_MESSAGE'), false);
});
test('overall timeout returns only missing evidence and does not invent an alternate cleanup action', async () => {
  const f = fixture({dropInner: true}); const pending = runDirectChildAcceptance(f.input); await f.time.advance(3000); const result = await pending;
  assert.equal(result.status, 'TIMEOUT'); assert.equal(result.cases[0].observation, null); assert.equal(result.cases[1].status, 'NOT_REACHED');
  assert.equal(f.signals.length, 0); assert.equal(f.requests.length, 1);
});
test('harness rejects expanded budgets, shared scopes/identities, history and relative executable before launch', async () => {
  for (const variant of ['budget', 'scope', 'identity', 'history', 'executable']) {
    const f = fixture(); const j = jobs();
    if (variant === 'budget') j.exit.max_wall_clock_sec = 2;
    if (variant === 'scope') j.abort.task_scope = j.exit.task_scope;
    if (variant === 'identity') j.abort.job_id = j.exit.job_id;
    if (variant === 'history') j.exit.fenced_history_ref = 'historical';
    await assert.rejects(runDirectChildAcceptance({...f.input, jobs: j, ...(variant === 'executable' ? {executable: 'node'} : {})}));
    assert.equal(f.requests.length, 0);
  }
});

test('task-timeout cancellation cannot substitute for the requested abort callback', async () => {
  const f = fixture({skipAbort: true, lateSelfExit: true});
  const pending = runDirectChildAcceptance(f.input); await f.time.advance(1500); const result = await pending;
  assert.equal(result.status, 'FAIL'); assert.equal(result.cases[1].observation.canceled, true);
  assert.equal(result.cases[1].observation.termination_reason, 'timeout');
});
