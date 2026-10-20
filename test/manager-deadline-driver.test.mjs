import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagerCustodyFactory, HOST_GATES} from '../src/manager-custody.mjs';
import {createManagerDeadlineDriver} from '../src/manager-deadline-driver.mjs';
import {createManagerObservationBridge} from '../src/manager-observation-bridge.mjs';
import {spec, managerSpec} from './fixtures.mjs';

function fixture(options = {}) {
  let time = 0; const timers = [], calls = [];
  const clock = {now: () => time, schedule(delay, callback) {
    if (options.scheduleThrows) throw new Error('PRIVATE_SCHEDULE');
    const timer = {at: time + delay, callback, canceled: false}; timers.push(timer);
    if (options.inline) callback();
    if (options.badCancel) return null;
    return () => {
      timer.canceled = true; options.cancelHook?.();
      if (options.cancelThrows) throw new Error('PRIVATE_CANCEL');
    };
  }};
  const job = {...managerSpec(), max_wall_clock_sec: 1};
  const binding = {job_id: job.job_id, unit_name: `squire-deadline-${job.job_id}.service`, invocation_id: '1'.repeat(32)};
  const manager = {startTransientUnit() { calls.push('start'); return {binding,
    custody_acknowledged: true, worker_in_cgroup_before_exec: true}; },
  stopUnit() { calls.push('stop'); if (options.stopThrows) throw new Error('PRIVATE_STOP');
    return {binding, job_acknowledged: true}; }};
  const factory = createManagerCustodyFactory({manager, clock: {now: clock.now},
    qualification: Object.fromEntries(HOST_GATES.map(k => [k, true]))});
  const session = factory.create(job, {executable: '/fixture/node', args: [], env: {TMPDIR: job.task_scope},
    stdio: ['ignore', 'ignore', 'ignore']}, {unit_name: binding.unit_name, stop_grace_ms: 50});
  if (!options.unstarted) session.start();
  const input = {session, clock}; const create = () => createManagerDeadlineDriver(input);
  const observe = (populated) => session.observe({binding, populated, launch_closed: true,
    coverage_complete: true, exact_live_count: null});
  async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
  return {session, input, create, observe, timers, calls, binding, clock, flush, setTime: n => {time = n;},
    async advance(n) {
      await flush();
      while (true) {
        const timer = timers.filter(t => !t.canceled && t.at <= n).sort((a,b) => a.at-b.at)[0];
        if (!timer) break;
        time = timer.at; timer.canceled = true; timer.callback(); await flush();
      }
      time = n; await flush();
    }};
}

