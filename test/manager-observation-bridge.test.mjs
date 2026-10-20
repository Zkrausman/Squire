import test from 'node:test';
import assert from 'node:assert/strict';
import {createManagerCustodyFactory, HOST_GATES} from '../src/manager-custody.mjs';
import {createManagerObservationBridge} from '../src/manager-observation-bridge.mjs';
import {spec} from './fixtures.mjs';

function fixture(options = {}) {
  let time = 0; const timers = [], reads = [], managerCalls = [];
  const clock = {now: () => time, schedule(delay, callback) {
    const item = {at: time + delay, callback, canceled: false}; timers.push(item);
    if (options.inlineTimers) callback();
    return () => { item.canceled = true; options.cancelHook?.(); };
  }};
  const job = {...spec(), max_wall_clock_sec: 1};
  const binding = {job_id: job.job_id, unit_name: 'squire-observer.service', invocation_id: '1'.repeat(32)};
  const manager = {startTransientUnit() { managerCalls.push('start'); return {binding,
    custody_acknowledged: true, worker_in_cgroup_before_exec: true}; },
  stopUnit() { managerCalls.push('stop'); return {binding, job_acknowledged: true}; }};
  const factory = createManagerCustodyFactory({manager, clock: {now: clock.now},
    qualification: Object.fromEntries(HOST_GATES.map(key => [key, true]))});
  const session = factory.create(job, {executable: '/fixture/node', args: [], env: {TMPDIR: job.task_scope},
    stdio: ['ignore', 'ignore', 'ignore']}, {unit_name: binding.unit_name, stop_grace_ms: 50});
  if (!options.unstarted) session.start();
  const source = {nextEvent(request) {
    options.readHook?.(request);
    if (options.readThrows) throw new Error('PRIVATE_READ_ERROR');
    let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    reads.push({request, resolve, reject}); return promise;
  }};
  const input = {session, source, clock, read_timeout_ms: options.readTimeout ?? 100};
  const create = () => createManagerObservationBridge(input);
  const bridge = options.unstarted ? null : create();
  const cgroup = (changes = {}) => ({type: 'cgroup', value: {binding, populated: 0, launch_closed: true,
    coverage_complete: true, exact_live_count: null, ...changes}});
  async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
  return {bridge, session, input, create, reads, timers, managerCalls, binding, cgroup, flush,
    setTime: n => {time = n;},
    async advance(n) {
      for (const timer of timers) if (!timer.canceled && timer.at <= n) {
        time = timer.at; timer.canceled = true; timer.callback(); await flush();
      }
      time = n; await flush();
    }};
}

