import test from 'node:test';
import assert from 'node:assert/strict';
import {FIXOBS} from '../src/fixobs.mjs';
import {createFixobsLifecycleHarness} from '../src/fixobs-port.mjs';

function frame(state = 'S0') {
  const bytes = new Uint8Array(FIXOBS.bytes);
  const color = FIXOBS.colors[state];
  for (let y = 0, offset = 0; y < FIXOBS.height; y++) {
    for (let x = 0; x < FIXOBS.width; x++, offset += 4) {
      const mark = x >= 540 && x < 740 && y >= 260 && y < 460;
      bytes[offset] = mark ? color[0] : 30;
      bytes[offset + 1] = mark ? color[1] : 30;
      bytes[offset + 2] = mark ? color[2] : 30;
      bytes[offset + 3] = 255;
    }
  }
  return bytes;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
function createRig(overrides = {}) {
  let now = 1000, serial = 0;
  const scheduled = new Map();
  const calls = [];
  const clock = {now: () => now};
  const scheduler = {schedule(target, callback) {
    const id = ++serial;
    scheduled.set(id, {target, callback});
    return {cancel() { scheduled.delete(id); }};
  }};
  const setNow = value => { now = value; };
  const advance = target => {
    const item = [...scheduled.entries()].find(([, entry]) => entry.target === target);
    assert.ok(item, `no synthetic deadline at ${target}`);
    scheduled.delete(item[0]);
    now = target;
    item[1].callback(target);
  };
  const ports = {
    launchPort: {launch(request) {
      calls.push(['launch', request]);
      now = Math.max(now, 1200);
      return Promise.resolve({correlation: request.correlation, status: 'ACK',
        t_ack_ms: now, injected_process_id: 'PID-101', error_code: null});
    }},
    actionPort: {dispatchAction(request) {
      calls.push(['action', request]);
      now = Math.max(now, request.kind === 'SPACE_STROKE' ? 2000 : 3200);
      return Promise.resolve({correlation: request.correlation, kind: request.kind,
        status: 'ACK', t_ack_ms: now, error_code: null});
    }},
    capturePort: {captureFrame(request) {
      calls.push(['capture', request]);
      const times = {F0: [1500, 1600], F1: [2500, 2600], F2: [3500, 3600]};
      const [acquired, done] = times[request.phase];
      now = done;
      return Promise.resolve({correlation: request.correlation,
        phase: request.phase, status: 'CAPTURED', t_acquired_ms: acquired,
        buffer: frame(request.phase === 'F0' ? 'S0' :
          request.phase === 'F1' ? 'S1' : 'S2'), error_code: null});
    }},
    stopPort: {stop(request) {
      calls.push(['stop', request]);
      now = Math.max(now, request.t_stop_ms + 200);
      return Promise.resolve({correlation: request.correlation, status: 'ACK',
        t_ack_ms: now, direct_child_exit_observed: true, error_code: null});
    }},
    settlementPort: {observeSettlement(request) {
      calls.push(['settlement', request]);
      now = Math.max(now, request.t_observe_ms + 200);
      return Promise.resolve({correlation: request.correlation,
        status: 'OBSERVED_CLEAN', t_observed_ms: now,
        scope_observation: {launch_closed: true,
          scope_id: request.expected_scope_id, coverage: 'FULL_INSPECTED',
          live_count: 0, conflicting_identities: []},
        fenced_scope_descriptors: [], error_code: null});
    }},
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'ports') Object.assign(ports, value);
    else if (key === 'clock') Object.assign(clock, value);
    else if (key === 'scheduler') Object.assign(scheduler, value);
  }
  const harness = createFixobsLifecycleHarness({
    t0_ms: 1000,
    correlation: {run_id: 'run-1', job_id: 'job-1', generation_id: 'gen-1'},
    ports, clock, scheduler, mode: 'SOURCE_SIMULATION',
  });
  return {harness, ports, calls, scheduled, setNow, advance, get now() { return now; }};
}

test('nominal lifecycle checks all three buffers and matched simulated settlement scope', async () => {
  const rig = createRig();
  const summary = await rig.harness.runLifecycle();
  assert.equal(summary.harness_status, 'COMPLETED');
  assert.equal(summary.model_snapshot.observation, 'BUFFER_SEQUENCE_MATCH');
  assert.deepEqual(summary.model_snapshot.frames, ['MATCH', 'MATCH', 'MATCH']);
  assert.deepEqual(summary.actual_port_calls,
    {launches: 1, actions: 2, captures: 3, stops: 1, settlements: 1});
  assert.equal(summary.ports_summary.settlement.status, 'OBSERVED_CLEAN');
  assert.equal(summary.ports_summary.settlement.scope_observation.scope_id, 'PID-101');
  assert.equal(summary.runtime_admitted, false);
  assert.equal(summary.qualified_observation, false);
  assert.ok(Object.isFrozen(summary));
  assert.ok(Object.isFrozen(summary.model_snapshot.frames));
});

test('capture acquisition may precede its monotonic validation completion', async () => {
  const rig = createRig();
  await rig.harness.step('LAUNCH', 1000);
  const capture = await rig.harness.step('F0_CAPTURE', 1200);
  assert.equal(capture.status, 'COMPLETED');
  assert.deepEqual(capture.snapshot.model_snapshot.frames,
    ['MATCH', 'NOT_RUN', 'NOT_RUN']);
  assert.equal(capture.snapshot.model_snapshot.last_ms, 1600);
  assert.equal(capture.snapshot.model_snapshot.reason, null);
  assert.equal(capture.snapshot.actual_port_calls.captures, 1);
});

test('a stopped active model permits bounded stop and settlement observations', async () => {
  const rig = createRig();
  await rig.harness.step('LAUNCH', 1000);
  const summary = await rig.harness.abort('CALLER_STOP', 1500);
  assert.equal(summary.harness_stop_reason, 'CALLER_ABORT');
  assert.equal(summary.model_snapshot.reason, 'CALLER_STOP');
  assert.equal(summary.model_snapshot.first_stop_ms, 1500);
  assert.equal(summary.model_snapshot.cleanup_deadline_ms, 31500);
  assert.equal(summary.ports_summary.stop.status, 'ACK');
  assert.equal(summary.ports_summary.stop.direct_child_exit_observed, true);
  assert.equal(summary.ports_summary.settlement.status, 'OBSERVED_CLEAN');
  assert.ok(summary.ports_summary.settlement.t_observed_ms <
    summary.model_snapshot.cleanup_deadline_ms);
  assert.deepEqual(summary.actual_port_calls,
    {launches: 1, actions: 0, captures: 0, stops: 1, settlements: 1});
});

test('launch fault counts the call, preserves PR180 stop semantics, and leaves later work unrun', async () => {
  const rig = createRig({ports: {launchPort: {launch() {
    throw new Error('private transport detail');
  }}}});
  const summary = await rig.harness.runLifecycle();
  assert.equal(summary.harness_stop_reason, 'LAUNCH_FAULT');
  assert.equal(summary.model_snapshot.reason, 'CALLER_STOP');
  assert.deepEqual(summary.model_snapshot.frames, ['NOT_RUN', 'NOT_RUN', 'NOT_RUN']);
  assert.deepEqual(summary.actual_port_calls,
    {launches: 1, actions: 0, captures: 0, stops: 1, settlements: 1});
  assert.equal(JSON.stringify(summary).includes('private transport detail'), false);
});

test('synthetic deadline abandons a pending capture; late buffer cannot promote or rewrite summary', async () => {
  const capture = deferred();
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const rig = createRig({ports: {capturePort: {captureFrame(request) {
    if (request.phase === 'F0') { entered(); return capture.promise; }
    return Promise.reject(new Error('unexpected'));
  }}}});
  const run = rig.harness.runLifecycle();
  await waiting;
  rig.advance(11001);
  const summary = await run;
  assert.equal(summary.harness_stop_reason, 'PHASE_DEADLINE');
  assert.equal(summary.model_snapshot.reason, 'PHASE_DEADLINE');
  assert.deepEqual(summary.model_snapshot.frames, ['NOT_RUN', 'NOT_RUN', 'NOT_RUN']);
  assert.equal(summary.model_snapshot.modeled_reservations.capture_attempts, 0);
  assert.equal(summary.actual_port_calls.captures, 1);
  assert.ok(summary.retained_owner_state.abandoned_operations
    .some(item => item.operation_id === 'op_capture_F0'));
  capture.resolve({correlation: {run_id: 'run-1', job_id: 'job-1',
    generation_id: 'gen-1', operation_id: 'op_capture_F0'},
    phase: 'F0', status: 'CAPTURED', t_acquired_ms: 11002,
    buffer: frame(), error_code: null});
  await Promise.resolve();
  assert.equal(summary.model_snapshot.observation, 'UNKNOWN');
  assert.equal(JSON.stringify(summary).includes('Uint8Array'), false);
});

test('abort bypasses the active dispatch lock and traps a late launch PID', async () => {
  const launch = deferred();
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const rig = createRig({ports: {launchPort: {launch() { entered(); return launch.promise; }}}});
  const run = rig.harness.runLifecycle();
  await waiting;
  const summaryPromise = rig.harness.abort('CALLER_STOP', 1500);
  const summary = await summaryPromise;
  await run;
  assert.equal(summary.cancellation_latched, undefined);
  assert.equal(summary.harness_stop_reason, 'CALLER_ABORT');
  launch.resolve({correlation: {run_id: 'run-1', job_id: 'job-1',
    generation_id: 'gen-1', operation_id: 'op_launch_0'}, status: 'ACK',
    t_ack_ms: 1600, injected_process_id: 'PID-LATE', error_code: null});
  await Promise.resolve();
  assert.ok(rig.harness.getSnapshot().retained_owner_state
    .orphaned_injected_process_ids.includes('PID-LATE'));
  assert.ok(rig.harness.getSnapshot().retained_owner_state.fenced_scopes
    .includes('late-launch:PID-LATE'));
});

