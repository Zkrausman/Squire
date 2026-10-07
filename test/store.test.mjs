import test from './standalone.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { digest, validateConfig } from '../src/contracts.mjs';
import { fixture } from './support.mjs';

test('state and ordered outbox events survive reopening; authority changes reject', async t => {
  const f = await fixture(t);
  f.store.update(f.config.id, s => { s.tickets[0].status = 'verifying'; s.tickets[0].headSha = 'a'.repeat(40); }, 'ticket.transition', { ticket: 'a' });
  const other = new Store(f.stateDir); f.addCleanup(() => other.close());
  assert.equal(other.get(f.config.id).tickets[0].headSha, 'a'.repeat(40));
  const events = other.events(f.config.id); assert.deepEqual(events.map(e => e.type), ['project.created', 'ticket.transition']);
  assert.equal(other.events(f.config.id, events[0].cursor).length, 1);
  assert.throws(() => other.initialize({ ...f.config, goal: 'Expanded authority' }), /policy changed/);
});
test('failed transaction rolls back both state and events; lease excludes live owner', async t => {
  const f = await fixture(t), previous = f.store.get(f.config.id);
  assert.throws(() => f.store.update(f.config.id, s => { s.status = 'completed'; f.store.emit(f.config.id, 'bad', {}); throw new Error('abort'); }, 'bad'), /abort/);
  assert.equal(f.store.get(f.config.id).status, previous.status); assert.equal(f.store.events(f.config.id).length, 1);
  const release = f.store.lease('repo:main'); assert.throws(() => f.store.lease('repo:main'), /live controller/); release();
  f.store.lease('repo:main')();
});
test('pause and retry are explicit; postmerge failure retries verification, never implementation', async t => {
  const f = await fixture(t); f.store.pause(f.config.id); assert.equal(f.store.get(f.config.id).paused, true);
  f.store.update(f.config.id, s => { s.tickets[0].status = 'blocked'; s.tickets[0].mergeSha = 'a'.repeat(40); s.tickets[0].blocker = { code: 'postmerge_failed' }; });
  f.store.resume(f.config.id, true); assert.equal(f.store.get(f.config.id).tickets[0].status, 'postmerge');
});

test('model policy change requires quiescence, preserves budgets and forces fresh review', async t => {
  const f = await fixture(t);
  const runtime = { ...f.config.runtime, roles: { implement: { model: 'luna', reasoning: 'max' }, review: { model: 'sol', reasoning: 'medium' } } };
  assert.throws(() => f.store.configureRuntime(f.config, runtime), /Pause/);
  f.store.pause(f.config.id);
  const release = f.store.lease(`controller:${f.config.id}`);
  assert.throws(() => f.store.configureRuntime(f.config, runtime), /settle/); release();
  assert.throws(() => f.store.configureRuntime(f.config, { ...runtime, command: ['another-cli'] }), /authority/);
  f.store.update(f.config.id, s => { s.agentCalls = 8; s.tickets[0].repairs = 3; s.tickets[0].status = 'publishing'; s.tickets[0].headSha = 'a'.repeat(40); s.tickets[0].review = { verdict: 'pass' }; });
  const changed = f.store.configureRuntime(f.config, runtime);
  assert.equal(changed.agentCalls, 8); assert.equal(changed.tickets[0].repairs, 3);
  assert.equal(changed.tickets[0].headSha, 'a'.repeat(40)); assert.equal(changed.tickets[0].status, 'verifying'); assert.equal(changed.tickets[0].review, null);
  assert.equal(f.store.initialize(changed.config).config.runtime.roles.implement.reasoning, 'max');
  assert.throws(() => f.store.initialize(f.config), /policy changed/);
  assert.equal(f.store.events(f.config.id).at(-1).type, 'project.runtime_configured');
});

const structuredTicket = (id = 'a', dependsOn = []) => ({
  id, service: 'app', title: `Feature ${id}`, description: `Add feature ${id}.`,
  acceptance: ['Feature behavior is correct.'], dependsOn,
  execution: {
    version: 1, outcome: 'Implement the feature.', ownedPaths: ['feature-a.mjs'], contextPaths: [],
    invariants: ['Keep the exported API stable.'],
    checklist: [
      { id: 'base-one', assertion: 'Basic behavior works.', steps: ['Run the behavior check.'], evidence: 'Passing assertion.' },
      { id: 'base-two', assertion: 'Negative inputs are handled.', steps: ['Exercise a negative input.'], evidence: 'Observed expected result.' }
    ],
    stopWhen: 'Stop after one unresolved outcome.', maxAttempts: 1
  }
});
test('selective infrastructure retry preserves unrelated review stops and recovers partial workspace', async t => {
  const f = await fixture(t, [structuredTicket('a'), structuredTicket('b')]);
  f.store.update(f.config.id, s => {
    Object.assign(s.tickets[0], { status: 'blocked', attempts: 1, repairs: 0, workspace: 'preserved-workspace', beforeAgentHead: 'a'.repeat(40), blocker: { code: 'unexpected_error', message: 'Subprocess ended without durable receipt' } });
    Object.assign(s.tickets[1], { status: 'blocked', attempts: 3, repairs: 2, headSha: 'b'.repeat(40), blocker: { code: 'repair_budget', message: 'Real source finding' } });
  });
  const before=f.store.get(f.config.id).tickets[1];
  assert.throws(()=>f.store.resume(f.config.id,true,['missing']), /existing ticket/);
  const state=f.store.resume(f.config.id,true,['a']);
  assert.equal(state.tickets[0].status,'recovering');
  assert.equal(state.tickets[0].attempts,1);assert.equal(state.tickets[0].repairs,0);
  assert.equal(state.tickets[0].workspace,'preserved-workspace');
  assert.equal(state.tickets[0].retryHistory[0].blocker.code,'unexpected_error');
  assert.deepEqual(state.tickets[1],before);
});
const correctionFor = head => ({
  ticketId: 'a', expectedHeadSha: head, outcome: 'Handle the reviewed edge case.',
  instructions: 'Keep the change within feature-a.mjs and add a regression assertion.',
  checklist: [{ id: 'correction-one', assertion: 'The edge case is handled.', steps: ['Run its regression assertion.'], evidence: 'Observed expected output.' }]
});

test('correction admission is exact-head, paused, quiescent, one-time, and preserves ticket authority and history', async t => {
  const f = await fixture(t, [structuredTicket(), { ...structuredTicket('b'), execution: undefined, dependsOn: ['a'] }]);
  const originalSpec = structuredClone(f.store.get(f.config.id).tickets[0].spec);
  const headSha = 'b'.repeat(40);
  const review = { headSha, verdict: 'fail', summary: 'P1 fixture finding', findings: [{ priority: 'P1', file: 'feature-a.mjs', line: 1, message: 'Handle the reviewed edge case.' }], sessionRef: 'fresh-review', jobId: 'review-job' };
  f.store.update(f.config.id, state => {
    const ticket = state.tickets[0];
    Object.assign(ticket, { status: 'blocked', attempts: 1, repairs: 2, rebases: 1, headSha, treeSha: 'c'.repeat(40), baseSha: 'd'.repeat(40), blocker: { code: 'repair_budget', message: 'Budget exhausted' }, review, verification: { passed: true }, implementation: { sessionRef: 'completed-implementation', jobId: 'implementation-job' } });
    state.tickets[1].status = 'dependency_blocked'; state.tickets[1].blocker = { code: 'dependency' };
  });
  const correction = correctionFor(headSha);
  assert.throws(() => f.store.authorizeCorrection(f.config, correction), /Pause the project/);
  f.store.pause(f.config.id);
  const release = f.store.lease(`controller:${f.config.id}`);
  assert.throws(() => f.store.authorizeCorrection(f.config, correction), /settle/); release();
  assert.throws(() => f.store.authorizeCorrection({ ...f.config, goal: 'different policy' }, correction), /configuration/);
  assert.throws(() => f.store.authorizeCorrection(f.config, correctionFor('e'.repeat(40))), /expectedHeadSha/);
  const tooMany = { ...correction, checklist: Array.from({ length: 7 }, (_, index) => ({ ...correction.checklist[0], id: `extra-${index}` })) };
  assert.throws(() => f.store.authorizeCorrection(f.config, tooMany), /combined review limit/);

  const before = f.store.get(f.config.id).tickets[0];
  const receipt = f.store.authorizeCorrection(f.config, correction);
  assert.equal(receipt.admitted, true); assert.equal(receipt.status, 'repairing'); assert.equal(receipt.headSha, headSha);
  const state = f.store.get(f.config.id), ticket = state.tickets[0];
  assert.equal(state.paused, true);
  assert.equal(ticket.status, 'repairing'); assert.equal(ticket.headSha, before.headSha); assert.equal(ticket.treeSha, before.treeSha);
  assert.equal(ticket.attempts, before.attempts); assert.equal(ticket.repairs, before.repairs); assert.equal(ticket.rebases, before.rebases);
  assert.deepEqual(ticket.spec, originalSpec); assert.equal(ticket.review, null); assert.equal(ticket.verification, null);
  assert.equal(ticket.correctionAdmission.evidence.originalReview.headSha, headSha);
  assert.deepEqual(ticket.correctionAdmission.evidence.originalBlocker, before.blocker);
  assert.deepEqual(ticket.correctionAdmission.ceilings, { implementAttempts: 2, repairs: 3 });
  assert.equal(state.tickets[1].status, 'queued');
  assert.throws(() => f.store.authorizeCorrection(f.config, correction), /already received/);
  assert.equal(f.store.events(f.config.id).at(-1).type, 'ticket.correction_authorized');
});

