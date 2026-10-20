import {resolve} from 'node:path';
import {validateJobSpec, closed, fail, nonnegative} from './job-spec.mjs';
import {captureUnitBinding} from './manager-custody.mjs';

// Strong, process-local ownership only. No persistent/cross-process admission or
// host custody. Dispatched/fenced owners have no discharge/release API here.
const retained = new Set(), internals = new WeakMap();
const overlaps = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
function reason(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)) fail('startup_reason');
  return value; // Caller-selected nonsecret classification, never an exception message.
}

export function createStartupOperation(options) {
  closed(options, ['spec', 'policy', 'clock', 'task_deadline_ms'], [], 'startup_operation');
  const spec = validateJobSpec(options.spec), {policy, clock} = options;
  closed(policy, ['unit_name', 'task_scope'], [], 'startup_policy');
  closed(clock, ['now'], [], 'startup_clock');
  if (typeof clock.now !== 'function' || typeof policy.unit_name !== 'string' ||
      !/^squire-[a-zA-Z0-9-]+\.service$/.test(policy.unit_name) || policy.task_scope !== spec.task_scope ||
      !spec.task_scope.startsWith('/') || resolve(spec.task_scope) !== spec.task_scope || spec.task_scope === '/') fail('startup_policy');
  const readClock = clock.now.bind(clock), requestedAt = readClock(), duration = spec.max_wall_clock_sec * 1000;
  const deadline = requestedAt + duration;
  if (!nonnegative(requestedAt) || !Number.isSafeInteger(duration) || !Number.isSafeInteger(deadline) ||
      options.task_deadline_ms !== deadline) fail('startup_budget');
  const unitName = policy.unit_name, scope = spec.task_scope;
  for (const item of retained) {
    if (item.job === spec.job_id || item.unit === unitName || overlaps(item.scope, scope)) fail('startup_reservation');
  }
  let phase = 'NOT_DISPATCHED', dispatched = false, epoch = null, custody = false;
  let canceled = false, cancellationReason = null, quarantined = false, lastNow = requestedAt, busy = false, revision = 0;
  const failures = new Set(), listeners = new Set();
  function snapshot() {
    return Object.freeze({job_id: spec.job_id, unit_name: unitName, task_scope: scope, task_deadline_ms: deadline,
      phase, dispatch_attempted: dispatched, epoch, custody_acknowledged: custody,
      cancellation_latched: canceled, cancellation_reason: cancellationReason, workspace_quarantined: quarantined,
      failure_reasons: Object.freeze([...failures]), runtime_qualification: 'NOT_ESTABLISHED_BY_SOURCE'});
  }
  function fence(code) {
    phase = 'UNRESOLVED_FENCED'; custody = false; quarantined = true;
    failures.add(code); revision++;
  }
  function cancel(code) { if (!canceled) {canceled = true; cancellationReason = code; revision++;} }
  function tickClock() {
    try {
      const n = readClock(); if (!nonnegative(n) || n < lastNow) fail('startup_clock');
      lastNow = n;
      if (phase !== 'NOT_ADMITTED' && n >= deadline) cancel('deadline');
    } catch {fence('startup_clock_failed');}
  }
  function update(action, checkTime = true, before = revision) {
    if (busy) {if (phase !== 'NOT_ADMITTED') fence('startup_reentrant_event'); fail('startup_event', 'reentrant_transition');}
    busy = true;
    try {if (checkTime && phase !== 'NOT_ADMITTED') tickClock(); action();}
    finally {
      busy = false;
      if (revision !== before) for (const listener of [...listeners]) listener();
    }
    return snapshot();
  }
  function requirePhase(expected) {if (phase !== expected) fail('startup_event', 'illegal_transition');}
  const item = {job: spec.job_id, unit: unitName, scope, owner: null};
  const operation = Object.freeze({snapshot,
    markNotAdmitted(code) {
      reason(code);
      return update(() => {requirePhase('NOT_DISPATCHED'); phase = 'NOT_ADMITTED'; failures.add(code); revision++; retained.delete(item);}, false);
    },
    markDispatchAttempted() {
      return update(() => {
        requirePhase('NOT_DISPATCHED'); if (canceled) fail('startup_event', 'dispatch_after_cancellation');
        dispatched = true; quarantined = true; phase = 'DISPATCH_IN_FLIGHT'; revision++;
      });
    },
    applyStartAck(event) {
      return update(() => {
        if (!dispatched || phase === 'NOT_ADMITTED') fail('startup_event', 'ack_before_dispatch');
        if (phase === 'UNRESOLVED_FENCED') return; // A late ACK cannot clear a fence.
        try {
          closed(event, ['binding', 'custody_acknowledged', 'worker_in_cgroup_before_exec'], [], 'startup_ack');
          const candidate = captureUnitBinding(event.binding);
          if (candidate.job_id !== spec.job_id || candidate.unit_name !== unitName ||
              event.custody_acknowledged !== true || event.worker_in_cgroup_before_exec !== true) fail('startup_ack');
          if (epoch && Object.keys(epoch).some(key => epoch[key] !== candidate[key])) fail('startup_ack');
          if (!epoch) {epoch = candidate; custody = true; phase = 'ACK_CONFIRMED'; revision++;}
        } catch {fence('startup_ack_invalid');}
      });
    },
    applyDispatchFailure(code) {
      reason(code);
      return update(() => {if (!dispatched) fail('startup_event', 'failure_before_dispatch'); fence(code);});
    },
    abort(code) {
      reason(code);
      // Intent survives both a reentrant update guard and a fallible clock.
      const before = revision; cancel(code);
      return update(() => {if (phase !== 'NOT_ADMITTED') tickClock();}, false, before);
    },
    tick() {return update(() => {});}
  });
  item.owner = operation; retained.add(item);
  internals.set(operation, {listen(fn) {listeners.add(fn); return () => listeners.delete(fn);}});
  return operation;
}

