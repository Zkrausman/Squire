import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgyOutputCollector} from '../src/agy-output-collector.mjs';
import {decodeAgyJson} from '../src/agy-profile.mjs';
const binding = Object.freeze({job_id: 'synthetic-job', unit_name: 'squire-collector.service', invocation_id: 'a'.repeat(32)});
const limits = Object.freeze({max_stdout_bytes: 1048576, max_stderr_bytes: 65536});
const encode = s => new TextEncoder().encode(s);
const payload = encode('{"status":"SUCCESS","usage":{"input_tokens":5,"thinking_tokens":0,"total_tokens":8}}');
const event = (type, fields = {}) => ({type, binding, ...fields});
function fixture(extra = {}) {
  let now = 0, calls = 0, hook = null;
  const clock = {now() { calls++; return hook ? hook() : now; }};
  const collector = createAgyOutputCollector({binding, limits, clock, task_deadline_ms: 1000, ...extra});
  return {collector, setNow: n => {now = n;}, setHook: h => {hook = h;}, clockCalls: () => calls};
}
function feed(c, bytes = payload, exitFirst = false) {
  if (exitFirst) c.applyEvent(event('raw_exit', {raw_exit: {exit_code: 0, signal: null, wall_ms: 12}}));
  c.applyEvent(event('stdout_chunk', {stream_offset: 0, chunk: bytes}));
  c.applyEvent(event('stdout_eof', {stream_offset: bytes.length}));
  c.applyEvent(event('stderr_eof', {stream_offset: 0}));
  if (!exitFirst) c.applyEvent(event('raw_exit', {raw_exit: {exit_code: 0, signal: null, wall_ms: 12}}));
}
function faulted(c, diagnostic) {
  const s = c.snapshot(); assert.equal(s.phase, 'FAULTED'); assert.equal(s.diagnostic, diagnostic);
  assert.equal(s.stdout_retained_bytes, 0); assert.equal(s.decoded_metadata, null); return s;
}

