import test from 'node:test';
import assert from 'node:assert/strict';
import {createKnownCustodyCoordinator} from '../src/known-custody-coordinator.mjs';
import {createManagerCustodyFactory, createAsyncStopManagerCustodyFactory, HOST_GATES} from '../src/manager-custody.mjs';
import {createManagerObservationBridge} from '../src/manager-observation-bridge.mjs';
import {encodeStopUnitRequest, captureStopJobReply, decodeStopJobRemoved} from '../src/stop-unit-codec.mjs';
import {spec, managerSpec} from './fixtures.mjs';

function fixture({unstarted = false, asyncStop = false, onReadCancel, onTimerCancel, scheduleThrows = false} = {}) {
  let time = 0; const timers = [], calls = [], reads = []; let stopComplete;
  const clock = {now: () => time, schedule(delay, fn) {if (scheduleThrows) throw new Error('PRIVATE_SCHEDULE'); const t = {at: time + delay, fn, active: true}; timers.push(t); return () => {t.active = false; onTimerCancel?.();};}};
  const job = {...managerSpec(), max_wall_clock_sec: 1};
  const binding = {job_id: job.job_id, unit_name: `squire-coordinator-${job.job_id}.service`, invocation_id: '1'.repeat(32)};
  const manager = {startTransientUnit() {calls.push('start'); return {binding, custody_acknowledged: true, worker_in_cgroup_before_exec: true};},
    stopUnit(request) {calls.push('stop'); assert.deepEqual(request.binding, binding);
      return asyncStop ? new Promise(resolve => {stopComplete = resolve;}) : {binding, job_acknowledged: true};}};
  const options = {manager, clock: asyncStop ? clock : {now: clock.now}, qualification: Object.fromEntries(HOST_GATES.map(k => [k, true]))};
  const factory = asyncStop ? createAsyncStopManagerCustodyFactory({...options, stop_ack_timeout_ms: 100}) : createManagerCustodyFactory(options);
  const session = factory.create(job, {executable: '/fixture/node', args: [], env: {TMPDIR: job.task_scope}, stdio: ['ignore', 'ignore', 'ignore']},
    {unit_name: binding.unit_name, stop_grace_ms: 50});
  if (!unstarted) session.start();
  const source = {nextEvent(request) {return new Promise((resolve, reject) => {
    reads.push({request, resolve, reject}); request.signal.addEventListener('abort', () => onReadCancel?.(session, n => {time = n;}), {once: true});
  });}};
  const create = (read_timeout_ms = 1000) => createKnownCustodyCoordinator({session, source, clock, read_timeout_ms});
  const event = (type, value) => ({type, value: {binding, ...value}});
  return {session, create, source, clock, calls, reads, binding, stopComplete: response => stopComplete(response),
    event, setTime: n => {time = n;}, fire() {const t = timers.find(t => t.active && t.at <= time); if (t) {t.active = false; t.fn();}},
    active: () => timers.filter(t => t.active).length};
}