test('failed-review correction admits one or two additive criteria over an immutable eight-item base', async t => {
  const makeSpec = () => {
    const spec = structuredTicket();
    spec.execution.checklist = Array.from({ length: 8 }, (_, index) => ({
      id: `base-${index}`, assertion: `Base behavior ${index} holds.`,
      steps: [`Exercise base behavior ${index}.`], evidence: `Observe base behavior ${index}.`
    }));
    return spec;
  };
  const makeAdditional = count => Array.from({ length: count }, (_, index) => ({
    id: `correction-${index}`, assertion: `Narrow corrected behavior ${index} holds.`,
    steps: [`Run regression ${index}.`], evidence: `Observe regression ${index}.`
  }));

  for (const count of [1, 2]) {
    const spec = makeSpec(), f = await fixture(t, [spec]), headSha = String(count + 2).repeat(40);
    const review = { headSha, verdict: 'fail', summary: 'Exact candidate has one narrow finding.',
      findings: [{ priority: 'P1', file: 'feature-a.mjs', line: 1, message: 'Fix the narrowly identified boundary.' }],
      sessionRef: 'fresh-review', jobId: `review-${count}` };
    f.store.update(f.config.id, state => Object.assign(state.tickets[0], {
      status: 'blocked', attempts: 1, repairs: 1, rebases: 2, reviewAttempts: 1,
      headSha, treeSha: 'a'.repeat(40), baseSha: 'b'.repeat(40),
      blocker: { code: 'repair_budget', message: 'Original budget exhausted after review.' },
      review, implementation: { sessionRef: 'completed-implementation', jobId: `implementation-${count}` }
    }));
    f.store.pause(f.config.id);
    const before = f.store.get(f.config.id).tickets[0], originalSpec = structuredClone(before.spec);
    const correction = { ...correctionFor(headSha), checklist: makeAdditional(count) };
    const receipt = f.store.authorizeCorrection(f.config, correction);
    const after = f.store.get(f.config.id).tickets[0];
    assert.equal(receipt.status, 'repairing');
    assert.deepEqual(after.spec, originalSpec);
    assert.deepEqual(after.correctionAdmission.checklist, correction.checklist);
    assert.deepEqual(after.correctionAdmission.evidence.counters,
      { attempts: before.attempts, repairs: before.repairs, rebases: before.rebases });
    assert.equal(after.spec.execution.checklist.length, 8);
    assert.equal(after.spec.execution.checklist.length + after.correctionAdmission.checklist.length, 8 + count);
    assert.throws(() => f.store.authorizeCorrection(f.config, correction), /already received/);
  }

  const spec = makeSpec(), f = await fixture(t, [spec]), headSha = '5'.repeat(40);
  f.store.update(f.config.id, state => Object.assign(state.tickets[0], {
    status: 'blocked', attempts: 1, repairs: 1, headSha, treeSha: '6'.repeat(40),
    blocker: { code: 'repair_budget', message: 'Original budget exhausted.' },
    review: { headSha, verdict: 'fail', summary: 'Finding.', findings: [{ priority: 'P1', file: 'feature-a.mjs', line: 1, message: 'Fix.' }], sessionRef: 'review', jobId: 'review-job' },
    implementation: { sessionRef: 'complete', jobId: 'implementation-job' }
  }));
  f.store.pause(f.config.id);
  assert.throws(() => f.store.authorizeCorrection(f.config, { ...correctionFor(headSha), checklist: makeAdditional(3) }), /checklist must add 1\.\.2 criteria/);
});

test('inherited nine-item base has one correction slot and exact verification can close a full-ten base', async t => {
  const makeSpec = count => {
    const spec = structuredTicket();
    spec.execution.checklist = Array.from({ length: count }, (_, index) => ({
      id: `inherited-${index}`, assertion: `Inherited requirement ${index} holds.`,
      steps: [`Exercise inherited requirement ${index}.`], evidence: `Observe inherited requirement ${index}.`
    }));
    return spec;
  };
  const one = [{ id: 'last-slot', assertion: 'The new narrow boundary is covered.', steps: ['Run its regression.'], evidence: 'Observe its expected output.' }];
  const nineFixture = await fixture(t, [makeSpec(9)]), nineHead = '7'.repeat(40);
  nineFixture.store.update(nineFixture.config.id, state => Object.assign(state.tickets[0], {
    status: 'blocked', attempts: 1, repairs: 1, headSha: nineHead, treeSha: '8'.repeat(40),
    blocker: { code: 'repair_budget', message: 'Exact-head review failed.' },
    review: { headSha: nineHead, verdict: 'fail', summary: 'Narrow finding.', findings: [{ priority: 'P1', file: 'feature-a.mjs', line: 1, message: 'Correct the boundary.' }], sessionRef: 'review-nine', jobId: 'review-nine-job' },
    implementation: { sessionRef: 'impl-nine', jobId: 'impl-nine-job' }
  }));
  nineFixture.store.pause(nineFixture.config.id);
  assert.throws(() => nineFixture.store.authorizeCorrection(nineFixture.config, { ...correctionFor(nineHead), checklist: [...one, { ...one[0], id: 'over-cap' }] }), /checklist must add 1\.\.1 criteria/);
  const originalNine = structuredClone(nineFixture.store.get(nineFixture.config.id).tickets[0].spec.execution);
  nineFixture.store.authorizeCorrection(nineFixture.config, { ...correctionFor(nineHead), checklist: one });
  const nineAfter = nineFixture.store.get(nineFixture.config.id).tickets[0];
  assert.equal(nineAfter.spec.execution.checklist.length, 9);
  assert.deepEqual(nineAfter.spec.execution, originalNine);
  assert.equal(nineAfter.spec.execution.checklist.length + nineAfter.correctionAdmission.checklist.length, 10);

  const tenHead = '9'.repeat(40), tenFixture = await fixture(t, [makeSpec(10)]), tenTree = 'a'.repeat(40);
  tenFixture.store.update(tenFixture.config.id, state => Object.assign(state.tickets[0], {
    status: 'blocked', attempts: 1, repairs: 0, headSha: tenHead, treeSha: tenTree,
    blocker: { code: 'repair_budget', message: 'Exact required check failed.' },
    implementation: { sessionRef: 'impl-ten', jobId: 'impl-ten-job' },
    verification: failedVerificationFor(tenFixture, tenHead, tenTree)
  }));
  tenFixture.store.pause(tenFixture.config.id);
  const originalTen = structuredClone(tenFixture.store.get(tenFixture.config.id).tickets[0].spec.execution);
  const receipt = tenFixture.store.authorizeCorrection(tenFixture.config, { ...correctionFor(tenHead), checklist: [] });
  const tenAfter = tenFixture.store.get(tenFixture.config.id).tickets[0];
  assert.equal(receipt.status, 'repairing');
  assert.deepEqual(tenAfter.spec.execution, originalTen);
  assert.deepEqual(tenAfter.correctionAdmission.checklist, []);

  const tenReviewHead = 'c'.repeat(40), tenReviewFixture = await fixture(t, [makeSpec(10)]);
  tenReviewFixture.store.update(tenReviewFixture.config.id, state => Object.assign(state.tickets[0], {
    status: 'blocked', attempts: 1, repairs: 1, headSha: tenReviewHead, treeSha: 'd'.repeat(40),
    blocker: { code: 'repair_budget', message: 'Exact-head review failed.' },
    review: { headSha: tenReviewHead, verdict: 'fail', summary: 'No room for more criteria.', findings: [{ priority: 'P1', file: 'feature-a.mjs', line: 1, message: 'Fix.' }], sessionRef: 'review-ten', jobId: 'review-ten-job' },
    implementation: { sessionRef: 'impl-ten-review', jobId: 'impl-ten-review-job' }
  }));
  tenReviewFixture.store.pause(tenReviewFixture.config.id);
  assert.throws(() => tenReviewFixture.store.authorizeCorrection(tenReviewFixture.config, { ...correctionFor(tenReviewHead), checklist: one }), /checklist must add/);
});

