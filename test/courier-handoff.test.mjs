import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  assessCourierHandoff,
  COURIER_HANDOFF_LIMITS,
  prepareCourierHandoff
} from '../src/courier-handoff.mjs';

const REQUEST_SCHEMA = 'squire3.courier_handoff_request.v1';
const OBSERVATIONS_SCHEMA = 'squire3.courier_handoff_observations.v1';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const hash = value => createHash('sha256').update(value).digest('hex');
const ref = (reference_id, body = reference_id) => ({
  reference_id,
  sha256: hash(body),
  byte_count: Buffer.byteLength(body)
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

const isInvalidInput = error =>
  error?.name === 'CourierHandoffError' &&
  error?.code === 'INVALID_INPUT' &&
  error?.message === 'INVALID_INPUT';

test('preparation frames a subshell, quotes literal outer argv and keeps the private command separate', () => {
  const input = request();
  input.outer_argv = [
    input.executable, 'space arg', "it's", '$HOME', '`tick`', 'line\nbreak',
    '(literal); &&', ''
  ];
  input.inner_node_argv = ['--inner-only'];
  const prepared = prepareCourierHandoff(input);
  assert.equal(
    prepared.private_command,
    "(cd '/synthetic/work' && exec '/synthetic/bin/courier' 'space arg' 'it'\"'\"'s' '$HOME' '`tick`' 'line\nbreak' '(literal); &&' '')"
  );
  assert.equal(prepared.private_command.includes('--inner-only'), false);
  assert.equal(JSON.stringify(prepared.safe_summary).includes('/synthetic'), false);
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.safe_summary.bindings.wrapper), true);
});

test('canonical request identity is property-order independent and duplicate reads are idempotent', () => {
  const one = ref('read-one');
  const first = prepareCourierHandoff(request([one, one]));
  const reordered = request([one]);
  const second = prepareCourierHandoff({
    recovery_reference: reordered.recovery_reference,
    required_read_groups: reordered.required_read_groups,
    bindings: reordered.bindings,
    requested_identity: reordered.requested_identity,
    inner_node_argv: reordered.inner_node_argv,
    outer_argv: reordered.outer_argv,
    cwd: reordered.cwd,
    executable: reordered.executable,
    schema_version: reordered.schema_version
  });
  assert.equal(first.safe_summary.request_digest, second.safe_summary.request_digest);
  assert.equal(first.safe_summary.reference_digest, second.safe_summary.reference_digest);
  assert.equal(first.safe_summary.required_read_groups.flat().length, 1);
});

test('malformed, placeholder, incomplete and conflicting request identities fail with a constant error', () => {
  const base = request();
  assert.throws(() => prepareCourierHandoff({
    ...base,
    outer_argv: [base.executable, '<COMMAND>']
  }), isInvalidInput);
  assert.throws(() => prepareCourierHandoff({
    ...base,
    outer_argv: ['/synthetic/other', 'handoff']
  }), isInvalidInput);
  const conflict = request([ref('same'), {...ref('same'), sha256: 'b'.repeat(64)}]);
  assert.throws(() => prepareCourierHandoff(conflict), isInvalidInput);

  const prepared = prepareCourierHandoff(base);
  const wrong = observations(prepared, {request_digest: 'f'.repeat(64)});
  assert.throws(() => assessCourierHandoff(prepared, wrong), isInvalidInput);
});

test('136 required reads use bounded groups and keep three coverage claims distinct', () => {
  const reads = Array.from({length: 136}, (_, index) => {
    const id = `read-${String(index).padStart(3, '0')}`;
    return ref(id, `body-${index}`);
  });
  const prepared = prepareCourierHandoff(request(reads));
  assert.deepEqual(prepared.safe_summary.required_read_groups.map(group => group.length), [64, 64, 8]);
  const facts = prepared.safe_summary.required_read_groups.flat().map((required, index) => {
    const kind = ['WHOLE_BYTE_EXACT', 'BOUNDED_EXCERPT', 'COMPLETE_JSON_VALUE_EQUALITY'][index % 3];
    if (kind === 'WHOLE_BYTE_EXACT') {
      return {
        reference_digest: required.reference_digest,
        sha256: required.sha256,
        byte_count: required.byte_count,
        coverage: kind
      };
    }
    return {
      reference_digest: required.reference_digest,
      sha256: hash(`evidence-${index}`),
      byte_count: kind === 'BOUNDED_EXCERPT' ? 0 : index + 1,
      coverage: kind
    };
  });
  const assessed = assessCourierHandoff(prepared, observations(prepared, {
    read_observation_groups: groups(facts)
  }));
  assert.equal(assessed.read_coverage.required_count, 136);
  assert.equal(assessed.read_coverage.supplied_count, 136);
  assert.deepEqual(assessed.read_coverage.groups.map(group => group.length), [64, 64, 8]);
  assert.equal(assessed.read_coverage.claim_counts.WHOLE_BYTE_EXACT, 46);
  assert.equal(assessed.read_coverage.claim_counts.BOUNDED_EXCERPT, 45);
  assert.equal(assessed.read_coverage.claim_counts.COMPLETE_JSON_VALUE_EQUALITY, 45);
  assert.equal(assessed.read_coverage.claim_counts.NOT_REPORTED, 0);
});

