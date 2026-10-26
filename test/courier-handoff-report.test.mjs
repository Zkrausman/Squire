import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {
  buildCourierHandoffReport,
  CourierHandoffReportError
} from '../src/courier-handoff-report.mjs';
import {
  assessCourierHandoff,
  COURIER_HANDOFF_LIMITS,
  prepareCourierHandoff
} from '../src/courier-handoff.mjs';
import {
  formatSummaryTerminal,
  parseReceiptJson,
  projectRunSummary,
  REPORT_MAX_BYTES
} from '../src/offline-run-summary.mjs';
import {
  formatSingleJsSummaryTerminal,
  projectSingleJsRunSummary
} from '../src/single-js-summary.mjs';
import {
  formatProjectSummaryTerminal,
  projectProjectRunSummary
} from '../src/project-summary.mjs';
import {runOfflineReportCli, readReceiptBytes} from '../bin/squire-report.mjs';

const INPUT_SCHEMA = 'SQUIRE3_COURIER_HANDOFF_REPORT_V1';
const REQUEST_SCHEMA = 'squire3.courier_handoff_request.v1';
const OBSERVATIONS_SCHEMA = 'squire3.courier_handoff_observations.v1';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const hash = value => createHash('sha256').update(value).digest('hex');
const encode = value => new TextEncoder().encode(
  typeof value === 'string' ? value : JSON.stringify(value)
);
const ref = (reference_id, body = reference_id) => ({
  reference_id,
  sha256: hash(body),
  byte_count: Buffer.byteLength(body)
});
const sizedRef = (reference_id, byte_count, sha256 = 'a'.repeat(64)) => ({
  reference_id,
  sha256,
  byte_count
});
const groups = values => {
  const result = [];
  for (let i = 0; i < values.length; i += 64) result.push(values.slice(i, i + 64));
  return result;
};

function request(readRefs = [ref('read-default')]) {
  return {
    schema_version: REQUEST_SCHEMA,
    executable: '/synthetic/bin/courier',
    cwd: '/synthetic/work',
    outer_argv: ['/synthetic/bin/courier', '--mode', 'handoff'],
    inner_node_argv: ['--synthetic-inner-only'],
    requested_identity: {model: 'gpt-6-luna', effort: 'xhigh'},
    bindings: {
      wrapper: ref('wrapper'),
      instruction: ref('instruction'),
      manifest: ref('manifest')
    },
    required_read_groups: groups(readRefs),
    recovery_reference: null
  };
}

function observations(prepared, overrides = {}) {
  return {
    schema_version: OBSERVATIONS_SCHEMA,
    request_digest: prepared.safe_summary.request_digest,
    reference_digest: prepared.safe_summary.reference_digest,
    dispatch_state: 'UNKNOWN',
    process_start_state: 'UNKNOWN',
    terminal: {state: 'UNKNOWN', exit_code: null, signal_state: 'UNKNOWN'},
    reported_identity: {model: 'UNKNOWN', effort: 'UNKNOWN'},
    raw_capture: {
      stdout: {state: 'UNKNOWN', sha256: null, byte_count: null},
      stderr: {state: 'UNKNOWN', sha256: null, byte_count: null}
    },
    final_artifact: {
      state: 'UNKNOWN',
      sha256: null,
      byte_count: null,
      origin_stream: 'NONE',
      origin_sha256: null,
      transform_reference: null,
      transform_kind: 'UNKNOWN'
    },
    read_observation_groups: [],
    recovery: {reference_state: 'ABSENT', context_state: 'NOT_SUPPLIED'},
    review: {
      mode: 'NOT_A_REVIEW',
      original_review_reference: null,
      original_context_reference: null,
      original_candidate_reference: null,
      current_context_reference: null,
      current_candidate_reference: null,
      prior_outcome: 'NOT_APPLICABLE'
    },
    environment_removals: {
      outer_state: 'UNKNOWN',
      outer_count: null,
      wrapper_state: 'UNKNOWN',
      wrapper_count: null
    },
    permission_denial: 'UNKNOWN',
    quota_evidence: 'UNKNOWN',
    transport_state: 'UNKNOWN',
    evidence_state: 'UNKNOWN',
    tool_state: 'UNKNOWN',
    estimate_state: 'UNKNOWN',
    settlement_state: 'UNKNOWN',
    ...overrides
  };
}

function savedInput(readRefs = [ref('read-default')], observationOverrides = {}) {
  const requestData = request(readRefs);
  const prepared = prepareCourierHandoff(requestData);
  return {
    schema: INPUT_SCHEMA,
    request: requestData,
    observations: observations(prepared, observationOverrides)
  };
}

function capturedPositiveInput() {
  const input = savedInput();
  const prepared = prepareCourierHandoff(input.request);
  const required = prepared.safe_summary.required_read_groups[0][0];
  const raw = hash('raw stdout');
  input.observations = observations(prepared, {
    dispatch_state: 'ADMITTED',
    process_start_state: 'OBSERVED',
    terminal: {state: 'EXIT_CODE', exit_code: 0, signal_state: 'NONE'},
    reported_identity: {model: 'UNKNOWN', effort: 'UNKNOWN'},
    raw_capture: {
      stdout: {state: 'COMPLETE', sha256: raw, byte_count: 10},
      stderr: {state: 'EMPTY', sha256: EMPTY_SHA256, byte_count: 0}
    },
    final_artifact: {
      state: 'COMPLETE',
      sha256: hash('candidate'),
      byte_count: 9,
      origin_stream: 'STDOUT',
      origin_sha256: raw,
      transform_reference: ref('transform'),
      transform_kind: 'FINAL_TEXT_V1'
    },
    read_observation_groups: [[{
      reference_digest: required.reference_digest,
      sha256: required.sha256,
      byte_count: required.byte_count,
      coverage: 'WHOLE_BYTE_EXACT'
    }]],
    environment_removals: {
      outer_state: 'OBSERVED', outer_count: 0,
      wrapper_state: 'NOT_OBSERVED', wrapper_count: null
    },
    permission_denial: 'NOT_OBSERVED',
    quota_evidence: 'OBSERVED',
    transport_state: 'CERTAIN',
    evidence_state: 'COMPLETE',
    tool_state: 'SUCCESS',
    estimate_state: 'KNOWN',
    settlement_state: 'DIRECT_CHILD_ONLY'
  });
  return input;
}

