import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeAgyJson, decodeCodexJsonl} from '../src/provider-metadata.mjs';

const input = payload => ({raw_payload_bytes: new TextEncoder().encode(payload), max_response_bytes: 65536,
  wrapper_exit_code: 0, wrapper_signal: null, wrapper_wall_ms: null});
const agy = value => decodeAgyJson(input(JSON.stringify(value)));
const codex = (...values) => decodeCodexJsonl(input(values.map(value => JSON.stringify(value)).join('\n')));
const empty = {input: null, output: null, cache_read: null, thinking: null, total: null};
function rejected(result, code) {
  assert.equal(result.parser_status, 'PARSE_ERROR'); assert.equal(result.diagnostic_code, code);
  assert.equal(result.provider_reported_status, null); assert.equal(result.usage, null);
  assert.equal(result.task_outcome_evaluated, false);
}

test('AGY full counters preserve explicit total, thinking and elapsed wall duration', () => {
  const result = agy({status: 'SUCCESS', duration_seconds: 2.5, usage: {
    input_tokens: 100, output_tokens: 50, thinking_tokens: 20, cache_read_tokens: 30, total_tokens: 999}});
  assert.equal(result.parser_status, 'OK'); assert.equal(result.diagnostic_code, 'PARSE_OK');
  assert.deepEqual(result.usage, {input: 100, output: 50, cache_read: 30, thinking: 20, total: 999});
  assert.equal(result.duration_seconds, 2.5);
  assert.deepEqual(result.extra_metadata, {codex_reasoning_output_tokens: null, backend_model: 'UNKNOWN'});
});
test('AGY zero counters remain zero and cumulative values are unsummed', () => {
  assert.deepEqual(agy({status: 'SUCCESS', usage: {input_tokens: 5, output_tokens: 0,
    cache_read_tokens: 0, thinking_tokens: 0, total_tokens: 5}}).usage,
    {input: 5, output: 0, cache_read: 0, thinking: 0, total: 5});
});
test('invalid individual counters never coerce or discard remaining values', () => {
  for (const bad of [true, null, '50', 0.5, -1, 9007199254740992]) {
    const result = agy({status: 'SUCCESS', usage: {input_tokens: bad, output_tokens: 10, total_tokens: 15}});
    assert.equal(result.parser_status, 'OK_WITH_FIELD_DIAGNOSTIC');
    assert.equal(result.diagnostic_code, 'INVALID_USAGE_COUNTER');
    assert.deepEqual(result.usage, {...empty, output: 10, total: 15});
  }
  assert.equal(decodeAgyJson(input('{"status":"SUCCESS","usage":{"input_tokens":1e400}}')).usage.input, null);
});
test('missing metrics are unknown; explicit malformed usage or duration is diagnosed', () => {
  assert.deepEqual(agy({status: 'WAITING'}).usage, empty);
  assert.equal(agy({status: 'WAITING'}).parser_status, 'OK');
  for (const usage of [null, [], false, 2, 'secret'])
    assert.equal(agy({status: 'ERROR', usage}).diagnostic_code, 'INVALID_USAGE_COUNTER');
  for (const duration_seconds of [null, false, -1, '2']) {
    const result = agy({status: 'SUCCESS', duration_seconds});
    assert.equal(result.duration_seconds, null); assert.equal(result.diagnostic_code, 'INVALID_USAGE_COUNTER');
  }
  assert.equal(agy({status: 'SUCCESS', duration_seconds: 0}).duration_seconds, 0);
});
test('Codex terminal counters keep reasoning separate and never compute totals', () => {
  const result = codex({type: 'thread.started', thread_id: 'ignored'}, {type: 'item.completed', item: {text: 'PRIVATE'}},
    {type: 'turn.completed', usage: {input_tokens: 50, cached_input_tokens: 10, output_tokens: 25, reasoning_output_tokens: 8}});
  assert.deepEqual(result.usage, {input: 50, output: 25, cache_read: 10, thinking: null, total: null});
  assert.equal(result.extra_metadata.codex_reasoning_output_tokens, 8);
  assert.equal(result.provider_reported_status, 'turn.completed'); assert.equal(result.duration_seconds, null);
  assert.equal(result.parser_status, 'OK'); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});
