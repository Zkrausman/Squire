import {closed, fail, nonnegative} from './job-spec.mjs';

// Internal bounded observer. Dispatch is injected; no transport or timer defaults.
export function observeStopAcknowledgement(options) {
  closed(options, ['dispatch', 'clock', 'deadline_ms', 'acknowledged', 'failed'], [], 'stop_ack_observer');
  const {dispatch, clock, acknowledged, failed, deadline_ms: deadline} = options;
  closed(clock, ['now', 'schedule'], [], 'stop_ack_clock');
  if ([dispatch, acknowledged, failed, clock.now, clock.schedule].some(v => typeof v !== 'function') || !nonnegative(deadline)) fail('stop_ack_observer');
  let done = false, cancelTimer = null, lastNow = -1, resolve;
  const result = new Promise(complete => {resolve = complete;});
  function now() {
    const n = clock.now(); if (!nonnegative(n) || n < lastNow) fail('stop_ack_clock');
    lastNow = n; return n;
  }
  function finish(status, code, response) {
    if (done) return;
    done = true;
    try { cancelTimer?.(); } catch {status = 'UNKNOWN'; code = 'stop_ack_timer_failed';}
    cancelTimer = null;
    if (status === 'ACKNOWLEDGED') {
      try { if (now() >= deadline || acknowledged(response) !== true) throw new Error(); }
      catch {status = 'UNKNOWN'; code = 'stop_ack_invalid_or_late';}
    }
    if (status === 'UNKNOWN') failed(code);
    resolve(Object.freeze({status}));
  }
  function arm(time) {
    let returned = false, inline = false;
    const cancel = clock.schedule(Math.max(0, deadline - time), () => {
      if (!returned) {inline = true; return;}
      if (done) return;
      cancelTimer = null;
      try { const t = now(); if (t < deadline) arm(t); else finish('UNKNOWN', 'stop_ack_timeout'); }
      catch {finish('UNKNOWN', 'stop_ack_timer_failed');}
    });
    returned = true;
    if (typeof cancel !== 'function') fail('stop_ack_clock.schedule');
    cancelTimer = cancel;
    if (inline) fail('stop_ack_clock.inline_callback');
  }
  try {
    const time = now();
    if (time >= deadline) finish('UNKNOWN', 'stop_ack_timeout');
    else {
      arm(time);
      if (!done) {
        const response = dispatch();
        // Consume both outcomes even if a failure/cancellation wins the race.
        Promise.resolve(response).then(value => {
          if (!done) finish('ACKNOWLEDGED', null, value);
        }, () => {if (!done) finish('UNKNOWN', 'stop_ack_rejected');});
      }
    }
  } catch {finish('UNKNOWN', 'stop_ack_dispatch_or_timer_failed');}
  return Object.freeze({result, pending: () => !done, cancel: () => finish('UNKNOWN', 'stop_ack_canceled')});
}
