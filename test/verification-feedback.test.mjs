import test from 'node:test';
import assert from 'node:assert/strict';
import { VerificationRunner } from '../src/verification.mjs';
import { digest, commands, validateConfig } from '../src/contracts.mjs';
import { Controller } from '../src/controller.mjs';
import { Store } from '../src/store.mjs';
import {
  DIAGNOSTIC_FEEDBACK_MAX_BYTES,
  WITHHELD_DIAGNOSTIC_FEEDBACK,
  createDiagnosticFeedbackV1,
  diagnosticFeedbackForPrompt,
  repairReasonForPrompt
} from '../src/verification-feedback.mjs';

const headSha = 'a'.repeat(40), treeSha = 'b'.repeat(40);
const check = (diagnosticDisclosureV1) => ({
  name: 'unitCheck1', argv: ['synthetic-check'], timeoutSeconds: 5,
  ...(diagnosticDisclosureV1 ? { diagnosticDisclosureV1 } : {})
});
const bindingFor = checks => ({ phase: 'candidate-verification', headSha, treeSha, policyDigest: digest(checks) });
const fakeProcessRunner = output => async request => ({
  exitCode: output.exitCode ?? 7,
  stopped: output.stopped ?? false,
  timedOut: output.timedOut ?? false,
  outputExceeded: output.outputExceeded ?? false,
  launchError: output.launchError ?? false,
  stdout: output.stdout ?? '', stderr: output.stderr ?? '',
  argv: request.argv, cwd: request.cwd, directory: request.directory,
  operationId: 'synthetic-operation', startedAt: 1, endedAt: 2
});
const rendered = (stored, checks, binding = bindingFor(checks)) => diagnosticFeedbackForPrompt(stored, checks, binding);
const isScalarText = text => [...text].every(scalar => {
  const point = scalar.codePointAt(0);
  return point < 0xd800 || point > 0xdfff;
});

test('per-check opt-in is strict and unavailable outside configured service checks', () => {
  const approved = check({ version: 1, stdout: 'approved' });
  assert.deepEqual(commands([approved], 'service checks', true, { allowDiagnosticDisclosure: true }), [approved]);
  assert.throws(() => commands([approved], 'setup', false));
  assert.throws(() => commands([check({ version: 2, stdout: 'approved' })], 'service checks', true, { allowDiagnosticDisclosure: true }));
  assert.throws(() => commands([check({ version: 1, mystery: 'approved' })], 'service checks', true, { allowDiagnosticDisclosure: true }));
});

test('metadata alone and default classifications produce one fixed withheld indication', async () => {
  for (const declaration of [undefined, { version: 1, metadata: 'approved' }]) {
    const checks = [check(declaration)];
    const runner = new VerificationRunner('/synthetic-root', { processRunner: fakeProcessRunner({
      stdout: 'SYNTHETIC_PRIVATE_STDOUT', stderr: 'SYNTHETIC_PRIVATE_STDERR'
    }) });
    const outcome = await runner.runForCandidate('/synthetic-workspace', checks, 'synthetic', undefined, bindingFor(checks));
    assert.deepEqual(outcome.diagnosticFeedbackV1, WITHHELD_DIAGNOSTIC_FEEDBACK);
    assert.deepEqual(rendered(outcome.diagnosticFeedbackV1, checks), WITHHELD_DIAGNOSTIC_FEEDBACK);
    assert.equal(JSON.stringify(outcome.diagnosticFeedbackV1).includes('unitCheck1'), false);
    assert.equal(JSON.stringify(outcome.diagnosticFeedbackV1).includes('SYNTHETIC_PRIVATE'), false);
  }
});

test('withheld classifications short-circuit malformed results and excluded getters', () => {
  for (const declaration of [undefined, { version: 1, metadata: 'approved' }]) {
    const checks = [check(declaration)];
    const result = Object.defineProperties({}, {
      name: { get() { throw new Error('EXCLUDED_NAME_GETTER'); } },
      passed: { get() { throw new Error('EXCLUDED_PASSED_GETTER'); } },
      stdout: { get() { throw new Error('EXCLUDED_STDOUT_GETTER'); } },
      stderr: { get() { throw new Error('EXCLUDED_STDERR_GETTER'); } },
      launchError: { get() { throw new Error('EXCLUDED_METADATA_GETTER'); } }
    });
    assert.deepEqual(createDiagnosticFeedbackV1(checks, [result], {
      get phase() { throw new Error('EXCLUDED_BINDING_GETTER'); }
    }), WITHHELD_DIAGNOSTIC_FEEDBACK);
  }
  assert.deepEqual(createDiagnosticFeedbackV1([check()], [{ name: 'SYNTHETIC_PRIVATE', passed: 'malformed' }], null),
    WITHHELD_DIAGNOSTIC_FEEDBACK);
});

