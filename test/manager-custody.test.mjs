import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagerCustodyFactory, HOST_GATES} from '../src/manager-custody.mjs';
import {spec, managerSpec} from './fixtures.mjs';

function fixture(config = {}) {
  let time = 0; const calls = [];
  const job = {...managerSpec(), max_wall_clock_sec: 1};
  const identity = {job_id: job.job_id, unit_name: `squire-fixture-${job.job_id}.service`, invocation_id: '1'.repeat(32)};
  const manager = {
    startTransientUnit(request) {
      calls.push({method: 'StartTransientUnit', request});
      if (config.startThrows) throw new Error('PRIVATE_MANAGER_MESSAGE');
      config.startHook?.();
      return {binding: {...identity, ...config.startBinding}, custody_acknowledged: !config.unacknowledged,
        worker_in_cgroup_before_exec: true};
    },
    stopUnit(request) {
      calls.push({method: 'StopUnit', request});
      if (config.stopThrows) throw new Error('PRIVATE_STOP_MESSAGE');
      config.stopHook?.();
      return {binding: {...identity, ...config.stopBinding}, job_acknowledged: true};
    }
  };
  const qualification = Object.fromEntries(HOST_GATES.map(key => [key, true]));
  const factory = createManagerCustodyFactory({manager, clock: {now: () => time}, qualification});
  const invocation = {executable: '/fixture/node', args: ['PRIVATE_ARGUMENT'], env: {TMPDIR: job.task_scope}, stdio: ['ignore', 'ignore', 'ignore']};
  const policy = {unit_name: identity.unit_name, stop_grace_ms: 50};
  const session = factory.create(job, invocation, policy);
  const observe = (changes = {}) => session.observe({binding: identity, populated: null, launch_closed: true,
    coverage_complete: true, exact_live_count: null, ...changes});
  return {session, calls, observe, identity, job, factory, invocation, policy, qualification, manager,
    setTime: n => {time = n;}};
}

