// Offline saved-data report only. This module never launches work.
import {types} from 'node:util';
import {
  assessCourierHandoff,
  prepareCourierHandoff
} from './courier-handoff.mjs';
import {
  parseReceiptJson,
  REPORT_MAX_BYTES,
  snapshotReceiptData
} from './offline-run-summary.mjs';

const INPUT_SCHEMA = 'SQUIRE3_COURIER_HANDOFF_REPORT_V1';
const OUTPUT_SCHEMA = 'SQUIRE3_COURIER_HANDOFF_REPORT_OUTPUT_V1';
const MAX_TERMINAL_BYTES = 8192;
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export class CourierHandoffReportError extends Error {
  constructor() {
    super('INVALID_INPUT');
    this.name = 'CourierHandoffReportError';
    this.code = 'INVALID_INPUT';
  }
}

const invalid = () => { throw new CourierHandoffReportError(); };

function captureInput(value) {
  try {
    if (types.isProxy(value)) invalid();
    if (types.isUint8Array(value)) return parseReceiptJson(value);
    return snapshotReceiptData(value);
  } catch {
    invalid();
  }
}

function closed(value, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key))) invalid();
}

function token(value) {
  return typeof value === 'string' && /^[A-Z0-9_]+$/.test(value)
    ? value : 'UNKNOWN';
}

function identity(value, allowed) {
  return allowed.includes(value) ? value : 'UNKNOWN';
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : 'UNKNOWN';
}

function digest(value) {
  return isDigest(value) ? value : 'UNKNOWN';
}

function nullable(value) {
  return value === null || value === undefined ? 'UNKNOWN' : String(value);
}

function terminalText(assessment) {
  const raw = assessment.raw_capture;
  const final = assessment.derived_final;
  const coverage = assessment.read_coverage;
  const environment = assessment.environment_removals;
  const external = assessment.external_stages;
  const lines = [
    'Squire courier handoff report: METADATA_ONLY',
    'Supplied input claims are not independently verified.',
    `Request digest: ${digest(assessment.request_digest)}`,
    `Reference digest: ${digest(assessment.reference_digest)}`,
    `Requested identity: model=${identity(assessment.requested_identity.model, ['gpt-6-luna', 'gpt-6.1-sol', 'UNKNOWN'])}; effort=${identity(assessment.requested_identity.effort, ['low', 'medium', 'high', 'xhigh', 'UNKNOWN'])}`,
    `Reported identity: model=${identity(assessment.reported_identity.model, ['gpt-6-luna', 'gpt-6.1-sol', 'UNKNOWN'])}; effort=${identity(assessment.reported_identity.effort, ['low', 'medium', 'high', 'xhigh', 'UNKNOWN'])}`,
    `Dispatch: ${token(assessment.dispatch_state)}; process start: ${token(assessment.process_start_state)}`,
    `Terminal: ${token(assessment.terminal.state)}; exit code: ${count(assessment.terminal.exit_code)}; signal: ${token(assessment.terminal.signal_state)}`,
    `Raw stdout: state=${token(raw.stdout.state)}; sha256=${digest(raw.stdout.sha256)}; bytes=${count(raw.stdout.byte_count)}`,
    `Raw stderr: state=${token(raw.stderr.state)}; sha256=${digest(raw.stderr.sha256)}; bytes=${count(raw.stderr.byte_count)}`,
    `Derived final: state=${token(final.state)}; sha256=${digest(final.sha256)}; bytes=${count(final.byte_count)}; origin=${token(final.origin_stream)}; origin sha256=${digest(final.origin_sha256)}; transform=${token(final.transform_kind)}`,
    `Capture state: ${token(assessment.capture_state)}; candidate presence: ${token(assessment.candidate_presence)}`,
    `Required reads: ${count(coverage.required_count)}; supplied reads: ${count(coverage.supplied_count)}`,
    `Coverage claims: WHOLE_BYTE_EXACT=${count(coverage.claim_counts.WHOLE_BYTE_EXACT)}; BOUNDED_EXCERPT=${count(coverage.claim_counts.BOUNDED_EXCERPT)}; COMPLETE_JSON_VALUE_EQUALITY=${count(coverage.claim_counts.COMPLETE_JSON_VALUE_EQUALITY)}; MISSING=${count(coverage.claim_counts.MISSING)}; UNKNOWN=${count(coverage.claim_counts.UNKNOWN)}; NOT_REPORTED=${count(coverage.claim_counts.NOT_REPORTED)}`,
    'Coverage labels are supplied claims; referenced bytes are not verified by this report.',
    `Recovery: reference=${token(assessment.recovery.reference_state)}; context=${token(assessment.recovery.context_state)}`,
    `Review: mode=${token(assessment.review.mode)}; prior outcome=${token(assessment.review.prior_outcome)}; candidate relation=${token(assessment.review.candidate_relation)}`,
    `Outer environment removals: state=${token(environment.outer_state)}; count=${count(environment.outer_count)}`,
    `Wrapper environment removals: state=${token(environment.wrapper_state)}; count=${count(environment.wrapper_count)}`,
    `Permission denial: ${token(assessment.permission_denial)}`,
    `Quota evidence: ${token(assessment.quota_evidence)}`,
    `Transport: ${token(assessment.transport_state)}`,
    `Evidence: ${token(assessment.evidence_state)}`,
    `Tool: ${token(assessment.tool_state)}`,
    `Estimate: ${token(assessment.estimate_state)}`,
    `Settlement: ${token(assessment.settlement_state)}`,
    `Runtime admitted: ${assessment.runtime_admitted === false ? 'false' : 'UNKNOWN'}; task correctness: ${token(assessment.task_correctness)}`,
    `Execution permission: ${token(assessment.execution_permission)}; replay: ${token(assessment.replay)}`,
    `External stages: review acceptance=${token(external.review_acceptance)}; delivery=${token(external.delivery)}; merge=${token(external.merge)}; installation=${token(external.installation)}; use=${token(external.use)}`,
    'No semantic acceptance, authorization, delivery, merge, installation or use is established.'
  ];
  const result = `${lines.join('\n')}\n`;
  if (/[^\x20-\x7e\n]/.test(result) ||
      new TextEncoder().encode(result).length > MAX_TERMINAL_BYTES) invalid();
  return result;
}

export function buildCourierHandoffReport(value) {
  try {
    const input = captureInput(value);
    closed(input, ['schema', 'request', 'observations']);
    if (input.schema !== INPUT_SCHEMA) invalid();
    const prepared = prepareCourierHandoff(input.request);
    const assessment = assessCourierHandoff(prepared, input.observations);
    return Object.freeze({
      schema: OUTPUT_SCHEMA,
      assessment,
      terminal_text: terminalText(assessment)
    });
  } catch {
    throw new CourierHandoffReportError();
  }
}