test('known-custody coordinator requires existing ACK and never starts a session or observation itself', () => {
  const f = fixture({unstarted: true}); assert.throws(() => f.create(), /custody_not_acknowledged/);
  assert.deepEqual(f.calls, []); assert.equal(f.reads.length, 0);
  const g = fixture(); const c = g.create(); assert.deepEqual(g.calls, ['start']); assert.equal(g.reads.length, 0);
  assert.throws(() => g.create(), /deadline_driver_in_progress/); c.abort();
});
test('coherent fake native-exit/empty/release flow composes existing session, bridge and deadline driver', async () => {
  const f = fixture(); const c = f.create(); const raw = c.readNext();
  f.reads[0].resolve(f.event('native_exit', {code: 0})); assert.equal((await raw).state.process_exit_code, 0);
  assert.equal(c.reconcile(), null); const empty = c.readNext();
  f.reads[1].resolve(f.event('cgroup', {populated: 0, launch_closed: true, coverage_complete: true, exact_live_count: null}));
  assert.equal((await empty).state.settlement_status, 'CLEAN'); assert.equal(c.reconcile(), null);
  assert.equal(f.session.releaseWorkspace(), true); c.reconcile(); const r = await c.result;
  assert.equal(r.status, 'RELEASED'); assert.equal(r.state.process_exit_code, 0); assert.equal(f.active(), 0);
  assert.equal(Object.hasOwn(r, 'record'), false); assert.deepEqual(f.calls, ['start']);
});
test('idle original deadline completes coordinator without starting a read or resetting task budget', async () => {
  const f = fixture(); const c = f.create(); f.setTime(1000); f.fire(); const r = await c.result;
  assert.equal(r.status, 'DEADLINE'); assert.equal(r.state.task_deadline_ms, 1000); assert.equal(r.state.custody_acknowledged, true);
  assert.equal(r.state.settlement_status, 'UNKNOWN'); assert.equal(f.reads.length, 0); assert.deepEqual(f.calls, ['start', 'stop']);
});
test('deadline response passively closes pending read and dispatches no duplicate stop', async () => {
  const f = fixture(); const c = f.create(); const read = c.readNext(); f.setTime(1000); f.fire();
  const r = await c.result; assert.equal(r.status, 'DEADLINE'); assert.equal(f.reads[0].request.signal.aborted, true);
  assert.equal((await read).status, 'CLOSED'); assert.equal(f.active(), 0); assert.deepEqual(f.calls, ['start', 'stop']);
  assert.throws(() => c.readNext(), /coordinator_returned/); assert.equal(c.abort(), r);
});
test('explicit coordinator abort preserves first cancellation and terminates only local observation', async () => {
  const f = fixture(); const c = f.create(); const read = c.readNext(); c.abort(); const r = await c.result;
  assert.equal(r.status, 'CANCELED'); assert.equal(r.state.cancellation_reason, 'aborted'); await read;
  assert.equal(f.reads[0].request.signal.aborted, true); assert.deepEqual(f.calls, ['start', 'stop']); assert.equal(f.active(), 0);
});
test('producer failure fences coordination without turning failure into user cancellation', async () => {
  const f = fixture(); const c = f.create(); const read = c.readNext(); f.reads[0].reject(new Error('PRIVATE_SOURCE'));
  assert.equal((await read).status, 'READ_FAILED'); const r = await c.result;
  assert.equal(r.status, 'FENCED'); assert.equal(r.state.canceled, false); assert.equal(JSON.stringify(r).includes('PRIVATE'), false);
  assert.deepEqual(f.calls, ['start']); assert.equal(f.active(), 0);
});
test('manager disconnect fences without synthetic cancellation or teardown on an untrusted epoch', async () => {
  const f = fixture(); const c = f.create(); const read = c.readNext(); f.reads[0].resolve(f.event('manager_disconnected', {}));
  await read; const r = await c.result; assert.equal(r.status, 'FENCED'); assert.equal(r.state.canceled, false);
  assert.equal(r.state.custody_acknowledged, false); assert.deepEqual(f.calls, ['start']);
});
test('short read deadline remains observation uncertainty and cancels independent task timer', async () => {
  const f = fixture(); const c = f.create(50); const read = c.readNext(); f.setTime(50); f.fire();
  await read; const r = await c.result; assert.equal(r.status, 'FENCED'); assert.equal(r.state.canceled, false);
  assert.equal(r.state.task_deadline_ms, 1000); assert.equal(f.active(), 0);
});
test('late source fulfillment cannot rewrite delivered coordinator snapshot or release workspace', async () => {
  const f = fixture(); const c = f.create(); const read = c.readNext(); c.abort(); const old = await c.result; await read;
  f.reads[0].resolve(f.event('cgroup', {populated: 0, launch_closed: true, coverage_complete: true, exact_live_count: 0}));
  await Promise.resolve(); await Promise.resolve(); assert.equal(c.reconcile(), old);
  assert.equal(f.session.snapshot().workspace_reuse_blocked, true); assert.equal(old.state.settlement_status, 'UNKNOWN');
});
test('release with read pending closes only observation and retains immutable released state', async () => {
  const f = fixture(); const c = f.create(); const read = c.readNext();
  f.session.observe({binding: f.binding, populated: 0, launch_closed: true, coverage_complete: true, exact_live_count: 0});
  f.session.releaseWorkspace(); c.reconcile(); const r = await c.result; await read;
  assert.equal(r.status, 'RELEASED'); assert.equal(r.state.canceled, false); assert.equal(f.active(), 0);
});
test('overlapping coordinator reads fail before a second producer request', async () => {
  const f = fixture(); const c = f.create(); const read = c.readNext(); assert.throws(() => c.readNext(), /observation_read_in_progress/);
  assert.equal(f.reads.length, 1); c.abort(); await read; await c.result;
});
test('known custody composes async StopUnit codec ACK without caller response claiming settlement', async () => {
  const f = fixture({asyncStop: true}); const c = f.create(); c.abort(); const r = await c.result;
  assert.equal(r.state.stop_ack_pending, true); assert.equal(r.state.settlement_status, 'UNKNOWN');
  const request = encodeStopUnitRequest({binding: f.binding, manager_owner: ':1.42', job_mode: 'fail'});
  const receipt = captureStopJobReply({binding: request.binding, manager_owner: ':1.42', request_serial: 7},
    {sender: ':1.42', reply_serial: 7, signature: 'o', body: ['/org/freedesktop/systemd1/job/23']});
  const ack = decodeStopJobRemoved(receipt, {sender: ':1.42', path: '/org/freedesktop/systemd1', interface: 'org.freedesktop.systemd1.Manager',
    member: 'JobRemoved', signature: 'uoss', body: [23, receipt.job_path, f.binding.unit_name, 'done']});
  f.stopComplete(ack.response); await f.session.stopAcknowledgement(); assert.equal(f.session.snapshot().stop_job_acknowledged, true);
  assert.equal(f.session.snapshot().workspace_reuse_blocked, true); assert.equal(r.state.stop_job_acknowledged, false);
});
test('passive bridge close resolves read without setting task cancellation or making cleanup claims', async () => {
  const f = fixture(); const b = createManagerObservationBridge({session: f.session, source: f.source, clock: f.clock, read_timeout_ms: 500});
  const read = b.readNext(); const closed = b.close(); assert.equal(closed.status, 'CLOSED'); assert.equal((await read).status, 'CLOSED');
  assert.equal(f.session.snapshot().canceled, false); assert.equal(f.session.snapshot().workspace_reuse_blocked, true);
  assert.equal((await b.readNext()).status, 'FENCED'); b.close(); assert.equal(f.active(), 0); assert.deepEqual(f.calls, ['start']);
});
test('observer-cancellation side effects remain visible in final coordinator response', async () => {
  const f = fixture({onReadCancel(session) {session.disconnected();}}); const c = f.create(); const read = c.readNext(); c.abort();
  const r = await c.result; await read; assert.equal(r.status, 'FENCED'); assert.equal(r.state.canceled, true);
  assert.equal(r.state.custody_acknowledged, false); assert.equal(r.state.admission_quarantined, true);
});

test('reentrant abort during driver cancellation cannot publish a provisional pre-fence result', async () => {
  let c, once = false;
  const f = fixture({onTimerCancel() {if (!once) {once = true; c.abort(); throw new Error('PRIVATE_CANCEL');}}});
  c = f.create(); f.setTime(1000); c.reconcile(); const r = await c.result;
  assert.equal(r.status, 'FENCED'); assert.equal(r.state.admission_quarantined, true);
  assert.equal(r.state.canceled, true); assert.equal(r.state.custody_acknowledged, false);
  assert.equal(JSON.stringify(r).includes('PRIVATE'), false); assert.equal(f.active(), 0);
});
test('abort before coordinator response preserves intent even if driver already committed a scheduling failure', async () => {
  const f = fixture({scheduleThrows: true}); const c = f.create(); c.abort(); const r = await c.result;
  assert.equal(r.status, 'FENCED'); assert.equal(r.state.canceled, true); assert.equal(r.state.cancellation_reason, 'aborted');
  assert.equal(r.state.admission_quarantined, true); assert.equal(f.reads.length, 0);
});