test('idle acknowledged session reaches original task deadline without any observation read', async () => {
  const f = fixture(); const driver = f.create(); assert.equal(f.timers.length, 1); assert.equal(f.timers[0].at, 1000);
  await f.advance(1000); const r = await driver.result;
  assert.equal(r.status, 'DEADLINE'); assert.equal(r.state.canceled, true); assert.equal(r.state.cancellation_reason, 'timeout');
  assert.equal(r.state.custody_acknowledged, true); assert.equal(r.state.settlement_status, 'UNKNOWN');
  assert.deepEqual(f.calls, ['start', 'stop']); assert.equal(r.runtime_qualification, 'NOT_ESTABLISHED_BY_SOURCE');
});
test('early timer delivery rearms against original deadline without extending it', async () => {
  const f = fixture(); const driver = f.create(); f.setTime(500); f.timers[0].canceled = true; f.timers[0].callback();
  assert.equal(f.timers[1].at, 1000); await f.advance(1000); assert.equal((await driver.result).status, 'DEADLINE');
});
test('repeated reconciliation and partial observations create no extra timer or reset', async () => {
  const f = fixture(); const driver = f.create();
  f.setTime(100); f.observe(1); assert.equal(driver.reconcile(), null);
  f.setTime(500); f.observe(1); driver.reconcile(); assert.equal(f.timers.length, 1);
  await f.advance(1000); assert.equal((await driver.result).state.task_deadline_ms, 1000);
});
test('abort before deadline is permanent and timer cancellation does not dispatch a second stop', async () => {
  const f = fixture(); const driver = f.create(); const r = driver.abort(); assert.equal(r.status, 'CANCELED');
  assert.equal(r.state.cancellation_reason, 'aborted'); assert.equal(f.timers[0].canceled, true);
  f.setTime(1000); f.timers[0].callback(); driver.abort(); assert.deepEqual(f.calls, ['start', 'stop']);
  assert.deepEqual(await driver.result, r);
});
test('abort intent survives a regressed clock and scheduler result reports quarantine', async () => {
  const f = fixture(); f.setTime(10); const driver = f.create(); f.setTime(9); driver.abort(); const r = await driver.result;
  assert.equal(r.status, 'FENCED'); assert.equal(r.state.canceled, true); assert.equal(r.state.cancellation_reason, 'aborted');
  assert.equal(r.state.admission_quarantined, true);
});
test('verified empty alone keeps task deadline active until explicit workspace release', async () => {
  const f = fixture(); const driver = f.create(); f.observe(0); assert.equal(driver.reconcile(), null);
  assert.equal(f.timers[0].canceled, false); f.session.releaseWorkspace();
  assert.equal(driver.reconcile().status, 'RELEASED'); assert.equal(f.timers[0].canceled, true);
  const r = await driver.result; assert.equal(r.state.canceled, false); assert.equal(r.state.local_workspace_released, true);
});
test('manager disconnect ends local scheduling with UNKNOWN, not successful cleanup', async () => {
  const f = fixture(); const driver = f.create(); f.session.disconnected(); driver.reconcile(); const r = await driver.result;
  assert.equal(r.status, 'FENCED'); assert.equal(r.state.settlement_status, 'UNKNOWN'); assert.equal(r.state.workspace_reuse_blocked, true);
  assert.deepEqual(f.calls, ['start']); assert.equal(f.timers[0].canceled, true);
});
test('later positive/empty custody observations cannot rewrite the returned deadline snapshot', async () => {
  const f = fixture(); const driver = f.create(); await f.advance(1000); const r = await driver.result;
  assert.equal(f.observe(1).settlement_status, 'DIRTY_LEAK'); assert.equal(f.observe(0).settlement_status, 'ORPHAN_KILLED');
  assert.equal(r.state.settlement_status, 'UNKNOWN'); assert.equal(r.state.canceled, true);
  assert.strictEqual(driver.reconcile(), r);
});
test('scheduling throw, invalid cancel handle and inline callback fence without private messages or fallback', async () => {
  for (const options of [{scheduleThrows: true}, {badCancel: true}, {inline: true}]) {
    const f = fixture(options); const driver = f.create(); const r = await driver.result;
    assert.equal(r.status, 'FENCED'); assert.equal(r.state.settlement_status, 'UNKNOWN');
    assert.ok(r.state.failure_codes.includes('custody_scheduler_failed')); assert.equal(JSON.stringify(r).includes('PRIVATE_'), false);
    assert.deepEqual(f.calls, ['start']);
    for (const timer of f.timers) { f.setTime(1000); timer.callback(); }
    assert.deepEqual(f.calls, ['start']);
    if (options.inline) assert.equal(f.timers[0].canceled, true);
  }
});
test('cancel-handle failure preserves abort and fences the session', async () => {
  const f = fixture({cancelThrows: true}); const driver = f.create(); driver.abort(); const r = await driver.result;
  assert.equal(r.state.canceled, true); assert.equal(r.status, 'FENCED'); assert.equal(JSON.stringify(r).includes('PRIVATE_'), false);
});
test('one session cannot have overlapping deadline drivers', async () => {
  const f = fixture(); const driver = f.create(); assert.throws(f.create, /deadline_driver_in_progress/);
  assert.equal(f.timers.length, 1); driver.abort(); await driver.result;
});
test('driver refuses unacknowledged custody without starting anything', () => {
  const f = fixture({unstarted: true}); assert.throws(f.create, /custody_not_acknowledged/);
  assert.equal(f.timers.length, 0); assert.deepEqual(f.calls, []);
});
test('raw native exit survives idle timeout and stop denial without cleanup claims', async () => {
  const f = fixture({stopThrows: true}); const driver = f.create(); f.session.nativeExit({binding: f.binding, code: 7});
  await f.advance(1000); const r = await driver.result; assert.equal(r.state.process_exit_code, 7);
  assert.equal(r.state.canceled, true); assert.equal(r.status, 'FENCED'); assert.equal(r.state.settlement_status, 'UNKNOWN');
  assert.deepEqual(f.calls, ['start', 'stop']);
});
test('observation and driver deadline timers coexist without duplicate StopUnit', async () => {
  const f = fixture(); let resolve;
  const bridge = createManagerObservationBridge({session: f.session, clock: f.clock, read_timeout_ms: 2000,
    source: {nextEvent: () => new Promise(done => {resolve = done;})}});
  const driver = f.create(); const p = bridge.readNext(); await f.advance(1000);
  assert.equal((await driver.result).state.canceled, true); assert.equal((await p).state.canceled, true);
  assert.deepEqual(f.calls, ['start', 'stop']); resolve({type: 'native_exit', value: {binding: f.binding, code: 0}});
  await f.flush(); assert.equal(f.session.snapshot().process_exit_code, null);
});
test('abort during timer cancellation is retained in the final deadline result', async () => {
  const options = {}; const f = fixture(options); const driver = f.create();
  options.cancelHook = () => f.session.abort(); f.session.observe({binding: f.binding, populated: 0,
    launch_closed: true, coverage_complete: true, exact_live_count: null});
  f.setTime(1000); driver.reconcile(); const r = await driver.result;
  assert.equal(r.state.canceled, true); assert.equal(r.state.cancellation_reason, 'timeout'); assert.equal(r.status, 'DEADLINE');
});
