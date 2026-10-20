import test from 'node:test';
import assert from 'node:assert/strict';
import {createStartupOperation, createStartupWaiter} from '../src/startup-operation.mjs';
import {finalizeLifecycle} from '../src/lifecycle.mjs';
import {spec} from './fixtures.mjs';

let sequence = 0;
function clock() {
  let time = 0; const timers = [];
  return {now: () => time, set: n => {time = n;},
    schedule(delay, fn) {const timer = {at: time + delay, fn, active: true}; timers.push(timer); return () => {timer.active = false;};},
    fire(force = false) {const timer = timers.find(t => t.active && (force || t.at <= time));
      if (timer) {timer.active = false; timer.fn();}},
    active: () => timers.filter(t => t.active).length};
}
function fixture(seconds = 1, config = {}) {
  const id = ++sequence, c = clock();
  const job = {...spec(), job_id: `12345678-1234-4abc-8def-${id.toString(16).padStart(12, '0')}`,
    task_scope: `/fixture/start-${id}`, max_wall_clock_sec: seconds};
  const policy = {unit_name: `squire-start-${id}.service`, task_scope: job.task_scope};
  const options = {spec: job, policy, clock: {now: () => {config.clockHook?.(); return c.now();}}, task_deadline_ms: seconds * 1000};
  const operation = createStartupOperation(options);
  const ack = () => ({binding: {job_id: job.job_id, unit_name: policy.unit_name, invocation_id: '1'.repeat(32)},
    custody_acknowledged: true, worker_in_cgroup_before_exec: true});
  const wait = (ms = 50, wc = {now: c.now, schedule: c.schedule}) => createStartupWaiter(operation, {clock: wc, caller_wait_ms: ms});
  return {c, job, policy, options, operation, ack, wait};
}

