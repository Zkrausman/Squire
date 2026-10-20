import test from 'node:test';
import assert from 'node:assert/strict';
import {createInjectedTaskCoordinator} from '../src/injected-task-coordinator.mjs';
import {HOST_GATES} from '../src/manager-custody.mjs';
import {managerSpec} from './fixtures.mjs';
const encode = value => new TextEncoder().encode(value);
const admission = {admission_passed: true, workspace_fence_passed: true, history_fence_passed: true, process_group_allocated: true};
const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
function fixture({wall = 12, missing = false, maxWall = 300, readHook, clockHook} = {}) {
  const spec = {...managerSpec(), provider_id: 'agy_gemini', requested_model: 'synthetic-model', max_wall_clock_sec: maxWall};
  let now = 0, task, closes = 0; const timers = [], requests = [], calls = [], fsCalls = [];
  const binding = {job_id: spec.job_id, unit_name: `squire-task-core-${spec.job_id}.service`, invocation_id: 'a'.repeat(32)};
  const clock = {now() {clockHook?.(task); return now;}, schedule(delay, fn) {const t = {at: now + delay, fn, active: true}; timers.push(t); return () => {t.active = false;};}};
  const stat = directory => ({dev: 1n, ino: directory ? 1n : 2n, size: directory ? 0n : 3n, mode: directory ? 0o40700n : 0o100600n,
    mtimeNs: 1n, ctimeNs: 1n, isFile: () => !directory, isDirectory: () => directory, isSymbolicLink: () => false});
  const path = spec.task_scope + '/result.txt';
  const fs = {async lstat(p) {fsCalls.push('lstat'); assert.ok([path, spec.task_scope].includes(p));
    if (missing && p === path) throw Object.assign(Error('PRIVATE_MISSING'), {code: 'ENOENT'}); return stat(p === spec.task_scope);},
    async realpath(p) {fsCalls.push('realpath'); return p;}, async open(p) {fsCalls.push('open'); assert.equal(p, path);
      return {async stat() {return stat(false);}, async read(buffer, offset, length, position) {
        const body = Buffer.from('abc'), size = Math.min(length, Math.max(0, body.length - position));
        body.copy(buffer, offset, position, position + size); readHook?.(task); return {bytesRead: size};
      }, async close() {closes++;}};}};
  task = createInjectedTaskCoordinator({spec, policy: {unit_name: binding.unit_name, task_scope: spec.task_scope, stop_grace_ms: 50},
    clock, task_deadline_ms: maxWall * 1000, preparation: {effort: 'medium', observed_cli_version: '1.4.3',
      executable_reference: '/synthetic/agy', prompt_bytes: encode('PRIVATE_PROMPT'), policy_data: {allowed_models: [spec.requested_model], allowed_efforts: ['medium'], quota_available: true}},
    environment: {TMPDIR: spec.task_scope, GEMINI_API_KEY: 'PRIVATE_SYNTHETIC_ENV'}, stdio: ['ignore', 3, 4],
    manager: {startTransientUnit() {calls.push('UNEXPECTED_START'); throw Error('NO_START');}, stopUnit() {calls.push('stop'); return {binding, job_acknowledged: true};}},
    qualification: Object.fromEntries(HOST_GATES.map(key => [key, true])),
    source: {nextEvent(request) {return new Promise(resolve => {requests.push({request, resolve});});}},
    read_timeout_ms: 1000, artifact_fs: fs});
  // Source request is frozen; retain resolver separately, not on the DTO.
  return {task, binding, spec, calls, requests, fsCalls, closes: () => closes,
    admit(evidence = admission) {task.markDispatchAttempted(); return task.applyStartAck({binding, custody_acknowledged: true, worker_in_cgroup_before_exec: true}, evidence);},
    async managerEvent(type, fields) {const response = task.readManagerEvent(); const entry = requests.at(-1);
      entry.resolve({type, value: {binding, ...fields}}); return response;},
    output(code = 0, overrides = {}) {
      const body = encode(JSON.stringify({status: 'SUCCESS', response: 'PRIVATE_RESPONSE', usage: {input_tokens: 0, output_tokens: 3}}));
      for (const event of [{type: 'stdout_chunk', stream_offset: 0, chunk: body}, {type: 'stdout_eof', stream_offset: body.length},
        {type: 'stderr_eof', stream_offset: 0}, {type: 'raw_exit', raw_exit: {exit_code: code, signal: null, wall_ms: wall, ...overrides}}]) task.feedOutput({binding, ...event});
    },
    quiescence() {return {binding, task_scope: spec.task_scope, owned_writers_settled: true, exclusive_no_external_writers: true};},
    setNow(value) {now = value;}, expire() {now = maxWall * 1000; for (const timer of timers) if (timer.active && timer.at <= now) {timer.active = false; timer.fn();}},
    active: () => timers.filter(t => t.active).length,
    cleanup() {task.abort();}};
}
const empty = {populated: 0, launch_closed: true, coverage_complete: true, exact_live_count: null};
async function observed(f, code = 0) {f.output(code); await f.managerEvent('native_exit', {code}); await f.managerEvent('cgroup', empty);}