test('drain and raw exit are independent gates in either arrival order, decode at most once', () => {
  for (const exitFirst of [false, true]) {
    let decoded = 0;
    const {collector: c} = fixture({decoder(input) {decoded++; return decodeAgyJson(input);}});
    assert.equal(c.drainAndDecode(), null);
    feed(c, payload, exitFirst);
    assert.equal(c.snapshot().phase, 'IO_DRAINED'); assert.equal(c.snapshot().stdout_retained_bytes, payload.length);
    const result = c.drainAndDecode(); assert.equal(result.provider_reported_status, 'SUCCESS');
    assert.equal(result.usage.thinking, 0); assert.equal(result.raw_wrapper.exit_code, 0);
    assert.equal(c.snapshot().stdout_retained_bytes, 0); assert.equal(c.snapshot().stdout_bytes_observed_capped, payload.length);
    assert.equal(c.drainAndDecode(), result); assert.equal(decoded, 1);
    assert.equal(c.snapshot().runtime_qualification, 'NOT_ESTABLISHED_BY_SOURCE');
  }
});
test('exit before EOF never decodes; EOF without exit never decodes', () => {
  const {collector: c} = fixture();
  c.applyEvent(event('raw_exit', {raw_exit: {exit_code: null, signal: 'SIGTERM', wall_ms: null}}));
  assert.equal(c.drainAndDecode(), null); assert.equal(c.snapshot().decoding_attempted, false);
  c.applyEvent(event('stdout_chunk', {stream_offset: 0, chunk: payload}));
  c.applyEvent(event('stdout_eof', {stream_offset: payload.length}));
  assert.equal(c.drainAndDecode(), null);
  c.applyEvent(event('stderr_eof', {stream_offset: 0}));
  assert.deepEqual(c.drainAndDecode().raw_wrapper, {exit_code: null, signal: 'SIGTERM', wall_duration_ms: null});
  const second = fixture().collector;
  second.applyEvent(event('stdout_eof', {stream_offset: 0})); second.applyEvent(event('stderr_eof', {stream_offset: 0}));
  assert.equal(second.drainAndDecode(), null); assert.equal(second.snapshot().decoding_attempted, false);
});
test('stdout exact cap retains bounded bytes; cap plus one purges and saturates lower bound', () => {
  for (const size of [1048576, 1048577]) {
    const c = fixture().collector;
    c.applyEvent(event('stdout_chunk', {stream_offset: 0, chunk: new Uint8Array(size)}));
    const s = c.snapshot(); assert.equal(s.stdout_bytes_observed_capped, size);
    assert.equal(s.stdout_saturated_over_cap, size > 1048576);
    if (size > 1048576) {
      faulted(c, 'PAYLOAD_SIZE_EXCEEDED'); assert.equal(s.recommend_owner_abort.reason, 'CAPACITY_EXCEEDED');
      c.applyEvent(event('stdout_chunk', {stream_offset: size, chunk: new Uint8Array(100)}));
      assert.equal(c.snapshot().stdout_bytes_observed_capped, size);
    } else { assert.equal(s.stdout_retained_bytes, size); assert.equal(s.diagnostic, 'NONE'); }
  }
});
test('stderr exact cap is count-only; cap plus one drops existing stdout', () => {
  const c = fixture().collector;
  c.applyEvent(event('stdout_chunk', {stream_offset: 0, chunk: payload}));
  c.applyEvent(event('stderr_chunk', {stream_offset: 0, chunk: new Uint8Array(65536)}));
  assert.equal(c.snapshot().stderr_bytes_counted, 65536); assert.equal(c.snapshot().stdout_retained_bytes, payload.length);
  c.applyEvent(event('stderr_chunk', {stream_offset: 65536, chunk: new Uint8Array(1)}));
  const s = faulted(c, 'STDERR_SIZE_EXCEEDED'); assert.equal(s.stderr_bytes_counted, 65537);
  assert.equal(s.stderr_saturated_over_cap, true); assert.equal(JSON.stringify(s).includes('chunk'), false);
});
test('stdout defensively copied; split multibyte UTF8 validated only after full drain', () => {
  const c = fixture().collector, source = encode('{"status":"SUCCESS","ignored":"😀"}');
  const split = source.indexOf(0xf0) + 2;
  c.applyEvent(event('stdout_chunk', {stream_offset: 0, chunk: source.subarray(0, split)}));
  c.applyEvent(event('stdout_chunk', {stream_offset: split, chunk: source.subarray(split)}));
  source.fill(255);
  c.applyEvent(event('stdout_eof', {stream_offset: source.length})); c.applyEvent(event('stderr_eof', {stream_offset: 0}));
  c.applyEvent(event('raw_exit', {raw_exit: {exit_code: 0, signal: null, wall_ms: null}}));
  assert.equal(c.drainAndDecode().provider_reported_status, 'SUCCESS');
  const bad = fixture().collector; feed(bad, new Uint8Array([0xe2, 0x82]));
  assert.equal(bad.drainAndDecode(), null); faulted(bad, 'DECODE_ERROR');
});
test('zero chunks duplicate EOF and raw exit are idempotent; offsets cannot gap or replay', () => {
  const c = fixture().collector;
  c.applyEvent(event('stdout_chunk', {stream_offset: 0, chunk: new Uint8Array()}));
  assert.equal(c.snapshot().stdout_bytes_observed_capped, 0);
  c.applyEvent(event('stdout_eof', {stream_offset: 0}));
  assert.equal(c.applyEvent(event('stdout_eof', {stream_offset: 0})).rejection_reason, 'IDEMPOTENT_IGNORED');
  for (const offset of [0, 5]) {
    const other = fixture().collector;
    other.applyEvent(event('stdout_chunk', {stream_offset: 0, chunk: encode('abc')}));
    other.applyEvent(event('stdout_chunk', {stream_offset: offset, chunk: encode('x')}));
    faulted(other, 'STREAM_OFFSET_MISMATCH');
  }
  c.applyEvent(event('stdout_chunk', {stream_offset: 0, chunk: new Uint8Array()})); faulted(c, 'CHUNK_AFTER_EOF');
});
test('first raw exit survives conflict and subsequent clock failure or prior fault', () => {
  const f = fixture(), c = f.collector, raw_exit = {exit_code: 7, signal: null, wall_ms: 8};
  c.applyEvent(event('raw_exit', {raw_exit}));
  assert.equal(c.applyEvent(event('raw_exit', {raw_exit})).rejection_reason, 'IDEMPOTENT_IGNORED');
  c.applyEvent(event('raw_exit', {raw_exit: {...raw_exit, exit_code: 0}}));
  assert.deepEqual(faulted(c, 'CONFLICTING_WRAPPER_EXIT').raw_wrapper, raw_exit);
  const other = fixture(); other.setHook(() => {throw Error('PRIVATE');});
  other.collector.applyEvent(event('raw_exit', {raw_exit}));
  assert.deepEqual(faulted(other.collector, 'CLOCK_REGRESSION').raw_wrapper, raw_exit);
  assert.equal(JSON.stringify(other.collector.snapshot()).includes('PRIVATE'), false);
});
test('wrong binding malformed DTO shared buffers and unsafe wrappers mutate nothing and read no clock', () => {
  const f = fixture(), c = f.collector, before = c.snapshot(); let traps = 0;
  const invalid = [event('tick', {binding: {...binding, invocation_id: 'b'.repeat(32)}}),
    event('abort', {code: 'PRIVATE'}), event('stream_error', {stream: 'stdout', code: 'PRIVATE'}),
    event('stdout_chunk', {stream_offset: 0, chunk: new Uint8Array(new SharedArrayBuffer(1))}),
    event('raw_exit', {raw_exit: {exit_code: 1.5, signal: null, wall_ms: 0}}),
    new Proxy({}, {ownKeys() {traps++; throw Error();}})];
  const getter = event('tick'); Object.defineProperty(getter, 'type', {get() {traps++; return 'tick';}}); invalid.push(getter);
  for (const value of invalid) {assert.equal(c.applyEvent(value).rejection_reason, 'BINDING_MISMATCH'); assert.deepEqual(c.snapshot(), before);}
  assert.equal(f.clockCalls(), 0); assert.equal(traps, 0);
});
test('deadline gates collecting IO-drained and memoized metadata without restarting deadline', () => {
  for (const state of ['collecting', 'drained', 'decoded']) {
    const f = fixture(), c = f.collector;
    if (state !== 'collecting') feed(c);
    if (state === 'decoded') assert.ok(c.drainAndDecode());
    f.setNow(1000);
    if (state === 'collecting') c.applyEvent(event('tick')); else assert.equal(c.drainAndDecode(), null);
    const s = faulted(c, 'TASK_DEADLINE_EXPIRED'); assert.equal(s.cancellation_reason, 'TASK_DEADLINE_EXPIRED');
    assert.equal(s.task_deadline_ms, 1000);
  }
});
test('abort latches before clock and busy guards, preserves first diagnostic/reason and raw exit', () => {
  const f = fixture(), c = f.collector;
  c.applyEvent(event('stream_error', {stream: 'stdout', code: 'STREAM_ERROR'}));
  c.applyEvent(event('abort', {code: 'USER_ABORT'})); c.applyEvent(event('abort', {code: 'TIMEOUT'}));
  const s = faulted(c, 'STREAM_READ_ERROR'); assert.equal(s.cancellation_reason, 'USER_ABORT');
  assert.equal(s.recommend_owner_abort.reason, 'USER_ABORT');
  c.applyEvent(event('raw_exit', {raw_exit: {exit_code: null, signal: 'SIGTERM', wall_ms: null}}));
  assert.equal(c.snapshot().raw_exit_observed, true);
});
test('reentrant apply during clock faults while preserving protected raw exit', () => {
  const f = fixture(), c = f.collector;
  f.setHook(() => { c.applyEvent(event('raw_exit', {raw_exit: {exit_code: 9, signal: null, wall_ms: null}})); return 1000; });
  const result = c.applyEvent(event('tick'));
  const s = faulted(c, 'REENTRANT_CALL'); assert.equal(s.raw_wrapper.exit_code, 9);
  assert.equal(s.cancellation_latched, false); assert.deepEqual(result.snapshot, c.snapshot());
});
test('clock reentrant abort wins over returned deadline and invalid clock sample', () => {
  for (const sample of [1000, NaN]) {
    const f = fixture(), c = f.collector;
    f.setHook(() => { c.applyEvent(event('abort', {code: 'USER_ABORT'})); return sample; });
    c.applyEvent(event('tick'));
    const s = faulted(c, 'ABORT_LATCHED'); assert.equal(s.cancellation_reason, 'USER_ABORT');
  }
});
test('passive close reads no clock and seals all late operational changes', () => {
  const f = fixture(), c = f.collector; c.applyEvent(event('stdout_chunk', {stream_offset: 0, chunk: payload}));
  const clocks = f.clockCalls(); c.close(); const closed = c.snapshot();
  assert.equal(closed.phase, 'CLOSED'); assert.equal(closed.stdout_retained_bytes, 0); assert.equal(closed.recommend_owner_abort.recommended, false);
  assert.equal(f.clockCalls(), clocks); f.setNow(1000);
  assert.equal(c.applyEvent(event('abort', {code: 'USER_ABORT'})).rejection_reason, 'ALREADY_CLOSED');
  assert.equal(c.drainAndDecode(), null); c.close(); assert.deepEqual(c.snapshot(), closed);
  assert.equal(f.clockCalls(), clocks);
});
test('reentrant close in every clock stage cannot acquire deadline cancellation or metadata', () => {
  for (const stage of ['apply', 'decode-pre', 'decode-post', 'memo']) {
    const f = fixture(), c = f.collector;
    if (stage !== 'apply') feed(c);
    if (stage === 'memo') assert.ok(c.drainAndDecode());
    let n = 0;
    f.setHook(() => {n++; if (stage !== 'decode-post' || n === 2) {c.close(); return 1000;} return 0;});
    if (stage === 'apply') c.applyEvent(event('tick')); else assert.equal(c.drainAndDecode(), null);
    const s = c.snapshot(); assert.equal(s.phase, 'CLOSED'); assert.equal(s.cancellation_latched, false);
    assert.equal(s.diagnostic, 'NONE'); assert.equal(s.decoded_metadata, null); assert.equal(s.recommend_owner_abort.recommended, false);
  }
});
test('decoder reentrant abort close tick or raw conflict cannot publish its result', () => {
  for (const action of ['abort', 'close', 'tick', 'exit', 'drain']) {
    let c;
    const f = fixture({decoder(input) {
      if (action === 'close') c.close();
      else if (action === 'abort') c.applyEvent(event('abort', {code: 'USER_ABORT'}));
      else if (action === 'exit') c.applyEvent(event('raw_exit', {raw_exit: {exit_code: 7, signal: null, wall_ms: 12}}));
      else if (action === 'drain') c.drainAndDecode();
      else c.applyEvent(event('tick'));
      return decodeAgyJson(input);
    }}); c = f.collector; feed(c);
    assert.equal(c.drainAndDecode(), null); assert.equal(c.snapshot().decoded_metadata, null);
    assert.equal(c.snapshot().phase, action === 'close' ? 'CLOSED' : 'FAULTED');
    if (action === 'abort') assert.equal(c.snapshot().cancellation_reason, 'USER_ABORT');
    if (action === 'exit') assert.equal(c.snapshot().raw_wrapper.exit_code, 0);
  }
});
test('decoder throw async/thenable shape malformed metadata and private fields reject once', () => {
  for (const produce of [() => {throw Error('PRIVATE');}, () => Promise.resolve({}), () => ({then() {throw Error('PRIVATE');}}),
    () => ({parser_status: 'SUCCESS'}), input => ({...decodeAgyJson(input), response: 'PRIVATE'}),
    input => ({...decodeAgyJson(input), usage: {...decodeAgyJson(input).usage, input: 'PRIVATE'}})]) {
    let calls = 0; const c = fixture({decoder(input) {calls++; return produce(input);}}).collector; feed(c);
    assert.equal(c.drainAndDecode(), null); faulted(c, 'DECODE_ERROR'); assert.equal(c.drainAndDecode(), null);
    assert.equal(calls, 1); assert.equal(JSON.stringify(c.snapshot()).includes('PRIVATE'), false);
  }
});
test('post-decoder deadline and clock regression invalidate result, earlier snapshots stay frozen', () => {
  for (const value of [1000, -1]) {
    const f = fixture({decoder(input) {f.setNow(value); return decodeAgyJson(input);}}); const c = f.collector; feed(c);
    const before = c.snapshot(); assert.equal(c.drainAndDecode(), null);
    faulted(c, value === 1000 ? 'TASK_DEADLINE_EXPIRED' : 'CLOCK_REGRESSION');
    assert.equal(before.diagnostic, 'NONE'); assert.equal(before.stdout_retained_bytes, payload.length);
    assert.ok(Object.isFrozen(before)); assert.ok(Object.isFrozen(before.raw_wrapper));
  }
});

