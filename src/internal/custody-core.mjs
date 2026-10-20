import {validateJobSpec, closed, fail, nonnegative} from '../job-spec.mjs';
import {resolve} from 'node:path';
import {observeStopAcknowledgement} from '../stop-acknowledgement.mjs';
import {captureInvocation} from '../execution-wrapper.mjs';

// Lexical authority is confined to this module instance, not a host security boundary.
const retained = new Set(), internals = new WeakMap(), sessions = new WeakMap();
const allUnits = new Set(), allJobs = new Set(), allWorkspaces = new Set();
const overlaps = (a, b) => a !== null && b !== null && (a === b || a.startsWith(b + '/') || b.startsWith(a + '/'));
function sampleClock(cell) {
  const n = cell.readClock();
  if (!nonnegative(n) || n < cell.lastNow) fail('custody_clock');
  cell.lastNow = n; return n;
}
function checkReservations(spec, unit, excluded = null) {
  if (allUnits.has(unit) || allJobs.has(spec.job_id) || [...allWorkspaces].some(scope => overlaps(scope, spec.task_scope)) ||
      [...retained].some(item => item !== excluded && (item.job === spec.job_id || item.unit === unit || overlaps(item.scope, spec.task_scope)))) fail('custody_reservation');
}

export const CUSTODY_AMENDMENT = 'SQ-AMEND-2026-10-CUSTODY-03';
export const HOST_GATES = Object.freeze(['stable_manager_lifetime', 'failed_nonempty_unit_retention',
  'exclusive_epoch_authority', 'launch_inside_cgroup', 'cgroup_v2_descendant_coverage',
  'non_adversarial_workload_no_escape', 'no_external_cgroup_admission']);

export function captureUnitBinding(value) {
  closed(value, ['job_id', 'unit_name', 'invocation_id'], [], 'unit_binding');
  if (typeof value.job_id !== 'string' || typeof value.unit_name !== 'string' || !/^squire-[a-zA-Z0-9-]+\.service$/.test(value.unit_name) ||
      typeof value.invocation_id !== 'string' || !/^[a-fA-F0-9]{32}$/.test(value.invocation_id) || /^0+$/.test(value.invocation_id)) fail('unit_binding');
  return Object.freeze({...value});
}
function matches(expected, input) {
  const actual = captureUnitBinding(input);
  if (Object.keys(expected).some(key => actual[key] !== expected[key])) fail('unit_epoch_conflict');
  return actual;
}

// Source-injected contract only: no bus connection, native implementation, timers,
// enumeration, pidfds or process-group signalling. Ports must be bounded synchronous
// calls; the optional async-stop branch observes its response separately.
// Actual transport and host qualification remain unimplemented.
export function createManagerCustodyFactory(options) { return custodyFactory(options, null); }

// Start still requires the original verified synchronous custody acknowledgement.
export function createAsyncStopManagerCustodyFactory(options) {
  closed(options, ['manager', 'clock', 'qualification', 'stop_ack_timeout_ms'], [], 'async_stop_factory');
  closed(options.clock, ['now', 'schedule'], [], 'async_stop_clock');
  if (typeof options.clock.now !== 'function' || typeof options.clock.schedule !== 'function' ||
      !Number.isSafeInteger(options.stop_ack_timeout_ms) || options.stop_ack_timeout_ms <= 0) fail('async_stop_factory');
  return custodyFactory({manager: options.manager, clock: {now: options.clock.now.bind(options.clock)}, qualification: options.qualification},
    {schedule: options.clock.schedule.bind(options.clock), timeout: options.stop_ack_timeout_ms});
}

