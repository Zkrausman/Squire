// Source-only AGY profile preparation. This module never launches or admits execution.
import {types} from 'node:util';
import {closed, ContractError, fail, nonnegative, own, text, validateJobSpec} from './job-spec.mjs';
import {decodeAgyJson as decodeMetadata} from './provider-metadata.mjs';

export const AGY_BYTE_LIMITS = Object.freeze({max_prompt_bytes: 32768, max_stdout_bytes: 1048576, max_stderr_bytes: 65536});
export const AGY_CHILD_ENV_DELETIONS = Object.freeze(['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL']);
const lengthOf = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const efforts = ['low', 'medium', 'high'];
function limits(value) {
  closed(value, Object.keys(AGY_BYTE_LIMITS), [], 'ByteLimits');
  for (const key of Object.keys(AGY_BYTE_LIMITS)) if (value[key] !== AGY_BYTE_LIMITS[key]) fail('ByteLimits');
}
function bytes(value, cap) {
  if (types.isProxy(value) || !types.isUint8Array(value)) fail('payload_bytes');
  const length = lengthOf.call(value);
  if (length > cap) return {length, captured: null};
  const captured = new Uint8Array(length);
  for (let i = 0; i < length; i++) captured[i] = value[i];
  return {length, captured};
}
function prompt(value, bounds) {
  limits(bounds);
  const {length, captured} = bytes(value, AGY_BYTE_LIMITS.max_prompt_bytes);
  let diagnostic = 'VALID', decoded = null;
  if (!length) diagnostic = 'EMPTY_INPUT';
  else if (!captured) diagnostic = 'PROMPT_SIZE_EXCEEDED';
  else if (captured[0] === 0xef && captured[1] === 0xbb && captured[2] === 0xbf) diagnostic = 'MALFORMED_INPUT_BOM';
  else if (captured.includes(0)) diagnostic = 'MALFORMED_INPUT_NUL';
  else {
    // UTF-8 encodings of surrogate codepoints receive the profile's specific diagnostic.
    for (let i = 0; i + 2 < captured.length; i++) {
      if (captured[i] === 0xed && captured[i + 1] >= 0xa0 && captured[i + 1] <= 0xbf &&
          captured[i + 2] >= 0x80 && captured[i + 2] <= 0xbf) diagnostic = 'MALFORMED_INPUT_SURROGATE';
    }
    if (diagnostic === 'VALID') {
      try {
        decoded = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(captured);
        if (decoded.includes('\uFEFF')) diagnostic = 'MALFORMED_INPUT_BOM';
      }
      catch { diagnostic = 'MALFORMED_UTF8'; }
    }
  }
  return {result: Object.freeze({valid: diagnostic === 'VALID', byte_length: length, diagnostic}), decoded};
}
export const validateAgyPrompt = (promptBytes, bounds) => prompt(promptBytes, bounds).result;
// Count-only seam: callers discard content. This does not collect or drain a stream.
export function isAgyStderrByteCountWithinLimit(count, bounds) {
  limits(bounds);
  if (!nonnegative(count)) fail('stderr_byte_count');
  return count <= AGY_BYTE_LIMITS.max_stderr_bytes;
}