test('reentrant step is synchronously rejected while an operation is pending', async () => {
  const capture = deferred();
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const rig = createRig({ports: {capturePort: {captureFrame(request) {
    if (request.phase === 'F0') { entered(); return capture.promise; }
    return Promise.reject(new Error('unexpected'));
  }}}});
  const run = rig.harness.runLifecycle();
  await waiting;
  assert.throws(() => rig.harness.step('KEY_ACTION', 1500),
    error => error.code === 'CONCURRENT_DISPATCH_REJECTED');
  capture.resolve({correlation: {run_id: 'run-1', job_id: 'job-1',
    generation_id: 'gen-1', operation_id: 'op_capture_F0'}, phase: 'F0',
    status: 'CAPTURED', t_acquired_ms: 1500, buffer: frame(), error_code: null});
  await run;
});

test('same duplicate launch ACK is ignored; conflicting duplicate fences the run', async () => {
  let setLaunchClock = () => {};
  const duplicate = (firstPid, secondPid = firstPid) => ({launch(request) {
    return {then(resolve) {
      const value = id => ({correlation: request.correlation, status: 'ACK',
        t_ack_ms: 1200, injected_process_id: id, error_code: null});
      setLaunchClock(1200);
      resolve(value(firstPid));
      resolve(value(secondPid));
    }};
  }});
  const good = createRig({ports: {launchPort: duplicate('PID-101')}});
  setLaunchClock = good.setNow;
  const goodSummary = await good.harness.runLifecycle();
  assert.equal(goodSummary.harness_status, 'COMPLETED');
  assert.ok(goodSummary.audit_events.some(event =>
    event.event === 'LATE_OUTCOME_DISCARDED' && event.detail_code === 'IGNORED'));

  const conflicting = createRig({ports: {launchPort:
    duplicate('PID-101', 'PID-102')}});
  setLaunchClock = conflicting.setNow;
  const conflictSummary = await conflicting.harness.runLifecycle();
  assert.equal(conflictSummary.harness_stop_reason, 'IDENTITY_CONFLICT');
  assert.equal(conflictSummary.actual_port_calls.launches, 1);
});

test('action identity mismatch stops without using the conflicting identity', async () => {
  const rig = createRig({ports: {actionPort: {dispatchAction(request) {
    rigSetNow = 2000;
    return Promise.resolve({correlation: request.correlation, kind: request.kind,
      status: 'ACK', t_ack_ms: 2000, injected_process_id: 'PID-102',
      error_code: null});
  }}}});
  let rigSetNow = 2000;
  const summary = await rig.harness.runLifecycle();
  assert.equal(summary.harness_stop_reason, 'IDENTITY_CONFLICT');
  assert.equal(summary.ports_summary.stop.injected_process_id, undefined);
  assert.equal(summary.ports_summary.stop.status, 'ACK');
});

test('partial, nonempty, and unacknowledged cleanup evidence is never promoted to clean', async () => {
  let setPartialClock = () => {};
  const partial = createRig({ports: {settlementPort: {observeSettlement(request) {
    setPartialClock(4000);
    return Promise.resolve({correlation: request.correlation, status: 'OBSERVED_CLEAN',
      t_observed_ms: 4000, scope_observation: {launch_closed: true,
        scope_id: request.expected_scope_id, coverage: 'PARTIAL', live_count: 0,
        conflicting_identities: []}, fenced_scope_descriptors: [], error_code: null});
  }}}});
  setPartialClock = partial.setNow;
  const partialSummary = await partial.harness.runLifecycle();
  assert.equal(partialSummary.ports_summary.settlement.status, 'UNKNOWN');

  let setNonemptyClock = () => {};
  const nonempty = createRig({ports: {settlementPort: {observeSettlement(request) {
    setNonemptyClock(4000);
    return Promise.resolve({correlation: request.correlation, status: 'OBSERVED_NONEMPTY',
      t_observed_ms: 4000, scope_observation: {launch_closed: true,
        scope_id: request.expected_scope_id, coverage: 'FULL_INSPECTED', live_count: 1,
        conflicting_identities: []}, fenced_scope_descriptors: ['simulated:live'],
      error_code: null});
  }}}});
  setNonemptyClock = nonempty.setNow;
  const nonemptySummary = await nonempty.harness.runLifecycle();
  assert.equal(nonemptySummary.ports_summary.settlement.status, 'OBSERVED_NONEMPTY');

  const unacknowledged = createRig();
  const noLaunch = await unacknowledged.harness.abort('CALLER_ABORT', 1500);
  assert.equal(noLaunch.ports_summary.settlement.status, 'UNKNOWN');
  assert.equal(noLaunch.ports_summary.settlement.scope_observation, null);
  assert.ok(noLaunch.retained_owner_state.fenced_scopes
    .includes('unacknowledged_launch_scope'));
});

test('malformed result getters and proxies are rejected without invoking getters', async () => {
  let getterCalls = 0;
  const rig = createRig({ports: {launchPort: {launch() {
    return Promise.resolve(Object.defineProperty({}, 'correlation', {
      get() { getterCalls++; throw new Error('private'); },
    }));
  }}}});
  const summary = await rig.harness.runLifecycle();
  assert.equal(getterCalls, 0);
  assert.equal(summary.harness_stop_reason, 'LAUNCH_FAULT');

  const proxied = createRig({ports: {launchPort: {launch() {
    return Promise.resolve(new Proxy({}, {getOwnPropertyDescriptor() {
      throw new Error('private proxy');
    }}));
  }}}});
  assert.equal((await proxied.harness.runLifecycle()).harness_stop_reason, 'LAUNCH_FAULT');
});

test('rejected promises and hostile thenables are trapped with bounded error projections', async () => {
  const rejected = createRig({ports: {launchPort: {launch() {
    return Promise.reject(new Error('secret stack and transport payload'));
  }}}});
  const summary = await rejected.harness.runLifecycle();
  const text = JSON.stringify(summary);
  assert.equal(text.includes('secret stack'), false);
  assert.equal(text.includes('transport payload'), false);

  const hostile = createRig({ports: {launchPort: {launch() {
    return {get then() { throw new Error('getter secret'); }};
  }}}});
  const hostileSummary = await hostile.harness.runLifecycle();
  assert.equal(hostileSummary.harness_stop_reason, 'LAUNCH_FAULT');
  assert.equal(JSON.stringify(hostileSummary).includes('getter secret'), false);
});

test('pre-validation deadline leaves PR180 reservations untouched and port calls zero', async () => {
  const rig = createRig();
  rig.setNow(11001);
  const step = await rig.harness.step('LAUNCH', 11001);
  assert.equal(step.snapshot.model_snapshot.reason, 'PHASE_DEADLINE');
  assert.deepEqual(step.snapshot.model_snapshot.frames, ['NOT_RUN', 'NOT_RUN', 'NOT_RUN']);
  assert.equal(step.snapshot.model_snapshot.modeled_reservations.launches, 0);
  assert.equal(step.snapshot.actual_port_calls.launches, 0);
});

test('backwards model time and future port timestamps remain invalid', async () => {
  const backwards = createRig();
  backwards.harness.poll(999);
  const backwardsSummary = await backwards.harness.runLifecycle();
  assert.equal(backwardsSummary.harness_stop_reason, 'INVALID_CLOCK');
  assert.equal(backwardsSummary.model_snapshot.reason, 'INVALID_CLOCK');

  const future = createRig({ports: {launchPort: {launch(request) {
    return Promise.resolve({correlation: request.correlation, status: 'ACK',
      t_ack_ms: 1201, injected_process_id: 'PID-101', error_code: null});
  }}}});
  const futureSummary = await future.harness.runLifecycle();
  assert.equal(futureSummary.harness_stop_reason, 'INVALID_CLOCK');
  assert.equal(futureSummary.model_snapshot.reason, 'INVALID_CLOCK');
});

test('completed harness rejects reuse and returned summary remains frozen', async () => {
  const rig = createRig();
  const summary = await rig.harness.runLifecycle();
  assert.throws(() => rig.harness.runLifecycle(),
    error => error.code === 'HARNESS_ALREADY_COMPLETED');
  assert.throws(() => rig.harness.step('F0_CAPTURE', 5000),
    error => error.code === 'HARNESS_ALREADY_COMPLETED');
  assert.ok(Object.isFrozen(summary));
  assert.ok(Object.isFrozen(summary.ports_summary));
});

