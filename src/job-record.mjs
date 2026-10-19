import {validateJobSpec, closed, object, own, fail, text, nonnegative, artifactPath} from './job-spec.mjs';

export const TERMINAL_STATUSES = Object.freeze(['SUCCESS', 'FAILED', 'CANCELED']);
export const SETTLEMENT_STATUSES = Object.freeze(['CLEAN', 'ORPHAN_KILLED', 'DIRTY_LEAK']);
export const USAGE_FIELDS = Object.freeze(['input', 'output', 'cache_read', 'thinking', 'total']);
const required = ['job_id', 'reported_model', 'lifecycle_status', 'process_exit_code',
  'process_wall_ms', 'inference_time_ms', 'usage_tokens', 'artifact_witness', 'settlement_status'];

// Validates final data only. It never observes a process, verifies disk bytes or emits telemetry.
export function validateJobRecord(specification, input, observations) {
  const spec = validateJobSpec(specification);
  closed(input, required, ['error_details'], 'JobRecord');
  closed(observations, ['process_group_allocated', 'process_exit_code', 'settlement_status'], [], 'observations');
  if (typeof observations.process_group_allocated !== 'boolean') fail('process_group_allocated');
  if (observations.process_exit_code !== null && !Number.isSafeInteger(observations.process_exit_code)) fail('process_exit_code');
  if (input.process_exit_code !== observations.process_exit_code) fail('process_exit_code', 'observation_conflict');
  if (observations.process_group_allocated) {
    if (observations.settlement_status === null) fail('settlement_status', 'unrepresentable_settlement');
    if (!SETTLEMENT_STATUSES.includes(observations.settlement_status)) fail('settlement_status');
  } else if (observations.process_exit_code !== null || observations.settlement_status !== null) fail('pre_spawn_observations');
  if (input.settlement_status !== observations.settlement_status) fail('settlement_status', 'observation_conflict');
  if (input.job_id !== spec.job_id) fail('job_id');
  if (!text(input.reported_model)) fail('reported_model');
  if (!TERMINAL_STATUSES.includes(input.lifecycle_status)) fail('lifecycle_status');
  if (!nonnegative(input.process_wall_ms)) fail('process_wall_ms');
  if (input.inference_time_ms !== 'UNKNOWN' && !nonnegative(input.inference_time_ms)) fail('inference_time_ms');

  closed(input.usage_tokens, [], USAGE_FIELDS, 'usage_tokens');
  const usage = {};
  for (const key of USAGE_FIELDS) {
    const value = own(input.usage_tokens, key) ? input.usage_tokens[key] : 'UNKNOWN';
    if (value !== 'UNKNOWN' && !nonnegative(value)) fail(`usage_tokens.${key}`);
    usage[key] = value;
  }
  const witness = validateArtifactWitness(input.artifact_witness);
  if (input.lifecycle_status === 'SUCCESS') {
    if (input.process_exit_code !== 0 || !['CLEAN', 'ORPHAN_KILLED'].includes(input.settlement_status) ||
        spec.required_artifacts.some(name => !own(witness, name))) fail('success_evidence');
  }
  const result = Object.fromEntries(required.map(key => [key, input[key]]));
  result.usage_tokens = Object.freeze(usage);
  result.artifact_witness = witness;
  if (own(input, 'error_details')) {
    closed(input.error_details, [], ['code', 'signal', 'classification'], 'error_details');
    const details = {};
    for (const key of Reflect.ownKeys(input.error_details)) {
      const value = Object.getOwnPropertyDescriptor(input.error_details, key).value;
      if (!(text(value) || key === 'code' && Number.isSafeInteger(value))) fail(`error_details.${key}`);
      details[key] = value;
    }
    result.error_details = Object.freeze(details);
  }
  return Object.freeze(result);
}

// Structural assertions only; this function performs no artifact I/O or hashing.
export function validateArtifactWitness(input) {
  object(input, 'artifact_witness');
  const witness = Object.create(null);
  for (const name of Reflect.ownKeys(input)) {
    if (!artifactPath(name)) fail('artifact_witness');
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!own(descriptor, 'value')) fail('artifact_witness');
    const value = descriptor.value;
    closed(value, ['byte_count', 'sha256'], [], 'artifact_witness.entry');
    if (!Number.isSafeInteger(value.byte_count) || value.byte_count <= 0 ||
        typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) fail('artifact_witness.entry');
    witness[name] = Object.freeze({byte_count: value.byte_count, sha256: value.sha256});
  }
  return Object.freeze(witness);
}