test('read observations reject an equal-count substituted set and conflicting duplicates', () => {
  const prepared = prepareCourierHandoff(request([ref('read-one', 'bytes')]));
  const required = prepared.safe_summary.required_read_groups[0][0];
  const exact = {
    reference_digest: required.reference_digest,
    sha256: required.sha256,
    byte_count: required.byte_count,
    coverage: 'WHOLE_BYTE_EXACT'
  };
  assert.throws(() => assessCourierHandoff(prepared, observations(prepared, {
    read_observation_groups: [[{...exact, reference_digest: 'f'.repeat(64)}]]
  })), isInvalidInput);
  const idempotent = assessCourierHandoff(prepared, observations(prepared, {
    read_observation_groups: [[exact, exact]]
  }));
  assert.equal(idempotent.read_coverage.supplied_count, 1);
  assert.throws(() => assessCourierHandoff(prepared, observations(prepared, {
    read_observation_groups: [[
      exact,
      {...exact, coverage: 'BOUNDED_EXCERPT', sha256: hash('excerpt'), byte_count: 1}
    ]]
  })), isInvalidInput);
});

test('raw and derived capture remain bound, and exit zero cannot promote a candidate', () => {
  const prepared = prepareCourierHandoff(request());
  const raw = hash('raw stdout');
  const transform = ref('transform');
  const complete = assessCourierHandoff(prepared, observations(prepared, {
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
      transform_reference: transform,
      transform_kind: 'FINAL_TEXT_V1'
    },
    environment_removals: {
      outer_state: 'OBSERVED', outer_count: 0,
      wrapper_state: 'UNKNOWN', wrapper_count: null
    }
  }));
  assert.equal(complete.capture_state, 'COMPLETE');
  assert.equal(complete.candidate_presence, 'NONEMPTY_CAPTURED');
  assert.equal(complete.raw_capture.stderr.byte_count, 0);
  assert.equal(complete.environment_removals.outer_count, 0);
  assert.equal(complete.environment_removals.wrapper_count, null);
  assert.equal(complete.runtime_admitted, false);
  assert.equal(complete.task_correctness, 'NOT_EVALUATED');
  assert.equal(complete.external_stages.review_acceptance, 'EXTERNAL_NOT_ASSESSED');

  const emptyRaw = {state: 'EMPTY', sha256: EMPTY_SHA256, byte_count: 0};
  const noCandidate = assessCourierHandoff(prepared, observations(prepared, {
    terminal: {state: 'EXIT_CODE', exit_code: 0, signal_state: 'NONE'},
    raw_capture: {stdout: emptyRaw, stderr: emptyRaw},
    final_artifact: {
      state: 'NO_CANDIDATE',
      sha256: null,
      byte_count: null,
      origin_stream: 'STDOUT',
      origin_sha256: EMPTY_SHA256,
      transform_reference: transform,
      transform_kind: 'FINAL_TEXT_V1'
    }
  }));
  assert.equal(noCandidate.capture_state, 'COMPLETE');
  assert.equal(noCandidate.candidate_presence, 'NO_CANDIDATE');
  assert.equal(Object.hasOwn(noCandidate, 'candidate_usable'), false);

  assert.throws(() => assessCourierHandoff(prepared, observations(prepared, {
    raw_capture: {stdout: {state: 'COMPLETE', sha256: raw, byte_count: 10},
      stderr: {state: 'EMPTY', sha256: EMPTY_SHA256, byte_count: 0}},
    final_artifact: {
      state: 'COMPLETE', sha256: hash('candidate'), byte_count: 9,
      origin_stream: 'STDOUT', origin_sha256: hash('substituted raw'),
      transform_reference: transform, transform_kind: 'FINAL_TEXT_V1'
    }
  })), isInvalidInput);
});