test('correction admission rejects legacy, non-budget, merged, or missing exact-head failed-review evidence', async t => {
  const f = await fixture(t, [structuredTicket(), { ...structuredTicket('legacy'), execution: undefined }]);
  const headSha = 'f'.repeat(40), correction = correctionFor(headSha);
  f.store.pause(f.config.id);
  f.store.update(f.config.id, state => {
    const ticket = state.tickets[0];
    Object.assign(ticket, { status: 'blocked', headSha, treeSha: 'a'.repeat(40), blocker: { code: 'other' }, implementation: { sessionRef: 'completed-implementation', jobId: 'implementation-job' }, review: { headSha, verdict: 'fail', summary: 'finding', findings: [{ priority: 'P1', file: 'feature-a.mjs', line: 1, message: 'Fix' }], sessionRef: 'review', jobId: 'job' } });
    state.tickets[1].status = 'blocked'; state.tickets[1].blocker = { code: 'repair_budget' };
  });
  assert.throws(() => f.store.authorizeCorrection(f.config, correction), /repair_budget or slice_budget/);
  f.store.update(f.config.id, state => { state.tickets[0].blocker = { code: 'slice_budget' }; state.tickets[0].review.headSha = 'e'.repeat(40); });
  assert.throws(() => f.store.authorizeCorrection(f.config, correction), /exact blocked candidate/);
  f.store.update(f.config.id, state => { state.tickets[0].review.headSha = headSha; state.tickets[0].publication = { id: 'published' }; });
  assert.throws(() => f.store.authorizeCorrection(f.config, correction), /published tickets/);
  f.store.update(f.config.id, state => { delete state.tickets[0].publication; state.tickets[1].headSha = headSha; state.tickets[1].review = state.tickets[0].review; });
  assert.throws(() => f.store.authorizeCorrection(f.config, { ...correction, ticketId: 'legacy' }), /structured execution contract/);
});

const failedCheckFor = (f, overrides = {}) => ({
  name: 'behavior', argv: f.config.services.app.checks[0].argv[0] === 'node' ? [process.execPath, ...f.config.services.app.checks[0].argv.slice(1)] : f.config.services.app.checks[0].argv, passed: false, exitCode: 1,
  stopped: false, timedOut: false, outputExceeded: false, launchError: null, failureTail: 'Pinned manifest assertion failed.',
  ...overrides
});
const failedVerificationFor = (f, headSha, treeSha, overrides = {}) => ({
  passed: false, headSha, treeSha, policyDigest: digest(f.config.services.app.checks),
  results: [failedCheckFor(f)],
  ...overrides
});

test('correction admission accepts an exact completed application-check failure and preserves its hashed receipt', async t => {
  const f = await fixture(t, [structuredTicket()]), headSha = '9'.repeat(40), treeSha = '8'.repeat(40);
  f.store.update(f.config.id, state => {
    Object.assign(state.tickets[0], {
      status: 'blocked', attempts: 1, repairs: 0, rebases: 0, reviewAttempts: 0,
      headSha, treeSha, baseSha: '7'.repeat(40), workspace: path.join(f.root, 'workspaces', 'a-1'), generation: 1,
      implementation: { sessionRef: 'completed-implementation', jobId: 'implementation-job' },
      blocker: { code: 'repair_budget', message: 'Required behavior check failed.' },
      review: null, lastFailedReview: null,
      verification: failedVerificationFor(f, headSha, treeSha)
    });
  });
  f.store.pause(f.config.id);
  const before = f.store.get(f.config.id).tickets[0], receipt = f.store.authorizeCorrection(f.config, correctionFor(headSha));
  const saved = f.store.get(f.config.id).tickets[0], audit = saved.correctionAdmission.evidence;
  assert.equal(receipt.status, 'repairing'); assert.equal(saved.status, 'repairing');
  assert.equal(saved.attempts, before.attempts); assert.equal(saved.repairs, before.repairs); assert.equal(saved.rebases, before.rebases);
  assert.deepEqual(saved.spec, before.spec); assert.equal(saved.headSha, headSha); assert.equal(saved.treeSha, treeSha);
  assert.equal(saved.review, null); assert.equal(saved.verification, null);
  assert.equal(audit.proofType, 'failed_verification');
  assert.deepEqual(audit.originalVerification, before.verification);
  assert.equal(audit.verificationDigest, digest(before.verification));
  assert.equal(audit.originalBlocker.code, 'repair_budget');
  assert.deepEqual(saved.repairReason.actualFailure, {
    kind: 'failed_verification', verificationDigest: digest(before.verification), headSha, treeSha,
    policyDigest: before.verification.policyDigest,
    failedChecks: [{ name: 'behavior', exitCode: 1, failureTail: 'Pinned manifest assertion failed.' }]
  });
  assert.equal(saved.correctionAdmission.ceilings.implementAttempts, 2);
  assert.equal(saved.correctionAdmission.ceilings.repairs, 1);
  assert.throws(() => f.store.authorizeCorrection(f.config, correctionFor(headSha)), /already received/);
});

test('verification-based correction rejects partial, stale, wrong-policy, missing-check, and infrastructure receipts', async t => {
  const f = await fixture(t, [structuredTicket()]), headSha = 'a'.repeat(40), treeSha = 'b'.repeat(40);
  const correction = correctionFor(headSha);
  f.store.update(f.config.id, state => Object.assign(state.tickets[0], {
    status: 'blocked', attempts: 1, repairs: 0, headSha, treeSha, baseSha: 'c'.repeat(40),
    blocker: { code: 'repair_budget', message: 'Check failed.' }, review: null,
    implementation: { sessionRef: 'completed-implementation', jobId: 'implementation-job' },
    verification: failedVerificationFor(f, headSha, treeSha)
  }));
  f.store.pause(f.config.id);
  const rejectedReceipt = (verification, extra = {}) => {
    f.store.update(f.config.id, state => { Object.assign(state.tickets[0], { verification, ...extra }); });
    assert.throws(() => f.store.authorizeCorrection(f.config, correction));
  };
  rejectedReceipt(failedVerificationFor(f, headSha, treeSha, { policyDigest: 'wrong-policy' }));
  rejectedReceipt(failedVerificationFor(f, headSha, 'd'.repeat(40)));
  rejectedReceipt(failedVerificationFor(f, headSha, treeSha, { results: [] }));
  rejectedReceipt(failedVerificationFor(f, headSha, treeSha, { results: [failedCheckFor(f, { name: 'unexpected-check' })] }));
  rejectedReceipt(failedVerificationFor(f, headSha, treeSha, { results: [failedCheckFor(f, { exitCode: 0 })] }));
  rejectedReceipt(failedVerificationFor(f, headSha, treeSha, { results: [failedCheckFor(f, { exitCode: null, timedOut: true })] }));
  rejectedReceipt(failedVerificationFor(f, headSha, treeSha, { results: [failedCheckFor(f, { launchError: 'ENOENT' })] }));
  rejectedReceipt({ ...failedVerificationFor(f, headSha, treeSha), passed: true });
  rejectedReceipt(failedVerificationFor(f, headSha, treeSha), { implementation: null });
  rejectedReceipt(failedVerificationFor(f, headSha, treeSha), { recovered: true });
  rejectedReceipt(failedVerificationFor(f, headSha, treeSha), { headSha: 'e'.repeat(40) });
});