test('wrong cleanup correlations latch identity conflict and veto a clean observer', async () => {
  let stopClock = () => {};
  const wrongStop = createRig({ports: {stopPort: {stop(request) {
    stopClock(request.t_stop_ms + 200);
    return Promise.resolve({correlation: {...request.correlation, operation_id: 'wrong-stop'},
      status: 'ACK', t_ack_ms: request.t_stop_ms + 200,
      direct_child_exit_observed: true, error_code: null});
  }}}});
  stopClock = wrongStop.setNow;
  const stopSummary = await wrongStop.harness.runLifecycle();
  assert.equal(stopSummary.harness_stop_reason, 'IDENTITY_CONFLICT');
  assert.equal(stopSummary.model_snapshot.first_stop_ms, 3600);
  assert.equal(stopSummary.model_snapshot.cleanup_deadline_ms, 33600);
  assert.equal(stopSummary.ports_summary.stop.error_code, 'IDENTITY_CONFLICT');
  assert.equal(stopSummary.actual_port_calls.settlements, 1);
  assert.equal(stopSummary.ports_summary.settlement.status, 'UNKNOWN');
  assert.equal(stopSummary.ports_summary.settlement.error_code, 'IDENTITY_CONFLICT');
  assert.equal(stopSummary.ports_summary.settlement.scope_observation, null);
  assert.ok(stopSummary.ports_summary.settlement.fenced_scope_descriptors
    .includes('simulated-scope:PID-101'));
  assert.ok(stopSummary.retained_owner_state.fenced_scopes
    .includes('simulated-scope:PID-101'));

  let settlementClock = () => {};
  const wrongSettlement = createRig({ports: {settlementPort: {observeSettlement(request) {
    settlementClock(4000);
    return Promise.resolve({correlation: {...request.correlation, job_id: 'other-job'},
      status: 'OBSERVED_CLEAN', t_observed_ms: 4000,
      scope_observation: {launch_closed: true, scope_id: request.expected_scope_id,
        coverage: 'FULL_INSPECTED', live_count: 0, conflicting_identities: []},
      fenced_scope_descriptors: [], error_code: null});
  }}}});
  settlementClock = wrongSettlement.setNow;
  const settlementSummary = await wrongSettlement.harness.runLifecycle();
  assert.equal(settlementSummary.harness_stop_reason, 'IDENTITY_CONFLICT');
  assert.equal(settlementSummary.ports_summary.settlement.status, 'UNKNOWN');
  assert.equal(settlementSummary.ports_summary.settlement.error_code, 'IDENTITY_CONFLICT');
  assert.ok(settlementSummary.retained_owner_state.fenced_scopes
    .includes('simulated-scope:PID-101'));
});

test('latched cleanup identity conflict survives observer fault and deadline', async () => {
  const wrongStopWith = observeSettlement => {
    let setNow = () => {};
    const rig = createRig({ports: {
      stopPort: {stop(request) {
        setNow(request.t_stop_ms + 200);
        return Promise.resolve({correlation: {...request.correlation, operation_id: 'wrong-stop'},
          status: 'ACK', t_ack_ms: request.t_stop_ms + 200,
          direct_child_exit_observed: true, error_code: null});
      }},
      settlementPort: {observeSettlement},
    }});
    setNow = rig.setNow;
    return rig;
  };
  const assertLatched = summary => {
    assert.equal(summary.harness_status, 'FAULT');
    assert.equal(summary.harness_stop_reason, 'IDENTITY_CONFLICT');
    assert.equal(summary.model_snapshot.first_stop_ms, 3600);
    assert.equal(summary.model_snapshot.cleanup_deadline_ms, 33600);
    assert.equal(summary.actual_port_calls.stops, 1);
    assert.equal(summary.actual_port_calls.settlements, 1);
    assert.equal(summary.ports_summary.settlement.status, 'UNKNOWN');
    assert.equal(summary.ports_summary.settlement.error_code, 'IDENTITY_CONFLICT');
    assert.equal(summary.ports_summary.settlement.scope_observation, null);
    assert.ok(summary.ports_summary.settlement.fenced_scope_descriptors
      .includes('simulated-scope:PID-101'));
  };

  const rejected = wrongStopWith(() => Promise.reject(new Error('observer fault')));
  assertLatched(await rejected.harness.runLifecycle());

  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const pending = wrongStopWith(() => {
    entered();
    return new Promise(() => {});
  });
  const run = pending.harness.runLifecycle();
  await waiting;
  pending.advance(33600);
  const deadlineSummary = await run;
  assertLatched(deadlineSummary);
  assert.ok(deadlineSummary.retained_owner_state.abandoned_operations
    .some(item => item.operation_id === 'op_settlement_0'));
});

test('abort fixes first stop and cleanup bound before reentrant cancellation', async () => {
  let harness, setNow = () => {}, reentered = false;
  const rig = createRig({
    ports: {launchPort: {launch() { return new Promise(() => {}); }}},
    scheduler: {schedule(target) {
      return {cancel() {
        if (target === 11001 && !reentered) {
          reentered = true;
          setNow(11001);
          void harness.deliverDeadline(11001);
        }
      }};
    }},
  });
  harness = rig.harness;
  setNow = rig.setNow;
  const run = harness.runLifecycle();
  const summary = await harness.abort('CALLER_STOP', 1500);
  await run;
  assert.equal(reentered, true);
  assert.equal(summary.harness_stop_reason, 'CALLER_ABORT');
  assert.equal(summary.model_snapshot.reason, 'CALLER_STOP');
  assert.equal(summary.model_snapshot.first_stop_ms, 1500);
  assert.equal(summary.model_snapshot.cleanup_deadline_ms, 31500);
  assert.equal(summary.retained_owner_state.abandoned_operations[0].reason, 'CALLER_ABORT');
});

test('duplicate launch ACK checks correlation against immutable first identity', async () => {
  let setNow = () => {};
  const changedCorrelation = createRig({ports: {launchPort: {launch(request) {
    return {then(resolve) {
      setNow(1200);
      const first = {correlation: request.correlation, status: 'ACK', t_ack_ms: 1200,
        injected_process_id: 'PID-101', error_code: null};
      resolve(first);
      resolve({...first, correlation: {...request.correlation, operation_id: 'other'}});
    }};
  }}}});
  setNow = changedCorrelation.setNow;
  const changedSummary = await changedCorrelation.harness.runLifecycle();
  assert.equal(changedSummary.harness_stop_reason, 'IDENTITY_CONFLICT');
  assert.equal(changedSummary.actual_port_calls.launches, 1);
  assert.ok(changedSummary.retained_owner_state.fenced_scopes
    .includes('simulated-scope:PID-101'));

  const mutatedFirst = createRig({ports: {launchPort: {launch(request) {
    return {then(resolve) {
      setNow(1200);
      const first = {correlation: request.correlation, status: 'ACK', t_ack_ms: 1200,
        injected_process_id: 'PID-101', error_code: null};
      resolve(first);
      first.injected_process_id = 'PID-102';
      resolve({...first});
    }};
  }}}});
  setNow = mutatedFirst.setNow;
  const mutatedSummary = await mutatedFirst.harness.runLifecycle();
  assert.equal(mutatedSummary.harness_stop_reason, 'IDENTITY_CONFLICT');
  assert.ok(mutatedSummary.retained_owner_state.fenced_scopes
    .includes('simulated-scope:PID-101'));
});

test('maximum valid process IDs retain internally prefixed fences', async () => {
  const longPid = 'P'.repeat(128);
  const pending = deferred();
  const late = createRig({ports: {launchPort: {launch() { return pending.promise; }}}});
  const run = late.harness.runLifecycle();
  await late.harness.abort('CALLER_STOP', 1500);
  await run;
  pending.resolve({correlation: {run_id: 'run-1', job_id: 'job-1',
    generation_id: 'gen-1', operation_id: 'op_launch_0'}, status: 'ACK',
  t_ack_ms: 1600, injected_process_id: longPid, error_code: null});
  await Promise.resolve();
  const retained = late.harness.getSnapshot().retained_owner_state;
  assert.ok(retained.orphaned_injected_process_ids.includes(longPid));
  assert.ok(retained.fenced_scopes.includes(`late-launch:${longPid}`));

  let setNow = () => {};
  const conflict = createRig({ports: {
    launchPort: {launch(request) {
      setNow(1200);
      return Promise.resolve({correlation: request.correlation, status: 'ACK',
        t_ack_ms: 1200, injected_process_id: longPid, error_code: null});
    }},
    actionPort: {dispatchAction(request) {
      setNow(2000);
      return Promise.resolve({correlation: request.correlation, kind: request.kind,
        status: 'ACK', t_ack_ms: 2000, injected_process_id: 'PID-OTHER',
        error_code: null});
    }},
  }});
  setNow = conflict.setNow;
  const summary = await conflict.harness.runLifecycle();
  assert.equal(summary.harness_stop_reason, 'IDENTITY_CONFLICT');
  assert.ok(summary.retained_owner_state.fenced_scopes
    .includes(`simulated-scope:${longPid}`));
});

test('local fences survive rejected observation and empty conflict descriptors', async () => {
  const rejected = createRig({ports: {settlementPort: {observeSettlement() {
    return Promise.reject(new Error('private observer detail'));
  }}}});
  const unacknowledged = await rejected.harness.abort('CALLER_ABORT', 1500);
  assert.equal(unacknowledged.ports_summary.settlement.status, 'UNKNOWN');
  assert.ok(unacknowledged.retained_owner_state.fenced_scopes
    .includes('unacknowledged_launch_scope'));
  assert.ok(unacknowledged.ports_summary.settlement.fenced_scope_descriptors
    .includes('unacknowledged_launch_scope'));

  let setNow = () => {};
  const conflicting = createRig({ports: {settlementPort: {observeSettlement(request) {
    setNow(4000);
    return Promise.resolve({correlation: request.correlation,
      status: 'CONFLICTING_SCOPE', t_observed_ms: 4000,
      scope_observation: {launch_closed: true, scope_id: request.expected_scope_id,
        coverage: 'FULL_INSPECTED', live_count: 0,
        conflicting_identities: ['PID-OTHER']},
      fenced_scope_descriptors: [], error_code: null});
  }}}});
  setNow = conflicting.setNow;
  const summary = await conflicting.harness.runLifecycle();
  assert.equal(summary.ports_summary.settlement.status, 'CONFLICTING_SCOPE');
  assert.ok(summary.retained_owner_state.fenced_scopes
    .includes('simulated-scope:PID-101'));
  assert.ok(summary.ports_summary.settlement.fenced_scope_descriptors
    .includes('simulated-scope:PID-101'));
});