const isInvalidInput = error =>
  error instanceof CourierHandoffReportError &&
  error.name === 'CourierHandoffReportError' &&
  error.code === 'INVALID_INPUT' &&
  error.message === 'INVALID_INPUT' &&
  error.cause === undefined;

async function cliBytes(bytes, overrides = {}) {
  let out = '';
  let err = '';
  const ports = {
    readFile: async () => bytes,
    stat: async () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: bytes.length
    }),
    stdout: {write: value => { out += value; }},
    stderr: {write: value => { err += value; }},
    ...overrides
  };
  const code = await runOfflineReportCli(['/PRIVATE_SYNTHETIC/receipt.json'], ports);
  return {code, out, err};
}

async function cliValue(value, overrides) {
  return cliBytes(encode(value), overrides);
}

test('build returns the unchanged frozen safe assessment and bounded ASCII report', () => {
  const input = savedInput();
  const prepared = prepareCourierHandoff(input.request);
  const expected = assessCourierHandoff(prepared, input.observations);
  const report = buildCourierHandoffReport(input);

  assert.equal(report.schema, 'SQUIRE3_COURIER_HANDOFF_REPORT_OUTPUT_V1');
  assert.deepEqual(report.assessment, expected);
  assert.equal(report.assessment.schema_version, 'squire3.courier_handoff_assessment.v1');
  assert.equal(Object.isFrozen(report), true);
  assert.equal(Object.isFrozen(report.assessment), true);
  assert.equal(report.terminal_text.startsWith('Squire courier handoff report: METADATA_ONLY\n'), true);
  assert.match(report.terminal_text, /Supplied input claims are not independently verified\./);
  assert.match(report.terminal_text, /exit code: UNKNOWN/);
  assert.match(report.terminal_text, /task correctness: NOT_EVALUATED/);
  assert.match(report.terminal_text, /Runtime admitted: false/);
  assert.match(report.terminal_text, /replay: NOT_SUPPORTED/);
  assert.equal(/[^\x20-\x7e\n]/.test(report.terminal_text), false);
  assert.equal(report.terminal_text.endsWith('\n'), true);
  assert.ok(Buffer.byteLength(report.terminal_text) <= 8192);
});

test('complete capture, exit zero and exact reads remain metadata rather than semantic success', async () => {
  const input = capturedPositiveInput();
  const report = buildCourierHandoffReport(input);
  assert.match(report.terminal_text, /Terminal: EXIT_CODE; exit code: 0; signal: NONE/);
  assert.match(report.terminal_text, /Raw stdout: state=COMPLETE;/);
  assert.match(report.terminal_text, /Raw stderr: state=EMPTY;/);
  assert.match(report.terminal_text, /Derived final: state=COMPLETE;/);
  assert.match(report.terminal_text, /Capture state: COMPLETE; candidate presence: NONEMPTY_CAPTURED/);
  assert.match(report.terminal_text, /WHOLE_BYTE_EXACT=1/);
  assert.match(report.terminal_text, /Permission denial: NOT_OBSERVED/);
  assert.match(report.terminal_text, /Quota evidence: OBSERVED/);
  assert.match(report.terminal_text, /Settlement: DIRECT_CHILD_ONLY/);
  assert.match(report.terminal_text, /No semantic acceptance/);
  assert.equal(/\bPASS\b/.test(report.terminal_text), false);
  assert.equal(report.assessment.runtime_admitted, false);
  assert.equal(report.assessment.task_correctness, 'NOT_EVALUATED');
  assert.equal(report.assessment.execution_permission, 'EXTERNAL_NOT_ASSESSED');

  const cli = await cliValue(input);
  assert.equal(cli.code, 1);
  assert.equal(cli.out, report.terminal_text);
  assert.equal(cli.err, '');
});