test('verification receipts normalize only the trusted node alias and preserve the configured arguments', async t => {
  const makeCandidate = async (overrides = {}) => {
    const f = await fixture(t, [structuredTicket()], ({ source, check }) => ({ services: { app: {
      source, branch: 'main', delivery: { kind: 'local' },
      checks: [{ name: 'behavior', argv: ['node', check, '--pin', 'immutable'], timeoutSeconds: 10 }]
    } } }));
    const headSha = '6'.repeat(40), treeSha = '5'.repeat(40), check = f.config.services.app.checks[0];
    const verification = {
      passed: false, headSha, treeSha, policyDigest: digest([check]),
      results: [{ name: 'behavior', argv: [process.execPath, ...check.argv.slice(1)], passed: false, exitCode: 1,
        stopped: false, timedOut: false, outputExceeded: false, launchError: null, failureTail: 'Expected failure.' }],
      ...overrides
    };
    f.store.update(f.config.id, state => Object.assign(state.tickets[0], {
      status: 'blocked', attempts: 1, headSha, treeSha, blocker: { code: 'repair_budget', message: 'Check failed.' },
      implementation: { sessionRef: 'complete', jobId: 'job' }, verification
    }));
    f.store.pause(f.config.id);
    return { f, headSha, verification };
  };
  const valid = await makeCandidate();
  assert.equal(valid.f.store.authorizeCorrection(valid.f.config, correctionFor(valid.headSha)).status, 'repairing');

  for (const argv of [
    ['C:\\untrusted\\node.exe', ...valid.verification.results[0].argv.slice(1)],
    [process.execPath, valid.f.check, '--pin', 'changed'],
    [process.execPath, valid.f.check, '--pin']
  ]) {
    const candidate = await makeCandidate();
    candidate.f.store.update(candidate.f.config.id, state => { state.tickets[0].verification.results[0].argv = argv; });
    assert.throws(() => candidate.f.store.authorizeCorrection(candidate.f.config, correctionFor(candidate.headSha)), /exact-policy application verification/);
  }
});

test('empty corrective checklist is allowed only for a full eight-item contract with failed verification proof', async t => {
  const full = structuredTicket();
  full.execution.checklist.push(...Array.from({ length: 6 }, (_, index) => ({
    id: `base-extra-${index}`, assertion: `Additional behavior ${index} holds.`,
    steps: [`Exercise additional behavior ${index}.`], evidence: `Observe additional behavior ${index}.`
  })));
  const emptyCorrection = head => ({ ...correctionFor(head), checklist: [] });
  const headA = '4'.repeat(40), treeA = '3'.repeat(40), f = await fixture(t, [full]);
  f.store.update(f.config.id, state => Object.assign(state.tickets[0], {
    status: 'blocked', attempts: 1, headSha: headA, treeSha: treeA, blocker: { code: 'repair_budget', message: 'Required check failed.' },
    implementation: { sessionRef: 'complete', jobId: 'job' }, verification: failedVerificationFor(f, headA, treeA)
  }));
  f.store.pause(f.config.id);
  const originalContract = structuredClone(f.store.get(f.config.id).tickets[0].spec.execution);
  const admitted = f.store.authorizeCorrection(f.config, emptyCorrection(headA));
  assert.equal(admitted.status, 'repairing');
  assert.deepEqual(f.store.get(f.config.id).tickets[0].spec.execution, originalContract);
  assert.deepEqual(f.store.get(f.config.id).tickets[0].correctionAdmission.checklist, []);

  const headB = '2'.repeat(40), treeB = '1'.repeat(40), reviewFixture = await fixture(t, [structuredTicket()]);
  reviewFixture.store.update(reviewFixture.config.id, state => Object.assign(state.tickets[0], {
    status: 'blocked', attempts: 1, headSha: headB, treeSha: treeB, blocker: { code: 'repair_budget', message: 'Review failed.' },
    implementation: { sessionRef: 'complete', jobId: 'job' },
    review: { headSha: headB, verdict: 'fail', summary: 'Finding.', findings: [{ priority: 'P1', file: 'feature-a.mjs', line: 1, message: 'Fix.' }], sessionRef: 'review', jobId: 'review-job' }
  }));
  reviewFixture.store.pause(reviewFixture.config.id);
  assert.throws(() => reviewFixture.store.authorizeCorrection(reviewFixture.config, emptyCorrection(headB)), /checklist must add 1/);

  const headC = '0'.repeat(40), treeC = '9'.repeat(40), shortFixture = await fixture(t, [structuredTicket()]);
  shortFixture.store.update(shortFixture.config.id, state => Object.assign(state.tickets[0], {
    status: 'blocked', attempts: 1, headSha: headC, treeSha: treeC, blocker: { code: 'repair_budget', message: 'Check failed.' },
    implementation: { sessionRef: 'complete', jobId: 'job' }, verification: failedVerificationFor(shortFixture, headC, treeC)
  }));
  shortFixture.store.pause(shortFixture.config.id);
  assert.throws(() => shortFixture.store.authorizeCorrection(shortFixture.config, emptyCorrection(headC)), /checklist must add 1/);
});

test('a saturated ten-item base may admit an exact failed review without adding duplicate criteria', async t => {
  const makeCandidate = async (t, count, { reviewHead, includeReview = true, includeImplementation = true } = {}) => {
    const spec = structuredTicket();
    spec.execution.checklist = Array.from({ length: count }, (_, index) => ({
      id: `base-${index}`, assertion: `Existing requirement ${index} holds.`,
      steps: [`Exercise existing requirement ${index}.`], evidence: `Observe existing requirement ${index}.`
    }));
    const f = await fixture(t, [spec]), headSha = 'e'.repeat(40), treeSha = 'f'.repeat(40);
    const review = includeReview ? {
      headSha: reviewHead ?? headSha, verdict: 'fail', summary: 'The exact candidate has a narrow P1 finding.',
      findings: [{ priority: 'P1', file: 'feature-a.mjs', line: 1, message: 'The corrective regression is already included in the immutable checklist.' }],
      sessionRef: 'fresh-review', jobId: 'fresh-review-job'
    } : null;
    f.store.update(f.config.id, state => Object.assign(state.tickets[0], {
      status: 'blocked', attempts: 2, repairs: 1, rebases: 3, reviewAttempts: 2,
      headSha, treeSha, baseSha: 'a'.repeat(40),
      blocker: { code: 'repair_budget', message: 'Original repair budget exhausted.' },
      review, implementation: includeImplementation ? { sessionRef: 'completed-implementation', jobId: 'implementation-job' } : null
    }));
    f.store.pause(f.config.id);
    return { f, headSha, review };
  };
  const emptyCorrection = headSha => ({ ...correctionFor(headSha), outcome: 'Correct the already specified regression.',
    instructions: 'Implement the precise reviewed fix; preserve all ten existing checklist items.', checklist: [] });

  for (const count of [8, 9]) {
    const candidate = await makeCandidate(t, count);
    assert.throws(() => candidate.f.store.authorizeCorrection(candidate.f.config, emptyCorrection(candidate.headSha)), /checklist must add 1/);
  }

  const candidate = await makeCandidate(t, 10);
  const before = candidate.f.store.get(candidate.f.config.id).tickets[0];
  const receipt = candidate.f.store.authorizeCorrection(candidate.f.config, emptyCorrection(candidate.headSha));
  const after = candidate.f.store.get(candidate.f.config.id).tickets[0], evidence = after.correctionAdmission.evidence;
  assert.equal(receipt.status, 'repairing'); assert.equal(evidence.proofType, 'failed_review');
  assert.deepEqual(after.correctionAdmission.checklist, []);
  assert.deepEqual(after.spec, before.spec);
  assert.deepEqual(evidence.originalReview, candidate.review);
  assert.equal(evidence.reviewDigest, digest(candidate.review));
  assert.deepEqual(evidence.originalBlocker, before.blocker);
  assert.deepEqual(evidence.counters, { attempts: 2, repairs: 1, rebases: 3 });
  assert.equal(after.attempts, before.attempts); assert.equal(after.repairs, before.repairs);
  assert.equal(after.rebases, before.rebases); assert.equal(after.reviewAttempts, before.reviewAttempts);
  assert.throws(() => candidate.f.store.authorizeCorrection(candidate.f.config, emptyCorrection(candidate.headSha)), /already received/);

  const stale = await makeCandidate(t, 10, { reviewHead: 'd'.repeat(40) });
  assert.throws(() => stale.f.store.authorizeCorrection(stale.f.config, emptyCorrection(stale.headSha)), /failed fresh review/);
  const partial = await makeCandidate(t, 10, { includeImplementation: false });
  assert.throws(() => partial.f.store.authorizeCorrection(partial.f.config, emptyCorrection(partial.headSha)), /completed implementation receipt/);
  const missing = await makeCandidate(t, 10, { includeReview: false });
  assert.throws(() => missing.f.store.authorizeCorrection(missing.f.config, emptyCorrection(missing.headSha)), /failed fresh review/);
});

