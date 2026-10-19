import test from 'node:test';
import assert from 'node:assert/strict';
import {createLifecycle, advanceLifecycle, LIFECYCLE_STATUSES} from '../src/lifecycle.mjs';
import {spec, record} from './fixtures.mjs';

const settling = () => ['RUNNING', 'VERIFYING_ARTIFACTS', 'SETTLING_DESCENDANTS'].reduce(
  (state, next) => advanceLifecycle(state, next), createLifecycle(spec()));

test('lifecycle keeps immutable identity and deterministically follows the supported success path', () => {
  const first = createLifecycle(spec()); const last = advanceLifecycle(settling(), 'SUCCESS', record());
  assert.equal(first.lifecycle_status, 'SUBMITTED'); assert.equal(last.lifecycle_status, 'SUCCESS');
  assert.deepEqual(last.job_spec, first.job_spec); assert.equal(last.job_spec.job_id, spec().job_id);
  assert.throws(() => { last.job_spec.job_id = 'replacement'; }, TypeError);
  assert.deepEqual(advanceLifecycle(settling(), 'SUCCESS', record()), last);
});
test('lifecycle rejects direct success jumps and bypass of verification or settlement', () => {
  assert.throws(() => advanceLifecycle(createLifecycle(spec()), 'SUCCESS', record()), error => error.code === 'illegal_transition');
  const running = advanceLifecycle(createLifecycle(spec()), 'RUNNING');
  assert.throws(() => advanceLifecycle(running, 'SUCCESS', record()), error => error.code === 'illegal_transition');
  const verifying = advanceLifecycle(running, 'VERIFYING_ARTIFACTS');
  assert.throws(() => advanceLifecycle(verifying, 'SUCCESS', record()), error => error.code === 'illegal_transition');
});
test('lifecycle cannot turn exit0 alone into SUCCESS', () => {
  assert.throws(() => advanceLifecycle(settling(), 'SUCCESS'));
  assert.throws(() => advanceLifecycle(settling(), 'SUCCESS', {...record(), artifact_witness: {}}));
  assert.throws(() => advanceLifecycle(settling(), 'SUCCESS', {...record(), settlement_status: 'DIRTY_LEAK'}));
  assert.throws(() => advanceLifecycle(settling(), 'SUCCESS', {...record(), lifecycle_status: 'FAILED'}));
});
test('lifecycle terminals cannot transition or reopen a job', () => {
  for (const status of ['SUCCESS', 'FAILED', 'CANCELED']) {
    for (const target of LIFECYCLE_STATUSES) {
      assert.throws(() => advanceLifecycle({job_spec: spec(), lifecycle_status: status}, target, record()), error => error.code === 'illegal_transition');
    }
  }
});
test('lifecycle defers cancellation failure and alternate settlement paths without selecting semantics', () => {
  const first = createLifecycle(spec());
  for (const target of ['FAILED', 'CANCELED']) assert.throws(() => advanceLifecycle(first, target), error => error.code === 'pending_design_decision');
  const running = advanceLifecycle(first, 'RUNNING');
  assert.throws(() => advanceLifecycle(running, 'SETTLING_DESCENDANTS'), error => error.code === 'pending_design_decision');
  assert.equal(first.lifecycle_status, 'SUBMITTED'); assert.equal(running.lifecycle_status, 'RUNNING');
});
test('lifecycle rejects state patches unknown targets and premature final records', () => {
  const first = createLifecycle(spec());
  assert.throws(() => advanceLifecycle({...first, job_id: 'different'}, 'RUNNING'));
  assert.throws(() => advanceLifecycle(first, 'OTHER'));
  assert.throws(() => advanceLifecycle(first, 'RUNNING', record()));
  assert.equal(first.lifecycle_status, 'SUBMITTED');
});