test('captured provenance and IDENTITY digest/count correlations reject through the report API', () => {
  const positive = capturedPositiveInput();
  assert.doesNotThrow(() => buildCourierHandoffReport(positive));

  const rawDigest = positive.observations.raw_capture.stdout.sha256;
  const rawCount = positive.observations.raw_capture.stdout.byte_count;
  const validIdentity = {
    ...positive,
    observations: {
      ...positive.observations,
      final_artifact: {
        ...positive.observations.final_artifact,
        sha256: rawDigest,
        byte_count: rawCount,
        transform_kind: 'IDENTITY'
      }
    }
  };
  assert.equal(
    validIdentity.observations.final_artifact.sha256,
    validIdentity.observations.raw_capture.stdout.sha256
  );
  assert.equal(
    validIdentity.observations.final_artifact.byte_count,
    validIdentity.observations.raw_capture.stdout.byte_count
  );
  assert.doesNotThrow(() => buildCourierHandoffReport(validIdentity));

  const wrongOriginDigest = capturedPositiveInput();
  wrongOriginDigest.observations.final_artifact.origin_sha256 = hash('wrong raw origin');
  assert.throws(() => buildCourierHandoffReport(wrongOriginDigest), isInvalidInput);

  const wrongOriginStream = capturedPositiveInput();
  wrongOriginStream.observations.final_artifact.origin_stream = 'STDERR';
  assert.throws(() => buildCourierHandoffReport(wrongOriginStream), isInvalidInput);

  const wrongIdentityDigest = {
    ...validIdentity,
    observations: {
      ...validIdentity.observations,
      final_artifact: {
        ...validIdentity.observations.final_artifact,
        sha256: hash('wrong identity digest')
      }
    }
  };
  assert.throws(() => buildCourierHandoffReport(wrongIdentityDigest), isInvalidInput);

  const wrongIdentityCount = {
    ...validIdentity,
    observations: {
      ...validIdentity.observations,
      final_artifact: {
        ...validIdentity.observations.final_artifact,
        byte_count: rawCount - 1
      }
    }
  };
  assert.throws(() => buildCourierHandoffReport(wrongIdentityCount), isInvalidInput);
});

test('private command, paths, reference IDs and raw labels never enter the public report', () => {
  const input = savedInput();
  input.request.executable = '/PRIVATE_PATH_SENTINEL/courier';
  input.request.cwd = '/PRIVATE_CWD_SENTINEL/work';
  input.request.outer_argv = [
    input.request.executable,
    'PRIVATE_ARG_SENTINEL',
    "quote' `$HOME` ;\n"
  ];
  input.request.bindings.wrapper.reference_id = 'PRIVATE_REFERENCE_SENTINEL';
  input.request.required_read_groups[0][0].reference_id = 'PRIVATE_READ_SENTINEL';
  const prepared = prepareCourierHandoff(input.request);
  input.observations = observations(prepared, {
    reported_identity: {model: 'UNKNOWN', effort: 'UNKNOWN'}
  });

  const report = buildCourierHandoffReport(input);
  const serializedReport = JSON.stringify(report);
  for (const sentinel of [
    'PRIVATE_PATH_SENTINEL', 'PRIVATE_CWD_SENTINEL', 'PRIVATE_ARG_SENTINEL',
    'PRIVATE_REFERENCE_SENTINEL', 'PRIVATE_READ_SENTINEL', '$HOME'
  ]) {
    assert.equal(report.terminal_text.includes(sentinel), false);
    assert.equal(serializedReport.includes(sentinel), false);
  }
});

test('EMPTY, NO_CANDIDATE, TRUNCATED, MISSING and UNKNOWN stay distinct', () => {
  const cases = [
    {
      state: 'EMPTY',
      expected: 'EMPTY_NOT_USABLE',
      raw: {state: 'EMPTY', sha256: EMPTY_SHA256, byte_count: 0},
      final: {
        state: 'EMPTY', sha256: EMPTY_SHA256, byte_count: 0,
        origin_stream: 'STDOUT', origin_sha256: EMPTY_SHA256,
        transform_reference: ref('transform-empty'), transform_kind: 'FINAL_TEXT_V1'
      }
    },
    {
      state: 'NO_CANDIDATE',
      expected: 'NO_CANDIDATE',
      raw: {state: 'EMPTY', sha256: EMPTY_SHA256, byte_count: 0},
      final: {
        state: 'NO_CANDIDATE', sha256: null, byte_count: null,
        origin_stream: 'STDOUT', origin_sha256: EMPTY_SHA256,
        transform_reference: ref('transform-none'), transform_kind: 'FINAL_TEXT_V1'
      }
    },
    {
      state: 'TRUNCATED',
      expected: 'TRUNCATED',
      raw: {state: 'TRUNCATED', sha256: hash('partial'), byte_count: 7},
      final: {
        state: 'TRUNCATED', sha256: hash('final partial'), byte_count: 13,
        origin_stream: 'STDOUT', origin_sha256: hash('partial'),
        transform_reference: ref('transform-truncated'), transform_kind: 'FINAL_TEXT_V1'
      }
    },
    {
      state: 'MISSING',
      expected: 'MISSING',
      raw: {state: 'UNKNOWN', sha256: null, byte_count: null},
      final: {
        state: 'MISSING', sha256: null, byte_count: null,
        origin_stream: 'NONE', origin_sha256: null,
        transform_reference: null, transform_kind: 'NONE'
      }
    },
    {
      state: 'UNKNOWN',
      expected: 'UNKNOWN',
      raw: {state: 'UNKNOWN', sha256: null, byte_count: null},
      final: {
        state: 'UNKNOWN', sha256: null, byte_count: null,
        origin_stream: 'NONE', origin_sha256: null,
        transform_reference: null, transform_kind: 'UNKNOWN'
      }
    }
  ];

  for (const item of cases) {
    const input = savedInput();
    input.observations = observations(prepareCourierHandoff(input.request), {
      raw_capture: {
        stdout: item.raw,
        stderr: {state: 'EMPTY', sha256: EMPTY_SHA256, byte_count: 0}
      },
      final_artifact: item.final
    });
    const report = buildCourierHandoffReport(input);
    assert.equal(report.assessment.derived_final.state, item.state);
    assert.equal(report.assessment.candidate_presence, item.expected);
    assert.match(report.terminal_text, new RegExp(`candidate presence: ${item.expected}`));
  }
});

