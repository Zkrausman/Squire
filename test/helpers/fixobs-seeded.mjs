import {types} from 'node:util';
import {FIXOBS} from '../../src/fixobs.mjs';
import {
  createFixobsLifecycleHarness,
  FIXOBS_HARNESS_ENUMS,
} from '../../src/fixobs-port.mjs';

export const GRAMMAR_VERSION = 'SQUIRE_SEEDED_TEST_GRAMMAR_ORACLE_V5';
export const SEEDS = Object.freeze(Array.from({length: 32}, (_, index) => index + 1));
export const LIMITS = Object.freeze({
  commands: 50,
  drains: 16,
  snapshotReads: 2,
});

const BASE = Object.freeze({
  run_id: 'seeded-run',
  job_id: 'seeded-job',
  generation_id: 'seeded-generation',
});
const OP_IDS = Object.freeze({
  LAUNCH: 'op_launch_0',
  F0_CAPTURE: 'op_capture_F0',
  KEY_ACTION: 'op_action_SPACE',
  F1_CAPTURE: 'op_capture_F1',
  CLICK_ACTION: 'op_action_BUTTON1',
  F2_CAPTURE: 'op_capture_F2',
  STOP: 'op_stop_0',
  SETTLEMENT: 'op_settlement_0',
});
const ACTIVE_IDS = Object.freeze([
  OP_IDS.LAUNCH, OP_IDS.F0_CAPTURE, OP_IDS.KEY_ACTION,
  OP_IDS.F1_CAPTURE, OP_IDS.CLICK_ACTION, OP_IDS.F2_CAPTURE,
]);
const NEXT_PHASE = Object.freeze({
  CREATED: 'LAUNCH',
  F0_CAPTURING: 'F0_CAPTURE',
  KEY_RESERVING: 'KEY_ACTION',
  F1_CAPTURING: 'F1_CAPTURE',
  CLICK_RESERVING: 'CLICK_ACTION',
  F2_CAPTURING: 'F2_CAPTURE',
});
const COUNTERS = Object.freeze({
  LAUNCH: 'launches',
  F0_CAPTURE: 'captures',
  KEY_ACTION: 'actions',
  F1_CAPTURE: 'captures',
  CLICK_ACTION: 'actions',
  F2_CAPTURE: 'captures',
  STOP: 'stops',
  SETTLEMENT: 'settlements',
});
const CAPS = Object.freeze({
  launches: 1, actions: 2, captures: 3, stops: 1, settlements: 1,
});
const RESERVATION_CAPS = Object.freeze({
  launches: 1, logical_keys: 1, logical_clicks: 1, capture_attempts: 3,
});
const CODES = new Set([
  'COMMAND_BUDGET', 'DRIVER_EXCEPTION', 'DRIVER_MISSING_PENDING',
  'DRIVER_MISSING_DEADLINE', 'UNSETTLED_HARNESS', 'UNSETTLED_PUBLIC_PROMISE',
  'MISSING_SUMMARY', 'LEDGER_MISMATCH', 'CALL_CAP', 'CALL_REFUND',
  'ACTIVE_AFTER_STOP', 'DISPATCH_AFTER_COMPLETE', 'MODEL_DEADLINE',
  'FIRST_STOP_CHANGED', 'RESERVATION_CAP', 'RESERVATION_REFUND',
  'CANCELLATION_UNLATCHED', 'OLD_SNAPSHOT_CHANGED', 'SNAPSHOT_NOT_FROZEN',
  'TERMINAL_PROJECTION_CHANGED', 'PUBLIC_SHAPE', 'PUBLIC_ENUM',
  'PUBLIC_CORRELATION', 'PUBLIC_RAW_DATA', 'PUBLIC_PROOF_FLAG',
  'TERMINAL_PENDING_ROW', 'CLEAN_SCOPE', 'N7_MODEL_CLOCK',
  'LATE_IDENTITY_NOT_FENCED', 'INVALID_STEP_ACCEPTED',
  'INVALID_STEP_MUTATED', 'MALFORMED_PROMOTED',
  'SUCCESS_PROVENANCE', 'CLOCK_CHOICE_INELIGIBLE',
]);
const traceFailures = new WeakSet();

export function isOracleFailure(value) {
  return value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    traceFailures.has(value);
}

export function xorshift32(seed) {
  if (!Number.isInteger(seed) || seed < 1 || seed > 32) throw new TypeError('seed');
  let word = seed >>> 0;
  return () => {
    word ^= word << 13;
    word ^= word >>> 17;
    word ^= word << 5;
    return word >>> 0;
  };
}

export function choose(next, choices) {
  if (choices.length === 0) throw new TypeError('empty choices');
  return choices[next() % choices.length];
}

export function encodeTrace(trace) {
  return JSON.stringify(trace);
}

export function checkLedger(actual, ledger) {
  return Object.keys(CAPS).every(key => actual[key] === ledger[key]) ?
    null : 'LEDGER_MISMATCH';
}

function terminalProjection(snapshot) {
  return JSON.stringify({
    harness_state: snapshot.harness_state,
    model_snapshot: snapshot.model_snapshot,
    actual_port_calls: snapshot.actual_port_calls,
    last_observed_ms: snapshot.last_observed_ms,
    cancellation_latched: snapshot.cancellation_latched,
  });
}

