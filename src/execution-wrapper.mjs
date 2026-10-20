import {validateJobSpec, closed, object, own, fail, text, nonnegative} from './job-spec.mjs';
import {types} from 'node:util';
import {captureGroupObservation, requireSignalGuard} from './owned-group.mjs';

function dataArray(value, field) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(field);
  const length = Object.getOwnPropertyDescriptor(value, 'length').value;
  if (Reflect.ownKeys(value).length !== length + 1) fail(field);
  const result = [];
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !own(descriptor, 'value')) fail(field);
    result.push(descriptor.value);
  }
  return result;
}
export function captureInvocation(input) {
  closed(input, ['executable', 'args', 'env', 'stdio'], [], 'invocation');
  if (!text(input.executable) || !input.executable.startsWith('/')) fail('executable');
  const args = dataArray(input.args, 'args');
  if (args.some(value => typeof value !== 'string' || value.includes('\0'))) fail('args');
  object(input.env, 'env'); const env = Object.create(null);
  for (const key of Reflect.ownKeys(input.env)) {
    if (!text(key) || key.includes('=')) fail('env');
    const descriptor = Object.getOwnPropertyDescriptor(input.env, key);
    if (!own(descriptor, 'value') || typeof descriptor.value !== 'string' || descriptor.value.includes('\0')) fail('env');
    env[key] = descriptor.value;
  }
  if (!text(env.TMPDIR) || !env.TMPDIR.startsWith('/')) fail('env.TMPDIR');
  const stdio = dataArray(input.stdio, 'stdio');
  if (stdio.length !== 3 || stdio.some(value => value !== 'ignore' && !nonnegative(value))) fail('stdio');
  return Object.freeze({executable: input.executable, args: Object.freeze(args), env: Object.freeze(env), stdio: Object.freeze(stdio)});
}
function methods(value, keys, field) {
  closed(value, keys, [], field);
  if (keys.some(key => typeof value[key] !== 'function')) fail(field);
}