test('coverage report retains every claim kind, unreported reads and large grouped inputs', () => {
  const reads = Array.from({length: 136}, (_, index) =>
    ref(`read-${String(index).padStart(3, '0')}`, `body-${index}`)
  );
  const input = savedInput(reads);
  const prepared = prepareCourierHandoff(input.request);
  const facts = prepared.safe_summary.required_read_groups.flat().flatMap((required, index) => {
    const kind = [
      'WHOLE_BYTE_EXACT', 'BOUNDED_EXCERPT', 'COMPLETE_JSON_VALUE_EQUALITY',
      'MISSING', 'UNKNOWN', 'NOT_REPORTED'
    ][index % 6];
    if (kind === 'NOT_REPORTED') return [];
    if (kind === 'MISSING' || kind === 'UNKNOWN') {
      return [{
        reference_digest: required.reference_digest,
        sha256: null,
        byte_count: null,
        coverage: kind
      }];
    }
    if (kind === 'WHOLE_BYTE_EXACT') {
      return [{
        reference_digest: required.reference_digest,
        sha256: required.sha256,
        byte_count: required.byte_count,
        coverage: kind
      }];
    }
    return [{
      reference_digest: required.reference_digest,
      sha256: hash(`coverage-${index}`),
      byte_count: kind === 'BOUNDED_EXCERPT' ? 0 : index + 1,
      coverage: kind
    }];
  });
  input.observations = observations(prepared, {read_observation_groups: groups(facts)});

  const report = buildCourierHandoffReport(input);
  const coverage = report.assessment.read_coverage;
  assert.equal(coverage.required_count, 136);
  assert.equal(coverage.supplied_count, facts.length);
  assert.deepEqual(coverage.groups.map(group => group.length), [64, 64, 8]);
  assert.equal(coverage.claim_counts.WHOLE_BYTE_EXACT, 23);
  assert.equal(coverage.claim_counts.BOUNDED_EXCERPT, 23);
  assert.equal(coverage.claim_counts.COMPLETE_JSON_VALUE_EQUALITY, 23);
  assert.equal(coverage.claim_counts.MISSING, 23);
  assert.equal(coverage.claim_counts.UNKNOWN, 22);
  assert.equal(coverage.claim_counts.NOT_REPORTED, 22);
  assert.match(report.terminal_text, /COMPLETE_JSON_VALUE_EQUALITY=23/);
  assert.match(report.terminal_text, /NOT_REPORTED=22/);
  assert.match(report.terminal_text, /referenced bytes are not verified/);
  assert.ok(Buffer.byteLength(report.terminal_text) <= 8192);
});

test('maximum legitimate terminal metadata projects safely within both byte limits', () => {
  const maxReadCount = COURIER_HANDOFF_LIMITS.max_read_items;
  const maxReadBytes = COURIER_HANDOFF_LIMITS.max_read_bytes / maxReadCount;
  const maxBindingBytes = COURIER_HANDOFF_LIMITS.max_binding_bytes / 4;
  const maxReferenceBytes = COURIER_HANDOFF_LIMITS.max_reference_bytes;
  const maxStreamBytes = COURIER_HANDOFF_LIMITS.max_stdout_bytes;
  const reads = Array.from({length: maxReadCount}, (_, index) =>
    sizedRef(`read-${String(index).padStart(4, '0')}`, maxReadBytes, 'd'.repeat(64))
  );
  const requestData = request(reads);
  requestData.requested_identity = {model: 'gpt-6.1-sol', effort: 'xhigh'};
  requestData.bindings = {
    wrapper: sizedRef('max-wrapper', maxBindingBytes),
    instruction: sizedRef('max-instruction', maxBindingBytes),
    manifest: sizedRef('max-manifest', maxBindingBytes)
  };
  requestData.recovery_reference = sizedRef('max-recovery', maxBindingBytes);
  assert.equal(
    Object.values(requestData.bindings).reduce((sum, item) => sum + item.byte_count, 0) +
      requestData.recovery_reference.byte_count,
    COURIER_HANDOFF_LIMITS.max_binding_bytes
  );
  assert.equal(reads.reduce((sum, item) => sum + item.byte_count, 0), COURIER_HANDOFF_LIMITS.max_read_bytes);

  const prepared = prepareCourierHandoff(requestData);
  const rawStdoutDigest = 'a'.repeat(64);
  const input = {
    schema: INPUT_SCHEMA,
    request: requestData,
    observations: observations(prepared, {
      dispatch_state: 'ADMITTED',
      process_start_state: 'OBSERVED',
      terminal: {state: 'EXIT_CODE', exit_code: 255, signal_state: 'NONE'},
      reported_identity: {model: 'gpt-6.1-sol', effort: 'xhigh'},
      raw_capture: {
        stdout: {state: 'COMPLETE', sha256: rawStdoutDigest, byte_count: maxStreamBytes},
        stderr: {state: 'COMPLETE', sha256: 'b'.repeat(64), byte_count: maxStreamBytes}
      },
      final_artifact: {
        state: 'COMPLETE',
        sha256: 'c'.repeat(64),
        byte_count: maxReferenceBytes,
        origin_stream: 'STDOUT',
        origin_sha256: rawStdoutDigest,
        transform_reference: sizedRef('max-transform', maxReferenceBytes),
        transform_kind: 'NORMALIZED_FINAL_V1'
      },
      recovery: {reference_state: 'PRESENT', context_state: 'HISTORICAL_PANE_OR_PID_ONLY'},
      environment_removals: {
        outer_state: 'OBSERVED',
        outer_count: COURIER_HANDOFF_LIMITS.max_environment_removals,
        wrapper_state: 'OBSERVED',
        wrapper_count: COURIER_HANDOFF_LIMITS.max_environment_removals
      },
      permission_denial: 'OBSERVED',
      quota_evidence: 'OBSERVED',
      transport_state: 'UNCERTAIN',
      evidence_state: 'INCOMPLETE',
      tool_state: 'CAPABILITY_ERROR',
      estimate_state: 'UNKNOWN',
      settlement_state: 'OBSERVED_FULL'
    })
  };
  const encoded = encode(input);
  assert.ok(encoded.length <= REPORT_MAX_BYTES);
  const report = buildCourierHandoffReport(encoded);
  const assessment = report.assessment;

  assert.equal(assessment.requested_identity.model, 'gpt-6.1-sol');
  assert.equal(assessment.terminal.exit_code, 255);
  assert.equal(assessment.raw_capture.stdout.byte_count, maxStreamBytes);
  assert.equal(assessment.raw_capture.stderr.byte_count, maxStreamBytes);
  assert.equal(assessment.derived_final.byte_count, maxReferenceBytes);
  assert.equal(assessment.read_coverage.required_count, maxReadCount);
  assert.equal(assessment.read_coverage.supplied_count, 0);
  assert.equal(assessment.read_coverage.claim_counts.NOT_REPORTED, maxReadCount);
  assert.deepEqual(
    assessment.read_coverage.groups.map(group => group.length),
    Array(COURIER_HANDOFF_LIMITS.max_groups).fill(COURIER_HANDOFF_LIMITS.max_items_per_group)
  );
  assert.equal(
    assessment.environment_removals.outer_count,
    COURIER_HANDOFF_LIMITS.max_environment_removals
  );
  assert.equal(
    assessment.environment_removals.wrapper_count,
    COURIER_HANDOFF_LIMITS.max_environment_removals
  );
  assert.match(assessment.request_digest, /^[a-f0-9]{64}$/);
  assert.match(assessment.reference_digest, /^[a-f0-9]{64}$/);
  assert.equal(assessment.runtime_admitted, false);
  assert.equal(assessment.task_correctness, 'NOT_EVALUATED');
  assert.equal(/[^\x20-\x7e\n]/.test(report.terminal_text), false);
  assert.ok(Buffer.byteLength(report.terminal_text) <= 8192);
});