test('retaining capture thenable cannot repeat validation after its first callback', async () => {
  let retainedFulfill, original, setNow = () => {};
  const rig = createRig({ports: {capturePort: {captureFrame(request) {
    assert.equal(request.phase, 'F0');
    return {then(fulfill) {
      retainedFulfill = fulfill;
      setNow(1600);
      original = {correlation: request.correlation, phase: 'F0',
        status: 'CAPTURED', t_acquired_ms: 1500,
        buffer: frame('S0'), error_code: null};
      fulfill(original);
    }};
  }}}});
  setNow = rig.setNow;
  await rig.harness.step('LAUNCH', 1000);
  const first = await rig.harness.step('F0_CAPTURE', 1200);
  assert.equal(first.snapshot.model_snapshot.modeled_reservations.capture_attempts, 1);
  assert.equal(first.snapshot.model_snapshot.frames[0], 'MATCH');
  original = null;
  retainedFulfill({buffer: null});
  assert.equal(rig.harness.getSnapshot().model_snapshot.modeled_reservations.capture_attempts, 1);
  assert.equal(first.snapshot.model_snapshot.frames[0], 'MATCH');
});

test('malformed error codes reject nominal success records on all five ports', async () => {
  const malformed = 'OUTSIDE_FIXOBS_ERROR_CODE';
  let setNow = () => {};
  const launch = createRig({ports: {launchPort: {launch(request) {
    setNow(1200);
    return Promise.resolve({correlation: request.correlation, status: 'ACK',
      t_ack_ms: 1200, injected_process_id: 'PID-101', error_code: malformed});
  }}}});
  setNow = launch.setNow;
  const launchSummary = await launch.harness.runLifecycle();
  assert.equal(launchSummary.ports_summary.launch.status, 'FAULT');
  assert.equal(launchSummary.actual_port_calls.captures, 0);

  const action = createRig({ports: {actionPort: {dispatchAction(request) {
    setNow(2000);
    return Promise.resolve({correlation: request.correlation, kind: request.kind,
      status: 'ACK', t_ack_ms: 2000, error_code: malformed});
  }}}});
  setNow = action.setNow;
  const actionSummary = await action.harness.runLifecycle();
  assert.equal(actionSummary.ports_summary.actions[0].status, 'FAULT');
  assert.equal(actionSummary.actual_port_calls.captures, 1);

  const capture = createRig({ports: {capturePort: {captureFrame(request) {
    setNow(1600);
    return Promise.resolve({correlation: request.correlation, phase: request.phase,
      status: 'CAPTURED', t_acquired_ms: 1500, buffer: frame('S0'),
      error_code: malformed});
  }}}});
  setNow = capture.setNow;
  const captureSummary = await capture.harness.runLifecycle();
  assert.equal(captureSummary.ports_summary.captures[0].status, 'FAULT');
  assert.equal(captureSummary.model_snapshot.modeled_reservations.capture_attempts, 0);

  const stop = createRig({ports: {stopPort: {stop(request) {
    setNow(request.t_stop_ms + 200);
    return Promise.resolve({correlation: request.correlation, status: 'ACK',
      t_ack_ms: request.t_stop_ms + 200, direct_child_exit_observed: true,
      error_code: malformed});
  }}}});
  setNow = stop.setNow;
  const stopSummary = await stop.harness.runLifecycle();
  assert.equal(stopSummary.ports_summary.stop.status, 'FAULT');
  assert.equal(stopSummary.ports_summary.stop.error_code, 'STOP_FAULT');

  const settlement = createRig({ports: {settlementPort: {observeSettlement(request) {
    setNow(4000);
    return Promise.resolve({correlation: request.correlation,
      status: 'OBSERVED_CLEAN', t_observed_ms: 4000,
      scope_observation: {launch_closed: true, scope_id: request.expected_scope_id,
        coverage: 'FULL_INSPECTED', live_count: 0, conflicting_identities: []},
      fenced_scope_descriptors: [], error_code: malformed});
  }}}});
  setNow = settlement.setNow;
  const settlementSummary = await settlement.harness.runLifecycle();
  assert.equal(settlementSummary.ports_summary.settlement.status, 'UNKNOWN');
  assert.equal(settlementSummary.ports_summary.settlement.error_code, 'SETTLEMENT_FAULT');
});

test('available wrong stop and settlement correlations survive a reentrant expiry clock', async () => {
  for (const wrongPhase of ['stop', 'settlement']) {
    let rig, armed = false;
    const ports = wrongPhase === 'stop' ?
      {stopPort: {stop(request) {
        rig.setNow(4000);
        armed = true;
        return Promise.resolve({correlation: {...request.correlation,
          operation_id: 'wrong-stop'}, status: 'ACK', t_ack_ms: 4000,
        direct_child_exit_observed: true, error_code: null});
      }}} :
      {settlementPort: {observeSettlement(request) {
        rig.setNow(4000);
        armed = true;
        return Promise.resolve({correlation: {...request.correlation,
          operation_id: 'wrong-settlement'}, status: 'OBSERVED_CLEAN',
        t_observed_ms: 4000, scope_observation: {launch_closed: true,
          scope_id: request.expected_scope_id, coverage: 'FULL_INSPECTED',
          live_count: 0, conflicting_identities: []},
        fenced_scope_descriptors: [], error_code: null});
      }}};
    rig = createRig({ports, clock: {now() {
      if (armed) {
        armed = false;
        rig.setNow(33600);
        void rig.harness.deliverDeadline(33600);
      }
      return rig.now;
    }}});
    const summary = await rig.harness.runLifecycle();
    assert.equal(summary.harness_stop_reason, 'IDENTITY_CONFLICT');
    assert.equal(summary.model_snapshot.first_stop_ms, 3600);
    assert.equal(summary.model_snapshot.cleanup_deadline_ms, 33600);
    assert.equal(summary.model_snapshot.cleanup_window, 'ELAPSED');
    assert.equal(summary.ports_summary.settlement.status, 'UNKNOWN');
    assert.equal(summary.ports_summary.settlement.error_code, 'IDENTITY_CONFLICT');
    assert.ok(summary.retained_owner_state.fenced_scopes
      .includes('simulated-scope:PID-101'));
    if (wrongPhase === 'stop') {
      assert.equal(summary.ports_summary.stop.error_code, 'IDENTITY_CONFLICT');
      assert.equal(summary.actual_port_calls.settlements, 0);
    } else {
      assert.equal(summary.actual_port_calls.settlements, 1);
    }
  }
});

test('wrong settlement correlation is latched before its cancel callback expires cleanup', async () => {
  let rig, cleanupRegistrations = 0;
  rig = createRig({
    ports: {settlementPort: {observeSettlement(request) {
      rig.setNow(4000);
      return Promise.resolve({correlation: {...request.correlation,
        job_id: 'wrong-job'}, status: 'OBSERVED_CLEAN',
      t_observed_ms: 4000, scope_observation: {launch_closed: true,
        scope_id: request.expected_scope_id, coverage: 'FULL_INSPECTED',
        live_count: 0, conflicting_identities: []},
      fenced_scope_descriptors: [], error_code: null});
    }}},
    scheduler: {schedule(target, callback) {
      const ordinal = target === 33600 ? ++cleanupRegistrations : 0;
      return {cancel() {
        if (ordinal === 3) {
          rig.setNow(33600);
          callback(33600);
        }
      }};
    }},
  });
  const summary = await rig.harness.runLifecycle();
  assert.equal(cleanupRegistrations, 3);
  assert.equal(summary.harness_stop_reason, 'IDENTITY_CONFLICT');
  assert.equal(summary.ports_summary.settlement.error_code, 'IDENTITY_CONFLICT');
  assert.equal(summary.model_snapshot.cleanup_window, 'ELAPSED');
  assert.ok(summary.retained_owner_state.fenced_scopes
    .includes('simulated-scope:PID-101'));
});

test('validated unsafe scope fields create a local fence despite contradictory statuses', async () => {
  for (const scopeChange of [
    {conflicting_identities: ['PID-FOREIGN'], status: 'OBSERVED_CLEAN'},
    {live_count: 1, status: 'UNKNOWN'},
    {scope_id: 'PID-FOREIGN', status: 'OBSERVED_CLEAN'},
  ]) {
    let setNow = () => {};
    const rig = createRig({ports: {settlementPort: {observeSettlement(request) {
      setNow(4000);
      const {status, ...fields} = scopeChange;
      return Promise.resolve({correlation: request.correlation, status,
        t_observed_ms: 4000, scope_observation: {launch_closed: true,
          scope_id: request.expected_scope_id, coverage: 'FULL_INSPECTED',
          live_count: 0, conflicting_identities: [], ...fields},
        fenced_scope_descriptors: [], error_code: null});
    }}}});
    setNow = rig.setNow;
    const summary = await rig.harness.runLifecycle();
    assert.equal(summary.ports_summary.settlement.status, 'UNKNOWN');
    assert.ok(summary.retained_owner_state.fenced_scopes
      .includes('simulated-scope:PID-101'));
    assert.ok(summary.ports_summary.settlement.fenced_scope_descriptors
      .includes('simulated-scope:PID-101'));
    assert.equal(Object.hasOwn(summary.ports_summary.settlement, 'unsafeScope'), false);
  }
});

