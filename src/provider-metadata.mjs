// Pure bounded metadata decoding only. No launcher, provider, clock or custody authority.
import {types} from 'node:util';
import {closed, ContractError, nonnegative, own} from './job-spec.mjs';

const inputKeys = ['raw_payload_bytes', 'max_response_bytes', 'wrapper_exit_code',
  'wrapper_signal', 'wrapper_wall_ms'];
const signals = new Set(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT',
  'SIGBUS', 'SIGFPE', 'SIGKILL', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM',
  'SIGTERM', 'SIGCHLD', 'SIGCONT', 'SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU',
  'SIGURG', 'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM', 'SIGPROF', 'SIGWINCH', 'SIGIO', 'SIGSYS']);
const statuses = new Set(['SUCCESS', 'ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING']);
const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;

function boundary(input) {
  try {
    closed(input, inputKeys, [], 'DecoderInput');
    if (!Number.isSafeInteger(input.max_response_bytes) || input.max_response_bytes <= 0 ||
        types.isProxy(input.raw_payload_bytes) || !types.isUint8Array(input.raw_payload_bytes)) throw 0;
    if (input.wrapper_exit_code !== null && !Number.isSafeInteger(input.wrapper_exit_code)) throw 0;
    if (input.wrapper_signal !== null && !signals.has(input.wrapper_signal)) throw 0;
    if (input.wrapper_wall_ms !== null && !nonnegative(input.wrapper_wall_ms)) throw 0;
    const raw_wrapper = Object.freeze({exit_code: input.wrapper_exit_code,
      signal: input.wrapper_signal, wall_duration_ms: input.wrapper_wall_ms});
    // Length is checked before copying or decoding. Never invoke caller-defined properties.
    const size = byteLength.call(input.raw_payload_bytes);
    if (size > input.max_response_bytes) return {raw_wrapper, oversized: true};
    // Copy explicitly into a fresh intrinsic view; no species/user constructor callbacks.
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) bytes[i] = input.raw_payload_bytes[i];
    return {raw_wrapper, bytes};
  } catch {
    throw new ContractError('INVALID_WRAPPER_OBSERVATION', 'DecoderInput');
  }
}

function output(wrapper, diagnostic, status = null, usage = null, duration = null, reasoning = null, structural = false) {
  return Object.freeze({
    parser_status: structural ? 'PARSE_ERROR' : diagnostic === 'PARSE_OK' ? 'OK' : 'OK_WITH_FIELD_DIAGNOSTIC',
    diagnostic_code: diagnostic, provider_reported_status: status, raw_wrapper: wrapper,
    duration_seconds: duration, usage: usage === null ? null : Object.freeze(usage),
    extra_metadata: Object.freeze({codex_reasoning_output_tokens: reasoning, backend_model: 'UNKNOWN'}),
    task_outcome_evaluated: false
  });
}

// JSON.parse establishes grammar first. This iterative lexical pass then checks every
// object's decoded keys, including objects in ignored fields, without recursive descent.
function parseObject(text) {
  let value;
  try { value = JSON.parse(text); } catch { return {error: 'MALFORMED_JSON'}; }
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const start = i;
      while (++i < text.length) {
        if (text[i] === '\\') i++;
        else if (text[i] === '"') break;
      }
      const frame = stack.at(-1);
      if (frame?.keys && frame.expectKey) {
        const key = JSON.parse(text.slice(start, i + 1));
        if (frame.keys.has(key)) return {error: 'DUPLICATE_KEY_CONFLICT'};
        frame.keys.add(key); frame.expectKey = false;
      }
    } else if (char === '{') stack.push({keys: new Set(), expectKey: true});
    else if (char === '[') stack.push({});
    else if (char === '}' || char === ']') stack.pop();
    else if (char === ',' && stack.at(-1)?.keys) stack.at(-1).expectKey = true;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {error: 'INVALID_ROOT_SHAPE'};
  return {value};
}

function decode(input, codex) {
  const captured = boundary(input);
  const error = code => output(captured.raw_wrapper, code, null, null, null, null, true);
  if (captured.oversized) return error('PAYLOAD_SIZE_EXCEEDED');
  let text;
  try { text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(captured.bytes); }
  catch { return error('MALFORMED_UTF8'); }
  let envelope, status;
  if (codex) {
    const terminals = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const parsed = parseObject(line);
      if (parsed.error) return error(parsed.error);
      if (own(parsed.value, 'type') && (parsed.value.type === 'turn.completed' || parsed.value.type === 'turn.failed')) terminals.push(parsed.value);
    }
    if (!terminals.length) return error('MISSING_TERMINAL');
    if (terminals.length > 1) return error(new Set(terminals.map(item => item.type)).size > 1 ?
      'CONFLICTING_TERMINAL_EVENTS' : 'REPEATED_TERMINAL_REJECTED');
    envelope = terminals[0]; status = envelope.type;
  } else {
    const parsed = parseObject(text);
    if (parsed.error) return error(parsed.error);
    envelope = parsed.value; status = own(envelope, 'status') && statuses.has(envelope.status) ? envelope.status : null;
  }
  let invalid = false;
  const usage = {input: null, output: null, cache_read: null, thinking: null, total: null};
  let source = null;
  if ((!codex || status === 'turn.completed') && own(envelope, 'usage')) {
    if (envelope.usage && typeof envelope.usage === 'object' && !Array.isArray(envelope.usage)) source = envelope.usage;
    else invalid = true;
  }
  const counter = key => {
    if (!source || !own(source, key)) return null;
    if (!nonnegative(source[key])) { invalid = true; return null; }
    return source[key];
  };
  usage.input = counter('input_tokens'); usage.output = counter('output_tokens');
  usage.cache_read = counter(codex ? 'cached_input_tokens' : 'cache_read_tokens');
  let reasoning = null, duration = null;
  if (codex) reasoning = counter('reasoning_output_tokens');
  else {
    usage.thinking = counter('thinking_tokens'); usage.total = counter('total_tokens');
    if (own(envelope, 'duration_seconds')) {
      if (typeof envelope.duration_seconds === 'number' && Number.isFinite(envelope.duration_seconds) && envelope.duration_seconds >= 0)
        duration = envelope.duration_seconds;
      else invalid = true;
    }
  }
  // The accepted closed diagnostic vocabulary uses the numeric-field diagnostic
  // for duration too. Unknown status takes precedence without discarding counters.
  const diagnostic = status === null ? 'UNRECOGNIZED_STATUS' : invalid ? 'INVALID_USAGE_COUNTER' : 'PARSE_OK';
  return output(captured.raw_wrapper, diagnostic, status, usage, duration, reasoning);
}

export const decodeAgyJson = input => decode(input, false);
export const decodeCodexJsonl = input => decode(input, true);
