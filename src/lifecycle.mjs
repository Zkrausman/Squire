import {validateJobSpec, closed, own, fail} from './job-spec.mjs';
import {validateJobRecord, validateArtifactWitness} from './job-record.mjs';

export const LIFECYCLE_STATUSES = Object.freeze([
  'SUBMITTED', 'RUNNING', 'VERIFYING_ARTIFACTS', 'SETTLING_DESCENDANTS', 'TERMINAL_SETTLEMENT'
]);
const states = new WeakSet();
function state(value) { const result = Object.freeze(value); states.add(result); return result; }
function currentState(current) {
  if (!states.has(current)) fail('lifecycle', 'unrecognized_lifecycle');
  if (current.record !== null) fail('transition', 'illegal_transition');
}
function failed(current) { return current.terminal_intent === 'CANCELED' ? 'CANCELED' : 'FAILED'; }
const aborts = ['EVENT_USER_ABORT', 'EVENT_TIMEOUT_OR_ABORT'];
const settlements = Object.freeze({
  EVENT_DESCENDANTS_OBSERVED_CLEAN: 'CLEAN',
  EVENT_DESCENDANTS_OBSERVED_ORPHAN_KILLED: 'ORPHAN_KILLED',
  EVENT_SETTLEMENT_LIMIT_EXCEEDED_LEAK: 'DIRTY_LEAK'
});

export function createLifecycle(specification) {
  return state({job_spec: validateJobSpec(specification), lifecycle_status: 'SUBMITTED',
    terminal_intent: null, process_group_allocated: false, process_exit_code: null,
    settlement_status: null, artifact_witness: null, record: null});
}

// Pure injected observations, not execution, timers, admission enforcement or custody proof.
export function advanceLifecycle(current, event, payload = {}) {
  currentState(current);
  if (typeof event !== 'string') fail('event');
  const from = current.lifecycle_status;
  if (aborts.includes(event)) {
    closed(payload, [], [], 'event');
    return state({...current, terminal_intent: 'CANCELED', lifecycle_status:
      from === 'TERMINAL_SETTLEMENT' || !current.process_group_allocated ? 'TERMINAL_SETTLEMENT' : 'SETTLING_DESCENDANTS'});
  }
  if (from === 'TERMINAL_SETTLEMENT') fail('transition', 'illegal_transition');
  if (from === 'SUBMITTED') {
    if (event === 'EVENT_SPEC_VALIDATION_FAILED') {
      closed(payload, [], [], 'event');
      return state({...current, terminal_intent: 'FAILED', lifecycle_status: 'TERMINAL_SETTLEMENT'});
    }
    if (event === 'EVENT_ADMISSION_PASSED') {
      closed(payload, ['admission_passed', 'workspace_fence_passed', 'history_fence_passed', 'process_group_allocated'], [], 'event');
      if (['admission_passed', 'workspace_fence_passed', 'history_fence_passed', 'process_group_allocated']
        .some(key => payload[key] !== true)) fail('admission_observations');
      return state({...current, process_group_allocated: true, lifecycle_status: 'RUNNING'});
    }
  }
  if (['RUNNING', 'SETTLING_DESCENDANTS'].includes(from) &&
      ['EVENT_PROCESS_EXIT_ZERO', 'EVENT_PROCESS_EXIT_NONZERO', 'EVENT_PROCESS_SIGNAL_TERMINATED', 'EVENT_PROCESS_EXIT_UNOBSERVED'].includes(event)) {
    // Settlement accepts a late exit only after cancellation, without reopening verification.
    if (from === 'SETTLING_DESCENDANTS' && current.terminal_intent !== 'CANCELED') fail('transition', 'illegal_transition');
    let exit = null;
    if (['EVENT_PROCESS_SIGNAL_TERMINATED', 'EVENT_PROCESS_EXIT_UNOBSERVED'].includes(event)) closed(payload, [], [], 'event');
    else {
      closed(payload, ['process_exit_code'], [], 'event');
      exit = payload.process_exit_code;
      if (!Number.isSafeInteger(exit) || (event === 'EVENT_PROCESS_EXIT_ZERO' ? exit !== 0 : exit === 0)) fail('process_exit_code');
    }
    if (current.process_exit_code !== null && current.process_exit_code !== exit) fail('process_exit_code', 'observation_conflict');
    const canceled = current.terminal_intent === 'CANCELED';
    return state({...current, process_exit_code: exit,
      terminal_intent: canceled ? 'CANCELED' : exit === 0 ? null : 'FAILED',
      lifecycle_status: !canceled && exit === 0 ? 'VERIFYING_ARTIFACTS' : 'SETTLING_DESCENDANTS'});
  }
  if (event === 'EVENT_ARTIFACTS_VERIFIED' &&
      (from === 'VERIFYING_ARTIFACTS' || from === 'SETTLING_DESCENDANTS' && current.terminal_intent === 'CANCELED')) {
    closed(payload, ['artifact_witness'], [], 'event');
    // A late observation never restarts verification or replaces a committed witness.
    if (current.terminal_intent === 'CANCELED') return current;
    const witness = validateArtifactWitness(payload.artifact_witness);
    if (current.job_spec.required_artifacts.some(name => !own(witness, name))) fail('artifact_witness');
    return state({...current, artifact_witness: witness, terminal_intent: 'SUCCESS', lifecycle_status: 'SETTLING_DESCENDANTS'});
  }
  if (from === 'VERIFYING_ARTIFACTS' && event === 'EVENT_ARTIFACT_VERIFICATION_FAILED') {
    closed(payload, [], [], 'event');
    return state({...current, terminal_intent: 'FAILED', lifecycle_status: 'SETTLING_DESCENDANTS'});
  }
  if (from === 'SETTLING_DESCENDANTS') {
    if (own(settlements, event)) {
      closed(payload, [], [], 'event');
      const settlement = settlements[event];
      return state({...current, settlement_status: settlement, lifecycle_status: 'TERMINAL_SETTLEMENT',
        terminal_intent: settlement === 'DIRTY_LEAK' ? failed(current) : current.terminal_intent});
    }
    if (event === 'EVENT_SETTLEMENT_OBSERVATION_FAILED') {
      closed(payload, [], [], 'event');
      return state({...current, terminal_intent: failed(current), lifecycle_status: 'TERMINAL_SETTLEMENT'});
    }
  }
  fail('transition', 'illegal_transition');
}

export function finalizeLifecycle(current, input) {
  currentState(current);
  if (current.lifecycle_status !== 'TERMINAL_SETTLEMENT') fail('final_record', 'final_record_before_terminal');
  const record = validateJobRecord(current.job_spec, input, {
    process_group_allocated: current.process_group_allocated,
    process_exit_code: current.process_exit_code, settlement_status: current.settlement_status
  });
  if (record.lifecycle_status !== current.terminal_intent) fail('lifecycle_status', 'outcome_conflict');
  if (current.artifact_witness !== null) {
    const expected = current.artifact_witness; const actual = record.artifact_witness;
    if (Object.keys(expected).length !== Object.keys(actual).length || Object.keys(expected).some(name =>
      !own(actual, name) || expected[name].byte_count !== actual[name].byte_count || expected[name].sha256 !== actual[name].sha256)) {
      fail('artifact_witness', 'observation_conflict');
    }
  }
  return state({...current, record});
}