test('TC-START-01 local non-admission is irrevocable and releases only the local undispatched reservation', async () => {
  const f = fixture(); f.operation.markNotAdmitted('spec_invalid');
  const r = await f.wait().result; assert.equal(r.status, 'NOT_ADMITTED');
  assert.equal(r.operation_snapshot.dispatch_attempted, false); assert.equal(r.operation_snapshot.workspace_quarantined, false);
  assert.equal(r.operation_snapshot.epoch, null);
  const next = createStartupOperation(f.options); assert.equal(next.snapshot().phase, 'NOT_DISPATCHED');
  next.markNotAdmitted('not_used');
});
test('TC-START-02 non-admission after possible dispatch is forbidden', () => {
  const f = fixture(); f.operation.markDispatchAttempted();
  assert.throws(() => f.operation.markNotAdmitted('too_late'), /illegal_transition/);
  assert.equal(f.operation.snapshot().workspace_quarantined, true);
});
test('TC-START-03 exact complete ACK binds epoch and notifies a pending waiter', async () => {
  const f = fixture(); f.operation.markDispatchAttempted(); const waiter = f.wait();
  f.operation.applyStartAck(f.ack()); const r = await waiter.result;
  assert.equal(r.status, 'ACK_CONFIRMED'); assert.equal(r.operation_snapshot.custody_acknowledged, true);
  assert.equal(r.operation_snapshot.workspace_quarantined, true); assert.equal(f.c.active(), 0);
});
test('TC-START-04 caller wait expiration leaves owner unresolved and quarantined', async () => {
  const f = fixture(); f.operation.markDispatchAttempted(); const waiter = f.wait(); f.c.set(50); f.c.fire();
  const r = await waiter.result; assert.equal(r.status, 'CALLER_WAIT_EXPIRED');
  assert.equal(f.operation.snapshot().phase, 'DISPATCH_IN_FLIGHT'); assert.equal(f.operation.snapshot().cancellation_latched, false);
  assert.equal(f.operation.snapshot().task_deadline_ms, 1000); assert.equal(f.c.active(), 0);
});
test('TC-START-05 late ACK after caller return updates only owner and a subsequent waiter', async () => {
  const f = fixture(); f.operation.markDispatchAttempted(); const first = f.wait(); f.c.set(50); f.c.fire();
  const old = await first.result; f.c.set(60); f.operation.applyStartAck(f.ack());
  assert.equal(old.operation_snapshot.epoch, null); assert.equal(old.status, 'CALLER_WAIT_EXPIRED');
  assert.equal((await f.wait().result).status, 'ACK_CONFIRMED'); assert.equal(f.operation.snapshot().task_deadline_ms, 1000);
});
test('TC-START-06 manager rejection is not proof of non-dispatch and cannot clear quarantine', async () => {
  const f = fixture(); f.operation.markDispatchAttempted(); f.operation.applyDispatchFailure('manager_rejected');
  const r = await f.wait().result; assert.equal(r.status, 'UNRESOLVED_FENCED');
  assert.equal(r.operation_snapshot.dispatch_attempted, true); assert.equal(r.operation_snapshot.epoch, null);
  assert.equal(r.operation_snapshot.workspace_quarantined, true);
});
test('TC-START-07 original task deadline latches cancellation without settling unknown dispatch', () => {
  const f = fixture(); f.operation.markDispatchAttempted(); f.c.set(1000); const s = f.operation.tick();
  assert.equal(s.phase, 'DISPATCH_IN_FLIGHT'); assert.equal(s.cancellation_latched, true);
  assert.equal(s.cancellation_reason, 'deadline'); assert.equal(s.epoch, null);
});
test('TC-START-08 caller abort latches intent without dispatch, stop or final-record API', () => {
  const f = fixture(); f.operation.markDispatchAttempted(); f.operation.abort('user_abort');
  const s = f.operation.snapshot(); assert.equal(s.cancellation_latched, true); assert.equal(s.cancellation_reason, 'user_abort');
  assert.equal(s.phase, 'DISPATCH_IN_FLIGHT'); assert.equal(s.workspace_quarantined, true);
  for (const name of ['start', 'stopUnit', 'startTransientUnit', 'releaseWorkspace', 'finalizeLifecycle']) assert.equal(Object.hasOwn(f.operation, name), false);
});
test('TC-START-09 late ACK binds identity but cannot undo deadline cancellation', () => {
  const f = fixture(); f.operation.markDispatchAttempted(); f.c.set(1000); f.operation.applyStartAck(f.ack());
  const s = f.operation.snapshot(); assert.equal(s.phase, 'ACK_CONFIRMED'); assert.equal(s.cancellation_latched, true);
  assert.equal(s.cancellation_reason, 'deadline'); assert.deepEqual(s.epoch, f.ack().binding); assert.equal(s.workspace_quarantined, true);
});
test('TC-START-10 malformed or incomplete ACK cannot imply custody', () => {
  for (const patch of [a => ({...a, binding: {...a.binding, invocation_id: '0'.repeat(32)}}),
    a => ({...a, custody_acknowledged: false}), a => ({...a, worker_in_cgroup_before_exec: false}),
    a => ({binding: a.binding}), a => ({...a, extra: true})]) {
    const f = fixture(); f.operation.markDispatchAttempted(); f.operation.applyStartAck(patch(f.ack()));
    const s = f.operation.snapshot(); assert.equal(s.phase, 'UNRESOLVED_FENCED'); assert.equal(s.epoch, null);
    assert.equal(s.custody_acknowledged, false); assert.equal(s.workspace_quarantined, true);
  }
});
test('TC-START-11 mismatched job/unit binding fences operation', () => {
  for (const key of ['unit_name', 'job_id']) {
    const f = fixture(); f.operation.markDispatchAttempted(); const a = f.ack();
    a.binding[key] = key === 'unit_name' ? 'squire-wrong.service' : 'different'; f.operation.applyStartAck(a);
    assert.equal(f.operation.snapshot().phase, 'UNRESOLVED_FENCED'); assert.equal(f.operation.snapshot().epoch, null);
  }
});
test('TC-START-12 unresolved timeout/abort/error never creates identity or teardown capability', () => {
  const f = fixture(); f.operation.markDispatchAttempted(); f.operation.abort('user_abort'); f.c.set(2000); f.operation.tick();
  f.operation.applyDispatchFailure('transport_lost'); const s = f.operation.snapshot();
  assert.equal(s.epoch, null); assert.equal(s.workspace_quarantined, true);
  for (const name of ['process_group_allocated', 'process_exit_code', 'settlement_status', 'record', 'coordinator_returned']) assert.equal(Object.hasOwn(s, name), false);
});
test('TC-START-13 startup owner/snapshot cannot be passed as a legacy finalizable lifecycle', () => {
  const f = fixture(); f.operation.markDispatchAttempted();
  assert.throws(() => finalizeLifecycle(f.operation, {}), /unrecognized_lifecycle/);
  assert.throws(() => finalizeLifecycle(f.operation.snapshot(), {}), /unrecognized_lifecycle/);
});
test('TC-START-14 multiple caller waits never reset original task deadline or discard owner reservation', async () => {
  const f = fixture(600); f.operation.markDispatchAttempted();
  for (const n of [2000, 4000]) {const waiter = f.wait(2000); f.c.set(n); f.c.fire(); assert.equal((await waiter.result).status, 'CALLER_WAIT_EXPIRED');}
  assert.equal(f.operation.tick().task_deadline_ms, 600000);
  assert.throws(() => createStartupOperation({...f.options, task_deadline_ms: 604000}), /startup_reservation/);
});
test('TC-START-15 disconnect fence cannot be revived by a late valid ACK', () => {
  const f = fixture(); f.operation.markDispatchAttempted(); f.operation.applyDispatchFailure('dbus_disconnected');
  f.operation.applyStartAck(f.ack()); const s = f.operation.snapshot();
  assert.equal(s.phase, 'UNRESOLVED_FENCED'); assert.equal(s.custody_acknowledged, false); assert.equal(s.epoch, null);
});
test('TC-START-16 snapshots and captured epoch are immutable and input mutation is isolated', () => {
  const f = fixture(); f.operation.markDispatchAttempted(); const old = f.operation.snapshot(), ack = f.ack(); f.operation.applyStartAck(ack);
  ack.binding.invocation_id = '2'.repeat(32); const s = f.operation.snapshot();
  assert.equal(s.epoch.invocation_id, '1'.repeat(32)); assert.equal(old.epoch, null);
  assert.throws(() => {s.epoch.unit_name = 'changed';}, TypeError);
  assert.throws(() => {s.failure_reasons.push('changed');}, TypeError);
});
test('ACK before dispatch, dispatch repeats and post-NOT_ADMITTED revival are rejected', () => {
  const f = fixture(); assert.throws(() => f.operation.applyStartAck(f.ack()), /ack_before_dispatch/);
  assert.throws(() => f.operation.applyDispatchFailure('early'), /failure_before_dispatch/);
  f.operation.markDispatchAttempted(); assert.throws(() => f.operation.markDispatchAttempted(), /illegal_transition/);
  const g = fixture(); g.operation.markNotAdmitted('gate_failed');
  assert.throws(() => g.operation.applyStartAck(g.ack()), /ack_before_dispatch/);
  assert.throws(() => g.operation.markDispatchAttempted(), /illegal_transition/); assert.equal(g.operation.snapshot().phase, 'NOT_ADMITTED');
});
test('exact repeated ACK is idempotent but conflicting epoch irreversibly revokes custody', () => {
  const f = fixture(); f.operation.markDispatchAttempted(); f.operation.applyStartAck(f.ack()); const old = f.operation.snapshot();
  f.operation.applyStartAck(f.ack()); assert.deepEqual(f.operation.snapshot(), old);
  const conflict = f.ack(); conflict.binding.invocation_id = '2'.repeat(32); f.operation.applyStartAck(conflict);
  assert.equal(f.operation.snapshot().phase, 'UNRESOLVED_FENCED'); assert.equal(f.operation.snapshot().custody_acknowledged, false);
  assert.deepEqual(f.operation.snapshot().epoch, old.epoch);
});
test('abort before dispatch prevents future dispatch and first cancellation reason stays latched', () => {
  const f = fixture(); f.operation.abort('user_abort'); f.c.set(1000); f.operation.tick();
  assert.throws(() => f.operation.markDispatchAttempted(), /dispatch_after_cancellation/);
  assert.equal(f.operation.snapshot().cancellation_reason, 'user_abort');
});
test('same-process unit/job/overlapping workspace cannot be reused by another owner', () => {
  const f = fixture(); f.operation.markDispatchAttempted();
  for (const patch of [{}, {spec: {...f.job, task_scope: f.job.task_scope + '/nested'},
    policy: {...f.policy, task_scope: f.job.task_scope + '/nested'}}]) {
    assert.throws(() => createStartupOperation({...f.options, ...patch}), /startup_reservation/);
  }
});
test('deadline must match original request time and budget, not an arbitrary supplied extension', () => {
  const f = fixture(); assert.throws(() => createStartupOperation({...f.options, task_deadline_ms: 1001}), /startup_budget/);
  assert.throws(() => createStartupOperation({...f.options, start_dispatch() {throw new Error('UNEXPECTED');}}));
  assert.throws(() => f.wait(0), /caller_wait_ms/);
});
test('malformed ACK getters and proxies are not evaluated or echoed', () => {
  const f = fixture(); f.operation.markDispatchAttempted(); let calls = 0;
  const ack = f.ack(); Object.defineProperty(ack, 'binding', {get() {calls++; throw new Error('PRIVATE');}});
  f.operation.applyStartAck(ack); assert.equal(calls, 0); assert.equal(JSON.stringify(f.operation.snapshot()).includes('PRIVATE'), false);
  const g = fixture(); g.operation.markDispatchAttempted();
  g.operation.applyStartAck(new Proxy({}, {ownKeys() {calls++; throw new Error('PRIVATE');}})); assert.equal(calls, 0);
});
test('backwards owner clock fences without invented native/settlement values and preserves abort', () => {
  const f = fixture(); f.operation.markDispatchAttempted(); f.c.set(10); f.operation.tick(); f.c.set(9); f.operation.abort('user_abort');
  assert.equal(f.operation.snapshot().phase, 'UNRESOLVED_FENCED'); assert.equal(f.operation.snapshot().cancellation_reason, 'user_abort');
  assert.equal(f.operation.snapshot().workspace_quarantined, true);
});
test('early caller timer re-arms against the original caller deadline', async () => {
  const f = fixture(); f.operation.markDispatchAttempted(); const w = f.wait(); f.c.set(20); f.c.fire(true);
  assert.equal(f.c.active(), 1); assert.equal(w.reconcile(), null); f.c.set(50); f.c.fire();
  assert.equal((await w.result).caller_waited_ms, 50); assert.equal(f.c.active(), 0);
});
test('ACK after caller budget cannot retroactively satisfy that caller, but remains recorded by owner', async () => {
  const f = fixture(); f.operation.markDispatchAttempted(); const w = f.wait(); f.c.set(60); f.operation.applyStartAck(f.ack());
  const r = await w.result; assert.equal(r.status, 'CALLER_WAIT_EXPIRED'); assert.equal(r.operation_snapshot.phase, 'ACK_CONFIRMED');
});
test('broken caller scheduler rejects only the waiter; owner remains retained and unresolved', async () => {
  const f = fixture(); f.operation.markDispatchAttempted(); let canceled = 0;
  const w = f.wait(50, {now: f.c.now, schedule(delay, fn) {fn(); return () => {canceled++;};}});
  await assert.rejects(w.result, /startup_waiter_observation_failed/); assert.equal(canceled, 1);
  assert.equal(f.operation.snapshot().phase, 'DISPATCH_IN_FLIGHT'); assert.equal(f.operation.snapshot().workspace_quarantined, true);
});
test('ACK arriving reentrantly during schedule setup cancels returned handle without leaking waiter', async () => {
  const f = fixture(); f.operation.markDispatchAttempted(); let canceled = 0;
  const w = f.wait(50, {now: f.c.now, schedule() {f.operation.applyStartAck(f.ack()); return () => {canceled++;};}});
  assert.equal((await w.result).status, 'ACK_CONFIRMED'); assert.equal(canceled, 1);
});
test('timer cancellation side effects cannot hide cancellation or caller-budget overrun', async () => {
  const f = fixture(); f.operation.markDispatchAttempted();
  const w = f.wait(50, {now: f.c.now, schedule() {return () => {f.c.set(60); f.operation.abort('user_abort');};}});
  f.operation.applyStartAck(f.ack()); const r = await w.result;
  assert.equal(r.status, 'CALLER_WAIT_EXPIRED'); assert.equal(r.operation_snapshot.cancellation_latched, true);
});

test('abort intent survives reentrant owner clock during tick or dispatch attempt', () => {
  for (const action of ['tick', 'markDispatchAttempted']) {
    const config = {}, f = fixture(1, config);
    if (action === 'tick') f.operation.markDispatchAttempted();
    config.clockHook = () => {config.clockHook = null; f.operation.abort('user_abort');};
    if (action === 'tick') f.operation.tick();
    else assert.throws(() => f.operation.markDispatchAttempted(), /illegal_transition/);
    const s = f.operation.snapshot();
    assert.equal(s.cancellation_latched, true); assert.equal(s.cancellation_reason, 'user_abort');
    assert.equal(s.phase, 'UNRESOLVED_FENCED'); assert.equal(s.workspace_quarantined, true);
  }
});