test('synchronous cleanup registration expiry closes without dispatching Stop', async () => {
  let registrations = 0;
  const rig = createRig({scheduler: {schedule(target, callback) {
    if (target === 33600 && ++registrations === 1) callback(33600);
    return {cancel() {}};
  }}});
  const summary = await rig.harness.runLifecycle();
  assert.equal(registrations, 1);
  assert.equal(summary.actual_port_calls.stops, 0);
  assert.equal(summary.actual_port_calls.settlements, 0);
  assert.equal(rig.calls.some(([kind]) => kind === 'stop'), false);
  assert.equal(summary.ports_summary.settlement.error_code, 'CLEANUP_DEADLINE');
  assert.equal(rig.harness.getSnapshot().harness_state, 'COMPLETED');
});

test('cleanup token cancellation cannot change an assigned terminal result', async () => {
  let rig, cleanupRegistrations = 0, cancelReentered = false;
  rig = createRig({scheduler: {schedule(target, callback) {
    const ordinal = target === 33600 ? ++cleanupRegistrations : 0;
    return {cancel() {
      if (ordinal === 1) {
        cancelReentered = true;
        rig.setNow(33600);
        callback(33600);
      }
    }};
  }}});
  const summary = await rig.harness.runLifecycle();
  assert.equal(cancelReentered, true);
  assert.equal(summary.ports_summary.settlement.status, 'OBSERVED_CLEAN');
  assert.equal(summary.ports_summary.settlement.error_code, null);
  assert.equal(summary.actual_port_calls.stops, 1);
  assert.equal(summary.actual_port_calls.settlements, 1);
  assert.equal(summary.model_snapshot.cleanup_window, 'OPEN');
});

test('abort during cleanup latches cancellation without replacing first-stop disposition', async () => {
  let harness, setNow = () => {};
  const rig = createRig({ports: {
    stopPort: {stop(request) {
      setNow(3800);
      return Promise.resolve({correlation: {...request.correlation,
        operation_id: 'wrong-stop'}, status: 'ACK', t_ack_ms: 3800,
      direct_child_exit_observed: true, error_code: null});
    }},
    settlementPort: {observeSettlement(request) {
      void harness.abort('CALLER_STOP', request.t_observe_ms);
      setNow(4000);
      return Promise.resolve({correlation: request.correlation,
        status: 'OBSERVED_CLEAN', t_observed_ms: 4000,
        scope_observation: {launch_closed: true,
          scope_id: request.expected_scope_id, coverage: 'FULL_INSPECTED',
          live_count: 0, conflicting_identities: []},
        fenced_scope_descriptors: [], error_code: null});
    }},
  }});
  harness = rig.harness;
  setNow = rig.setNow;
  const summary = await harness.runLifecycle();
  assert.equal(summary.harness_stop_reason, 'IDENTITY_CONFLICT');
  assert.equal(summary.model_snapshot.reason, 'THREE_BUFFER_PREDICATES_MATCH');
  assert.equal(summary.model_snapshot.first_stop_ms, 3600);
  assert.equal(summary.model_snapshot.cleanup_deadline_ms, 33600);
  assert.equal(summary.ports_summary.settlement.error_code, 'IDENTITY_CONFLICT');
  assert.equal(harness.getSnapshot().cancellation_latched, true);
  assert.equal(summary.actual_port_calls.stops, 1);
});

test('step rejects every phase outside the closed enum before any work', () => {
  const rig = createRig();
  const longPhase = 'private-phase-'.repeat(1000);
  for (const phase of [longPhase, 'constructor', '__proto__', 42, null]) {
    assert.throws(() => rig.harness.step(phase, 1000),
      error => error.code === 'UNEXPECTED_SEQUENCE' &&
        !error.message.includes(longPhase));
  }
  const snapshot = rig.harness.getSnapshot();
  assert.equal(snapshot.harness_state, 'CREATED');
  assert.deepEqual(snapshot.actual_port_calls,
    {launches: 0, actions: 0, captures: 0, stops: 0, settlements: 0});
  assert.equal(rig.calls.length, 0);
});

test('late noncaptured capture results reconcile the PR180 phase deadline', async () => {
  for (const status of ['FAULT', 'TIMEOUT']) {
    let setNow = () => {};
    const rig = createRig({ports: {capturePort: {captureFrame(request) {
      setNow(11001);
      return Promise.resolve({correlation: request.correlation,
        phase: request.phase, status, t_acquired_ms: 1500,
        buffer: null, error_code: null});
    }}}});
    setNow = rig.setNow;
    const summary = await rig.harness.runLifecycle();
    assert.equal(summary.harness_stop_reason, 'PHASE_DEADLINE');
    assert.equal(summary.model_snapshot.reason, 'PHASE_DEADLINE');
    assert.equal(summary.model_snapshot.first_stop_ms, 11001);
    assert.equal(summary.model_snapshot.cleanup_deadline_ms, 41001);
    assert.equal(summary.model_snapshot.modeled_reservations.capture_attempts, 0);
    assert.equal(summary.ports_summary.captures[0].status, 'TIMEOUT');
    assert.equal(summary.ports_summary.captures[0].error_code, 'PHASE_DEADLINE');
    assert.equal(summary.actual_port_calls.captures, 1);
  }
});

test('available wrong cleanup correlation survives malformed shape and reentrant expiry', async () => {
  for (const phase of ['stop', 'settlement']) {
    for (const shape of ['missing', 'extra']) {
      let rig, armed = false, getterCalls = 0;
      const malformed = request => {
        const result = phase === 'stop' ?
          {correlation: {...request.correlation, operation_id: 'wrong-stop'},
            status: 'ACK', t_ack_ms: 1700,
            direct_child_exit_observed: true, error_code: null} :
          {correlation: {...request.correlation, operation_id: 'wrong-settlement'},
            status: 'OBSERVED_CLEAN', t_observed_ms: 1900,
            scope_observation: {launch_closed: true, scope_id: null,
              coverage: 'FULL_INSPECTED', live_count: 0,
              conflicting_identities: []},
            fenced_scope_descriptors: [], error_code: null};
        if (shape === 'missing') delete result.error_code;
        else Object.defineProperty(result, 'secret', {get() {
          getterCalls++;
          throw new Error('private cleanup getter');
        }});
        rig.setNow(phase === 'stop' ? 1700 : 1900);
        armed = true;
        return Promise.resolve(result);
      };
      rig = createRig({
        ports: phase === 'stop' ?
          {stopPort: {stop: malformed}} :
          {settlementPort: {observeSettlement: malformed}},
        clock: {now() {
          if (armed) {
            armed = false;
            rig.setNow(31500);
            void rig.harness.deliverDeadline(31500);
          }
          return rig.now;
        }},
      });
      const summary = await rig.harness.abort('CALLER_STOP', 1500);
      assert.equal(getterCalls, 0);
      assert.equal(summary.harness_stop_reason, 'IDENTITY_CONFLICT');
      assert.equal(summary.model_snapshot.first_stop_ms, 1500);
      assert.equal(summary.model_snapshot.cleanup_deadline_ms, 31500);
      assert.equal(summary.ports_summary.settlement.status, 'UNKNOWN');
      assert.equal(summary.ports_summary.settlement.error_code, 'IDENTITY_CONFLICT');
      assert.ok(summary.retained_owner_state.fenced_scopes
        .includes('unacknowledged_launch_scope'));
      if (phase === 'stop') {
        assert.equal(summary.ports_summary.stop.error_code, 'IDENTITY_CONFLICT');
      }
      assert.equal(JSON.stringify(summary).includes('private cleanup getter'), false);
    }
  }
});

test('early active callbacks and manual deadlines leave PR180 running', async () => {
  const launch = deferred();
  const rig = createRig({ports: {launchPort: {launch() {
    return launch.promise;
  }}}});
  const step = rig.harness.step('LAUNCH', 1000);
  const active = [...rig.scheduled.values()].find(item => item.target === 11001);
  assert.ok(active);
  active.callback(11000);
  const early = await rig.harness.deliverDeadline(11000);
  assert.equal(early.model_snapshot.first_stop_ms, null);
  assert.equal(early.model_snapshot.cleanup_window, 'NOT_STARTED');
  assert.equal(early.actual_port_calls.stops, 0);
  rig.setNow(1200);
  launch.resolve({correlation: {run_id: 'run-1', job_id: 'job-1',
    generation_id: 'gen-1', operation_id: 'op_launch_0'},
  status: 'ACK', t_ack_ms: 1200, injected_process_id: 'PID-101',
  error_code: null});
  const continued = await step;
  assert.equal(continued.snapshot.harness_state, 'F0_CAPTURING');
  assert.equal(continued.snapshot.model_snapshot.first_stop_ms, null);
  const summary = await rig.harness.abort('CALLER_STOP', 1500);
  assert.equal(summary.model_snapshot.first_stop_ms, 1500);
  assert.equal(summary.model_snapshot.cleanup_deadline_ms, 31500);
  assert.deepEqual(summary.actual_port_calls,
    {launches: 1, actions: 0, captures: 0, stops: 1, settlements: 1});
});

test('an early callback retains the pending call until the actual inclusive threshold', async () => {
  const rig = createRig({ports: {launchPort: {launch() {
    return new Promise(() => {});
  }}}});
  const run = rig.harness.runLifecycle();
  const active = [...rig.scheduled.values()].find(item => item.target === 11001);
  assert.ok(active);
  active.callback(11000);
  assert.equal(rig.harness.getSnapshot().model_snapshot.first_stop_ms, null);
  assert.equal(rig.harness.getSnapshot().actual_port_calls.stops, 0);
  rig.advance(11001);
  const summary = await run;
  assert.equal(summary.harness_stop_reason, 'PHASE_DEADLINE');
  assert.equal(summary.model_snapshot.first_stop_ms, 11001);
  assert.equal(summary.model_snapshot.cleanup_deadline_ms, 41001);
  assert.deepEqual(summary.model_snapshot.frames,
    ['NOT_RUN', 'NOT_RUN', 'NOT_RUN']);
  assert.equal(summary.actual_port_calls.launches, 1);
  assert.equal(summary.actual_port_calls.stops, 1);
});

