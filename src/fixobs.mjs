// Pure canonical-buffer predicates and explicit-time source model. No I/O,
// timers, GTK, launcher, observer, supervisor, or native activation ports.
import {types} from 'node:util';
export {FIXOBS, advanceFixobsState, inFixobsMark} from './fixobs-state.mjs';
import {FIXOBS} from './fixobs-state.mjs';

export const FIXOBS_CONTRACT = Object.freeze({
  schema: 'squire.fixobs.source_model.v1',
  sha256: 'be92d4b36b632152e3a4bf9f83e004a241ca6912b361e5766ced8898f836f10b',
  runtime_admitted: false,
});
const size = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const backing = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer').get;
function copyFrame(value) {
  try {
    if (types.isProxy(value) || !types.isUint8Array(value) ||
        Object.getPrototypeOf(value) !== Uint8Array.prototype ||
        Reflect.apply(size, value, []) !== FIXOBS.bytes ||
        types.isSharedArrayBuffer(Reflect.apply(backing, value, []))) return null;
    // Use an intrinsic copy, never a caller iterator or species constructor.
    const copy = new Uint8Array(FIXOBS.bytes);
    Uint8Array.prototype.set.call(copy, value);
    return copy;
  } catch { return null; }
}
const result = (stage, reason) => Object.freeze({stage,
  predicate: reason === 'MATCH' ? 'MATCH' : 'UNKNOWN', reason,
  qualified_observation: false, runtime_admitted: false});

function compare(stage, frame, previous) {
  const color = FIXOBS.colors[stage];
  let changed = false;
  for (let y = 0, offset = 0; y < FIXOBS.height; y++) {
    for (let x = 0; x < FIXOBS.width; x++, offset += 4) {
      if (frame[offset + 3] !== 255) return result(stage, 'NONOPAQUE_PIXEL');
      const core = x >= 560 && x < 720 && y >= 280 && y < 440;
      const mark = x >= 540 && x < 740 && y >= 260 && y < 460;
      for (let c = 0; c < 3; c++) {
        if (core && Math.abs(frame[offset + c] - color[c]) > 5) return result(stage, 'CORE_MISMATCH');
        if (!mark && stage === 'S0' && Math.abs(frame[offset + c] - 30) > 3) return result(stage, 'BACKGROUND_MISMATCH');
        if (!mark && previous && Math.abs(frame[offset + c] - previous[offset + c]) > 2) return result(stage, 'BACKGROUND_DRIFT');
        if (previous && frame[offset + c] !== previous[offset + c]) changed = true;
      }
    }
  }
  if (previous && !changed) return result(stage, 'NO_VISUAL_DELTA');
  return result(stage, 'MATCH');
}

export function evaluateFixobsFrame(stage, bytes, previousBytes = null) {
  if (!['S0', 'S1', 'S2'].includes(stage)) return result(null, 'INVALID_STAGE');
  const frame = copyFrame(bytes);
  if (!frame) return result(stage, 'INVALID_CANONICAL_BUFFER');
  const previous = stage === 'S0' ? null : copyFrame(previousBytes);
  if (stage !== 'S0' && !previous) return result(stage, 'MISSING_PREVIOUS_BUFFER');
  if (previous && compare(stage === 'S1' ? 'S0' : 'S1', previous, null).predicate !== 'MATCH') return result(stage, 'PREVIOUS_PREDICATE_MISMATCH');
  // This API compares supplied buffers only. The sequence model enforces the
  // validated prior frame, action ordering and timing; neither proves app identity.
  return compare(stage, frame, previous);
}

