import {closed, fail, nonnegative} from './job-spec.mjs';

const activeSessions = new WeakSet(); // Local overlap guard, not host exclusivity.

// Observation-only source adapter. No native defaults, bus, service creation,
// background loop or retry. A pending read never constitutes manager custody.
export function createManagerObservationBridge(options) {
  closed(options, ['session', 'source', 'clock', 'read_timeout_ms'], [], 'observation_bridge');
  const {session, source, clock} = options;
  closed(source, ['nextEvent'], [], 'observation_source');
  closed(clock, ['now', 'schedule'], [], 'observation_clock');
  const sessionKeys = ['snapshot', 'start', 'abort', 'tick', 'settle', 'observe', 'nativeExit',
    'disconnected', 'observationFailed', 'releaseWorkspace'];
  closed(session, sessionKeys, ['schedulingFailed', 'stopAcknowledgement'], 'custody_session');
  if (sessionKeys.some(key => typeof session[key] !== 'function') || typeof source.nextEvent !== 'function' ||
      typeof clock.now !== 'function' || typeof clock.schedule !== 'function' ||
      !Number.isSafeInteger(options.read_timeout_ms) || options.read_timeout_ms <= 0) fail('observation_bridge');
  const call = Object.freeze(Object.fromEntries(sessionKeys.map(key => [key, session[key].bind(session)])));
  const nextEvent = source.nextEvent.bind(source), readClock = clock.now.bind(clock), schedule = clock.schedule.bind(clock);
  const timeout = options.read_timeout_ms;
  const initial = call.snapshot();
  if (!initial.started || !initial.unit || initial.custody_acknowledged !== true ||
      initial.admission_quarantined || initial.local_workspace_released || !nonnegative(initial.task_deadline_ms)) fail('custody_not_acknowledged');
  const epoch = initial.unit, deadline = initial.task_deadline_ms;
  let lastNow = -1, pending = null, stopped = false;
  function now() {
    const n = readClock(); if (!nonnegative(n) || n < lastNow) fail('observation_clock');
    lastNow = n; return n;
  }
  function result(status, state) { return Object.freeze({status, state, runtime_qualification: 'NOT_ESTABLISHED_BY_SOURCE'}); }
  function sameEpoch(state) {
    return state.unit && ['job_id', 'unit_name', 'invocation_id'].every(key => state.unit[key] === epoch[key]);
  }
  function failRead() {
    stopped = true;
    return result('READ_FAILED', call.observationFailed());
  }
  function eligible() {
    const state = call.snapshot();
    return !stopped && sameEpoch(state) && !state.admission_quarantined && !state.local_workspace_released;
  }
  function finish(active, status, state) {
    if (pending !== active || active.done) return;
    active.done = true;
    try { active.cancelTimer?.(); } catch { status = 'READ_FAILED'; state = call.observationFailed(); stopped = true; }
    // Aborts only the observation read; never native service cleanup or a fallback.
    try { active.controller.abort(); } catch { status = 'READ_FAILED'; state = call.observationFailed(); stopped = true; }
    // A cancellation callback may consume time or latch session cancellation.
    // Recheck the existing task clock after cleanup without losing raw exit data.
    let latest = call.tick();
    if (latest.admission_quarantined && status === 'OBSERVED') status = 'FENCED';
    if (status === 'OBSERVED' && latest.cancellation_reason === 'timeout') { stopped = true; status = 'DEADLINE'; }
    if (status === 'OBSERVED' && latest.canceled) status = 'CANCELED';
    pending = null; activeSessions.delete(session); active.resolve(result(status, latest));
  }
  function expired(active) {
    if (pending !== active || active.done) return;
    try {
      const time = now();
      if (time < active.at) { arm(active, time); return; }
      if (time >= deadline) {
        stopped = true; finish(active, 'DEADLINE', call.tick());
      } else {
        stopped = true; finish(active, 'READ_FAILED', call.observationFailed());
      }
    } catch { finish(active, 'READ_FAILED', failRead().state); }
  }
  function arm(active, time) {
    let returned = false, inline = false;
    const cancel = schedule(Math.max(0, active.at - time), () => {
      if (!returned) { inline = true; return; }
      expired(active);
    });
    returned = true;
    if (typeof cancel !== 'function') fail('observation_clock.schedule');
    active.cancelTimer = cancel;
    if (inline) fail('observation_clock.inline_callback');
  }
  function deliver(active, event) {
    if (pending !== active || active.done) return;
    try {
      // A released or quarantined session cannot be revived by a queued event.
      if (!eligible()) { stopped = true; finish(active, 'FENCED', call.snapshot()); return; }
      closed(event, ['type', 'value'], [], 'manager_event');
      let state;
      // Native raw exit capture precedes fallible clock reads, as in the core.
      if (event.type === 'native_exit') state = call.nativeExit(event.value);
      else if (event.type === 'cgroup') {
        if (now() >= active.at) { expired(active); return; }
        state = call.observe(event.value);
      } else if (event.type === 'manager_disconnected') {
        closed(event.value, ['binding'], [], 'disconnect_event');
        closed(event.value.binding, ['job_id', 'unit_name', 'invocation_id'], [], 'disconnect_binding');
        if (['job_id', 'unit_name', 'invocation_id'].some(key => event.value.binding[key] !== epoch[key])) fail('disconnect_binding');
        state = call.disconnected(); stopped = true;
      } else fail('manager_event');
      if (state.admission_quarantined) { stopped = true; finish(active, 'FENCED', state); return; }
      // An observed native exit may be retained after a late callback, but lateness
      // must still trigger the original task deadline or read-uncertainty fence.
      if (now() >= active.at) { expired(active); return; }
      finish(active, 'OBSERVED', state);
    } catch { finish(active, 'READ_FAILED', failRead().state); }
  }
  return Object.freeze({
    readNext() {
      if (pending || activeSessions.has(session)) fail('observation_read_in_progress');
      if (!eligible()) return Promise.resolve(result('FENCED', call.snapshot()));
      let time;
      try { time = now(); }
      catch { return Promise.resolve(failRead()); }
      if (time >= deadline) { stopped = true; return Promise.resolve(result('DEADLINE', call.tick())); }
      const at = Math.min(deadline, time + timeout);
      if (!Number.isSafeInteger(at)) fail('observation_budget');
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      const active = {at, resolve, controller: new AbortController(), cancelTimer: null, done: false};
      pending = active; activeSessions.add(session);
      try {
        arm(active, time);
        if (pending !== active || active.done) return promise;
        const response = nextEvent(Object.freeze({binding: epoch, signal: active.controller.signal}));
        // Both continuations are installed even if cancellation/timeout wins;
        // late fulfillment and rejection cannot mutate state or escape unhandled.
        Promise.resolve(response).then(event => deliver(active, event), () => {
          if (pending === active && !active.done) finish(active, 'READ_FAILED', failRead().state);
        });
      } catch { finish(active, 'READ_FAILED', failRead().state); }
      return promise;
    },
    close() {
      // Passive read closure is distinct from task abort. The injected read's
      // AbortSignal is cooperative observer cancellation, never native cleanup.
      stopped = true;
      if (pending) finish(pending, 'CLOSED', call.snapshot());
      return result('CLOSED', call.snapshot());
    },
    abort() {
      const state = call.abort(); stopped = true;
      if (pending) finish(pending, 'CANCELED', state);
      return result('CANCELED', call.snapshot());
    }
  });
}
