import {types} from 'node:util';
import {collectorDiagnostic,sanitizeDiagnosticMetadata} from './limited-diagnostics.mjs';
import {createLimitedStreamCollector} from '../limited-stream-collector.mjs';
import {validateLimitedJobRecord} from '../limited-job-record.mjs';

const passiveError = () => {};
const byteLengthOf = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const retained = new Set();
// Explicit ports for synthetic tests; this module has no native defaults or public argv entrypoint.
export function runForeground(spec, invocation, options, ports) {
  const {clock, spawn, persist, environment} = ports, shutdown = options.shutdown;
  const collector = spec.task_class === 'BOUNDED_CODEGEN_SUMMARIZER_V5' ? ports.createCollector() : createLimitedStreamCollector(), timers = new Map(), attempts = [];
  let spawnAttempted = false, child = null, startedAt = null, lastNow = -1, deadline = null, pid = null;
  let exited = false, code = null, signal = null, wall = null, status = null, diagnostic = null;
  let done = false, completing = false, finishing = false, drainingForced = false, stopping = false, spawned = false;
  let abortLatched = false, timeoutLatched = false, metadata = null, payloadValid = null;
  let persisted = {persisted: false, path: null, byte_count: null, persistence_error: null};
  let persistenceController = null, resolve;
  const result = new Promise(complete => {resolve = complete;});
  const late = []; // At most one actual late child exit; never rewrites the record.
  const now = () => {
    const value = clock.now();
    if (!Number.isSafeInteger(value) || value < 0 || value < lastNow) throw Error('CLOCK_UNAVAILABLE');
    lastNow = value; return value;
  };
  function cancel(name) {const fn = timers.get(name); timers.delete(name); try {fn?.();} catch {diagnostic ??= 'TIMER_CANCEL_FAILED'; status ??= 'LIMITED_INTERNAL_ERROR';}}
  function cancelAll() {for (const name of [...timers.keys()]) cancel(name);}
  function arm(name, delay, callback) {
    cancel(name); let returned = false, inline = false;
    const cancelFn = clock.schedule(delay, () => {if (!returned) {inline = true; return;} timers.delete(name); if (!done) callback();});
    returned = true;
    if (typeof cancelFn !== 'function') throw Error('SCHEDULER_UNAVAILABLE');
    if (inline) {try {cancelFn();} catch {} throw Error('SCHEDULER_UNAVAILABLE');}
    if (done || completing || exited && ['term', 'kill', 'allocation'].includes(name)) {try {cancelFn();} catch {} return;}
    timers.set(name, cancelFn);
  }
  function latch(next, detail = next) {
    if (next === 'LIMITED_USER_ABORT') {abortLatched = true; if (!timeoutLatched) status = next;}
    else if (next === 'LIMITED_TIMEOUT') {timeoutLatched = true; if (!abortLatched) status = next; persistenceController?.abort();}
    else status ??= next;
    diagnostic ??= detail;
  }
  function destroyStreams() {
    for (const stream of [child?.stdout, child?.stderr]) {
      if (!stream) continue;
      stream.on('error', passiveError);
      try {stream.destroy();} catch {diagnostic ??= 'STREAM_DESTROY_FAILED';}
    }
  }
  function signalChild(kind) {
    if (exited || done || !child || !spawned) return;
    const item = {signal: kind, elapsed_ms: null, accepted: false}; attempts.push(item);
    try {item.elapsed_ms = now() - startedAt;} catch {latch('LIMITED_INTERNAL_ERROR', 'CLOCK_UNAVAILABLE');}
    if (exited || done) return;
    try {item.accepted = child.kill(kind) === true;} catch {diagnostic ??= 'SIGNAL_ATTEMPT_FAILED';}
  }
  function teardown() {
    cancelAll(); options.abortSignal?.removeEventListener('abort', onAbort);
    const target = child;
    if (target) {
      for (const stream of [target.stdout, target.stderr]) if (stream) {
        stream.removeListener('data', stream === target.stdout ? onOut : onErr);
        stream.removeListener('end', stream === target.stdout ? onOutEnd : onErrEnd);
        stream.removeListener('close', stream === target.stdout ? onOutClose : onErrClose);
        stream.removeListener('error', onStreamError); stream.on('error', passiveError);
      }
      target.removeListener('spawn', onSpawn); target.removeListener('exit', onExit); target.removeListener('error', onError);
      target.on('error', passiveError);
      if (!exited) {
        retained.add(target);
        target.once('exit', (exit_code, exit_signal) => {retained.delete(target); late.push(Object.freeze({exit_code, exit_signal}));});
        target.unref?.();
      }
    }
    destroyStreams(); child = null; collector.close();
  }
  function complete() {
    if (done || completing) return;
    completing = true; cancelAll();
    const io = collector.snapshot();
    const record = validateLimitedJobRecord({job_id: spec.job_id, task_class: spec.task_class,
      lifecycle_status: status ?? 'LIMITED_INTERNAL_ERROR', requested_model: spec.requested_model, reported_model: 'UNKNOWN',
      process_exit: {pid, exit_code: code, exit_signal: signal, process_wall_ms: wall, observed_termination: exited},
      io_state: {...io, io_drained: io.io_drained && !drainingForced},
      containment_evidence: {containment_level: 'DIRECT_CHILD_ONLY_NO_DESCENDANT_TRACKING',
        settlement_status: exited ? 'SETTLED_DIRECT_CHILD_EXIT' : spawned ? 'ABANDONED_UNSETTLED' : 'UNKNOWN', descendant_guarantee: 'NONE'},
      provider_metadata: {provider_reported_status: metadata?.provider_reported_status ?? null, duration_seconds: metadata?.duration_seconds ?? null,
        usage_tokens: Object.fromEntries(['input', 'output', 'cache_read', 'thinking', 'total'].map(k => [k, metadata?.usage?.[k] ?? 'UNKNOWN']))},
      output_custody: persisted, task_outcome_evaluated: false, task_payload_valid: payloadValid,
      error_details: {code: diagnostic, classification: status === 'LIMITED_SUCCESS' ? null : status, message: null}});
    done = true; teardown();
    resolve(Object.freeze({record, runtime_evidence: Object.freeze({deadline_ms: deadline, timeout_latched: timeoutLatched,
      abort_latched: abortLatched, signal_attempts: Object.freeze(attempts.map(x => Object.freeze({...x}))),
      event_loop_condition: 'RESPONSIVE_PARENT_EVENT_LOOP', workspace_reuse: 'NOT_AUTHORIZED',
      workspace_disposition: status === 'LIMITED_SUCCESS' ? 'DEDICATED_NOT_REUSED' : 'QUARANTINED', max_steps: 'UNSUPPORTED'}),
      late_observations: () => Object.freeze([...late])}));
  }
  function beginStop() {
    if (stopping || done || exited) return;
    stopping = true; cancel('budget');
    if (!spawned) {
      try {arm('allocation', shutdown.term_grace_ms + shutdown.kill_grace_ms, () => {drainingForced = true; complete();});}
      catch {drainingForced = true; complete();}
      return;
    }
    signalChild('SIGTERM');
    if (exited || done) return;
    try {arm('term', shutdown.term_grace_ms, () => {
      signalChild('SIGKILL'); if (exited || done) return;
      try {arm('kill', shutdown.kill_grace_ms, () => {drainingForced = true; complete();});}
      catch {drainingForced = true; complete();}
    });} catch {drainingForced = true; complete();}
  }
  function budgetTick() {
    try {const t = now(); if (t < deadline) {arm('budget', deadline - t, budgetTick); return;} latch('LIMITED_TIMEOUT');}
    catch {latch('LIMITED_INTERNAL_ERROR', 'CLOCK_UNAVAILABLE');}
    beginStop();
    if (!spawned && !done) try {arm('allocation', shutdown.term_grace_ms + shutdown.kill_grace_ms, () => {drainingForced = true; complete();});} catch {complete();}
  }
  function onAbort() {
    if (done) return;
    latch('LIMITED_USER_ABORT'); persistenceController?.abort(); beginStop();
    if (exited) void finalize();
  }
  function checkDeadline() {
    try {if (now() >= deadline) {latch('LIMITED_TIMEOUT'); beginStop();}}
    catch {latch('LIMITED_INTERNAL_ERROR', 'CLOCK_UNAVAILABLE'); beginStop();}
  }
  async function finalize() {
    if (done || finishing || !exited) return;
    const io = collector.snapshot();
    if (!drainingForced && (!io.stdout_eof || !io.stderr_eof)) return;
    finishing = true; cancel('drain'); checkDeadline();
    if (!status && (code !== 0 || signal !== null)) latch('LIMITED_PROCESS_FAILED');
    if (!status && !io.io_drained) latch('LIMITED_INTERNAL_ERROR', 'IO_INCOMPLETE');
    if (!status && ['PUBLIC_INLINE_TEXT_SUMMARIZATION_FOREGROUND', 'BOUNDED_CODEGEN_SUMMARIZER_V5'].includes(spec.task_class)) {
      let parsed, parsedBytes, parsedLength;
      try {
        parsed = collector.decode({exit_code: code, exit_signal: signal, process_wall_ms: wall});
        if (!parsed || typeof parsed !== 'object' || types.isProxy(parsed)) throw Error('INVALID_DECODE_RESULT');
        const metadataField = Object.getOwnPropertyDescriptor(parsed, 'metadata'), bytesField = Object.getOwnPropertyDescriptor(parsed, 'bytes');
        if (!metadataField || !Object.hasOwn(metadataField, 'value') || !bytesField || !Object.hasOwn(bytesField, 'value')) throw Error('INVALID_DECODE_RESULT');
        const safeMetadata = sanitizeDiagnosticMetadata(metadataField.value);
        parsedBytes = bytesField.value;
        if (!safeMetadata || safeMetadata.provider_reported_status !== 'SUCCESS' || !types.isUint8Array(parsedBytes)) throw Error('INVALID_DECODE_RESULT');
        parsedLength = Reflect.apply(byteLengthOf, parsedBytes, []);
        metadata = safeMetadata; payloadValid = true;
      }
      catch(error) {
        parsed = null; parsedBytes = null; metadata = null; payloadValid = false;
        if (!status) {
          const report=collectorDiagnostic(collector,error);
          // A report method may reenter cancellation. Never overwrite that primary status.
          if (!status) {latch('LIMITED_PARSER_ERROR', `${report.stage}:${report.reason}`);metadata=report.metadata;}
        }
      }
      if (parsed && !status) {
        persistenceController = new AbortController();
        try {
          await new Promise((accept, reject) => {
            arm('persist', shutdown.persistence_timeout_ms, () => {persistenceController.abort(); reject(Error('PERSISTENCE_TIMEOUT'));});
            Promise.resolve().then(() => persist(parsedBytes, persistenceController.signal)).then(accept, reject);
          });
          cancel('persist'); checkDeadline();
          persisted = {persisted: true, path: options.output_path, byte_count: parsedLength, persistence_error: null};
        } catch {cancel('persist'); persisted.persistence_error = 'PERSISTENCE_FAILED_OR_UNCERTAIN'; latch('LIMITED_PERSISTENCE_FAILED');}
        try {Uint8Array.prototype.fill.call(parsedBytes, 0);} catch {latch('LIMITED_INTERNAL_ERROR', 'BUFFER_CLEAR_FAILED');}
      }
    }
    if (!status) status = spec.task_class === 'INERT_TIMEOUT_ACCEPTANCE_PROBE' ? 'LIMITED_PROCESS_FAILED' : 'LIMITED_SUCCESS';
    complete();
  }
  function onSpawn() {spawned = true; pid = Number.isSafeInteger(child?.pid) ? child.pid : null;
    cancel('allocation'); if (status) {stopping = false; beginStop();}}
  function onExit(exit_code, exit_signal) {
    if (done || exited) return;
    // Preserve observed raw values before the fallible clock call.
    exited = true; code = exit_code; signal = exit_signal; cancel('term'); cancel('kill'); cancel('allocation');
    try {wall = now() - startedAt;} catch {latch('LIMITED_INTERNAL_ERROR', 'CLOCK_UNAVAILABLE');}
    try {arm('drain', shutdown.stream_drain_timeout_ms, () => {drainingForced = true; void finalize();});}
    catch {drainingForced = true;}
    void finalize();
  }
  function onError() {if (!spawned) {latch('LIMITED_SPAWN_FAILED'); drainingForced = true; complete();}
    else {latch('LIMITED_INTERNAL_ERROR', 'CHILD_ERROR'); beginStop();}}
  function onStreamError() {if (!done) {latch('LIMITED_INTERNAL_ERROR', 'STREAM_ERROR'); drainingForced = true; beginStop(); if (exited) void finalize();}}
  function feed(stream, bytes) {
    if (done) return;
    if (!collector.chunk(stream, bytes)) {latch('LIMITED_CAPACITY_EXCEEDED'); drainingForced = true; destroyStreams(); beginStop();}
    checkDeadline();
  }
  const onOut = b => feed('stdout', b), onErr = b => feed('stderr', b);
  function end(stream) {if (!done && !drainingForced) collector.eof(stream); void finalize();}
  const onOutEnd = () => end('stdout'), onErrEnd = () => end('stderr');
  // A close without end is not evidence of complete drain.
  const onOutClose = () => {if (!collector.snapshot().stdout_eof) onStreamError();};
  const onErrClose = () => {if (!collector.snapshot().stderr_eof) onStreamError();};
  try {
    startedAt = now(); deadline = startedAt + spec.max_wall_clock_sec * 1000;
    if (!Number.isSafeInteger(deadline)) throw Error('CLOCK_BUDGET_OVERFLOW');
    options.abortSignal?.addEventListener('abort', onAbort, {once: true});
    if (options.abortSignal?.aborted) {latch('LIMITED_USER_ABORT'); complete(); return result;}
    arm('budget', deadline - startedAt, budgetTick);
    checkDeadline();
    if (status) {complete(); return result;}
    spawnAttempted = true;
    child = spawn(invocation.executable, invocation.args, {cwd: spec.task_scope, env: environment,
      shell: false, detached: false, stdio: ['ignore', 'pipe', 'pipe']});
    child.on('error', onError); child.on('spawn', onSpawn); child.on('exit', onExit);
    for (const [stream, data, endFn, closeFn] of [[child.stdout, onOut, onOutEnd, onOutClose], [child.stderr, onErr, onErrEnd, onErrClose]]) {
      stream.on('error', onStreamError); stream.on('data', data); stream.on('end', endFn); stream.on('close', closeFn);
    }
  } catch {latch(spawnAttempted && !child ? 'LIMITED_SPAWN_FAILED' : 'LIMITED_INTERNAL_ERROR'); if (child) beginStop(); else complete();}
  return result;
}
