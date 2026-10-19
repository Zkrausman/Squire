import test from 'node:test';
import assert from 'node:assert/strict';
import {validateJobRecord as validateRecord, TERMINAL_STATUSES} from '../src/job-record.mjs';
import {spec, record} from './fixtures.mjs';
const validateJobRecord = (specification, input, observations = {process_group_allocated: true, process_exit_code: 0, settlement_status: 'CLEAN'}) => validateRecord(specification, input, observations);

test('JobRecord accepts only final status values and binds the original job identity', () => {
  for (const lifecycle_status of TERMINAL_STATUSES) assert.equal(validateJobRecord(spec(), {...record(), lifecycle_status}).lifecycle_status, lifecycle_status);
  for (const lifecycle_status of ['SUBMITTED', 'RUNNING', 'VERIFYING_ARTIFACTS', 'SETTLING_DESCENDANTS', 'TERMINAL_SETTLEMENT', 'UNKNOWN']) {
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
test('JobRecord nullable observations are explicit and pre-spawn settlement alone is null', () => {
  for (const lifecycle_status of ['FAILED', 'CANCELED']) {
    const input = {...record(), lifecycle_status, process_exit_code: null, settlement_status: null};
    const pre = {process_group_allocated: false, process_exit_code: null, settlement_status: null};
    assert.equal(validateJobRecord(spec(), input, pre).process_exit_code, null);
    assert.equal(JSON.parse(JSON.stringify(validateJobRecord(spec(), input, pre))).settlement_status, null);
    assert.throws(() => validateJobRecord(spec(), input, {...pre, process_group_allocated: true}), e => e.code === 'observation_conflict');
    assert.throws(() => validateJobRecord(spec(), {...input, settlement_status: 'CLEAN'}, {...pre, settlement_status: 'CLEAN'}));
    const post = {...input, settlement_status: 'CLEAN'};
    assert.equal(validateJobRecord(spec(), post, {...pre, process_group_allocated: true, settlement_status: 'CLEAN'}).process_exit_code, null);
  }
  for (const process_exit_code of [undefined, 'UNKNOWN', 1.5]) {
    assert.throws(() => validateJobRecord(spec(), {...record(), process_exit_code}));
  }
  assert.throws(() => validateJobRecord(spec(), {...record(), settlement_status: 'NOT_APPLICABLE'}));
  assert.throws(() => validateRecord(spec(), record()));
});
test('JobRecord preserves supplied observed raw integers and rejects synthesized or mismatched values', () => {
  for (const process_exit_code of [-1, 1, 137, 255]) {
    const input = {...record(), lifecycle_status: 'FAILED', process_exit_code};
    assert.equal(validateJobRecord(spec(), input, {process_group_allocated: true, process_exit_code, settlement_status: 'CLEAN'}).process_exit_code, process_exit_code);
    assert.throws(() => validateJobRecord(spec(), input, {process_group_allocated: true, process_exit_code: null, settlement_status: 'CLEAN'}), e => e.code === 'observation_conflict');
  }
  assert.equal(validateJobRecord(spec(), {...record(), settlement_status: 'ORPHAN_KILLED'}, {process_group_allocated: true, process_exit_code: 0, settlement_status: 'ORPHAN_KILLED'}).lifecycle_status, 'SUCCESS');
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
test('approved UNKNOWN wire emission is fail-closed and separate from native null observations', () => {
  for (const lifecycle_status of ['FAILED', 'CANCELED']) for (const process_exit_code of [null, 0, 7]) {
    const observations = {process_group_allocated: true, process_exit_code, settlement_status: null};
    const input = {...record(), lifecycle_status, process_exit_code, settlement_status: 'UNKNOWN'};
    const result = validateJobRecord(spec(), input, observations);
    assert.equal(result.settlement_status, 'UNKNOWN'); assert.equal(result.process_exit_code, process_exit_code);
    assert.equal(result.lifecycle_status, lifecycle_status); assert.equal(Object.hasOwn(result, 'error_details'), false);
    assert.throws(() => validateJobRecord(spec(), {...input, lifecycle_status: 'SUCCESS'}, observations));
    assert.throws(() => validateJobRecord(spec(), input, {...observations, settlement_status: 'UNKNOWN'}));
    assert.throws(() => validateJobRecord(spec(), input, {...observations, process_group_allocated: false}));
  }
});
