import test from 'node:test';
import assert from 'node:assert/strict';
import {createAsyncStopManagerCustodyFactory, HOST_GATES} from '../src/manager-custody.mjs';
import {createManagerDeadlineDriver} from '../src/manager-deadline-driver.mjs';
import {spec} from './fixtures.mjs';

function fixture(options = {}) {
  let time = 0, resolve, reject; const timers = [], calls = [];
  const clock = {now: () => time, schedule(delay, callback) {
    if (options.scheduleThrows) throw new Error('PRIVATE_SCHEDULE');
    const timer = {at: time + delay, callback, canceled: false}; timers.push(timer);
    if (options.inline) callback();
    return () => {timer.canceled = true; options.cancelHook?.();};
  }};
  const job = {...spec(), max_wall_clock_sec: 1};
  const binding = {job_id: job.job_id, unit_name: 'squire-async-stop.service', invocation_id: '1'.repeat(32)};
  const response = new Promise((yes, no) => {resolve = yes; reject = no;});
  const manager = {startTransientUnit() {calls.push('start'); return {binding, custody_acknowledged: true, worker_in_cgroup_before_exec: true};},
    stopUnit(request) {calls.push({method: 'stop', binding: request.binding}); options.stopHook?.();
      if (options.stopThrows) throw new Error('PRIVATE_STOP'); return response;}};
  const factory = createAsyncStopManagerCustodyFactory({manager, clock, stop_ack_timeout_ms: 100,
    qualification: Object.fromEntries(HOST_GATES.map(key => [key, true]))});
  const session = factory.create(job, {executable: '/fixture/node', args: [], env: {TMPDIR: job.task_scope},
    stdio: ['ignore', 'ignore', 'ignore']}, {unit_name: binding.unit_name, stop_grace_ms: 50});
  session.start();
  const observe = populated => session.observe({binding, populated, launch_closed: true, coverage_complete: true, exact_live_count: null});
  const ack = (changes = {}) => resolve({binding, job_acknowledged: true, ...changes});
  async function flush() {for (let i = 0; i < 12; i++) await Promise.resolve();}
  return {session, calls, timers, binding, clock, observe, ack, reject, flush, setTime: n => {time = n;},
    async advance(n) {
      await flush();
      while (true) {
        const timer = timers.filter(t => !t.canceled && t.at <= n).sort((a,b) => a.at-b.at)[0];
        if (!timer) break; time = timer.at; timer.canceled = true; timer.callback(); await flush();
      }
      time = n; await flush();
    }};
}

