// SOURCE_SIMULATION only. Ports, clock, and scheduler are injected; this module
// supplies no native adapter, timer, process control, network, or filesystem IO.
import {types} from 'node:util';
import {createFixobsObservation} from './fixobs.mjs';

const PHASES = Object.freeze(['LAUNCH', 'F0_CAPTURE', 'KEY_ACTION', 'F1_CAPTURE',
  'CLICK_ACTION', 'F2_CAPTURE', 'STOP', 'SETTLEMENT']);
const ACTIONS = Object.freeze(['SPACE_STROKE', 'BUTTON1_CENTER_STROKE']);
const CAPTURES = Object.freeze(['F0', 'F1', 'F2']);
const STATES = Object.freeze(['CREATED', 'LAUNCH_RESERVING', 'LAUNCH_DISPATCHING',
  'F0_CAPTURING', 'F0_EVALUATING', 'KEY_RESERVING', 'KEY_DISPATCHING',
  'F1_CAPTURING', 'F1_EVALUATING', 'CLICK_RESERVING', 'CLICK_DISPATCHING',
  'F2_CAPTURING', 'F2_EVALUATING', 'STOPPED', 'SETTLING', 'COMPLETED']);
const ERRORS = Object.freeze(['NONE', 'LAUNCH_FAULT', 'ACTION_FAULT',
  'CAPTURE_FAULT', 'STOP_FAULT', 'SETTLEMENT_FAULT', 'PHASE_DEADLINE',
  'CLEANUP_DEADLINE', 'ACTIVE_DEADLINE', 'CALLER_ABORT', 'IDENTITY_CONFLICT',
  'DUPLICATE_ACK', 'INVALID_CLOCK', 'UNEXPECTED_SEQUENCE',
  'CONCURRENT_DISPATCH_REJECTED', 'HARNESS_ALREADY_COMPLETED',
  'SCHEDULER_FAULT', 'UNKNOWN']);
const STOP_REASONS = Object.freeze(['CALLER_STOP', 'CALLER_ABORT', 'PHASE_DEADLINE',
  'CLEANUP_DEADLINE', 'ACTIVE_DEADLINE', 'LAUNCH_FAULT', 'ACTION_FAULT',
  'CAPTURE_FAULT', 'PREDICATE_MISMATCH', 'BACKGROUND_DRIFT', 'IDENTITY_CONFLICT',
  'INVALID_CLOCK', 'UNEXPECTED_SEQUENCE', 'THREE_BUFFER_PREDICATES_MATCH']);
const AUDIT_EVENTS = Object.freeze(['HARNESS_CREATED', 'LAUNCH_DISPATCHED',
  'LAUNCH_ACK_RECEIVED', 'ACTION_DISPATCHED', 'ACTION_ACK_RECEIVED',
  'CAPTURE_DISPATCHED', 'CAPTURE_EVALUATED', 'STOP_DISPATCHED', 'STOP_ACK_RECEIVED',
  'SETTLEMENT_DISPATCHED', 'SETTLEMENT_OBSERVED', 'DEADLINE_DELIVERED',
  'ABORT_LATCHED', 'CONCURRENT_REJECTED', 'LATE_OUTCOME_DISCARDED',
  'LATE_FAULT_TRAPPED', 'LATE_ABANDONED_LAUNCH_FENCED',
  'IDENTITY_CONFLICT_DETECTED', 'HARNESS_COMPLETED']);
const DETAILS = Object.freeze(['OK', 'TIMEOUT', 'FAULT', 'ABANDONED', 'MATCH',
  'DRIFT', 'FENCED', 'REJECTED', 'IGNORED']);

export const FIXOBS_HARNESS_ENUMS = Object.freeze({
  phases: PHASES, actions: ACTIONS, captures: CAPTURES, states: STATES,
  errors: ERRORS, stopReasons: STOP_REASONS, auditEvents: AUDIT_EVENTS,
  details: DETAILS,
});
export const FIXOBS_HARNESS_CONTRACT = Object.freeze({
  schema: 'squire.fixobs.lifecycle_harness_summary.v2',
  mode: 'SOURCE_SIMULATION',
  runtime_admitted: false,
  qualified_observation: false,
  custody_established: false,
  process_ceiling_enforced: false,
  benchmark_pass: false,
});

const sets = values => new Set(values);
const errorSet = sets(ERRORS), reasonSet = sets(STOP_REASONS);
const phaseSet = sets(PHASES), actionSet = sets(ACTIONS), captureSet = sets(CAPTURES);
const idPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const safeTime = value => Number.isSafeInteger(value) && value >= 0;
const safeId = value => typeof value === 'string' && idPattern.test(value);
const own = (value, key) => Object.getOwnPropertyDescriptor(value, key);
const plain = value => value !== null && typeof value === 'object' &&
  !types.isProxy(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

function dataRecord(value, required, optional = []) {
  try {
    if (!plain(value)) return null;
    const allowed = new Set([...required, ...optional]);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || !allowed.has(key))) return null;
    const out = Object.create(null);
    for (const key of keys) {
      const descriptor = own(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
      out[key] = descriptor.value;
    }
    if (required.some(key => !Object.hasOwn(out, key))) return null;
    return out;
  } catch { return null; }
}

function dataMethod(target, key) {
  try {
    if (target === null || (typeof target !== 'object' && typeof target !== 'function') ||
        types.isProxy(target)) return null;
    let current = target;
    for (let depth = 0; current && depth < 8; depth++, current = Object.getPrototypeOf(current)) {
      const descriptor = own(current, key);
      if (descriptor) return Object.hasOwn(descriptor, 'value') &&
        typeof descriptor.value === 'function' ? descriptor.value : null;
    }
  } catch { return null; }
  return null;
}

function codedError(code) {
  const error = new Error(code);
  Object.defineProperty(error, 'code', {value: code, enumerable: true});
  return error;
}

function immutable(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) immutable(value[key]);
    Object.freeze(value);
  }
  return value;
}

function boundedStrings(value, limit) {
  try {
    if (!Array.isArray(value) || types.isProxy(value) ||
        Object.getPrototypeOf(value) !== Array.prototype) return null;
    const length = own(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) return null;
    const out = [];
    for (let index = 0; index < length; index++) {
      const descriptor = own(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') ||
          !safeId(descriptor.value)) return null;
      out.push(descriptor.value);
    }
    if (Reflect.ownKeys(value).some(key => key !== 'length' &&
        !(typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) &&
          Number(key) < length))) return null;
    return out;
  } catch { return null; }
}

function correlation(base, operationId) {
  return Object.freeze({...base, operation_id: operationId});
}

function exactCorrelation(value, expected) {
  const data = dataRecord(value, ['run_id', 'job_id', 'generation_id', 'operation_id']);
  return !!data && data.run_id === expected.run_id && data.job_id === expected.job_id &&
    data.generation_id === expected.generation_id &&
    data.operation_id === expected.operation_id;
}

function availableOwnCorrelation(value) {
  try {
    if (!plain(value)) return null;
    const descriptor = own(value, 'correlation');
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null;
    const data = dataRecord(descriptor.value,
      ['run_id', 'job_id', 'generation_id', 'operation_id']);
    return data && ['run_id', 'job_id', 'generation_id', 'operation_id']
      .every(key => safeId(data[key])) ? data : null;
  } catch { return null; }
}

function statusErrorCode(value, fallback) {
  return value === null || value === 'NONE' ? null :
    errorSet.has(value) ? value : fallback;
}

function validErrorCode(value) {
  return value === null || errorSet.has(value);
}

function successErrorCode(value) {
  return value === null || value === 'NONE';
}

function possibleLaunchIdentity(value, expected) {
  try {
    if (!plain(value)) return null;
    const correlationData = own(value, 'correlation');
    const status = own(value, 'status');
    const pid = own(value, 'injected_process_id');
    if (!correlationData || !status || !pid ||
        !Object.hasOwn(correlationData, 'value') ||
        !Object.hasOwn(status, 'value') ||
        !Object.hasOwn(pid, 'value') ||
        !exactCorrelation(correlationData.value, expected) ||
        status.value !== 'ACK' || !safeId(pid.value)) return null;
    return Object.freeze({correlation: expected, injected_process_id: pid.value});
  } catch { return null; }
}