function stringList(value, field, allow) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(field);
  const length = Object.getOwnPropertyDescriptor(value, 'length').value;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1 || keys.some(key => typeof key !== 'string' ||
      key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) fail(field);
  const result = [];
  for (let i = 0; i < length; i++) {
    const item = Object.getOwnPropertyDescriptor(value, String(i));
    if (!item || !own(item, 'value') || !text(item.value) || allow && !allow.includes(item.value)) fail(field);
    result.push(item.value);
  }
  return result;
}
function policy(value) {
  closed(value, ['allowed_models', 'allowed_efforts', 'quota_available'], [], 'policy_data');
  if (typeof value.quota_available !== 'boolean') fail('policy_data');
  return {models: stringList(value.allowed_models, 'allowed_models'),
    efforts: stringList(value.allowed_efforts, 'allowed_efforts', efforts), quota: value.quota_available};
}
function preparation(status, argv = null, timeout = null) {
  return Object.freeze({runtime_admitted: false, status, argv: argv === null ? null : Object.freeze(argv),
    timeout_minutes: timeout, diagnostic: status});
}
export function prepareAgyArgv(spec, bounds) {
  limits(bounds);
  closed(spec, ['job_spec', 'observed_cli_version', 'executable_reference', 'prompt_bytes',
    'task_deadline_ms', 'observed_now_ms'], ['effort', 'policy_data'], 'AgyPreparationSpec');
  const job = validateJobSpec(spec.job_spec);
  if (!text(spec.executable_reference)) fail('executable_reference');
  if (spec.observed_cli_version !== '1.4.3') return preparation('VERSION_MISMATCH_FAIL_CLOSED');
  let allowed;
  try { allowed = policy(spec.policy_data); } catch { return preparation('INVALID_POLICY_DATA'); }
  if (job.provider_id !== 'agy_gemini' || !allowed.models.includes(job.requested_model)) return preparation('INVALID_MODEL');
  if (!efforts.includes(spec.effort) || !allowed.efforts.includes(spec.effort)) return preparation('INVALID_EFFORT');
  if (!allowed.quota) return preparation('QUOTA_EXHAUSTED');
  if (!Number.isSafeInteger(spec.task_deadline_ms) || spec.task_deadline_ms <= 0 || !nonnegative(spec.observed_now_ms))
    return preparation('INVALID_TIME_VALUE');
  const remaining = spec.task_deadline_ms - spec.observed_now_ms;
  if (remaining < 75000) return preparation('BUDGET_INSUFFICIENT_FOR_PROFILE');
  const validated = prompt(spec.prompt_bytes, bounds);
  if (!validated.result.valid) return preparation('PROMPT_VALIDATION_FAILED');
  const timeout = Math.floor((remaining - 15000) / 60000);
  return preparation('PREPARED_NOT_EXECUTABLE', [spec.executable_reference, '--prompt', validated.decoded,
    '--output-format', 'json', '--model', job.requested_model, '--effort', spec.effort,
    '--print-timeout', `${timeout}m`, '--sandbox', '--disable-slash-commands'], timeout);
}

function malformed(result, code) {
  return Object.freeze({...result, parser_status: 'PARSE_ERROR', diagnostic_code: code,
    provider_reported_status: null, usage: null, duration_seconds: null});
}
function unpaired(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
// Profile facade tightens stdout encoding/caps without changing the general metadata seam.
export function decodeAgyJson(input) {
  try {
    closed(input, ['raw_payload_bytes', 'max_response_bytes', 'wrapper_exit_code', 'wrapper_signal', 'wrapper_wall_ms'], [], 'DecoderInput');
  } catch { throw new ContractError('INVALID_WRAPPER_OBSERVATION', 'DecoderInput'); }
  if (input.max_response_bytes !== AGY_BYTE_LIMITS.max_stdout_bytes) fail('max_response_bytes');
  let captured;
  try { captured = bytes(input.raw_payload_bytes, AGY_BYTE_LIMITS.max_stdout_bytes); }
  catch { throw new ContractError('INVALID_WRAPPER_OBSERVATION', 'DecoderInput'); }
  const result = decodeMetadata({...input, raw_payload_bytes: captured.captured ?? input.raw_payload_bytes});
  if (result.parser_status === 'PARSE_ERROR') return result;
  if (captured.length < 2 || captured.captured.includes(0)) return malformed(result, 'MALFORMED_JSON');
  // Base validation has already established fatal UTF8, object grammar and unique keys.
  const decoded = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(captured.captured);
  if (decoded.includes('\uFEFF')) return malformed(result, 'MALFORMED_JSON');
  const value = JSON.parse(decoded);
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string') { if (unpaired(current)) return malformed(result, 'MALFORMED_JSON'); }
    else if (current && typeof current === 'object') {
      for (const key of Object.keys(current)) {
        if (unpaired(key)) return malformed(result, 'MALFORMED_JSON');
        pending.push(current[key]);
      }
    }
  }
  return result;
}
