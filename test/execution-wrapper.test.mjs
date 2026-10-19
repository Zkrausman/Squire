import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {startProcess} from '../src/execution-wrapper.mjs';
import {createNodeProcessPort} from '../src/node-process-port.mjs';
import {spec} from './fixtures.mjs';

const invocation = () => ({executable: '/fixture/program', args: ['PRIVATE_ARG'], env: {TMPDIR: '/fixture/private-tmp', FIXTURE_SECRET: 'PRIVATE_ENV'}, stdio: [0, 1, 2]});
const shutdown = () => ({term_grace_ms: 5, kill_grace_ms: 3, poll_interval_ms: 1});
function fakeClock() {
  let time = 0, sequence = 0; const timers = [];
  const clock = {now: () => time, schedule(delay, callback) {
    const entry = {at: time + delay, sequence: sequence++, callback, canceled: false}; timers.push(entry);
    return () => { entry.canceled = true; };
  }};
  return {clock, advance(target) {
    let count = 0;
    while (true) {
      const next = timers.filter(t => !t.canceled && t.at <= target).sort((a,b) => a.at-b.at || a.sequence-b.sequence)[0];
      if (!next) break;
      if (++count > 10000) throw new Error('fake clock loop');
      next.canceled = true; time = next.at; next.callback();
    }
    time = target;
  }, pending: () => timers.filter(t => !t.canceled).length, jump(target) { time = target; }};
}
function fixture(config = {}) {
  const time = fakeClock(); const identity = Object.freeze({}); const signals = []; const observations = [];
  let events, live = config.live ?? 1, releases = 0, spawns = 0;
  const handle = {pid: 1234, identity, observe() {
    observations.push(time.clock.now());
    if (config.observe) return config.observe({time, identity, live});
    return {job_id: spec().job_id, pgid: 1234, identity, live_count: live, coverage_complete: true, signal_safe: true};
  }, sendSignal(signal, observation) {
    signals.push({signal, time: time.clock.now()});
    if (config.signal) return config.signal(signal, observation, {exit, setLive: value => { live = value; }});
    return true;
  }, release() { releases++; }};
  const port = {spawn(_spec, _invocation, supplied) { spawns++; events = supplied; if (config.spawn) return config.spawn(supplied, handle); return handle; }};
  const options = {port, clock: time.clock, shutdown: shutdown(), ...(config.signalObject ? {signal: config.signalObject} : {})};
  const session = startProcess({...spec(), max_wall_clock_sec: 1}, invocation(), options);
  function exit(code, signal = null) { events.onExit({code, signal}); }
  function spawn() { events.onSpawn({pid: 1234}); }
  return {session, time, signals, observations, events: () => events, spawn, exit, setLive: value => { live = value; }, releases: () => releases, spawns: () => spawns, options};
}