test('source coordinator completes prepared ACK/adoption/output/quiesced verification/CLEAN record and release', async () => {
  const f = fixture();
  try {
    assert.equal(f.task.plan.runtime_admitted, false); f.admit(); await observed(f);
    assert.equal(f.task.snapshot().lifecycle.lifecycle_status, 'VERIFYING_ARTIFACTS');
    const result = await f.task.finish(f.quiescence());
    assert.equal(result.lifecycle.record.lifecycle_status, 'SUCCESS'); assert.equal(result.lifecycle.record.process_exit_code, 0);
    assert.equal(result.lifecycle.record.reported_model, 'UNKNOWN'); assert.equal(result.lifecycle.record.inference_time_ms, 'UNKNOWN');
    assert.deepEqual(result.lifecycle.record.usage_tokens, {input: 0, output: 3, cache_read: 'UNKNOWN', thinking: 'UNKNOWN', total: 'UNKNOWN'});
    assert.deepEqual({...result.lifecycle.record.artifact_witness['result.txt']}, {byte_count: 3, sha256: abc});
    assert.equal(result.lifecycle.record.settlement_status, 'CLEAN'); assert.equal(f.closes(), 1);
    assert.equal(f.task.releaseWorkspace(), true); assert.equal((await f.task.callerResult()).status, 'RELEASED');
    assert.deepEqual(f.calls, []); assert.equal(f.active(), 0); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  } finally {f.cleanup();}
});
test('missing artifact produces FAILED/CLEAN and permits release only after its valid record', async () => {
  const f = fixture({missing: true});
  try {f.admit(); await observed(f);
    assert.equal(f.task.releaseWorkspace(), false);
    const result = await f.task.finish(f.quiescence()); assert.equal(result.lifecycle.record.lifecycle_status, 'FAILED');
    assert.equal(result.lifecycle.record.settlement_status, 'CLEAN'); assert.equal(result.verification.failure.classification, 'missing_path');
    assert.equal(f.task.releaseWorkspace(), true); assert.deepEqual(f.calls, []);
  } finally {f.cleanup();}
});
test('nonzero exit ignores provider success, bypasses filesystem and remains FAILED/CLEAN without stop', async () => {
  const f = fixture();
  try {f.admit(); await observed(f, 7); const result = await f.task.finish();
    assert.equal(result.lifecycle.record.process_exit_code, 7); assert.equal(result.lifecycle.record.lifecycle_status, 'FAILED');
    assert.equal(result.lifecycle.record.settlement_status, 'CLEAN'); assert.deepEqual(f.fsCalls, []); assert.deepEqual(f.calls, []);
    assert.equal(f.task.releaseWorkspace(), true);
  } finally {f.cleanup();}
});
test('verification requires full empty proof plus exact explicit quiescence, not ACK or stable bytes', async () => {
  const f = fixture();
  try {f.admit(); f.output(); await f.managerEvent('native_exit', {code: 0});
    await assert.rejects(f.task.finish(f.quiescence()), /settlement_not_proved/); assert.deepEqual(f.fsCalls, []);
    await f.managerEvent('cgroup', {...empty, coverage_complete: false});
    await assert.rejects(f.task.finish(f.quiescence()), /settlement_not_proved/);
    await f.managerEvent('cgroup', empty);
    for (const patch of [{task_scope: '/different'}, {owned_writers_settled: false}, {exclusive_no_external_writers: false},
      {binding: {...f.binding, invocation_id: 'b'.repeat(32)}}]) await assert.rejects(f.task.finish({...f.quiescence(), ...patch}), /quiescence/);
    assert.deepEqual(f.fsCalls, []); assert.equal(f.task.snapshot().verification_attempted, false);
  } finally {f.cleanup();}
});
test('null raw wall withholds record AND release; observed zero wall is valid', async () => {
  for (const wall of [null, 0]) {
    const f = fixture({wall});
    try {f.admit(); await observed(f); const result = await f.task.finish(f.quiescence());
      assert.equal(result.lifecycle.lifecycle_status, 'TERMINAL_SETTLEMENT');
      if (wall === null) {assert.equal(result.lifecycle.record, null); assert.equal(result.record_withheld, true); assert.equal(f.task.releaseWorkspace(), false);}
      else {assert.equal(result.lifecycle.record.process_wall_ms, 0); assert.equal(f.task.releaseWorkspace(), true);}
    } finally {f.cleanup();}
  }
});
test('capacity teardown waits for real observations and preserves operational failure without user cancellation', async () => {
  const f = fixture();
  try {f.admit(); f.task.feedOutput({type: 'stdout_chunk', binding: f.binding, stream_offset: 0, chunk: new Uint8Array(1048577)});
    assert.deepEqual(f.calls, ['stop']); assert.equal(f.task.snapshot().canceled, false);
    const pending = await f.task.finish(); assert.equal(pending.fatal_diagnostic, 'collector_failure');
    assert.equal(pending.lifecycle.record, null); assert.equal(f.task.releaseWorkspace(), false);
    f.task.feedOutput({type: 'raw_exit', binding: f.binding, raw_exit: {exit_code: 7, signal: null, wall_ms: 12}});
    await f.managerEvent('native_exit', {code: 7}); await f.managerEvent('cgroup', empty);
    const result = await f.task.finish(); assert.equal(result.lifecycle.record.lifecycle_status, 'FAILED');
    assert.equal(result.lifecycle.record.settlement_status, 'ORPHAN_KILLED');
    assert.equal(result.lifecycle.record.usage_tokens.input, 'UNKNOWN'); assert.equal(result.canceled, false);
  } finally {f.cleanup();}
});
test('deadline during verification preserves CANCELED/CLEAN, discards late witness and permits valid-record release', async () => {
  let f, once = false;
  f = fixture({readHook() {if (!once) {once = true; f.expire();}}});
  try {f.admit(); await observed(f); const result = await f.task.finish(f.quiescence());
    assert.equal(result.canceled, true); assert.equal(result.cancellation_reason, 'deadline');
    assert.equal(result.lifecycle.record.lifecycle_status, 'CANCELED'); assert.equal(result.lifecycle.record.settlement_status, 'CLEAN');
    assert.equal(Object.keys(result.lifecycle.record.artifact_witness).length, 0); assert.equal(result.lifecycle.record.process_exit_code, 0);
    assert.equal((await f.task.callerResult()).status, 'DEADLINE'); assert.equal(f.task.releaseWorkspace(), true);
    assert.equal(f.closes(), 1);
  } finally {f.cleanup();}
});
test('user cancellation during verification remains CANCELED despite artifact read failure', async () => {
  let once = false; const f = fixture({readHook(task) {if (!once) {once = true; task.abort();}}});
  try {f.admit(); await observed(f); const result = await f.task.finish(f.quiescence());
    assert.equal(result.lifecycle.record.lifecycle_status, 'CANCELED'); assert.equal(result.cancellation_reason, 'user_abort');
    assert.equal(result.lifecycle.record.settlement_status, 'CLEAN'); assert.equal(f.task.releaseWorkspace(), true);
  } finally {f.cleanup();}
});
test('manager disconnect during verification keeps raw exit but cannot promote retained empty proof', async () => {
  let f, pending, once = false;
  f = fixture({readHook() {if (!once) {once = true; pending = f.managerEvent('manager_disconnected', {});}}});
  try {f.admit(); await observed(f); const result = await f.task.finish(f.quiescence()); await pending;
    assert.equal(result.lifecycle.record.lifecycle_status, 'FAILED'); assert.equal(result.lifecycle.record.settlement_status, 'UNKNOWN');
    assert.equal(result.lifecycle.record.process_exit_code, 0); assert.equal(f.task.releaseWorkspace(), false);
  } finally {f.cleanup();}
});
test('raw exit conflict is rejected without selecting fabricated success', async () => {
  const f = fixture();
  try {f.admit(); f.output(0);
    await assert.rejects(f.managerEvent('native_exit', {code: 7}), error => error.code === 'observation_conflict');
    const result = await f.task.finish(); assert.equal(result.lifecycle.record.lifecycle_status, 'FAILED');
    assert.equal(result.lifecycle.record.process_exit_code, 7); assert.equal(result.lifecycle.record.settlement_status, 'UNKNOWN');
    assert.equal(f.task.releaseWorkspace(), false); assert.equal((await f.task.callerResult()).status, 'FENCED');
    assert.equal(f.active(), 0);
  } finally {f.cleanup();}
});
test('preparation refusal cannot dispatch; admission evidence cannot be synthesized from ACK', () => {
  const refused = fixture({maxWall: 1});
  try {assert.equal(refused.task.plan.status, 'BUDGET_INSUFFICIENT_FOR_PROFILE'); assert.equal(refused.task.snapshot().startup.phase, 'NOT_ADMITTED');
    assert.throws(() => refused.task.markDispatchAttempted(), error => error.code === 'not_admitted'); assert.deepEqual(refused.calls, []);
  } finally {refused.cleanup();}
  const f = fixture();
  try {f.task.markDispatchAttempted();
    assert.throws(() => f.task.applyStartAck({binding: f.binding, custody_acknowledged: true, worker_in_cgroup_before_exec: true}, {...admission, history_fence_passed: false}), /admission_observations/);
    assert.equal(f.task.snapshot().lifecycle.lifecycle_status, 'SUBMITTED'); assert.equal(f.task.snapshot().startup.adopted, false);
  } finally {f.cleanup();}
});
test('manager-only source route rejects chunks; output route cannot mint custody observations', async () => {
  const f = fixture();
  try {f.admit(); const response = await f.managerEvent('stdout_chunk', {stream_offset: 0, chunk: encode('x')});
    assert.equal(response.status, 'READ_FAILED'); assert.equal(f.task.snapshot().custody.admission_quarantined, true);
    assert.equal(f.task.feedOutput({type: 'cgroup', binding: f.binding, ...empty}).rejection_reason, 'BINDING_MISMATCH');
    assert.equal(f.task.releaseWorkspace(), false);
  } finally {f.cleanup();}
});

