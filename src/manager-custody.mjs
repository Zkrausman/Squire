import {validateJobSpec, closed, fail, nonnegative} from './job-spec.mjs';
import {resolve} from 'node:path';
import {captureInvocation} from './execution-wrapper.mjs';

export const CUSTODY_AMENDMENT = 'SQ-AMEND-2026-10-CUSTODY-03';
export const HOST_GATES = Object.freeze(['stable_manager_lifetime', 'failed_nonempty_unit_retention',
  'exclusive_epoch_authority', 'launch_inside_cgroup', 'cgroup_v2_descendant_coverage',
  'non_adversarial_workload_no_escape', 'no_external_cgroup_admission']);

function binding(value) {
  closed(value, ['job_id', 'unit_name', 'invocation_id'], [], 'unit_binding');
  if (typeof value.job_id !== 'string' || typeof value.unit_name !== 'string' || !/^squire-[a-zA-Z0-9-]+\.service$/.test(value.unit_name) ||
      typeof value.invocation_id !== 'string' || !/^[a-fA-F0-9]{32}$/.test(value.invocation_id) || /^0+$/.test(value.invocation_id)) fail('unit_binding');
  return Object.freeze({...value});
}
function matches(expected, input) {
  const actual = binding(input);
  if (Object.keys(expected).some(key => actual[key] !== expected[key])) fail('unit_epoch_conflict');
  return actual;
}

// Source-injected contract only: no bus connection, native implementation, timers,
// enumeration, pidfds or process-group signalling. Ports must be bounded synchronous
// operations; their actual transport and host qualification remain unimplemented.
export function createManagerCustodyFactory(options) {
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
  // Local reservation supplements, but does not prove, the host's exclusive authority
  // and non-reuse across factories, restarts or crashes. Reservations are never freed.
  const units = new Set(), jobs = new Set(), workspaces = new Set();
  return Object.freeze({create(specification, invocation, policy) {
    const spec = validateJobSpec(specification), worker = captureInvocation(invocation);
    closed(policy, ['unit_name', 'stop_grace_ms'], [], 'custody_policy');
    if (!eligible) fail('host_not_qualified');
    if (typeof policy.unit_name !== 'string' || !/^squire-[a-zA-Z0-9-]+\.service$/.test(policy.unit_name) ||
        !Number.isSafeInteger(policy.stop_grace_ms) || policy.stop_grace_ms <= 0 ||
        !spec.task_scope.startsWith('/') || resolve(spec.task_scope) !== spec.task_scope || spec.task_scope === '/' || worker.env.TMPDIR !== spec.task_scope) fail('custody_policy');
    if (units.has(policy.unit_name) || jobs.has(spec.job_id) || [...workspaces].some(scope => scope === spec.task_scope || scope.startsWith(spec.task_scope + '/') || spec.task_scope.startsWith(scope + '/'))) fail('custody_reservation');
    const unitName = policy.unit_name, grace = policy.stop_grace_ms;
    const duration = spec.max_wall_clock_sec * 1000;
    if (!Number.isSafeInteger(duration)) fail('custody_budget');
    let lastNow = -1;
    function now() {
      const n = readClock(); if (!nonnegative(n) || n < lastNow) fail('custody_clock');
      lastNow = n; return n;
    }
    const requestedAt = now(), deadline = requestedAt + duration;
    if (!Number.isSafeInteger(deadline)) fail('custody_budget');
    units.add(unitName); jobs.add(spec.job_id); workspaces.add(spec.task_scope);
    let epoch = null, started = false, busy = false, stopAttempted = false, stopAcknowledged = false;
    let canceled = false, reason = null, unknownLatched = false, custody = false, exitObserved = false, exitCode = null;
    let settlement = null, count = null, populated = null, emptyProved = false, returned = false, released = false;
    const failures = new Set();
    function snapshot() {
      return Object.freeze({job_id: spec.job_id, unit: epoch, started, custody_acknowledged: custody,
        canceled, cancellation_reason: reason, coordinator_returned: returned,
        process_exit_code: exitCode, settlement_status: settlement, live_count: count,
        stop_attempted: stopAttempted, stop_job_acknowledged: stopAcknowledged,
        workspace_reuse_blocked: !emptyProved || unknownLatched, local_workspace_released: released,
        admission_quarantined: unknownLatched, failure_codes: Object.freeze([...failures]),
        runtime_qualification: 'NOT_ESTABLISHED_BY_SOURCE'});
    }
    function unknown(code) {
      unknownLatched = true; custody = false; emptyProved = false;
      populated = null; count = null; settlement = 'UNKNOWN'; failures.add(code);
    }
    function stop() {
      if (stopAttempted || !epoch || unknownLatched) return;
      stopAttempted = true;
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
    return Object.freeze({snapshot,
      releaseWorkspace() {
        if (!emptyProved || unknownLatched || !custody || busy) return false;
        workspaces.delete(spec.task_scope); released = true; return true;
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
            const candidate = binding(response.binding);
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
      tick() { return operate(() => {}); },
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
          if (emptyProved) { count = 0; settlement = stopAttempted ? 'ORPHAN_KILLED' : 'CLEAN'; }
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
      disconnected() { if (released) return snapshot(); unknown('manager_disconnected'); returned = true; return snapshot(); }
    });
  }});
}