// The failure writer reads own data descriptors only. Every copied string is
// selected from a fixed vocabulary; every number has a fixed public bound.
function ownData(value, key) {
  if (value === null || typeof value !== 'object' || types.isProxy(value))
    return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ?
      descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

const MODEL_PHASES = Object.freeze([
  'LAUNCH', 'F0', 'KEY', 'F1', 'CLICK', 'F2', 'STOPPED',
]);
const MODEL_REASONS = Object.freeze([
  'CALLER_STOP', 'INVALID_CLOCK', 'PHASE_DEADLINE',
  'UNEXPECTED_SEQUENCE', 'THREE_BUFFER_PREDICATES_MATCH',
  'INVALID_CANONICAL_BUFFER', 'NONOPAQUE_PIXEL', 'CORE_MISMATCH',
  'BACKGROUND_MISMATCH', 'BACKGROUND_DRIFT', 'NO_VISUAL_DELTA',
]);
const FRAME_VALUES = Object.freeze(['NOT_RUN', 'MATCH', 'UNKNOWN']);
const COMMAND_ENUMS = Object.freeze({
  op: ['STEP', 'SET_TIME', 'POLL', 'DELIVER_DEADLINE',
    'SETTLE_PENDING', 'REJECT_PENDING', 'DUPLICATE_LAUNCH',
    'ABORT', 'ARM_REENTRY', 'TRY_INVALID_STEP'],
  choice: ['CURRENT', 'PLUS_1', 'PLUS_100', 'PHASE_CAP',
    'PHASE_CAP_PLUS_1', 'CLEANUP_CAP', 'EARLY_TARGET_MINUS_1',
    'EXACT_TARGET', 'LATER_BOUNDED'],
  slot: ['ACTIVE', 'CLEANUP'],
  form: ['SUCCESS', 'FAULT', 'FAULT_CODE_SUCCESS',
    'WRONG_CORRELATION', 'MISSING_FIELD', 'EXTRA_FIELD'],
  event_time: ['DISPATCH', 'BETWEEN_DISPATCH_COMPLETION',
    'BEFORE_DISPATCH', 'AFTER_COMPLETION'],
  frame: ['S0', 'S1', 'S2', 'INVALID_SHORT'],
  kind: ['MATCH', 'CONFLICTING_PID', 'WRONG_CORRELATION',
    'MALFORMED_UNRELATED'],
  reason: ['CALLER_STOP', 'CALLER_ABORT'],
  site: ['CLOCK', 'SCHEDULER_REGISTER', 'TOKEN_CANCEL'],
  action: ['ABORT', 'DELIVER_DEADLINE', 'POLL'],
});
const boundedEnum = (value, choices) =>
  typeof value === 'string' && choices.includes(value) ? value : null;
const boundedTime = value =>
  Number.isSafeInteger(value) && value >= 0 && value <= 61000 ? value : null;
const boundedCount = (value, cap) =>
  Number.isSafeInteger(value) && value >= 0 && value <= cap ? value : null;

function boundedArrayLength(value, cap) {
  if (value === null || typeof value !== 'object' ||
      types.isProxy(value) || !Array.isArray(value)) return null;
  return boundedCount(ownData(value, 'length'), cap);
}

function traceCommand(value) {
  const record = {op: boundedEnum(ownData(value, 'op'), COMMAND_ENUMS.op)};
  for (const [key, choices] of Object.entries(COMMAND_ENUMS)) {
    if (key === 'op') continue;
    const field = ownData(value, key);
    if (field !== undefined) record[key] = boundedEnum(field, choices);
  }
  const phase = ownData(value, 'phase');
  if (phase !== undefined)
    record.phase = FIXOBS_HARNESS_ENUMS.phases.includes(phase) ||
      phase === 'constructor' || phase === 'PRIVATE_FIXED_INVALID' ||
      phase === 42 || phase === null ? phase : null;
  for (const key of ['at', 'value', 'event_ms']) {
    const field = ownData(value, key);
    if (field !== undefined) record[key] = boundedTime(field);
  }
  const nested = ownData(value, 'nested');
  if (nested !== undefined)
    record.nested = typeof nested === 'boolean' ? nested : null;
  return record;
}

function traceProjection(snapshot) {
  if (snapshot === null || snapshot === undefined) return null;
  const model = ownData(snapshot, 'model_snapshot');
  const frames = ownData(model, 'frames');
  const reservations = ownData(model, 'modeled_reservations');
  const calls = ownData(snapshot, 'actual_port_calls');
  const owner = ownData(snapshot, 'retained_owner_state');
  return {
    harness_state: boundedEnum(ownData(snapshot, 'harness_state'),
      FIXOBS_HARNESS_ENUMS.states),
    model_phase: boundedEnum(ownData(model, 'phase'), MODEL_PHASES),
    model_reason: boundedEnum(ownData(model, 'reason'), MODEL_REASONS),
    first_stop_ms: boundedTime(ownData(model, 'first_stop_ms')),
    cleanup_deadline_ms: boundedTime(
      ownData(model, 'cleanup_deadline_ms')),
    last_ms: boundedTime(ownData(model, 'last_ms')),
    frames: [0, 1, 2].map(index =>
      boundedEnum(ownData(frames, String(index)), FRAME_VALUES)),
    modeled_reservations: Object.fromEntries(
      Object.entries(RESERVATION_CAPS).map(([key, cap]) =>
        [key, boundedCount(ownData(reservations, key), cap)])),
    actual_port_calls: Object.fromEntries(
      Object.entries(CAPS).map(([key, cap]) =>
        [key, boundedCount(ownData(calls, key), cap)])),
    orphan_count: boundedArrayLength(
      ownData(owner, 'orphaned_injected_process_ids'), 8),
    fence_count: boundedArrayLength(ownData(owner, 'fenced_scopes'), 8),
  };
}

export function oracleFailureTrace(code, snapshot, seed, commands) {
  const length = boundedArrayLength(commands, LIMITS.commands);
  const safeCommands = [];
  if (length !== null)
    for (let index = 0; index < length; index++)
      safeCommands.push(traceCommand(ownData(commands, String(index))));
  return encodeTrace({
    schema: 'squire.fixobs.seeded_trace.v1',
    grammar_version: GRAMMAR_VERSION,
    seed: Number.isInteger(seed) && seed >= 1 && seed <= 32 ? seed : null,
    command_index: Math.max(0, safeCommands.length - 1),
    commands: safeCommands,
    invariant_code: CODES.has(code) ? code : 'DRIVER_EXCEPTION',
    last_bounded_snapshot_projection: traceProjection(snapshot),
  });
}

function rawDataIn(value, seen = new Set()) {
  if (typeof value === 'function') return true;
  if (value === null || typeof value !== 'object') return false;
  if (types.isProxy(value) || types.isNativeError(value) ||
      types.isAnyArrayBuffer(value) || ArrayBuffer.isView(value))
    return true;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (!Array.isArray(value) &&
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) return true;
    return Reflect.ownKeys(value).some(key => {
      if (typeof key !== 'string' ||
          /^(buffer|stack|cause|message)$/i.test(key)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor || !Object.hasOwn(descriptor, 'value') ||
        rawDataIn(descriptor.value, seen);
    });
  } catch {
    return true;
  }
}

function frozenTree(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return true;
  if (types.isProxy(value)) return false;
  seen.add(value);
  try {
    return Object.isFrozen(value) &&
      Reflect.ownKeys(value).every(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && Object.hasOwn(descriptor, 'value') &&
          frozenTree(descriptor.value, seen);
      });
  } catch {
    return false;
  }
}

function proofFlags(value) {
  return ['runtime_admitted', 'qualified_observation', 'custody_established',
    'process_ceiling_enforced', 'benchmark_pass']
    .every(key => !Object.hasOwn(value, key) || value[key] === false);
}