test('approved stream projection omits withheld streams and metadata without a metadata classification', async () => {
  const checks = [check({ version: 1, stdout: 'approved', stderr: 'withheld' })];
  const runner = new VerificationRunner('/synthetic-root', { processRunner: fakeProcessRunner({
    stdout: 'SYNTHETIC_APPROVED_STDOUT', stderr: 'SYNTHETIC_EXCLUDED_STDERR'
  }) });
  const outcome = await runner.runForCandidate('/synthetic-workspace', checks, 'synthetic', undefined, bindingFor(checks));
  const payload = rendered(outcome.diagnosticFeedbackV1, checks);
  assert.equal(payload.state, 'ready');
  assert.deepEqual(payload.entries[0], { streams: [{ name: 'stdout', head: 'SYNTHETIC_APPROVED_STDOUT', tail: '' }] });
  assert.equal(JSON.stringify(payload).includes('SYNTHETIC_EXCLUDED_STDERR'), false);
  assert.equal(JSON.stringify(payload).includes('unitCheck1'), false);
  assert.equal(JSON.stringify(payload).includes('operationId'), false);
  assert.equal(JSON.stringify(outcome.diagnosticFeedbackV1).includes('SYNTHETIC_APPROVED_STDOUT'), true);
});

test('aggregate serialized cap, stream fairness, JSON escaping, and Unicode scalar clipping are deterministic', async () => {
  const checks = [check({ version: 1, stdout: 'approved', stderr: 'approved', metadata: 'approved' })];
  const stdout = `SYNTHETIC_STDOUT_HEAD_${'🙂é界\n"\\'.repeat(5000)}_SYNTHETIC_STDOUT_TAIL`;
  const stderr = `SYNTHETIC_STDERR_HEAD_${'ß🙂\t\r'.repeat(5000)}_SYNTHETIC_STDERR_TAIL`;
  const runner = new VerificationRunner('/synthetic-root', { processRunner: fakeProcessRunner({ stdout, stderr, outputExceeded: true }) });
  const outcome = await runner.runForCandidate('/synthetic-workspace', checks, 'synthetic', undefined, bindingFor(checks));
  const payload = rendered(outcome.diagnosticFeedbackV1, checks);
  const serialized = JSON.stringify(payload);
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= DIAGNOSTIC_FEEDBACK_MAX_BYTES);
  assert.ok(serialized.includes('SYNTHETIC_STDOUT_HEAD_'));
  assert.ok(serialized.includes('_SYNTHETIC_STDOUT_TAIL'));
  assert.ok(serialized.includes('SYNTHETIC_STDERR_HEAD_'));
  assert.ok(serialized.includes('_SYNTHETIC_STDERR_TAIL'));
  assert.equal(payload.entries[0].metadata.outputExceeded, true);
  assert.equal(payload.entries[0].metadata.captureIncomplete, true);
  assert.ok(payload.entries[0].streams.every(stream => stream.truncated && stream.omittedBytes > 0));
  assert.ok(payload.entries[0].streams.every(stream => isScalarText(stream.head) && isScalarText(stream.tail)));
  assert.ok(Buffer.byteLength(JSON.stringify(outcome.diagnosticFeedbackV1), 'utf8') < 10000, 'persisted projection contains only clipped approved text');
});