test('identical duplicate read identities are idempotent and conflicts reject', () => {
  const read = ref('duplicate-read');
  const input = savedInput([read, read]);
  const prepared = prepareCourierHandoff(input.request);
  const required = prepared.safe_summary.required_read_groups[0][0];
  const fact = {
    reference_digest: required.reference_digest,
    sha256: required.sha256,
    byte_count: required.byte_count,
    coverage: 'WHOLE_BYTE_EXACT'
  };
  input.observations = observations(prepared, {
    read_observation_groups: [[fact, fact]]
  });
  assert.equal(buildCourierHandoffReport(input).assessment.read_coverage.supplied_count, 1);

  input.observations = observations(prepared, {
    read_observation_groups: [[fact, {...fact, coverage: 'BOUNDED_EXCERPT'}]]
  });
  assert.throws(() => buildCourierHandoffReport(input), isInvalidInput);

  const conflict = savedInput([read]);
  conflict.request.required_read_groups = groups([
    read,
    {...read, sha256: 'b'.repeat(64)}
  ]);
  assert.throws(() => buildCourierHandoffReport(conflict), isInvalidInput);
});

test('fresh and continuing reviews report context and candidate relation without IDs', () => {
  const currentContext = ref('PRIVATE_CONTEXT_ID');
  const currentCandidate = ref('PRIVATE_CANDIDATE_ID');
  const fresh = savedInput(undefined, {
    review: {
      mode: 'FRESH_REVIEW',
      original_review_reference: null,
      original_context_reference: null,
      original_candidate_reference: null,
      current_context_reference: currentContext,
      current_candidate_reference: currentCandidate,
      prior_outcome: 'NOT_APPLICABLE'
    }
  });
  const freshReport = buildCourierHandoffReport(fresh);
  assert.match(freshReport.terminal_text, /Review: mode=FRESH_REVIEW; prior outcome=NOT_APPLICABLE; candidate relation=NOT_APPLICABLE/);
  assert.equal(freshReport.terminal_text.includes('PRIVATE_CONTEXT_ID'), false);
  assert.equal(freshReport.terminal_text.includes('PRIVATE_CANDIDATE_ID'), false);

  const continuationReview = {
    mode: 'CONTINUATION',
    original_review_reference: ref('PRIVATE_REVIEW_ID'),
    original_context_reference: currentContext,
    original_candidate_reference: currentCandidate,
    current_context_reference: currentContext,
    current_candidate_reference: currentCandidate,
    prior_outcome: 'UNKNOWN'
  };
  const same = savedInput(undefined, {review: continuationReview});
  const sameReport = buildCourierHandoffReport(same);
  assert.match(sameReport.terminal_text, /mode=CONTINUATION; prior outcome=UNKNOWN; candidate relation=SAME/);
  assert.equal(sameReport.terminal_text.includes('PRIVATE_REVIEW_ID'), false);

  const changed = savedInput(undefined, {
    review: {
      ...continuationReview,
      current_candidate_reference: ref('PRIVATE_REVISED_CANDIDATE')
    }
  });
  assert.match(buildCourierHandoffReport(changed).terminal_text, /candidate relation=CHANGED/);
  const wrongContext = savedInput(undefined, {
    review: {
      ...continuationReview,
      current_context_reference: ref('different-context')
    }
  });
  assert.throws(() => buildCourierHandoffReport(wrongContext), isInvalidInput);
});