test('one-time agent budget increase is guarded and preserves ticket authority and counters', async t => {
  const f = await fixture(t, [structuredTicket()], { limits: { maxAgentCalls: 8 } });
  f.store.update(f.config.id, state => {
    state.agentCalls = 5;
    Object.assign(state.tickets[0], { attempts: 1, repairs: 2, rebases: 1, status: 'blocked', blocker: { code: 'repair_budget', message: 'Preserve this history.' } });
  });
  const request = { expectedMaxAgentCalls: 8, newMaxAgentCalls: 16, reason: 'Allow the planned independent reviews and one bounded correction.' };
  assert.throws(() => f.store.configureAgentBudget(f.config, request), /Pause the project/);
  f.store.pause(f.config.id);
  const release = f.store.lease(`controller:${f.config.id}`);
  assert.throws(() => f.store.configureAgentBudget(f.config, request), /settle/); release();
  assert.throws(() => f.store.configureAgentBudget(f.config, { ...request, expectedMaxAgentCalls: 9 }), /does not match/);
  for (const invalid of [
    { ...request, newMaxAgentCalls: 8 }, { ...request, newMaxAgentCalls: 101 },
    { ...request, newMaxAgentCalls: 5 }, { ...request, surprise: true }, { ...request, reason: '' }
  ]) assert.throws(() => f.store.configureAgentBudget(f.config, invalid));

  const before = f.store.get(f.config.id), originalTickets = structuredClone(before.tickets);
  const result = f.store.configureAgentBudget(f.config, request);
  const after = f.store.get(f.config.id);
  assert.equal(result.newMaxAgentCalls, 16); assert.equal(result.spentAgentCalls, 5);
  assert.equal(after.config.limits.maxAgentCalls, 16); assert.equal(after.agentCalls, 5);
  assert.deepEqual(after.tickets, originalTickets);
  assert.equal(after.config.runtime.command, before.config.runtime.command);
  assert.equal(after.agentBudgetIncrease.reason, request.reason);
  assert.equal(after.agentBudgetIncrease.configDigestAfter, digest(after.config));
  assert.equal(f.store.initialize(after.config).config.limits.maxAgentCalls, 16);
  assert.throws(() => f.store.configureAgentBudget(after.config, { ...request, expectedMaxAgentCalls: 16, newMaxAgentCalls: 20 }), /one lifetime/);
  assert.equal(f.store.events(f.config.id).at(-1).type, 'project.agent_budget_increased');
});

const continuationFor = head => ({ ticketId: 'a', expectedHeadSha: head, instructions: 'Finish the interrupted startup cleanup within the existing owned paths.' });
function prepareInterruptedContinuation(f, overrides = {}) {
  const headSha = '8'.repeat(40);
  f.store.update(f.config.id, state => {
    const ticket = state.tickets[0];
    Object.assign(ticket, {
      status: 'blocked', attempts: 1, repairs: 0, rebases: 0, reviewAttempts: 1,
      workspace: path.join(f.root, 'partial-workspace'), generation: 1,
      baseSha: '1'.repeat(40), beforeAgentHead: '1'.repeat(40), headSha, treeSha: '9'.repeat(40),
      recovered: true, blocker: { code: 'repair_budget', message: 'Recovered candidate review failed.' },
      review: { headSha, verdict: 'fail', summary: 'Partial candidate misses startup cleanup.', findings: [{ priority: 'P1', file: 'main.mjs', line: 20, message: 'Dispose startup resources when shutdown interrupts startup.' }] },
      implementation: undefined,
      ...overrides
    });
  });
  return headSha;
}

test('interrupted continuation is paused, exact-head, quiescent, one-time, and preserves the logical attempt audit', async t => {
  const f = await fixture(t, [structuredTicket()]);
  const headSha = prepareInterruptedContinuation(f);
  assert.throws(() => f.store.continueInterrupted(f.config, continuationFor(headSha)), /Pause the project/);
  f.store.pause(f.config.id);
  const release = f.store.lease(`controller:${f.config.id}`);
  assert.throws(() => f.store.continueInterrupted(f.config, continuationFor(headSha)), /settle/); release();
  assert.throws(() => f.store.continueInterrupted({ ...f.config, goal: 'different policy' }, continuationFor(headSha)), /configuration/);
  assert.throws(() => f.store.continueInterrupted(f.config, continuationFor('7'.repeat(40))), /expected head/i);

  const before = f.store.get(f.config.id).tickets[0];
  const receipt = f.store.continueInterrupted(f.config, continuationFor(headSha));
  const ticketState = f.store.get(f.config.id).tickets[0];
  assert.equal(receipt.continued, true); assert.equal(receipt.status, 'continuing');
  assert.equal(ticketState.status, 'continuing'); assert.equal(ticketState.headSha, headSha);
  assert.equal(ticketState.attempts, before.attempts); assert.equal(ticketState.repairs, before.repairs);
  assert.deepEqual(ticketState.interruptedContinuation.partial.review, before.review);
  assert.deepEqual(ticketState.interruptedContinuation.partial.blocker, before.blocker);
  assert.deepEqual(ticketState.interruptedContinuation.partial.counters, { attempts: 1, repairs: 0, rebases: 0, reviewAttempts: 1 });
  assert.deepEqual(ticketState.spec, before.spec);
  assert.throws(() => f.store.continueInterrupted(f.config, continuationFor(headSha)), /already used/);
});

test('interrupted continuation rejects completed jobs, untrusted partial state, wrong blockers, and legacy tickets', async t => {
  const f = await fixture(t, [structuredTicket(), { ...structuredTicket('legacy'), execution: undefined }]);
  f.store.pause(f.config.id);
  const headSha = prepareInterruptedContinuation(f);
  f.store.update(f.config.id, state => { state.tickets[0].recovered = false; });
  assert.throws(() => f.store.continueInterrupted(f.config, continuationFor(headSha)), /recovered partial candidate/);
  f.store.update(f.config.id, state => { state.tickets[0].recovered = true; state.tickets[0].implementation = { sessionRef: 'completed-job' }; });
  assert.throws(() => f.store.continueInterrupted(f.config, continuationFor(headSha)), /recovered partial candidate/);
  f.store.update(f.config.id, state => { state.tickets[0].implementation = undefined; state.tickets[0].blocker = { code: 'review_not_fresh' }; });
  assert.throws(() => f.store.continueInterrupted(f.config, continuationFor(headSha)), /repair_budget, slice_budget/);
  f.store.update(f.config.id, state => { state.tickets[0].blocker = { code: 'repair_budget' }; state.tickets[0].headSha = null; });
  assert.throws(() => f.store.continueInterrupted(f.config, continuationFor(headSha)), /complete partial candidate identity/);
  f.store.update(f.config.id, state => { state.tickets[0].headSha = headSha; state.tickets[1].status = 'blocked'; state.tickets[1].blocker = { code: 'repair_budget' }; });
  assert.throws(() => f.store.continueInterrupted(f.config, { ...continuationFor(headSha), ticketId: 'legacy' }), /structured execution contract/);
});