test('IDENTITY preserves raw digest and byte count, including incomplete capture', () => {
  const prepared = prepareCourierHandoff(request());
  const rawDigest = hash('raw bytes');
  const transform = ref('identity-transform');
  const identityFacts = ({
    rawState = 'COMPLETE',
    finalState = rawState,
    finalSha256 = rawDigest,
    finalByteCount = 9
  } = {}) => observations(prepared, {
    raw_capture: {
      stdout: {state: rawState, sha256: rawDigest, byte_count: 9},
      stderr: {state: 'EMPTY', sha256: EMPTY_SHA256, byte_count: 0}
    },
    final_artifact: {
      state: finalState,
      sha256: finalSha256,
      byte_count: finalByteCount,
      origin_stream: 'STDOUT',
      origin_sha256: rawDigest,
      transform_reference: transform,
      transform_kind: 'IDENTITY'
    }
  });

  const exact = assessCourierHandoff(prepared, identityFacts());
  assert.equal(exact.derived_final.sha256, rawDigest);
  assert.equal(exact.derived_final.byte_count, 9);
  assert.throws(() => assessCourierHandoff(prepared, identityFacts({
    finalSha256: hash('different bytes')
  })), isInvalidInput);
  assert.throws(() => assessCourierHandoff(prepared, identityFacts({
    finalByteCount: 8
  })), isInvalidInput);

  const incomplete = assessCourierHandoff(prepared, identityFacts({
    rawState: 'TRUNCATED',
    finalState: 'TRUNCATED'
  }));
  assert.equal(incomplete.capture_state, 'INCOMPLETE');
  assert.equal(incomplete.candidate_presence, 'TRUNCATED');
});

test('zero, null, missing, unknown and partial capture stay distinct', () => {
  const prepared = prepareCourierHandoff(request());
  const result = assessCourierHandoff(prepared, observations(prepared, {
    terminal: {state: 'EXIT_CODE', exit_code: 0, signal_state: 'NONE'},
    raw_capture: {
      stdout: {state: 'EMPTY', sha256: EMPTY_SHA256, byte_count: 0},
      stderr: {state: 'UNKNOWN', sha256: null, byte_count: null}
    },
    final_artifact: {
      state: 'MISSING',
      sha256: null,
      byte_count: null,
      origin_stream: 'NONE',
      origin_sha256: null,
      transform_reference: null,
      transform_kind: 'NONE'
    }
  }));
  assert.equal(result.raw_capture.stdout.byte_count, 0);
  assert.equal(result.raw_capture.stderr.byte_count, null);
  assert.equal(result.capture_state, 'INCOMPLETE');
  assert.equal(result.candidate_presence, 'MISSING');
});

test('recovery and review identities stay distinct; unknown prior outcome cannot enable replay', () => {
  const base = request();
  base.recovery_reference = ref('recovery-invocation-reference');
  const prepared = prepareCourierHandoff(base);
  const currentContext = ref('context-current');
  const currentCandidate = ref('candidate-current');
  const fresh = assessCourierHandoff(prepared, observations(prepared, {
    recovery: {
      reference_state: 'PRESENT',
      context_state: 'HISTORICAL_PANE_OR_PID_ONLY'
    },
    review: {
      mode: 'FRESH_REVIEW',
      original_review_reference: null,
      original_context_reference: null,
      original_candidate_reference: null,
      current_context_reference: currentContext,
      current_candidate_reference: currentCandidate,
      prior_outcome: 'NOT_APPLICABLE'
    }
  }));
  assert.equal(fresh.recovery.reference_digest, prepared.safe_summary.recovery_reference_digest);
  assert.equal(fresh.recovery.live_context_identity, 'NOT_ESTABLISHED');
  assert.equal(fresh.review.candidate_relation, 'NOT_APPLICABLE');
  assert.equal(fresh.review.substantive_independence, 'NOT_ESTABLISHED');

  const continuationReview = {
    mode: 'CONTINUATION',
    original_review_reference: ref('review-receipt'),
    original_context_reference: currentContext,
    original_candidate_reference: currentCandidate,
    current_context_reference: currentContext,
    current_candidate_reference: currentCandidate,
    prior_outcome: 'UNKNOWN'
  };
  const continuation = assessCourierHandoff(prepared, observations(prepared, {
    recovery: {reference_state: 'PRESENT', context_state: 'CURRENT_CONTEXT_REPORTED'},
    review: continuationReview
  }));
  assert.equal(continuation.review.prior_outcome, 'UNKNOWN');
  assert.equal(continuation.review.candidate_relation, 'SAME');
  assert.equal(continuation.replay, 'NOT_SUPPORTED');
  const changedCandidate = assessCourierHandoff(prepared, observations(prepared, {
    recovery: {reference_state: 'PRESENT', context_state: 'CURRENT_CONTEXT_REPORTED'},
    review: {
      ...continuationReview,
      current_candidate_reference: ref('candidate-revised')
    }
  }));
  assert.equal(changedCandidate.review.candidate_relation, 'CHANGED');
  assert.equal(changedCandidate.review.prior_outcome, 'UNKNOWN');
  assert.equal(changedCandidate.replay, 'NOT_SUPPORTED');
  assert.equal(
    changedCandidate.external_stages.review_acceptance,
    'EXTERNAL_NOT_ASSESSED'
  );
  assert.throws(() => assessCourierHandoff(prepared, observations(prepared, {
    recovery: {reference_state: 'PRESENT', context_state: 'CURRENT_CONTEXT_REPORTED'},
    review: {
      ...continuationReview,
      current_context_reference: ref('different-context')
    }
  })), isInvalidInput);
});

