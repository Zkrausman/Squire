import test from 'node:test';
import assert from 'node:assert/strict';
import * as startupFacade from '../src/startup-operation.mjs';
import * as managerFacade from '../src/manager-custody.mjs';
import {createStartupOperation, createStartupWaiter} from '../src/startup-operation.mjs';
import {createManagerCustodyFactory, createAsyncStopManagerCustodyFactory, HOST_GATES} from '../src/manager-custody.mjs';
import {createKnownCustodyCoordinator} from '../src/known-custody-coordinator.mjs';
import {managerSpec} from './fixtures.mjs';

function fixture(config = {}) {
  let time = 0, stopResolve; const calls = [], timers = [];
  const clock = {now() {config.clockHook?.(); return time;}, schedule(delay, fn) {
    const t = {at: time + delay, fn, active: true}; timers.push(t); return () => {t.active = false;};}};
  const spec = {...managerSpec(), max_wall_clock_sec: 1};
  const unit_name = `squire-adopt-${spec.job_id}.service`;
  const operation = createStartupOperation({spec, policy: {unit_name, task_scope: spec.task_scope}, clock: {now: clock.now}, task_deadline_ms: 1000});
  const ack = () => ({binding: {job_id: spec.job_id, unit_name, invocation_id: '1'.repeat(32)}, custody_acknowledged: true, worker_in_cgroup_before_exec: true});
  const invocation = {executable: '/fixture/node', args: [], env: {TMPDIR: spec.task_scope}, stdio: ['ignore', 'ignore', 'ignore']};
  const policy = {unit_name, stop_grace_ms: 50};
  const manager = {startTransientUnit() {calls.push('start'); return ack();}, stopUnit(request) {calls.push({method: 'stop', binding: request.binding});
    return config.asyncStop ? new Promise(resolve => {stopResolve = resolve;}) : {binding: request.binding, job_acknowledged: true};}};
  const qualification = Object.fromEntries(HOST_GATES.map(key => [key, true]));
  const factory = (override = {}) => {
    const options = {manager, clock: config.asyncStop ? clock : {now: clock.now}, qualification, ...override};
    return config.asyncStop ? createAsyncStopManagerCustodyFactory({...options, stop_ack_timeout_ms: 100}) : createManagerCustodyFactory(options);
  };
  const f = factory();
  const adopt = (overrides = {}) => f.adoptStartupOperation(operation, overrides.spec ?? spec, overrides.invocation ?? invocation, overrides.policy ?? policy);
  const ready = () => {operation.markDispatchAttempted(); operation.applyStartAck(ack());};
  const empty = session => session.observe({binding: ack().binding, populated: 0, launch_closed: true, coverage_complete: true, exact_live_count: null});
  return {operation, spec, invocation, policy, manager, qualification, factory, f, adopt, ready, ack, empty, calls, clock, timers,
    setTime: value => {time = value;}, resolveStop: value => stopResolve(value)};
}