test('literal 8192-byte serialized payload is accepted and the same 8193-byte shape is withheld', () => {
  const checks = [check({ version: 1, stdout: 'approved' })];
  const stored = createDiagnosticFeedbackV1(checks, [{ name: 'unitCheck1', passed: false, stdout: '' }], bindingFor(checks));
  assert.equal(rendered(stored, checks).state, 'ready');
  const empty = rendered(stored, checks);
  const overhead = Buffer.byteLength(JSON.stringify(empty), 'utf8');
  stored.records[0].streams[0].head = 'x'.repeat(DIAGNOSTIC_FEEDBACK_MAX_BYTES - overhead);
  const exact = rendered(stored, checks);
  assert.equal(exact.state, 'ready');
  assert.equal(Buffer.byteLength(JSON.stringify(exact), 'utf8'), DIAGNOSTIC_FEEDBACK_MAX_BYTES);
  stored.records[0].streams[0].head += 'x';
  assert.deepEqual(rendered(stored, checks), WITHHELD_DIAGNOSTIC_FEEDBACK);
});

test('approved metadata rejects malformed facts and summarizes only supported launch-error values', () => {
  const checks = [check({ version: 1, stdout: 'approved', metadata: 'approved' })];
  const binding = bindingFor(checks);
  const valid = { name: 'unitCheck1', passed: false, exitCode: 7, stopped: false, timedOut: false,
    outputExceeded: false, launchError: null, stdout: 'SYNTHETIC_APPROVED' };
  for (const malformed of [
    { stopped: 'true' }, { timedOut: 1 }, { outputExceeded: 'false' }, { exitCode: undefined },
    { exitCode: Infinity }, { launchError: { message: 'SYNTHETIC_SECRET_ERROR' } }, { launchError: 1 }
  ]) {
    const feedback = createDiagnosticFeedbackV1(checks, [{ ...valid, ...malformed }], binding);
    assert.notEqual(feedback.state, 'ready');
    assert.equal(JSON.stringify(feedback).includes('SYNTHETIC_SECRET_ERROR'), false);
  }
  for (const launchError of [undefined, null, false, true, 'SYNTHETIC_ERROR_MESSAGE']) {
    const feedback = createDiagnosticFeedbackV1(checks, [{ ...valid, launchError }], binding);
    assert.equal(feedback.state, 'ready');
    const payload = rendered(feedback, checks);
    assert.equal(payload.entries[0].metadata.launchError, launchError === true || (typeof launchError === 'string' && launchError.length > 0));
    assert.equal(JSON.stringify(payload).includes('SYNTHETIC_ERROR_MESSAGE'), false);
  }
});