test('capture completion clock can finish abort cleanup without late evaluation', async () => {
  let rig, armed = false, fired = false, abortResult;
  rig = createRig({
    ports: {capturePort: {captureFrame(request) {
      rig.setNow(1600);
      armed = true;
      return Promise.resolve({correlation: request.correlation,
        phase: request.phase, status: 'CAPTURED', t_acquired_ms: 1500,
        buffer: frame('S0'), error_code: null});
    }}},
    clock: {now() {
      if (armed && !fired) {
        fired = true;
        abortResult = rig.harness.abort('CALLER_STOP', 1600);
      }
      return rig.now;
    }},
    scheduler: {schedule(target) {
      if (target === 31600) throw new Error('private scheduler fault');
      return {cancel() {}};
    }},
  });
  const earlier = await rig.harness.step('LAUNCH', 1000);
  const capture = await rig.harness.step('F0_CAPTURE', 1200);
  const summary = await abortResult;
  assert.equal(fired, true);
  assert.equal(summary.harness_stop_reason, 'CALLER_ABORT');
  assert.equal(capture.snapshot.harness_state, 'COMPLETED');
  assert.equal(rig.harness.getSnapshot().harness_state, 'COMPLETED');
  assert.equal(summary.model_snapshot.first_stop_ms, 1600);
  assert.equal(summary.model_snapshot.modeled_reservations.capture_attempts, 0);
  assert.deepEqual(summary.model_snapshot.frames,
    ['NOT_RUN', 'NOT_RUN', 'NOT_RUN']);
  assert.equal(summary.ports_summary.captures[0].predicate, 'NOT_RUN');
  assert.equal(summary.actual_port_calls.captures, 1);
  assert.deepEqual(earlier.snapshot.model_snapshot.frames,
    ['NOT_RUN', 'NOT_RUN', 'NOT_RUN']);
  assert.ok(Object.isFrozen(summary));
});

test('delayed launch and action ACKs use dispatch time despite intervening polls', async () => {
  const launch = deferred(), action = deferred();
  const rig = createRig({ports: {
    launchPort: {launch() { return launch.promise; }},
    actionPort: {dispatchAction() { return action.promise; }},
  }});
  const launching = rig.harness.step('LAUNCH', 1000);
  rig.harness.poll(1150);
  rig.setNow(1200);
  launch.resolve({correlation: {run_id: 'run-1', job_id: 'job-1',
    generation_id: 'gen-1', operation_id: 'op_launch_0'},
  status: 'ACK', t_ack_ms: 1100, injected_process_id: 'PID-101',
  error_code: null});
  assert.equal((await launching).snapshot.harness_state, 'F0_CAPTURING');
  await rig.harness.step('F0_CAPTURE', 1200);
  const acting = rig.harness.step('KEY_ACTION', 1600);
  rig.harness.poll(1750);
  rig.setNow(1900);
  action.resolve({correlation: {run_id: 'run-1', job_id: 'job-1',
    generation_id: 'gen-1', operation_id: 'op_action_SPACE'},
  kind: 'SPACE_STROKE', status: 'ACK', t_ack_ms: 1700,
  error_code: null});
  const accepted = await acting;
  assert.equal(accepted.snapshot.harness_state, 'F1_CAPTURING');
  assert.equal(accepted.snapshot.model_snapshot.first_stop_ms, null);
  const summary = await rig.harness.abort('CALLER_STOP', 2000);
  assert.equal(summary.ports_summary.launch.t_ack_ms, 1100);
  assert.equal(summary.ports_summary.actions[0].t_ack_ms, 1700);
});

test('capture acquisition before a poll reaches the unchanged PR180 clock limit', async () => {
  const capture = deferred();
  const rig = createRig({ports: {capturePort: {captureFrame() {
    return capture.promise;
  }}}});
  await rig.harness.step('LAUNCH', 1000);
  const pending = rig.harness.step('F0_CAPTURE', 1200);
  rig.harness.poll(1550);
  rig.setNow(1600);
  capture.resolve({correlation: {run_id: 'run-1', job_id: 'job-1',
    generation_id: 'gen-1', operation_id: 'op_capture_F0'},
  phase: 'F0', status: 'CAPTURED', t_acquired_ms: 1500,
  buffer: frame('S0'), error_code: null});
  const result = await pending;
  assert.equal(result.snapshot.model_snapshot.reason, 'INVALID_CLOCK');
  assert.equal(result.snapshot.model_snapshot.first_stop_ms, 1550);
  assert.equal(result.snapshot.model_snapshot.modeled_reservations.capture_attempts, 0);
  const captureRow = result.snapshot.actual_port_calls.captures;
  assert.equal(captureRow, 1);
  assert.equal(result.snapshot.model_snapshot.frames[0], 'NOT_RUN');
});

test('event times before dispatch and after completion remain invalid', async () => {
  const earlyLaunch = createRig({ports: {launchPort: {launch(request) {
    return Promise.resolve({correlation: request.correlation, status: 'ACK',
      t_ack_ms: 999, injected_process_id: 'PID-101', error_code: null});
  }}}});
  assert.equal((await earlyLaunch.harness.runLifecycle())
    .model_snapshot.reason, 'INVALID_CLOCK');

  let setNow = () => {};
  const futureCapture = createRig({ports: {capturePort: {captureFrame(request) {
    setNow(1600);
    return Promise.resolve({correlation: request.correlation, phase: request.phase,
      status: 'CAPTURED', t_acquired_ms: 1601, buffer: frame('S0'),
      error_code: null});
  }}}});
  setNow = futureCapture.setNow;
  const summary = await futureCapture.harness.runLifecycle();
  assert.equal(summary.model_snapshot.reason, 'INVALID_CLOCK');
  assert.equal(summary.model_snapshot.modeled_reservations.capture_attempts, 0);
  assert.equal(summary.ports_summary.captures[0].error_code, 'INVALID_CLOCK');
});

test('invalid capture acquisition reconciles its one sampled completion first', async () => {
  const cases = [
    {name: 'pre-dispatch', acquired: 1199, done: 1600, reason: 'INVALID_CLOCK'},
    {name: 'future', acquired: 1601, done: 1600, reason: 'INVALID_CLOCK'},
    {name: 'string', acquired: '1500', done: 1600, reason: 'INVALID_CLOCK'},
    {name: 'NaN', acquired: NaN, done: 1600, reason: 'INVALID_CLOCK'},
    {name: 'fractional', acquired: 1500.5, done: 1600, reason: 'INVALID_CLOCK'},
    {name: 'future past cap', acquired: 11002, done: 11001,
      reason: 'PHASE_DEADLINE'},
    {name: 'non-safe past cap', acquired: '1500', done: 11001,
      reason: 'PHASE_DEADLINE'},
  ];
  for (const {name, acquired, done, reason} of cases) {
    let rig, completionOpen = false, completionReads = 0, stopRequest;
    rig = createRig({
      ports: {
        capturePort: {captureFrame(request) {
          rig.setNow(done);
          completionOpen = true;
          return Promise.resolve({correlation: request.correlation,
            phase: request.phase, status: 'CAPTURED',
            t_acquired_ms: acquired, buffer: new Uint8Array([67, 68, 69]),
            error_code: null});
        }},
        stopPort: {stop(request) {
          completionOpen = false;
          stopRequest = request;
          rig.setNow(Math.max(rig.now, request.t_stop_ms + 200));
          return Promise.resolve({correlation: request.correlation, status: 'ACK',
            t_ack_ms: rig.now, direct_child_exit_observed: true,
            error_code: null});
        }},
      },
      clock: {now() {
        if (completionOpen) completionReads++;
        return rig.now;
      }},
    });
    const summary = await rig.harness.runLifecycle();
    const row = summary.ports_summary.captures[0];
    assert.equal(completionReads, 1, name);
    assert.equal(summary.model_snapshot.reason, reason, name);
    assert.equal(summary.harness_stop_reason, reason, name);
    assert.equal(summary.model_snapshot.first_stop_ms, done, name);
    assert.equal(summary.model_snapshot.cleanup_deadline_ms, done + 30000, name);
    assert.equal(stopRequest.t_stop_ms, done, name);
    assert.equal(stopRequest.reason, reason, name);
    assert.equal(row.status, reason === 'PHASE_DEADLINE' ? 'TIMEOUT' : 'FAULT', name);
    assert.equal(row.error_code, reason, name);
    assert.equal(row.t_acquired_ms, null, name);
    assert.equal(row.predicate, 'NOT_RUN', name);
    assert.deepEqual(summary.model_snapshot.frames,
      ['NOT_RUN', 'NOT_RUN', 'NOT_RUN'], name);
    assert.equal(summary.model_snapshot.modeled_reservations.capture_attempts, 0, name);
    assert.deepEqual(summary.actual_port_calls,
      {launches: 1, actions: 0, captures: 1, stops: 1, settlements: 1}, name);
    assert.equal(Object.hasOwn(row, 'buffer'), false, name);
    assert.equal(JSON.stringify(summary).includes('"buffer"'), false, name);
  }
});