const timedOutImplementationBlocker = (sandbox = 'workspace-write', overrides = {}) => ({
  code: 'runtime_failed', message: 'Codex implementation stopped at its time limit.', role: 'implement',
  detail: { receipt: { argv: ['codex', 'exec', '--sandbox', sandbox], exitCode: null, stopped: false, timedOut: true,
    outputExceeded: false, launchError: null, ...overrides } }
});
const partialRecoveryFor = ticket => ({ ticketId: ticket.spec.id, expectedWorkspace: ticket.workspace,
  expectedBaseSha: ticket.baseSha, expectedBeforeAgentHead: ticket.beforeAgentHead });
const interruptedCandidateBlocker = (workspace, overrides = {}) => ({
  code: 'runtime_failed', role: 'implement', message: 'Corrective implementation stopped at the runtime limit.',
  detail: { receipt: { argv: ['codex', 'exec', '--ignore-user-config', '--json', '--ephemeral', '-C', workspace, '--sandbox', 'workspace-write'],
    startedAt: 10, endedAt: 20, exitCode: null, stopped: false, timedOut: true, outputExceeded: false, launchError: null, ...overrides } }
});
const interruptedCandidateRequest = ticket => ({ ticketId: ticket.spec.id, expectedWorkspace: ticket.workspace,
  expectedBaseSha: ticket.baseSha, expectedBeforeAgentHead: ticket.beforeAgentHead, expectedHeadSha: ticket.headSha,
  expectedTreeSha: ticket.treeSha, expectedCorrectionAdmissionId: ticket.correctionAdmission.admissionId,
  expectedCorrectionDigest: digest(ticket.correctionAdmission), expectedBlockerDigest: digest(ticket.blocker),
  expectedProcessReceiptDigest: digest(ticket.blocker.detail.receipt) });

test('partial timeout recovery authorization is paused, quiescent, exact, implementation-only, and one-time', async t => {
  const f = await fixture(t, [structuredTicket()]), baseSha = '1'.repeat(40), workspace = path.join(f.root, 'managed', 'a-1');
  f.store.update(f.config.id, state => {
    state.agentCalls = 4;
    Object.assign(state.tickets[0], {
    status: 'blocked', attempts: 2, repairs: 2, rebases: 1, reviewAttempts: 0,
    workspace, generation: 1, baseSha, beforeAgentHead: baseSha,
    headSha: null, treeSha: null, implementation: null, mergeSha: null, publication: null,
    blocker: timedOutImplementationBlocker()
    });
  });
  const request = partialRecoveryFor(f.store.get(f.config.id).tickets[0]);
  assert.throws(() => f.store.authorizeInterruptedRecovery(f.config, request), /Pause the project/);
  f.store.pause(f.config.id);
  const release = f.store.lease(`controller:${f.config.id}`);
  assert.throws(() => f.store.authorizeInterruptedRecovery(f.config, request), /settle/); release();
  assert.throws(() => f.store.authorizeInterruptedRecovery({ ...f.config, goal: 'different policy' }, request), /configuration/);
  assert.throws(() => f.store.authorizeInterruptedRecovery(f.config, { ...request, expectedWorkspace: path.join(f.root, 'other-workspace') }), /identity/);
  assert.throws(() => f.store.authorizeInterruptedRecovery(f.config, { ...request, expectedBaseSha: '2'.repeat(40) }), /identity/);
  assert.throws(() => f.store.authorizeInterruptedRecovery(f.config, { ...request, expectedBeforeAgentHead: '3'.repeat(40) }), /identity/);

  f.store.update(f.config.id, state => { state.tickets[0].blocker = timedOutImplementationBlocker('read-only', { argv: ['codex', 'exec', '--sandbox', 'read-only'] }); });
  assert.throws(() => f.store.authorizeInterruptedRecovery(f.config, request), /implementation receipt/);
  f.store.update(f.config.id, state => { state.tickets[0].blocker = timedOutImplementationBlocker('workspace-write', { timedOut: false, stopped: false }); });
  assert.throws(() => f.store.authorizeInterruptedRecovery(f.config, request), /implementation receipt/);
  f.store.update(f.config.id, state => { state.tickets[0].blocker = timedOutImplementationBlocker(); state.tickets[0].implementation = { sessionRef: 'completed', jobId: 'completed-job' }; });
  assert.throws(() => f.store.authorizeInterruptedRecovery(f.config, request), /Completed implementation or delivered/);
  f.store.update(f.config.id, state => { state.tickets[0].implementation = null; state.tickets[0].mergeSha = '4'.repeat(40); });
  assert.throws(() => f.store.authorizeInterruptedRecovery(f.config, request), /Completed implementation or delivered/);
  f.store.update(f.config.id, state => { state.tickets[0].mergeSha = null; state.tickets[0].blocker = timedOutImplementationBlocker(); });

  const before = f.store.get(f.config.id).tickets[0], callsBefore = f.store.get(f.config.id).agentCalls;
  const authorization = f.store.authorizeInterruptedRecovery(f.config, request);
  const pending = f.store.get(f.config.id).tickets[0];
  assert.equal(authorization.authorized, true); assert.equal(pending.status, 'recovering_partial');
  assert.deepEqual(pending.partialRecovery.evidence.counters, { attempts: 2, repairs: 2, rebases: 1, reviewAttempts: 0, agentCalls: callsBefore });
  assert.deepEqual(pending.partialRecovery.evidence.blocker, before.blocker);
  assert.equal(pending.partialRecovery.evidence.processReceiptDigest, digest(before.blocker.detail.receipt));
  assert.equal(pending.attempts, before.attempts); assert.equal(pending.repairs, before.repairs);
  assert.equal(pending.rebases, before.rebases); assert.equal(f.store.get(f.config.id).agentCalls, callsBefore);
  assert.throws(() => f.store.authorizeInterruptedRecovery(f.config, request), /already has a partial implementation recovery record/);
  assert.throws(() => f.store.resume(f.config.id), /authorized partial-recovery checkpoint/);
});