test('manager service request fixes custody properties, no restart, exact worker and no signal fallback', () => {
  const f = fixture(); const before = f.session.snapshot(); assert.equal(f.calls.length, 0);
  assert.equal(before.settlement_status, null); assert.equal(before.workspace_reuse_blocked, true);
  const result = f.session.start(); f.session.start();
  assert.equal(f.calls.length, 1); assert.equal(result.custody_acknowledged, true);
  assert.equal(result.runtime_qualification, 'NOT_ESTABLISHED_BY_SOURCE');
  assert.deepEqual(f.calls[0].request.properties, {Type: 'exec', ExitType: 'cgroup', KillMode: 'control-group', Restart: 'no', KillSignal: 'SIGTERM', SendSIGKILL: true, FinalKillSignal: 'SIGKILL', TimeoutStopSec: 0.05});
  assert.equal(f.calls[0].request.mode, 'fail'); assert.equal(f.calls[0].request.worker.args[0], 'PRIVATE_ARGUMENT');
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
});
test('any unqualified host gate disables create before manager use', () => {
  const f = fixture();
  for (const gate of HOST_GATES) {
    const factory = createManagerCustodyFactory({manager: f.manager, clock: {now: () => 0}, qualification: {...f.qualification, [gate]: false}});
    assert.throws(() => factory.create(f.job, f.invocation, f.policy), /host_not_qualified/);
  }
  assert.equal(f.calls.length, 0);
});
test('StopUnit transaction acknowledgement is not settlement or an empty proof', () => {
  const f = fixture(); f.session.start(); const s = f.session.settle();
  assert.equal(s.stop_job_acknowledged, true); assert.equal(s.settlement_status, 'UNKNOWN');
  assert.equal(s.live_count, null); assert.equal(s.workspace_reuse_blocked, true);
  f.session.settle(); assert.deepEqual(f.calls.map(c => c.method), ['StartTransientUnit', 'StopUnit']);
});
test('count remains nullable and positive populated is not an invented exact count', () => {
  const f = fixture(); f.session.start();
  let s = f.observe({populated: 1}); assert.equal(s.live_count, null); assert.equal(s.settlement_status, 'UNKNOWN');
  s = f.observe({populated: 1, exact_live_count: 4}); assert.equal(s.live_count, 4);
  s = f.observe({populated: 0, coverage_complete: false}); assert.equal(s.live_count, null); assert.equal(s.workspace_reuse_blocked, true);
  s = f.observe({populated: 0, launch_closed: false}); assert.equal(s.settlement_status, 'UNKNOWN');
});
test('only epoch-bound closed full-tree populated zero permits CLEAN or ORPHAN_KILLED', () => {
  const f = fixture(); f.session.start(); const before = f.session.snapshot();
  const clean = f.observe({populated: 0}); assert.equal(clean.settlement_status, 'CLEAN'); assert.equal(clean.live_count, 0);
  assert.equal(clean.workspace_reuse_blocked, false); assert.equal(before.workspace_reuse_blocked, true);
  const g = fixture(); g.session.start(); g.session.settle();
  assert.equal(g.observe({populated: 0}).settlement_status, 'ORPHAN_KILLED');
});
test('timeout latches cancellation, dispatches StopUnit once and retains host custody for survivors', () => {
  const f = fixture(); f.session.start(); f.observe({populated: 1}); f.setTime(1000);
  const timeout = f.session.tick(); assert.equal(timeout.canceled, true); assert.equal(timeout.cancellation_reason, 'timeout');
  assert.equal(timeout.coordinator_returned, true); assert.equal(timeout.custody_acknowledged, true);
  assert.equal(timeout.settlement_status, 'UNKNOWN'); // Earlier populated evidence is not a post-timeout observation.
  const leak = f.observe({populated: 1}); assert.equal(leak.settlement_status, 'DIRTY_LEAK'); assert.equal(leak.live_count, null);
  assert.equal(leak.workspace_reuse_blocked, true);
  f.session.abort(); f.session.tick(); assert.equal(f.calls.length, 2);
  const clean = f.observe({populated: 0}); assert.equal(clean.canceled, true); assert.equal(clean.settlement_status, 'ORPHAN_KILLED');
  assert.equal(clean.workspace_reuse_blocked, false); assert.equal(leak.settlement_status, 'DIRTY_LEAK');
});
test('abort before start launches nothing and abort during custody stays latched across raw exit zero', () => {
  const f = fixture(); f.session.abort(); f.session.start(); assert.equal(f.calls.length, 0);
  const g = fixture(); g.session.start(); g.session.abort();
  const s = g.session.nativeExit({binding: g.identity, code: 0});
  assert.equal(s.process_exit_code, 0); assert.equal(s.canceled, true); assert.equal(s.cancellation_reason, 'aborted');
  assert.equal(g.observe({populated: 0}).canceled, true);
});
test('raw exit is preserved and cannot establish empty or manufacture a signal code', () => {
  for (const code of [7, null, -3]) {
    const f = fixture(); f.session.start(); const s = f.session.nativeExit({binding: f.identity, code});
    assert.equal(s.process_exit_code, code); assert.equal(s.settlement_status, 'UNKNOWN'); assert.equal(s.workspace_reuse_blocked, true);
  }
});
test('disconnect permanently latches UNKNOWN and quarantine despite later empty or native exit', () => {
  const f = fixture(); f.session.start(); f.session.abort(); const old = f.session.disconnected();
  assert.equal(old.settlement_status, 'UNKNOWN'); assert.equal(old.custody_acknowledged, false); assert.equal(old.admission_quarantined, true);
  assert.equal(f.observe({populated: 0}).workspace_reuse_blocked, true);
  const s = f.session.nativeExit({binding: f.identity, code: 7}); assert.equal(s.process_exit_code, 7); assert.equal(s.settlement_status, 'UNKNOWN');
});
test('start/stop failures or conflicting epochs never retry and disclose only classifications', () => {
  for (const config of [{startThrows: true}, {unacknowledged: true}, {startBinding: {invocation_id: '0'.repeat(32)}},
    {stopThrows: true}, {stopBinding: {invocation_id: '2'.repeat(32)}}]) {
    const f = fixture(config); f.session.start(); f.session.abort(); f.session.start(); f.session.settle();
    const s = f.session.snapshot(); assert.equal(s.settlement_status, 'UNKNOWN'); assert.equal(s.admission_quarantined, true);
    assert.equal(f.calls.filter(c => c.method === 'StartTransientUnit').length, 1);
    assert.ok(f.calls.filter(c => c.method === 'StopUnit').length <= 1); assert.equal(JSON.stringify(s).includes('PRIVATE_'), false);
  }
});
test('identity mismatch, malformed count and backwards clock fail closed without signals', () => {
  const changes = [{binding: {unit_name: 'squire-wrong.service'}}, {populated: 1, exact_live_count: 0},
    {populated: 0, exact_live_count: 1}, {exact_live_count: 3}, {exact_live_count: -1}];
  for (const change of changes) {
    const f = fixture(); f.session.start(); const input = {...change};
    if (input.binding) input.binding = {...f.identity, ...input.binding};
    assert.equal(f.observe(input).admission_quarantined, true); assert.equal(f.calls.length, 1);
  }
  const f = fixture(); f.session.start(); f.setTime(5); f.session.tick(); f.setTime(4);
  assert.equal(f.session.tick().admission_quarantined, true);
});
test('factory never retries a job or reuses a unit or overlapping reserved workspace', () => {
  const f = fixture();
  for (const [job, policy] of [[f.job, {...f.policy, unit_name: 'squire-other.service'}],
    [{...f.job, job_id: '12345678-1234-4abc-8def-123456789abd', task_scope: '/different'}, f.policy],
    [{...f.job, job_id: '12345678-1234-4abc-8def-123456789abd', task_scope: f.job.task_scope + '/nested'}, {...f.policy, unit_name: 'squire-other.service'}]]) {
    assert.throws(() => f.factory.create(job, {...f.invocation, env: {TMPDIR: job.task_scope}}, policy), /custody_reservation/);
  }
});
test('reentrant manager failure cannot be overwritten by a later start acknowledgement', () => {
  const config = {}; const f = fixture(config); config.startHook = () => f.session.tick();
  const s = f.session.start(); assert.equal(s.admission_quarantined, true); assert.equal(s.custody_acknowledged, false);
});

