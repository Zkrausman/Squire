// Source-only composition. No dispatch port, native defaults, pump or runtime admission.
import {validateJobSpec, closed, object, own, fail, nonnegative} from './job-spec.mjs';
import {createLifecycle, advanceLifecycle, finalizeLifecycle} from './lifecycle.mjs';
import {USAGE_FIELDS} from './job-record.mjs';
import {prepareAgyArgv, AGY_BYTE_LIMITS, AGY_CHILD_ENV_DELETIONS} from './agy-profile.mjs';
import {captureInvocation} from './execution-wrapper.mjs';
import {createStartupOperation} from './startup-operation.mjs';
import {createManagerCustodyFactory, captureUnitBinding} from './manager-custody.mjs';
import {createAgyOutputCollector} from './agy-output-collector.mjs';
import {createKnownCustodyCoordinator} from './known-custody-coordinator.mjs';
import {verifyArtifacts} from './artifact-verifier.mjs';

const admissionFields = ['admission_passed', 'workspace_fence_passed', 'history_fence_passed', 'process_group_allocated'];
const same = (a, b) => ['job_id', 'unit_name', 'invocation_id'].every(key => a[key] === b[key]);
function childEnvironment(input) {
  object(input, 'environment'); const result = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!own(descriptor, 'value')) fail('environment');
    if (!AGY_CHILD_ENV_DELETIONS.includes(key)) result[key] = descriptor.value;
  }
  return result;
}