test('NEG-01 fake, proxied and snapshot-only startup capabilities fail without evaluating traps or dispatching', () => {
  const f = fixture(); let traps = 0;
  for (const fake of [{snapshot: () => ({phase: 'ACK_CONFIRMED'})}, f.operation.snapshot(),
    new Proxy(f.operation, {get() {traps++; throw new Error('PRIVATE');}})]) {
    assert.throws(() => f.f.adoptStartupOperation(fake, f.spec, f.invocation, f.policy), /startup_capability/);
  }
  assert.equal(traps, 0); assert.deepEqual(f.calls, []); assert.equal(f.operation.snapshot().adopted, false);
});
test('NEG-02 full original JobSpec mismatch does not consume the authentic operation', () => {
  const f = fixture(); f.ready();
  for (const change of [{provider_id: 'agy_gemini'}, {requested_model: 'other'}, {max_steps: 2}, {max_wall_clock_sec: 2},
    {required_artifacts: ['another.txt']}, {fenced_history_ref: 'new-history'}]) {
    assert.throws(() => f.adopt({spec: {...f.spec, ...change}}), /job_spec_mismatch/);
    assert.equal(f.operation.snapshot().adopted, false);
  }
  assert.equal(f.adopt().snapshot().custody_acknowledged, true); assert.deepEqual(f.calls, []);
});
test('NEG-03 second adoption across factories is rejected and original target remains sole controller', () => {
  const f = fixture(); f.ready(); const session = f.adopt();
  assert.throws(() => f.factory().adoptStartupOperation(f.operation, f.spec, f.invocation, f.policy), /startup_already_adopted/);
  assert.equal(f.operation.snapshot().adopted, true); assert.equal(session.snapshot().started, true);
  session.start(); assert.deepEqual(f.calls, []);
});
test('NEG-04 adoption past original deadline latches timeout without stop until post-commit driver', async () => {
  const f = fixture(); f.ready(); f.setTime(1000); const session = f.adopt();
  assert.equal(f.operation.snapshot().cancellation_reason, 'deadline'); assert.equal(session.snapshot().cancellation_reason, 'timeout');
  assert.equal(session.snapshot().task_deadline_ms, 1000); assert.deepEqual(f.calls, []);
  const c = createKnownCustodyCoordinator({session, source: {nextEvent() {throw new Error('UNEXPECTED');}}, clock: f.clock, read_timeout_ms: 100});
  const r = await c.result; assert.equal(r.status, 'DEADLINE'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'stop');
});
test('NEG-05 prior abort provenance survives deadline and maps to standard aborted reason', () => {
  const f = fixture(); f.ready(); f.operation.abort('user_cancel'); f.setTime(1000); const session = f.adopt();
  assert.equal(f.operation.snapshot().cancellation_reason, 'user_cancel'); assert.equal(session.snapshot().cancellation_reason, 'aborted');
  assert.ok(session.snapshot().failure_codes.includes('startup_cancellation_user_cancel')); assert.deepEqual(f.calls, []);
});
test('NEG-06 global factory reservations reject overlapping create/startup and preserve original owner', () => {
  const f = fixture(); f.ready(); f.adopt(); const other = f.factory();
  const spec = {...managerSpec(), task_scope: f.spec.task_scope + '/nested'};
  const policy = {...f.policy, unit_name: `squire-other-${spec.job_id}.service`};
  assert.throws(() => other.create(spec, {...f.invocation, env: {TMPDIR: spec.task_scope}}, policy), /custody_reservation/);
  assert.throws(() => createStartupOperation({spec, policy: {unit_name: policy.unit_name, task_scope: spec.task_scope}, clock: {now: f.clock.now}, task_deadline_ms: 300000}), /startup_reservation/);
  assert.equal(f.operation.snapshot().adopted, true);
});
test('NEG-07 only target-private canonical complete empty proof releases both workspace scopes', () => {
  const f = fixture(); f.ready(); const session = f.adopt();
  for (const flags of [{launch_closed: false}, {coverage_complete: false}]) {
    session.observe({binding: f.ack().binding, populated: 0, launch_closed: true, coverage_complete: true, exact_live_count: null, ...flags});
    assert.equal(session.releaseWorkspace(), false); assert.equal(f.operation.snapshot().workspace_quarantined, true);
  }
  f.empty(session); assert.equal(session.snapshot().live_count, 0); assert.equal(session.releaseWorkspace(), true);
  assert.equal(f.operation.snapshot().workspace_quarantined, true);
  const spec = {...managerSpec(), task_scope: f.spec.task_scope};
  const next = f.factory().create(spec, f.invocation, {...f.policy, unit_name: `squire-reuse-${spec.job_id}.service`});
  assert.equal(next.snapshot().started, false); assert.equal(session.releaseWorkspace(), false);
  // Repeating the old release cannot erase the new occupant's reservation.
  const third = {...managerSpec(), task_scope: f.spec.task_scope};
  assert.throws(() => f.factory().create(third, f.invocation, {...f.policy, unit_name: `squire-third-${third.job_id}.service`}), /custody_reservation/);
});
test('NEG-08 post-adoption source ACK conflict permanently fences target without losing raw exit', () => {
  const f = fixture(); f.ready(); const session = f.adopt(); session.nativeExit({binding: f.ack().binding, code: 7});
  const ack = f.ack(); ack.binding.invocation_id = '2'.repeat(32); f.operation.applyStartAck(ack);
  assert.equal(f.operation.snapshot().phase, 'UNRESOLVED_FENCED'); assert.equal(session.snapshot().settlement_status, 'UNKNOWN');
  assert.equal(session.snapshot().process_exit_code, 7); assert.equal(session.snapshot().custody_acknowledged, false);
  f.empty(session); assert.equal(session.releaseWorkspace(), false); assert.deepEqual(f.calls, []);
});
test('genuine ACK adopts into PR156 fake coordinator without a second start and preserves deadline/epoch', async () => {
  const f = fixture(); f.ready(); f.setTime(20); const session = f.adopt(); let deliver;
  const c = createKnownCustodyCoordinator({session, source: {nextEvent() {return new Promise(resolve => {deliver = resolve;});}}, clock: f.clock, read_timeout_ms: 100});
  let read = c.readNext(); deliver({type: 'native_exit', value: {binding: f.ack().binding, code: 0}}); await read;
  read = c.readNext(); deliver({type: 'cgroup', value: {binding: f.ack().binding, populated: 0, launch_closed: true, coverage_complete: true, exact_live_count: null}}); await read;
  assert.equal(session.releaseWorkspace(), true); c.reconcile(); const r = await c.result;
  assert.equal(r.status, 'RELEASED'); assert.equal(r.state.task_deadline_ms, 1000); assert.equal(r.state.process_exit_code, 0);
  assert.deepEqual(r.state.unit, f.ack().binding); assert.deepEqual(f.calls, []); assert.equal(Object.hasOwn(r, 'record'), false);
});
test('source and target share the identical evolving original monotonic reader, not factory clock or copied counters', () => {
  const f = fixture(); f.ready(); let factoryReads = 0;
  const factory = f.factory({clock: {now() {factoryReads++; throw new Error('WRONG_CLOCK');}}});
  f.setTime(20); const session = factory.adoptStartupOperation(f.operation, f.spec, f.invocation, f.policy);
  f.setTime(80); session.tick(); f.setTime(60); f.operation.tick();
  assert.equal(factoryReads, 0); assert.equal(f.operation.snapshot().phase, 'UNRESOLVED_FENCED');
  assert.equal(session.snapshot().admission_quarantined, true);
  const g = fixture(); g.ready(); const target = g.adopt(); g.setTime(80); g.operation.tick(); g.setTime(60); target.tick();
  assert.equal(g.operation.snapshot().phase, 'UNRESOLVED_FENCED'); assert.equal(target.snapshot().admission_quarantined, true);
});
test('prepare clock failure fences owner and exports no target or RPC', () => {
  const config = {}, f = fixture(config); f.ready(); config.clockHook = () => {throw new Error('PRIVATE_CLOCK');};
  assert.throws(f.adopt, /custody_clock_failed/); assert.equal(f.operation.snapshot().adopted, false);
  assert.equal(f.operation.snapshot().phase, 'UNRESOLVED_FENCED'); assert.deepEqual(f.calls, []);
  assert.equal(JSON.stringify(f.operation.snapshot()).includes('PRIVATE'), false);
});
test('reentrant prepare abort invalidates preparation, retains intent and permits only an explicit later adoption', () => {
  const config = {}, f = fixture(config); f.ready();
  config.clockHook = () => {config.clockHook = null; f.operation.abort('user_cancel');};
  assert.throws(f.adopt, /startup_prepare_changed/); assert.equal(f.operation.snapshot().adopted, false);
  assert.equal(f.operation.snapshot().cancellation_reason, 'user_cancel');
  assert.equal(f.adopt().snapshot().cancellation_reason, 'aborted'); assert.deepEqual(f.calls, []);
});
test('prepare latch rejects reentrant adoption by a second genuine factory without corrupting first commit', () => {
  const config = {}, f = fixture(config); f.ready(); const second = f.factory();
  config.clockHook = () => {config.clockHook = null; assert.throws(() => second.adoptStartupOperation(f.operation, f.spec, f.invocation, f.policy), /startup_preparing/);};
  assert.equal(f.adopt().snapshot().custody_acknowledged, true); assert.equal(f.operation.snapshot().adopted, true);
});
test('source abort after adoption transfers intent only and next target tick controls the existing stop path', () => {
  const f = fixture(); f.ready(); const session = f.adopt(); f.operation.abort('late_user_cancel');
  assert.equal(session.snapshot().canceled, true); assert.equal(session.snapshot().cancellation_reason, 'aborted'); assert.deepEqual(f.calls, []);
  session.tick(); session.tick(); assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].binding, f.ack().binding);
});
test('target failure and cancellation are reflected in retained source and never reset by duplicate ACK', () => {
  const f = fixture(); f.ready(); const session = f.adopt(); session.abort();
  assert.equal(f.operation.snapshot().cancellation_latched, true); f.operation.applyStartAck(f.ack());
  session.disconnected(); assert.equal(f.operation.snapshot().phase, 'UNRESOLVED_FENCED');
  assert.equal(f.operation.snapshot().cancellation_latched, true); assert.equal(session.releaseWorkspace(), false);
});
test('job/unit reservations remain consumed after dual scope release across all factories and facades', () => {
  const f = fixture(); f.ready(); const session = f.adopt(); f.empty(session); session.releaseWorkspace();
  const other = {...managerSpec(), task_scope: '/fixture/distinct-adopt-reservation'};
  assert.throws(() => f.factory().create(other, {...f.invocation, env: {TMPDIR: other.task_scope}}, f.policy), /custody_reservation/);
  assert.throws(() => f.factory().create({...other, job_id: f.spec.job_id}, {...f.invocation, env: {TMPDIR: other.task_scope}},
    {...f.policy, unit_name: `squire-distinct-${other.job_id}.service`}), /custody_reservation/);
});
test('adoption validates all flags/inputs and host gates without accepting unACK/failed startup', () => {
  const f = fixture(); assert.throws(f.adopt, /startup_capability/); f.operation.markDispatchAttempted(); assert.throws(f.adopt, /startup_capability/);
  f.operation.applyStartAck(f.ack());
  assert.throws(() => f.factory({qualification: {...f.qualification, stable_manager_lifetime: false}}).adoptStartupOperation(f.operation, f.spec, f.invocation, f.policy), /host_not_qualified/);
  assert.throws(() => f.adopt({policy: {...f.policy, extra: true}}));
  assert.throws(() => f.adopt({invocation: {...f.invocation, env: {TMPDIR: '/wrong'}}}), /custody_policy/);
  assert.throws(() => f.adopt({policy: {...f.policy, unit_name: 'squire-wrong.service'}}), /startup_unit_mismatch/);
  assert.equal(f.adopt().snapshot().custody_acknowledged, true);
});
test('facades expose compatibility factories only, no enrollment/grant/commit/fence/release authority', () => {
  assert.deepEqual(Object.keys(startupFacade).sort(), ['createStartupOperation', 'createStartupWaiter']);
  assert.deepEqual(Object.keys(managerFacade).sort(), ['CUSTODY_AMENDMENT', 'HOST_GATES', 'captureUnitBinding', 'createAsyncStopManagerCustodyFactory', 'createManagerCustodyFactory']);
});
test('an abort classification named deadline still maps to aborted provenance rather than timeout', () => {
  const f = fixture(); f.ready(); f.operation.abort('deadline'); const session = f.adopt();
  assert.equal(session.snapshot().cancellation_reason, 'aborted'); assert.deepEqual(f.calls, []);
});
test('late ACK after caller wait expiration still adopts with original task budget and no new dispatch', async () => {
  const f = fixture(); f.operation.markDispatchAttempted(); const waiter = createStartupWaiter(f.operation, {clock: f.clock, caller_wait_ms: 10});
  f.setTime(10); waiter.reconcile(); assert.equal((await waiter.result).status, 'CALLER_WAIT_EXPIRED');
  f.setTime(20); f.operation.applyStartAck(f.ack()); const session = f.adopt();
  assert.equal(session.snapshot().task_deadline_ms, 1000); assert.deepEqual(f.calls, []);
});
test('adopted async StopUnit acknowledgement still requires fresh empty proof for dual release', async () => {
  const f = fixture({asyncStop: true}); f.ready(); const session = f.adopt(); session.abort(); f.empty(session);
  assert.equal(session.releaseWorkspace(), false); f.resolveStop({binding: f.ack().binding, job_acknowledged: true}); await session.stopAcknowledgement();
  assert.equal(session.releaseWorkspace(), false); f.empty(session); assert.equal(session.releaseWorkspace(), true);
  assert.equal(f.operation.snapshot().workspace_quarantined, true); assert.equal(f.calls.length, 1);
});

