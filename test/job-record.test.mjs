import test from 'node:test';
import assert from 'node:assert/strict';
import {validateJobRecord, TERMINAL_STATUSES} from '../src/job-record.mjs';
import {spec, record} from './fixtures.mjs';

test('JobRecord accepts only final status values and binds the original job identity', () => {
  for (const lifecycle_status of TERMINAL_STATUSES) assert.equal(validateJobRecord(spec(), {...record(), lifecycle_status}).lifecycle_status, lifecycle_status);
  for (const lifecycle_status of ['SUBMITTED', 'RUNNING', 'VERIFYING_ARTIFACTS', 'SETTLING_DESCENDANTS', 'UNKNOWN']) {
    assert.throws(() => validateJobRecord(spec(), {...record(), lifecycle_status}));
  }
  assert.throws(() => validateJobRecord(spec(), {...record(), job_id: 'other'}));
});
test('JobRecord rejects missing final fields and arbitrary telemetry payload fields', () => {
  for (const key of Object.keys(record())) {
    const input = record(); delete input[key]; assert.throws(() => validateJobRecord(spec(), input));
  }
  for (const field of ['prompt', 'response', 'command', 'diff', 'credentials']) {
    assert.throws(() => validateJobRecord(spec(), {...record(), [field]: 'PRIVATE_FIXTURE'}));
  }
});
test('JobRecord preserves reported UNKNOWN, separate timings and missing usage as UNKNOWN', () => {
  const result = validateJobRecord(spec(), {...record(), usage_tokens: {input: 3, total: 9}});
  assert.equal(result.reported_model, 'UNKNOWN'); assert.equal(result.inference_time_ms, 'UNKNOWN');
  assert.equal(result.process_wall_ms, 12);
  assert.deepEqual(result.usage_tokens, {input: 3, output: 'UNKNOWN', cache_read: 'UNKNOWN', thinking: 'UNKNOWN', total: 9});
  assert.equal(validateJobRecord(spec(), {...record(), inference_time_ms: 0}).inference_time_ms, 0);
});
test('JobRecord rejects negative invalid and extra metrics without inferring arithmetic totals', () => {
  for (const usage_tokens of [{input: -1}, {output: 1.5}, {thinking: null}, {unapproved: 0}]) {
    assert.throws(() => validateJobRecord(spec(), {...record(), usage_tokens}));
  }
  for (const process_wall_ms of [-1, 1.5, null]) assert.throws(() => validateJobRecord(spec(), {...record(), process_wall_ms}));
  const inconsistent = validateJobRecord(spec(), {...record(), usage_tokens: {input: 9, output: 9, total: 2}});
  assert.equal(inconsistent.usage_tokens.total, 2);
});
test('JobRecord success needs exit0 declared nonempty artifact assertions and settled descendants', () => {
  for (const patch of [{process_exit_code: 1}, {artifact_witness: {}}, {settlement_status: 'DIRTY_LEAK'},
    {artifact_witness: {'result.txt': {byte_count: 0, sha256: 'a'.repeat(64)}}},
    {artifact_witness: {'result.txt': {byte_count: 1, sha256: 'not-a-digest'}}}]) {
    assert.throws(() => validateJobRecord(spec(), {...record(), ...patch}));
  }
  assert.equal(validateJobRecord(spec(), {...record(), lifecycle_status: 'FAILED', artifact_witness: {}}).lifecycle_status, 'FAILED');
});
test('JobRecord does not choose absent exit or no-descendant enum conventions', () => {
  for (const value of [undefined, null, 'UNKNOWN']) {
    assert.throws(() => validateJobRecord(spec(), {...record(), process_exit_code: value}), error => error.code === 'pending_design_decision');
  }
  assert.throws(() => validateJobRecord(spec(), {...record(), settlement_status: 'NOT_APPLICABLE'}));
});
test('JobRecord freezes copies and error projection allows only metadata keys', () => {
  const input = {...record(), lifecycle_status: 'FAILED', error_details: {classification: 'fixture_failure', code: 1, signal: 'SIGTERM'}};
  const result = validateJobRecord(spec(), input);
  input.artifact_witness['result.txt'].byte_count = 99;
  assert.equal(result.artifact_witness['result.txt'].byte_count, 1);
  assert.throws(() => { result.error_details.code = 2; }, TypeError);
  assert.throws(() => validateJobRecord(spec(), {...input, error_details: {message: 'PRIVATE_FIXTURE'}}));
  assert.throws(() => validateJobRecord(spec(), {...input, artifact_witness: {'../outside': {byte_count: 1, sha256: 'a'.repeat(64)}}}));
  const details = {classification: 'fixture_failure'};
  Object.defineProperty(details, 'code', {value: 5});
  assert.equal(validateJobRecord(spec(), {...input, error_details: details}).error_details.code, 5);
  const hiddenInvalid = {};
  Object.defineProperty(hiddenInvalid, 'code', {value: {privatePayload: 'PRIVATE_FIXTURE'}});
  assert.throws(() => validateJobRecord(spec(), {...input, error_details: hiddenInvalid}));
});