test('output drain and decode gate physical verification; passive collector close cannot promote success', async () => {
  const f = fixture();
  try {f.admit(); await f.managerEvent('native_exit', {code: 0}); await f.managerEvent('cgroup', empty);
    await assert.rejects(f.task.finish(f.quiescence()), /output_not_drained/); assert.deepEqual(f.fsCalls, []);
    f.output(); f.task.feedOutput({type: 'close', binding: f.binding});
    const result = await f.task.finish(f.quiescence());
    assert.equal(result.lifecycle.record.lifecycle_status, 'FAILED'); assert.equal(result.lifecycle.record.settlement_status, 'CLEAN');
    assert.deepEqual(f.fsCalls, []); assert.equal(f.task.releaseWorkspace(), true);
  } finally {f.cleanup();}
});
test('clock regression is fatal/UNKNOWN, never a manufactured user cancellation', async () => {
  const f = fixture();
  try {f.admit(); await observed(f); f.setNow(-1); assert.throws(() => f.task.tick(), /task_clock/);
    const failed = f.task.snapshot(); assert.equal(failed.canceled, false); assert.equal(failed.custody.settlement_status, 'UNKNOWN');
    assert.equal(failed.custody.admission_quarantined, true); assert.equal(failed.lifecycle.record, null);
    f.setNow(0); assert.equal(f.task.releaseWorkspace(), false);
    const result = await f.task.finish(); assert.equal(result.lifecycle.record.lifecycle_status, 'FAILED');
    assert.equal(result.lifecycle.record.settlement_status, 'UNKNOWN');
  } finally {f.setNow(0); f.cleanup();}
});
test('late ACK after pending user cancellation retains intent and never invokes a second start', () => {
  const f = fixture();
  try {f.task.markDispatchAttempted(); f.task.abort();
    const state = f.task.applyStartAck({binding: f.binding, custody_acknowledged: true, worker_in_cgroup_before_exec: true}, admission);
    assert.equal(state.canceled, true); assert.equal(state.lifecycle.terminal_intent, 'CANCELED');
    assert.equal(state.lifecycle.process_group_allocated, true); assert.equal(state.startup.adopted, true);
    assert.equal(f.calls.includes('UNEXPECTED_START'), false);
  } finally {f.cleanup();}
});
test('verification overlap rejects before a second filesystem walk and record finalization is immutable', async () => {
  let didPause = false;
  // Asynchronous fs methods themselves are injected; no host operations or timer.
  const f = fixture({readHook() {didPause = true;}});
  try {f.admit(); await observed(f);
    const finishing = f.task.finish(f.quiescence());
    await assert.rejects(f.task.finish(f.quiescence()), /verification_in_progress/);
    const done = await finishing; assert.equal(didPause, true); assert.equal(f.closes(), 1);
    const record = done.lifecycle.record; f.task.abort(); const again = await f.task.finish();
    assert.equal(again.lifecycle.record, record); assert.equal(record.lifecycle_status, 'SUCCESS');
    assert.ok(Object.isFrozen(record)); assert.equal(f.task.releaseWorkspace(), true);
  } finally {f.cleanup();}
});