// Passive local observation: no dispatch/control port or native timer/default.
// Caller wait completion detaches only this waiter; it never discharges the owner.
export function createStartupWaiter(operation, options) {
  const internal = internals.get(operation); if (!internal) fail('startup_operation');
  closed(options, ['clock', 'caller_wait_ms'], [], 'startup_waiter');
  closed(options.clock, ['now', 'schedule'], [], 'startup_waiter_clock');
  if (typeof options.clock.now !== 'function' || typeof options.clock.schedule !== 'function' ||
      !Number.isSafeInteger(options.caller_wait_ms) || options.caller_wait_ms <= 0) fail('caller_wait_ms');
  const now = options.clock.now.bind(options.clock), schedule = options.clock.schedule.bind(options.clock);
  const start = now(), deadline = start + options.caller_wait_ms;
  if (!nonnegative(start) || !Number.isSafeInteger(deadline)) fail('caller_wait_budget');
  let lastNow = start, done = false, checking = false, arming = false, cancelTimer = null, generation = 0, delivered;
  let complete, reject;
  const result = new Promise((resolve, failWait) => {complete = resolve; reject = failWait;});
  let unlisten = () => {};
  function finish(status, snapshot, time, error = null) {
    if (done) return;
    done = true; generation++; unlisten();
    try {cancelTimer?.();} catch {error = true;}
    cancelTimer = null;
    if (error) {reject(new TypeError('startup_waiter_observation_failed')); return;}
    try {
      time = now(); if (!nonnegative(time) || time < lastNow) fail('startup_waiter_clock'); lastNow = time;
      snapshot = operation.tick();
      status = time >= deadline ? 'CALLER_WAIT_EXPIRED' :
        ['ACK_CONFIRMED', 'NOT_ADMITTED', 'UNRESOLVED_FENCED'].includes(snapshot.phase) ? snapshot.phase : status;
    } catch {reject(new TypeError('startup_waiter_observation_failed')); return;}
    delivered = Object.freeze({status, caller_waited_ms: time - start, operation_snapshot: snapshot,
      runtime_qualification: 'NOT_ESTABLISHED_BY_SOURCE'});
    complete(delivered);
  }
  function check() {
    if (done || checking || arming) return delivered ?? null;
    checking = true;
    try {
      const time = now(); if (!nonnegative(time) || time < lastNow) fail('startup_waiter_clock'); lastNow = time;
      const snapshot = operation.tick();
      const status = time >= deadline ? 'CALLER_WAIT_EXPIRED' :
        ['ACK_CONFIRMED', 'NOT_ADMITTED', 'UNRESOLVED_FENCED'].includes(snapshot.phase) ? snapshot.phase : null;
      if (status) finish(status, snapshot, time);
    } catch {finish(null, null, lastNow, true);}
    finally {checking = false;}
    return delivered ?? null;
  }
  function arm() {
    if (done) return;
    const token = ++generation; let returned = false, inline = false;
    arming = true;
    try {
      const cancel = schedule(Math.max(0, deadline - lastNow), () => {
        if (!returned) {inline = true; return;}
        if (done || token !== generation) return;
        cancelTimer = null; check(); if (!done) arm();
      });
      returned = true;
      if (typeof cancel !== 'function') fail('startup_waiter_clock.schedule');
      cancelTimer = cancel;
      if (inline) fail('startup_waiter_clock.inline_callback');
    } catch {finish(null, null, lastNow, true);}
    finally {arming = false;}
    check();
  }
  unlisten = internal.listen(check);
  check(); arm();
  return Object.freeze({result, reconcile: check});
}
