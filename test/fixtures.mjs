export const spec = () => ({
  job_id: '12345678-1234-4abc-8def-123456789abc', task_scope: '/fixture/workspace',
  provider_id: 'native_codex', requested_model: 'fixture-model',
  max_wall_clock_sec: 300, max_steps: 10, required_artifacts: ['result.txt']
});
export const record = () => ({
  job_id: spec().job_id, reported_model: 'UNKNOWN', lifecycle_status: 'SUCCESS',
  process_exit_code: 0, process_wall_ms: 12, inference_time_ms: 'UNKNOWN',
  usage_tokens: {}, artifact_witness: {'result.txt': {byte_count: 1, sha256: 'a'.repeat(64)}},
  settlement_status: 'CLEAN'
});
