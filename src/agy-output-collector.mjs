// Caller-driven injected observation only: no producer, pump, timer or custody action.
import {types} from 'node:util';
import {closed, fail, nonnegative, own} from './job-spec.mjs';
import {decodeAgyJson} from './agy-profile.mjs';

const OUT = 1048576, ERR = 65536;
const NativePromise = Promise, nativePromisePrototype = Promise.prototype;
const nativeThen = Promise.prototype.then;
const nativeSpecies = Object.getOwnPropertyDescriptor(Promise, Symbol.species).get;
function observeOrdinaryPromise(result) {
  // Native then consults constructor/species. Do not execute arbitrary accessors.
  if (Object.getPrototypeOf(result) !== nativePromisePrototype) return;
  const ownConstructor = Object.getOwnPropertyDescriptor(result, 'constructor');
  const constructor = Object.getOwnPropertyDescriptor(nativePromisePrototype, 'constructor');
  const species = Object.getOwnPropertyDescriptor(NativePromise, Symbol.species);
  if (ownConstructor && (!own(ownConstructor, 'value') || ownConstructor.value !== NativePromise) ||
      constructor?.value !== NativePromise || species?.get !== nativeSpecies) return;
  Reflect.apply(nativeThen, result, [() => undefined, () => undefined]);
}
const reasons = ['USER_ABORT', 'TASK_DEADLINE_EXPIRED', 'TIMEOUT', 'SYSTEM_SHUTDOWN', 'STREAM_ERROR', 'CAPACITY_EXCEEDED'];
const statuses = ['SUCCESS', 'ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING'];
const signalNames = ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGBUS', 'SIGFPE',
  'SIGKILL', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGCHLD', 'SIGCONT',
  'SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM', 'SIGPROF', 'SIGWINCH', 'SIGIO', 'SIGSYS'];
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const getLength = Object.getOwnPropertyDescriptor(typed, 'byteLength').get;
const getBuffer = Object.getOwnPropertyDescriptor(typed, 'buffer').get;
function binding(value) {
  closed(value, ['job_id', 'unit_name', 'invocation_id'], [], 'collector_binding');
  if (typeof value.job_id !== 'string' || typeof value.unit_name !== 'string' ||
      !/^squire-[a-zA-Z0-9-]+\.service$/.test(value.unit_name) || typeof value.invocation_id !== 'string' ||
      !/^[a-fA-F0-9]{32}$/.test(value.invocation_id) || /^0+$/.test(value.invocation_id)) fail('collector_binding');
  return Object.freeze({...value});
}
function raw(value) {
  closed(value, ['exit_code', 'signal', 'wall_ms'], [], 'raw_exit');
  if (value.exit_code !== null && !Number.isSafeInteger(value.exit_code) ||
      value.signal !== null && !signalNames.includes(value.signal) || value.wall_ms !== null && !nonnegative(value.wall_ms)) fail('raw_exit');
  return Object.freeze({...value});
}
function chunk(value, copy) {
  if (types.isProxy(value) || !types.isUint8Array(value) || types.isSharedArrayBuffer(getBuffer.call(value))) fail('chunk');
  const size = getLength.call(value);
  if (!copy || size > OUT) return {view: null, size};
  const view = new Uint8Array(size);
  Uint8Array.prototype.set.call(view, value);
  return {view, size};
}
function metadata(value, wrapper) {
  closed(value, ['parser_status', 'diagnostic_code', 'provider_reported_status', 'raw_wrapper',
    'duration_seconds', 'usage', 'extra_metadata', 'task_outcome_evaluated'], [], 'metadata');
  if (!['OK', 'OK_WITH_FIELD_DIAGNOSTIC'].includes(value.parser_status) || value.task_outcome_evaluated !== false ||
      !['PARSE_OK', 'INVALID_USAGE_COUNTER', 'UNRECOGNIZED_STATUS'].includes(value.diagnostic_code) ||
      (value.parser_status === 'OK') !== (value.diagnostic_code === 'PARSE_OK') ||
      value.provider_reported_status !== null && !statuses.includes(value.provider_reported_status) ||
      (value.provider_reported_status === null) !== (value.diagnostic_code === 'UNRECOGNIZED_STATUS') ||
      value.duration_seconds !== null && (typeof value.duration_seconds !== 'number' || !Number.isFinite(value.duration_seconds) || value.duration_seconds < 0)) fail('metadata');
  closed(value.raw_wrapper, ['exit_code', 'signal', 'wall_duration_ms'], [], 'metadata_wrapper');
  if (value.raw_wrapper.exit_code !== wrapper.exit_code || value.raw_wrapper.signal !== wrapper.signal ||
      value.raw_wrapper.wall_duration_ms !== wrapper.wall_ms) fail('metadata_wrapper');
  const keys = ['input', 'output', 'cache_read', 'thinking', 'total'];
  closed(value.usage, keys, [], 'metadata_usage');
  if (keys.some(key => value.usage[key] !== null && !nonnegative(value.usage[key]))) fail('metadata_usage');
  closed(value.extra_metadata, ['codex_reasoning_output_tokens', 'backend_model'], [], 'metadata_extra');
  if (value.extra_metadata.codex_reasoning_output_tokens !== null || value.extra_metadata.backend_model !== 'UNKNOWN') fail('metadata_extra');
  return Object.freeze({...value, raw_wrapper: Object.freeze({...value.raw_wrapper}),
    usage: Object.freeze({...value.usage}), extra_metadata: Object.freeze({...value.extra_metadata})});
}