test('reentrant user abort during clock callback latches both task and genuine owner before failure', async () => {
  let enabled = false, once = false;
  const f = fixture({clockHook(task) {
    if (enabled && !once) {once = true; assert.throws(() => task.abort(), /reentrant_transition/);}
  }});
  try {f.admit(); f.output(); await f.managerEvent('native_exit', {code: 0}); enabled = true;
    f.task.tick(); const snapshot = f.task.snapshot();
    assert.equal(snapshot.canceled, true); assert.equal(snapshot.custody.canceled, true);
    assert.equal(snapshot.lifecycle.terminal_intent, 'CANCELED');
    assert.equal(snapshot.custody.settlement_status, 'UNKNOWN');
    const done = await f.task.finish(); assert.equal(done.lifecycle.record.lifecycle_status, 'CANCELED');
    assert.equal(done.lifecycle.record.settlement_status, 'UNKNOWN'); assert.equal(f.task.releaseWorkspace(), false);
  } finally {enabled = false; f.cleanup();}
});
test('raw signaled exit stays null with no fabricated numeric signal code', async () => {
  const f = fixture();
  try {f.admit(); f.output(null, {signal: 'SIGTERM'}); await f.managerEvent('native_exit', {code: null});
    await f.managerEvent('cgroup', empty); const done = await f.task.finish();
    assert.equal(done.lifecycle.record.lifecycle_status, 'FAILED'); assert.equal(done.lifecycle.record.process_exit_code, null);
    assert.equal(done.lifecycle.record.settlement_status, 'CLEAN'); assert.deepEqual(f.calls, []);
  } finally {f.cleanup();}
});