test('tool failure, uncertainty and incomplete evidence do not become denial or quota', () => {
  const prepared = prepareCourierHandoff(request());
  const result = assessCourierHandoff(prepared, observations(prepared, {
    permission_denial: 'UNKNOWN',
    quota_evidence: 'UNKNOWN',
    transport_state: 'UNCERTAIN',
    evidence_state: 'INCOMPLETE',
    tool_state: 'CAPABILITY_ERROR',
    estimate_state: 'UNKNOWN'
  }));
  assert.equal(result.permission_denial, 'UNKNOWN');
  assert.equal(result.quota_evidence, 'UNKNOWN');
  assert.equal(result.transport_state, 'UNCERTAIN');
  assert.equal(result.evidence_state, 'INCOMPLETE');
  assert.equal(result.tool_state, 'CAPABILITY_ERROR');
  assert.equal(result.estimate_state, 'UNKNOWN');

  const explicit = assessCourierHandoff(prepared, observations(prepared, {
    permission_denial: 'OBSERVED',
    quota_evidence: 'OBSERVED',
    tool_state: 'FAILURE'
  }));
  assert.equal(explicit.permission_denial, 'OBSERVED');
  assert.equal(explicit.quota_evidence, 'OBSERVED');
});

test('hostile getters, proxies, toJSON, symbols and cycles are rejected without invoking hooks', () => {
  let called = 0;
  const getter = request();
  Object.defineProperty(getter, 'extra', {
    enumerable: true,
    get() { called++; throw new Error('private'); }
  });
  assert.throws(() => prepareCourierHandoff(getter), isInvalidInput);

  const proxy = new Proxy(request(), {
    get() { called++; throw new Error('private'); },
    ownKeys() { called++; throw new Error('private'); }
  });
  assert.throws(() => prepareCourierHandoff(proxy), isInvalidInput);

  const toJson = request();
  toJson.toJSON = () => { called++; throw new Error('private'); };
  assert.throws(() => prepareCourierHandoff(toJson), isInvalidInput);

  const symbol = request();
  symbol[Symbol('private')] = true;
  assert.throws(() => prepareCourierHandoff(symbol), isInvalidInput);

  const cycle = request();
  cycle.loop = cycle;
  assert.throws(() => prepareCourierHandoff(cycle), isInvalidInput);
  assert.equal(called, 0);
});

test('byte intake uses the existing duplicate-key parser and limits; grouped bounds reject closed', () => {
  const encoded = new TextEncoder().encode(JSON.stringify(request()));
  assert.equal(
    prepareCourierHandoff(encoded).safe_summary.schema_version,
    'squire3.courier_handoff_safe_request.v1'
  );
  const duplicate = new TextEncoder().encode(
    '{"schema_version":"squire3.courier_handoff_request.v1",' +
    '"schema_version":"squire3.courier_handoff_request.v1"}'
  );
  assert.throws(() => prepareCourierHandoff(duplicate), isInvalidInput);
  assert.throws(() => prepareCourierHandoff(
    new Uint8Array(COURIER_HANDOFF_LIMITS.input_bytes + 1)
  ), isInvalidInput);

  const tooManyGroups = request();
  tooManyGroups.required_read_groups = Array.from({length: 17}, (_, i) => [ref(`read-${i}`)]);
  assert.throws(() => prepareCourierHandoff(tooManyGroups), isInvalidInput);
  const tooManyBytes = Array.from({length: 257}, (_, i) => ({
    reference_id: `large-${i}`,
    sha256: 'a'.repeat(64),
    byte_count: COURIER_HANDOFF_LIMITS.max_reference_bytes
  }));
  assert.throws(() => prepareCourierHandoff(request(tooManyBytes)), isInvalidInput);
});

