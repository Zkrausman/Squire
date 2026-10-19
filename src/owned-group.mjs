import {closed, nonnegative, text, fail} from './job-spec.mjs';

// Correlation and pure guards only. No PID lookup, atomic ownership or OS signalling.
export function captureGroupObservation(group, input) {
  closed(group, ['job_id', 'pgid', 'identity'], [], 'owned_group');
  if (!text(group.job_id) || !Number.isSafeInteger(group.pgid) || group.pgid <= 1 ||
      group.identity === null || typeof group.identity !== 'object') fail('owned_group');
  const keys = ['job_id', 'pgid', 'identity', 'live_count', 'coverage_complete', 'signal_safe'];
  closed(input, keys, [], 'owned_group_observation');
  if (input.job_id !== group.job_id || input.pgid !== group.pgid || input.identity !== group.identity ||
      !nonnegative(input.live_count) || typeof input.coverage_complete !== 'boolean' || typeof input.signal_safe !== 'boolean') fail('owned_group_observation');
  return Object.freeze(Object.fromEntries(keys.map(key => [key, input[key]])));
}

export function requireSignalGuard(group, signal, input) {
  const observation = captureGroupObservation(group, input);
  if (!['SIGTERM', 'SIGKILL'].includes(signal) || !observation.signal_safe || observation.live_count === 0) fail('signal_target');
  // Coverage controls settlement claims, not a separately qualified signal target.
  return observation;
}