test('bridge requires acknowledged custody and makes no observation request until readNext', () => {
  const f = fixture({unstarted: true}); assert.throws(f.create, /custody_not_acknowledged/); assert.equal(f.reads.length, 0);
  f.session.start(); const bridge = f.create(); assert.equal(f.reads.length, 0);
  const pending = bridge.readNext(); assert.equal(f.reads.length, 1); bridge.abort(); return pending;
});
test('asynchronous event binds to admitted epoch and reaches the existing empty-proof validator', async () => {
  const f = fixture(); const pending = f.bridge.readNext();
  assert.deepEqual(f.reads[0].request.binding, f.binding); assert.equal(f.reads[0].request.signal.aborted, false);
  f.reads[0].resolve(f.cgroup()); const result = await pending;
  assert.equal(result.status, 'OBSERVED'); assert.equal(result.state.settlement_status, 'CLEAN');
  assert.equal(result.state.live_count, 0); assert.equal(result.runtime_qualification, 'NOT_ESTABLISHED_BY_SOURCE');
  assert.equal(f.reads[0].request.signal.aborted, true); assert.ok(f.timers.every(t => t.canceled));
  assert.throws(() => { result.state.canceled = true; }, TypeError);
});
test('observation cannot fabricate exact count or promote incomplete coverage', async () => {
  for (const value of [{populated: 1}, {populated: 0, coverage_complete: false}]) {
    const f = fixture(); const pending = f.bridge.readNext(); f.reads[0].resolve(f.cgroup(value)); const r = await pending;
    assert.equal(r.state.live_count, null); assert.equal(r.state.workspace_reuse_blocked, true);
  }
});
test('overlapping read is rejected without another source invocation', async () => {
  const f = fixture(); const p = f.bridge.readNext(); assert.throws(() => f.bridge.readNext(), /observation_read_in_progress/);
  assert.equal(f.reads.length, 1); f.bridge.abort(); await p;
});
test('one timed-out read latches UNKNOWN, ignores late fulfillment and never retries', async () => {
  const f = fixture(); const p = f.bridge.readNext(); await f.advance(100); const r = await p;
  assert.equal(r.status, 'READ_FAILED'); assert.equal(r.state.admission_quarantined, true);
  assert.equal(r.state.custody_acknowledged, false); assert.equal(f.reads[0].request.signal.aborted, true);
  f.reads[0].resolve(f.cgroup()); await f.flush(); assert.equal(f.session.snapshot().settlement_status, 'UNKNOWN');
  assert.equal((await f.bridge.readNext()).status, 'FENCED'); assert.equal(f.reads.length, 1);
  assert.deepEqual(f.managerCalls, ['start']);
});
test('original task deadline wins over a longer read timeout and StopUnit dispatches once', async () => {
  const f = fixture({readTimeout: 2000}); const p = f.bridge.readNext(); await f.advance(1000); const r = await p;
  assert.equal(r.status, 'DEADLINE'); assert.equal(r.state.canceled, true); assert.equal(r.state.cancellation_reason, 'timeout');
  assert.equal(r.state.custody_acknowledged, true); assert.equal(r.state.settlement_status, 'UNKNOWN');
  assert.deepEqual(f.managerCalls, ['start', 'stop']); assert.equal((await f.bridge.readNext()).status, 'FENCED');
});
test('repeated completed reads do not reset the original deadline', async () => {
  const f = fixture({readTimeout: 600});
  const first = f.bridge.readNext(); f.setTime(500); f.reads[0].resolve(f.cgroup({populated: 1})); await first;
  const second = f.bridge.readNext(); assert.equal(f.timers.at(-1).at, 1000);
  await f.advance(1000); assert.equal((await second).status, 'DEADLINE');
});
test('abort latches cancellation and stops the pending read without replaying late events', async () => {
  const f = fixture(); const p = f.bridge.readNext(); const r = f.bridge.abort();
  assert.equal(r.state.canceled, true); assert.equal((await p).status, 'CANCELED');
  f.reads[0].resolve(f.cgroup()); await f.flush(); assert.equal(f.session.snapshot().settlement_status, 'UNKNOWN');
  assert.deepEqual(f.managerCalls, ['start', 'stop']);
});
test('source throw and rejected promise fail closed without private messages or fallback', async () => {
  const f = fixture({readThrows: true}); const r = await f.bridge.readNext(); assert.equal(r.status, 'READ_FAILED');
  assert.equal(JSON.stringify(r).includes('PRIVATE_'), false); assert.deepEqual(f.managerCalls, ['start']);
  const g = fixture(); const p = g.bridge.readNext(); g.reads[0].reject(new Error('PRIVATE_REJECTION')); const s = await p;
  assert.equal(s.status, 'READ_FAILED'); assert.equal(JSON.stringify(s).includes('PRIVATE_'), false);
});
test('late rejection after timeout is consumed without another operation', async () => {
  const f = fixture(); const p = f.bridge.readNext(); await f.advance(100); await p;
  f.reads[0].reject(new Error('PRIVATE_LATE')); await f.flush(); assert.equal(f.reads.length, 1);
});
test('wrong epoch or malformed event fences the session without accepting empty', async () => {
  for (const event of [{type: 'cgroup', value: {wrong: 'PRIVATE_PAYLOAD'}}, {type: 'unsupported', value: {}},
    {type: 'manager_disconnected', value: {binding: {unit_name: 'squire-wrong.service'}}}]) {
    const f = fixture(); const p = f.bridge.readNext(); f.reads[0].resolve(event); const r = await p;
    assert.equal(r.state.settlement_status, 'UNKNOWN'); assert.equal(r.state.workspace_reuse_blocked, true);
    assert.equal(r.state.admission_quarantined, true); assert.equal(JSON.stringify(r).includes('PRIVATE_'), false);
  }
});
test('manager disconnect revokes custody and later reads stay fenced', async () => {
  const f = fixture(); const p = f.bridge.readNext();
  f.reads[0].resolve({type: 'manager_disconnected', value: {binding: f.binding}}); const r = await p;
  assert.equal(r.state.custody_acknowledged, false); assert.equal(r.state.admission_quarantined, true);
  assert.equal((await f.bridge.readNext()).status, 'FENCED');
});
test('raw integer exit survives late callback and clock regression while cleanup stays unknown', async () => {
  for (const mode of ['late', 'regression']) {
    const f = fixture(); f.setTime(5); const p = f.bridge.readNext(); f.setTime(mode === 'late' ? 105 : 4);
    f.reads[0].resolve({type: 'native_exit', value: {binding: f.binding, code: 7}}); const r = await p;
    assert.equal(r.state.process_exit_code, 7); assert.equal(r.state.settlement_status, 'UNKNOWN');
    assert.equal(r.state.admission_quarantined, true);
  }
});
test('a released session cannot be rewritten by an already pending observation', async () => {
  const f = fixture(); const p = f.bridge.readNext(); f.session.observe(f.cgroup().value); f.session.releaseWorkspace();
  const final = f.session.snapshot(); f.reads[0].resolve(f.cgroup({populated: 1})); assert.equal((await p).status, 'FENCED');
  assert.deepEqual(f.session.snapshot(), final);
});
test('abort triggered during timer cancellation remains reflected in the delivered result', async () => {
  const options = {}; const f = fixture(options); let fired = false;
  options.cancelHook = () => { if (!fired) { fired = true; f.bridge.abort(); } };
  const p = f.bridge.readNext(); f.reads[0].resolve(f.cgroup({populated: 1})); const r = await p;
  assert.equal(r.status, 'CANCELED'); assert.equal(r.state.canceled, true); assert.deepEqual(f.managerCalls, ['start', 'stop']);
});