test('workspace reservation is released only explicitly after verified empty, never from ACK or UNKNOWN', () => {
  const f = fixture(); f.session.start(); f.session.settle(); assert.equal(f.session.releaseWorkspace(), false);
  f.observe({populated: 0}); assert.equal(f.session.releaseWorkspace(), true);
  const s = f.session.snapshot(); assert.equal(s.local_workspace_released, true);
  const next = {...f.job, job_id: '12345678-1234-4abc-8def-123456789abd'};
  f.factory.create(next, f.invocation, {...f.policy, unit_name: 'squire-next.service'});
  f.session.tick(); assert.equal(f.calls.length, 2);
  const g = fixture(); g.session.start(); g.session.disconnected(); g.observe({populated: 0});
  assert.equal(g.session.releaseWorkspace(), false);
});

test('abort intent survives a failed clock and reentrant manager callback', () => {
  const f = fixture(); f.session.start(); f.setTime(5); f.session.tick(); f.setTime(4);
  const s = f.session.abort(); assert.equal(s.canceled, true); assert.equal(s.cancellation_reason, 'aborted');
  assert.equal(s.admission_quarantined, true);
  const config = {}; const g = fixture(config); config.startHook = () => g.session.abort();
  const r = g.session.start(); assert.equal(r.canceled, true); assert.equal(r.cancellation_reason, 'aborted');
  assert.equal(r.admission_quarantined, true); assert.equal(r.custody_acknowledged, false);
});

test('released session snapshots cannot be rewritten by late events', () => {
  const f = fixture(); f.session.start(); f.observe({populated: 0}); f.session.releaseWorkspace();
  const final = f.session.snapshot(); f.session.disconnected(); f.session.abort();
  f.setTime(1000); f.session.tick(); f.observe({populated: 1});
  f.session.nativeExit({binding: f.identity, code: 7});
  assert.deepEqual(f.session.snapshot(), final); assert.equal(f.calls.length, 1);
});

test('identity-bound native raw exit survives clock failure without inventing timing or cleanup', () => {
  const f = fixture(); f.session.start(); f.setTime(5); f.session.tick(); f.setTime(4);
  const s = f.session.nativeExit({binding: f.identity, code: 7});
  assert.equal(s.process_exit_code, 7); assert.equal(s.settlement_status, 'UNKNOWN'); assert.equal(s.admission_quarantined, true);
});
