import test from 'node:test';
import assert from 'node:assert/strict';
import {AGY_BYTE_LIMITS as caps, AGY_CHILD_ENV_DELETIONS, validateAgyPrompt, prepareAgyArgv,
  decodeAgyJson, isAgyStderrByteCountWithinLimit} from '../src/agy-profile.mjs';
const encode = value => new TextEncoder().encode(value);
const job = () => ({job_id: '11111111-1111-4111-8111-111111111111', task_scope: '/synthetic/task',
  provider_id: 'agy_gemini', requested_model: 'synthetic-approved-model', max_wall_clock_sec: 300,
  max_steps: 12, required_artifacts: ['answer.txt'], fenced_history_ref: 'synthetic-history'});
const fixture = () => ({job_spec: job(), effort: 'medium', observed_cli_version: '1.4.3',
  executable_reference: '/synthetic/explicit-cli', prompt_bytes: encode('synthetic prompt'),
  task_deadline_ms: 301000, observed_now_ms: 1000,
  policy_data: {allowed_models: ['synthetic-approved-model'], allowed_efforts: ['medium'], quota_available: true}});
const decodeInput = payload => ({raw_payload_bytes: encode(payload), max_response_bytes: caps.max_stdout_bytes,
  wrapper_exit_code: 0, wrapper_signal: null, wrapper_wall_ms: null});
function reject(spec, status) {
  const result = prepareAgyArgv(spec, caps);
  assert.deepEqual(result, {runtime_admitted: false, status, argv: null, timeout_minutes: null, diagnostic: status});
}