test('denial, quota, uncertainty, tool and settlement states remain separate', () => {
  const input = savedInput(undefined, {
    permission_denial: 'UNKNOWN',
    quota_evidence: 'NOT_OBSERVED',
    transport_state: 'UNCERTAIN',
    evidence_state: 'INCOMPLETE',
    tool_state: 'CAPABILITY_ERROR',
    estimate_state: 'UNKNOWN',
    settlement_state: 'INCOMPLETE'
  });
  const report = buildCourierHandoffReport(input);
  assert.match(report.terminal_text, /Permission denial: UNKNOWN/);
  assert.match(report.terminal_text, /Quota evidence: NOT_OBSERVED/);
  assert.match(report.terminal_text, /Transport: UNCERTAIN/);
  assert.match(report.terminal_text, /Evidence: INCOMPLETE/);
  assert.match(report.terminal_text, /Tool: CAPABILITY_ERROR/);
  assert.match(report.terminal_text, /Estimate: UNKNOWN/);
  assert.match(report.terminal_text, /Settlement: INCOMPLETE/);
  assert.equal(report.assessment.permission_denial, 'UNKNOWN');
  assert.equal(report.assessment.quota_evidence, 'NOT_OBSERVED');

  const blockerStates = ['OBSERVED', 'NOT_OBSERVED', 'UNKNOWN'];
  for (const permissionDenial of blockerStates) {
    for (const quotaEvidence of blockerStates) {
      const independent = buildCourierHandoffReport(savedInput(undefined, {
        permission_denial: permissionDenial,
        quota_evidence: quotaEvidence
      }));
      assert.deepEqual({
        permission_denial: independent.assessment.permission_denial,
        quota_evidence: independent.assessment.quota_evidence,
        execution_permission: independent.assessment.execution_permission,
        runtime_admitted: independent.assessment.runtime_admitted,
        task_correctness: independent.assessment.task_correctness
      }, {
        permission_denial: permissionDenial,
        quota_evidence: quotaEvidence,
        execution_permission: 'EXTERNAL_NOT_ASSESSED',
        runtime_admitted: false,
        task_correctness: 'NOT_EVALUATED'
      });
      assert.match(independent.terminal_text, new RegExp(`Permission denial: ${permissionDenial}`));
      assert.match(independent.terminal_text, new RegExp(`Quota evidence: ${quotaEvidence}`));
      assert.doesNotMatch(independent.terminal_text, /\bPASS\b/);
    }
  }
  for (const settlement of ['DIRECT_CHILD_ONLY', 'OBSERVED_FULL']) {
    const result = buildCourierHandoffReport(savedInput(undefined, {
      settlement_state: settlement
    }));
    assert.match(result.terminal_text, new RegExp(`Settlement: ${settlement}`));
  }
});

test('closed envelope rejects forged wrappers, getters, proxies and unsafe object shapes', () => {
  const base = savedInput();
  const wrongSchema = {...base, schema: 'OTHER_SCHEMA'};
  const missing = {...base};
  delete missing.observations;
  const extra = {...base, assessment: {runtime_admitted: true}};
  const forgedAssessment = {...base, prepared: {private_command: 'PRIVATE_COMMAND'}};
  for (const value of [wrongSchema, missing, extra, forgedAssessment]) {
    assert.throws(() => buildCourierHandoffReport(value), isInvalidInput);
  }

  let called = 0;
  const getter = savedInput();
  Object.defineProperty(getter, 'request', {
    enumerable: true,
    get() { called++; throw new Error('PRIVATE_GETTER_ERROR'); }
  });
  assert.throws(() => buildCourierHandoffReport(getter), isInvalidInput);

  const proxy = new Proxy(savedInput(), {
    get() { called++; throw new Error('PRIVATE_PROXY_ERROR'); },
    ownKeys() { called++; throw new Error('PRIVATE_PROXY_ERROR'); }
  });
  assert.throws(() => buildCourierHandoffReport(proxy), isInvalidInput);

  const toJson = savedInput();
  toJson.toJSON = () => { called++; throw new Error('PRIVATE_TOJSON_ERROR'); };
  assert.throws(() => buildCourierHandoffReport(toJson), isInvalidInput);

  const symbol = savedInput();
  symbol[Symbol('private')] = true;
  assert.throws(() => buildCourierHandoffReport(symbol), isInvalidInput);

  const cycle = savedInput();
  cycle.loop = cycle;
  assert.throws(() => buildCourierHandoffReport(cycle), isInvalidInput);

  const functionValue = savedInput();
  functionValue.request.outer_argv.push(() => { called++; });
  assert.throws(() => buildCourierHandoffReport(functionValue), isInvalidInput);
  assert.equal(called, 0);
});

test('wrong digests, unpaired Unicode, and invalid request or observation fields fail closed', () => {
  const wrongRequestDigest = savedInput();
  wrongRequestDigest.observations.request_digest = 'f'.repeat(64);
  const wrongReferenceDigest = savedInput();
  wrongReferenceDigest.observations.reference_digest = 'e'.repeat(64);
  const unknownField = savedInput();
  unknownField.observations.private_label = 'PRIVATE_LABEL_SENTINEL';
  const badUnicode = savedInput();
  badUnicode.request.bindings.wrapper.reference_id = '\ud800';
  const badArg = savedInput();
  badArg.request.outer_argv[1] = '<COMMAND>';
  for (const input of [
    wrongRequestDigest, wrongReferenceDigest, unknownField, badUnicode, badArg
  ]) {
    assert.throws(() => buildCourierHandoffReport(input), isInvalidInput);
  }
});