export function createAgyOutputCollector(config) {
  closed(config, ['binding', 'limits', 'clock', 'task_deadline_ms'], ['decoder'], 'CollectorConfig');
  const identity = binding(config.binding);
  closed(config.limits, ['max_stdout_bytes', 'max_stderr_bytes'], [], 'collector_limits');
  if (config.limits.max_stdout_bytes !== OUT || config.limits.max_stderr_bytes !== ERR) fail('collector_limits');
  closed(config.clock, ['now'], [], 'collector_clock');
  if (typeof config.clock.now !== 'function' || !Number.isSafeInteger(config.task_deadline_ms) || config.task_deadline_ms <= 0 ||
      own(config, 'decoder') && config.decoder !== undefined && typeof config.decoder !== 'function') fail('collector_config');
  const clockFunction = config.clock.now, clockReceiver = config.clock;
  const now = () => Reflect.apply(clockFunction, clockReceiver, []);
  const deadline = config.task_deadline_ms, decode = config.decoder ?? decodeAgyJson;
  let phase = 'COLLECTING', diagnostic = 'NONE', revision = 0, busy = false, attempted = false, lastClock = null;
  let arena = new Uint8Array(OUT), retained = 0, outCount = 0, errCount = 0, outOver = false, errOver = false;
  let outEof = false, errEof = false, exitObserved = false, wrapper = Object.freeze({exit_code: null, signal: null, wall_ms: null});
  let decoded = null, canceled = false, cancelReason = null, recommended = false, recommendation = null, sealed = false;
  const active = () => !sealed && phase !== 'FAULTED' && !canceled;
  const purge = () => { arena = null; retained = 0; decoded = null; };
  function advise(reason = 'STREAM_ERROR') {
    if (!recommended) { recommended = true; recommendation = reason; }
  }
  function fault(code, reason) {
    if (sealed) return;
    phase = 'FAULTED'; if (diagnostic === 'NONE') diagnostic = code;
    purge(); advise(reason); revision++;
  }
  function cancel(reason) {
    if (sealed) return;
    if (!canceled) { canceled = true; cancelReason = reason; }
    recommended = true; recommendation = cancelReason;
    fault('ABORT_LATCHED', cancelReason);
  }
  function close() {
    if (sealed) return;
    sealed = true; phase = 'CLOSED'; purge(); revision++;
  }
  function snapshot() {
    return Object.freeze({binding: identity, phase, stdout_bytes_observed_capped: outCount,
      stdout_retained_bytes: retained, stdout_saturated_over_cap: outOver, stderr_bytes_counted: errCount,
      stderr_saturated_over_cap: errOver, stdout_eof_observed: outEof, stderr_eof_observed: errEof,
      io_drained: outEof && errEof, raw_exit_observed: exitObserved, raw_wrapper: wrapper,
      decoded_metadata: decoded, diagnostic, cancellation_latched: canceled, cancellation_reason: cancelReason,
      recommend_owner_abort: Object.freeze({recommended, reason: recommendation}), local_closed: sealed,
      task_deadline_ms: deadline, decoding_attempted: attempted, state_revision: revision,
      runtime_qualification: 'NOT_ESTABLISHED_BY_SOURCE'});
  }
  const reply = (accepted, rejection_reason = 'NONE') => Object.freeze({accepted, rejection_reason, snapshot: snapshot()});
  // After every external callback, sealing/revision takes precedence over interpreting
  // its return value. A reentrant close can never gain a later deadline cancellation.
  function clockGate() {
    if (!active()) return false;
    const before = revision;
    let sample, valid = true;
    try { sample = now(); } catch { valid = false; }
    if (sealed || revision !== before || !active()) return false;
    if (!valid || !nonnegative(sample) || lastClock !== null && sample < lastClock) {
      fault('CLOCK_REGRESSION'); return false;
    }
    if (sample >= deadline) {
      if (!canceled) { canceled = true; cancelReason = 'TASK_DEADLINE_EXPIRED'; }
      recommended = true; recommendation = cancelReason;
      fault('TASK_DEADLINE_EXPIRED', cancelReason); return false;
    }
    lastClock = sample; return true;
  }
  function capture(event) {
    closed(event, ['type', 'binding'], ['stream_offset', 'chunk', 'stream', 'code', 'raw_exit'], 'collector_event');
    const actual = binding(event.binding);
    if (Object.keys(identity).some(key => identity[key] !== actual[key])) fail('collector_event_binding');
    const fields = {stdout_chunk: ['stream_offset', 'chunk'], stderr_chunk: ['stream_offset', 'chunk'],
      stdout_eof: ['stream_offset'], stderr_eof: ['stream_offset'], stream_error: ['stream', 'code'],
      raw_exit: ['raw_exit'], tick: [], abort: ['code'], close: []};
    if (typeof event.type !== 'string' || !own(fields, event.type)) fail('collector_event');
    closed(event, ['type', 'binding', ...fields[event.type]], [], 'collector_event');
    const result = {type: event.type};
    if (event.type === 'abort' || event.type === 'stream_error') {
      if (!reasons.includes(event.code)) fail('collector_event_code'); result.code = event.code;
    }
    if (event.type === 'stream_error') {
      if (!['stdout', 'stderr'].includes(event.stream)) fail('collector_stream');
      result.stream = event.stream;
    }
    if (own(event, 'stream_offset')) {
      if (!nonnegative(event.stream_offset)) fail('stream_offset'); result.offset = event.stream_offset;
    }
    if (own(event, 'chunk')) result.chunk = chunk(event.chunk, event.type === 'stdout_chunk' && active() && !busy);
    if (event.type === 'raw_exit') result.raw = raw(event.raw_exit);
    return result;
  }
  function applyEvent(input) {
    let event;
    try { event = capture(input); } catch { return reply(false, 'BINDING_MISMATCH'); }
    if (sealed) return reply(false, 'ALREADY_CLOSED');
    if (event.type === 'close') { close(); return reply(true); }
    let ignored = false;
    if (event.type === 'abort') cancel(event.code);
    if (event.type === 'raw_exit') {
      if (!exitObserved) { wrapper = event.raw; exitObserved = true; revision++; }
      else if (Object.keys(wrapper).every(key => wrapper[key] === event.raw[key])) ignored = true;
      else fault('CONFLICTING_WRAPPER_EXIT');
    }
    if (busy) { fault('REENTRANT_CALL'); return reply(false, 'REENTRANT_CALL'); }
    busy = true;
    try {
      if (clockGate() && active()) {
      const stdout = event.type.startsWith('stdout_');
      if (event.type.endsWith('_chunk') || event.type.endsWith('_eof')) {
        const expected = stdout ? outCount : errCount, eof = stdout ? outEof : errEof;
        if (event.type.endsWith('_chunk') && eof) fault('CHUNK_AFTER_EOF');
        else if (event.offset !== expected) fault('STREAM_OFFSET_MISMATCH');
        else if (event.type.endsWith('_eof')) {
          if (eof) ignored = true;
          else if (stdout) outEof = true; else errEof = true;
          if (outEof && errEof) phase = 'IO_DRAINED';
        } else if (stdout) {
          if (event.chunk.size > OUT - outCount) {
            outCount = OUT + 1; outOver = true; fault('PAYLOAD_SIZE_EXCEEDED', 'CAPACITY_EXCEEDED');
          } else {
            Uint8Array.prototype.set.call(arena, event.chunk.view, retained);
            outCount += event.chunk.size; retained += event.chunk.size;
          }
        } else {
          if (event.chunk.size > ERR - errCount) {
            errCount = ERR + 1; errOver = true; fault('STDERR_SIZE_EXCEEDED', 'CAPACITY_EXCEEDED');
          } else errCount += event.chunk.size;
        }
      } else if (event.type === 'stream_error') fault('STREAM_READ_ERROR', event.code);
      }
    } finally { busy = false; if (!sealed) revision++; }
    return reply(!ignored, ignored ? 'IDEMPOTENT_IGNORED' : 'NONE');
  }
  function drainAndDecode() {
    if (!active() || phase !== 'IO_DRAINED' || !exitObserved || diagnostic !== 'NONE') return null;
    if (busy) { if (!attempted) { attempted = true; revision++; } fault('REENTRANT_CALL'); return null; }
    if (!attempted && arena === null) return null;
    busy = true;
    try {
      if (attempted) return clockGate() && active() ? decoded : null;
      attempted = true; revision++;
      if (!clockGate()) return null;
      const before = revision;
      const input = {raw_payload_bytes: arena.slice(0, retained), max_response_bytes: OUT,
        wrapper_exit_code: wrapper.exit_code, wrapper_signal: wrapper.signal, wrapper_wall_ms: wrapper.wall_ms};
      let result;
      try { result = decode(input); }
      catch { fault('DECODE_ERROR'); return null; }
      // Mitigate ordinary native rejected Promises even after close/abort.
      // Exotic constructor/species are outside the synchronous decoder contract;
      // they remain rejected without accessing their getters or promising containment.
      if (types.isPromise(result)) {
        try { observeOrdinaryPromise(result); } catch {}
        fault('DECODE_ERROR'); return null;
      }
      if (sealed || revision !== before || !active()) return null;
      if (!clockGate() || revision !== before || !active()) return null;
      let accepted;
      try { accepted = metadata(result, wrapper); }
      catch { fault('DECODE_ERROR'); return null; }
      decoded = accepted; arena = null; retained = 0; revision++;
      return decoded;
    } finally { busy = false; }
  }
  return Object.freeze({applyEvent, drainAndDecode, snapshot, close});
}
