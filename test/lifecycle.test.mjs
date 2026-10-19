import test from 'node:test';
import assert from 'node:assert/strict';
import {createLifecycle, advanceLifecycle as advance, finalizeLifecycle as finalize, LIFECYCLE_STATUSES} from '../src/lifecycle.mjs';
import {spec, record} from './fixtures.mjs';

const admission = () => ({admission_passed: true, workspace_fence_passed: true, history_fence_passed: true, process_group_allocated: true});
const submitted = () => createLifecycle(spec());
const running = () => advance(submitted(), 'EVENT_ADMISSION_PASSED', admission());
const verifying = () => advance(running(), 'EVENT_PROCESS_EXIT_ZERO', {process_exit_code: 0});
const settling = () => advance(verifying(), 'EVENT_ARTIFACTS_VERIFIED', {artifact_witness: record().artifact_witness});
const settlementEvents = ['EVENT_DESCENDANTS_OBSERVED_CLEAN', 'EVENT_DESCENDANTS_OBSERVED_ORPHAN_KILLED', 'EVENT_SETTLEMENT_LIMIT_EXCEEDED_LEAK'];
const settlements = ['CLEAN', 'ORPHAN_KILLED', 'DIRTY_LEAK'];
const terminal = () => advance(settling(), settlementEvents[0]);
const finalInput = current => ({...record(), lifecycle_status: current.terminal_intent, process_exit_code: current.process_exit_code, settlement_status: current.settlement_status});
const emit = current => finalize(current, finalInput(current));

