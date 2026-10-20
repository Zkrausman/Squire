// Integration evidence only. These explicit synthetic observations are not a runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareAgyArgv, AGY_BYTE_LIMITS, AGY_CHILD_ENV_DELETIONS} from '../src/agy-profile.mjs';
import {createAgyOutputCollector} from '../src/agy-output-collector.mjs';
import {createStartupOperation} from '../src/startup-operation.mjs';
import {createManagerCustodyFactory, HOST_GATES} from '../src/manager-custody.mjs';
import {createKnownCustodyCoordinator} from '../src/known-custody-coordinator.mjs';
import {verifyArtifacts} from '../src/artifact-verifier.mjs';
import {createLifecycle, advanceLifecycle as advance, finalizeLifecycle} from '../src/lifecycle.mjs';
import {managerSpec, record} from './fixtures.mjs';

const encode = value => new TextEncoder().encode(value);
const admission = Object.freeze({admission_passed: true, workspace_fence_passed: true,
  history_fence_passed: true, process_group_allocated: true});
const usage = Object.freeze({input: 5, output: 3, cache_read: 0, thinking: 0, total: 8});
const envelope = status => encode(JSON.stringify({status, duration_seconds: 0.012, usage: {
  input_tokens: 5, output_tokens: 3, cache_read_tokens: 0, thinking_tokens: 0, total_tokens: 8},
  response: 'SYNTHETIC_PRIVATE_RESPONSE', error: 'SYNTHETIC_PRIVATE_ERROR'}));
const abcHash = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

// The verifier always receives this explicit in-memory fs port. No native default,
// temp directory, actual permission denial or historical fixture is involved.
function artifactPort(job, {missing = false, onRead} = {}) {
  const calls = [], path = job.task_scope + '/result.txt', bytes = Buffer.from('abc');
  let closes = 0;
  const stat = directory => ({dev: 1n, ino: directory ? 1n : 2n, size: directory ? 0n : 3n,
    mtimeNs: 1n, ctimeNs: 1n, mode: directory ? 0o40700n : 0o100600n,
    isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => false});
  const fs = {
    async lstat(value) {
      calls.push(['lstat', value]);
      assert.ok(value === job.task_scope || value === path);
      if (value === path && missing) throw Object.assign(new Error('SYNTHETIC_PRIVATE_MISSING'), {code: 'ENOENT'});
      return stat(value === job.task_scope);
    },
    async realpath(value) {calls.push(['realpath', value]); assert.ok([job.task_scope, path].includes(value)); return value;},
    async open(value) {
      calls.push(['open', value]); assert.equal(value, path);
      return {async stat() {return stat(false);}, async read(buffer, offset, length, position) {
        calls.push(['read', position]); const size = Math.min(length, Math.max(0, bytes.length - position));
        bytes.copy(buffer, offset, position, position + size); onRead?.(); return {bytesRead: size};
      }, async close() {closes++;}};
    }
  };
  return {fs, calls, closes: () => closes};
}