test('cancel reentrancy retains the first copied launch ID without promotion', async () => {
  for (const interruption of ['abort', 'deadline']) {
    let rig, payload, reentered = false;
    const firstId = 'P'.repeat(128), mutatedId = 'Q'.repeat(128);
    rig = createRig({
      ports: {launchPort: {launch(request) {
        return {then(fulfill) {
          rig.setNow(1200);
          payload = {correlation: {...request.correlation}, status: 'ACK',
            t_ack_ms: 1200, injected_process_id: firstId, error_code: null};
          fulfill(payload);
        }};
      }}},
      scheduler: {schedule(target) {
        return {cancel() {
          if (target !== 11001 || reentered) return;
          reentered = true;
          payload.injected_process_id = mutatedId;
          payload.correlation.operation_id = 'mutated-operation';
          if (interruption === 'abort') {
            rig.setNow(1500);
            void rig.harness.abort('CALLER_STOP', 1500);
          } else {
            rig.setNow(11001);
            void rig.harness.deliverDeadline(11001);
          }
        }};
      }},
    });
    const summary = await rig.harness.runLifecycle();
    assert.equal(reentered, true);
    assert.equal(summary.model_snapshot.first_stop_ms,
      interruption === 'abort' ? 1500 : 11001);
    assert.equal(summary.model_snapshot.cleanup_deadline_ms,
      interruption === 'abort' ? 31500 : 41001);
    assert.equal(summary.ports_summary.launch.injected_process_id, null);
    assert.equal(summary.actual_port_calls.launches, 1);
    assert.equal(summary.actual_port_calls.captures, 0);
    assert.deepEqual(summary.retained_owner_state.orphaned_injected_process_ids,
      [firstId]);
    assert.ok(summary.retained_owner_state.fenced_scopes
      .includes(`late-launch:${firstId}`));
    assert.equal(summary.retained_owner_state.orphaned_injected_process_ids
      .includes(mutatedId), false);
    assert.equal(rig.calls.find(([kind]) => kind === 'stop')[1]
      .injected_process_id, null);
  }
});

test('clock reentrancy cannot poll a completed model after cleanup scheduler fault', async () => {
  let rig, armed = false, abortResult;
  rig = createRig({
    ports: {launchPort: {launch(request) {
      rig.setNow(1200);
      armed = true;
      return Promise.resolve({correlation: request.correlation, status: 'ACK',
        t_ack_ms: 1200, injected_process_id: 'PID-101', error_code: null});
    }}},
    clock: {now() {
      if (armed) {
        armed = false;
        abortResult = rig.harness.abort('CALLER_STOP', 1500);
        rig.setNow(9000);
      }
      return rig.now;
    }},
    scheduler: {schedule(target) {
      if (target === 31500) throw new Error('private cleanup scheduler fault');
      return {cancel() {}};
    }},
  });
  const summary = await rig.harness.runLifecycle();
  assert.strictEqual(await abortResult, summary);
  const snapshot = rig.harness.getSnapshot();
  assert.deepEqual(snapshot.model_snapshot, summary.model_snapshot);
  assert.equal(snapshot.last_observed_ms, summary.model_snapshot.last_ms);
  assert.equal(summary.harness_stop_reason, 'CALLER_ABORT');
  assert.equal(summary.model_snapshot.first_stop_ms, 1500);
  assert.equal(summary.ports_summary.launch.status, 'FAULT');
  assert.equal(summary.ports_summary.settlement.error_code, 'SCHEDULER_FAULT');
});

test('in-enum fault codes on successful statuses close all five ports', async () => {
  const expectedCalls = {
    launch: {launches: 1, actions: 0, captures: 0, stops: 1, settlements: 1},
    action: {launches: 1, actions: 1, captures: 1, stops: 1, settlements: 1},
    capture: {launches: 1, actions: 0, captures: 1, stops: 1, settlements: 1},
    stop: {launches: 1, actions: 2, captures: 3, stops: 1, settlements: 1},
    settlement: {launches: 1, actions: 2, captures: 3, stops: 1, settlements: 1},
  };
  for (const port of ['launch', 'action', 'capture', 'stop', 'settlement']) {
    let rig;
    const result = request => {
      const common = {correlation: request.correlation, error_code: 'UNKNOWN'};
      if (port === 'launch') return {...common, status: 'ACK', t_ack_ms: 1200,
        injected_process_id: 'PID-101'};
      if (port === 'action') return {...common, kind: request.kind,
        status: 'ACK', t_ack_ms: 2000};
      if (port === 'capture') return {...common, phase: request.phase,
        status: 'CAPTURED', t_acquired_ms: 1500, buffer: frame('S0')};
      if (port === 'stop') return {...common, status: 'ACK',
        t_ack_ms: request.t_stop_ms + 200, direct_child_exit_observed: true};
      return {...common, status: 'OBSERVED_CLEAN', t_observed_ms: 4000,
        scope_observation: {launch_closed: true,
          scope_id: request.expected_scope_id, coverage: 'FULL_INSPECTED',
          live_count: 0, conflicting_identities: []},
        fenced_scope_descriptors: []};
    };
    const method = request => {
      rig.setNow(port === 'launch' ? 1200 : port === 'action' ? 2000 :
        port === 'capture' ? 1600 : port === 'settlement' ? 4000 :
          request.t_stop_ms + 200);
      return Promise.resolve(result(request));
    };
    const key = {launch: 'launchPort', action: 'actionPort',
      capture: 'capturePort', stop: 'stopPort',
      settlement: 'settlementPort'}[port];
    const name = {launch: 'launch', action: 'dispatchAction',
      capture: 'captureFrame', stop: 'stop',
      settlement: 'observeSettlement'}[port];
    rig = createRig({ports: {[key]: {[name]: method}}});
    const summary = await rig.harness.runLifecycle();
    const row = port === 'action' ? summary.ports_summary.actions[0] :
      port === 'capture' ? summary.ports_summary.captures[0] :
        summary.ports_summary[port];
    assert.equal(row.status, port === 'settlement' ? 'UNKNOWN' : 'FAULT', port);
    assert.equal(row.error_code, `${port.toUpperCase()}_FAULT`, port);
    assert.deepEqual(summary.actual_port_calls, expectedCalls[port], port);
    if (port === 'launch') {
      assert.equal(summary.actual_port_calls.captures, 0);
      assert.equal(summary.ports_summary.launch.injected_process_id, null);
      assert.ok(summary.retained_owner_state.orphaned_injected_process_ids
        .includes('PID-101'));
    }
    if (port === 'action') assert.equal(summary.actual_port_calls.captures, 1);
    if (port === 'capture') {
      assert.equal(summary.model_snapshot.modeled_reservations.capture_attempts, 0);
      assert.equal(summary.actual_port_calls.actions, 0);
    }
    if (port === 'stop') {
      const settlement = summary.ports_summary.settlement;
      assert.equal(summary.harness_status, 'FAULT');
      assert.equal(summary.ports_summary.stop.direct_child_exit_observed, false);
      assert.equal(settlement.status, 'OBSERVED_CLEAN');
      assert.equal(settlement.error_code, null);
      assert.equal(settlement.t_observed_ms, 4000);
      assert.ok(settlement.t_observed_ms <
        summary.model_snapshot.cleanup_deadline_ms);
      assert.deepEqual(settlement.scope_observation, {
        launch_closed: true, scope_id: 'PID-101', coverage: 'FULL_INSPECTED',
        live_count: 0, conflicting_identities: [],
      });
    }
    if (port === 'settlement') {
      assert.equal(summary.harness_status, 'FAULT');
      assert.equal(summary.ports_summary.stop.status, 'ACK');
      assert.equal(summary.ports_summary.stop.direct_child_exit_observed, true);
      assert.equal(summary.ports_summary.settlement.status, 'UNKNOWN');
      assert.equal(summary.ports_summary.settlement.error_code, 'SETTLEMENT_FAULT');
    }
  }
});

test('late matching launch identity survives unrelated malformed fields', async () => {
  for (const shape of ['missing', 'extra', 'accessor', 'wrong-correlation']) {
    const pending = deferred();
    let getterCalls = 0;
    const pid = 'P'.repeat(128);
    const rig = createRig({ports: {launchPort: {launch() {
      return pending.promise;
    }}}});
    const run = rig.harness.runLifecycle();
    const summary = await rig.harness.abort('CALLER_STOP', 1500);
    await run;
    const late = {correlation: {run_id: 'run-1', job_id: 'job-1',
      generation_id: 'gen-1', operation_id: 'op_launch_0'},
    status: 'ACK', t_ack_ms: 1600, injected_process_id: pid,
    error_code: null};
    if (shape === 'missing') delete late.error_code;
    if (shape === 'extra') late.unrelated = true;
    if (shape === 'accessor') Object.defineProperty(late, 'unrelated', {
      get() { getterCalls++; throw new Error('private'); },
    });
    if (shape === 'wrong-correlation') late.correlation.operation_id = 'other';
    pending.resolve(late);
    await Promise.resolve();
    const retained = rig.harness.getSnapshot().retained_owner_state;
    assert.equal(getterCalls, 0);
    assert.equal(retained.orphaned_injected_process_ids.includes(pid),
      shape !== 'wrong-correlation');
    assert.equal(retained.fenced_scopes.includes(`late-launch:${pid}`),
      shape !== 'wrong-correlation');
    assert.equal(summary.ports_summary.launch.injected_process_id, null);
    assert.equal(summary.actual_port_calls.captures, 0);
  }
});