test('byte intake rejects duplicate keys, malformed UTF-8/JSON, depth, arrays and strings', () => {
  const input = savedInput();
  const rootPositive = savedInput();
  const rootDuplicateJson = JSON.stringify(rootPositive).replace(
    `"schema":"${INPUT_SCHEMA}"`,
    `"schema":"${INPUT_SCHEMA}","\\u0073chema":"${INPUT_SCHEMA}"`
  );
  assert.ok(rootDuplicateJson.includes(String.raw`\u0073chema`));
  assert.deepEqual(JSON.parse(rootDuplicateJson), rootPositive);
  assert.throws(
    () => parseReceiptJson(encode(rootDuplicateJson)),
    error => error === 'DUPLICATE_KEY_CONFLICT'
  );
  assert.throws(() => buildCourierHandoffReport(encode(rootDuplicateJson)), isInvalidInput);

  const nestedPositive = savedInput();
  const nestedDuplicateJson = JSON.stringify(nestedPositive).replace(
    `"request":{"schema_version":"${REQUEST_SCHEMA}"`,
    `"request":{"schema_version":"${REQUEST_SCHEMA}","schema\\u005fversion":"${REQUEST_SCHEMA}"`
  );
  assert.ok(nestedDuplicateJson.includes(String.raw`schema\u005fversion`));
  assert.deepEqual(JSON.parse(nestedDuplicateJson), nestedPositive);
  assert.throws(
    () => parseReceiptJson(encode(nestedDuplicateJson)),
    error => error === 'DUPLICATE_KEY_CONFLICT'
  );
  assert.throws(() => buildCourierHandoffReport(encode(nestedDuplicateJson)), isInvalidInput);

  const malformed = [
    `{"schema":"${INPUT_SCHEMA}","schema":"${INPUT_SCHEMA}"}`,
    `{"schema":"${INPUT_SCHEMA}","\\u0073chema":"${INPUT_SCHEMA}"}`,
    `{"schema":"${INPUT_SCHEMA}","request":{"schema_version":"${REQUEST_SCHEMA}","schema\\u005fversion":"${REQUEST_SCHEMA}"},"observations":{}}`,
    rootDuplicateJson,
    nestedDuplicateJson,
    '{"schema":"SQUIRE3_COURIER_HANDOFF_REPORT_V1",',
    '{"schema":"SQUIRE3_COURIER_HANDOFF_REPORT_V1","request":{},"observations":{},"extra":' +
      '['.repeat(12) + '0' + ']'.repeat(12) + '}',
    JSON.stringify({...input, extra: Array(65).fill(0)}),
    JSON.stringify({...input, extra: 'x'.repeat(4097)}),
    JSON.stringify({
      ...input,
      request: {
        ...input.request,
        bindings: {
          ...input.request.bindings,
          wrapper: {...input.request.bindings.wrapper, reference_id: '\ud800'}
        }
      }
    })
  ];
  for (const raw of malformed) {
    assert.throws(() => buildCourierHandoffReport(encode(raw)), isInvalidInput);
  }
  assert.throws(() => buildCourierHandoffReport(new Uint8Array([0xff])), isInvalidInput);
  assert.throws(
    () => buildCourierHandoffReport(new Uint8Array(REPORT_MAX_BYTES + 1)),
    isInvalidInput
  );
  assert.equal(
    buildCourierHandoffReport(encode(input)).schema,
    'SQUIRE3_COURIER_HANDOFF_REPORT_OUTPUT_V1'
  );
});

test('exact input-byte ceiling accepts trailing JSON whitespace and the next byte rejects', () => {
  const encoded = encode(savedInput());
  assert.ok(encoded.length < REPORT_MAX_BYTES);
  const exact = new Uint8Array(REPORT_MAX_BYTES);
  exact.set(encoded);
  exact.fill(0x20, encoded.length);
  assert.equal(buildCourierHandoffReport(exact).schema, 'SQUIRE3_COURIER_HANDOFF_REPORT_OUTPUT_V1');
  const paddedOversize = new Uint8Array(REPORT_MAX_BYTES + 1);
  paddedOversize.set(encoded);
  paddedOversize.fill(0x20, encoded.length);
  assert.throws(() => buildCourierHandoffReport(paddedOversize), isInvalidInput);
  assert.throws(
    () => buildCourierHandoffReport(new Uint8Array(REPORT_MAX_BYTES + 1)),
    isInvalidInput
  );
  assert.equal(COURIER_HANDOFF_LIMITS.input_bytes, REPORT_MAX_BYTES);
});

test('injected CLI reports valid handoffs with exit one and rejects malformed handoffs with two', async () => {
  const input = savedInput();
  const expected = buildCourierHandoffReport(input);
  const valid = await cliValue(input);
  assert.equal(valid.code, 1);
  assert.equal(valid.out, expected.terminal_text);
  assert.equal(valid.err, '');
  assert.equal(valid.out.includes('/PRIVATE_SYNTHETIC'), false);

  const malformed = await cliValue({
    schema: INPUT_SCHEMA,
    request: {},
    observations: {},
    private_sentinel: 'PRIVATE_INPUT_SENTINEL'
  });
  assert.equal(malformed.code, 2);
  assert.equal(malformed.out, '');
  assert.equal(malformed.err, 'INVALID_INPUT\n');
  assert.equal(malformed.out.includes('PRIVATE_INPUT_SENTINEL'), false);
  assert.equal(malformed.err.includes('PRIVATE_INPUT_SENTINEL'), false);
  assert.equal(malformed.out.includes('Squire offline receipt summary'), false);
});