test('native exit metadata is separate from complete descendant settlement and contains no invocation payload', async () => {
  const f = fixture(); f.spawn(); f.time.advance(4); f.exit(0);
  assert.deepEqual(await f.session.exit, {job_id: spec().job_id, process_exit_code: 0, signal: null, process_wall_ms: 4});
  f.setLive(0); const result = await f.session.settle();
  assert.equal(result.settlement_status, 'CLEAN'); assert.equal(result.canceled, false);
  assert.equal(f.signals.length, 0); assert.equal(f.releases(), 1); assert.equal(f.time.pending(), 0);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  assert.equal(Object.hasOwn(result, 'inference_time_ms'), false); assert.equal(Object.hasOwn(result, 'usage_tokens'), false);
});
test('abort uses fixed TERM then KILL deadlines and requires a later zero-live observation', async () => {
  const f = fixture(); f.spawn(); f.session.abort();
  assert.deepEqual(f.signals, [{signal: 'SIGTERM', time: 0}]);
  f.time.advance(4); f.session.abort(); f.session.settle();
  f.time.advance(5); assert.deepEqual(f.signals[1], {signal: 'SIGKILL', time: 5});
  f.exit(null, 'SIGKILL'); f.setLive(0); f.time.advance(6);
  const result = await f.session.result;
  assert.equal(result.canceled, true); assert.equal(result.process_exit_code, null); assert.equal(result.signal, 'SIGKILL');
  assert.equal(result.settlement_status, 'ORPHAN_KILLED'); assert.equal(result.process_wall_ms, 5);
});
test('positive live descendants at the exact shutdown limit are DIRTY_LEAK, never success', async () => {
  const f = fixture(); f.spawn(); f.session.abort(); f.time.advance(8);
  const result = await f.session.result;
  assert.equal(result.settlement_status, 'DIRTY_LEAK'); assert.equal(result.canceled, true);
  assert.equal(result.process_exit_code, null); assert.equal(result.process_wall_ms, null);
  assert.deepEqual(f.signals.map(s => s.signal), ['SIGTERM', 'SIGKILL']);
});
test('late timer wake is unknown settlement rather than fabricated DIRTY_LEAK', async () => {
  const f = fixture(); f.spawn(); f.session.abort();
  f.time.jump(10); f.session.settle();
  const result = await f.session.result;
  assert.equal(result.settlement_status, null); assert.equal(result.termination_reason, 'shutdown_limit');
  assert.deepEqual(f.observations, [0]);
});
test('timeout stays armed after native exit and during verification or manual settlement', async () => {
  const f = fixture(); f.spawn(); f.exit(0); f.time.advance(1000);
  assert.deepEqual(f.signals[0], {signal: 'SIGTERM', time: 1000});
  f.setLive(0); f.time.advance(1001);
  assert.equal((await f.session.result).canceled, true);
  const g = fixture(); g.spawn(); g.time.advance(998); g.session.settle();
  g.time.advance(1000); g.exit(0); g.setLive(0); g.time.advance(1001);
  const result = await g.session.result; assert.equal(result.canceled, true); assert.equal(result.termination_reason, 'timeout');
});
test('pre-aborted signal launches nothing and preserves pre-spawn null settlement', async () => {
  const controller = new AbortController(); controller.abort(); const f = fixture({signalObject: controller.signal});
  const result = await f.session.result;
  assert.equal(f.spawns(), 0); assert.equal(result.process_group_allocated, false); assert.equal(result.pid, null);
  assert.equal(result.process_exit_code, null); assert.equal(result.settlement_status, null); assert.equal(result.canceled, true);
});
test('abort signal during settlement stays latched across late exit0 and clean cleanup', async () => {
  const controller = new AbortController(); const f = fixture({signalObject: controller.signal}); f.spawn();
  f.session.settle(); controller.abort(); f.exit(0); f.setLive(0); f.time.advance(1);
  const result = await f.session.result; assert.equal(result.canceled, true); assert.equal(result.process_exit_code, 0);
  assert.equal(result.termination_reason, 'aborted'); assert.equal(result.settlement_status, 'ORPHAN_KILLED');
});
test('observation failure and incomplete or mismatched coverage fence without signals or retry', async () => {
  for (const kind of ['throw', 'coverage', 'job', 'identity', 'pgid', 'async']) {
    const f = fixture({observe({identity}) {
      if (kind === 'throw') throw new Error('PRIVATE_ERROR');
      if (kind === 'async') return Promise.resolve({});
      return {job_id: kind === 'job' ? 'other' : spec().job_id, pgid: kind === 'pgid' ? 999 : 1234,
        identity: kind === 'identity' ? {} : identity, live_count: 0, coverage_complete: kind !== 'coverage', signal_safe: true};
    }}); f.spawn(); const result = await f.session.abort();
    assert.equal(result.settlement_status, null); assert.equal(result.canceled, true); assert.equal(f.signals.length, 0);
    assert.equal(f.observations.length, 1); assert.equal(JSON.stringify(result).includes('PRIVATE_ERROR'), false);
    f.time.advance(2000); assert.equal(f.observations.length, 1);
  }
});
test('signal denial or unconfirmed target is terminal unknown with no fallback SIGKILL', async () => {
  const f = fixture({signal() { throw Object.assign(new Error('PRIVATE_DENIAL'), {code: 'EPERM'}); }}); f.spawn();
  const result = await f.session.abort(); f.time.advance(2000);
  assert.equal(result.settlement_status, null); assert.equal(result.termination_reason, 'signal_failed');
  assert.deepEqual(f.signals.map(s => s.signal), ['SIGTERM']); assert.equal(JSON.stringify(result).includes('PRIVATE_DENIAL'), false);
  const g = fixture({observe({identity}) { return {job_id: spec().job_id, pgid: 1234, identity, live_count: 1, coverage_complete: true, signal_safe: false}; }});
  g.spawn(); await g.session.abort(); assert.equal(g.signals.length, 0);
});
test('confirmed spawn failure differs from unknown allocation and never invents an exit code', async () => {
  const f = fixture({spawn(events, handle) { return {...handle, pid: null}; }});
  f.events().onError({spawn_failed: true});
  const failed = await f.session.result; assert.equal(failed.process_group_allocated, false); assert.equal(failed.process_exit_code, null);
  assert.equal(failed.termination_reason, 'spawn_failed');
  const g = fixture({spawn() { throw new Error('PRIVATE_LAUNCH_ERROR'); }});
  const unknown = await g.session.result; assert.equal(unknown.process_group_allocated, null);
  assert.equal(unknown.settlement_status, null); assert.equal(JSON.stringify(unknown).includes('PRIVATE_LAUNCH_ERROR'), false);
});
test('settlement waits for native exit observation when group is already empty', async () => {
  const f = fixture({live: 0}); f.spawn(); f.session.settle(); f.time.advance(2); f.exit(9);
  const result = await f.session.result; assert.equal(result.process_exit_code, 9); assert.equal(result.process_wall_ms, 2);
  assert.equal(result.settlement_status, 'CLEAN');
});
test('missing exit observation can settle honestly with null exit and wall time', async () => {
  const f = fixture({live: 0}); f.spawn(); f.session.settle(); f.time.advance(8);
  const result = await f.session.result; assert.equal(result.settlement_status, 'CLEAN');
  assert.equal(result.process_exit_code, null); assert.equal(result.process_wall_ms, null);
});
test('late events and repeated finish calls cannot change delivered immutable metadata', async () => {
  const f = fixture(); f.spawn(); f.exit(0); f.setLive(0); const result = await f.session.settle();
  f.events().onExit({code: 99, signal: null}); f.events().onError({spawn_failed: false});
  assert.equal(await f.session.abort(), result); assert.equal(await f.session.settle(), result);
  assert.equal(result.canceled, false); assert.equal(result.process_exit_code, 0);
  assert.throws(() => { result.process_exit_code = 99; }, TypeError); assert.equal(f.releases(), 1);
});
test('reentrant native callback during signal dispatch does not dispatch duplicate signals', async () => {
  const f = fixture({signal(_signal, _observed, {exit, setLive}) { setLive(0); exit(null, 'SIGTERM'); return true; }});
  f.spawn(); const result = await f.session.abort();
  assert.equal(result.settlement_status, 'ORPHAN_KILLED'); assert.equal(f.signals.length, 1);
});
test('invalid launch parameters fail before spawning without shell or environment fallback', () => {
  let count = 0;
  const options = {port: {spawn() { count++; }}, clock: fakeClock().clock, shutdown: shutdown()};
  for (const patch of [{executable: 'relative'}, {env: {}}, {stdio: ['pipe', 1, 2]}, {args: ['a\0b']}, {shell: true}]) {
    assert.throws(() => startProcess(spec(), {...invocation(), ...patch}, options));
  }
  for (const value of [0, -1, undefined, 1.5]) assert.throws(() => startProcess(spec(), invocation(), {...options, shutdown: {...shutdown(), term_grace_ms: value}}));
  const args = []; Object.defineProperty(args, '0', {get() { throw new Error('must not evaluate'); }});
  assert.throws(() => startProcess(spec(), {...invocation(), args}, options)); assert.equal(count, 0);
});
test('native port maps detached spawn and raw exit using fake OS operations only', async () => {
  const child = new EventEmitter(); child.pid = 2345; let called;
  const controls = {observe(group) { return {...group, live_count: 0, coverage_complete: true, signal_safe: false}; }, signal() { return true; }};
  const port = createNodeProcessPort(controls, {platform: 'linux', spawn(...args) { called = args; return child; }});
  const f = fakeClock(); const session = startProcess(spec(), invocation(), {port, clock: f.clock, shutdown: shutdown()});
  child.emit('spawn'); f.advance(3); child.emit('exit', null, 'SIGTERM');
  assert.equal((await session.exit).process_exit_code, null); assert.equal((await session.exit).signal, 'SIGTERM');
  assert.deepEqual(called, ['/fixture/program', ['PRIVATE_ARG'], {cwd: spec().task_scope, env: {...invocation().env}, stdio: [0,1,2], shell: false, detached: true}]);
  const result = await session.settle(); assert.equal(result.settlement_status, 'CLEAN');
  child.emit('error', new Error('PRIVATE_LATE_ERROR')); assert.equal(await session.result, result);
  assert.equal(child.listenerCount('spawn'), 0); assert.equal(child.listenerCount('exit'), 0);
});
test('native port requires owned-group controls and rejects unsupported platform without native launch', () => {
  assert.throws(() => createNodeProcessPort());
  assert.throws(() => createNodeProcessPort({observe() {}, signal() {}}, {platform: 'win32', spawn() { throw new Error('must not launch'); }}));
});
test('task deadline is not postponed by a long shutdown polling interval', async () => {
  const time = fakeClock(); const identity = {}; let events;
  const handle = {pid: 1234, identity, observe: () => ({job_id: spec().job_id, pgid: 1234, identity, live_count: 1, coverage_complete: true, signal_safe: true}), sendSignal: () => true, release() {}};
  const session = startProcess({...spec(), max_wall_clock_sec: 1}, invocation(), {
    port: {spawn(_s, _i, value) { events = value; return handle; }}, clock: time.clock,
    shutdown: {term_grace_ms: 5000, kill_grace_ms: 1000, poll_interval_ms: 4000}
  });
  events.onSpawn({pid: 1234}); time.advance(900); session.settle(); time.advance(1000);
  time.advance(6900); const result = await session.result;
  assert.equal(result.canceled, true); assert.equal(result.termination_reason, 'shutdown_limit');
});
test('native group controls receive exact identity-bound signal requests under fake operations', () => {
  const child = new EventEmitter(); child.pid = 2345; const calls = [];
  const port = createNodeProcessPort({observe(group) { return {...group, live_count: 1, coverage_complete: true, signal_safe: true}; }, signal(...args) { calls.push(args); return true; }}, {platform: 'linux', spawn: () => child});
  const handle = port.spawn(spec(), invocation(), {onSpawn() {}, onExit() {}, onError() {}});
  const observation = handle.observe(); assert.equal(handle.sendSignal('SIGTERM', observation), true);
  assert.equal(calls[0][0].identity, handle.identity); assert.equal(calls[0][1], 'SIGTERM');
  assert.throws(() => handle.sendSignal('SIGKILL', {...observation, identity: {}}));
  assert.throws(() => handle.sendSignal('SIGINT', observation)); assert.equal(calls.length, 1); handle.release();
});
test('observer-triggered cancellation is latched before a zero-live result is delivered', async () => {
  const controller = new AbortController();
  const f = fixture({signalObject: controller.signal, observe({identity}) {
    controller.abort();
    return {job_id: spec().job_id, pgid: 1234, identity, live_count: 0, coverage_complete: true, signal_safe: false};
  }});
  f.spawn(); f.exit(0); const result = await f.session.settle();
  assert.equal(result.canceled, true); assert.equal(result.process_exit_code, 0);
  assert.equal(result.termination_reason, 'aborted'); assert.equal(result.settlement_status, 'CLEAN');
});
test('abort inside launch waits for the returned allocated handle and settles it', async () => {
  const controller = new AbortController();
  const f = fixture({signalObject: controller.signal, spawn(events, handle) {
    events.onSpawn({pid: 1234}); controller.abort(); return handle;
  }});
  assert.deepEqual(f.signals, [{signal: 'SIGTERM', time: 0}]); assert.equal(f.releases(), 0);
  f.exit(null, 'SIGTERM'); f.setLive(0); f.time.advance(1);
  const result = await f.session.result; assert.equal(result.canceled, true);
  assert.equal(result.process_group_allocated, true); assert.equal(result.settlement_status, 'ORPHAN_KILLED');
});
test('exit callback inside the final owned observation is captured before result delivery', async () => {
  let callbacks;
  const f = fixture({spawn(events, handle) { callbacks = events; return handle; }, observe({time, identity}) {
    if (time.clock.now() === 8) callbacks.onExit({code: 7, signal: null});
    return {job_id: spec().job_id, pgid: 1234, identity, live_count: time.clock.now() === 8 ? 0 : 1, coverage_complete: true, signal_safe: true};
  }});
  f.spawn(); f.session.settle(); f.time.advance(8);
  const result = await f.session.result; assert.equal(result.process_exit_code, 7); assert.equal(result.process_wall_ms, 8);
  assert.equal(result.settlement_status, 'ORPHAN_KILLED');
});
test('cancellation during release is retained until result delivery', async () => {
  const controller = new AbortController();
  const f = fixture({signalObject: controller.signal, spawn(_events, handle) { return {...handle, release() { controller.abort(); }}; }});
  f.spawn(); f.exit(0); f.setLive(0);
  const result = await f.session.settle(); assert.equal(result.canceled, true); assert.equal(result.termination_reason, 'aborted');
});
test('malformed reentrant exit ends control before any further signal dispatch', async () => {
  let callbacks;
  const f = fixture({spawn(events, handle) { callbacks = events; return handle; }, observe({identity}) {
    callbacks.onExit({code: null, signal: null});
    return {job_id: spec().job_id, pgid: 1234, identity, live_count: 1, coverage_complete: true, signal_safe: true};
  }});
  f.spawn(); const result = await f.session.abort();
  assert.equal(result.settlement_status, null); assert.equal(result.termination_reason, 'control_failed');
  assert.equal(f.signals.length, 0);
});
test('incomplete coverage permits separately qualified safe signals but never proves clean settlement', async () => {
  const f = fixture({observe({identity, live}) {
    return {job_id: spec().job_id, pgid: 1234, identity, live_count: live, coverage_complete: false, signal_safe: true};
  }});
  f.spawn(); f.session.abort(); assert.deepEqual(f.signals, [{signal: 'SIGTERM', time: 0}]);
  f.time.advance(5); assert.deepEqual(f.signals[1], {signal: 'SIGKILL', time: 5});
  f.exit(null, 'SIGKILL'); f.setLive(0); f.time.advance(6);
  const result = await f.session.result;
  assert.equal(result.settlement_status, null); assert.equal(result.canceled, true);
  assert.equal(result.failure_codes.includes('settlement_coverage_incomplete'), true);
});
