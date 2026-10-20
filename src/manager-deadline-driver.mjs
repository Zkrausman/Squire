import {closed, fail, nonnegative} from './job-spec.mjs';

const drivenSessions = new WeakSet(); // Local ownership only, no durable host fence.

// Drives one existing acknowledged session deadline. No native defaults, transport,
// observation polling, acknowledgement synthesis or background retention after return.
export function createManagerDeadlineDriver(options) {
  closed(options, ['session', 'clock'], [], 'deadline_driver');
  const {session, clock} = options;
  const keys = ['snapshot', 'start', 'abort', 'tick', 'settle', 'observe', 'nativeExit',
    'disconnected', 'observationFailed', 'schedulingFailed', 'releaseWorkspace'];
  closed(session, keys, ['stopAcknowledgement'], 'custody_session');
  closed(clock, ['now', 'schedule'], [], 'deadline_clock');
  if (keys.some(key => typeof session[key] !== 'function') || typeof clock.now !== 'function' ||
      typeof clock.schedule !== 'function') fail('deadline_driver');
  const call = Object.freeze(Object.fromEntries(keys.map(key => [key, session[key].bind(session)])));
  const readClock = clock.now.bind(clock), schedule = clock.schedule.bind(clock);
  const initial = call.snapshot();
  if (!initial.started || !initial.unit || initial.custody_acknowledged !== true ||
      initial.admission_quarantined || initial.local_workspace_released || !nonnegative(initial.task_deadline_ms)) fail('custody_not_acknowledged');
  if (drivenSessions.has(session)) fail('deadline_driver_in_progress');
  const binding = initial.unit, deadline = initial.task_deadline_ms;
  let done = false, finishing = false, cancelTimer = null, generation = 0, lastNow = -1, delivered;
  let resolve;
  const result = new Promise(complete => { resolve = complete; });
  function now() {
    const value = readClock(); if (!nonnegative(value) || value < lastNow) fail('deadline_clock');
    lastNow = value; return value;
  }
  function sameEpoch(state) {
    return state.unit && ['job_id', 'unit_name', 'invocation_id'].every(key => state.unit[key] === binding[key]);
  }
  function terminal(state) {
    if (state.local_workspace_released) return 'RELEASED';
    if (state.admission_quarantined || !sameEpoch(state) || !state.custody_acknowledged) return 'FENCED';
    if (state.canceled) return state.cancellation_reason === 'timeout' ? 'DEADLINE' : 'CANCELED';
    return null;
  }
  function finish(status) {
    if (done || finishing) return;
    finishing = true; generation++;
    try { cancelTimer?.(); } catch { call.schedulingFailed(); }
    cancelTimer = null;
    // A timer-cancellation callback may latch abort, release, uncertainty or consume
    // time. The final source snapshot must reflect those effects without reset.
    const state = call.tick();
    status = terminal(state) ?? status;
    delivered = Object.freeze({status, state, runtime_qualification: 'NOT_ESTABLISHED_BY_SOURCE'});
    done = true; finishing = false; drivenSessions.delete(session); resolve(delivered);
  }
  function failed() { call.schedulingFailed(); finish('FENCED'); }
  function arm(time) {
    const token = ++generation; let returned = false, inline = false;
    const cancel = schedule(Math.max(0, deadline - time), () => {
      if (!returned) { inline = true; return; }
      if (done || finishing || token !== generation) return;
      cancelTimer = null; wake();
    });
    returned = true;
    if (typeof cancel !== 'function') fail('deadline_clock.schedule');
    cancelTimer = cancel;
    if (inline) fail('deadline_clock.inline_callback');
  }
  function wake() {
    if (done || finishing) return;
    try {
      const time = now(), state = call.tick(), status = terminal(state);
      if (status) { finish(status); return; }
      // The core and driver must share a monotonic time domain. A disagreement
      // cannot be promoted into a synthetic timeout or a successful completion.
      if (time >= deadline) { failed(); return; }
      arm(time); // Early timer delivery checks the original absolute deadline.
    } catch { failed(); }
  }
  drivenSessions.add(session);
  const driver = Object.freeze({result,
    abort() {
      if (done) return delivered;
      call.abort(); // Preserve intent before fallible clock/timer/control operations.
      finish('CANCELED'); return delivered ?? Object.freeze({status: 'CANCELED', state: call.snapshot(), runtime_qualification: 'NOT_ESTABLISHED_BY_SOURCE'});
    },
    reconcile() {
      if (done) return delivered;
      if (finishing) return null;
      try {
        now(); const status = terminal(call.tick());
        if (status) finish(status);
      } catch { failed(); }
      return delivered ?? null;
    }
  });
  wake();
  return driver;
}