export function createInjectedTaskCoordinator(options) {
  closed(options, ['spec', 'policy', 'clock', 'task_deadline_ms', 'preparation', 'environment', 'stdio',
    'manager', 'qualification', 'source', 'read_timeout_ms', 'artifact_fs'], [], 'task_options');
  const spec = validateJobSpec(options.spec);
  closed(options.policy, ['unit_name', 'task_scope', 'stop_grace_ms'], [], 'task_policy');
  closed(options.clock, ['now', 'schedule'], [], 'task_clock');
  closed(options.source, ['nextEvent'], [], 'manager_source');
  closed(options.preparation, ['effort', 'observed_cli_version', 'executable_reference', 'prompt_bytes', 'policy_data'], [], 'preparation');
  closed(options.artifact_fs, ['lstat', 'realpath', 'open'], [], 'artifact_fs');
  if (typeof options.clock.now !== 'function' || typeof options.clock.schedule !== 'function' ||
      typeof options.source.nextEvent !== 'function' || !Number.isSafeInteger(options.policy.stop_grace_ms) || options.policy.stop_grace_ms <= 0 || !Number.isSafeInteger(options.read_timeout_ms) || options.read_timeout_ms <= 0 ||
      ['lstat', 'realpath', 'open'].some(key => typeof options.artifact_fs[key] !== 'function')) fail('task_ports');
  const deadline = options.task_deadline_ms, rawNow = options.clock.now, clockReceiver = options.clock;
  const rawNext = options.source.nextEvent, sourceReceiver = options.source;
  const readTimeout = options.read_timeout_ms;
  const schedule = options.clock.schedule, artifactFs = Object.freeze({...options.artifact_fs});
  const policy = Object.freeze({...options.policy});
  let lifecycle = createLifecycle(spec), operation = null, session = null, known = null, collector = null;
  let revision = 0, busy = false, clockBusy = false, lastNow = -1, canceled = false, cancellationReason = null;
  let fenceRequested = false, exitConflict = false, populatedObserved = null;
  let fatal = null, managerExitSeen = false, managerExit = null, nativeApplied = false, providerMetadata = null;
  let verification = null, verifying = false, verificationAttempted = false, verifyController = null;
  function failTask(code) { if (!fatal) {fatal = code; revision++;} }
  function latch(reason) {
    if (canceled || lifecycle.record !== null) return;
    canceled = true; cancellationReason = reason;
    lifecycle = advanceLifecycle(lifecycle, reason === 'user_abort' ? 'EVENT_USER_ABORT' : 'EVENT_TIMEOUT_OR_ABORT'); revision++;
  }
  function abortInspection() { if (verifyController && !verifyController.signal.aborted) verifyController.abort(); }
  function readClock() {
    if (clockBusy) {fenceRequested = true; failTask('clock_reentrancy'); fail('task_clock', 'reentrant_transition');}
    clockBusy = true;
    try {
      let value;
      try {value = Reflect.apply(rawNow, clockReceiver, []);} catch {fenceRequested = true; failTask('clock_failure'); abortInspection(); throw new TypeError('task_clock');}
      if (!nonnegative(value) || value < lastNow) {fenceRequested = true; failTask('clock_regression'); abortInspection(); fail('task_clock');}
      lastNow = value;
      if (value >= deadline) {latch('deadline'); abortInspection();}
      return value;
    } finally {clockBusy = false;}
  }
  const clock = Object.freeze({now: readClock, schedule: (delay, fn) => Reflect.apply(schedule, clockReceiver, [delay, fn])});
  const factory = createManagerCustodyFactory({manager: options.manager, clock: {now: readClock}, qualification: options.qualification});
  operation = createStartupOperation({spec, policy: {unit_name: policy.unit_name, task_scope: policy.task_scope},
    clock: {now: readClock}, task_deadline_ms: deadline});
  let plan, invocation;
  try {
    plan = prepareAgyArgv({...options.preparation, job_spec: spec, task_deadline_ms: deadline, observed_now_ms: readClock()}, AGY_BYTE_LIMITS);
    if (plan.status !== 'PREPARED_NOT_EXECUTABLE') operation.markNotAdmitted(plan.diagnostic);
    else invocation = captureInvocation({executable: plan.argv[0], args: plan.argv.slice(1),
      env: childEnvironment(options.environment), stdio: options.stdio});
  } catch (error) {operation.markNotAdmitted('invalid_preparation'); throw error;}

  function current() {return session?.snapshot() ?? null;}
  function snapshot() {
    return Object.freeze({job_id: spec.job_id, task_deadline_ms: deadline, lifecycle, startup: operation.snapshot(),
      custody: current(), collection: collector?.snapshot() ?? null, metadata: providerMetadata,
      verification, verification_in_progress: verifying, verification_attempted: verificationAttempted,
      canceled, cancellation_reason: cancellationReason, fatal_diagnostic: fatal, state_revision: revision,
      record_withheld: lifecycle.lifecycle_status === 'TERMINAL_SETTLEMENT' && lifecycle.record === null,
      runtime_qualification: 'NOT_ESTABLISHED_BY_SOURCE'});
  }
  function flushFence() {
    if (fenceRequested && session) {fenceRequested = false; session.schedulingFailed(); abortInspection();}
  }
  function guard(action) {
    if (busy || clockBusy) {fenceRequested = true; failTask('reentrant_task_operation'); fail('task_coordinator', 'reentrant_transition');}
    busy = true;
    try {return action();} finally {try {flushFence();} finally {busy = false;}}
  }
  function captureNative(event, signal) {
    if (signal.aborted) return;
    try {
      closed(event, ['type', 'value'], [], 'manager_event');
      if (event.type === 'cgroup') {
        closed(event.value, ['binding', 'populated', 'launch_closed', 'coverage_complete', 'exact_live_count'], [], 'cgroup');
        if (same(captureUnitBinding(event.value.binding), current().unit)) populatedObserved =
          event.value.launch_closed === true && event.value.coverage_complete === true && [0, 1].includes(event.value.populated) ? event.value.populated : null;
        return;
      }
      if (event.type !== 'native_exit') return;
      closed(event.value, ['binding', 'code'], [], 'native_exit');
      const bound = captureUnitBinding(event.value.binding);
      if (!same(bound, current().unit) || event.value.code !== null && !Number.isSafeInteger(event.value.code)) return;
      if (!managerExitSeen) {managerExitSeen = true; managerExit = event.value.code; revision++;}
      else if (managerExit !== event.value.code) failTask('observation_conflict');
    } catch { /* The existing manager bridge owns DTO rejection/fencing. */ }
  }
  function checkExitConflict() {
    const output = collector?.snapshot();
    if (!exitConflict && managerExitSeen && output?.raw_exit_observed && managerExit !== output.raw_wrapper.exit_code) {
      exitConflict = true;
      failTask('observation_conflict'); session.observationFailed(); abortInspection(); known?.reconcile();
      fail('process_exit_code', 'observation_conflict');
    }
  }
  function sync() {
    flushFence();
    const state = current(); if (!state) return;
    if (state.canceled) {latch(state.cancellation_reason === 'timeout' ? 'deadline' : 'user_abort'); abortInspection();}
    if (state.admission_quarantined || !state.custody_acknowledged) {failTask('custody_unavailable'); abortInspection();}
    if (lifecycle.record === null && managerExitSeen && !nativeApplied && ['RUNNING', 'SETTLING_DESCENDANTS'].includes(lifecycle.lifecycle_status)) {
      if (lifecycle.lifecycle_status === 'RUNNING' || lifecycle.terminal_intent === 'CANCELED') {
        const event = managerExit === null ? 'EVENT_PROCESS_EXIT_UNOBSERVED' : managerExit === 0 ? 'EVENT_PROCESS_EXIT_ZERO' : 'EVENT_PROCESS_EXIT_NONZERO';
        lifecycle = advanceLifecycle(lifecycle, event, managerExit === null ? {} : {process_exit_code: managerExit}); nativeApplied = true; revision++;
      }
    }
    checkExitConflict();
    known?.reconcile();
    const ending = current();
    if (ending.canceled) {latch(ending.cancellation_reason === 'timeout' ? 'deadline' : 'user_abort'); abortInspection();}
    if (ending.admission_quarantined || !ending.custody_acknowledged) {failTask('custody_unavailable'); abortInspection();}
  }
  function operationalTeardown() {
    const state = current();
    if (state && fatal && !state.canceled && state.custody_acknowledged && !state.admission_quarantined &&
        !['CLEAN', 'ORPHAN_KILLED'].includes(state.settlement_status) && !state.stop_attempted) session.settle();
  }
  function collectMetadata() {
    if (!collector) return;
    const state = collector.snapshot();
    if (state.phase === 'FAULTED' && !canceled) failTask('collector_failure');
    if (state.phase === 'CLOSED' && !canceled && lifecycle.record === null) failTask('collector_closed');
    if (!fatal && !canceled && state.phase === 'IO_DRAINED' && state.raw_exit_observed) {
      const before = revision, value = collector.drainAndDecode();
      if (value && before === revision && !fatal && !canceled) {providerMetadata = value; revision++;}
      if (collector.snapshot().phase === 'FAULTED' && !canceled) failTask('collector_failure');
    }
  }
  function matchQuiescence(assertion) {
    closed(assertion, ['binding', 'task_scope', 'owned_writers_settled', 'exclusive_no_external_writers'], [], 'quiescence');
    const bound = captureUnitBinding(assertion.binding);
    if (!same(bound, current().unit) || assertion.task_scope !== spec.task_scope ||
        assertion.owned_writers_settled !== true || assertion.exclusive_no_external_writers !== true) fail('quiescence');
  }
  function provedEmpty(state) {
    return state && state.custody_acknowledged && !state.admission_quarantined && !state.stop_ack_pending &&
      state.live_count === 0 && ['CLEAN', 'ORPHAN_KILLED'].includes(state.settlement_status);
  }
  function finishRecord() {
    sync(); const state = current();
    if (lifecycle.record || !state) return snapshot();
    if (lifecycle.lifecycle_status === 'RUNNING') {
      if (!fatal && !canceled || !managerExitSeen && state.custody_acknowledged && !state.coordinator_returned) return snapshot();
      lifecycle = advanceLifecycle(lifecycle, 'EVENT_PROCESS_EXIT_UNOBSERVED');
    }
    if (lifecycle.lifecycle_status === 'VERIFYING_ARTIFACTS') {
      if (!verification && !fatal) return snapshot();
      lifecycle = advanceLifecycle(lifecycle, verification?.verified && !fatal && !canceled ? 'EVENT_ARTIFACTS_VERIFIED' : 'EVENT_ARTIFACT_VERIFICATION_FAILED',
        verification?.verified && !fatal && !canceled ? {artifact_witness: verification.artifact_witness} : {});
    }
    if (lifecycle.lifecycle_status === 'SETTLING_DESCENDANTS') {
      const event = provedEmpty(state) ? state.settlement_status === 'CLEAN' ? 'EVENT_DESCENDANTS_OBSERVED_CLEAN' : 'EVENT_DESCENDANTS_OBSERVED_ORPHAN_KILLED' :
        state.settlement_status === 'DIRTY_LEAK' ? 'EVENT_SETTLEMENT_LIMIT_EXCEEDED_LEAK' :
          state.admission_quarantined || fatal || state.coordinator_returned ? 'EVENT_SETTLEMENT_OBSERVATION_FAILED' : null;
      if (!event) return snapshot();
      lifecycle = advanceLifecycle(lifecycle, event); revision++;
    }
    if (lifecycle.lifecycle_status !== 'TERMINAL_SETTLEMENT') return snapshot();
    const raw = collector?.snapshot();
    if (!managerExitSeen || !raw?.raw_exit_observed || raw.raw_wrapper.wall_ms === null) return snapshot();
    const metrics = Object.fromEntries(USAGE_FIELDS.map(key => [key, providerMetadata?.usage?.[key] ?? 'UNKNOWN']));
    lifecycle = finalizeLifecycle(lifecycle, {job_id: spec.job_id, reported_model: providerMetadata?.extra_metadata.backend_model ?? 'UNKNOWN',
      lifecycle_status: lifecycle.terminal_intent, process_exit_code: lifecycle.process_exit_code,
      process_wall_ms: raw.raw_wrapper.wall_ms, inference_time_ms: 'UNKNOWN', usage_tokens: metrics,
      artifact_witness: lifecycle.artifact_witness ?? {}, settlement_status: lifecycle.settlement_status ?? (lifecycle.process_group_allocated ? 'UNKNOWN' : null)});
    collector.close(); revision++; return snapshot();
  }
  const api = Object.freeze({plan, snapshot,
    markDispatchAttempted() {return guard(() => {if (plan.status !== 'PREPARED_NOT_EXECUTABLE') fail('dispatch', 'not_admitted'); operation.markDispatchAttempted(); revision++; return snapshot();});},
    applyStartAck(ack, evidence) {
      return guard(() => {
        if (session) fail('adoption', 'already_adopted');
        closed(evidence, admissionFields, [], 'admission');
        if (admissionFields.some(key => evidence[key] !== true)) fail('admission_observations');
        const acceptedEvidence = Object.freeze(Object.fromEntries(admissionFields.map(key => [key, evidence[key]])));
        operation.applyStartAck(ack);
        if (operation.snapshot().phase !== 'ACK_CONFIRMED') {failTask('startup_unacknowledged'); return snapshot();}
        session = factory.adoptStartupOperation(operation, spec, invocation, {unit_name: policy.unit_name, stop_grace_ms: policy.stop_grace_ms});
        let admitted = advanceLifecycle(createLifecycle(spec), 'EVENT_ADMISSION_PASSED', acceptedEvidence);
        if (canceled) admitted = advanceLifecycle(admitted, cancellationReason === 'user_abort' ? 'EVENT_USER_ABORT' : 'EVENT_TIMEOUT_OR_ABORT');
        lifecycle = admitted; revision++;
        collector = createAgyOutputCollector({binding: session.snapshot().unit, limits: {max_stdout_bytes: 1048576, max_stderr_bytes: 65536},
          clock: {now: readClock}, task_deadline_ms: deadline});
        const source = {nextEvent(request) {return Promise.resolve(Reflect.apply(rawNext, sourceReceiver, [request])).then(event => {captureNative(event, request.signal); return event;});}};
        known = createKnownCustodyCoordinator({session, source, clock, read_timeout_ms: readTimeout});
        known.result.then(() => {try {sync();} catch {failTask('observation_conflict');}});
        sync(); return snapshot();
      });
    },
    readManagerEvent() {
      if (!known) fail('task', 'custody_not_acknowledged');
      return known.readNext().then(response => {guard(() => {sync(); operationalTeardown();}); return response;});
    },
    feedOutput(event) {
      return guard(() => {
        if (!collector) fail('task', 'custody_not_acknowledged');
        const response = collector.applyEvent(event); sync(); collectMetadata(); operationalTeardown(); sync(); return response;
      });
    },
    tick() {return guard(() => {readClock(); if (session) {session.tick(); collector.applyEvent({type: 'tick', binding: current().unit}); sync(); operationalTeardown(); known.reconcile();} else operation.tick(); return snapshot();});},
    abort() {
      if (lifecycle.record) return snapshot();
      latch('user_abort'); // Task intent precedes every fallible owner/callback call.
      const reentrant = busy || clockBusy;
      if (!reentrant) busy = true;
      try {
        // Genuine owner APIs also latch intent before their own busy/clock guards.
        if (session) session.abort(); else operation.abort('user_abort');
        abortInspection();
        if (collector) collector.applyEvent({type: 'abort', binding: current().unit, code: 'USER_ABORT'});
        if (reentrant) {fenceRequested = true; failTask('reentrant_task_operation'); fail('task_coordinator', 'reentrant_transition');}
        if (known) {known.abort(); sync();}
        else if (operation.snapshot().phase === 'NOT_DISPATCHED') operation.markNotAdmitted('user_aborted');
        return snapshot();
      } finally {if (!reentrant) {try {flushFence();} finally {busy = false;}}}
    },
    requestSettlement() {return guard(() => {sync(); const state = current(); if (state && (fatal || managerExitSeen && populatedObserved === 1) && !provedEmpty(state) && state.custody_acknowledged && !state.admission_quarantined && !state.stop_attempted) session.settle(); sync(); return snapshot();});},
    async finish(assertion) {
      if (verifying) fail('verification', 'verification_in_progress');
      let inspect = false;
      guard(() => {
        readClock(); sync(); collectMetadata(); operationalTeardown(); sync();
        if (!session || lifecycle.record) return;
        if (lifecycle.lifecycle_status === 'VERIFYING_ARTIFACTS' && !fatal && !canceled && !verificationAttempted) {
          if (!provedEmpty(current())) fail('verification', 'settlement_not_proved');
          if (!providerMetadata || collector.snapshot().phase !== 'IO_DRAINED' || collector.snapshot().diagnostic !== 'NONE') fail('verification', 'output_not_drained');
          matchQuiescence(assertion); verificationAttempted = true; verifying = true;
          verifyController = new AbortController(); inspect = true; revision++;
        }
      });
      if (inspect) {
        let result;
        try {result = await verifyArtifacts(spec, {fs: artifactFs, signal: verifyController.signal});}
        catch {failTask('verification_contract_error');}
        finally {verifying = false; verifyController = null;}
        guard(() => {readClock(); sync(); if (!canceled && !fatal) verification = result ?? null; revision++;});
      }
      return guard(finishRecord);
    },
    releaseWorkspace() {
      return guard(() => {
        readClock(); sync();
        if (!lifecycle.record || !provedEmpty(current())) return false;
        const released = session.releaseWorkspace(); known.reconcile(); return released;
      });
    },
    callerResult() {if (!known) fail('task', 'custody_not_acknowledged'); return known.result;}
  });
  return api;
}