test('candidate or current-policy mismatch, malformed new data, and legacy raw reasons stay withheld', async () => {
  const checks = [check({ version: 1, stdout: 'approved' })];
  const runner = new VerificationRunner('/synthetic-root', { processRunner: fakeProcessRunner({ stdout: 'SYNTHETIC_APPROVED' }) });
  const outcome = await runner.runForCandidate('/synthetic-workspace', checks, 'synthetic', undefined, bindingFor(checks));
  const staleCandidate = rendered(outcome.diagnosticFeedbackV1, checks, { ...bindingFor(checks), headSha: 'c'.repeat(40) });
  const changedPolicy = [check({ version: 1, stdout: 'withheld' })];
  assert.deepEqual(staleCandidate, WITHHELD_DIAGNOSTIC_FEEDBACK);
  assert.deepEqual(rendered(outcome.diagnosticFeedbackV1, changedPolicy), WITHHELD_DIAGNOSTIC_FEEDBACK);
  assert.deepEqual(rendered({ ...outcome.diagnosticFeedbackV1, extra: 'SYNTHETIC_RAW' }, checks), WITHHELD_DIAGNOSTIC_FEEDBACK);

  const legacy = repairReasonForPrompt({ passed: false, results: [{ failureTail: 'SYNTHETIC_LEGACY_RAW' }], notRun: [] }, checks, bindingFor(checks));
  assert.deepEqual(legacy, { code: 'verification_failed', diagnosticFeedbackV1: WITHHELD_DIAGNOSTIC_FEEDBACK });
  const automatic = repairReasonForPrompt({ code: 'verification_failed', passed: false,
    results: [{ failureTail: 'SYNTHETIC_AUTOMATIC_RAW' }], notRun: [], diagnosticFeedbackV1: outcome.diagnosticFeedbackV1 }, checks, bindingFor(checks));
  assert.deepEqual(automatic, { code: 'verification_failed', diagnosticFeedbackV1: rendered(outcome.diagnosticFeedbackV1, checks) });
  const correction = repairReasonForPrompt({ code: 'authorized_correction', outcome: 'Fix the test', instructions: 'Stay in scope',
    actualFailure: { kind: 'failed_verification', headSha, failedChecks: [{ failureTail: 'SYNTHETIC_CORRECTION_RAW' }],
      diagnosticFeedbackV1: outcome.diagnosticFeedbackV1 }, extra: 'SYNTHETIC_EXTRA' }, checks, bindingFor(checks));
  assert.deepEqual(correction.actualFailure, { kind: 'failed_verification', diagnosticFeedbackV1: rendered(outcome.diagnosticFeedbackV1, checks) });
  assert.equal(Object.hasOwn(correction, 'extra'), false);
  assert.equal(JSON.stringify(correction).includes('SYNTHETIC_CORRECTION_RAW'), false);
  const continuation = repairReasonForPrompt({ code: 'interrupted_continuation', actualPartialReview: { verdict: 'fail' },
    actualPartialVerification: { results: [{ failureTail: 'SYNTHETIC_CONTINUATION_RAW' }] }, extra: 'SYNTHETIC_EXTRA' }, checks, bindingFor(checks));
  assert.deepEqual(continuation.actualPartialVerification, WITHHELD_DIAGNOSTIC_FEEDBACK);
  assert.deepEqual(continuation.actualPartialReview, { verdict: 'fail' });
  assert.equal(JSON.stringify(continuation).includes('SYNTHETIC_CONTINUATION_RAW'), false);
  assert.equal(Object.hasOwn(continuation, 'extra'), false);

  for (const malformed of [
    { passed: 'false', results: [{ failureTail: 'SYNTHETIC_MALFORMED_LEGACY' }] },
    { notRun: [{ name: 'SYNTHETIC_NOTRUN_NAME' }] },
    { code: 'authorized_correction', actualFailure: { kind: 'malformed_verification', failureTail: 'SYNTHETIC_MALFORMED_CORRECTION' } },
    { code: 'interrupted_continuation', actualPartialVerification: { kind: 'malformed_verification', results: [{ failureTail: 'SYNTHETIC_MALFORMED_CONTINUATION' }] } }
  ]) {
    assert.equal(JSON.stringify(repairReasonForPrompt(malformed, checks, bindingFor(checks))).includes('SYNTHETIC_'), false);
  }
  const validReviewFailure = { code: 'authorized_correction', message: 'Synthetic correction', outcome: 'Synthetic outcome',
    instructions: 'Synthetic instructions', actualFailure: { kind: 'failed_review', reviewDigest: 'c'.repeat(64),
      headSha, summary: 'SYNTHETIC_APPROVED_REVIEW', findings: [], checklist: [] } };
  assert.deepEqual(repairReasonForPrompt(validReviewFailure, checks, bindingFor(checks)), validReviewFailure);
});

test('persisted records must be unique and follow configured check order', () => {
  const checks = [check({ version: 1, stdout: 'approved' }), { ...check({ version: 1, stdout: 'approved' }), name: 'secondCheck' }];
  const results = checks.map(item => ({ name: item.name, passed: false, stdout: `SYNTHETIC_${item.name}` }));
  const stored = createDiagnosticFeedbackV1(checks, results, bindingFor(checks));
  assert.equal(rendered(stored, checks).state, 'ready');
  const duplicate = structuredClone(stored);
  duplicate.records[1] = structuredClone(duplicate.records[0]);
  assert.deepEqual(rendered(duplicate, checks), WITHHELD_DIAGNOSTIC_FEEDBACK);
  const reordered = structuredClone(stored);
  reordered.records.reverse();
  assert.deepEqual(rendered(reordered, checks), WITHHELD_DIAGNOSTIC_FEEDBACK);
});

