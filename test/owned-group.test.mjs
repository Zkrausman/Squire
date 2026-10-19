import test from 'node:test';
import assert from 'node:assert/strict';
import {captureGroupObservation, requireSignalGuard} from '../src/owned-group.mjs';
const identity = Object.freeze({});
const group = Object.freeze({job_id: 'fixture-job', pgid: 1234, identity});
const snapshot = () => ({...group, live_count: 1, coverage_complete: true, signal_safe: true});

test('matching terminal empty observation stays correlated without a signal target', () => {
  const input = {...snapshot(), live_count: 0};
  assert.equal(captureGroupObservation(group, input).live_count, 0);
  assert.throws(() => requireSignalGuard(group, 'SIGTERM', input));
});
test('signal safety is independent of complete descendant coverage', () => {
  const incomplete = {...snapshot(), coverage_complete: false};
  assert.equal(requireSignalGuard(group, 'SIGTERM', incomplete).coverage_complete, false);
  assert.equal(requireSignalGuard(group, 'SIGKILL', incomplete).signal_safe, true);
  assert.throws(() => requireSignalGuard(group, 'SIGTERM', {...snapshot(), signal_safe: false}));
  assert.throws(() => requireSignalGuard(group, 'SIGINT', snapshot()));
});
test('binding conflicts and malformed observation flags are rejected', () => {
  for (const patch of [{job_id: 'other'}, {pgid: 999}, {identity: {}}, {live_count: -1}, {live_count: 0.5},
    {coverage_complete: 'true'}, {signal_safe: null}, {extra: 'PRIVATE_BODY'}]) {
    assert.throws(() => captureGroupObservation(group, {...snapshot(), ...patch}));
  }
});
test('captured observations cannot be changed by later input mutation', () => {
  const input = snapshot(); const captured = captureGroupObservation(group, input);
  input.live_count = 0; input.signal_safe = false;
  assert.equal(captured.live_count, 1); assert.equal(captured.signal_safe, true);
  assert.throws(() => { captured.coverage_complete = false; }, TypeError);
});
test('observation accessors are rejected without evaluation or private value disclosure', () => {
  let reads = 0; const input = snapshot();
  Object.defineProperty(input, 'live_count', {get() { reads++; return 1; }});
  assert.throws(() => captureGroupObservation(group, input), error => !error.message.includes('PRIVATE'));
  assert.equal(reads, 0);
});
