import test from 'node:test';
import assert from 'node:assert/strict';
import {validateJobSpec, ContractError} from '../src/job-spec.mjs';
import {spec} from './fixtures.mjs';

test('JobSpec requires every approved field and rejects additional payload fields', () => {
  for (const key of Object.keys(spec())) {
    const input = spec(); delete input[key]; assert.throws(() => validateJobSpec(input), ContractError);
  }
  for (const key of ['prompt', 'command', 'credentials', 'transcript']) {
    assert.throws(() => validateJobSpec({...spec(), [key]: 'PRIVATE_FIXTURE'}), ContractError);
  }
});
test('JobSpec copies and freezes caller data without altering identity or history reference', () => {
  const input = {...spec(), fenced_history_ref: 'history-fixture'};
  const result = validateJobSpec(input); input.required_artifacts.push('later.txt'); input.job_id = 'changed';
  assert.equal(result.job_id, spec().job_id); assert.deepEqual(result.required_artifacts, ['result.txt']);
  assert.equal(result.fenced_history_ref, 'history-fixture');
  assert.throws(() => { result.job_id = 'changed'; }, TypeError);
  assert.throws(() => result.required_artifacts.push('changed'), TypeError);
});
test('JobSpec requires UUIDv4 and either approved provider without resolving a live model', () => {
  for (const job_id of ['', 'not-a-uuid', '12345678-1234-1abc-8def-123456789abc']) {
    assert.throws(() => validateJobSpec({...spec(), job_id}), ContractError);
  }
  for (const provider_id of ['agy_gemini', 'native_codex']) assert.equal(validateJobSpec({...spec(), provider_id}).provider_id, provider_id);
  assert.throws(() => validateJobSpec({...spec(), provider_id: 'paid_api'}), ContractError);
});
test('JobSpec requires explicit positive integer budgets without introducing defaults or benchmark caps', () => {
  for (const key of ['max_wall_clock_sec', 'max_steps']) {
    for (const value of [0, -1, 1.5, NaN, Infinity, '300', null, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => validateJobSpec({...spec(), [key]: value}), ContractError);
    }
    assert.equal(validateJobSpec({...spec(), [key]: 1})[key], 1);
  }
});
test('JobSpec rejects empty scopes models and history references without echoing supplied values', () => {
  for (const key of ['task_scope', 'requested_model', 'fenced_history_ref']) {
    for (const value of ['', '   ', null, 'bad\0value']) assert.throws(() => validateJobSpec({...spec(), [key]: value}), ContractError);
  }
  try { validateJobSpec({...spec(), job_id: 'PRIVATE_FIXTURE'}); assert.fail(); }
  catch (failure) { assert(!failure.message.includes('PRIVATE_FIXTURE')); }
});
test('JobSpec requires unique relative artifact paths and rejects traversal aliases and sparse arrays', () => {
  for (const required_artifacts of [[], ['/absolute'], ['../parent'], ['a/../b'], ['./a'], ['a//b'], ['a\\b'],
    ['C:relative'], ['a\nb'], ['result.txt', 'result.txt'], new Array(1), ['result.txt', ...new Array(1)]]) {
    assert.throws(() => validateJobSpec({...spec(), required_artifacts}), ContractError);
  }
  assert.deepEqual(validateJobSpec({...spec(), required_artifacts: ['folder/output.txt']}).required_artifacts, ['folder/output.txt']);
});
test('JobSpec rejects accessors and non-data records', () => {
  const input = spec(); Object.defineProperty(input, 'requested_model', {get() { throw Error('must not evaluate'); }});
  assert.throws(() => validateJobSpec(input), ContractError);
  for (const invalid of [null, [], new Date()]) assert.throws(() => validateJobSpec(invalid), ContractError);
});
test('JobSpec captures artifact data once and never evaluates element getters or custom iterators', () => {
  let calls = 0;
  const accessor = ['result.txt'];
  Object.defineProperty(accessor, '0', {get() { calls++; return '../outside'; }});
  const iterator = ['result.txt'];
  iterator[Symbol.iterator] = function* () { calls++; yield '../outside'; };
  const extra = ['result.txt']; extra.privatePayload = 'PRIVATE_FIXTURE';
  for (const required_artifacts of [accessor, iterator, extra, Object.assign(Object.create(Array.prototype), {length: 1})]) {
    assert.throws(() => validateJobSpec({...spec(), required_artifacts}), ContractError);
  }
  assert.equal(calls, 0);
  const ordinary = ['result.txt'];
  const validated = validateJobSpec({...spec(), required_artifacts: ordinary}); ordinary[0] = '../changed';
  assert.deepEqual(validated.required_artifacts, ['result.txt']);
});
test('JobSpec rejects Proxy records and arrays without invoking their traps', () => {
  let calls = 0;
  const handler = {getPrototypeOf() { calls++; throw Error('trap'); }, ownKeys() { calls++; throw Error('trap'); }};
  assert.throws(() => validateJobSpec(new Proxy(spec(), handler)), ContractError);
  assert.throws(() => validateJobSpec({...spec(), required_artifacts: new Proxy(['result.txt'], handler)}), ContractError);
  assert.equal(calls, 0);
});