export function checkTransition(before, after, ledger) {
  if (rawDataIn(after)) return 'PUBLIC_RAW_DATA';
  if (!frozenTree(after)) return 'SNAPSHOT_NOT_FROZEN';
  if (checkLedger(after.actual_port_calls, ledger)) return 'LEDGER_MISMATCH';
  const a = before.model_snapshot;
  const b = after.model_snapshot;
  if (b.t0_ms !== 1000 || b.active_deadline_ms !== 31000 ||
      b.total_deadline_ms !== 61000 ||
      (b.first_stop_ms === null) !== (b.cleanup_deadline_ms === null) ||
      (b.first_stop_ms !== null &&
        b.cleanup_deadline_ms !== Math.min(61000, b.first_stop_ms + 30000)))
    return 'MODEL_DEADLINE';
  if (a.first_stop_ms !== null && b.first_stop_ms !== a.first_stop_ms)
    return 'FIRST_STOP_CHANGED';
  if (a.first_stop_ms !== null &&
      ['launches', 'actions', 'captures'].some(key =>
        after.actual_port_calls[key] !== before.actual_port_calls[key]))
    return 'ACTIVE_AFTER_STOP';
  if (before.harness_state === 'COMPLETED' &&
      Object.keys(CAPS).some(key =>
        after.actual_port_calls[key] !== before.actual_port_calls[key]))
    return 'DISPATCH_AFTER_COMPLETE';
  for (const [key, cap] of Object.entries(CAPS)) {
    if (after.actual_port_calls[key] > cap) return 'CALL_CAP';
    if (after.actual_port_calls[key] < before.actual_port_calls[key])
      return 'CALL_REFUND';
  }
  for (const [key, cap] of Object.entries(RESERVATION_CAPS)) {
    if (b.modeled_reservations[key] > cap) return 'RESERVATION_CAP';
    if (b.modeled_reservations[key] < a.modeled_reservations[key])
      return 'RESERVATION_REFUND';
  }
  if (before.cancellation_latched && !after.cancellation_latched)
    return 'CANCELLATION_UNLATCHED';
  if (!FIXOBS_HARNESS_ENUMS.states.includes(after.harness_state) ||
      (b.first_stop_ms !== null &&
        !['STOPPED', 'SETTLING', 'COMPLETED'].includes(after.harness_state)))
    return 'PUBLIC_ENUM';
  if (!proofFlags(b)) return 'PUBLIC_PROOF_FLAG';
  if (before.harness_state === 'COMPLETED' &&
      terminalProjection(before) !== terminalProjection(after))
    return 'TERMINAL_PROJECTION_CHANGED';
  return null;
}

function exactCorrelation(value, operationId) {
  return value && Object.keys(value).sort().join(',') ===
      'generation_id,job_id,operation_id,run_id' &&
    value.run_id === BASE.run_id && value.job_id === BASE.job_id &&
    value.generation_id === BASE.generation_id &&
    value.operation_id === operationId;
}

export function possibleOwnLaunchPid(value) {
  return value?.status === 'ACK' &&
    exactCorrelation(value.correlation, OP_IDS.LAUNCH) &&
    typeof value.injected_process_id === 'string' &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(value.injected_process_id) ?
      value.injected_process_id : null;
}

export function validFirstLaunchAckPid(value, dispatchAt, completionAt) {
  const pid = possibleOwnLaunchPid(value);
  return pid !== null &&
    Object.keys(value).sort().join(',') ===
      'correlation,error_code,injected_process_id,status,t_ack_ms' &&
    Number.isSafeInteger(dispatchAt) && dispatchAt >= 0 &&
    Number.isSafeInteger(completionAt) && completionAt >= dispatchAt &&
    Number.isSafeInteger(value.t_ack_ms) &&
    value.t_ack_ms >= dispatchAt && value.t_ack_ms <= completionAt &&
    (value.error_code === null || value.error_code === 'NONE') ?
      pid : null;
}