test('CLI read, usage and parser failures use fixed diagnostics without raw error or path', async () => {
  const readFailure = await cliValue(savedInput(), {
    readFile: async () => { throw new Error('PRIVATE_READ_ERROR_SENTINEL'); }
  });
  assert.equal(readFailure.code, 2);
  assert.equal(readFailure.err, 'READ_FAILED\n');
  assert.equal(/PRIVATE_READ_ERROR_SENTINEL|PRIVATE_SYNTHETIC/.test(readFailure.out + readFailure.err), false);

  const special = await cliValue(savedInput(), {
    stat: async () => ({isFile: () => false, isSymbolicLink: () => false, size: 1})
  });
  assert.equal(special.code, 2);
  assert.equal(special.err, 'SPECIAL_FILE_REJECTED\n');
  assert.equal(special.out.includes('PRIVATE_SYNTHETIC'), false);

  const oversized = await cliValue(savedInput(), {
    stat: async () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      size: REPORT_MAX_BYTES + 1
    })
  });
  assert.equal(oversized.code, 2);
  assert.equal(oversized.err, 'FILE_TOO_LARGE\n');

  const duplicate = await cliBytes(encode(
    `{"schema":"${INPUT_SCHEMA}","schema":"${INPUT_SCHEMA}"}`
  ));
  assert.equal(duplicate.code, 2);
  assert.equal(duplicate.err, 'DUPLICATE_KEY_CONFLICT\n');

  const escapedDuplicate = await cliBytes(encode(
    `{"schema":"${INPUT_SCHEMA}","\\u0073chema":"${INPUT_SCHEMA}"}`
  ));
  assert.equal(escapedDuplicate.code, 2);
  assert.equal(escapedDuplicate.err, 'DUPLICATE_KEY_CONFLICT\n');

  const rootPositive = savedInput();
  const rootDuplicateJson = JSON.stringify(rootPositive).replace(
    `"schema":"${INPUT_SCHEMA}"`,
    `"schema":"${INPUT_SCHEMA}","\\u0073chema":"${INPUT_SCHEMA}"`
  );
  const nestedPositive = savedInput();
  const nestedDuplicateJson = JSON.stringify(nestedPositive).replace(
    `"request":{"schema_version":"${REQUEST_SCHEMA}"`,
    `"request":{"schema_version":"${REQUEST_SCHEMA}","schema\\u005fversion":"${REQUEST_SCHEMA}"`
  );
  const rootValidExceptDuplicate = await cliBytes(encode(rootDuplicateJson));
  assert.equal(rootValidExceptDuplicate.code, 2);
  assert.equal(rootValidExceptDuplicate.err, 'DUPLICATE_KEY_CONFLICT\n');
  const nestedValidExceptDuplicate = await cliBytes(encode(nestedDuplicateJson));
  assert.equal(nestedValidExceptDuplicate.code, 2);
  assert.equal(nestedValidExceptDuplicate.err, 'DUPLICATE_KEY_CONFLICT\n');

  let out = '';
  let err = '';
  const usageCode = await runOfflineReportCli([], {
    stdout: {write: value => { out += value; }},
    stderr: {write: value => { err += value; }}
  });
  assert.equal(usageCode, 2);
  assert.equal(out, '');
  assert.match(err, /^Usage:/);
});

test('native CLI reader accepts an exact-size handoff and rejects missing, symlink, directory and oversize files', async () => {
  const root = await fs.mkdtemp(new URL('./courier-handoff-report-fixture-', import.meta.url));
  try {
    const path = join(root, 'receipt.json');
    const encoded = encode(savedInput());
    const exact = new Uint8Array(REPORT_MAX_BYTES);
    exact.set(encoded);
    exact.fill(0x20, encoded.length);
    await fs.writeFile(path, exact);
    const exactReport = await runOfflineReportCli([path]);
    assert.equal(exactReport, 1);

    const link = join(root, 'link.json');
    await fs.symlink(path, link);
    for (const rejectedPath of [link, root, join(root, 'missing.json')]) {
      let out = '';
      let err = '';
      const code = await runOfflineReportCli([rejectedPath], {
        stdout: {write: value => { out += value; }},
        stderr: {write: value => { err += value; }}
      });
      assert.equal(code, 2);
      assert.equal(out.includes(rejectedPath), false);
      assert.equal(err.includes(rejectedPath), false);
    }

    const large = join(root, 'large.json');
    await fs.writeFile(large, new Uint8Array(REPORT_MAX_BYTES + 1));
    await assert.rejects(readReceiptBytes(large));
    let out = '';
    let err = '';
    const largeCode = await runOfflineReportCli([large], {
      stdout: {write: value => { out += value; }},
      stderr: {write: value => { err += value; }}
    });
    assert.equal(largeCode, 2);
    assert.equal(out.includes(large), false);
    assert.equal(err.includes(large), false);
  } finally {
    await fs.rm(root, {recursive: true});
  }
});

test('campaign, single-JavaScript and project CLI routes retain their existing formatters and exits', async () => {
  const cases = [
    [{}, projectRunSummary, formatSummaryTerminal],
    [{schema: 'SQUIRE2_SINGLE_JS_RESULT_V1'}, projectSingleJsRunSummary, formatSingleJsSummaryTerminal],
    [{schema: 'SQUIRE2_PROJECT_RESULT_V1'}, projectProjectRunSummary, formatProjectSummaryTerminal]
  ];
  for (const [raw, project, format] of cases) {
    const result = await cliValue(raw);
    const summary = project(raw);
    assert.equal(result.out, format(summary));
    assert.equal(result.code, 2);
    assert.equal(result.err, 'SCHEMA_MISMATCH\n');
    assert.equal(result.out.includes('Squire courier handoff report'), false);
  }
});