const clockValue = value => Number.isSafeInteger(value) && value >= 0;
export function createFixobsObservation(t0_ms) {
  if (!clockValue(t0_ms) || !Number.isSafeInteger(t0_ms + 60000)) throw new TypeError('INVALID_FIXOBS_CLOCK');
  let last = t0_ms, phase = 'LAUNCH', phaseDeadline = t0_ms + 10000;
  let prior = null, launches = 0, keys = 0, clicks = 0, attempts = 0;
  let stopAt = null, cleanupDeadline = null, cleanupWindow = 'NOT_STARTED';
  let observation = 'NOT_RUN', reason = null;
  const frames = ['NOT_RUN', 'NOT_RUN', 'NOT_RUN'];
  const snapshot = () => Object.freeze({schema: FIXOBS_CONTRACT.schema,
    t0_ms, last_ms: last, active_deadline_ms: t0_ms + 30000,
    total_deadline_ms: t0_ms + 60000, phase, phase_deadline_ms: phaseDeadline,
    first_stop_ms: stopAt, cleanup_deadline_ms: cleanupDeadline,
    cleanup_window: cleanupWindow, cleanup_observed: 'UNKNOWN',
    observation, reason, frames: Object.freeze([...frames]),
    modeled_reservations: Object.freeze({launches, logical_keys: keys,
      logical_clicks: clicks, capture_attempts: attempts}),
    runtime_admitted: false, qualified_observation: false,
    custody_established: false, process_ceiling_enforced: false});
  function stop(at, why, complete = false) {
    if (stopAt !== null) return;
    stopAt = at; cleanupDeadline = Math.min(t0_ms + 60000, at + 30000);
    cleanupWindow = at >= cleanupDeadline ? 'ELAPSED' : 'OPEN'; phase = 'STOPPED'; phaseDeadline = null;
    prior = null; observation = complete ? 'BUFFER_SEQUENCE_MATCH' : 'UNKNOWN'; reason = why;
  }
  function check(at) {
    if (!clockValue(at) || at < last) { stop(last, 'INVALID_CLOCK'); return false; }
    last = at;
    if (stopAt !== null) {
      if (at >= cleanupDeadline) cleanupWindow = 'ELAPSED';
      return false;
    }
    // Validation and all modeled dispatch/capture work fit the same phase cap.
    if (at > phaseDeadline || at > t0_ms + 30000) { stop(at, 'PHASE_DEADLINE'); return false; }
    return true;
  }
  function wrong(at) { stop(at, 'UNEXPECTED_SEQUENCE'); return snapshot(); }
  return Object.freeze({snapshot,
    reserveLaunch(at) {
      if (!check(at)) return snapshot();
      if (phase !== 'LAUNCH') return wrong(at);
      launches++; phase = 'F0'; observation = 'IN_PROGRESS'; return snapshot();
    },
    reserveAction(kind, at) {
      if (!check(at)) return snapshot();
      if (phase === 'KEY' && kind === 'SPACE_STROKE') { keys++; phase = 'F1'; }
      else if (phase === 'CLICK' && kind === 'BUTTON1_CENTER_STROKE') { clicks++; phase = 'F2'; }
      else return wrong(at);
      return snapshot();
    },
    acceptCandidate(bytes, at, validationCompletedAt = at) {
      if (!check(at)) return snapshot();
      const index = ['F0', 'F1', 'F2'].indexOf(phase);
      if (index < 0 || attempts >= 3) return wrong(at);
      attempts++;
      const candidate = copyFrame(bytes);
      const verdict = candidate ? compare(`S${index}`, candidate, prior) : result(`S${index}`, 'INVALID_CANONICAL_BUFFER');
      // Explicit completion time models validation overhead; no hidden clock,
      // resampling or borrowed phase/cleanup time.
      if (!check(validationCompletedAt)) { frames[index] = 'UNKNOWN'; return snapshot(); }
      frames[index] = verdict.predicate;
      if (verdict.predicate !== 'MATCH') { stop(validationCompletedAt, verdict.reason); return snapshot(); }
      if (index === 2) { stop(validationCompletedAt, 'THREE_BUFFER_PREDICATES_MATCH', true); return snapshot(); }
      prior = candidate;
      phase = index === 0 ? 'KEY' : 'CLICK';
      phaseDeadline = Math.min(t0_ms + (index === 0 ? 18000 : 26000), validationCompletedAt + 8000);
      return snapshot();
    },
    poll(at) { check(at); return snapshot(); },
    stop(at) { if (check(at)) stop(at, 'CALLER_STOP'); return snapshot(); },
  });
}