function fixture({maxWall = 300} = {}) {
  const job = {...managerSpec(), provider_id: 'agy_gemini', requested_model: 'synthetic-approved-model', max_wall_clock_sec: maxWall};
  let time = 0, modeledDispatches = 0;
  const timers = [], managerCalls = [], pendingReads = [];
  const clock = {now: () => time, schedule(delay, fn) {
    const timer = {at: time + delay, fn, active: true}; timers.push(timer); return () => {timer.active = false;};
  }};
  const deadline = maxWall * 1000, unit_name = `squire-task-${job.job_id}.service`;
  const binding = Object.freeze({job_id: job.job_id, unit_name, invocation_id: '9'.repeat(32)});
  const operation = createStartupOperation({spec: job, policy: {unit_name, task_scope: job.task_scope},
    clock: {now: clock.now}, task_deadline_ms: deadline});
  const plan = prepareAgyArgv({job_spec: job, effort: 'medium', observed_cli_version: '1.4.3',
    executable_reference: '/synthetic/explicit-agy', prompt_bytes: encode('SYNTHETIC_PRIVATE_PROMPT'),
    task_deadline_ms: operation.snapshot().task_deadline_ms, observed_now_ms: clock.now(),
    policy_data: {allowed_models: [job.requested_model], allowed_efforts: ['medium'], quota_available: true}}, AGY_BYTE_LIMITS);
  const manager = {startTransientUnit() {managerCalls.push('UNEXPECTED_START'); throw Error('NO_NATIVE_START');},
    stopUnit(request) {managerCalls.push('fake_stop'); assert.deepEqual(request.binding, binding); return {binding, job_acknowledged: true};}};
  // All true values below are synthetic fixture assertions, not host qualification.
  const factory = createManagerCustodyFactory({manager, clock: {now: clock.now},
    qualification: Object.fromEntries(HOST_GATES.map(key => [key, true]))});
  let session = null, coordinator = null, collector = null;
  function acknowledgeAndAdopt() {
    assert.equal(plan.status, 'PREPARED_NOT_EXECUTABLE'); assert.equal(plan.runtime_admitted, false);
    modeledDispatches++; operation.markDispatchAttempted();
    operation.applyStartAck({binding, custody_acknowledged: true, worker_in_cgroup_before_exec: true});
    const suppliedEnv = {TMPDIR: job.task_scope, GEMINI_API_KEY: 'synthetic-value', GOOGLE_API_KEY: 'synthetic-value', GOOGLE_GEMINI_BASE_URL: 'synthetic-value'};
    const childEnv = {...suppliedEnv}; for (const key of AGY_CHILD_ENV_DELETIONS) delete childEnv[key];
    assert.equal(suppliedEnv.GEMINI_API_KEY, 'synthetic-value');
    session = factory.adoptStartupOperation(operation, job, {executable: plan.argv[0], args: plan.argv.slice(1),
      env: childEnv, stdio: ['ignore', 3, 4]}, {unit_name, stop_grace_ms: 50});
    const source = {nextEvent(request) {assert.deepEqual(request.binding, binding);
      return new Promise(resolve => {pendingReads.push(resolve);});}};
    coordinator = createKnownCustodyCoordinator({session, source, clock, read_timeout_ms: 1000});
    collector = createAgyOutputCollector({binding, limits: {max_stdout_bytes: 1048576, max_stderr_bytes: 65536},
      clock: {now: clock.now}, task_deadline_ms: deadline});
    return {session, coordinator, collector};
  }
  const output = (type, fields = {}) => collector.applyEvent({type, binding, ...fields});
  async function managerEvent(type, fields) {
    const read = coordinator.readNext(); const deliver = pendingReads.shift();
    assert.equal(typeof deliver, 'function'); deliver({type, value: {binding, ...fields}}); return read;
  }
  function completeOutput({status = 'SUCCESS', code = 0, wall = 12} = {}) {
    const body = envelope(status), split = 13;
    output('stdout_chunk', {stream_offset: 0, chunk: body.subarray(0, split)});
    output('stdout_chunk', {stream_offset: split, chunk: body.subarray(split)});
    output('stderr_chunk', {stream_offset: 0, chunk: encode('SYNTHETIC_PRIVATE_STDERR')});
    output('stdout_eof', {stream_offset: body.length});
    output('stderr_eof', {stream_offset: encode('SYNTHETIC_PRIVATE_STDERR').length});
    output('raw_exit', {raw_exit: {exit_code: code, signal: null, wall_ms: wall}});
    return collector.drainAndDecode();
  }
  async function empty() {
    return managerEvent('cgroup', {populated: 0, launch_closed: true, coverage_complete: true, exact_live_count: null});
  }
  function expire() {
    time = deadline;
    for (const timer of timers) if (timer.active && timer.at <= time) {timer.active = false; timer.fn();}
  }
  function cleanup() {collector?.close(); if (coordinator && !coordinator.reconcile()) coordinator.abort();}
  return {job, binding, operation, plan, deadline, managerCalls, acknowledgeAndAdopt, output, managerEvent, completeOutput,
    empty, expire, cleanup, modeledDispatches: () => modeledDispatches,
    activeTimers: () => timers.filter(timer => timer.active).length};
}
function running(job) {return advance(createLifecycle(job), 'EVENT_ADMISSION_PASSED', admission);}
function explicitFinal(job, current, metadata, witness = {}) {
  // Explicit test caller record, not a selected production metadata-to-wire mapper.
  return {...record(), job_id: job.job_id, lifecycle_status: current.terminal_intent,
    process_exit_code: current.process_exit_code, process_wall_ms: metadata.raw_wrapper.wall_duration_ms,
    usage_tokens: metadata.usage ?? {}, artifact_witness: witness,
    settlement_status: current.settlement_status ?? (current.process_group_allocated ? 'UNKNOWN' : null)};
}