test('prompt inclusive byte caps and non-BMP scalars are exact, never UTF16 lengths', () => {
  assert.deepEqual(validateAgyPrompt(encode('x'), caps), {valid: true, byte_length: 1, diagnostic: 'VALID'});
  assert.equal(validateAgyPrompt(encode('x'.repeat(32768)), caps).valid, true);
  assert.equal(validateAgyPrompt(encode('x'.repeat(32769)), caps).diagnostic, 'PROMPT_SIZE_EXCEEDED');
  assert.deepEqual(validateAgyPrompt(encode('😀'.repeat(10)), caps), {valid: true, byte_length: 40, diagnostic: 'VALID'});
  assert.equal(validateAgyPrompt(new Uint8Array(), caps).diagnostic, 'EMPTY_INPUT');
});
test('plain backslash-u prompt text is preserved; BOM NUL and actual surrogate bytes reject', () => {
  const spec = fixture(); spec.prompt_bytes = encode('literal \\uD800 and \\u0041 😀');
  assert.equal(prepareAgyArgv(spec, caps).argv[2], 'literal \\uD800 and \\u0041 😀');
  for (const [raw, diagnostic] of [
    [[0xef, 0xbb, 0xbf, 65], 'MALFORMED_INPUT_BOM'], [[65, 0, 66], 'MALFORMED_INPUT_NUL'],
    [[0xed, 0xa0, 0x80], 'MALFORMED_INPUT_SURROGATE'], [[0xff], 'MALFORMED_UTF8']]) {
    const value = new Uint8Array(raw);
    assert.equal(validateAgyPrompt(value, caps).diagnostic, diagnostic);
    reject({...fixture(), prompt_bytes: value}, 'PROMPT_VALIDATION_FAILED');
  }
});
test('exact argv is closed, standalone flags required, input spec and budget unchanged', () => {
  const spec = fixture(), prior = structuredClone(spec);
  const result = prepareAgyArgv(spec, caps);
  assert.deepEqual(result.argv, ['/synthetic/explicit-cli', '--prompt', 'synthetic prompt', '--output-format', 'json',
    '--model', 'synthetic-approved-model', '--effort', 'medium', '--print-timeout', '4m', '--sandbox', '--disable-slash-commands']);
  assert.equal(result.runtime_admitted, false); assert.equal(result.status, 'PREPARED_NOT_EXECUTABLE');
  assert.deepEqual(spec, prior); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.argv));
  assert.equal(result.timeout_minutes, 4);
  assert.equal(result.argv.includes('--max-steps'), false);
});
test('version mismatch has no update fallback or executable default', () => {
  for (const version of ['1.4.4', '1.4.2', '', null]) reject({...fixture(), observed_cli_version: version}, 'VERSION_MISMATCH_FAIL_CLOSED');
  assert.throws(() => prepareAgyArgv({...fixture(), executable_reference: ''}, caps));
  const spec = fixture(); delete spec.executable_reference;
  assert.throws(() => prepareAgyArgv(spec, caps));
});
test('explicit original deadline quantizes wait without resetting budget or inventing TIMEOUT', () => {
  for (const remaining of [-1, 0, 74999]) reject({...fixture(), task_deadline_ms: 100000, observed_now_ms: 100000 - remaining}, 'BUDGET_INSUFFICIENT_FOR_PROFILE');
  for (const [remaining, minutes] of [[75000, 1], [134999, 1], [135000, 2], [300000, 4]]) {
    const result = prepareAgyArgv({...fixture(), task_deadline_ms: remaining, observed_now_ms: 0}, caps);
    assert.equal(result.timeout_minutes, minutes); assert.equal(result.argv[10], `${minutes}m`);
  }
  for (const [key, value] of [['task_deadline_ms', 0], ['task_deadline_ms', 1.5], ['observed_now_ms', -1], ['observed_now_ms', NaN]])
    reject({...fixture(), [key]: value}, 'INVALID_TIME_VALUE');
});
test('full JobSpec alias validates required and optional fields; no effort grafting', () => {
  for (const key of ['required_artifacts', 'max_steps', 'task_scope', 'job_id']) {
    const spec = fixture(); delete spec.job_spec[key]; assert.throws(() => prepareAgyArgv(spec, caps));
  }
  assert.throws(() => prepareAgyArgv({...fixture(), job_spec: {...job(), effort: 'medium'}}, caps));
  reject({...fixture(), job_spec: {...job(), provider_id: 'native_codex'}}, 'INVALID_MODEL');
  assert.equal(prepareAgyArgv({...fixture(), job_spec: {...job(), fenced_history_ref: 'other-history'}}, caps).status, 'PREPARED_NOT_EXECUTABLE');
});
test('caller model, effort and policy snapshots fail closed without defaults or quota claims', () => {
  reject({...fixture(), job_spec: {...job(), requested_model: 'unapproved'}}, 'INVALID_MODEL');
  for (const effort of [undefined, null, 'ultra', 'high']) reject({...fixture(), effort}, 'INVALID_EFFORT');
  const missing = fixture(); delete missing.effort; reject(missing, 'INVALID_EFFORT');
  const missingPolicy = fixture(); delete missingPolicy.policy_data; reject(missingPolicy, 'INVALID_POLICY_DATA');
  reject({...fixture(), policy_data: {...fixture().policy_data, quota_available: false}}, 'QUOTA_EXHAUSTED');
  for (const policy_data of [null, {}, {allowed_models: ['synthetic-approved-model'], allowed_efforts: ['medium'], quota_available: 1},
    {...fixture().policy_data, extra: true}, {...fixture().policy_data, allowed_efforts: ['ultra']}])
    reject({...fixture(), policy_data}, 'INVALID_POLICY_DATA');
});
test('closed input rejects flags, shell wrappers, getters and proxies without running traps', () => {
  for (const key of ['argv', 'shell', 'sandbox', 'session', 'extra_flags']) assert.throws(() => prepareAgyArgv({...fixture(), [key]: true}, caps));
  let traps = 0;
  const proxy = new Proxy({}, {ownKeys() { traps++; throw Error(); }});
  assert.throws(() => prepareAgyArgv(proxy, caps));
  reject({...fixture(), policy_data: proxy}, 'INVALID_POLICY_DATA');
  const getter = fixture(); Object.defineProperty(getter, 'effort', {get() {traps++; return 'high';}});
  assert.throws(() => prepareAgyArgv(getter, caps));
  const models = ['synthetic-approved-model']; Object.defineProperty(models, 0, {get() {traps++; return 'synthetic-approved-model';}});
  reject({...fixture(), policy_data: {...fixture().policy_data, allowed_models: models}}, 'INVALID_POLICY_DATA');
  assert.equal(traps, 0);
});
test('fixed caps reject widening narrowing omissions and alternate decoder budget', () => {
  for (const key of Object.keys(caps)) {
    for (const change of [-1, 1]) assert.throws(() => validateAgyPrompt(encode('x'), {...caps, [key]: caps[key] + change}));
  }
  assert.throws(() => prepareAgyArgv(fixture(), undefined));
  assert.throws(() => decodeAgyJson({...decodeInput('{}'), max_response_bytes: 65536}));
  assert.throws(() => decodeAgyJson({...decodeInput('{}'), max_response_bytes: 1048577}));
});
test('profile stdout cap is inclusive and overrun never accepts prefix', () => {
  const payload = '{"status":"SUCCESS","ignored":"' + 'x'.repeat(1048576 - 33) + '"}';
  assert.equal(encode(payload).length, 1048576);
  assert.equal(decodeAgyJson(decodeInput(payload)).provider_reported_status, 'SUCCESS');
  const result = decodeAgyJson(decodeInput(payload + ' '));
  assert.equal(result.diagnostic_code, 'PAYLOAD_SIZE_EXCEEDED'); assert.equal(result.usage, null);
  const tiny = decodeAgyJson(decodeInput('{}'));
  assert.equal(tiny.diagnostic_code, 'UNRECOGNIZED_STATUS'); assert.equal(tiny.provider_reported_status, null);
  assert.equal(tiny.task_outcome_evaluated, false);
});
test('profile stdout rejects unpaired escapes even in ignored values or keys', () => {
  for (const json of ['{"status":"SUCCESS","ignored":"\\uD800"}', '{"status":"SUCCESS","\\uDC00":1}',
    '{"status":"SUCCESS","ignored":["\\uD800x"]}']) {
    const result = decodeAgyJson(decodeInput(json));
    assert.equal(result.diagnostic_code, 'MALFORMED_JSON'); assert.equal(result.usage, null);
    assert.equal(result.provider_reported_status, null);
  }
  assert.equal(decodeAgyJson(decodeInput('{"status":"SUCCESS","ignored":"\\uD83D\\uDE00"}')).provider_reported_status, 'SUCCESS');
});
test('profile stdout preserves base duplicate UTF8 root trailing and counter semantics', () => {
  for (const [json, diagnostic] of [['{"status":"SUCCESS","\\u0073tatus":"ERROR"}', 'DUPLICATE_KEY_CONFLICT'],
    ['[]', 'INVALID_ROOT_SHAPE'], ['{"status":"SUCCESS"}{}', 'MALFORMED_JSON'], ['{"status":', 'MALFORMED_JSON']])
    assert.equal(decodeAgyJson(decodeInput(json)).diagnostic_code, diagnostic);
  assert.equal(decodeAgyJson({...decodeInput('{}'), raw_payload_bytes: new Uint8Array([255, 254])}).diagnostic_code, 'MALFORMED_UTF8');
  assert.equal(decodeAgyJson(decodeInput('\uFEFF{}')).diagnostic_code, 'MALFORMED_JSON');
  const result = decodeAgyJson({...decodeInput('{"status":"SUCCESS","usage":{"thinking_tokens":0,"total_tokens":99}}'), wrapper_exit_code: 7});
  assert.equal(result.usage.thinking, 0); assert.equal(result.usage.total, 99); assert.equal(result.raw_wrapper.exit_code, 7);
  assert.equal(result.task_outcome_evaluated, false); assert.equal(result.extra_metadata.backend_model, 'UNKNOWN');
});
test('stderr count-only seam is inclusive and retains no text; env policy is data only', () => {
  assert.equal(isAgyStderrByteCountWithinLimit(65536, caps), true);
  assert.equal(isAgyStderrByteCountWithinLimit(65537, caps), false);
  assert.equal(isAgyStderrByteCountWithinLimit(0, caps), true);
  for (const count of [-1, '65536', 1.5]) assert.throws(() => isAgyStderrByteCountWithinLimit(count, caps));
  assert.deepEqual(AGY_CHILD_ENV_DELETIONS, ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL']);
  assert.ok(Object.isFrozen(AGY_CHILD_ENV_DELETIONS));
});

test('profile decoder preserves base boundary errors without evaluating getters or proxies', () => {
  let traps = 0;
  const invalid = [{}, {...decodeInput('{}'), raw_payload_bytes: '{}'},
    new Proxy({}, {ownKeys() {traps++; throw Error();}}),
    {...decodeInput('{}'), raw_payload_bytes: new Proxy(new Uint8Array(), {get() {traps++; throw Error();}})}];
  const accessor = decodeInput('{}');
  Object.defineProperty(accessor, 'raw_payload_bytes', {get() {traps++; return encode('{}');}});
  invalid.push(accessor);
  const missing = decodeInput('{}'); delete missing.wrapper_exit_code; invalid.push(missing);
  for (const value of invalid) assert.throws(() => decodeAgyJson(value), error => error.code === 'INVALID_WRAPPER_OBSERVATION');
  assert.equal(traps, 0);
});