test('pending StopUnit response is not job acknowledgement or cleanup evidence', async () => {
  const f = fixture(); assert.equal(f.session.stopAcknowledgement(), null); const pending = f.session.settle();
  assert.equal(pending.stop_ack_pending, true); assert.equal(pending.stop_job_acknowledged, false);
  assert.equal(pending.custody_acknowledged, true); assert.equal(pending.settlement_status, 'UNKNOWN');
  f.ack(); const r = await f.session.stopAcknowledgement(); assert.equal(r.status, 'ACKNOWLEDGED');
  const s = f.session.snapshot(); assert.equal(s.stop_ack_pending, false); assert.equal(s.stop_job_acknowledged, true);
  assert.equal(s.live_count, null); assert.equal(s.workspace_reuse_blocked, true);
});
test('an empty sample collected before stop ACK cannot release workspace or become post-stop proof', async () => {
  const f = fixture(); f.session.settle(); const pre = f.observe(0);
  assert.equal(pre.live_count, 0); assert.equal(pre.settlement_status, 'UNKNOWN'); assert.equal(f.session.releaseWorkspace(), false);
  f.ack(); await f.session.stopAcknowledgement(); assert.equal(f.session.snapshot().live_count, null);
  assert.equal(f.session.releaseWorkspace(), false);
  assert.equal(f.observe(0).settlement_status, 'ORPHAN_KILLED'); assert.equal(f.session.releaseWorkspace(), true);
  assert.equal(pre.settlement_status, 'UNKNOWN');
});
test('task deadline returns with known custody while bounded stop ACK observation continues separately', async () => {
  const f = fixture(); const driver = createManagerDeadlineDriver({session: f.session, clock: f.clock});
  await f.advance(1000); const r = await driver.result;
  assert.equal(r.status, 'DEADLINE'); assert.equal(r.state.task_deadline_ms, 1000);
  assert.equal(r.state.custody_acknowledged, true); assert.equal(r.state.stop_ack_pending, true);
  assert.equal(f.timers.at(-1).at, 1100); f.setTime(1050); f.ack(); await f.session.stopAcknowledgement();
  assert.equal(f.observe(0).canceled, true); assert.equal(r.state.settlement_status, 'UNKNOWN');
  assert.equal(f.calls.length, 2);
});
test('missing stop ACK times out as UNKNOWN without retry and ignores late fulfillment', async () => {
  const f = fixture(); f.session.abort(); await f.advance(100); const r = await f.session.stopAcknowledgement();
  assert.equal(r.status, 'UNKNOWN'); const before = f.session.snapshot();
  assert.equal(before.admission_quarantined, true); assert.equal(before.canceled, true);
  f.ack(); await f.flush(); f.session.settle(); f.session.abort();
  assert.equal(f.session.snapshot().stop_job_acknowledged, false); assert.equal(f.calls.length, 2);
  assert.equal(f.session.releaseWorkspace(), false);
});
test('late rejection after timeout is consumed and private text never enters state', async () => {
  const f = fixture(); f.session.settle(); await f.advance(100); await f.session.stopAcknowledgement();
  f.reject(new Error('PRIVATE_LATE_REJECTION')); await f.flush();
  assert.equal(JSON.stringify(f.session.snapshot()).includes('PRIVATE_'), false); assert.equal(f.calls.length, 2);
});
test('reject, malformed acknowledgement and conflicting epoch fence without fallback', async () => {
  for (const mode of ['reject', 'false', 'identity', 'raw_job_path']) {
    const f = fixture(); f.session.settle();
    if (mode === 'reject') f.reject(new Error('PRIVATE_REJECT'));
    else if (mode === 'false') f.ack({job_acknowledged: false});
    else if (mode === 'identity') f.ack({binding: {...f.binding, invocation_id: '2'.repeat(32)}});
    else f.ack({binding: '/org/freedesktop/systemd1/job/1'});
    const r = await f.session.stopAcknowledgement(); assert.equal(r.status, 'UNKNOWN');
    const s = f.session.snapshot(); assert.equal(s.admission_quarantined, true); assert.equal(s.stop_job_acknowledged, false);
    assert.equal(s.settlement_status, 'UNKNOWN'); assert.equal(JSON.stringify(s).includes('PRIVATE_'), false);
    assert.equal(f.calls.length, 2);
  }
});
test('disconnect cancels bounded ACK observation and cannot be undone by a late response', async () => {
  const f = fixture(); f.session.settle(); f.session.disconnected();
  assert.equal((await f.session.stopAcknowledgement()).status, 'UNKNOWN'); assert.equal(f.timers[0].canceled, true);
  f.ack(); await f.flush(); assert.equal(f.session.snapshot().custody_acknowledged, false);
  assert.equal(f.session.snapshot().admission_quarantined, true);
});
test('ACK timer/setup and dispatch errors remain one-shot and do not expose native errors', async () => {
  for (const options of [{scheduleThrows: true}, {inline: true}, {stopThrows: true}]) {
    const f = fixture(options); f.session.settle(); const p = f.session.stopAcknowledgement(); if (p) await p;
    assert.equal(f.session.snapshot().admission_quarantined, true); assert.equal(f.session.snapshot().stop_ack_pending, false);
    assert.equal(JSON.stringify(f.session.snapshot()).includes('PRIVATE_'), false);
    f.session.settle(); assert.equal(f.calls.length, options.stopThrows ? 2 : 1);
    if (options.inline) assert.equal(f.timers[0].canceled, true);
  }
});
test('ACK clock regression retains raw exit and cancellation', async () => {
  const f = fixture(); f.session.nativeExit({binding: f.binding, code: 7}); f.setTime(5); f.session.abort();
  f.setTime(4); f.ack(); const r = await f.session.stopAcknowledgement();
  assert.equal(r.status, 'UNKNOWN'); const s = f.session.snapshot(); assert.equal(s.process_exit_code, 7);
  assert.equal(s.canceled, true); assert.equal(s.admission_quarantined, true);
});
test('early ACK timer callback preserves the original ACK deadline', async () => {
  const f = fixture(); f.session.settle(); f.setTime(50); f.timers[0].canceled = true; f.timers[0].callback();
  assert.equal(f.timers[1].at, 100); f.setTime(99); f.ack();
  assert.equal((await f.session.stopAcknowledgement()).status, 'ACKNOWLEDGED');
});
test('response reaching the exact ACK deadline is not treated as timely', async () => {
  const f = fixture(); f.session.settle(); f.setTime(100); f.ack();
  assert.equal((await f.session.stopAcknowledgement()).status, 'UNKNOWN');
});
test('manager disconnect during stop dispatch cannot be overwritten by returned Promise', async () => {
  const options = {}; const f = fixture(options); options.stopHook = () => f.session.disconnected(); f.session.settle();
  assert.equal((await f.session.stopAcknowledgement()).status, 'UNKNOWN'); f.ack(); await f.flush();
  assert.equal(f.session.snapshot().stop_job_acknowledged, false); assert.equal(f.session.snapshot().admission_quarantined, true);
});
test('positive post-timeout survivors stay truthful while stop acknowledgement is pending', async () => {
  const f = fixture(); f.setTime(1000); f.session.tick(); const leak = f.observe(1);
  assert.equal(leak.settlement_status, 'DIRTY_LEAK'); assert.equal(leak.live_count, null);
  f.ack(); await f.session.stopAcknowledgement(); assert.equal(f.session.snapshot().settlement_status, 'DIRTY_LEAK');
  assert.equal(f.session.snapshot().workspace_reuse_blocked, true);
});
