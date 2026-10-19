import {validateJobSpec, closed, fail} from './job-spec.mjs';
import {validateJobRecord, TERMINAL_STATUSES} from './job-record.mjs';

export const LIFECYCLE_STATUSES = Object.freeze([
  'SUBMITTED', 'RUNNING', 'VERIFYING_ARTIFACTS', 'SETTLING_DESCENDANTS', ...TERMINAL_STATUSES
]);
const successPath = Object.freeze({
  SUBMITTED: 'RUNNING', RUNNING: 'VERIFYING_ARTIFACTS',
  VERIFYING_ARTIFACTS: 'SETTLING_DESCENDANTS', SETTLING_DESCENDANTS: 'SUCCESS'
});

export function createLifecycle(specification) {
  return Object.freeze({job_spec: validateJobSpec(specification), lifecycle_status: 'SUBMITTED'});
}

// Immutable value transformation, not a runtime coordinator or proof of actual execution.
export function advanceLifecycle(current, target, finalRecord) {
  closed(current, ['job_spec', 'lifecycle_status'], [], 'lifecycle');
  const spec = validateJobSpec(current.job_spec);
  const from = current.lifecycle_status;
  if (!LIFECYCLE_STATUSES.includes(from) || !LIFECYCLE_STATUSES.includes(target)) fail('lifecycle_status');
  if (TERMINAL_STATUSES.includes(from)) fail('transition', 'illegal_transition');
  // Failure/cancellation finalization and RUNNING -> settlement depend on the open design choices.
  if (['FAILED', 'CANCELED'].includes(target) || from === 'RUNNING' && target === 'SETTLING_DESCENDANTS') {
    fail('transition', 'pending_design_decision');
  }
  if (successPath[from] !== target) fail('transition', 'illegal_transition');
  if (target === 'SUCCESS') {
    const record = validateJobRecord(spec, finalRecord);
    if (record.lifecycle_status !== 'SUCCESS') fail('success_evidence');
  } else if (finalRecord !== undefined) fail('final_record_before_terminal');
  return Object.freeze({job_spec: spec, lifecycle_status: target});
}