test('cancellation or an elapsed deadline cannot bypass the missing startup ACK', () => {
  const f = fixture(); f.operation.markDispatchAttempted(); f.operation.abort('user_cancel'); f.setTime(1000); f.operation.tick();
  assert.throws(f.adopt, /startup_capability/); assert.equal(f.operation.snapshot().adopted, false); assert.deepEqual(f.calls, []);
});
test('conflicting producer count fences both records and cannot become dual release proof', () => {
  const f = fixture(); f.ready(); const session = f.adopt();
  session.observe({binding: f.ack().binding, populated: 1, launch_closed: true, coverage_complete: true, exact_live_count: 0});
  assert.equal(session.snapshot().admission_quarantined, true); assert.equal(f.operation.snapshot().phase, 'UNRESOLVED_FENCED');
  f.empty(session); assert.equal(session.releaseWorkspace(), false);
});
test('legacy creates across independent factories use the same module-global reservation guards', () => {
  const spec = managerSpec(), unit_name = `squire-legacy-global-${spec.job_id}.service`;
  const binding = {job_id: spec.job_id, unit_name, invocation_id: '1'.repeat(32)};
  const manager = {startTransientUnit() {return {binding, custody_acknowledged: true, worker_in_cgroup_before_exec: true};},
    stopUnit() {return {binding, job_acknowledged: true};}};
  const options = {manager, clock: {now: () => 0}, qualification: Object.fromEntries(HOST_GATES.map(key => [key, true]))};
  const invocation = {executable: '/fixture/node', args: [], env: {TMPDIR: spec.task_scope}, stdio: ['ignore', 'ignore', 'ignore']};
  const policy = {unit_name, stop_grace_ms: 50}; createManagerCustodyFactory(options).create(spec, invocation, policy);
  assert.throws(() => createManagerCustodyFactory(options).create(spec, invocation, policy), /custody_reservation/);
  assert.throws(() => createStartupOperation({spec, policy: {unit_name, task_scope: spec.task_scope}, clock: {now: () => 0}, task_deadline_ms: 300000}), /startup_reservation/);
});

