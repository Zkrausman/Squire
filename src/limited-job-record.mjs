import {closed, fail, nonnegative, text} from './job-spec.mjs';
export const LIMITED_STATUSES = Object.freeze(['LIMITED_SUCCESS', 'LIMITED_PROCESS_FAILED', 'LIMITED_TIMEOUT', 'LIMITED_USER_ABORT',
  'LIMITED_CAPACITY_EXCEEDED', 'LIMITED_PARSER_ERROR', 'LIMITED_SPAWN_FAILED', 'LIMITED_PERSISTENCE_FAILED', 'LIMITED_INTERNAL_ERROR']);
const boolean = v => typeof v === 'boolean';
const nullable = (v, predicate) => v === null || predicate(v);
export function validateLimitedJobRecord(value) {
  closed(value, ['job_id', 'task_class', 'lifecycle_status', 'requested_model', 'reported_model', 'process_exit', 'io_state',
    'containment_evidence', 'provider_metadata', 'output_custody', 'task_outcome_evaluated', 'task_payload_valid', 'error_details'], [], 'LimitedJobRecord');
  if (typeof value.job_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.job_id) ||
      !['PUBLIC_INLINE_TEXT_SUMMARIZATION_FOREGROUND', 'INERT_TIMEOUT_ACCEPTANCE_PROBE', 'BOUNDED_CODEGEN_SUMMARIZER_V5'].includes(value.task_class) ||
      !LIMITED_STATUSES.includes(value.lifecycle_status) || !text(value.requested_model) || !text(value.reported_model)) fail('limited_record');
  const p = value.process_exit, io = value.io_state, c = value.containment_evidence, m = value.provider_metadata, o = value.output_custody;
  closed(p, ['pid', 'exit_code', 'exit_signal', 'process_wall_ms', 'observed_termination'], [], 'limited_exit');
  if (!nullable(p.pid, v => Number.isSafeInteger(v) && v > 0) || !nullable(p.exit_code, Number.isSafeInteger) ||
      !nullable(p.exit_signal, text) || !nullable(p.process_wall_ms, nonnegative) || !boolean(p.observed_termination) ||
      !p.observed_termination && (p.exit_code !== null || p.exit_signal !== null)) fail('limited_exit');
  closed(io, ['stdout_bytes_observed', 'stderr_bytes_observed', 'stdout_eof', 'stderr_eof', 'io_drained'], [], 'limited_io');
  if (![io.stdout_bytes_observed, io.stderr_bytes_observed].every(nonnegative) || ![io.stdout_eof, io.stderr_eof, io.io_drained].every(boolean) ||
      io.io_drained && (!io.stdout_eof || !io.stderr_eof)) fail('limited_io');
  closed(c, ['containment_level', 'settlement_status', 'descendant_guarantee'], [], 'limited_containment');
  if (c.containment_level !== 'DIRECT_CHILD_ONLY_NO_DESCENDANT_TRACKING' || c.descendant_guarantee !== 'NONE' ||
      !['SETTLED_DIRECT_CHILD_EXIT', 'SIGNALED_DIRECT_CHILD', 'ABANDONED_UNSETTLED', 'UNKNOWN'].includes(c.settlement_status) ||
      c.settlement_status === 'SETTLED_DIRECT_CHILD_EXIT' && !p.observed_termination ||
      c.settlement_status === 'ABANDONED_UNSETTLED' && p.observed_termination) fail('limited_containment');
  closed(m, ['provider_reported_status', 'duration_seconds', 'usage_tokens'], [], 'limited_metadata');
  if (!nullable(m.provider_reported_status, text) || !nullable(m.duration_seconds, v => Number.isFinite(v) && v >= 0)) fail('limited_metadata');
  closed(m.usage_tokens, ['input', 'output', 'cache_read', 'thinking', 'total'], [], 'limited_usage');
  if (Object.values(m.usage_tokens).some(v => v !== 'UNKNOWN' && !nonnegative(v))) fail('limited_usage');
  closed(o, ['persisted', 'path', 'byte_count', 'persistence_error'], [], 'limited_output');
  if (!boolean(o.persisted) || !nullable(o.path, text) || !nullable(o.byte_count, nonnegative) || !nullable(o.persistence_error, text) ||
      o.persisted && (!text(o.path) || !nonnegative(o.byte_count))) fail('limited_output');
  closed(value.error_details, ['code', 'classification', 'message'], [], 'limited_error');
  if (Object.values(value.error_details).some(v => !nullable(v, text)) || !boolean(value.task_outcome_evaluated) ||
      !nullable(value.task_payload_valid, boolean) || value.task_class === 'BOUNDED_CODEGEN_SUMMARIZER_V5' && value.task_outcome_evaluated !== false) fail('limited_outcome');
  if (value.lifecycle_status === 'LIMITED_SUCCESS' && (!p.observed_termination || p.exit_code !== 0 || p.exit_signal !== null ||
      !io.io_drained || io.stdout_bytes_observed > 1048576 || io.stderr_bytes_observed > 65536 || m.provider_reported_status !== 'SUCCESS' ||
      value.task_payload_valid !== true || !o.persisted || c.settlement_status !== 'SETTLED_DIRECT_CHILD_EXIT')) fail('limited_success');
  return Object.freeze({...value, process_exit: Object.freeze({...p}), io_state: Object.freeze({...io}), containment_evidence: Object.freeze({...c}),
    provider_metadata: Object.freeze({...m, usage_tokens: Object.freeze({...m.usage_tokens})}), output_custody: Object.freeze({...o}), error_details: Object.freeze({...value.error_details})});
}