test('terminal active faults use their one completion clock and phase cap', async () => {
  for (const form of ['throw', 'reject', 'malformed']) {
    let rig;
    rig = createRig({ports: {launchPort: {launch(request) {
      rig.setNow(1100);
      if (form === 'throw') throw new Error('private');
      if (form === 'reject') return Promise.reject(new Error('private'));
      return Promise.resolve({correlation: request.correlation, status: 'ACK'});
    }}}});
    const summary = await rig.harness.runLifecycle();
    assert.equal(summary.model_snapshot.first_stop_ms, 1100, form);
    assert.equal(summary.model_snapshot.cleanup_deadline_ms, 31100, form);
    assert.equal(summary.harness_stop_reason, 'LAUNCH_FAULT', form);
    assert.equal(summary.actual_port_calls.captures, 0, form);
  }
  for (const port of ['action', 'capture']) {
    for (const form of ['reject', 'malformed']) {
      let rig;
      const method = request => {
        rig.setNow(11001);
        return form === 'reject' ? Promise.reject(new Error('private')) :
          Promise.resolve({correlation: request.correlation});
      };
      rig = createRig({ports: port === 'action' ?
        {actionPort: {dispatchAction: method}} :
        {capturePort: {captureFrame: method}}});
      const summary = await rig.harness.runLifecycle();
      assert.equal(summary.model_snapshot.reason, 'PHASE_DEADLINE');
      assert.equal(summary.model_snapshot.first_stop_ms, 11001);
      assert.equal(summary.model_snapshot.cleanup_deadline_ms, 41001);
      assert.equal(summary.harness_stop_reason, 'PHASE_DEADLINE');
      assert.equal(summary.actual_port_calls.actions,
        port === 'action' ? 1 : 0);
      assert.equal(summary.actual_port_calls.captures, 1);
    }
  }
});

test('pending active and Stop rows close before terminal summary freezes', async () => {
  const capture = deferred();
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const active = createRig({ports: {capturePort: {captureFrame() {
    entered();
    return capture.promise;
  }}}});
  const run = active.harness.runLifecycle();
  await waiting;
  const before = active.harness.getSnapshot();
  active.advance(11001);
  const summary = await run;
  assert.equal(summary.ports_summary.captures[0].status, 'TIMEOUT');
  assert.equal(summary.ports_summary.captures[0].error_code, 'PHASE_DEADLINE');
  assert.equal(before.model_snapshot.first_stop_ms, null);
  assert.equal(Object.isFrozen(before), true);

  let stopEntered;
  const stopWaiting = new Promise(resolve => { stopEntered = resolve; });
  const cleanup = createRig({ports: {stopPort: {stop() {
    stopEntered();
    return new Promise(() => {});
  }}}});
  const cleaning = cleanup.harness.runLifecycle();
  await stopWaiting;
  const prior = cleanup.harness.getSnapshot();
  cleanup.advance(33600);
  const expired = await cleaning;
  assert.equal(expired.ports_summary.stop.status, 'TIMEOUT');
  assert.equal(expired.ports_summary.stop.error_code, 'CLEANUP_DEADLINE');
  assert.equal(expired.ports_summary.settlement.status, 'UNKNOWN');
  assert.equal(expired.harness_status, 'FAULT');
  assert.equal(prior.model_snapshot.cleanup_window, 'OPEN');
  assert.equal(cleanup.harness.getSnapshot().model_snapshot.cleanup_window, 'ELAPSED');
});

test('post-completion launch duplicates change bounded evidence only', async () => {
  let rig, emit;
  rig = createRig({ports: {launchPort: {launch(request) {
    return {then(fulfill) {
      emit = fulfill;
      rig.setNow(1200);
      fulfill({correlation: request.correlation, status: 'ACK',
        t_ack_ms: 1200, injected_process_id: 'PID-101', error_code: null});
    }};
  }}}});
  const summary = await rig.harness.runLifecycle();
  const frozen = JSON.stringify(summary);
  const before = rig.harness.getSnapshot();
  const correlation = summary.ports_summary.launch.correlation;
  const duplicate = id => ({correlation, status: 'ACK', t_ack_ms: 1200,
    injected_process_id: id, error_code: null});
  emit(duplicate('PID-101'));
  emit(duplicate('PID-OTHER'));
  let getterCalls = 0;
  emit(Object.defineProperty({...duplicate('PID-ANOTHER')}, 'unrelated', {
    get() { getterCalls++; throw new Error('private'); },
  }));
  emit({...duplicate('PID-WRONG'),
    correlation: {...correlation, operation_id: 'other'}});
  for (let index = 0; index < 20; index++) emit(duplicate(`PID-${index}`));
  const after = rig.harness.getSnapshot();
  assert.equal(getterCalls, 0);
  assert.equal(JSON.stringify(summary), frozen);
  assert.deepEqual(after.model_snapshot, before.model_snapshot);
  assert.equal(after.last_observed_ms, before.last_observed_ms);
  assert.deepEqual(after.actual_port_calls, before.actual_port_calls);
  assert.ok(after.retained_owner_state.orphaned_injected_process_ids
    .includes('PID-OTHER'));
  assert.equal(after.retained_owner_state.orphaned_injected_process_ids
    .includes('PID-WRONG'), false);
  assert.ok(after.retained_owner_state.orphaned_injected_process_ids.length <= 8);
  assert.ok(after.retained_owner_state.fenced_scopes.length <= 8);
  assert.equal(after.harness_state, 'COMPLETED');
});

test('active wrong correlation survives abort inside the completion clock', async () => {
  const cases = [
    {phase: 'launch', abortAt: 1500, pid: null,
      fence: 'unacknowledged_launch_scope', attempts: 0,
      calls: {launches: 1, actions: 0, captures: 0, stops: 1, settlements: 1}},
    {phase: 'action', abortAt: 2100, pid: 'PID-101',
      fence: 'simulated-scope:PID-101', attempts: 1,
      calls: {launches: 1, actions: 1, captures: 1, stops: 1, settlements: 1}},
    {phase: 'capture', abortAt: 1700, pid: 'PID-101',
      fence: 'simulated-scope:PID-101', attempts: 0,
      calls: {launches: 1, actions: 0, captures: 1, stops: 1, settlements: 1}},
  ];
  for (const {phase, abortAt, pid, fence, attempts, calls} of cases) {
    let rig, armed = false, abortResult;
    const portName = {launch: 'launchPort', action: 'actionPort',
      capture: 'capturePort'}[phase];
    const methodName = {launch: 'launch', action: 'dispatchAction',
      capture: 'captureFrame'}[phase];
    rig = createRig({
      ports: {[portName]: {[methodName](request) {
        const completedAt = {launch: 1200, action: 2000, capture: 1600}[phase];
        rig.setNow(completedAt);
        armed = true;
        const correlation = {...request.correlation, operation_id: 'wrong-active'};
        if (phase === 'launch') return Promise.resolve({correlation, status: 'ACK',
          t_ack_ms: completedAt, injected_process_id: 'PID-FOREIGN',
          error_code: null});
        if (phase === 'action') return Promise.resolve({correlation,
          kind: request.kind, status: 'ACK', t_ack_ms: completedAt,
          injected_process_id: 'PID-FOREIGN', error_code: null});
        return Promise.resolve({correlation, phase: request.phase,
          status: 'CAPTURED', t_acquired_ms: 1500,
          buffer: new Uint8Array([67, 68, 69]), error_code: null});
      }}},
      clock: {now() {
        if (armed) {
          armed = false;
          rig.setNow(abortAt);
          abortResult = rig.harness.abort('CALLER_STOP', abortAt);
        }
        return rig.now;
      }},
    });
    const summary = await rig.harness.runLifecycle();
    assert.strictEqual(await abortResult, summary, phase);
    const row = phase === 'launch' ? summary.ports_summary.launch :
      phase === 'action' ? summary.ports_summary.actions[0] :
        summary.ports_summary.captures[0];
    const stopRequest = rig.calls.find(([kind]) => kind === 'stop')?.[1];
    assert.equal(rig.harness.getSnapshot().cancellation_latched, true, phase);
    assert.equal(summary.harness_stop_reason, 'IDENTITY_CONFLICT', phase);
    assert.equal(summary.harness_status, 'FAULT', phase);
    assert.equal(summary.model_snapshot.reason, 'CALLER_STOP', phase);
    assert.equal(summary.model_snapshot.first_stop_ms, abortAt, phase);
    assert.equal(summary.model_snapshot.cleanup_deadline_ms, abortAt + 30000, phase);
    assert.equal(stopRequest.reason, 'IDENTITY_CONFLICT', phase);
    assert.equal(stopRequest.t_stop_ms, abortAt, phase);
    assert.equal(stopRequest.injected_process_id, pid, phase);
    assert.equal(summary.ports_summary.launch.injected_process_id, pid, phase);
    assert.equal(row.status, 'FAULT', phase);
    assert.equal(row.error_code, 'IDENTITY_CONFLICT', phase);
    assert.equal(summary.ports_summary.settlement.status, 'UNKNOWN', phase);
    assert.equal(summary.ports_summary.settlement.error_code, 'IDENTITY_CONFLICT', phase);
    assert.equal(summary.ports_summary.settlement.scope_observation, null, phase);
    assert.ok(summary.retained_owner_state.fenced_scopes.includes(fence), phase);
    assert.ok(summary.ports_summary.settlement.fenced_scope_descriptors
      .includes(fence), phase);
    assert.equal(summary.model_snapshot.modeled_reservations.capture_attempts,
      attempts, phase);
    assert.deepEqual(summary.actual_port_calls, calls, phase);
    assert.equal(JSON.stringify(summary).includes('"buffer"'), false, phase);
  }
});