test('unrecognized verification markers and conflicting verification branches fail closed', () => {
  const checks = [check({ version: 1, stdout: 'approved' })];
  const stored = createDiagnosticFeedbackV1(checks, [{ name: 'unitCheck1', passed: false, stdout: 'SYNTHETIC_APPROVED' }], bindingFor(checks));
  const withheldReason = { code: 'verification_failed', diagnosticFeedbackV1: WITHHELD_DIAGNOSTIC_FEEDBACK };
  const markerCases = [
    { passed: 'malformed', owner: 'synthetic' },
    { results: 'malformed', owner: 'synthetic' },
    { notRun: null, owner: 'synthetic' },
    { failureTail: { text: 'SYNTHETIC_PRIVATE_FAILURE_TAIL' }, owner: 'synthetic' },
    { failedChecks: [{ detail: 'SYNTHETIC_PRIVATE_FAILED_CHECK' }], owner: 'synthetic' },
    { stdout: 'SYNTHETIC_PRIVATE_STDOUT', owner: 'synthetic' },
    { stderr: 'SYNTHETIC_PRIVATE_STDERR', owner: 'synthetic' },
    { diagnosticFeedbackV1: { unexpected: 'SYNTHETIC_PRIVATE_NEW_FIELD' }, owner: 'synthetic' }
  ];
  for (const reason of markerCases) {
    assert.deepEqual(repairReasonForPrompt(reason, checks, bindingFor(checks)), withheldReason);
  }

  const conflicting = repairReasonForPrompt({ code: 'verification_failed', diagnosticFeedbackV1: stored,
    passed: false, results: [{ failureTail: 'SYNTHETIC_PRIVATE_OLD' }], notRun: [],
    actualFailure: { kind: 'failed_verification', diagnosticFeedbackV1: stored },
    actualPartialVerification: { diagnosticFeedbackV1: stored } }, checks, bindingFor(checks));
  assert.deepEqual(conflicting, withheldReason);

  const ownerContexts = [
    { code: 'review_failed', message: 'Synthetic review context', detail: { verdict: 'fail', findings: ['Synthetic finding'] } },
    { code: 'base_moved', headSha, treeSha, rebase: { status: 'ready' } },
    { code: 'ci_failed', status: 'failed', checks: ['Synthetic CI check'] },
    { code: 'runtime_failed', role: 'implement', message: 'Synthetic owner failure', detail: { kind: 'capacity' } }
  ];
  for (const context of ownerContexts) assert.deepEqual(repairReasonForPrompt(context, checks, bindingFor(checks)), context);
});

test('primitive and array repair reasons are withheld instead of prompt-serialized', () => {
  const checks = [check()];
  const withheldReason = { code: 'verification_failed', diagnosticFeedbackV1: WITHHELD_DIAGNOSTIC_FEEDBACK };
  for (const malformed of ['SYNTHETIC_PRIVATE_STRING', ['SYNTHETIC_PRIVATE_ARRAY'], 42, false]) {
    const projected = repairReasonForPrompt(malformed, checks, bindingFor(checks));
    assert.deepEqual(projected, withheldReason);
    assert.equal(JSON.stringify(projected).includes('SYNTHETIC_PRIVATE'), false);
  }
  assert.equal(repairReasonForPrompt(null, checks, bindingFor(checks)), null);
  assert.equal(repairReasonForPrompt(undefined, checks, bindingFor(checks)), undefined);
});

test('candidate-bound run preserves pass outcome and legacy generic run shape', async () => {
  const checks = [check({ version: 1, stdout: 'approved' })];
  const runner = new VerificationRunner('/synthetic-root', { processRunner: fakeProcessRunner({ exitCode: 0, stdout: 'SYNTHETIC_PASS' }) });
  const candidate = await runner.runForCandidate('/synthetic-workspace', checks, 'synthetic', undefined, bindingFor(checks));
  assert.equal(candidate.passed, true);
  assert.equal(Object.hasOwn(candidate, 'diagnosticFeedbackV1'), false);
  const generic = await runner.run('/synthetic-workspace', checks, 'synthetic-generic');
  assert.deepEqual(Object.keys(generic), ['passed', 'results', 'notRun']);
});

