import {publicRetention,takeRejectedCapture,retentionResult,ownData} from './rejected-capture.mjs';
import {types} from 'node:util';
import {collectorDiagnostic,sanitizeDiagnosticMetadata} from './limited-diagnostics.mjs';
import {createLimitedStreamCollector} from '../limited-stream-collector.mjs';
import {validateLimitedJobRecord,validateLargeProjectJobRecord} from '../limited-job-record.mjs';
import {DESKTOP_TARGET} from '../desktop-profile.mjs';
import {
  PROJECT_LARGE_OBSERVATION_TASK_CLASS,PROJECT_OUTPUT_LARGE_PROFILE,
  validateProjectCodingObservationProfile,validateProjectOutputLargeProfile
} from '../project-coding-profile.mjs';

const passiveError = () => {};
const byteLengthOf = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const retained = new Set();
// Explicit ports for synthetic tests; this module has no native defaults or public argv entrypoint.
export function runForeground(spec, invocation, options, ports) {
  // Null is a closed desktop-project capability, never a generic timeout switch.
  const hasExecutionProfile=Object.hasOwn(spec,'execution_profile');
  const hasOutputProfile=Object.hasOwn(spec,'output_profile');
  const largeObservation=hasOutputProfile;
  const observation=hasExecutionProfile||largeObservation;
  let largeOutputProfile=null;
  if(largeObservation){
    const executionProfile=validateProjectCodingObservationProfile(spec.execution_profile);
    largeOutputProfile=validateProjectOutputLargeProfile(spec.output_profile);
    if(spec.provider_id!=='native_codex'||spec.task_class!==PROJECT_LARGE_OBSERVATION_TASK_CLASS||
       spec.runtime_target!==DESKTOP_TARGET||spec.max_wall_clock_sec!==null||
       executionProfile.id!=='PROJECT_CODING_OBSERVE_V1') throw Error('INVALID_OBSERVATION_PROFILE');
  }else if(hasExecutionProfile){
    validateProjectCodingObservationProfile(spec.execution_profile);
    if(spec.provider_id!=='native_codex'||spec.task_class!=='PROJECT_CODEGEN_V1'||
       spec.runtime_target!==DESKTOP_TARGET||spec.max_wall_clock_sec!==null)throw Error('INVALID_OBSERVATION_PROFILE');
  }else if(spec.max_wall_clock_sec===null||spec.task_class===PROJECT_LARGE_OBSERVATION_TASK_CLASS)throw Error('INVALID_OBSERVATION_PROFILE');
  const {clock, spawn, persist, environment} = ports, shutdown = options.shutdown;
  const collector = ['BOUNDED_CODEGEN_SUMMARIZER_V5','SINGLE_JS_CODEGEN_V1','PROJECT_CODEGEN_V1',PROJECT_LARGE_OBSERVATION_TASK_CLASS].includes(spec.task_class) ? ports.createCollector() : createLimitedStreamCollector(), timers = new Map(), attempts = [];
  let spawnAttempted = false, child = null, startedAt = null, lastNow = -1, deadline = null, pid = null;
  let exited = false, code = null, signal = null, wall = null, status = null, diagnostic = null;
  let done = false, completing = false, finishing = false, drainingForced = false, stopping = false, spawned = false;
  let abortLatched = false, timeoutLatched = false, metadata = null, payloadValid = null;
  let persisted = {persisted: false, path: null, byte_count: null, persistence_error: null};
  let persistenceController = null, retentionController = null, resolve;
  const codex=spec.provider_id==='native_codex';
  let inputBytes=null,inputDelivered=invocation.stdin_bytes===undefined,inputWriteReturned=false,inputWritten=false,inputNeedsDrain=false,inputDrained=false,inputEnding=false;
  let diagnosticRetention = publicRetention();
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
    else if (next === 'LIMITED_TIMEOUT') {timeoutLatched = true; if (!abortLatched) status = next; persistenceController?.abort(); retentionController?.abort();}
    else status ??= next;
    diagnostic ??= detail;
  }
  function destroyStreams() {
    for (const stream of [child?.stdout, child?.stderr, child?.stdin]) {
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
      if(target.stdin){target.stdin.removeListener('error',onInputError);target.stdin.removeListener('drain',onInputDrain);target.stdin.removeListener('close',onInputClose);target.stdin.on('error',passiveError);}
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
    const recordInput = {job_id: spec.job_id, task_class: spec.task_class,
      ...(largeObservation?{output_profile:largeOutputProfile}:{}),
      lifecycle_status: status ?? 'LIMITED_INTERNAL_ERROR', requested_model: spec.requested_model, reported_model: 'UNKNOWN',
      process_exit: {pid, exit_code: code, exit_signal: signal, process_wall_ms: wall, observed_termination: exited},
      io_state: {...io, io_drained: io.io_drained && !drainingForced},
      containment_evidence: {containment_level: 'DIRECT_CHILD_ONLY_NO_DESCENDANT_TRACKING',
        settlement_status: exited ? 'SETTLED_DIRECT_CHILD_EXIT' : spawned ? 'ABANDONED_UNSETTLED' : 'UNKNOWN', descendant_guarantee: 'NONE'},
      provider_metadata: {...(codex?{codex_reasoning_output_tokens:metadata?.extra_metadata?.codex_reasoning_output_tokens??'UNKNOWN'}:{}),provider_reported_status: metadata?.provider_reported_status ?? null, duration_seconds: metadata?.duration_seconds ?? null,
        usage_tokens: Object.fromEntries(['input', 'output', 'cache_read', 'thinking', 'total'].map(k => [k, metadata?.usage?.[k] ?? 'UNKNOWN']))},
      output_custody: persisted, task_outcome_evaluated: false, task_payload_valid: payloadValid,
      error_details: {code: diagnostic, classification: status === 'LIMITED_SUCCESS' ? null : status, message: null}};
    const record=largeObservation?validateLargeProjectJobRecord(recordInput):validateLimitedJobRecord(recordInput);
    done = true; teardown();
    resolve(Object.freeze({record, diagnostic_retention: diagnosticRetention, runtime_evidence: Object.freeze({deadline_ms: deadline, timeout_latched: timeoutLatched,
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
    latch('LIMITED_USER_ABORT'); persistenceController?.abort(); retentionController?.abort(); beginStop();
    if (exited) void finalize();
  }
  function checkDeadline() {
    try {const current=now();if (!observation&&current >= deadline) {latch('LIMITED_TIMEOUT'); beginStop();return false;}return true;}
    catch {latch('LIMITED_INTERNAL_ERROR', 'CLOCK_UNAVAILABLE'); beginStop();return false;}
  }
  async function retainRejected() {
    if (options.enableDiagnosticRetention !== true || status !== 'LIMITED_PARSER_ERROR') return;
    let capture;
    try {capture = takeRejectedCapture(collector);} catch {diagnosticRetention=publicRetention('FAILED',null,'RETENTION_INVALID_CAPTURE');return;}
    if (!capture?.eligible) {diagnosticRetention=publicRetention('NOT_ELIGIBLE',capture);return;}
    const clear=()=>{try{capture.response_bytes.fill(0);}catch{}};
    let remaining;
    try {const current=now();remaining=observation?shutdown.persistence_timeout_ms:deadline-current;} catch {latch('LIMITED_INTERNAL_ERROR','CLOCK_UNAVAILABLE');clear();return;}
    if (options.abortSignal?.aborted) onAbort();
    if (remaining<=0) latch('LIMITED_TIMEOUT');
    if (status!=='LIMITED_PARSER_ERROR') {clear();return;}
    let retainPort;try{retainPort=ownData(ports,'retainRejected');}catch{}
    if(typeof retainPort!=='function'||types.isProxy(retainPort)){diagnosticRetention=publicRetention('FAILED',capture,'RETENTION_IO_FAILED');clear();return;}
    retentionController=new AbortController();
    let abortListener, settled=false;
    const aborted=new Promise((_,reject)=>{abortListener=()=>reject(Error('RETENTION_ABORTED'));retentionController.signal.addEventListener('abort',abortListener,{once:true});});
    aborted.catch(()=>{});
    let operation;
    try {
      arm('retention',remaining,()=>{if(!observation)latch('LIMITED_TIMEOUT');retentionController.abort();});
      // schedule()/clock callbacks may reenter abort: register first, then check again before calling the port.
      if(!checkDeadline())retentionController.abort();
      if(options.abortSignal?.aborted)onAbort();
      if(status!=='LIMITED_PARSER_ERROR')retentionController.abort();
      operation=Promise.resolve().then(()=>{if(retentionController.signal.aborted)throw Error('RETENTION_ABORTED');return Reflect.apply(retainPort,ports,[capture,retentionController.signal]);});
      operation.then(()=>{settled=true;clear();},()=>{settled=true;clear();});
      const value=await Promise.race([operation,aborted]);
      if(!checkDeadline())retentionController.abort();
      diagnosticRetention=retentionController.signal.aborted?publicRetention('UNKNOWN',capture,'RETENTION_TIMEOUT_OR_ABORTED'):retentionResult(value,capture);
    } catch {
      diagnosticRetention=publicRetention(retentionController.signal.aborted?'UNKNOWN':'FAILED',capture,retentionController.signal.aborted?'RETENTION_TIMEOUT_OR_ABORTED':'RETENTION_IO_FAILED');
      if(!operation)clear();
    } finally {
      cancel('retention');retentionController.signal.removeEventListener('abort',abortListener);
      // A pending port owns its copy until observed settlement, even after bounded caller return.
      if(settled)clear();
    }
  }
  async function finalize() {
    if (done || finishing || !exited) return;
    const io = collector.snapshot();
    if (!drainingForced && (!io.stdout_eof || !io.stderr_eof)) return;
    finishing = true; cancel('drain'); checkDeadline();
    if (!status && (code !== 0 || signal !== null)) latch('LIMITED_PROCESS_FAILED');
    if (!status && !io.io_drained) latch('LIMITED_INTERNAL_ERROR', 'IO_INCOMPLETE');
    if ((!status||codex&&status==='LIMITED_PROCESS_FAILED'&&inputDelivered&&io.io_drained) && ['PUBLIC_INLINE_TEXT_SUMMARIZATION_FOREGROUND', 'BOUNDED_CODEGEN_SUMMARIZER_V5','SINGLE_JS_CODEGEN_V1','PROJECT_CODEGEN_V1',PROJECT_LARGE_OBSERVATION_TASK_CLASS].includes(spec.task_class)) {
      let parsed, parsedBytes, parsedLength;
      try {
        parsed = collector.decode({exit_code: code, exit_signal: signal, process_wall_ms: wall});
        if (!parsed || typeof parsed !== 'object' || types.isProxy(parsed)) throw Error('INVALID_DECODE_RESULT');
        const metadataField = Object.getOwnPropertyDescriptor(parsed, 'metadata'), bytesField = Object.getOwnPropertyDescriptor(parsed, 'bytes');
        if (!metadataField || !Object.hasOwn(metadataField, 'value') || !bytesField || !Object.hasOwn(bytesField, 'value')) throw Error('INVALID_DECODE_RESULT');
        const safeMetadata = sanitizeDiagnosticMetadata(metadataField.value);
        parsedBytes = bytesField.value;
        if (!safeMetadata || safeMetadata.provider_reported_status !== (codex?'turn.completed':'SUCCESS') || !types.isUint8Array(parsedBytes)) throw Error('INVALID_DECODE_RESULT');
        parsedLength = Reflect.apply(byteLengthOf, parsedBytes, []);
        metadata = safeMetadata; payloadValid = true;
      }
      catch(error) {
        parsed = null; parsedBytes = null; metadata = null; payloadValid = false;
        if (!status) {
          const report=collectorDiagnostic(collector,error);
          // A report method may reenter cancellation. Never overwrite that primary status.
          if (!status) {latch('LIMITED_PARSER_ERROR', `${report.stage}:${report.reason}`);metadata=report.metadata;}
        }else if(codex&&status==='LIMITED_PROCESS_FAILED'){
          const report=collectorDiagnostic(collector,error);metadata=report.metadata;diagnostic??=`${report.stage}:${report.reason}`;
        }
      }
      if(parsed&&status&&parsedBytes){try{Uint8Array.prototype.fill.call(parsedBytes,0);}catch{}}
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
    await retainRejected();
    if (!status) status = spec.task_class === 'INERT_TIMEOUT_ACCEPTANCE_PROBE' ? 'LIMITED_PROCESS_FAILED' : 'LIMITED_SUCCESS';
    complete();
  }
  function onInputError(){if(done||inputDelivered)return;latch('LIMITED_PROCESS_FAILED','STDIN_WRITE_FAILED');beginStop();if(exited)void finalize();}
  function onInputClose(){if(!inputDelivered)onInputError();}
  function finishInput(){
    if(done||status||exited||inputEnding||!inputWriteReturned||!inputWritten||inputNeedsDrain&&!inputDrained)return;
    if(!checkDeadline()||options.abortSignal?.aborted){if(options.abortSignal?.aborted)onAbort();return;}
    inputEnding=true;
    try{child.stdin.end(error=>{
      if(error){onInputError();return;}
      if(done||status||exited)return;
      if(checkDeadline()&&!options.abortSignal?.aborted)inputDelivered=true;
      else if(options.abortSignal?.aborted)onAbort();
    });}catch{onInputError();}
  }
  function onInputDrain(){inputDrained=true;finishInput();}
  function writeInput(){
    if(inputDelivered||done||status||exited)return;
    if(!checkDeadline()||options.abortSignal?.aborted){if(options.abortSignal?.aborted)onAbort();return;}
    try{
      if(!child.stdin||typeof child.stdin.write!=='function'||typeof child.stdin.end!=='function')throw 0;
      const accepted=child.stdin.write(inputBytes,error=>{
        inputWritten=true;inputBytes?.fill(0);inputBytes=null;
        if(error){onInputError();return;}finishInput();
      });
      inputNeedsDrain=accepted===false;inputWriteReturned=true;finishInput();
    }catch{onInputError();}
  }
  function onSpawn() {spawned = true; pid = Number.isSafeInteger(child?.pid) ? child.pid : null;
    cancel('allocation'); if (status) {stopping = false; beginStop();}else writeInput();}
  function onExit(exit_code, exit_signal) {
    if (done || exited) return;
    // Preserve observed raw values before the fallible clock call.
    exited = true; code = exit_code; signal = exit_signal;
    if(!inputDelivered)latch('LIMITED_PROCESS_FAILED','STDIN_WRITE_FAILED'); cancel('term'); cancel('kill'); cancel('allocation');
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
    startedAt = now();
    if(!observation){
      deadline = startedAt + spec.max_wall_clock_sec * 1000;
      if (!Number.isSafeInteger(deadline)) throw Error('CLOCK_BUDGET_OVERFLOW');
    }
    options.abortSignal?.addEventListener('abort', onAbort, {once: true});
    if (options.abortSignal?.aborted) {latch('LIMITED_USER_ABORT'); complete(); return result;}
    if(!observation)arm('budget', deadline - startedAt, budgetTick);
    checkDeadline();
    if (status) {complete(); return result;}
    if(invocation.stdin_bytes!==undefined){
      if(types.isProxy(invocation.stdin_bytes)||!types.isUint8Array(invocation.stdin_bytes))throw Error('STDIN_WRITE_FAILED');
      const size=Reflect.apply(byteLengthOf,invocation.stdin_bytes,[]);if(size<1||size>32768)throw Error('STDIN_WRITE_FAILED');
      inputBytes=new Uint8Array(size);for(let i=0;i<size;i++)inputBytes[i]=invocation.stdin_bytes[i];
    }
    spawnAttempted = true;
    child = spawn(invocation.executable, invocation.args, {cwd: spec.task_scope, env: environment,
      shell: false, detached: false, stdio: [inputDelivered?'ignore':'pipe', 'pipe', 'pipe']});
    child.on('error', onError); child.on('spawn', onSpawn); child.on('exit', onExit);
    if(!inputDelivered){if(!child.stdin)throw Error('STDIN_WRITE_FAILED');child.stdin.on('error',onInputError);child.stdin.on('drain',onInputDrain);child.stdin.on('close',onInputClose);}
    for (const [stream, data, endFn, closeFn] of [[child.stdout, onOut, onOutEnd, onOutClose], [child.stderr, onErr, onErrEnd, onErrClose]]) {
      stream.on('error', onStreamError); stream.on('data', data); stream.on('end', endFn); stream.on('close', closeFn);
    }
  } catch {latch(spawnAttempted && !child ? 'LIMITED_SPAWN_FAILED' : 'LIMITED_INTERNAL_ERROR'); if (child) beginStop(); else complete();}
  return result;
}