test('two bridge instances cannot overlap reads for the same custody session', async () => {
  const f = fixture(); const other = f.create(); const p = f.bridge.readNext();
  assert.throws(() => other.readNext(), /observation_read_in_progress/); assert.equal(f.reads.length, 1);
  f.reads[0].resolve(f.cgroup({populated: 1})); await p;
  const next = other.readNext(); assert.equal(f.reads.length, 2); other.abort(); await next;
});
test('deadline crossed during read cancellation is reflected before returning evidence', async () => {
  const options = {}; const f = fixture(options); options.cancelHook = () => f.setTime(1000);
  const p = f.bridge.readNext(); f.reads[0].resolve(f.cgroup({populated: 1})); const r = await p;
  assert.equal(r.status, 'DEADLINE'); assert.equal(r.state.canceled, true); assert.deepEqual(f.managerCalls, ['start', 'stop']);
});
test('a late queued empty event cannot become accepted evidence when its read budget elapsed', async () => {
  const f = fixture(); const p = f.bridge.readNext(); f.setTime(100); f.reads[0].resolve(f.cgroup());
  const r = await p; assert.equal(r.status, 'READ_FAILED'); assert.equal(r.state.live_count, null);
  assert.equal(r.state.settlement_status, 'UNKNOWN'); assert.equal(r.state.workspace_reuse_blocked, true);
});

test('inline timer callbacks fail closed and release the returned cancellation handle before source use', async () => {
  const f = fixture({inlineTimers: true}); const r = await f.bridge.readNext();
  assert.equal(r.status, 'READ_FAILED'); assert.equal(r.state.admission_quarantined, true);
  assert.equal(f.reads.length, 0); assert.equal(f.timers.length, 1); assert.equal(f.timers[0].canceled, true);
});