test('automatic-repair and correction consumers retain private evidence without projecting it', async () => {
  const checks = [check()];
  const original = { passed: false, results: [{ name: 'unitCheck1', passed: false, failureTail: 'SYNTHETIC_PRIVATE_TAIL',
    argv: ['SYNTHETIC_PRIVATE_ARG'], stdout: undefined, stderr: undefined }], notRun: [{ name: 'SYNTHETIC_PRIVATE_NOTRUN', status: 'NOTRUN' }] };
  const ticket = { spec: { id: 'ticket1', service: 'app' }, status: 'verifying', headSha, treeSha, repairs: 0, attempts: 1 };
  const fakeController = {
    config: { services: { app: { checks } }, limits: { maxRepairs: 2 } }, root: '/synthetic', current: () => ticket,
    assertActive: async () => {}, ensureTicketPreparation: async () => {}, deliveryFactory: () => ({}),
    workspace: { assertCandidate: async () => ({ headSha, treeSha }) }, checkBinding: () => bindingFor(checks),
    verifier: { runForCandidate: async () => structuredClone(original) },
    retainChecks: async () => { throw new Error('SYNTHETIC_RETENTION_FAILURE'); },
    change: (_id, fn) => fn(ticket), transition: (_id, status, patch) => Object.assign(ticket, { status }, patch),
    repair: async (id, reason) => Controller.prototype.repair.call(fakeController, id, reason)
  };
  await Controller.prototype.produceStep.call(fakeController, 'ticket1');
  assert.equal(ticket.status, 'repairing');
  assert.deepEqual(ticket.repairReason.results, original.results);
  assert.deepEqual(ticket.repairReason.notRun, original.notRun);
  assert.equal(ticket.verification, null);
  assert.equal(ticket.attempts, 1);
  assert.equal(ticket.repairs, 0);
  assert.equal(JSON.stringify(repairReasonForPrompt(ticket.repairReason, checks, bindingFor(checks))).includes('SYNTHETIC_PRIVATE_'), false);

  const execution = { version: 1, outcome: 'Synthetic outcome', ownedPaths: ['feature.mjs'], contextPaths: [], invariants: ['Synthetic invariant'],
    checklist: [{ id: 'base1', assertion: 'Synthetic assertion', steps: ['Synthetic step'], evidence: 'Synthetic evidence' }], stopWhen: 'Synthetic stop', maxAttempts: 1 };
  const spec = { id: 'ticket1', service: 'app', title: 'Synthetic ticket', description: 'Synthetic description',
    acceptance: ['Synthetic acceptance'], dependsOn: [], execution };
  const config = validateConfig({ version: 1, id: 'synthetic', stateDir: '/synthetic-state', tickets: [spec],
    services: { app: { source: '/synthetic-source', branch: 'main', delivery: { kind: 'local' }, checks } } });
  const verification = { passed: false, headSha, treeSha, policyDigest: digest(checks),
    results: [{ name: 'unitCheck1', passed: false, argv: checks[0].argv, exitCode: 7, stopped: false, timedOut: false,
      outputExceeded: false, launchError: null, failureTail: 'SYNTHETIC_PRIVATE_STORE_RAW' }],
    notRun: [], checkEvidence: { state: 'unavailable', reason: 'retention_failed' } };
  const storedTicket = { spec, status: 'blocked', headSha, treeSha, repairs: 2, attempts: 1, rebases: 0,
    blocker: { code: 'repair_budget' }, implementation: { sessionRef: 'synthetic-session', jobId: 'synthetic-job' },
    verification: structuredClone(verification) };
  const state = { id: config.id, config, paused: true, tickets: [storedTicket] };
  const fakeStore = { transaction: fn => fn(), get: () => state, assertProducerScopesClear: () => {}, emit: () => {},
    db: { prepare: sql => ({ get: () => sql.includes('config_hash') ? { config_hash: digest(config) } : undefined, run: () => {} }) } };
  Store.prototype.authorizeCorrection.call(fakeStore, config, { ticketId: 'ticket1', expectedHeadSha: headSha,
    outcome: 'Synthetic correction', instructions: 'Synthetic instructions',
    checklist: [{ id: 'fix1', assertion: 'Synthetic assertion', steps: ['Synthetic step'], evidence: 'Synthetic evidence' }] });
  assert.deepEqual(storedTicket.correctionAdmission.evidence.originalVerification, verification);
  assert.deepEqual(storedTicket.correctionAdmission.evidence.counters, { attempts: 1, repairs: 2, rebases: 0 });
  assert.equal(JSON.stringify(repairReasonForPrompt(storedTicket.repairReason, checks, bindingFor(checks))).includes('SYNTHETIC_PRIVATE_STORE_RAW'), false);
});