// This wrapper records metadata only. Trusted ports must return bounded synchronous observations.
// It does not instantiate a native port, inspect payloads, verify artifacts or emit a JobRecord.
export function startProcess(specification, invocation, options) {
  const spec = validateJobSpec(specification); const request = captureInvocation(invocation);
  closed(options, ['port', 'clock', 'shutdown'], ['signal'], 'execution_options');
  methods(options.port, ['spawn'], 'port'); methods(options.clock, ['now', 'schedule'], 'clock');
  const {shutdown, signal} = options;
  const port = Object.freeze({spawn: options.port.spawn.bind(options.port)});
  const clock = Object.freeze({now: options.clock.now.bind(options.clock), schedule: options.clock.schedule.bind(options.clock)});
  closed(shutdown, ['term_grace_ms', 'kill_grace_ms', 'poll_interval_ms'], [], 'shutdown');
  for (const key of ['term_grace_ms', 'kill_grace_ms', 'poll_interval_ms']) {
    if (!Number.isSafeInteger(shutdown[key]) || shutdown[key] <= 0) fail(`shutdown.${key}`);
  }
  const policy = Object.freeze(Object.fromEntries(['term_grace_ms', 'kill_grace_ms', 'poll_interval_ms'].map(key => [key, shutdown[key]])));
  const budget = spec.max_wall_clock_sec * 1000;
  if (!Number.isSafeInteger(budget) || !Number.isSafeInteger(policy.term_grace_ms + policy.kill_grace_ms)) fail('clock_budget');
  if (signal !== undefined && (!(signal instanceof AbortSignal) || types.isProxy(signal))) fail('signal');
  let lastNow = -1;
  function now() {
    const value = clock.now();
    if (!nonnegative(value) || value < lastNow) fail('monotonic_clock');
    lastNow = value; return value;
  }
  const requestedAt = now(); const budgetDeadline = requestedAt + budget;
  if (!Number.isSafeInteger(budgetDeadline + policy.term_grace_ms + policy.kill_grace_ms)) fail('clock_budget');
  let handle = null, allocated = false, pid = null, spawnedAt = null, exitValue = null;
  let stopAt = null, termDeadline = null, stopDeadline = null, stopReason = null;
  let canceled = false, completed = false, finishing = false, spawnInProgress = false;
  let termSent = false, killSent = false, cancelTimer = null;
  let resolveExit, resolveResult;
  const exit = new Promise(resolve => { resolveExit = resolve; });
  const result = new Promise(resolve => { resolveResult = resolve; });
  const failures = new Set();
  const exitMetadata = () => Object.freeze({job_id: spec.job_id, process_exit_code: exitValue?.code ?? null,
    signal: exitValue?.signal ?? null, process_wall_ms: exitValue?.wall ?? null});
  function finish(settlement, reason) {
    if (completed || finishing) return;
    finishing = true;
    try { cancelTimer?.(); } catch { failures.add('timer_cancel_failed'); }
    cancelTimer = null;
    try { handle?.release(); } catch { failures.add('release_failed'); }
    signal?.removeEventListener('abort', abortEvent);
    completed = true;
    const metadata = Object.freeze({...exitMetadata(), pid, process_group_allocated: allocated,
      canceled, settlement_status: settlement, termination_reason: ['settled', 'aborted', 'timeout'].includes(reason) ? stopReason ?? reason : reason,
      failure_codes: Object.freeze([...failures])});
    resolveExit(exitMetadata()); resolveResult(metadata);
  }
  let inControl = false; const pending = [];
  function guarded(action) {
    if (completed || finishing) return;
    if (inControl) { pending.push(action); return; }
    inControl = true;
    try { action(); } catch { failures.add('control_failed'); finish(null, 'control_failed'); }
    finally { inControl = false; }
    while (!completed && pending.length) guarded(pending.shift());
    if (completed) pending.length = 0;
  }
  function schedule(at) {
    cancelTimer?.();
    const wake = canceled ? at : Math.min(at, budgetDeadline);
    cancelTimer = clock.schedule(Math.max(0, wake - now()), () => guarded(tick));
    if (typeof cancelTimer !== 'function') fail('clock.schedule');
  }
  function beginSettlement(reason) {
    if (completed) return result;
    // Latch cancellation when received, even during a control call or release.
    if (reason === 'aborted' || reason === 'timeout') {
      if (!canceled) stopReason = reason;
      canceled = true;
    }
    guarded(() => {
      if (stopAt === null) {
        stopAt = now(); termDeadline = stopAt + policy.term_grace_ms;
        stopDeadline = termDeadline + policy.kill_grace_ms; stopReason ??= reason;
        if (!Number.isSafeInteger(stopDeadline)) fail('clock_budget');
      }
      // Repeated abort/settle calls never reset either absolute deadline.
      tick();
    });
    return result;
  }
  function abortEvent() { beginSettlement('aborted'); }
  function tick() {
    const time = now();
    if (!canceled && time >= budgetDeadline) {
      canceled = true; stopReason = 'timeout';
      if (stopAt === null) {
        stopAt = time; termDeadline = time + policy.term_grace_ms;
        stopDeadline = termDeadline + policy.kill_grace_ms; stopReason = 'timeout';
      }
    }
    if (stopAt === null) { schedule(budgetDeadline); return; }
    if (!handle) {
      if (!spawnInProgress) finish(null, stopReason);
      return;
    }
    if (!allocated) {
      // A spawn request without an allocation/failure observation is not a pre-spawn proof.
      if (time >= stopDeadline) { failures.add('spawn_observation_missing'); finish(null, 'observation_failed'); }
      else schedule(Math.min(stopDeadline, time + policy.poll_interval_ms));
      return;
    }
    if (time > stopDeadline) { failures.add('settlement_observation_late'); finish(null, 'shutdown_limit'); return; }
    let observed;
    try {
      observed = captureGroupObservation({job_id: spec.job_id, pgid: pid, identity: handle.identity}, handle.observe());
    } catch { failures.add('settlement_observation_failed'); finish(null, 'observation_failed'); return; }
    if (completed || finishing) return;
    const observedAt = now();
    if (observedAt > stopDeadline) { failures.add('settlement_observation_late'); finish(null, 'shutdown_limit'); return; }
    if (observed.live_count === 0) {
      if (!observed.coverage_complete) { failures.add('settlement_coverage_incomplete'); finish(null, 'observation_failed'); return; }
      if (exitValue !== null || observedAt >= stopDeadline) finish(termSent || killSent ? 'ORPHAN_KILLED' : 'CLEAN', stopReason);
      else schedule(Math.min(stopDeadline, observedAt + policy.poll_interval_ms));
      return;
    }
    if (observedAt >= stopDeadline) { finish('DIRTY_LEAK', 'shutdown_limit'); return; }
    const desired = !termSent ? 'SIGTERM' : observedAt >= termDeadline && !killSent ? 'SIGKILL' : null;
    if (desired) {
      if (!observed.signal_safe) { failures.add('signal_ownership_unconfirmed'); finish(null, 'observation_failed'); return; }
      try {
        requireSignalGuard({job_id: spec.job_id, pgid: pid, identity: handle.identity}, desired, observed);
        if (handle.sendSignal(desired, observed) !== true) throw new Error('signal_unconfirmed');
      } catch { failures.add('signal_failed'); finish(null, 'signal_failed'); return; }
      if (completed || finishing) return;
      if (desired === 'SIGTERM') termSent = true; else killSent = true;
    }
    schedule(Math.min(stopDeadline, termSent && !killSent ? termDeadline : stopDeadline, now() + policy.poll_interval_ms));
  }
  function capture(action) {
    if (completed || finishing) return;
    try { action(); } catch { failures.add('control_failed'); finish(null, 'control_failed'); }
  }
  function onSpawn(value) {
    capture(() => {
      closed(value, ['pid'], [], 'spawn');
      if (!Number.isSafeInteger(value.pid) || value.pid <= 1 || handle && value.pid !== handle.pid || spawnedAt !== null) fail('spawn');
      pid = value.pid; allocated = true; spawnedAt = now();
      if (stopAt !== null && handle) guarded(tick);
    });
  }
  function onExit(value) {
    capture(() => {
      closed(value, ['code', 'signal'], [], 'exit');
      if (exitValue !== null || !allocated || spawnedAt === null ||
          !(value.code === null && text(value.signal) || Number.isSafeInteger(value.code) && value.signal === null)) fail('exit');
      exitValue = Object.freeze({code: value.code, signal: value.signal, wall: now() - spawnedAt});
      resolveExit(exitMetadata());
      if (stopAt !== null && handle) guarded(tick);
    });
  }
  function onError(value) {
    capture(() => {
      closed(value, ['spawn_failed'], [], 'process_error');
      if (typeof value.spawn_failed !== 'boolean') fail('process_error');
      failures.add('process_error');
      if (value.spawn_failed && !allocated) { allocated = false; finish(null, 'spawn_failed'); }
      else beginSettlement('process_error');
    });
  }
  if (signal?.aborted) { canceled = true; finish(null, 'aborted'); }
  else {
    signal?.addEventListener('abort', abortEvent, {once: true});
    try {
      allocated = null; // request issued; allocation is unknown until positive native evidence
      spawnInProgress = true;
      handle = port.spawn(spec, request, Object.freeze({onSpawn, onExit, onError}));
      spawnInProgress = false;
      closed(handle, ['pid', 'identity', 'observe', 'sendSignal', 'release'], [], 'process_handle');
      if (!(handle.pid === null || Number.isSafeInteger(handle.pid) && handle.pid > 1) ||
          !handle.identity || typeof handle.identity !== 'object' ||
          ['observe', 'sendSignal', 'release'].some(key => typeof handle[key] !== 'function')) fail('process_handle');
      if (pid !== null && pid !== handle.pid) fail('spawn_observation_conflict');
      if (handle.pid !== null) { pid = handle.pid; allocated = true; }
      if (completed) handle.release(); else guarded(tick);
    } catch { spawnInProgress = false; failures.add('spawn_failed_or_unobserved'); finish(null, 'spawn_failed_or_unobserved'); }
  }
  return Object.freeze({exit, result, settle: () => beginSettlement('settled'), abort: () => beginSettlement('aborted')});
}