function modelStopReason(snapshot) {
  if (snapshot.reason === 'THREE_BUFFER_PREDICATES_MATCH') return 'THREE_BUFFER_PREDICATES_MATCH';
  if (snapshot.reason === 'BACKGROUND_DRIFT') return 'BACKGROUND_DRIFT';
  if (snapshot.reason === 'INVALID_CLOCK') return 'INVALID_CLOCK';
  if (snapshot.reason === 'PHASE_DEADLINE') return 'PHASE_DEADLINE';
  if (snapshot.reason === 'UNEXPECTED_SEQUENCE') return 'UNEXPECTED_SEQUENCE';
  return 'PREDICATE_MISMATCH';
}

function opId(phase) {
  return ({LAUNCH: 'op_launch_0', F0_CAPTURE: 'op_capture_F0',
    KEY_ACTION: 'op_action_SPACE', F1_CAPTURE: 'op_capture_F1',
    CLICK_ACTION: 'op_action_BUTTON1', F2_CAPTURE: 'op_capture_F2',
    STOP: 'op_stop_0', SETTLEMENT: 'op_settlement_0'})[phase];
}

export function createFixobsLifecycleHarness(options) {
  const input = dataRecord(options,
    ['t0_ms', 'correlation', 'ports', 'clock', 'scheduler', 'mode']);
  if (!input || !safeTime(input.t0_ms) || !Number.isSafeInteger(input.t0_ms + 60000) ||
      input.mode !== 'SOURCE_SIMULATION') throw codedError('UNKNOWN');
  const base = dataRecord(input.correlation, ['run_id', 'job_id', 'generation_id']);
  if (!base || !safeId(base.run_id) || !safeId(base.job_id) ||
      !safeId(base.generation_id)) throw codedError('UNKNOWN');
  const portSpecs = [
    ['launchPort', 'launch'], ['actionPort', 'dispatchAction'],
    ['capturePort', 'captureFrame'], ['stopPort', 'stop'],
    ['settlementPort', 'observeSettlement'],
  ];
  const ports = Object.create(null);
  for (const [name, methodName] of portSpecs) {
    const port = input.ports && dataRecord(input.ports, portSpecs.map(item => item[0]));
    const method = port && dataMethod(port[name], methodName);
    if (!method) throw codedError('UNKNOWN');
    ports[name] = {receiver: port[name], method};
  }
  const clockNow = dataMethod(input.clock, 'now');
  const schedule = dataMethod(input.scheduler, 'schedule');
  if (!clockNow || !schedule || types.isProxy(input.clock) ||
      types.isProxy(input.scheduler)) throw codedError('UNKNOWN');

  const model = createFixobsObservation(input.t0_ms);
  let state = 'CREATED', activePhase = null, activeSlot = null, cleanupSlot = null;
  let busy = false, runStarted = false, cancellationLatched = false;
  let stopStarted = false, cleanupExpired = false, cleanupPromise = null;
  let cleanupToken = null, cleanupDeadline = null, harnessStopReason = null;
  let injectedProcessId = null, lastObserved = input.t0_ms, cleanupFault = false;
  let identityConflictLatched = false, terminalizing = false;
  let pendingLaunchIdentity = null;
  let lifecycleSummary = null, terminalResolve;
  const terminalPromise = new Promise(resolve => { terminalResolve = resolve; });
  const calls = {launches: 0, actions: 0, captures: 0, stops: 0, settlements: 0};
  const abandoned = [], orphaned = [], fenced = [], audit = [];
  const launchCorr = correlation(base, opId('LAUNCH'));
  const stopCorr = correlation(base, opId('STOP'));
  const settlementCorr = correlation(base, opId('SETTLEMENT'));
  const summaries = {
    launch: {correlation: launchCorr, status: 'NOT_RUN', t_ack_ms: null,
      injected_process_id: null, error_code: null},
    actions: [], captures: [],
    stop: {correlation: stopCorr, status: 'NOT_RUN', t_stop_ms: null,
      direct_child_exit_observed: false, error_code: null},
    settlement: {correlation: settlementCorr, status: 'NOT_RUN',
      t_observed_ms: null, scope_observation: null,
      fenced_scope_descriptors: [], error_code: null},
  };

  function addAudit(event, at, detail = 'OK') {
    if (audit.length < 48 && AUDIT_EVENTS.includes(event) &&
        DETAILS.includes(detail) && safeTime(at)) audit.push({event, t_ms: at, detail_code: detail});
  }
  function addUnique(list, value) {
    if (safeId(value) && list.length < 8 && !list.includes(value)) list.push(value);
  }
  function addFence(value, local = false) {
    const internal = typeof value === 'string' &&
      ['late-launch:', 'simulated-scope:'].some(prefix =>
        value.startsWith(prefix) && safeId(value.slice(prefix.length)));
    if (!(safeId(value) || internal) || fenced.includes(value)) return;
    if (fenced.length === 8) {
      if (!local) return;
      fenced.pop();
    }
    fenced.push(value);
  }
  function fenceLocalScope(scopeId = injectedProcessId) {
    const descriptor = scopeId === null ? 'unacknowledged_launch_scope' :
      `simulated-scope:${scopeId}`;
    addFence(descriptor, true);
    const descriptions = summaries.settlement.fenced_scope_descriptors;
    if (!descriptions.includes(descriptor)) {
      if (descriptions.length === 8) descriptions.pop();
      descriptions.push(descriptor);
    }
  }
  function frozenSnapshot() {
    return immutable({
      schema: 'squire.fixobs.harness_snapshot.v1',
      harness_state: state,
      model_snapshot: model.snapshot(),
      active_phase: activePhase,
      cancellation_latched: cancellationLatched,
      injected_process_id: injectedProcessId,
      actual_port_calls: {...calls},
      retained_owner_state: {
        abandoned_operations: abandoned.map(item => ({...item})),
        orphaned_injected_process_ids: [...orphaned],
        fenced_scopes: [...fenced],
      },
      last_observed_ms: lastObserved,
    });
  }
  function sampleClock() {
    let value;
    try { value = Reflect.apply(clockNow, input.clock, []); }
    catch { value = NaN; }
    return terminalizing || lifecycleSummary ? null : {value};
  }
  function readClock() {
    const sample = sampleClock();
    return sample === null ? null : observeTime(sample.value);
  }
  function readCaptureCompletionTime(row) {
    const sample = sampleClock();
    if (sample === null || stopStarted) return null;
    const {value} = sample;
    if (!safeTime(value) || value < lastObserved) {
      row.status = 'FAULT';
      row.error_code = 'INVALID_CLOCK';
      observeTime(value);
      return null;
    }
    return value;
  }
  function observeTime(value) {
    if (terminalizing || lifecycleSummary) return null;
    const observedBefore = lastObserved;
    const snapshot = model.poll(value);
    lastObserved = snapshot.last_ms;
    if (snapshot.first_stop_ms !== null) {
      if (!stopStarted) beginStop(modelStopReason(snapshot), snapshot.first_stop_ms, true);
      if (terminalizing || lifecycleSummary) return null;
      if (cleanupDeadline !== null && safeTime(value) && value >= cleanupDeadline) {
        expireCleanup(value);
        return null;
      }
      if (!safeTime(value) || value < observedBefore) return null;
      return value;
    }
    if (!safeTime(value) || value < observedBefore) return null;
    return value;
  }
  function dispatchTime(requested) {
    if (requested !== undefined &&
        (!safeTime(requested) || requested < lastObserved)) {
      observeTime(requested);
      if (!stopStarted) beginStop('INVALID_CLOCK', lastObserved, true);
      return null;
    }
    const now = readClock();
    if (now === null) return null;
    if (requested !== undefined && now < requested) {
      observeTime(NaN);
      return null;
    }
    return now;
  }
  function requestTimeout(at, phaseDeadline) {
    return Math.max(1, Math.min(phaseDeadline, input.t0_ms + 30000) - at);
  }
  function cancelToken(token) {
    const cancel = token && dataMethod(token, 'cancel');
    if (!cancel) return false;
    try { Reflect.apply(cancel, token, []); return true; }
    catch { return false; }
  }
  function scheduleToken(target, callback) {
    let token;
    try { token = Reflect.apply(schedule, input.scheduler, [target, callback]); }
    catch { return null; }
    if (!token || !dataMethod(token, 'cancel')) return null;
    return token;
  }
  function appendAbandoned(slot, reason, at) {
    const item = {operation_id: slot.correlation.operation_id, phase: slot.phase,
      t_abandoned_ms: safeTime(at) ? at : lastObserved, reason};
    if (!abandoned.some(old => old.operation_id === item.operation_id) &&
        abandoned.length < 8) abandoned.push(item);
  }
  function finishPendingRow(row, phase, reason) {
    if (!row || row.status !== 'PENDING') return;
    if (phase === 'SETTLEMENT') {
      row.status = 'UNKNOWN';
      row.error_code = identityConflictLatched ? 'IDENTITY_CONFLICT' :
        reason === 'CLEANUP_DEADLINE' ? 'CLEANUP_DEADLINE' : 'SETTLEMENT_FAULT';
      return;
    }
    if (identityConflictLatched) {
      row.status = 'FAULT';
      row.error_code = 'IDENTITY_CONFLICT';
      return;
    }
    const timeout = reason === 'PHASE_DEADLINE' ||
      reason === 'ACTIVE_DEADLINE' || reason === 'CLEANUP_DEADLINE';
    row.status = timeout ? 'TIMEOUT' : 'FAULT';
    row.error_code = timeout ? reason :
      reason === 'CALLER_ABORT' ? 'CALLER_ABORT' :
        phase === 'LAUNCH' ? 'LAUNCH_FAULT' :
          phase.endsWith('_ACTION') ? 'ACTION_FAULT' :
            phase.endsWith('_CAPTURE') ? 'CAPTURE_FAULT' : 'STOP_FAULT';
  }
  function markActiveAbandoned(reason, at) {
    const slot = activeSlot;
    if (!slot || slot.state !== 'PENDING') return;
    slot.state = 'ABANDONED_LOCKED';
    finishPendingRow(slot.summaryRow, slot.phase, reason);
    appendAbandoned(slot, reason, at);
    slot.resolveRace({kind: 'abandoned'});
    cancelToken(slot.token);
  }
  function completeSummary() {
    if (lifecycleSummary) return lifecycleSummary;
    terminalizing = true;
    const pendingReason = cleanupExpired ? 'CLEANUP_DEADLINE' :
      harnessStopReason ?? 'UNKNOWN';
    finishPendingRow(summaries.launch, 'LAUNCH', pendingReason);
    for (const row of summaries.actions) {
      finishPendingRow(row, 'KEY_ACTION', pendingReason);
    }
    for (const row of summaries.captures) {
      finishPendingRow(row, 'F0_CAPTURE', pendingReason);
    }
    finishPendingRow(summaries.stop, 'STOP', pendingReason);
    finishPendingRow(summaries.settlement, 'SETTLEMENT', pendingReason);
    if (identityConflictLatched) {
      summaries.settlement.status = 'UNKNOWN';
      summaries.settlement.scope_observation = null;
      summaries.settlement.error_code = 'IDENTITY_CONFLICT';
    }
    state = 'COMPLETED';
    activePhase = null;
    addAudit('HARNESS_COMPLETED', lastObserved,
      cleanupFault ? 'FAULT' : 'OK');
    lifecycleSummary = immutable({
      schema: 'squire.fixobs.lifecycle_harness_summary.v2',
      correlation: {...base},
      mode: 'SOURCE_SIMULATION',
      harness_status: cleanupFault ? 'FAULT' :
        model.snapshot().observation === 'BUFFER_SEQUENCE_MATCH' ? 'COMPLETED' : 'STOPPED',
      harness_stop_reason: harnessStopReason,
      model_snapshot: model.snapshot(),
      actual_port_calls: {...calls},
      ports_summary: {
        launch: {...summaries.launch},
        actions: summaries.actions.map(item => ({...item})),
        captures: summaries.captures.map(item => ({...item})),
        stop: {...summaries.stop},
        settlement: {...summaries.settlement,
          scope_observation: summaries.settlement.scope_observation &&
            {...summaries.settlement.scope_observation,
              conflicting_identities: [...summaries.settlement.scope_observation.conflicting_identities]},
          fenced_scope_descriptors: [...summaries.settlement.fenced_scope_descriptors]},
      },
      retained_owner_state: {
        abandoned_operations: abandoned.map(item => ({...item})),
        orphaned_injected_process_ids: [...orphaned],
        fenced_scopes: [...fenced],
      },
      audit_events: audit.map(item => ({...item})),
      runtime_admitted: false,
      qualified_observation: false,
      custody_established: false,
      process_ceiling_enforced: false,
      benchmark_pass: false,
    });
    const token = cleanupToken;
    cleanupToken = null;
    if (token) cancelToken(token);
    terminalResolve(lifecycleSummary);
    return lifecycleSummary;
  }
  function expireCleanup(at) {
    if (cleanupExpired || terminalizing || lifecycleSummary) return;
    cleanupExpired = true;
    cleanupFault = true;
    model.poll(at);
    lastObserved = model.snapshot().last_ms;
    if (cleanupSlot && cleanupSlot.state === 'PENDING') {
      cleanupSlot.state = 'ABANDONED_LOCKED';
      finishPendingRow(cleanupSlot.summaryRow, cleanupSlot.phase,
        'CLEANUP_DEADLINE');
      appendAbandoned(cleanupSlot, 'CLEANUP_DEADLINE', at);
      cancelToken(cleanupSlot.token);
      cleanupSlot.resolveRace({kind: 'deadline'});
    }
    summaries.settlement.status = 'UNKNOWN';
    summaries.settlement.error_code = identityConflictLatched ?
      'IDENTITY_CONFLICT' : 'CLEANUP_DEADLINE';
    completeSummary();
  }
  function beginStop(reason, at, modelAlreadyStopped = false) {
    if (stopStarted) return cleanupPromise;
    const before = model.snapshot();
    // The caller's hint is never evidence of a PR180 first stop.
    if (modelAlreadyStopped && before.first_stop_ms === null) modelAlreadyStopped = false;
    if (!modelAlreadyStopped && before.first_stop_ms === null) {
      const stopAt = safeTime(at) && at >= lastObserved ? at : lastObserved;
      model.stop(stopAt);
      lastObserved = model.snapshot().last_ms;
    }
    const stopped = model.snapshot();
    if (stopped.first_stop_ms === null || stopped.cleanup_deadline_ms === null) {
      throw codedError('INVALID_CLOCK');
    }
    stopStarted = true;
    harnessStopReason = reasonSet.has(reason) ? reason : 'UNKNOWN';
    state = 'STOPPED';
    activePhase = null;
    if (pendingLaunchIdentity) {
      retainOrphanedLaunchId(pendingLaunchIdentity.injected_process_id);
      pendingLaunchIdentity = null;
    }
    cleanupDeadline = stopped.cleanup_deadline_ms;
    if (injectedProcessId === null) fenceLocalScope();
    markActiveAbandoned(harnessStopReason, lastObserved);
    if (terminalizing || lifecycleSummary) return cleanupPromise ?? terminalPromise;
    cleanupPromise = cleanupFlow().catch(() => {
      if (terminalizing || lifecycleSummary) return lifecycleSummary;
      cleanupFault = true;
      summaries.settlement.status = 'UNKNOWN';
      summaries.settlement.error_code = 'UNKNOWN';
      completeSummary();
      return lifecycleSummary;
    });
    return cleanupPromise;
  }
  function timeExpired(at) {
    if (!safeTime(at)) {
      observeTime(at);
      return true;
    }
    const snapshot = observeTime(at);
    return snapshot === null || stopStarted;
  }
  function phaseDeadlineTarget() {
    const snapshot = model.snapshot();
    const phase = snapshot.phase_deadline_ms ?? input.t0_ms + 30000;
    return Math.min(phase, input.t0_ms + 30000) + 1;
  }
  function onActiveDeadline(slot, at) {
    if (slot.state !== 'PENDING' || activeSlot !== slot) return;
    if (safeTime(at) && at < slot.deadline) {
      addAudit('DEADLINE_DELIVERED', at, 'IGNORED');
      return;
    }
    addAudit('DEADLINE_DELIVERED', safeTime(at) ? at : lastObserved, 'TIMEOUT');
    observeTime(at);
    const stopped = model.snapshot();
    if (!stopStarted && stopped.first_stop_ms !== null) {
      beginStop(modelStopReason(stopped), stopped.first_stop_ms, true);
    }
  }
  function onCleanupDeadline(target, at) {
    if (terminalizing || lifecycleSummary) return;
    if (!safeTime(at) || at < target) {
      addAudit('DEADLINE_DELIVERED', lastObserved, 'IGNORED');
      return;
    }
    expireCleanup(at);
  }
  function retainOrphanedLaunchId(pid) {
    if (!safeId(pid)) return;
    const first = !orphaned.includes(pid);
    addUnique(orphaned, pid);
    addFence(`late-launch:${pid}`, true);
    if (first) addAudit('LATE_ABANDONED_LAUNCH_FENCED', lastObserved, 'FENCED');
  }
  function lateOutcome(slot, kind, value) {
    if (kind === 'rejected') {
      addAudit('LATE_FAULT_TRAPPED', lastObserved, 'FAULT');
      return;
    }
    addAudit('LATE_OUTCOME_DISCARDED', lastObserved, 'IGNORED');
    if (slot.phase === 'LAUNCH') {
      const identity = possibleLaunchIdentity(value, slot.correlation);
      if (identity) retainOrphanedLaunchId(identity.injected_process_id);
    }
  }
  function launchAckIdentity(value, expected) {
    const data = dataRecord(value, ['correlation', 'status', 't_ack_ms',
      'injected_process_id', 'error_code']);
    if (!data || !exactCorrelation(data.correlation, expected) ||
        data.status !== 'ACK' || !safeTime(data.t_ack_ms) ||
        !safeId(data.injected_process_id) ||
        !successErrorCode(data.error_code)) return null;
    return Object.freeze({correlation: expected,
      injected_process_id: data.injected_process_id});
  }
  function duplicateOutcome(slot, kind, value) {
    if (kind === 'rejected') {
      addAudit('LATE_FAULT_TRAPPED', lastObserved, 'FAULT');
      return;
    }
    if (terminalizing || lifecycleSummary) {
      if (slot.phase === 'LAUNCH') {
        const possible = possibleLaunchIdentity(value, slot.correlation);
        if (possible && slot.firstIdentity &&
            possible.injected_process_id !== slot.firstIdentity.injected_process_id) {
          retainOrphanedLaunchId(possible.injected_process_id);
          addAudit('IDENTITY_CONFLICT_DETECTED', lastObserved, 'FENCED');
          return;
        }
      }
      addAudit('LATE_OUTCOME_DISCARDED', lastObserved, 'IGNORED');
      return;
    }
    if (slot.phase === 'LAUNCH') {
      const current = launchAckIdentity(value, slot.correlation);
      if (!slot.firstIdentity || !current ||
          current.injected_process_id !== slot.firstIdentity.injected_process_id) {
        identityConflict(lastObserved, slot.firstIdentity?.injected_process_id ?? null);
        return;
      }
    }
    addAudit('LATE_OUTCOME_DISCARDED', lastObserved, 'IGNORED');
  }
  function latchCleanupCorrelation(slot, value) {
    if (slot.kind !== 'cleanup' || terminalizing || lifecycleSummary) return;
    const available = availableOwnCorrelation(value);
    if (!available || exactCorrelation(available, slot.correlation)) return;
    if (slot.phase === 'STOP') {
      summaries.stop.status = 'FAULT';
      summaries.stop.error_code = 'IDENTITY_CONFLICT';
    }
    identityConflict(lastObserved);
  }
  function dispatchPromise(slot, port, request, counter, summaryRow, dispatchEvent) {
    return new Promise(resolve => {
      slot.resolveRace = resolve;
      slot.summaryRow = summaryRow;
      if (activeSlot && slot.kind === 'active') {
        resolve({kind: 'scheduler-fault'});
        return;
      }
      if (slot.kind === 'active') activeSlot = slot;
      else cleanupSlot = slot;
      const deadline = slot.kind === 'active' ?
        phaseDeadlineTarget() : cleanupDeadline;
      slot.deadline = deadline;
      const onDeadline = at => slot.kind === 'active' ?
        onActiveDeadline(slot, at) : onCleanupDeadline(deadline, at);
      const token = scheduleToken(deadline, onDeadline);
      if (!token) {
        if (slot.kind === 'active') activeSlot = null;
        else cleanupSlot = null;
        resolve({kind: 'scheduler-fault'});
        return;
      }
      slot.token = token;
      if (slot.state !== 'PENDING' ||
          (slot.kind === 'cleanup' &&
            (cleanupExpired || terminalizing || lifecycleSummary))) {
        cancelToken(token);
        if (slot.state === 'PENDING') resolve({kind: 'deadline'});
        return;
      }
      slot.dispatched = true;
      calls[counter]++;
      addAudit(dispatchEvent, lastObserved, 'OK');
      if (summaryRow) summaryRow.status = 'PENDING';
      let returned;
      try { returned = Reflect.apply(port.method, port.receiver, [request]); }
      catch {
        slot.state = 'RESOLVED';
        if (slot.kind === 'active') activeSlot = null;
        else cleanupSlot = null;
        if (summaryRow) {
          summaryRow.status = 'FAULT';
          summaryRow.error_code = slot.faultCode;
        }
        cancelToken(token);
        resolve({kind: 'rejected'});
        return;
      }
      const onFulfilled = value => {
        if (slot.state !== 'PENDING') {
          if (slot.state === 'ABANDONED_LOCKED') lateOutcome(slot, 'fulfilled', value);
          else duplicateOutcome(slot, 'fulfilled', value);
          return;
        }
        slot.state = 'RESOLVED';
        if (slot.phase === 'LAUNCH') {
          slot.firstIdentity = launchAckIdentity(value, slot.correlation);
          pendingLaunchIdentity = possibleLaunchIdentity(value, slot.correlation);
        }
        slot.response = value;
        // A synchronous cancel callback can expire cleanup before the awaiting
        // flow resumes. Preserve any already delivered correlation conflict.
        latchCleanupCorrelation(slot, value);
        cancelToken(token);
        if (slot.kind === 'active') activeSlot = null;
        else cleanupSlot = null;
        resolve({kind: 'fulfilled'});
      };
      const onRejected = () => {
        if (slot.state !== 'PENDING') {
          if (slot.state === 'ABANDONED_LOCKED') lateOutcome(slot, 'rejected');
          else duplicateOutcome(slot, 'rejected');
          return;
        }
        slot.state = 'RESOLVED';
        if (summaryRow) {
          summaryRow.status = 'FAULT';
          summaryRow.error_code = slot.faultCode;
        }
        cancelToken(token);
        if (slot.kind === 'active') activeSlot = null;
        else cleanupSlot = null;
        resolve({kind: 'rejected'});
      };
      if (types.isPromise(returned)) {
        try {
          const chained = Reflect.apply(Promise.prototype.then, returned,
            [onFulfilled, onRejected]);
          Reflect.apply(Promise.prototype.then, chained, [undefined, () => undefined]);
        } catch { onRejected(); }
      } else {
        const thenDescriptor = plain(returned) && own(returned, 'then');
        if (!thenDescriptor || !Object.hasOwn(thenDescriptor, 'value') ||
            typeof thenDescriptor.value !== 'function') {
          onRejected();
        } else {
          try { Reflect.apply(thenDescriptor.value, returned, [onFulfilled, onRejected]); }
          catch { onRejected(); }
        }
      }
      returned = null;
    });
  }
  function operationSlot(phase, corr, kind, faultCode) {
    return {phase, correlation: corr, kind, faultCode, state: 'PENDING',
      token: null, deadline: null, resolveRace: null, response: null,
      firstIdentity: null, summaryRow: null, dispatched: false};
  }
  function takeResponse(slot) {
    const response = slot.response;
    slot.response = null;
    return response;
  }
  function makePortResultSummary() {
    return Object.freeze({
      observation: model.snapshot().observation,
      frames: [...model.snapshot().frames],
    });
  }
  function portFailure(reason, code, at, row) {
    if (terminalizing || lifecycleSummary) return false;
    if (row) {
      row.status = code === 'PHASE_DEADLINE' ? 'TIMEOUT' : 'FAULT';
      row.error_code = errorSet.has(code) ? code : 'UNKNOWN';
    }
    beginStop(reason, at);
    return false;
  }
  function reconcileActiveCompletion(sample, row) {
    if (sample === null || stopStarted || terminalizing || lifecycleSummary) return null;
    const at = sample.value;
    if (!safeTime(at) || at < lastObserved) {
      row.status = 'FAULT';
      row.error_code = 'INVALID_CLOCK';
    } else {
      const snapshot = model.snapshot();
      if (at > snapshot.phase_deadline_ms ||
          at > snapshot.active_deadline_ms) {
        row.status = 'TIMEOUT';
        row.error_code = 'PHASE_DEADLINE';
      }
    }
    const now = observeTime(at);
    return stopStarted || terminalizing || lifecycleSummary ? null : now;
  }
  function responseTime(eventTime, dispatchAt, row, now) {
    if (now === null || stopStarted || terminalizing || lifecycleSummary) return null;
    if (!safeTime(eventTime) || eventTime < dispatchAt || eventTime > now) {
      row.status = 'FAULT';
      row.error_code = 'INVALID_CLOCK';
      observeTime(NaN);
      return null;
    }
    return now;
  }
  function matchCorrelation(data, expected) {
    return data && exactCorrelation(data.correlation, expected);
  }
  function latchIdentityConflict(at, scopeId = injectedProcessId) {
    if (terminalizing || lifecycleSummary) return;
    identityConflictLatched = true;
    cleanupFault = true;
    harnessStopReason = 'IDENTITY_CONFLICT';
    addAudit('IDENTITY_CONFLICT_DETECTED', at, 'FENCED');
    fenceLocalScope(scopeId);
    summaries.settlement.status = 'UNKNOWN';
    summaries.settlement.scope_observation = null;
    summaries.settlement.error_code = 'IDENTITY_CONFLICT';
  }
  function identityConflict(at, scopeId = injectedProcessId) {
    if (terminalizing || lifecycleSummary) return false;
    latchIdentityConflict(at, scopeId);
    beginStop('IDENTITY_CONFLICT', at);
    return false;
  }
  function expectedActivePhase() {
    if (state === 'CREATED') return 'LAUNCH';
    if (state === 'F0_CAPTURING') return 'F0_CAPTURE';
    if (state === 'KEY_RESERVING') return 'KEY_ACTION';
    if (state === 'F1_CAPTURING') return 'F1_CAPTURE';
    if (state === 'CLICK_RESERVING') return 'CLICK_ACTION';
    if (state === 'F2_CAPTURING') return 'F2_CAPTURE';
    return null;
  }
  async function runActivePhase(phase, suppliedAt) {
    if (!phaseSet.has(phase) || phase === 'STOP' || phase === 'SETTLEMENT' ||
        phase !== expectedActivePhase()) {
      const at = dispatchTime(suppliedAt);
      if (!stopStarted) beginStop('UNEXPECTED_SEQUENCE', at ?? lastObserved);
      return false;
    }
    const dispatchAt = dispatchTime(suppliedAt);
    if (dispatchAt === null || stopStarted) return false;
    activePhase = phase;
    let expectedModelPhase, reservation, kind;
    if (phase === 'LAUNCH') {
      state = 'LAUNCH_RESERVING';
      reservation = model.reserveLaunch(dispatchAt);
      expectedModelPhase = 'F0';
      state = 'LAUNCH_DISPATCHING';
    } else if (phase === 'KEY_ACTION' || phase === 'CLICK_ACTION') {
      kind = phase === 'KEY_ACTION' ? 'SPACE_STROKE' : 'BUTTON1_CENTER_STROKE';
      state = phase === 'KEY_ACTION' ? 'KEY_RESERVING' : 'CLICK_RESERVING';
      reservation = model.reserveAction(kind, dispatchAt);
      expectedModelPhase = phase === 'KEY_ACTION' ? 'F1' : 'F2';
      state = phase === 'KEY_ACTION' ? 'KEY_DISPATCHING' : 'CLICK_DISPATCHING';
    } else {
      expectedModelPhase = phase === 'F0_CAPTURE' ? 'F0' :
        phase === 'F1_CAPTURE' ? 'F1' : 'F2';
      state = phase === 'F0_CAPTURE' ? 'F0_CAPTURING' :
        phase === 'F1_CAPTURE' ? 'F1_CAPTURING' : 'F2_CAPTURING';
    }
    const reserved = model.snapshot();
    if (reserved.first_stop_ms !== null) {
      beginStop(modelStopReason(reserved), reserved.first_stop_ms, true);
      return false;
    }
    if (phase === 'LAUNCH' && reserved.phase !== expectedModelPhase ||
        (phase === 'KEY_ACTION' || phase === 'CLICK_ACTION') &&
          reserved.phase !== expectedModelPhase ||
        phase.endsWith('_CAPTURE') && reserved.phase !== expectedModelPhase) {
      beginStop('UNEXPECTED_SEQUENCE', dispatchAt, true);
      return false;
    }
    if (phase === 'LAUNCH' || phase.endsWith('_ACTION')) {
      const launch = phase === 'LAUNCH';
      const corr = correlation(base, opId(phase));
      const timeout = requestTimeout(dispatchAt, model.snapshot().phase_deadline_ms);
      const request = launch ? Object.freeze({correlation: corr,
        t_dispatch_ms: dispatchAt, timeout_ms: timeout,
        fixture_target: 'fixtures/fixobs/fixture.mjs:createFixobsWindow'}) :
        Object.freeze({correlation: corr, kind, t_dispatch_ms: dispatchAt,
          timeout_ms: timeout, injected_process_id: injectedProcessId});
      const row = launch ? summaries.launch : {
        correlation: corr, kind, status: 'NOT_RUN', t_ack_ms: null, error_code: null};
      if (!launch) summaries.actions.push(row);
      const port = launch ? ports.launchPort : ports.actionPort;
      const slot = operationSlot(phase, corr, 'active',
        launch ? 'LAUNCH_FAULT' : 'ACTION_FAULT');
      const outcome = await dispatchPromise(slot, port, request,
        launch ? 'launches' : 'actions', row,
        launch ? 'LAUNCH_DISPATCHED' : 'ACTION_DISPATCHED');
      let response = takeResponse(slot);
      if (stopStarted || cancellationLatched) {
        response = null;
        if (launch && pendingLaunchIdentity) {
          retainOrphanedLaunchId(pendingLaunchIdentity.injected_process_id);
          pendingLaunchIdentity = null;
        }
        if (outcome.kind === 'fulfilled') addAudit('LATE_OUTCOME_DISCARDED',
          lastObserved, 'IGNORED');
        return false;
      }
      if (outcome.kind === 'abandoned' || outcome.kind === 'deadline') return false;
      if (outcome.kind === 'scheduler-fault') {
        cleanupFault = true;
        return portFailure('LAUNCH_FAULT', 'SCHEDULER_FAULT', lastObserved, row);
      }
      const data = outcome.kind === 'fulfilled' ?
        (launch ? dataRecord(response, ['correlation', 'status', 't_ack_ms',
          'injected_process_id', 'error_code']) :
          dataRecord(response, ['correlation', 'kind', 'status', 't_ack_ms',
            'error_code'], ['injected_process_id'])) : null;
      const available = outcome.kind === 'fulfilled' ?
        availableOwnCorrelation(response) : null;
      const mismatch = available && !exactCorrelation(available, corr) ||
        data && !matchCorrelation(data, corr);
      response = null;
      if (mismatch) {
        row.status = 'FAULT';
        row.error_code = 'IDENTITY_CONFLICT';
        latchIdentityConflict(lastObserved,
          launch ? slot.firstIdentity?.injected_process_id ?? injectedProcessId :
            injectedProcessId);
      }
      const now = reconcileActiveCompletion(sampleClock(), row);
      if (stopStarted || terminalizing || lifecycleSummary) return false;
      if (mismatch) {
        beginStop('IDENTITY_CONFLICT', now ?? lastObserved);
        return false;
      }
      if (data && launch && slot.firstIdentity &&
          data.injected_process_id !== slot.firstIdentity.injected_process_id) {
        row.status = 'FAULT';
        return identityConflict(now ?? lastObserved,
          slot.firstIdentity.injected_process_id);
      }
      if (data && !launch && Object.hasOwn(data, 'injected_process_id') &&
          data.injected_process_id !== injectedProcessId) {
        row.status = 'FAULT';
        return identityConflict(now ?? lastObserved);
      }
      const boundedNow = data && responseTime(data.t_ack_ms, dispatchAt, row, now);
      if (stopStarted || terminalizing || lifecycleSummary) return false;
      if (!data || !validErrorCode(data.error_code) ||
          (!launch && data.kind !== kind) || boundedNow === null) {
        return portFailure(launch ? 'LAUNCH_FAULT' : 'ACTION_FAULT',
          launch ? 'LAUNCH_FAULT' : 'ACTION_FAULT', lastObserved, row);
      }
      if (data.status !== 'ACK') {
        const timedOut = data.status === 'TIMEOUT';
        return portFailure(timedOut ? 'PHASE_DEADLINE' :
          launch ? 'LAUNCH_FAULT' : 'ACTION_FAULT',
          statusErrorCode(data.error_code, timedOut ? 'PHASE_DEADLINE' :
            launch ? 'LAUNCH_FAULT' : 'ACTION_FAULT') ?? (timedOut ?
              'PHASE_DEADLINE' : launch ? 'LAUNCH_FAULT' : 'ACTION_FAULT'),
          now, row);
      }
      if (!successErrorCode(data.error_code)) {
        return portFailure(launch ? 'LAUNCH_FAULT' : 'ACTION_FAULT',
          launch ? 'LAUNCH_FAULT' : 'ACTION_FAULT', now, row);
      }
      if (launch) {
        if (!safeId(data.injected_process_id)) {
          return portFailure('LAUNCH_FAULT', 'LAUNCH_FAULT', now, row);
        }
        pendingLaunchIdentity = null;
        injectedProcessId = data.injected_process_id;
        row.status = 'ACK'; row.t_ack_ms = data.t_ack_ms;
        row.injected_process_id = injectedProcessId;
        row.error_code = null;
        addAudit('LAUNCH_ACK_RECEIVED', now, 'OK');
        state = 'F0_CAPTURING';
      } else {
        row.status = 'ACK'; row.t_ack_ms = data.t_ack_ms;
        row.error_code = null;
        addAudit('ACTION_ACK_RECEIVED', now, 'OK');
        state = phase === 'KEY_ACTION' ? 'F1_CAPTURING' : 'F2_CAPTURING';
      }
      activePhase = null;
      return true;
    }

    const capturePhase = phase === 'F0_CAPTURE' ? 'F0' :
      phase === 'F1_CAPTURE' ? 'F1' : 'F2';
    const corr = correlation(base, opId(phase));
    const request = Object.freeze({correlation: corr, phase: capturePhase,
      t_capture_ms: dispatchAt,
      timeout_ms: requestTimeout(dispatchAt, model.snapshot().phase_deadline_ms),
      injected_process_id: injectedProcessId});
    const row = {correlation: corr, phase: capturePhase, status: 'NOT_RUN',
      t_acquired_ms: null, predicate: 'NOT_RUN', error_code: null};
    summaries.captures.push(row);
    const slot = operationSlot(phase, corr, 'active', 'CAPTURE_FAULT');
    const outcome = await dispatchPromise(slot, ports.capturePort, request, 'captures', row,
    'CAPTURE_DISPATCHED');
    let response = takeResponse(slot);
    if (stopStarted || cancellationLatched) {
      response = null;
      if (outcome.kind === 'fulfilled') addAudit('LATE_OUTCOME_DISCARDED',
        lastObserved, 'IGNORED');
      return false;
    }
    if (outcome.kind === 'abandoned' || outcome.kind === 'deadline') return false;
    if (outcome.kind === 'scheduler-fault') {
      cleanupFault = true;
      return portFailure('CAPTURE_FAULT', 'SCHEDULER_FAULT', lastObserved, row);
    }
    const data = outcome.kind === 'fulfilled' && dataRecord(response,
      ['correlation', 'phase', 'status', 't_acquired_ms', 'buffer', 'error_code']);
    const available = outcome.kind === 'fulfilled' ?
      availableOwnCorrelation(response) : null;
    const mismatch = available && !exactCorrelation(available, corr) ||
      data && !matchCorrelation(data, corr);
    response = null;
    if (mismatch) {
      row.status = 'FAULT';
      row.error_code = 'IDENTITY_CONFLICT';
      latchIdentityConflict(lastObserved);
    }
    const doneAt = readCaptureCompletionTime(row);
    if (stopStarted || terminalizing || lifecycleSummary) {
      if (data) data.buffer = null;
      return false;
    }
    if (doneAt === null) {
      if (data) data.buffer = null;
      return false;
    }
    if (mismatch || !data || data.phase !== capturePhase ||
        !validErrorCode(data.error_code) ||
        (data.status === 'CAPTURED' && !successErrorCode(data.error_code))) {
      if (data) data.buffer = null;
      const reconciled = reconcileActiveCompletion({value: doneAt}, row);
      if (reconciled === null) return false;
      if (mismatch) {
        row.status = 'FAULT';
        row.error_code = 'IDENTITY_CONFLICT';
        beginStop('IDENTITY_CONFLICT', reconciled);
        return false;
      }
      return portFailure('CAPTURE_FAULT', 'CAPTURE_FAULT', reconciled, row);
    }
    if (!safeTime(data.t_acquired_ms) ||
        data.t_acquired_ms < dispatchAt ||
        data.t_acquired_ms > doneAt) {
      data.buffer = null;
      // The completion clock was already sampled. Reconcile it before
      // rejecting the acquisition time so an exceeded cap keeps its first stop.
      const reconciled = reconcileActiveCompletion({value: doneAt}, row);
      if (reconciled === null) return false;
      row.status = 'FAULT';
      row.error_code = 'INVALID_CLOCK';
      observeTime(NaN);
      if (!stopStarted) beginStop('INVALID_CLOCK', lastObserved);
      return false;
    }
    if (data.status !== 'CAPTURED') {
      // A fault or timeout is completed work for deadline accounting. Set the
      // deadline row before polling, since polling can start synchronous cleanup.
      const reconciled = reconcileActiveCompletion({value: doneAt}, row);
      if (reconciled === null || stopStarted) return false;
      const timeout = data.status === 'TIMEOUT';
      return portFailure(timeout ? 'PHASE_DEADLINE' : 'CAPTURE_FAULT',
        statusErrorCode(data.error_code, timeout ? 'PHASE_DEADLINE' :
          'CAPTURE_FAULT') ?? (timeout ? 'PHASE_DEADLINE' : 'CAPTURE_FAULT'),
        doneAt, row);
    }
    row.status = 'CAPTURED'; row.t_acquired_ms = data.t_acquired_ms;
    row.error_code = null;
    state = phase === 'F0_CAPTURE' ? 'F0_EVALUATING' :
      phase === 'F1_CAPTURE' ? 'F1_EVALUATING' : 'F2_EVALUATING';
    let evaluated;
    try {
      evaluated = model.acceptCandidate(data.buffer, data.t_acquired_ms, doneAt);
    } finally {
      data.buffer = null;
    }
    const snapshot = model.snapshot();
    lastObserved = snapshot.last_ms;
    row.predicate = snapshot.frames[CAPTURES.indexOf(capturePhase)];
    addAudit('CAPTURE_EVALUATED', doneAt,
      row.predicate === 'MATCH' ? 'MATCH' :
        snapshot.reason === 'BACKGROUND_DRIFT' ? 'DRIFT' : 'FAULT');
    if (snapshot.first_stop_ms !== null) {
      beginStop(modelStopReason(snapshot), snapshot.first_stop_ms, true);
      return evaluated.observation === 'BUFFER_SEQUENCE_MATCH';
    }
    if (row.predicate !== 'MATCH') {
      beginStop('PREDICATE_MISMATCH', doneAt, true);
      return false;
    }
    state = capturePhase === 'F0' ? 'KEY_RESERVING' :
      capturePhase === 'F1' ? 'CLICK_RESERVING' : 'STOPPED';
    activePhase = null;
    return true;
  }

  function normalizeSettlement(value, request, now) {
    const data = dataRecord(value, ['correlation', 'status', 't_observed_ms',
      'scope_observation', 'fenced_scope_descriptors', 'error_code']);
    if (!data || !matchCorrelation(data, request.correlation) ||
        !validErrorCode(data.error_code)) return null;
    const scope = dataRecord(data.scope_observation, ['launch_closed', 'scope_id',
      'coverage', 'live_count', 'conflicting_identities']);
    const conflicts = scope && boundedStrings(scope.conflicting_identities, 8);
    const descriptors = boundedStrings(data.fenced_scope_descriptors, 8);
    if (!scope || !conflicts || !descriptors ||
        typeof scope.launch_closed !== 'boolean' ||
        !(scope.scope_id === null || safeId(scope.scope_id)) ||
        !['FULL_INSPECTED', 'PARTIAL', 'UNINSPECTED'].includes(scope.coverage) ||
        !Number.isSafeInteger(scope.live_count) || scope.live_count < 0 ||
        !safeTime(data.t_observed_ms) || data.t_observed_ms < request.t_observe_ms ||
        data.t_observed_ms > now || !['OBSERVED_CLEAN', 'OBSERVED_NONEMPTY',
          'CONFLICTING_SCOPE', 'UNKNOWN'].includes(data.status)) return null;
    const contradictoryClean = data.status === 'OBSERVED_CLEAN' &&
      !successErrorCode(data.error_code);
    const unacknowledged = injectedProcessId === null;
    const matching = !unacknowledged &&
      request.expected_scope_id === injectedProcessId &&
      scope.scope_id === request.expected_scope_id && scope.launch_closed;
    const unsafeScope = !unacknowledged &&
      (!scope.launch_closed || scope.scope_id !== request.expected_scope_id ||
        scope.live_count > 0 || conflicts.length > 0);
    let status = 'UNKNOWN';
    if (matching && conflicts.length > 0 && data.status === 'CONFLICTING_SCOPE') {
      status = 'CONFLICTING_SCOPE';
    } else if (matching && scope.coverage === 'FULL_INSPECTED' &&
        scope.live_count > 0 && data.status === 'OBSERVED_NONEMPTY') {
      status = 'OBSERVED_NONEMPTY';
    } else if (matching && scope.coverage === 'FULL_INSPECTED' &&
        scope.live_count === 0 && conflicts.length === 0 &&
        data.status === 'OBSERVED_CLEAN' && !contradictoryClean) {
      status = 'OBSERVED_CLEAN';
    }
    // Unacknowledged observer metadata cannot be bound to this run. Preserve
    // the local fence marker, but do not return an unbound scope claim.
    return {status, unsafeScope, t_observed_ms: data.t_observed_ms,
      scope_observation: unacknowledged ? null : {
        launch_closed: scope.launch_closed,
        scope_id: scope.scope_id, coverage: scope.coverage,
        live_count: scope.live_count, conflicting_identities: conflicts},
      fenced_scope_descriptors: unacknowledged ?
        ['unacknowledged_launch_scope'] : descriptors,
      error_code: contradictoryClean ? 'SETTLEMENT_FAULT' :
        statusErrorCode(data.error_code, 'SETTLEMENT_FAULT')};
  }

  async function cleanupFlow() {
    if (cleanupDeadline === null || lastObserved >= cleanupDeadline) {
      summaries.settlement.status = 'UNKNOWN';
      completeSummary();
      return lifecycleSummary;
    }
    const cleanupAt = at => {
      if (cleanupExpired || terminalizing || lifecycleSummary) return null;
      if (!safeTime(at) || at < lastObserved) {
        observeTime(at);
        expireCleanup(lastObserved);
        return null;
      }
      const now = observeTime(at);
      if (now === null || cleanupExpired || terminalizing || lifecycleSummary) return null;
      return now;
    };
    const cleanupClock = () => {
      const at = readClock();
      if (cleanupExpired || terminalizing || lifecycleSummary) return null;
      return cleanupAt(at ?? NaN);
    };
    cleanupToken = scheduleToken(cleanupDeadline,
      at => onCleanupDeadline(cleanupDeadline, at));
    if (cleanupExpired || terminalizing || lifecycleSummary) {
      if (cleanupToken) cancelToken(cleanupToken);
      return lifecycleSummary;
    }
    if (!cleanupToken) {
      cleanupFault = true;
      summaries.stop.status = 'FAULT';
      summaries.stop.error_code = 'SCHEDULER_FAULT';
      summaries.settlement.status = 'UNKNOWN';
      summaries.settlement.error_code = 'SCHEDULER_FAULT';
      completeSummary();
      return lifecycleSummary;
    }
    const stopAt = model.snapshot().first_stop_ms ?? lastObserved;
    summaries.stop.t_stop_ms = stopAt;
    const stopRequest = Object.freeze({correlation: stopCorr,
      t_stop_ms: stopAt, reason: harnessStopReason,
      injected_process_id: injectedProcessId});
    state = 'STOPPED';
    const stopSlot = operationSlot('STOP', stopCorr, 'cleanup', 'STOP_FAULT');
    const stopOutcome = await dispatchPromise(stopSlot, ports.stopPort, stopRequest, 'stops',
    summaries.stop, 'STOP_DISPATCHED');
    let stopResponse = takeResponse(stopSlot);
    if (stopOutcome.kind !== 'fulfilled') stopResponse = null;
    if (lifecycleSummary) return lifecycleSummary;
    if (cleanupExpired) return completeSummary();
    let now = cleanupClock();
    if (identityConflictLatched &&
        summaries.stop.error_code === 'IDENTITY_CONFLICT') {
      stopResponse = null;
    } else if (stopOutcome.kind === 'fulfilled' && now !== null) {
      const data = dataRecord(stopResponse, ['correlation', 'status', 't_ack_ms',
        'direct_child_exit_observed', 'error_code']);
      stopResponse = null;
      if (data && !matchCorrelation(data, stopCorr)) {
        summaries.stop.status = 'FAULT';
        summaries.stop.error_code = 'IDENTITY_CONFLICT';
        identityConflict(now);
      } else if (data && validErrorCode(data.error_code) &&
          ['ACK', 'FAULT', 'TIMEOUT'].includes(data.status) &&
          typeof data.direct_child_exit_observed === 'boolean' &&
          safeTime(data.t_ack_ms) && data.t_ack_ms >= stopAt &&
          data.t_ack_ms <= now) {
        if (data.status === 'ACK' && !successErrorCode(data.error_code)) {
          summaries.stop.status = 'FAULT';
          summaries.stop.error_code = 'STOP_FAULT';
          cleanupFault = true;
          addAudit('STOP_ACK_RECEIVED', now, 'FAULT');
        } else {
          summaries.stop.status = data.status;
          summaries.stop.direct_child_exit_observed = data.direct_child_exit_observed;
          summaries.stop.error_code = statusErrorCode(data.error_code, 'STOP_FAULT');
          if (data.status !== 'ACK') cleanupFault = true;
          addAudit('STOP_ACK_RECEIVED', now, data.status === 'ACK' ? 'OK' : 'FAULT');
        }
      } else {
        summaries.stop.status = 'FAULT';
        summaries.stop.error_code = 'STOP_FAULT';
        cleanupFault = true;
      }
    } else if (!lifecycleSummary) {
      summaries.stop.status = stopOutcome.kind === 'deadline' ? 'TIMEOUT' : 'FAULT';
      summaries.stop.error_code = stopOutcome.kind === 'deadline' ?
        'CLEANUP_DEADLINE' : stopOutcome.kind === 'scheduler-fault' ?
          'SCHEDULER_FAULT' : 'STOP_FAULT';
      cleanupFault = true;
    }
    if (lifecycleSummary || cleanupExpired) return lifecycleSummary ?? completeSummary();
    now = cleanupClock();
    if (now === null || now >= cleanupDeadline) {
      expireCleanup(now ?? lastObserved);
      return lifecycleSummary;
    }
    state = 'SETTLING';
    const settlementRequest = Object.freeze({correlation: settlementCorr,
      t_observe_ms: now, cleanup_deadline_ms: cleanupDeadline,
      injected_process_id: injectedProcessId,
      // In SOURCE_SIMULATION the expected scope key is the acknowledged launch
      // identity. It is only a correlation check, never OS provenance.
      expected_scope_id: injectedProcessId});
    const settlementSlot = operationSlot('SETTLEMENT',
      settlementCorr, 'cleanup', 'SETTLEMENT_FAULT');
    const settlementOutcome = await dispatchPromise(settlementSlot, ports.settlementPort,
    settlementRequest, 'settlements', summaries.settlement,
    'SETTLEMENT_DISPATCHED');
    let settlementResponse = takeResponse(settlementSlot);
    if (settlementOutcome.kind !== 'fulfilled') settlementResponse = null;
    if (lifecycleSummary) return lifecycleSummary;
    if (cleanupExpired) return completeSummary();
    now = cleanupClock();
    if (settlementOutcome.kind === 'fulfilled' && now !== null) {
      const available = availableOwnCorrelation(settlementResponse);
      const mismatch = available && !exactCorrelation(available, settlementCorr);
      const result = mismatch ? null : normalizeSettlement(settlementResponse,
        settlementRequest, now);
      settlementResponse = null;
      if (mismatch) {
        identityConflict(now);
      } else if (identityConflictLatched) {
        addAudit('SETTLEMENT_OBSERVED', now, 'FENCED');
      } else if (result) {
        const {unsafeScope, ...observation} = result;
        Object.assign(summaries.settlement, observation);
        addAudit('SETTLEMENT_OBSERVED', now,
          result.status === 'OBSERVED_CLEAN' ? 'OK' :
            result.status === 'UNKNOWN' ? 'FENCED' : 'FAULT');
        if (unsafeScope || result.status === 'CONFLICTING_SCOPE' ||
            result.status === 'OBSERVED_NONEMPTY' ||
            (result.status === 'UNKNOWN' && injectedProcessId === null)) {
          fenceLocalScope();
          for (const descriptor of result.fenced_scope_descriptors) addFence(descriptor);
        }
        if (result.error_code && result.error_code !== 'NONE') cleanupFault = true;
      } else {
        summaries.settlement.status = 'UNKNOWN';
        summaries.settlement.error_code = 'SETTLEMENT_FAULT';
        cleanupFault = true;
      }
    } else if (!lifecycleSummary) {
      summaries.settlement.status = settlementOutcome.kind === 'deadline' ?
        'UNKNOWN' : 'UNKNOWN';
      summaries.settlement.error_code = settlementOutcome.kind === 'deadline' ?
        'CLEANUP_DEADLINE' : 'SETTLEMENT_FAULT';
      cleanupFault = settlementOutcome.kind !== 'deadline';
    }
    return completeSummary();
  }

  function startFromModel(at) {
    const snapshot = model.snapshot();
    if (snapshot.first_stop_ms !== null && !stopStarted) {
      beginStop(modelStopReason(snapshot), snapshot.first_stop_ms, true);
    } else if (snapshot.first_stop_ms === null && !stopStarted) {
      beginStop('CALLER_STOP', safeTime(at) ? at : lastObserved);
    }
  }
  function publicStep(phase, at_ms) {
    if (state === 'COMPLETED') throw codedError('HARNESS_ALREADY_COMPLETED');
    if (busy) throw codedError('CONCURRENT_DISPATCH_REJECTED');
    if (!phaseSet.has(phase)) throw codedError('UNEXPECTED_SEQUENCE');
    busy = true;
    return (async () => {
      try {
        if (phase === 'STOP' || phase === 'SETTLEMENT') {
          if (!stopStarted) {
            const at = dispatchTime(at_ms);
            startFromModel(at ?? lastObserved);
          }
          await (cleanupPromise ?? terminalPromise);
        } else {
          await runActivePhase(phase, at_ms);
          if (stopStarted) await (cleanupPromise ?? terminalPromise);
        }
        const status = state === 'COMPLETED' &&
          lifecycleSummary?.harness_status === 'COMPLETED' ? 'COMPLETED' :
          state === 'COMPLETED' && lifecycleSummary?.harness_status === 'FAULT' ?
            'FAULT' : stopStarted ? 'STOPPED' : 'COMPLETED';
        return immutable({correlation: correlation(base, opId(phase)),
          phase, status, snapshot: frozenSnapshot(),
          error_code: status === 'STOPPED' ?
            (harnessStopReason === 'PHASE_DEADLINE' ? 'PHASE_DEADLINE' :
              harnessStopReason === 'IDENTITY_CONFLICT' ? 'IDENTITY_CONFLICT' :
                'UNKNOWN') : status === 'FAULT' ? 'UNKNOWN' : null});
      } finally { busy = false; }
    })();
  }
  function driveLifecycle() {
    return (async () => {
      for (const phase of ['LAUNCH', 'F0_CAPTURE', 'KEY_ACTION',
        'F1_CAPTURE', 'CLICK_ACTION', 'F2_CAPTURE']) {
        if (stopStarted || state === 'COMPLETED') break;
        const ok = await runActivePhase(phase);
        if (!ok || stopStarted) break;
      }
      if (!stopStarted) startFromModel(lastObserved);
      await (cleanupPromise ?? terminalPromise);
      return lifecycleSummary;
    })().catch(() => {
      if (terminalizing || lifecycleSummary) return lifecycleSummary;
      cleanupFault = true;
      if (!stopStarted) beginStop('UNKNOWN', lastObserved);
      return (cleanupPromise ?? terminalPromise);
    });
  }
  function runLifecycle() {
    if (state === 'COMPLETED') throw codedError('HARNESS_ALREADY_COMPLETED');
    if (busy) throw codedError('CONCURRENT_DISPATCH_REJECTED');
    if (runStarted) throw codedError('HARNESS_ALREADY_COMPLETED');
    runStarted = true; busy = true;
    const run = driveLifecycle();
    run.finally(() => { busy = false; }).catch(() => undefined);
    return run;
  }
  function poll(at_ms) {
    if (state === 'COMPLETED') throw codedError('HARNESS_ALREADY_COMPLETED');
    const snapshot = model.poll(at_ms);
    lastObserved = snapshot.last_ms;
    if (snapshot.first_stop_ms !== null) {
      if (!stopStarted) beginStop(modelStopReason(snapshot), snapshot.first_stop_ms, true);
      else if (cleanupDeadline !== null && safeTime(at_ms) && at_ms >= cleanupDeadline) {
        expireCleanup(at_ms);
      }
    }
    return frozenSnapshot();
  }
  function deliverDeadline(at_ms) {
    if (state === 'COMPLETED') throw codedError('HARNESS_ALREADY_COMPLETED');
    if (cleanupDeadline !== null && safeTime(at_ms) && at_ms >= cleanupDeadline) {
      addAudit('DEADLINE_DELIVERED', at_ms, 'TIMEOUT');
      expireCleanup(at_ms);
    } else if (activeSlot && activeSlot.state === 'PENDING') {
      onActiveDeadline(activeSlot, at_ms);
    } else {
      addAudit('DEADLINE_DELIVERED',
        safeTime(at_ms) ? at_ms : lastObserved, 'IGNORED');
      const snapshot = model.poll(at_ms);
      lastObserved = snapshot.last_ms;
      if (snapshot.first_stop_ms !== null && !stopStarted) {
        beginStop(modelStopReason(snapshot), snapshot.first_stop_ms, true);
      }
    }
    return (cleanupPromise ?? Promise.resolve()).then(() => frozenSnapshot());
  }
  function abort(reason, at_ms) {
    if (state === 'COMPLETED') throw codedError('HARNESS_ALREADY_COMPLETED');
    if (!reasonSet.has(reason)) throw codedError('UNKNOWN');
    if (cancellationLatched) return terminalPromise;
    cancellationLatched = true;
    addAudit('ABORT_LATCHED', safeTime(at_ms) ? at_ms : lastObserved, 'OK');
    if (stopStarted) return terminalPromise;
    // An active response can expose a wrong correlation before its completion
    // clock reenters abort. Cancellation must not erase that detected conflict.
    const stopReason = identityConflictLatched ?
      'IDENTITY_CONFLICT' : 'CALLER_ABORT';
    harnessStopReason = stopReason;
    const eventTime = safeTime(at_ms) && at_ms >= lastObserved ? at_ms : lastObserved;
    const before = model.snapshot();
    if (before.first_stop_ms === null) model.stop(eventTime);
    lastObserved = model.snapshot().last_ms;
    if (model.snapshot().first_stop_ms !== null) {
      beginStop(stopReason, model.snapshot().first_stop_ms, true);
    } else beginStop(stopReason, eventTime);
    return terminalPromise;
  }

  addAudit('HARNESS_CREATED', input.t0_ms, 'OK');
  return Object.freeze({
    runLifecycle,
    step: publicStep,
    poll,
    deliverDeadline,
    abort,
    getSnapshot: frozenSnapshot,
  });
}