test('immutable identity and deterministic success require verified artifacts and observed complete settlement', () => {
  for (const event of settlementEvents.slice(0, 2)) {
    const first = submitted(); const end = advance(settling(), event); const done = emit(end);
    assert.equal(end.lifecycle_status, 'TERMINAL_SETTLEMENT'); assert.equal(end.record, null);
    assert.equal(done.record.lifecycle_status, 'SUCCESS'); assert.deepEqual(done.job_spec, first.job_spec);
    assert.deepEqual(emit(advance(settling(), event)), done);
    assert.throws(() => { done.job_spec.job_id = 'replacement'; }, TypeError);
    assert.throws(() => { done.record.lifecycle_status = 'FAILED'; }, TypeError);
  }
});
test('illegal jumps, state patches and records before settlement are rejected', () => {
  for (const current of [submitted(), running(), verifying(), settling()]) {
    for (const target of [...LIFECYCLE_STATUSES, 'SUCCESS', 'FAILED', 'CANCELED', 'OTHER']) {
      assert.throws(() => advance(current, target), e => e.code === 'illegal_transition');
    }
    assert.throws(() => finalize(current, record()), e => e.code === 'final_record_before_terminal');
    assert.throws(() => advance({...current}, 'EVENT_USER_ABORT'), e => e.code === 'unrecognized_lifecycle');
  }
  assert.throws(() => advance(submitted(), 'EVENT_PROCESS_EXIT_ZERO', {process_exit_code: 0}));
  assert.throws(() => advance(running(), settlementEvents[0]));
});
test('all admission and allocation assertions are required and must be true', () => {
  for (const key of Object.keys(admission())) {
    const payload = admission(); delete payload[key];
    assert.throws(() => advance(submitted(), 'EVENT_ADMISSION_PASSED', payload));
    assert.throws(() => advance(submitted(), 'EVENT_ADMISSION_PASSED', {...admission(), [key]: false}));
    const hidden = admission(); Object.defineProperty(hidden, key, {value: false, enumerable: false});
    assert.throws(() => advance(submitted(), 'EVENT_ADMISSION_PASSED', hidden));
  }
});
test('pre-spawn failure, abort and timeout preserve null observations without inventing cleanup', () => {
  for (const event of ['EVENT_SPEC_VALIDATION_FAILED', 'EVENT_USER_ABORT', 'EVENT_TIMEOUT_OR_ABORT']) {
    const end = advance(submitted(), event); const done = emit(end);
    assert.equal(done.record.lifecycle_status, event === 'EVENT_SPEC_VALIDATION_FAILED' ? 'FAILED' : 'CANCELED');
    assert.equal(done.record.process_exit_code, null); assert.equal(done.record.settlement_status, null);
    assert.equal(Object.hasOwn(done.record, 'error_details'), false);
    assert.throws(() => finalize(end, {...finalInput(end), process_exit_code: 0}));
  }
});
test('nonzero exits and artifact failure remain FAILED after clean or killed settlement', () => {
  const failures = [advance(running(), 'EVENT_PROCESS_EXIT_NONZERO', {process_exit_code: 7}),
    advance(verifying(), 'EVENT_ARTIFACT_VERIFICATION_FAILED')];
  for (const failed of failures) for (const event of settlementEvents) {
    const end = advance(failed, event); assert.equal(emit(end).record.lifecycle_status, 'FAILED');
    assert.throws(() => finalize(end, {...finalInput(end), lifecycle_status: 'SUCCESS'}));
  }
});
test('unobserved signaled exit stays null after positively observed spawned settlement', () => {
  const unobserved = advance(running(), 'EVENT_PROCESS_EXIT_UNOBSERVED');
  assert.equal(emit(advance(unobserved, settlementEvents[0])).record.process_exit_code, null);
  const failed = advance(running(), 'EVENT_PROCESS_SIGNAL_TERMINATED');
  const end = advance(failed, settlementEvents[0]);
  assert.equal(emit(end).record.process_exit_code, null);
  for (const code of [-1, 137, 255]) assert.throws(() => finalize(end, {...finalInput(end), process_exit_code: code}));
});
test('abort or timeout latches CANCELED during every active phase and every settlement outcome', () => {
  for (const initial of [running(), verifying(), settling()]) for (const abort of ['EVENT_USER_ABORT', 'EVENT_TIMEOUT_OR_ABORT']) {
    const canceled = advance(initial, abort);
    assert.equal(canceled.terminal_intent, 'CANCELED'); assert.equal(canceled.record, null);
    assert.equal(canceled.lifecycle_status, 'SETTLING_DESCENDANTS');
    for (let i = 0; i < settlementEvents.length; i++) {
      const end = advance(canceled, settlementEvents[i]); const done = emit(end);
      assert.equal(done.record.lifecycle_status, 'CANCELED'); assert.equal(done.record.settlement_status, settlements[i]);
      assert.throws(() => finalize(end, {...finalInput(end), lifecycle_status: 'FAILED'}));
    }
  }
});
test('late zero and artifact events cannot restart verification or overwrite cancellation', () => {
  let canceled = advance(running(), 'EVENT_USER_ABORT');
  canceled = advance(canceled, 'EVENT_PROCESS_EXIT_ZERO', {process_exit_code: 0});
  assert.equal(canceled.lifecycle_status, 'SETTLING_DESCENDANTS');
  assert.equal(advance(canceled, 'EVENT_ARTIFACTS_VERIFIED', {artifact_witness: record().artifact_witness}), canceled);
  assert.equal(emit(advance(canceled, settlementEvents[1])).record.lifecycle_status, 'CANCELED');
  assert.throws(() => advance(canceled, 'EVENT_PROCESS_EXIT_NONZERO', {process_exit_code: 8}), e => e.code === 'observation_conflict');
});
test('post-spawn observation failure fails closed and withholds unrepresentable record', () => {
  for (const initial of [settling(), advance(running(), 'EVENT_USER_ABORT')]) {
    const end = advance(initial, 'EVENT_SETTLEMENT_OBSERVATION_FAILED');
    assert.equal(end.lifecycle_status, 'TERMINAL_SETTLEMENT'); assert.equal(end.settlement_status, null);
    assert.equal(end.terminal_intent, initial.terminal_intent === 'CANCELED' ? 'CANCELED' : 'FAILED');
    for (const settlement_status of [null, ...settlements, 'UNKNOWN']) {
      assert.throws(() => finalize(end, {...finalInput(end), settlement_status}), e => e.code === 'unrepresentable_settlement');
    }
  }
});
test('dirty leak forbids success and cannot erase a cancellation arriving before emission', () => {
  const dirty = advance(settling(), settlementEvents[2]); assert.equal(emit(dirty).record.lifecycle_status, 'FAILED');
  const canceled = advance(terminal(), 'EVENT_USER_ABORT'); assert.equal(emit(canceled).record.lifecycle_status, 'CANCELED');
});
test('final record fields must match observations and accepted witness; emission is irreversible', () => {
  const end = terminal();
  for (const patch of [{process_exit_code: 1}, {settlement_status: 'ORPHAN_KILLED'}, {artifact_witness: {}},
    {artifact_witness: {'result.txt': {byte_count: 2, sha256: 'a'.repeat(64)}}}, {job_id: 'other'}]) {
    assert.throws(() => finalize(end, {...finalInput(end), ...patch}));
  }
  const done = emit(end);
  for (const event of ['EVENT_USER_ABORT', ...settlementEvents, 'EVENT_PROCESS_EXIT_ZERO']) {
    assert.throws(() => advance(done, event), e => e.code === 'illegal_transition');
  }
  assert.throws(() => finalize(done, finalInput(done)), e => e.code === 'illegal_transition');
  assert.throws(() => advance(end, settlementEvents[0]), e => e.code === 'illegal_transition');
});
test('malformed observations cannot mint success or change already returned state', () => {
  const first = running();
  assert.throws(() => advance(first, 'EVENT_PROCESS_EXIT_ZERO', {process_exit_code: null}));
  assert.throws(() => advance(first, 'EVENT_PROCESS_EXIT_NONZERO', {process_exit_code: 0}));
  assert.throws(() => advance(first, 'EVENT_PROCESS_SIGNAL_TERMINATED', {process_exit_code: 137}));
  assert.throws(() => advance(verifying(), 'EVENT_ARTIFACTS_VERIFIED', {artifact_witness: {}}));
  assert.equal(first.lifecycle_status, 'RUNNING'); assert.equal(first.terminal_intent, null);
});