export function checkSummary(summary, snapshot, ledger, operationLedger) {
  if (rawDataIn(summary)) return 'PUBLIC_RAW_DATA';
  if (!summary || summary.schema !== 'squire.fixobs.lifecycle_harness_summary.v2' ||
      summary.mode !== 'SOURCE_SIMULATION' ||
      !['COMPLETED', 'STOPPED', 'FAULT'].includes(summary.harness_status) ||
      !summary.model_snapshot || !summary.actual_port_calls ||
      !summary.ports_summary)
    return 'PUBLIC_SHAPE';
  if (!frozenTree(summary)) return 'SNAPSHOT_NOT_FROZEN';
  if (!proofFlags(summary) || !proofFlags(summary.model_snapshot))
    return 'PUBLIC_PROOF_FLAG';
  if (checkLedger(summary.actual_port_calls, ledger)) return 'LEDGER_MISMATCH';
  if (operationLedger.invalid) return 'PUBLIC_CORRELATION';
  const invoked = operationLedger.counts;
  if (Object.values(OP_IDS).some(id => invoked[id] > 1))
    return 'LEDGER_MISMATCH';
  if (checkLedger({
    launches: invoked[OP_IDS.LAUNCH],
    actions: invoked[OP_IDS.KEY_ACTION] + invoked[OP_IDS.CLICK_ACTION],
    captures: invoked[OP_IDS.F0_CAPTURE] + invoked[OP_IDS.F1_CAPTURE] +
      invoked[OP_IDS.F2_CAPTURE],
    stops: invoked[OP_IDS.STOP],
    settlements: invoked[OP_IDS.SETTLEMENT],
  }, ledger)) return 'LEDGER_MISMATCH';
  const model = summary.model_snapshot;
  const canonicalSuccess =
    model.observation === 'BUFFER_SEQUENCE_MATCH' &&
    model.reason === 'THREE_BUFFER_PREDICATES_MATCH' &&
    Array.isArray(model.frames) && model.frames.length === 3 &&
    model.frames.every(frame => frame === 'MATCH') &&
    model.modeled_reservations?.launches === 1 &&
    model.modeled_reservations.logical_keys === 1 &&
    model.modeled_reservations.logical_clicks === 1 &&
    model.modeled_reservations.capture_attempts === 3;
  if (summary.harness_status === 'COMPLETED' &&
      (!canonicalSuccess ||
       summary.harness_stop_reason !== 'THREE_BUFFER_PREDICATES_MATCH' ||
       ACTIVE_IDS.some(id => invoked[id] !== 1)))
    return 'SUCCESS_PROVENANCE';
  if (summary.harness_status === 'STOPPED' && canonicalSuccess)
    return 'SUCCESS_PROVENANCE';
  if (JSON.stringify(summary.model_snapshot) !==
      JSON.stringify(snapshot.model_snapshot)) return 'TERMINAL_PROJECTION_CHANGED';
  if (summary.correlation.run_id !== BASE.run_id ||
      summary.correlation.job_id !== BASE.job_id ||
      summary.correlation.generation_id !== BASE.generation_id ||
      Object.keys(summary.correlation).length !== 3)
    return 'PUBLIC_CORRELATION';
  if (summary.harness_stop_reason !== null &&
      !FIXOBS_HARNESS_ENUMS.stopReasons.includes(summary.harness_stop_reason))
    return 'PUBLIC_ENUM';
  const ports = summary.ports_summary;
  if (!ports || ports.actions.length > 2 || ports.captures.length > 3 ||
      !exactCorrelation(ports.launch.correlation, OP_IDS.LAUNCH) ||
      !exactCorrelation(ports.stop.correlation, OP_IDS.STOP) ||
      !exactCorrelation(ports.settlement.correlation, OP_IDS.SETTLEMENT))
    return 'PUBLIC_CORRELATION';
  const rows = [
    [ports.launch, ['NOT_RUN', 'ACK', 'FAULT', 'TIMEOUT']],
    ...ports.actions.map(row => [row, ['NOT_RUN', 'ACK', 'FAULT', 'TIMEOUT']]),
    ...ports.captures.map(row =>
      [row, ['NOT_RUN', 'CAPTURED', 'FAULT', 'TIMEOUT']]),
    [ports.stop, ['NOT_RUN', 'ACK', 'FAULT', 'TIMEOUT']],
    [ports.settlement, ['NOT_RUN', 'OBSERVED_CLEAN', 'OBSERVED_NONEMPTY',
      'CONFLICTING_SCOPE', 'UNKNOWN']],
  ];
  for (const [row, statuses] of rows) {
    if (row.status === 'PENDING') return 'TERMINAL_PENDING_ROW';
    if (!statuses.includes(row.status) ||
        (row.error_code !== null &&
          !FIXOBS_HARNESS_ENUMS.errors.includes(row.error_code)))
      return 'PUBLIC_ENUM';
    if (['ACK', 'CAPTURED', 'OBSERVED_CLEAN'].includes(row.status) &&
        row.error_code !== null && row.error_code !== 'NONE')
      return 'PUBLIC_ENUM';
  }
  // completeSummary maps cleanupFault to FAULT. Settlement status alone does
  // not set that flag; its non-NONE error code does.
  const faultCode = code => code !== null && code !== 'NONE';
  const visibleCleanupFault =
    ['FAULT', 'TIMEOUT'].includes(ports.stop.status) ||
    faultCode(ports.stop.error_code) ||
    faultCode(ports.settlement.error_code);
  if (canonicalSuccess &&
      ((summary.harness_status === 'COMPLETED' && visibleCleanupFault) ||
       (summary.harness_status === 'FAULT' && !visibleCleanupFault)))
    return 'SUCCESS_PROVENANCE';
  if (ports.launch.status === 'NOT_RUN') {
    if (invoked[OP_IDS.LAUNCH] !== 0 || ports.launch.t_ack_ms !== null ||
        ports.launch.injected_process_id !== null ||
        ports.launch.error_code !== null) return 'PUBLIC_ENUM';
  } else if (ports.launch.status === 'ACK' &&
             invoked[OP_IDS.LAUNCH] !== 1) {
    return 'PUBLIC_ENUM';
  }
  if (ports.stop.status === 'NOT_RUN') {
    if (invoked[OP_IDS.STOP] !== 0 || ports.stop.t_stop_ms !== null ||
        ports.stop.direct_child_exit_observed !== false ||
        ports.stop.error_code !== null) return 'PUBLIC_ENUM';
  } else if (ports.stop.status === 'ACK' &&
             invoked[OP_IDS.STOP] !== 1) {
    return 'PUBLIC_ENUM';
  }
  if (ports.settlement.status === 'NOT_RUN') {
    if (invoked[OP_IDS.SETTLEMENT] !== 0 ||
        ports.settlement.t_observed_ms !== null ||
        ports.settlement.scope_observation !== null ||
        !Array.isArray(ports.settlement.fenced_scope_descriptors) ||
        ports.settlement.fenced_scope_descriptors.length !== 0 ||
        ports.settlement.error_code !== null) return 'PUBLIC_ENUM';
  } else if (['OBSERVED_CLEAN', 'OBSERVED_NONEMPTY',
    'CONFLICTING_SCOPE'].includes(ports.settlement.status) &&
    invoked[OP_IDS.SETTLEMENT] !== 1) {
    return 'PUBLIC_ENUM';
  }
  const actionPhases = new Set();
  for (const row of ports.actions) {
    const phase = row.kind === 'SPACE_STROKE' ? 'KEY_ACTION' :
      row.kind === 'BUTTON1_CENTER_STROKE' ? 'CLICK_ACTION' : null;
    if (!phase || !exactCorrelation(row.correlation, OP_IDS[phase]))
      return 'PUBLIC_CORRELATION';
    if (actionPhases.has(phase)) return 'PUBLIC_SHAPE';
    actionPhases.add(phase);
    const calls = invoked[OP_IDS[phase]];
    if (row.status === 'NOT_RUN') {
      if (calls !== 0 || row.t_ack_ms !== null || row.error_code !== null)
        return 'PUBLIC_ENUM';
    } else if (calls === 0 && row.status === 'ACK') {
      return 'PUBLIC_ENUM';
    }
  }
  const capturePhases = new Set();
  for (const row of ports.captures) {
    const phase = `${row.phase}_CAPTURE`;
    if (!OP_IDS[phase] || !exactCorrelation(row.correlation, OP_IDS[phase]))
      return 'PUBLIC_CORRELATION';
    if (capturePhases.has(phase)) return 'PUBLIC_SHAPE';
    capturePhases.add(phase);
    const calls = invoked[OP_IDS[phase]];
    if (row.status === 'NOT_RUN') {
      if (calls !== 0 || row.t_acquired_ms !== null ||
          row.predicate !== 'NOT_RUN' || row.error_code !== null)
        return 'PUBLIC_ENUM';
    } else if (calls === 0 && row.status === 'CAPTURED') {
      return 'PUBLIC_ENUM';
    }
  }
  for (const phase of ['KEY_ACTION', 'CLICK_ACTION'])
    if (invoked[OP_IDS[phase]] === 1 && !actionPhases.has(phase))
      return 'PUBLIC_SHAPE';
  for (const phase of ['F0_CAPTURE', 'F1_CAPTURE', 'F2_CAPTURE'])
    if (invoked[OP_IDS[phase]] === 1 && !capturePhases.has(phase))
      return 'PUBLIC_SHAPE';
  if (ports.settlement.status === 'OBSERVED_CLEAN') {
    const scope = ports.settlement.scope_observation;
    if (ports.launch.status !== 'ACK' || !scope ||
        scope.scope_id !== ports.launch.injected_process_id ||
        scope.launch_closed !== true || scope.coverage !== 'FULL_INSPECTED' ||
        scope.live_count !== 0 || scope.conflicting_identities.length !== 0)
      return 'CLEAN_SCOPE';
  }
  if (summary.harness_stop_reason === 'IDENTITY_CONFLICT' &&
      (ports.settlement.status !== 'UNKNOWN' ||
        ports.settlement.scope_observation !== null))
    return 'CLEAN_SCOPE';
  if (summary.retained_owner_state.orphaned_injected_process_ids.length > 8 ||
      summary.retained_owner_state.fenced_scopes.length > 8 ||
      summary.retained_owner_state.abandoned_operations.length > 8 ||
      summary.audit_events.length > 48) return 'PUBLIC_SHAPE';
  if (summary.audit_events.some(item =>
    !FIXOBS_HARNESS_ENUMS.auditEvents.includes(item.event) ||
    !FIXOBS_HARNESS_ENUMS.details.includes(item.detail_code)))
    return 'PUBLIC_ENUM';
  return null;
}