test('post-release source abort, clock failure and conflicting ACK retain only original-epoch diagnostics', () => {
  for (const kind of ['abort', 'clock', 'ack']) {
    const f = fixture(); f.ready(); const old = f.adopt(); f.empty(old); assert.equal(old.releaseWorkspace(), true);
    const before = old.snapshot(), originalCodes = [...before.failure_codes];
    const nextSpec = {...managerSpec(), task_scope: f.spec.task_scope};
    const next = f.factory().create(nextSpec, f.invocation, {...f.policy, unit_name: `squire-new-${nextSpec.job_id}.service`});
    const newOccupant = next.snapshot();
    if (kind === 'abort') f.operation.abort('late_user_abort');
    else if (kind === 'clock') {f.setTime(20); f.operation.tick(); f.setTime(10); f.operation.tick();}
    else {const ack = f.ack(); ack.binding.invocation_id = '2'.repeat(32); f.operation.applyStartAck(ack);}
    const after = old.snapshot();
    const {failure_codes: oldCodes, ...oldOperational} = before;
    const {failure_codes: newCodes, ...newOperational} = after;
    assert.deepEqual(newOperational, oldOperational); assert.notEqual(after, before);
    assert.deepEqual(before.failure_codes, originalCodes); assert.ok(newCodes.length > oldCodes.length);
    assert.equal(Object.isFrozen(after), true); assert.equal(Object.isFrozen(newCodes), true);
    assert.deepEqual(next.snapshot(), newOccupant); assert.equal(old.releaseWorkspace(), false);
    const third = {...managerSpec(), task_scope: f.spec.task_scope};
    assert.throws(() => f.factory().create(third, f.invocation, {...f.policy, unit_name: `squire-blocked-${third.job_id}.service`}), /custody_reservation/);
    assert.deepEqual(f.calls, []);
    if (kind !== 'abort') assert.equal(f.operation.snapshot().phase, 'UNRESOLVED_FENCED');
  }
});
test('late source abort after a previously canceled released job does not change its reason or dispatch again', () => {
  const f = fixture(); f.ready(); f.operation.abort('first_abort'); const session = f.adopt(); session.tick();
  f.empty(session); session.releaseWorkspace(); const before = session.snapshot(); f.operation.abort('later_abort');
  const after = session.snapshot(); assert.equal(after.cancellation_reason, 'aborted'); assert.equal(after.coordinator_returned, before.coordinator_returned);
  assert.equal(after.settlement_status, before.settlement_status); assert.equal(after.admission_quarantined, before.admission_quarantined);
  assert.equal(after.local_workspace_released, true); assert.equal(f.calls.length, 1);
  assert.ok(after.failure_codes.includes('startup_late_abort_later_abort'));
});