test('interrupted corrective candidate verification binds exact receipt, consumed correction and preserves prior history', async t => {
  const f = await fixture(t, [structuredTicket()]), workspace = path.join(f.root, 'managed', 'a-1');
  const baseSha = '1'.repeat(40), treeSha = '2'.repeat(40), staleReview = { headSha: baseSha, verdict: 'fail', summary: 'Prior review.', findings: [] };
  const staleVerification = { passed: true, headSha: baseSha, treeSha, policyDigest: digest(f.config.services.app.checks), results: [{ name: 'prior', passed: true }] };
  const correctionAdmission = { admissionId: 'correction-one', outcome: 'Complete the one admitted repair.', instructions: 'Preserve scope.',
    checklist: [{ id: 'corrective-one', assertion: 'Boundary works.', steps: ['Run boundary check.'], evidence: 'Observed output.' }],
    ceilings: { implementAttempts: 2, repairs: 1 }, evidence: { original: 'preserve' } };
  f.store.update(f.config.id, state => {
    state.agentCalls = 8;
    Object.assign(state.tickets[0], {
      status: 'blocked', attempts: 2, repairs: 1, rebases: 1, reviewAttempts: 1, workspace, generation: 1,
      baseSha, beforeAgentHead: baseSha, headSha: baseSha, treeSha, implementation: { sessionRef: 'prior-completed-session', jobId: 'prior-completed-job' },
      implementationSessions: ['prior-completed-session', 'timed-out-correction-session'], correctionAdmission,
      interruptedContinuation: { continuationId: 'continuation-used', status: 'completed', logicalAttempt: 1 },
      partialRecovery: { recoveryId: 'partial-recovery-used', status: 'completed' },
      retryHistory: [{ at: 1, attempts: 1, repairs: 0 }], review: staleReview, verification: staleVerification,
      blocker: interruptedCandidateBlocker(workspace)
    });
  });
  const request = interruptedCandidateRequest(f.store.get(f.config.id).tickets[0]);
  assert.throws(() => f.store.authorizeInterruptedCandidateVerification(f.config, request), /Pause the project/);
  f.store.pause(f.config.id);
  const release = f.store.lease(`controller:${f.config.id}`);
  assert.throws(() => f.store.authorizeInterruptedCandidateVerification(f.config, request), /settle/); release();
  assert.throws(() => f.store.authorizeInterruptedCandidateVerification({ ...f.config, goal: 'Different policy.' }, request), /configuration/);
  for (const [field, value] of [['expectedWorkspace', path.join(f.root, 'other')], ['expectedBaseSha', '3'.repeat(40)],
    ['expectedBeforeAgentHead', '4'.repeat(40)], ['expectedHeadSha', '5'.repeat(40)], ['expectedTreeSha', '6'.repeat(40)],
    ['expectedCorrectionAdmissionId', 'stale-correction-id'],
    ['expectedCorrectionDigest', '7'.repeat(64)], ['expectedBlockerDigest', '8'.repeat(64)], ['expectedProcessReceiptDigest', '9'.repeat(64)]]) {
    assert.throws(() => f.store.authorizeInterruptedCandidateVerification(f.config, { ...request, [field]: value }), /exactly|exact|correction|receipt|identity/i, field);
  }
  f.store.update(f.config.id, state => { state.tickets[0].blocker.role = 'review'; });
  const wrongRoleRequest = interruptedCandidateRequest(f.store.get(f.config.id).tickets[0]);
  assert.throws(() => f.store.authorizeInterruptedCandidateVerification(f.config, wrongRoleRequest), /failed implementation runtime/);
  f.store.update(f.config.id, state => { state.tickets[0].blocker = interruptedCandidateBlocker(workspace, { timedOut: false, stopped: false }); });
  const nonTimeoutRequest = interruptedCandidateRequest(f.store.get(f.config.id).tickets[0]);
  assert.throws(() => f.store.authorizeInterruptedCandidateVerification(f.config, nonTimeoutRequest), /matching stopped or timed-out/);
  f.store.update(f.config.id, state => { state.tickets[0].blocker = interruptedCandidateBlocker(workspace); state.tickets[0].attempts = 1; });
  const unconsumedRequest = interruptedCandidateRequest(f.store.get(f.config.id).tickets[0]);
  assert.throws(() => f.store.authorizeInterruptedCandidateVerification(f.config, unconsumedRequest), /fully consumed/);
  f.store.update(f.config.id, state => { state.tickets[0].attempts = 2; state.tickets[0].publication = { id: 'published' }; });
  const publishedRequest = interruptedCandidateRequest(f.store.get(f.config.id).tickets[0]);
  assert.throws(() => f.store.authorizeInterruptedCandidateVerification(f.config, publishedRequest), /Merged, shipped/);
  f.store.update(f.config.id, state => { state.tickets[0].publication = null; });

  const beforeState = f.store.get(f.config.id), before = beforeState.tickets[0];
  const authorized = f.store.authorizeInterruptedCandidateVerification(f.config, request);
  const pending = f.store.get(f.config.id).tickets[0];
  assert.equal(authorized.authorized, true); assert.equal(pending.status, 'recovering_candidate');
  assert.deepEqual(pending.implementation, before.implementation); assert.deepEqual(pending.implementationSessions, before.implementationSessions);
  assert.deepEqual(pending.interruptedContinuation, before.interruptedContinuation); assert.deepEqual(pending.partialRecovery, before.partialRecovery);
  assert.deepEqual(pending.retryHistory, before.retryHistory); assert.equal(pending.attempts, before.attempts); assert.equal(pending.repairs, before.repairs);
  assert.equal(pending.rebases, before.rebases); assert.equal(pending.reviewAttempts, before.reviewAttempts); assert.equal(f.store.get(f.config.id).agentCalls, beforeState.agentCalls);
  assert.throws(() => f.store.authorizeInterruptedCandidateVerification(f.config, request), /already used/);

  const newHead = 'a'.repeat(40), newTree = 'b'.repeat(40), beforeIdentity = { headSha: baseSha, treeSha, dirty: ' M feature-a.mjs' };
  assert.throws(() => f.store.completeInterruptedCandidateVerification(f.config.id, 'a', authorized.recoveryId,
    { headSha: newHead, treeSha: newTree, files: ['feature-a.mjs'] }, { ...beforeIdentity, treeSha: 'c'.repeat(40) }), /identity changed/);
  f.store.completeInterruptedCandidateVerification(f.config.id, 'a', authorized.recoveryId,
    { headSha: newHead, treeSha: newTree, files: ['feature-a.mjs'] }, beforeIdentity);
  const completed = f.store.get(f.config.id).tickets[0];
  assert.equal(completed.status, 'verifying'); assert.equal(completed.blocker, null); assert.equal(completed.headSha, newHead); assert.equal(completed.treeSha, newTree);
  assert.equal(completed.review, null); assert.equal(completed.verification, null);
  assert.deepEqual(completed.implementation, before.implementation); assert.deepEqual(completed.implementationSessions, before.implementationSessions);
  assert.deepEqual(completed.interruptedContinuation, before.interruptedContinuation); assert.deepEqual(completed.partialRecovery, before.partialRecovery);
  assert.deepEqual(completed.interruptedCandidateVerification.evidence.review, staleReview);
  assert.deepEqual(completed.interruptedCandidateVerification.evidence.verification, staleVerification);
  assert.deepEqual(completed.interruptedCandidateVerification.evidence.spec, before.spec);
  assert.deepEqual(completed.interruptedCandidateVerification.evidence.correctionAdmission, before.correctionAdmission);
  assert.deepEqual(completed.interruptedCandidateVerification.evidence.retryHistory, before.retryHistory);
  assert.deepEqual(completed.interruptedCandidateVerification.evidence.blocker, before.blocker);
  assert.equal(completed.attempts, before.attempts); assert.equal(completed.repairs, before.repairs); assert.equal(completed.rebases, before.rebases);
  assert.equal(f.store.get(f.config.id).agentCalls, beforeState.agentCalls);
});

async function correctiveFulfillmentFixture(t) {
  const f = await fixture(t, [structuredTicket(), { id: 'b', service: 'app', title: 'Dependent', description: 'Wait for a.', acceptance: ['Works.'], dependsOn: ['a'] }]);
  const targetHead = 'b'.repeat(40), targetCorrection = correctionFor(targetHead).checklist;
  const sourceSpec = structuredTicket('successor');
  sourceSpec.execution.checklist = [
    ...structuredClone(sourceSpec.execution.checklist),
    ...structuredClone(targetCorrection),
    { id: 'successor-extra', assertion: 'The successor boundary remains stable.', steps: ['Run the successor regression.'], evidence: 'Observed expected output.' }
  ];
  const sourceConfig = validateConfig({ ...structuredClone(f.config), id: 'successor-project', stateDir: path.join(f.root, 'successor-state'), tickets: [sourceSpec] });
  f.store.initialize(sourceConfig);
  const sourceHead = '1'.repeat(40), mergeSha = '2'.repeat(40), treeSha = '3'.repeat(40);
  const sourceCriteria = sourceSpec.execution.checklist;
  const review = { headSha: sourceHead, verdict: 'pass', summary: 'All required criteria passed.', findings: [],
    checklist: sourceCriteria.map(item => ({ id: item.id, verdict: 'pass', evidence: `Observed ${item.id} in the successor candidate.` })),
    sessionRef: 'successor-fresh-review', jobId: 'successor-review-job' };
  const verificationResults = [{ name: 'behavior', passed: true }], postmergeResults = [{ name: 'behavior', passed: true }];
  const verification = { passed: true, headSha: sourceHead, treeSha, policyDigest: digest(sourceConfig.services.app.checks), results: verificationResults };
  const postmerge = { passed: true, headSha: mergeSha, treeSha, results: postmergeResults };
  const checklistEvidence = { headSha: mergeSha, reviewedHeadSha: sourceHead, contractDigest: digest(sourceSpec.execution), items: review.checklist,
    verification: verificationResults, postmerge: postmergeResults };
  const sourceBefore = f.store.update(sourceConfig.id, state => {
    state.status = 'running';
    Object.assign(state.tickets[0], { status: 'shipped', attempts: 2, repairs: 1, rebases: 0, headSha: sourceHead, mergeSha, treeSha, baseSha: '4'.repeat(40),
      workspace: path.join(f.root, 'successor-workspace'), branch: 'squire/successor', generation: 2, reviewAttempts: 1,
      review, verification, postmerge, checklistEvidence, implementation: { sessionRef: 'successor-implementation', jobId: 'successor-implementation-job' },
      implementationSessions: ['successor-implementation'], shippedAt: 42 });
  }).tickets[0];
  const failedReview = { headSha: targetHead, verdict: 'fail', summary: 'Original candidate missed the edge case.', findings: [{ priority: 'P1', file: 'feature-a.mjs', line: 1, message: 'Handle the reviewed edge case.' }], sessionRef: 'original-review', jobId: 'original-review-job' };
  f.store.update(f.config.id, state => {
    state.status = 'blocked'; state.blocker = { code: 'project_blocked' };
    Object.assign(state.tickets[0], { status: 'blocked', attempts: 5, repairs: 3, rebases: 2, headSha: targetHead, treeSha: '5'.repeat(40), baseSha: '6'.repeat(40),
      blocker: { code: 'slice_budget', message: 'Original budget blocker' }, review: failedReview, verification: { passed: false, results: [{ name: 'behavior', passed: false }] },
      correctionAdmission: { admissionId: 'original-correction', checklist: structuredClone(targetCorrection) } });
    state.tickets[1].status = 'dependency_blocked'; state.tickets[1].blocker = { code: 'dependency' };
  });
  f.store.pause(f.config.id);
  return { ...f, sourceConfig, sourceBefore: structuredClone(sourceBefore), targetHead, sourceHead, mergeSha, treeSha, failedReview, review, verification, postmerge, checklistEvidence };
}
const fulfillmentFor = f => ({ ticketId: 'a', sourceProjectId: 'successor-project', sourceTicketId: 'successor', expectedHeadSha: f.targetHead });