test('chunk capture precedes clock callbacks that mutate or detach caller bytes', () => {
  for (const detach of [false, true]) {
    const f = fixture(), c = f.collector, source = payload.slice();
    f.setHook(() => {
      if (detach) structuredClone(source, {transfer: [source.buffer]}); else source.fill(255);
      return 0;
    });
    c.applyEvent(event('stdout_chunk', {stream_offset: 0, chunk: source})); f.setHook(null);
    c.applyEvent(event('stdout_eof', {stream_offset: payload.length})); c.applyEvent(event('stderr_eof', {stream_offset: 0}));
    c.applyEvent(event('raw_exit', {raw_exit: {exit_code: 0, signal: null, wall_ms: null}}));
    assert.equal(c.drainAndDecode().provider_reported_status, 'SUCCESS');
  }
});

test('genuine rejected decoder Promises are observed even after reentrant close or abort', async () => {
  let traps = 0;
  for (const action of ['none', 'close', 'abort']) {
    let c;
    c = fixture({decoder() {
      if (action === 'close') c.close();
      if (action === 'abort') c.applyEvent(event('abort', {code: 'USER_ABORT'}));
      const rejected = Promise.reject(Error('PRIVATE'));
      Object.defineProperty(rejected, 'then', {get() {traps++; throw Error('PRIVATE');}});
      return rejected;
    }}).collector;
    feed(c); assert.equal(c.drainAndDecode(), null); await Promise.resolve();
    assert.equal(c.snapshot().phase, action === 'close' ? 'CLOSED' : 'FAULTED');
    assert.equal(c.snapshot().decoded_metadata, null);
    assert.equal(JSON.stringify(c.snapshot()).includes('PRIVATE'), false);
  }
  assert.equal(traps, 0);
});

test('nonordinary Promise constructor accessors are not invoked or accepted', async () => {
  let traps = 0;
  const c = fixture({decoder() {
    const rejected = Promise.reject(Error('PRIVATE'));
    // Test caller owns containment for a deliberately invalid exotic return.
    Promise.prototype.then.call(rejected, () => undefined, () => undefined);
    Object.defineProperty(rejected, 'constructor', {get() {traps++; throw Error('PRIVATE');}});
    return rejected;
  }}).collector;
  feed(c); assert.equal(c.drainAndDecode(), null); await Promise.resolve();
  faulted(c, 'DECODE_ERROR'); assert.equal(traps, 0);
});