test('fake task joins AGY preparation, one modeled ACK/adoption, output, artifact bytes, settlement and final record', async () => {
  const f = fixture(); const {session, coordinator, collector} = f.acknowledgeAndAdopt();
  try {
    let lifecycle = running(f.job);
    const metadata = f.completeOutput(); assert.deepEqual(metadata.usage, usage);
    assert.equal(metadata.task_outcome_evaluated, false); assert.equal(metadata.extra_metadata.backend_model, 'UNKNOWN');
    assert.equal(session.releaseWorkspace(), false); // EOF/provider success are not empty proof.
    await f.managerEvent('native_exit', {code: 0});
    lifecycle = advance(lifecycle, 'EVENT_PROCESS_EXIT_ZERO', {process_exit_code: session.snapshot().process_exit_code});
    const io = artifactPort(f.job), verification = await verifyArtifacts(f.job, {fs: io.fs});
    assert.equal(verification.verified, true); assert.equal(io.closes(), 1);
    assert.deepEqual({...verification.artifact_witness['result.txt']}, {byte_count: 3, sha256: abcHash});
    lifecycle = advance(lifecycle, 'EVENT_ARTIFACTS_VERIFIED', {artifact_witness: verification.artifact_witness});
    assert.throws(() => finalizeLifecycle(lifecycle, explicitFinal(f.job, lifecycle, metadata, verification.artifact_witness)), /final_record_before_terminal/);
    await f.empty(); assert.equal(session.snapshot().settlement_status, 'CLEAN');
    lifecycle = advance(lifecycle, 'EVENT_DESCENDANTS_OBSERVED_CLEAN');
    const done = finalizeLifecycle(lifecycle, explicitFinal(f.job, lifecycle, metadata, verification.artifact_witness));
    assert.equal(done.record.lifecycle_status, 'SUCCESS'); assert.equal(done.record.reported_model, 'UNKNOWN');
    assert.equal(done.record.inference_time_ms, 'UNKNOWN'); assert.equal(done.record.usage_tokens.thinking, 0);
    assert.equal(session.releaseWorkspace(), true); coordinator.reconcile();
    const response = await coordinator.result; assert.equal(response.status, 'RELEASED');
    assert.equal(response.state.task_deadline_ms, f.deadline); assert.equal(f.activeTimers(), 0);
    assert.equal(Object.hasOwn(response, 'record'), false); assert.equal(f.modeledDispatches(), 1);
    assert.deepEqual(f.managerCalls, []); assert.equal(collector.snapshot().stdout_retained_bytes, 0);
    assert.equal(JSON.stringify(done.record).includes('SYNTHETIC_PRIVATE'), false);
    assert.equal(JSON.stringify(metadata).includes('SYNTHETIC_PRIVATE'), false);
  } finally {f.cleanup();}
});
test('provider SUCCESS and exit zero cannot deliver a missing artifact or release without empty proof', async () => {
  const f = fixture(); const {session} = f.acknowledgeAndAdopt();
  try {
    const metadata = f.completeOutput(); await f.managerEvent('native_exit', {code: 0});
    let lifecycle = advance(running(f.job), 'EVENT_PROCESS_EXIT_ZERO', {process_exit_code: 0});
    const verification = await verifyArtifacts(f.job, {fs: artifactPort(f.job, {missing: true}).fs});
    assert.equal(verification.verified, false); assert.equal(verification.failure.classification, 'missing_path');
    lifecycle = advance(lifecycle, 'EVENT_ARTIFACT_VERIFICATION_FAILED');
    assert.equal(session.releaseWorkspace(), false); await f.empty();
    lifecycle = advance(lifecycle, 'EVENT_DESCENDANTS_OBSERVED_CLEAN');
    const done = finalizeLifecycle(lifecycle, explicitFinal(f.job, lifecycle, metadata));
    assert.equal(metadata.provider_reported_status, 'SUCCESS'); assert.equal(done.record.lifecycle_status, 'FAILED');
    assert.equal(Object.keys(done.record.artifact_witness).length, 0);
  } finally {f.cleanup();}
});
test('provider success cannot overwrite independently observed nonzero native exit', async () => {
  const f = fixture(); const {session} = f.acknowledgeAndAdopt();
  try {
    const metadata = f.completeOutput({code: 7}); await f.managerEvent('native_exit', {code: 7});
    let lifecycle = advance(running(f.job), 'EVENT_PROCESS_EXIT_NONZERO', {process_exit_code: session.snapshot().process_exit_code});
    await f.empty(); lifecycle = advance(lifecycle, 'EVENT_DESCENDANTS_OBSERVED_CLEAN');
    const done = finalizeLifecycle(lifecycle, explicitFinal(f.job, lifecycle, metadata));
    assert.equal(done.record.lifecycle_status, 'FAILED'); assert.equal(done.record.process_exit_code, 7);
    assert.equal(metadata.provider_reported_status, 'SUCCESS'); assert.deepEqual(f.managerCalls, []);
  } finally {f.cleanup();}
});
test('collector capacity advice requires explicit fake owner cancellation and never acts or proves cleanup', async () => {
  const f = fixture(); const {session, coordinator, collector} = f.acknowledgeAndAdopt();
  try {
    const before = running(f.job);
    f.output('stdout_chunk', {stream_offset: 0, chunk: new Uint8Array(1048577)});
    assert.equal(collector.snapshot().recommend_owner_abort.reason, 'CAPACITY_EXCEEDED');
    assert.equal(session.snapshot().canceled, false); assert.deepEqual(f.managerCalls, []);
    assert.equal(before.lifecycle_status, 'RUNNING');
    // Test caller explicitly elects cancellation; the collector does not call the owner.
    coordinator.abort(); const response = await coordinator.result;
    let lifecycle = advance(before, 'EVENT_TIMEOUT_OR_ABORT');
    assert.equal(response.state.settlement_status, 'UNKNOWN'); assert.equal(session.releaseWorkspace(), false);
    assert.deepEqual(f.managerCalls, ['fake_stop']);
    lifecycle = advance(lifecycle, 'EVENT_SETTLEMENT_OBSERVATION_FAILED');
    const raw = {raw_wrapper: {wall_duration_ms: 12}}; // Explicit separate synthetic wrapper observation.
    const done = finalizeLifecycle(lifecycle, explicitFinal(f.job, lifecycle, raw));
    assert.equal(done.record.lifecycle_status, 'CANCELED'); assert.equal(done.record.settlement_status, 'UNKNOWN');
    assert.equal(done.record.process_exit_code, null); assert.equal(collector.drainAndDecode(), null);
    assert.equal(session.snapshot().workspace_reuse_blocked, true);
  } finally {f.cleanup();}
});
test('deadline during injected artifact read cancels owner, discards witness and preserves raw exit/UNKNOWN', async () => {
  const f = fixture(); const {session, coordinator} = f.acknowledgeAndAdopt();
  try {
    const metadata = f.completeOutput(); await f.managerEvent('native_exit', {code: 0});
    let lifecycle = advance(running(f.job), 'EVENT_PROCESS_EXIT_ZERO', {process_exit_code: 0});
    const controller = new AbortController(); let expired = false;
    const io = artifactPort(f.job, {onRead() {
      if (expired) return; expired = true; f.expire(); controller.abort();
      lifecycle = advance(lifecycle, 'EVENT_TIMEOUT_OR_ABORT');
    }});
    const verification = await verifyArtifacts(f.job, {fs: io.fs, signal: controller.signal});
    assert.equal(verification.verified, false); assert.equal(verification.failure.classification, 'aborted');
    assert.equal(io.closes(), 1); assert.equal(Object.keys(verification.artifact_witness).length, 0);
    const response = await coordinator.result;
    assert.equal(response.status, 'DEADLINE'); assert.equal(response.state.process_exit_code, 0);
    assert.equal(response.state.settlement_status, 'UNKNOWN'); assert.equal(session.releaseWorkspace(), false);
    lifecycle = advance(lifecycle, 'EVENT_SETTLEMENT_OBSERVATION_FAILED');
    const done = finalizeLifecycle(lifecycle, explicitFinal(f.job, lifecycle, metadata));
    assert.equal(done.record.lifecycle_status, 'CANCELED'); assert.equal(done.record.process_exit_code, 0);
    assert.equal(done.record.settlement_status, 'UNKNOWN'); assert.equal(f.activeTimers(), 0);
  } finally {f.cleanup();}
});
test('artifact verification cannot turn a lost custody epoch into successful settlement', async () => {
  const f = fixture(); const {session, coordinator} = f.acknowledgeAndAdopt();
  try {
    const metadata = f.completeOutput(); await f.managerEvent('native_exit', {code: 0});
    let lifecycle = advance(running(f.job), 'EVENT_PROCESS_EXIT_ZERO', {process_exit_code: 0});
    const verification = await verifyArtifacts(f.job, {fs: artifactPort(f.job).fs});
    lifecycle = advance(lifecycle, 'EVENT_ARTIFACTS_VERIFIED', {artifact_witness: verification.artifact_witness});
    await f.managerEvent('manager_disconnected', {}); const response = await coordinator.result;
    assert.equal(response.status, 'FENCED'); assert.equal(session.snapshot().custody_acknowledged, false);
    assert.equal(session.releaseWorkspace(), false);
    lifecycle = advance(lifecycle, 'EVENT_SETTLEMENT_OBSERVATION_FAILED');
    const done = finalizeLifecycle(lifecycle, explicitFinal(f.job, lifecycle, metadata, verification.artifact_witness));
    assert.equal(done.record.lifecycle_status, 'FAILED'); assert.equal(done.record.settlement_status, 'UNKNOWN');
    assert.equal(done.record.process_exit_code, 0); assert.deepEqual(f.managerCalls, []);
  } finally {f.cleanup();}
});
test('missing raw wall duration withholds final record rather than borrowing provider duration or zero', async () => {
  const f = fixture(); const {session} = f.acknowledgeAndAdopt();
  try {
    const metadata = f.completeOutput({wall: null}); await f.managerEvent('native_exit', {code: 0});
    let lifecycle = advance(running(f.job), 'EVENT_PROCESS_EXIT_ZERO', {process_exit_code: 0});
    const verification = await verifyArtifacts(f.job, {fs: artifactPort(f.job).fs});
    lifecycle = advance(lifecycle, 'EVENT_ARTIFACTS_VERIFIED', {artifact_witness: verification.artifact_witness});
    await f.empty(); lifecycle = advance(lifecycle, 'EVENT_DESCENDANTS_OBSERVED_CLEAN');
    assert.equal(metadata.duration_seconds, 0.012); assert.equal(metadata.raw_wrapper.wall_duration_ms, null);
    assert.throws(() => finalizeLifecycle(lifecycle, explicitFinal(f.job, lifecycle, metadata, verification.artifact_witness)), /process_wall_ms/);
    assert.equal(lifecycle.record, null); assert.equal(session.snapshot().local_workspace_released, false);
  } finally {f.cleanup();}
});
test('preparation refusal stays pre-dispatch and cannot synthesize admission or startup ACK', () => {
  const f = fixture({maxWall: 1});
  try {
    assert.equal(f.plan.status, 'BUDGET_INSUFFICIENT_FOR_PROFILE'); assert.equal(f.plan.argv, null);
    f.operation.markNotAdmitted('profile_budget_insufficient');
    assert.equal(f.operation.snapshot().phase, 'NOT_ADMITTED'); assert.equal(f.modeledDispatches(), 0);
    assert.equal(createLifecycle(f.job).lifecycle_status, 'SUBMITTED');
    assert.deepEqual(f.managerCalls, []); assert.equal(f.activeTimers(), 0);
    assert.throws(() => f.operation.applyStartAck({binding: f.binding, custody_acknowledged: true, worker_in_cgroup_before_exec: true}), /ack_before_dispatch/);
  } finally {f.cleanup();}
});
test('provider ERROR is passive metadata, not a lifecycle or owner cancellation event', () => {
  const f = fixture(); const {session} = f.acknowledgeAndAdopt();
  try {
    const lifecycle = running(f.job), metadata = f.completeOutput({status: 'ERROR'});
    assert.equal(metadata.provider_reported_status, 'ERROR'); assert.equal(metadata.task_outcome_evaluated, false);
    assert.equal(lifecycle.lifecycle_status, 'RUNNING'); assert.equal(lifecycle.record, null);
    assert.equal(session.snapshot().canceled, false); assert.equal(session.snapshot().process_exit_code, null);
    assert.equal(session.releaseWorkspace(), false); assert.deepEqual(f.managerCalls, []);
  } finally {f.cleanup();}
});