test('adopts only a same-authority shipped successor and preserves original target history and counters', async t => {
  const f = await correctiveFulfillmentFixture(t), targetSpec = structuredClone(f.store.get(f.config.id).tickets[0].spec);
  const sourceProjectBefore = f.store.get(f.sourceConfig.id), targetStateBefore = f.store.get(f.config.id);
  const receipt = f.store.adoptCorrectiveDelivery(f.config, fulfillmentFor(f));
  const targetState = f.store.get(f.config.id), target = targetState.tickets[0];
  assert.equal(receipt.adopted, true); assert.equal(receipt.headSha, f.sourceHead); assert.equal(receipt.mergeSha, f.mergeSha);
  assert.equal(target.status, 'shipped'); assert.equal(target.shippedAt, receipt.adoptedAt);
  assert.deepEqual(target.spec, targetSpec); assert.equal(target.headSha, f.sourceHead); assert.equal(target.mergeSha, f.mergeSha); assert.equal(target.treeSha, f.treeSha);
  assert.equal(target.workspace, f.store.get(f.sourceConfig.id).tickets[0].workspace); assert.equal(target.branch, 'squire/successor'); assert.equal(target.generation, 2);
  assert.deepEqual(target.implementation, { sessionRef: 'successor-implementation', jobId: 'successor-implementation-job' });
  assert.equal(target.attempts, 5); assert.equal(target.repairs, 3); assert.equal(target.rebases, 2);
  assert.deepEqual(target.review, f.review); assert.deepEqual(target.verification, f.verification); assert.deepEqual(target.postmerge, f.postmerge);
  assert.deepEqual(target.checklistEvidence, f.checklistEvidence);
  assert.equal(target.correctiveFulfillment.target.specDigest, digest(targetSpec));
  assert.deepEqual(target.correctiveFulfillment.target.review, f.failedReview);
  assert.deepEqual(target.correctiveFulfillment.target.blocker, targetStateBefore.tickets[0].blocker);
  assert.equal(target.correctiveFulfillment.target.counters.attempts, 5);
  assert.equal(target.correctiveFulfillment.source.reviewDigest, digest(f.review));
  assert.equal(target.correctiveFulfillment.source.postmergeDigest, digest(f.postmerge));
  assert.deepEqual(target.correctiveFulfillment.source.counters, { attempts: 2, repairs: 1, rebases: 0, reviewAttempts: 1 });
  assert.equal(target.correctiveFulfillment.source.workspace, path.join(f.root, 'successor-workspace'));
  assert.ok(target.correctiveFulfillment.receiptDigest);
  assert.equal(targetState.paused, true); assert.equal(targetState.status, targetStateBefore.status); assert.deepEqual(targetState.blocker, targetStateBefore.blocker);
  assert.equal(targetState.tickets[1].status, 'queued');
  assert.deepEqual(f.store.get(f.sourceConfig.id), sourceProjectBefore);
  assert.throws(() => f.store.adoptCorrectiveDelivery(f.config, fulfillmentFor(f)), /already has a lifetime/);

  const otherConfig = validateConfig({ ...structuredClone(f.config), id: 'second-target', stateDir: path.join(f.root, 'second-target-state'), tickets: [structuredTicket()] });
  f.store.initialize(otherConfig); f.store.pause(otherConfig.id);
  f.store.update(otherConfig.id, state => { Object.assign(state.tickets[0], { status: 'blocked', headSha: f.targetHead, blocker: { code: 'repair_budget' } }); });
  assert.throws(() => f.store.adoptCorrectiveDelivery(otherConfig, fulfillmentFor({ ...f, config: otherConfig })), /already fulfills another target/);
});

test('adoption rejects wrong target head, altered authority, missing criteria, and stale source receipts', async t => {
  const f = await correctiveFulfillmentFixture(t), input = fulfillmentFor(f);
  assert.throws(() => f.store.adoptCorrectiveDelivery(f.config, { ...input, unexpected: true }), /Unknown fulfillment field/);
  assert.throws(() => f.store.adoptCorrectiveDelivery(f.config, { ...input, expectedHeadSha: 'a'.repeat(40) }), /expectedHeadSha/);
  assert.throws(() => f.store.adoptCorrectiveDelivery({ ...f.config, goal: 'changed policy' }, input), /configuration/);

  const oldSourceConfig = f.store.get(f.sourceConfig.id).config;
  f.store.pause(f.sourceConfig.id);
  const changedRuntime = { ...oldSourceConfig.runtime, roles: { implement: { model: 'luna', reasoning: 'high' } } };
  f.store.configureRuntime(oldSourceConfig, changedRuntime);
  assert.throws(() => f.store.adoptCorrectiveDelivery(f.config, input), /runtime authority differs/);
  f.store.configureRuntime(f.store.get(f.sourceConfig.id).config, f.config.runtime);

  f.store.update(f.sourceConfig.id, state => { state.tickets[0].spec.execution.checklist.find(item => item.id === 'base-one').assertion = 'Changed assertion'; });
  assert.throws(() => f.store.adoptCorrectiveDelivery(f.config, input), /does not preserve target criterion base-one/);
  f.store.update(f.sourceConfig.id, state => { state.tickets[0].spec.execution.checklist.find(item => item.id === 'base-one').assertion = 'Basic behavior works.'; });
  f.store.update(f.sourceConfig.id, state => { state.tickets[0].verification.headSha = 'e'.repeat(40); });
  assert.throws(() => f.store.adoptCorrectiveDelivery(f.config, input), /verification and postmerge receipts/);
});


test('corrective adoption refuses a shipped source with an unclosed producer across reopen', async t => {
 const f=await correctiveFulfillmentFixture(t);
 const release=f.store.lease(`controller:${f.sourceConfig.id}`);
 const scopeId=f.store.beginProducer(f.sourceConfig.id,'ticket:successor',release);release();
 const before=f.store.get(f.config.id),source=f.store.get(f.sourceConfig.id);
 for(let i=0;i<2;i++) {
  const reopened=new Store(f.stateDir);
  try {
   assert.throws(()=>reopened.adoptCorrectiveDelivery(f.config,fulfillmentFor(f)),{code:'producer_unresolved'});
   assert.deepEqual(reopened.get(f.config.id),before);assert.deepEqual(reopened.get(f.sourceConfig.id),source);
   assert.equal(reopened.db.prepare('SELECT closed_at FROM producer_scopes WHERE id=?').get(scopeId).closed_at,null);
  } finally {reopened.close();}
 }
});