function custodyFactory(options, asyncStop) {
  closed(options, ['manager', 'clock', 'qualification'], [], 'custody_factory');
  const {manager, clock, qualification} = options;
  closed(manager, ['startTransientUnit', 'stopUnit'], [], 'manager');
  closed(clock, ['now'], [], 'clock');
  closed(qualification, HOST_GATES, [], 'host_qualification');
  if (typeof manager.startTransientUnit !== 'function' || typeof manager.stopUnit !== 'function' ||
      typeof clock.now !== 'function') fail('custody_ports');
  const eligible = HOST_GATES.every(key => qualification[key] === true);
  if (HOST_GATES.some(key => typeof qualification[key] !== 'boolean')) fail('host_qualification');
  const startUnit = manager.startTransientUnit.bind(manager), stopUnit = manager.stopUnit.bind(manager), readClock = clock.now.bind(clock);

  // Shared single-module reservations, never host/cross-process admission.
  const units = new Set(), jobs = new Set(), workspaces = new Set();
  function inputs(specification, invocation, suppliedPolicy) {
    const spec = validateJobSpec(specification), worker = captureInvocation(invocation);
    closed(suppliedPolicy, ['unit_name', 'stop_grace_ms'], [], 'custody_policy');
    if (!eligible) fail('host_not_qualified');
    const policy = Object.freeze({...suppliedPolicy});
    if (typeof policy.unit_name !== 'string' || !/^squire-[a-zA-Z0-9-]+\.service$/.test(policy.unit_name) ||
        !Number.isSafeInteger(policy.stop_grace_ms) || policy.stop_grace_ms <= 0 ||
        !spec.task_scope.startsWith('/') || resolve(spec.task_scope) !== spec.task_scope || spec.task_scope === '/' || worker.env.TMPDIR !== spec.task_scope) fail('custody_policy');
    return {spec, worker, policy};
  }
  function reserve(spec, policy) {
    units.add(policy.unit_name); jobs.add(spec.job_id); workspaces.add(spec.task_scope);
    allUnits.add(policy.unit_name); allJobs.add(spec.job_id); allWorkspaces.add(spec.task_scope);
  }
  function assemble(spec, worker, policy, deadline, clock_cell, startup = null) {
    const unitName = policy.unit_name, grace = policy.stop_grace_ms;
    function now() {return sampleClock(clock_cell);}
    let epoch = startup?.epoch ?? null, started = !!startup, busy = false, stopAttempted = false, stopAcknowledged = false;
    let canceled = startup?.canceled ?? false, reason = startup?.origin ?? null, unknownLatched = false, custody = !!startup, exitObserved = false, exitCode = null;
    let settlement = startup ? 'UNKNOWN' : null, count = null, populated = null, emptyProved = false, returned = false, released = false;
    let ackObserver = null, ackResult = null, ackPending = false;
    const failures = new Set();
    if (startup?.canceled) failures.add('startup_cancellation_' + startup.cancellationReason);
    function snapshot() {
      return Object.freeze({job_id: spec.job_id, unit: epoch, started, task_deadline_ms: deadline, custody_acknowledged: custody,
        canceled, cancellation_reason: reason, coordinator_returned: returned,
        process_exit_code: exitCode, settlement_status: settlement, live_count: count,
        stop_attempted: stopAttempted, stop_job_acknowledged: stopAcknowledged, stop_ack_pending: ackPending,
        workspace_reuse_blocked: !emptyProved || unknownLatched || ackPending, local_workspace_released: released,
        admission_quarantined: unknownLatched, failure_codes: Object.freeze([...failures]),
        runtime_qualification: 'NOT_ESTABLISHED_BY_SOURCE'});
    }
    function unknown(code) {
      const wasUnknown = unknownLatched;
      unknownLatched = true; custody = false; emptyProved = false;
      populated = null; count = null; settlement = 'UNKNOWN'; failures.add(code);
      ackPending = false; const observer = ackObserver; ackObserver = null; observer?.cancel();
      if (!wasUnknown) startup?.fence(code);
    }
    function stop() {
      if (stopAttempted || !epoch || unknownLatched) return;
      stopAttempted = true;
      if (asyncStop) {
        ackPending = true; emptyProved = false; populated = null; count = null; settlement = 'UNKNOWN';
        try {
          const ackDeadline = now() + asyncStop.timeout;
          if (!Number.isSafeInteger(ackDeadline)) fail('stop_ack_budget');
          const observer = observeStopAcknowledgement({clock: {now, schedule: asyncStop.schedule}, deadline_ms: ackDeadline,
            dispatch: () => stopUnit(Object.freeze({binding: epoch})),
            acknowledged(response) {
              if (unknownLatched || released) return false;
              closed(response, ['binding', 'job_acknowledged'], [], 'stop_response'); matches(epoch, response.binding);
              if (response.job_acknowledged !== true) fail('stop_response');
              stopAcknowledged = true; ackPending = false; ackObserver = null;
              // Require a fresh empty observation after acknowledgement; never
              // promote an earlier queued empty sample into post-stop proof.
              if (emptyProved) {emptyProved = false; populated = null; count = null; settlement = 'UNKNOWN';}
              return true;
            },
            failed(code) {ackPending = false; ackObserver = null; unknown(code);}
          });
          ackResult = observer.result;
          if (unknownLatched) observer.cancel();
          if (observer.pending()) ackObserver = observer;
        } catch {unknown('stop_ack_setup_failed');}
        return;
      }
      try {
        const response = stopUnit(Object.freeze({binding: epoch}));
        closed(response, ['binding', 'job_acknowledged'], [], 'stop_response'); matches(epoch, response.binding);
        if (response.job_acknowledged !== true) fail('stop_response');
        stopAcknowledged = true; // Transaction acknowledgement is never empty proof.
      } catch { unknown('stop_unconfirmed'); }
    }
    function cancelIntent(why) {
      if (canceled) return;
      canceled = true; reason = why; returned = true;
      startup?.cancel(why === 'timeout' ? 'deadline' : 'user_abort', why);
      if (!emptyProved && !unknownLatched) { populated = null; count = null; settlement = 'UNKNOWN'; }
    }
    function latch(why) { cancelIntent(why); if (started) stop(); }
    function checkDeadline() { if (now() >= deadline && !canceled) latch('timeout'); }
    function operate(action) {
      if (released) return snapshot();
      if (busy) { unknown('reentrant_manager_operation'); return snapshot(); }
      busy = true;
      try { checkDeadline(); action(); checkDeadline(); }
      catch { unknown('custody_observation_failed'); }
      finally { busy = false; }
      return snapshot();
    }
    const session = Object.freeze({snapshot,
      stopAcknowledgement: () => ackResult,
      releaseWorkspace() {
        if (released) return false;
        if (!emptyProved || unknownLatched || !custody || busy || ackPending || startup?.failure_fenced) return false;
        released = true; workspaces.delete(spec.task_scope); allWorkspaces.delete(spec.task_scope);
        startup?.releaseScope(); return true;
      },
      start() {
        return operate(() => {
          if (started || canceled || unknownLatched) return;
          started = true; settlement = 'UNKNOWN';
          try {
            const response = startUnit(Object.freeze({job_id: spec.job_id, unit_name: unitName, mode: 'fail',
              task_scope: spec.task_scope, worker, properties: Object.freeze({Type: 'exec', ExitType: 'cgroup',
                KillMode: 'control-group', Restart: 'no', KillSignal: 'SIGTERM', SendSIGKILL: true,
                FinalKillSignal: 'SIGKILL', TimeoutStopSec: grace / 1000})}));
            closed(response, ['binding', 'custody_acknowledged', 'worker_in_cgroup_before_exec'], [], 'start_response');
            const candidate = captureUnitBinding(response.binding);
            if (candidate.job_id !== spec.job_id || candidate.unit_name !== unitName ||
                response.custody_acknowledged !== true || response.worker_in_cgroup_before_exec !== true) fail('start_response');
            if (unknownLatched) return;
            epoch = candidate; custody = true;
          } catch { unknown('start_unconfirmed'); }
        });
      },
      abort() {
        if (released) return snapshot();
        cancelIntent('aborted'); // Intent survives clock failure and reentrant manager callbacks.
        return operate(() => { if (started) stop(); });
      },
      tick() { return operate(() => { if (canceled && started) {returned = true; stop();} }); },
      settle() { return operate(() => { if (started) stop(); }); },
      observe(input) {
        return operate(() => {
          if (!epoch || unknownLatched) return;
          closed(input, ['binding', 'populated', 'launch_closed', 'coverage_complete', 'exact_live_count'], [], 'cgroup_observation');
          matches(epoch, input.binding);
          if (![null, 0, 1].includes(input.populated) || typeof input.launch_closed !== 'boolean' ||
              typeof input.coverage_complete !== 'boolean' || !(input.exact_live_count === null || nonnegative(input.exact_live_count)) ||
              input.populated === null && input.exact_live_count !== null ||
              input.populated === 1 && input.exact_live_count === 0 ||
              input.populated === 0 && input.exact_live_count !== null && input.exact_live_count !== 0) fail('cgroup_observation');
          const covered = input.launch_closed && input.coverage_complete;
          populated = covered ? input.populated : null;
          count = covered ? input.exact_live_count : null;
          emptyProved = covered && populated === 0;
          if (emptyProved) { count = 0; settlement = ackPending ? 'UNKNOWN' : stopAttempted ? 'ORPHAN_KILLED' : 'CLEAN'; }
          else { settlement = canceled && now() >= deadline && populated === 1 ? 'DIRTY_LEAK' : 'UNKNOWN'; }
        });
      },
      nativeExit(input) {
        if (released) return snapshot();
        try {
          closed(input, ['binding', 'code'], [], 'native_exit');
          if (!epoch) fail('native_exit'); matches(epoch, input.binding);
          if (exitObserved || !(input.code === null || Number.isSafeInteger(input.code))) fail('native_exit');
          exitObserved = true; exitCode = input.code;
        } catch { unknown('native_exit_invalid'); return snapshot(); }
        return operate(() => {});
      },
      schedulingFailed() { if (released) return snapshot(); unknown('custody_scheduler_failed'); returned = true; return snapshot(); },
      observationFailed() { if (released) return snapshot(); unknown('observation_stream_failed'); returned = true; return snapshot(); },
      disconnected() { if (released) return snapshot(); unknown('manager_disconnected'); returned = true; return snapshot(); }
    });
    const record = {spec, unitName, grace, deadline, clock_cell, startup,
      get released() {return released;},
      fence(code) {
        // Historical evidence remains bound to this old epoch. It never bypasses
        // canonical released guards or re-acquires a newer occupant's scope.
        if (released) {failures.add(code === 'startup_ack_invalid' ? 'startup_ack_conflict' : code); return;}
        unknown(code);
      },
      cancel(code, origin) {
        if (released) {failures.add('startup_late_abort_' + code); return;}
        cancelIntent(origin); failures.add('startup_cancellation_' + code);
      }};
    return {session, record};
  }
  return Object.freeze({
    create(specification, invocation, suppliedPolicy) {
      const {spec, worker, policy} = inputs(specification, invocation, suppliedPolicy);
      checkReservations(spec, policy.unit_name);
      const clock_cell = {readClock, lastNow: -1};
      const requestedAt = sampleClock(clock_cell), duration = spec.max_wall_clock_sec * 1000;
      const deadline = requestedAt + duration;
      if (!Number.isSafeInteger(duration) || !Number.isSafeInteger(deadline)) fail('custody_budget');
      // External clock callbacks may reenter another factory before reservation.
      checkReservations(spec, policy.unit_name);
      const target = assemble(spec, worker, policy, deadline, clock_cell);
      reserve(spec, policy); sessions.set(target.session, target.record); return target.session;
    },
    adoptStartupOperation(operation, specification, invocation, suppliedPolicy) {
      const source = internals.get(operation); if (!source) fail('startup_capability');
      const {spec, worker, policy} = inputs(specification, invocation, suppliedPolicy);
      if (source.adopted) fail('startup_already_adopted');
      if (source.preparing) fail('startup_preparing');
      if (source.phase !== 'ACK_CONFIRMED' || source.failure_fenced || !source.quarantined || source.epoch === null || typeof source.epoch !== 'object') fail('startup_capability');
      source.preparing = true;
      try {
        if (JSON.stringify(spec) !== JSON.stringify(source.spec)) fail('job_spec_mismatch');
        if (policy.unit_name !== source.epoch.unit_name) fail('startup_unit_mismatch');
        const revision = source.revision;
        let time;
        try {time = sampleClock(source.clock_cell);}
        catch {source.fence('custody_clock_failed'); fail('custody_clock_failed');}
        if (source.revision !== revision) fail('startup_prepare_changed');
        if (time >= source.deadline) source.cancel('deadline', 'timeout');
        const preparedRevision = source.revision;
        checkReservations(spec, policy.unit_name, source.item);
        if (source.phase !== 'ACK_CONFIRMED' || source.failure_fenced || !source.quarantined || source.epoch === null || typeof source.epoch !== 'object' || source.revision !== preparedRevision) fail('startup_prepare_changed');
        const target = assemble(spec, worker, policy, source.deadline, source.clock_cell, source);
        // All caller/clock validation is complete. Commit makes no external calls,
        // listener notifications or RPCs; neither start nor stop is dispatched.
        try {
          reserve(spec, policy); sessions.set(target.session, target.record);
          source.bind(target.session, target.record);
        } catch {
          source.fence('startup_commit_failed'); target.record.fence('startup_commit_failed');
          throw new TypeError('startup_commit_failed');
        }
        return target.session;
      } finally {source.preparing = false;}
    }
  });
}

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
  if (allUnits.has(unitName) || allJobs.has(spec.job_id) || [...allWorkspaces].some(value => overlaps(value, scope))) fail('startup_reservation');
  for (const item of retained) {
    if (item.job === spec.job_id || item.unit === unitName || overlaps(item.scope, scope)) fail('startup_reservation');
  }
  let phase = 'NOT_DISPATCHED', dispatched = false, epoch = null, custody = false;
  let canceled = false, cancellationReason = null, quarantined = false, busy = false, revision = 0;
  let adopted = false, preparing = false, boundSession = null, targetRecord = null, origin = null, failure_fenced = false;
  const clock_cell = {readClock, lastNow: requestedAt};
  const failures = new Set(), listeners = new Set();
  function snapshot() {
    return Object.freeze({job_id: spec.job_id, unit_name: unitName, task_scope: scope, task_deadline_ms: deadline,
      phase, adopted, dispatch_attempted: dispatched, epoch, custody_acknowledged: custody,
      cancellation_latched: canceled, cancellation_reason: cancellationReason, workspace_quarantined: quarantined,
      failure_reasons: Object.freeze([...failures]), runtime_qualification: 'NOT_ESTABLISHED_BY_SOURCE'});
  }
  function fence(code) {
    phase = 'UNRESOLVED_FENCED'; custody = false; quarantined = true; failure_fenced = true;
    failures.add(code); revision++; targetRecord?.fence(code);
  }
  function cancel(code, why = 'aborted') {
    if (canceled) {if (targetRecord?.released) targetRecord.cancel(code, why); return;}
    canceled = true; cancellationReason = code; origin = why; revision++; targetRecord?.cancel(code, why);
  }
  function tickClock() {
    try {
      const n = sampleClock(clock_cell);
      if (phase !== 'NOT_ADMITTED' && n >= deadline) cancel('deadline', 'timeout');
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
  const item = {job: spec.job_id, unit: unitName, scope, owner: null, released: false};
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
  internals.set(operation, {
    spec, policy: Object.freeze({unit_name: unitName, task_scope: scope}), deadline, clock_cell, item,
    get phase() {return phase;}, get adopted() {return adopted;}, get epoch() {return epoch;},
    get failure_fenced() {return failure_fenced;}, get quarantined() {return quarantined;},
    get preparing() {return preparing;}, set preparing(value) {preparing = value;},
    get revision() {return revision;}, get canceled() {return canceled;},
    get cancellationReason() {return cancellationReason;}, get origin() {return origin;},
    fence, cancel,
    bind(session, record) {
      if (sessions.get(session) !== record || record.clock_cell !== clock_cell || adopted || !preparing) fail('startup_binding');
      adopted = true; boundSession = session; targetRecord = record; revision++;
    },
    releaseScope() {item.released = true; item.scope = null; revision++;},
    listen(fn) {listeners.add(fn); return () => listeners.delete(fn);}
  });
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