test('failed terminal has no invented usage and standalone error is not terminal', () => {
  const failed = codex({type: 'turn.failed', error: {message: 'PRIVATE'}, usage: {output_tokens: 7}});
  assert.equal(failed.provider_reported_status, 'turn.failed'); assert.deepEqual(failed.usage, empty);
  assert.equal(failed.parser_status, 'OK');
  rejected(codex({type: 'error', message: 'PRIVATE'}), 'MISSING_TERMINAL');
});
test('every JSONL line validates before metadata; no accepted prefix or trailing fragment', () => {
  rejected(decodeCodexJsonl(input('{"type":"turn.completed"}\n{"type":')), 'MALFORMED_JSON');
  rejected(decodeCodexJsonl(input('{"type":"turn.completed"}\n[]')), 'INVALID_ROOT_SHAPE');
  rejected(decodeCodexJsonl(input('{"type":"turn.completed"}\n{"ignored":{"x":1,"x":2}}')), 'DUPLICATE_KEY_CONFLICT');
  assert.equal(decodeCodexJsonl(input('\n \r\n{"type":"turn.completed"}\r\n')).parser_status, 'OK');
  rejected(decodeCodexJsonl(input('\n \n')), 'MISSING_TERMINAL');
});
test('repeated and conflicting terminals reject even identical events', () => {
  rejected(codex({type: 'turn.completed'}, {type: 'turn.completed'}), 'REPEATED_TERMINAL_REJECTED');
  rejected(codex({type: 'turn.failed'}, {type: 'turn.failed'}), 'REPEATED_TERMINAL_REJECTED');
  rejected(codex({type: 'turn.completed'}, {type: 'turn.failed'}), 'CONFLICTING_TERMINAL_EVENTS');
});
test('duplicate keys including escape aliases reject in every object', () => {
  for (const payload of ['{"status":"SUCCESS","\\u0073tatus":"ERROR"}',
    '{"status":"SUCCESS","usage":{"input_tokens":1,"input_tokens":2}}',
    '{"status":"SUCCESS","ignored":[{"a":1,"\\u0061":2}]}',
    '{"status":"SUCCESS","ignored":{"__proto__":{},"__proto__":{}}}'])
    rejected(decodeAgyJson(input(payload)), 'DUPLICATE_KEY_CONFLICT');
  assert.equal(decodeAgyJson(input('{"status":"SUCCESS","a":{"x":1},"b":{"x":2},"q":"\\\"{}[],"}')).parser_status, 'OK');
});
test('invalid root, truncated JSON and extra envelope fail closed', () => {
  for (const payload of ['null', '[]', '42', 'true', '"secret"']) rejected(decodeAgyJson(input(payload)), 'INVALID_ROOT_SHAPE');
  for (const payload of ['', '{"status":"SUCCESS",', '{"status":"SUCCESS"}{}']) rejected(decodeAgyJson(input(payload)), 'MALFORMED_JSON');
});
test('explicit byte limit applies before decoding and counts UTF-8 bytes', () => {
  const value = input('{"status":"SUCCESS","ignored":"é"}');
  value.max_response_bytes = value.raw_payload_bytes.length;
  assert.equal(decodeAgyJson(value).parser_status, 'OK');
  value.max_response_bytes--;
  rejected(decodeAgyJson(value), 'PAYLOAD_SIZE_EXCEEDED');
  value.raw_payload_bytes = new Uint8Array([255, 255]); value.max_response_bytes = 1;
  rejected(decodeAgyJson(value), 'PAYLOAD_SIZE_EXCEEDED');
});
test('fatal UTF-8 rejects malformed sequences, no replacement acceptance', () => {
  for (const bytes of [[255], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80]])
    rejected(decodeAgyJson({...input(''), raw_payload_bytes: new Uint8Array(bytes)}), 'MALFORMED_UTF8');
});
test('provider status is allowlisted without retaining arbitrary strings', () => {
  for (const status of ['SUCCESS', 'ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING'])
    assert.equal(agy({status}).provider_reported_status, status);
  for (const status of [null, true, {}, 'PRIVATE'.repeat(100)]) {
    const result = agy({status, usage: {input_tokens: 3}});
    assert.equal(result.provider_reported_status, null); assert.equal(result.diagnostic_code, 'UNRECOGNIZED_STATUS');
    assert.equal(result.usage.input, 3); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  }
});
test('raw wrapper observation is independent from provider and task outcome', () => {
  const result = decodeAgyJson({...input('{"status":"SUCCESS"}'), wrapper_exit_code: 7,
    wrapper_signal: 'SIGTERM', wrapper_wall_ms: 99});
  assert.deepEqual(result.raw_wrapper, {exit_code: 7, signal: 'SIGTERM', wall_duration_ms: 99});
  assert.equal(result.provider_reported_status, 'SUCCESS'); assert.equal(result.task_outcome_evaluated, false);
  assert.equal(decodeAgyJson({...input('{"status":"CANCELED"}'), wrapper_exit_code: null}).raw_wrapper.exit_code, null);
});
test('closed boundary rejects invalid inputs without getters or proxy traps', () => {
  const invalid = [{...input('{}'), max_response_bytes: 0}, {...input('{}'), max_response_bytes: 1.5},
    {...input('{}'), raw_payload_bytes: '{}'}, {...input('{}'), raw_payload_bytes: new Uint16Array(2)},
    {...input('{}'), wrapper_exit_code: 1.2}, {...input('{}'), wrapper_signal: 'PRIVATE'},
    {...input('{}'), wrapper_wall_ms: -1}, {...input('{}'), extra: true}, {}];
  let touched = 0;
  invalid.push(new Proxy({}, {ownKeys() { touched++; throw Error(); }}));
  invalid.push({...input('{}'), raw_payload_bytes: new Proxy(new Uint8Array(), {get() { touched++; throw Error(); }})});
  const getter = input('{}'); Object.defineProperty(getter, 'wrapper_exit_code', {get() { touched++; return 0; }}); invalid.push(getter);
  for (const value of invalid) assert.throws(() => decodeAgyJson(value), error => error.code === 'INVALID_WRAPPER_OBSERVATION');
  assert.equal(touched, 0);
});
test('raw payload remains transient; ignored sensitive fields never escape', () => {
  const result = agy({status: 'SUCCESS', response: 'SECRET', error: 'SECRET', conversation_id: 'SECRET',
    tool_calls: [{arguments: 'SECRET'}], model: 'SECRET', usage: {input_tokens: 1, unknown: 'SECRET'}});
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.deepEqual(Object.keys(result), ['parser_status', 'diagnostic_code', 'provider_reported_status', 'raw_wrapper',
    'duration_seconds', 'usage', 'extra_metadata', 'task_outcome_evaluated']);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.usage));
  assert.ok(Object.isFrozen(result.raw_wrapper)); assert.ok(Object.isFrozen(result.extra_metadata));
});
test('duplicate scan is iterative for deeply nested ignored data', () => {
  const payload = '{"status":"SUCCESS","ignored":' + '['.repeat(10000) + '0' + ']'.repeat(10000) + '}';
  assert.equal(decodeAgyJson(input(payload)).parser_status, 'OK');
});