test('active settlement requires observed need; nominal exit never issues an unconditional StopUnit', async () => {
  const f = fixture();
  try {f.admit(); f.output(); await f.managerEvent('native_exit', {code: 0});
    f.task.requestSettlement(); assert.deepEqual(f.calls, []);
    await f.managerEvent('cgroup', {...empty, populated: 1, exact_live_count: null});
    f.task.requestSettlement(); f.task.requestSettlement(); assert.deepEqual(f.calls, ['stop']);
    await f.managerEvent('cgroup', empty); const result = await f.task.finish(f.quiescence());
    assert.equal(result.lifecycle.record.lifecycle_status, 'SUCCESS'); assert.equal(result.lifecycle.record.settlement_status, 'ORPHAN_KILLED');
    assert.equal(f.task.releaseWorkspace(), true);
  } finally {f.cleanup();}
});

 test('adoption captures accepted admission evidence before caller clock callbacks', () => {
  const evidence = {...admission}; let armed = false;
  const f = fixture({clockHook() {if (armed) evidence.history_fence_passed = false;}});
  try {
    f.task.markDispatchAttempted(); armed = true;
    const state = f.task.applyStartAck({binding: f.binding, custody_acknowledged: true, worker_in_cgroup_before_exec: true}, evidence);
    assert.equal(evidence.history_fence_passed, false);
    assert.equal(state.lifecycle.lifecycle_status, 'RUNNING');
    assert.equal(state.lifecycle.process_group_allocated, true);
    assert.equal(state.custody.custody_acknowledged, true);
  } finally {f.cleanup();}
});

test('collector exit cannot substitute for missing manager exit after custody disconnect', async () => {
  const f = fixture();
  try {
    f.admit(); f.output(7);
    await f.managerEvent('manager_disconnected', {});
    assert.equal((await f.task.callerResult()).status, 'FENCED');
    assert.equal(f.task.snapshot().custody.admission_quarantined, true);
    const state = await f.task.finish(f.quiescence());
    assert.equal(state.lifecycle.record, null);
    assert.equal(f.task.releaseWorkspace(), false);
    assert.equal(state.collection.raw_wrapper.exit_code, 7);
  } finally {f.cleanup();}
});