test('private command maximum includes subshell framing and round-trips through assessment intake', () => {
  const input = request();
  const quotes = count => "'".repeat(count);
  input.cwd = `/${quotes(255)}`;
  input.executable = `/${quotes(255)}`;
  input.outer_argv = [
    input.executable,
    ...Array.from({length: 62}, () => quotes(4)),
    quotes(8)
  ];

  const prepared = prepareCourierHandoff(input);
  assert.equal(COURIER_HANDOFF_LIMITS.max_command_bytes, 4039);
  assert.equal(
    Buffer.byteLength(prepared.private_command),
    COURIER_HANDOFF_LIMITS.max_command_bytes
  );
  assert.doesNotThrow(() => assessCourierHandoff(
    prepared,
    observations(prepared)
  ));
  assert.throws(() => assessCourierHandoff({
    ...prepared,
    private_command: `${prepared.private_command}x`
  }, observations(prepared)), isInvalidInput);
});

test('raw capture byte counters accept intended receipts and reject overflows', () => {
  const prepared = prepareCourierHandoff(request());
  const representative = assessCourierHandoff(prepared, observations(prepared, {
    raw_capture: {
      stdout: {state: 'COMPLETE', sha256: hash('stdout'), byte_count: 381430},
      stderr: {state: 'COMPLETE', sha256: hash('stderr'), byte_count: 1095335}
    }
  }));
  assert.equal(representative.raw_capture.stdout.byte_count, 381430);
  assert.equal(representative.raw_capture.stderr.byte_count, 1095335);

  for (const stream of ['stdout', 'stderr']) {
    const limit = COURIER_HANDOFF_LIMITS[`max_${stream}_bytes`];
    const raw = {
      stdout: {state: 'UNKNOWN', sha256: null, byte_count: null},
      stderr: {state: 'UNKNOWN', sha256: null, byte_count: null}
    };
    raw[stream] = {
      state: 'COMPLETE',
      sha256: hash(`${stream}-at-limit`),
      byte_count: limit
    };
    assert.doesNotThrow(() => assessCourierHandoff(
      prepared,
      observations(prepared, {raw_capture: raw})
    ));

    raw[stream] = {...raw[stream], byte_count: limit + 1};
    assert.throws(() => assessCourierHandoff(
      prepared,
      observations(prepared, {raw_capture: raw})
    ), isInvalidInput);
  }
});

test('NOT_ATTEMPTED rejects terminal observations but retains missing-evidence controls', () => {
  const prepared = prepareCourierHandoff(request());
  const startStates = ['UNKNOWN', 'NOT_OBSERVED'];
  const observedTerminals = [
    {state: 'EXIT_CODE', exit_code: 0, signal_state: 'NONE'},
    {state: 'SIGNAL', exit_code: null, signal_state: 'OBSERVED'}
  ];
  const missingTerminals = [
    {state: 'UNKNOWN', exit_code: null, signal_state: 'UNKNOWN'},
    {state: 'NOT_OBSERVED', exit_code: null, signal_state: 'NONE'}
  ];

  for (const processStart of startStates) {
    for (const terminal of observedTerminals) {
      assert.throws(() => assessCourierHandoff(prepared, observations(prepared, {
        dispatch_state: 'NOT_ATTEMPTED',
        process_start_state: processStart,
        terminal
      })), isInvalidInput);

      const uncertainDispatch = assessCourierHandoff(prepared, observations(prepared, {
        dispatch_state: 'UNKNOWN',
        process_start_state: processStart,
        terminal
      }));
      assert.equal(uncertainDispatch.dispatch_state, 'UNKNOWN');
      assert.equal(uncertainDispatch.process_start_state, processStart);
      assert.deepEqual(uncertainDispatch.terminal, terminal);
    }

    for (const terminal of missingTerminals) {
      const unattempted = assessCourierHandoff(prepared, observations(prepared, {
        dispatch_state: 'NOT_ATTEMPTED',
        process_start_state: processStart,
        terminal
      }));
      assert.equal(unattempted.dispatch_state, 'NOT_ATTEMPTED');
      assert.equal(unattempted.process_start_state, processStart);
      assert.deepEqual(unattempted.terminal, terminal);
    }
  }
});