function frame(state) {
  if (state === 'INVALID_SHORT') return new Uint8Array([67, 68, 69]);
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

const settle = (form = 'SUCCESS', event_time = 'DISPATCH', frameName = 'S0',
  slot = 'ACTIVE') => ({op: 'SETTLE_PENDING', slot, form, event_time,
    frame: frameName});

function scripted(seed) {
  const launch = {op: 'STEP', phase: 'LAUNCH'};
  const goodLaunch = settle();
  const scripts = {
    17: [launch, {op: 'SET_TIME', choice: 'PLUS_100'},
      {op: 'POLL'}, goodLaunch],
    18: [launch, goodLaunch, {op: 'STEP', phase: 'F0_CAPTURE'},
      {op: 'SET_TIME', choice: 'PLUS_100'}, {op: 'POLL'}, settle()],
    19: [launch, {op: 'DELIVER_DEADLINE', choice: 'EARLY_TARGET_MINUS_1'},
      goodLaunch],
    20: [launch, {op: 'DELIVER_DEADLINE', choice: 'EXACT_TARGET'}],
    21: [launch, {op: 'ARM_REENTRY', site: 'CLOCK', action: 'ABORT'},
      goodLaunch],
    22: [launch, settle('WRONG_CORRELATION')],
    23: [launch, {op: 'REJECT_PENDING', slot: 'ACTIVE'}],
    24: [{op: 'TRY_INVALID_STEP', phase: 'constructor'}, launch],
  };
  return scripts[seed] ?? [];
}

function setTimeValue(choice, now, model) {
  const cap = model.phase_deadline_ms;
  return ({
    CURRENT: now,
    PLUS_1: Math.min(61000, now + 1),
    PLUS_100: Math.min(61000, now + 100),
    PHASE_CAP: cap ?? now,
    PHASE_CAP_PLUS_1: cap === null ? now : Math.min(61000, cap + 1),
    CLEANUP_CAP: model.cleanup_deadline_ms ?? now,
  })[choice];
}

export function eligibleSetTimeChoices(now, model, choices) {
  return choices.filter(choice => {
    const value = setTimeValue(choice, now, model);
    return Number.isSafeInteger(value) && value >= now && value <= 61000;
  });
}

export async function runSeed(seed) {
  const next = xorshift32(seed);
  const script = scripted(seed);
  const commands = [];
  const pending = [];
  const scheduled = new Map();
  const ledger = {launches: 0, actions: 0, captures: 0, stops: 0, settlements: 0};
  const operationLedger = {
    counts: Object.fromEntries(Object.values(OP_IDS).map(id => [id, 0])),
    invalid: false,
  };
  const oldSnapshots = [];
  const inflight = new Set();
  let now = 1000;
  let serial = 0;
  let harness;
  let last = null;
  let summary = null;
  let summaryArmed = false;
  let stepOpen = 0;
  let armed = null;
  let inReentry = false;
  let nestedFailure = null;
  let launchEmit = null;
  let launchRequest = null;
  let launchFirstAckPid = null;
  let launchWasAbandoned = false;
  let n7Checks = 0;

  function fail(code, snapshot = last) {
    const failure = new Error(
      oracleFailureTrace(code, snapshot, seed, commands));
    traceFailures.add(failure);
    throw failure;
  }

  function track(promise, kind) {
    const ticket = {kind};
    inflight.add(ticket);
    if (kind === 'STEP') stepOpen++;
    Promise.resolve(promise).then(value => {
      inflight.delete(ticket);
      if (kind === 'STEP') stepOpen--;
      if (value?.schema === 'squire.fixobs.lifecycle_harness_summary.v2')
        summary = value;
    }, () => {
      inflight.delete(ticket);
      if (kind === 'STEP') stepOpen--;
      nestedFailure = 'PUBLIC_SHAPE';
    });
  }

  function record(command) {
    if (commands.length >= LIMITS.commands) fail('COMMAND_BUDGET');
    commands.push(Object.freeze({...command}));
  }

  function available(slot) {
    return pending.find(item => !item.settled &&
      (slot === 'ACTIVE' ? !['STOP', 'SETTLEMENT'].includes(item.phase) :
        ['STOP', 'SETTLEMENT'].includes(item.phase)));
  }

  function reenter(site) {
    if (!armed || armed.site !== site || inReentry) return;
    const chosen = armed;
    armed = null;
    inReentry = true;
    const command = chosen.action === 'ABORT' ?
      {op: 'ABORT', reason: 'CALLER_STOP', at: now, nested: true} :
      chosen.action === 'POLL' ?
        {op: 'POLL', at: now, nested: true} :
        {op: 'DELIVER_DEADLINE', choice: 'LATER_BOUNDED',
          at: now, nested: true};
    try {
      const before = harness.getSnapshot();
      record(command);
      effect(command, before);
      const after = harness.getSnapshot();
      const code = checkTransition(before, after, ledger);
      if (code) nestedFailure = code;
      last = after;
    } catch {
      nestedFailure = 'DRIVER_EXCEPTION';
    } finally {
      inReentry = false;
    }
  }

  function port(phase) {
    const method = {
      LAUNCH: 'launch', F0_CAPTURE: 'captureFrame',
      KEY_ACTION: 'dispatchAction', F1_CAPTURE: 'captureFrame',
      CLICK_ACTION: 'dispatchAction', F2_CAPTURE: 'captureFrame',
      STOP: 'stop', SETTLEMENT: 'observeSettlement',
    }[phase];
    return {[method](request) {
      ledger[COUNTERS[phase]]++;
      if (exactCorrelation(request?.correlation, OP_IDS[phase]))
        operationLedger.counts[OP_IDS[phase]]++;
      else
        operationLedger.invalid = true;
      const item = {phase, request, resolve: null, reject: null, settled: false};
      pending.push(item);
      return {then(resolve, reject) {
        item.resolve = resolve;
        item.reject = reject;
      }};
    }};
  }

  const ports = {
    launchPort: port('LAUNCH'),
    actionPort: {dispatchAction(request) {
      return port(request.kind === 'SPACE_STROKE' ?
        'KEY_ACTION' : 'CLICK_ACTION').dispatchAction(request);
    }},
    capturePort: {captureFrame(request) {
      return port(`${request.phase}_CAPTURE`).captureFrame(request);
    }},
    stopPort: port('STOP'),
    settlementPort: port('SETTLEMENT'),
  };
  harness = createFixobsLifecycleHarness({
    t0_ms: 1000,
    correlation: BASE,
    ports,
    clock: {now() { reenter('CLOCK'); return now; }},
    scheduler: {schedule(target, callback) {
      const id = ++serial;
      scheduled.set(id, {target, callback});
      reenter('SCHEDULER_REGISTER');
      return {cancel() {
        scheduled.delete(id);
        reenter('TOKEN_CANCEL');
      }};
    }},
    mode: 'SOURCE_SIMULATION',
  });

  function deadline() {
    return [...scheduled.entries()].sort((a, b) =>
      a[1].target - b[1].target)[0] ?? null;
  }

  function materialize(command, before) {
    const out = {...command};
    if (out.op === 'STEP' || out.op === 'POLL' || out.op === 'ABORT')
      out.at = now;
    if (out.op === 'SET_TIME') {
      out.value = setTimeValue(out.choice, now, before.model_snapshot);
      if (!Number.isSafeInteger(out.value) || out.value < now ||
          out.value > 61000) fail('CLOCK_CHOICE_INELIGIBLE', before);
    }
    if (out.op === 'DELIVER_DEADLINE' && out.at === undefined) {
      const item = deadline();
      if (!item) fail('DRIVER_MISSING_DEADLINE', before);
      out.at = out.choice === 'EARLY_TARGET_MINUS_1' ? item[1].target - 1 :
        out.choice === 'EXACT_TARGET' ? item[1].target :
          Math.min(61000, item[1].target + 1);
    }
    if (out.op === 'SETTLE_PENDING' || out.op === 'REJECT_PENDING') {
      const item = available(out.slot);
      if (!item) fail('DRIVER_MISSING_PENDING', before);
      out.phase = item.phase;
      if (out.op === 'SETTLE_PENDING') {
        const dispatch = item.request.t_dispatch_ms ??
          item.request.t_capture_ms ?? item.request.t_stop_ms ??
          item.request.t_observe_ms;
        out.event_ms = ({
          DISPATCH: dispatch,
          BETWEEN_DISPATCH_COMPLETION: dispatch + Math.floor((now - dispatch) / 2),
          BEFORE_DISPATCH: dispatch - 1,
          AFTER_COMPLETION: now + 1,
        })[out.event_time];
        out.at = now;
      }
    }
    return out;
  }

  function result(item, command) {
    const request = item.request;
    const correlation = command.form === 'WRONG_CORRELATION' ?
      {...request.correlation, operation_id: 'other-operation'} :
      request.correlation;
    const event = command.event_ms;
    const fault = command.form === 'FAULT';
    let value;
    if (item.phase === 'LAUNCH') {
      value = {correlation, status: fault ? 'FAULT' : 'ACK',
        t_ack_ms: event, injected_process_id: 'PID-101',
        error_code: fault || command.form === 'FAULT_CODE_SUCCESS' ?
          'LAUNCH_FAULT' : null};
    } else if (item.phase.endsWith('_ACTION')) {
      value = {correlation, kind: request.kind, status: fault ? 'FAULT' : 'ACK',
        t_ack_ms: event,
        error_code: fault || command.form === 'FAULT_CODE_SUCCESS' ?
          'ACTION_FAULT' : null};
    } else if (item.phase.endsWith('_CAPTURE')) {
      value = {correlation, phase: request.phase,
        status: fault ? 'FAULT' : 'CAPTURED', t_acquired_ms: event,
        buffer: frame(command.frame),
        error_code: fault || command.form === 'FAULT_CODE_SUCCESS' ?
          'CAPTURE_FAULT' : null};
    } else if (item.phase === 'STOP') {
      value = {correlation, status: fault ? 'FAULT' : 'ACK',
        t_ack_ms: event, direct_child_exit_observed: true,
        error_code: fault || command.form === 'FAULT_CODE_SUCCESS' ?
          'STOP_FAULT' : null};
    } else {
      value = {correlation, status: fault ? 'UNKNOWN' : 'OBSERVED_CLEAN',
        t_observed_ms: event,
        scope_observation: {
          launch_closed: true, scope_id: request.expected_scope_id,
          coverage: 'FULL_INSPECTED', live_count: 0,
          conflicting_identities: [],
        },
        fenced_scope_descriptors: [],
        error_code: fault || command.form === 'FAULT_CODE_SUCCESS' ?
          'SETTLEMENT_FAULT' : null};
    }
    if (command.form === 'MISSING_FIELD') delete value.error_code;
    if (command.form === 'EXTRA_FIELD') value.extra = 'fixed-extra';
    return value;
  }

  function effect(command, before) {
    switch (command.op) {
      case 'STEP':
        track(harness.step(command.phase, command.at), 'STEP');
        return null;
      case 'SET_TIME':
        now = command.value;
        return null;
      case 'POLL':
        harness.poll(command.at);
        return null;
      case 'DELIVER_DEADLINE': {
        const item = deadline();
        if (item) {
          now = Math.max(now, command.at);
          if (command.at >= item[1].target) scheduled.delete(item[0]);
          item[1].callback(command.at);
        } else {
          now = Math.max(now, command.at);
          track(harness.deliverDeadline(command.at), 'DEADLINE');
        }
        return null;
      }
      case 'SETTLE_PENDING': {
        const item = available(command.slot);
        if (!item || item.phase !== command.phase || !item.resolve)
          fail('DRIVER_MISSING_PENDING', before);
        const dispatch = item.request.t_dispatch_ms ??
          item.request.t_capture_ms ?? item.request.t_stop_ms ??
          item.request.t_observe_ms;
        const n7 = item.phase.endsWith('_CAPTURE') &&
          command.form === 'SUCCESS' && !armed &&
          before.model_snapshot.first_stop_ms === null &&
          command.event_ms >= dispatch && command.event_ms <= now &&
          command.event_ms < before.model_snapshot.last_ms &&
          now <= before.model_snapshot.phase_deadline_ms &&
          now <= before.model_snapshot.active_deadline_ms;
        const emit = item.resolve;
        const value = result(item, command);
        const expectation = n7 ? {
          firstStop: before.model_snapshot.last_ms,
          attempts: before.model_snapshot.modeled_reservations.capture_attempts,
        } : {};
        if (item.phase === 'LAUNCH') {
          launchEmit = emit;
          launchRequest = item.request;
          launchFirstAckPid = validFirstLaunchAckPid(value, dispatch, now);
          launchWasAbandoned =
            before.retained_owner_state.abandoned_operations.some(
              operation => operation.operation_id === OP_IDS.LAUNCH);
          expectation.possibleOwnPid = possibleOwnLaunchPid(value);
          expectation.invalidLaunchAck = launchFirstAckPid === null;
        }
        item.settled = true;
        item.resolve = null;
        item.reject = null;
        emit(value);
        return expectation;
      }
      case 'REJECT_PENDING': {
        const item = available(command.slot);
        if (!item || !item.reject) fail('DRIVER_MISSING_PENDING', before);
        const reject = item.reject;
        item.settled = true;
        item.resolve = null;
        item.reject = null;
        reject(new Error('SYNTHETIC_PORT_FAULT'));
        return null;
      }
      case 'DUPLICATE_LAUNCH': {
        if (!launchEmit || !launchRequest) fail('DRIVER_MISSING_PENDING', before);
        const correlation = command.kind === 'WRONG_CORRELATION' ?
          {...launchRequest.correlation, operation_id: 'other-operation'} :
          launchRequest.correlation;
        const pid = command.kind === 'CONFLICTING_PID' ?
          'PID-OTHER' : 'PID-101';
        const value = {correlation, status: 'ACK',
          t_ack_ms: launchRequest.t_dispatch_ms,
          injected_process_id: pid, error_code: null};
        if (command.kind === 'MALFORMED_UNRELATED') value.unrelated = 'fixed';
        launchEmit(value);
        return command.kind === 'CONFLICTING_PID' &&
          before.harness_state === 'COMPLETED' &&
          (launchFirstAckPid !== null || launchWasAbandoned) ?
            {latePid: pid} : null;
      }
      case 'ABORT':
        summaryArmed = true;
        track(harness.abort(command.reason, command.at), 'ABORT');
        return null;
      case 'ARM_REENTRY':
        armed = {site: command.site, action: command.action};
        return null;
      case 'TRY_INVALID_STEP': {
        const expected = before.harness_state === 'COMPLETED' ?
          'HARNESS_ALREADY_COMPLETED' :
          stepOpen > 0 ? 'CONCURRENT_DISPATCH_REJECTED' :
            'UNEXPECTED_SEQUENCE';
        let threw = false;
        let caught;
        try {
          const returned = harness.step(command.phase, now);
          Promise.resolve(returned).then(() => undefined, () => undefined);
        } catch (error) {
          threw = true;
          caught = error;
        }
        if (!threw) fail('INVALID_STEP_ACCEPTED', before);
        if (caught?.code !== expected) fail('PUBLIC_ENUM', before);
        return {invalidBefore: terminalProjection(before)};
      }
      default:
        fail('DRIVER_EXCEPTION', before);
    }
  }

  async function execute(source) {
    const before = harness.getSnapshot();
    const command = materialize(source, before);
    record(command);
    let expectation;
    try {
      expectation = effect(command, before);
    } catch (error) {
      if (isOracleFailure(error)) throw error;
      fail('DRIVER_EXCEPTION', before);
    }
    for (let turn = 0; turn < LIMITS.drains; turn++) await Promise.resolve();
    const after = harness.getSnapshot();
    if (nestedFailure) fail(nestedFailure, after);
    const code = checkTransition(before, after, ledger);
    if (code) fail(code, after);
    if (expectation?.firstStop !== undefined) {
      n7Checks++;
      if (after.model_snapshot.reason !== 'INVALID_CLOCK' ||
          after.model_snapshot.first_stop_ms !== expectation.firstStop ||
          after.model_snapshot.modeled_reservations.capture_attempts !==
            expectation.attempts)
        fail('N7_MODEL_CLOCK', after);
    }
    if (expectation?.latePid &&
        (!after.retained_owner_state.orphaned_injected_process_ids
          .includes(expectation.latePid) ||
          !after.retained_owner_state.fenced_scopes
            .includes(`late-launch:${expectation.latePid}`)))
      fail('LATE_IDENTITY_NOT_FENCED', after);
    if (expectation?.invalidLaunchAck &&
        (after.injected_process_id !== null ||
          after.harness_state === 'F0_CAPTURING'))
      fail('MALFORMED_PROMOTED', after);
    if (expectation?.possibleOwnPid &&
        after.model_snapshot.first_stop_ms !== null &&
        after.injected_process_id === null &&
        (!after.retained_owner_state.orphaned_injected_process_ids
          .includes(expectation.possibleOwnPid) ||
          !after.retained_owner_state.fenced_scopes
            .includes(`late-launch:${expectation.possibleOwnPid}`)))
      fail('LATE_IDENTITY_NOT_FENCED', after);
    if (expectation?.invalidBefore &&
        terminalProjection(after) !== expectation.invalidBefore)
      fail('INVALID_STEP_MUTATED', after);
    for (const old of oldSnapshots) {
      if (JSON.stringify(old.value) !== old.encoding)
        fail('OLD_SNAPSHOT_CHANGED', after);
    }
    oldSnapshots.push({value: after, encoding: JSON.stringify(after)});
    last = after;
  }

  function randomSettle(slot) {
    return settle(
      choose(next, ['SUCCESS', 'SUCCESS', 'SUCCESS', 'FAULT',
        'FAULT_CODE_SUCCESS', 'WRONG_CORRELATION', 'MISSING_FIELD',
        'EXTRA_FIELD']),
      choose(next, ['DISPATCH', 'BETWEEN_DISPATCH_COMPLETION',
        'BEFORE_DISPATCH', 'AFTER_COMPLETION']),
      choose(next, ['S0', 'S1', 'S2', 'INVALID_SHORT']), slot);
  }

  function nextCommand(stepNumber) {
    if (stepNumber < script.length) return script[stepNumber];
    if (stepNumber === 0)
      return seed % 8 === 0 ?
        {op: 'ABORT', reason: 'CALLER_STOP'} :
        {op: 'STEP', phase: 'LAUNCH'};
    if (last.harness_state === 'COMPLETED') return null;
    if (last.model_snapshot.first_stop_ms !== null && !summaryArmed)
      return {op: 'ABORT', reason: 'CALLER_STOP'};
    if (seed >= 25 && stepNumber < 14 &&
        last.model_snapshot.first_stop_ms === null) {
      if (stepNumber === 2 && seed % 2 === 0)
        return {op: 'SET_TIME', choice: 'PLUS_1'};
      if (stepNumber === 5 && seed % 3 === 0) return {op: 'POLL'};
      if (available('ACTIVE')) {
        const item = available('ACTIVE');
        return settle('SUCCESS', 'DISPATCH',
          item.phase.endsWith('_CAPTURE') ?
            item.phase.slice(0, 2).replace('F0', 'S0')
              .replace('F1', 'S1').replace('F2', 'S2') : 'S0');
      }
      const phase = NEXT_PHASE[last.harness_state];
      if (phase && stepOpen === 0) return {op: 'STEP', phase};
    }
    const options = [];
    const active = available('ACTIVE');
    const cleanup = available('CLEANUP');
    if (active) {
      options.push(settle('SUCCESS', 'DISPATCH',
        active.phase === 'F1_CAPTURE' ? 'S1' :
          active.phase === 'F2_CAPTURE' ? 'S2' : 'S0'));
      options.push(randomSettle('ACTIVE'), randomSettle('ACTIVE'),
        {op: 'REJECT_PENDING', slot: 'ACTIVE'});
    }
    if (cleanup) {
      options.push(settle('SUCCESS', 'DISPATCH', 'S0', 'CLEANUP'),
        settle('SUCCESS', 'DISPATCH', 'S0', 'CLEANUP'),
        randomSettle('CLEANUP'),
        {op: 'REJECT_PENDING', slot: 'CLEANUP'});
    }
    const phase = NEXT_PHASE[last.harness_state];
    if (phase && stepOpen === 0 && !active) {
      options.push({op: 'STEP', phase}, {op: 'STEP', phase},
        {op: 'STEP', phase}, {op: 'STEP', phase},
        {op: 'STEP', phase: 'STOP'});
    }
    if (scheduled.size) {
      options.push({op: 'DELIVER_DEADLINE',
        choice: choose(next, ['EARLY_TARGET_MINUS_1', 'EXACT_TARGET',
          'LATER_BOUNDED'])});
    }
    if (last.model_snapshot.first_stop_ms === null) {
      const clockChoices = eligibleSetTimeChoices(now,
        last.model_snapshot, ['CURRENT', 'PLUS_1', 'PLUS_100',
          'PHASE_CAP', 'PHASE_CAP_PLUS_1']);
      options.push({op: 'SET_TIME', choice: choose(next, clockChoices)});
      options.push({op: 'POLL'});
    } else {
      if (eligibleSetTimeChoices(now, last.model_snapshot,
        ['CLEANUP_CAP']).length)
        options.push({op: 'SET_TIME', choice: 'CLEANUP_CAP'});
    }
    options.push({op: 'TRY_INVALID_STEP',
      phase: choose(next, ['constructor', 'PRIVATE_FIXED_INVALID', 42, null])});
    if (!armed) options.push({op: 'ARM_REENTRY',
      site: choose(next, ['CLOCK', 'SCHEDULER_REGISTER', 'TOKEN_CANCEL']),
      action: choose(next, ['ABORT', 'DELIVER_DEADLINE', 'POLL'])});
    options.push({op: 'ABORT',
      reason: choose(next, ['CALLER_STOP', 'CALLER_ABORT'])});
    return choose(next, options);
  }

  try {
    for (let stepNumber = 0; stepNumber < 26 &&
        commands.length < 38; stepNumber++) {
      const command = nextCommand(stepNumber);
      if (!command) break;
      await execute(command);
    }
    if (last?.harness_state !== 'COMPLETED' && !summaryArmed)
      await execute({op: 'ABORT', reason: 'CALLER_STOP'});
    for (let index = 0; index < 8 && last.harness_state !== 'COMPLETED';
      index++) {
      const cleanup = available('CLEANUP');
      if (cleanup) {
        await execute(settle(
          seed === 28 && cleanup.phase === 'STOP' ?
            'FAULT_CODE_SUCCESS' : 'SUCCESS',
          'DISPATCH', 'S0', 'CLEANUP'));
      } else if (scheduled.size) {
        await execute({op: 'DELIVER_DEADLINE', choice: 'EXACT_TARGET'});
      } else {
        fail('UNSETTLED_HARNESS');
      }
    }
    if (last.harness_state !== 'COMPLETED') fail('UNSETTLED_HARNESS');
    if (available('ACTIVE') && commands.length < 48)
      await execute(settle('SUCCESS', 'DISPATCH', 'S0', 'ACTIVE'));
    if (launchEmit && commands.length < 48) {
      await execute({op: 'DUPLICATE_LAUNCH', kind: 'MATCH'});
      await execute({op: 'DUPLICATE_LAUNCH', kind: 'CONFLICTING_PID'});
    }
    if (inflight.size !== 0) fail('UNSETTLED_PUBLIC_PROMISE');
    if (!summary) fail('MISSING_SUMMARY');
    const code = checkSummary(summary, last, ledger, operationLedger);
    if (code) fail(code);
    return {
      seed, count: commands.length, n7Checks,
      commands: commands.map(command => ({...command})),
      encoding: encodeTrace({grammar_version: GRAMMAR_VERSION, seed, commands}),
    };
  } catch (error) {
    if (isOracleFailure(error)) throw error;
    fail('DRIVER_EXCEPTION');
  } finally {
    for (const item of pending) {
      item.resolve = null;
      item.reject = null;
      item.request = null;
    }
    scheduled.clear();
    launchEmit = null;
    launchRequest = null;
  }
}
