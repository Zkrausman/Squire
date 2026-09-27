import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDualRetroFixture } from '../dual-retro-gate.mjs';

const sha = char => char.repeat(40);
const digest = char => char.repeat(64);
const projects = {
  squire: { repository: 'Zkrausman/Squire', branch: 'main', declared: true,
    instructionsDeclared: true, testsAndCiDeclared: true, isolatedEvidence: true,
    approvedWikiRoot: '.llm-wiki/wiki/' },
  target: { repository: 'Zkrausman/Gelt', branch: 'master', declared: true,
    instructionsDeclared: true, testsAndCiDeclared: true, isolatedEvidence: true,
    approvedWikiRoot: '.llm-wiki/wiki/' },
};

function review(repository, headSha, diffSha256, proposerId, reviewerId) {
  return { source: 'independent_reviewer', status: 'approved', independent: true,
    reviewerId, repository, headSha, diffSha256 };
}
function ci(repository, headSha, diffSha256, runId) {
  return { source: 'hosted_ci', status: 'passed', repository, headSha, diffSha256,
    workflow: 'wiki-ci', runId };
}
function sourceEvidence(project, mergeChar, baseChar, diffChar) {
  const repository = projects[project].repository;
  const mergeSha = sha(mergeChar), headSha = sha(project === 'squire' ? '7' : '8');
  const treeSha = sha(project === 'squire' ? '9' : 'a');
  const diffSha256 = digest(diffChar);
  const proposerId = `implementer-${project}`;
  const hostedCi = ci(repository, headSha, diffSha256, `source-ci-${project}`);
  return {
    project,
    mergeReceipt: { source: 'verified_merge_receipt', status: 'verified', repository,
      targetBranch: projects[project].branch, sha: mergeSha, sourceHeadSha: headSha, treeSha,
      receiptId: `merge-${project}` },
    reviewedDiff: { repository, baseSha: sha(baseChar), headSha, treeSha, diffSha256, proposerId,
      review: review(repository, headSha, diffSha256, proposerId, `reviewer-${project}`) },
    hostedCi,
    runReceipt: { source: 'squire_run_receipt', status: 'success', repository, headSha,
      diffSha256, hostedCiRunId: hostedCi.runId, receiptId: `run-${project}` },
  };
}
function prScope(project, baseChar, headChar, diffChar) {
  const repository = projects[project].repository;
  const headSha = sha(headChar);
  const diffSha256 = digest(diffChar);
  const proposerId = `wiki-implementer-${project}`;
  const path = project === 'squire' ? '.llm-wiki/wiki/squire-workflow.md' : '.llm-wiki/wiki/target-product.md';
  return { project, repository, baseBranch: projects[project].branch, baseSha: sha(baseChar), headSha, diffSha256,
    contentSha256: digest(project === 'squire' ? 'e' : 'f'), proposerId, paths: [path],
    review: review(repository, headSha, diffSha256, proposerId, `wiki-reviewer-${project}`),
    hostedCi: ci(repository, headSha, diffSha256, `wiki-ci-${project}`) };
}
function fixture() {
  const mergeEvidence = [sourceEvidence('squire', '1', '0', 'a'), sourceEvidence('target', '2', '0', 'b')];
  const changes = [
    { project: 'squire', lesson: 'squire_workflow', path: '.llm-wiki/wiki/squire-workflow.md',
      sourceMergeSha: sha('1'), sourceDiffSha256: digest('a'), contentSha256: digest('e') },
    { project: 'target', lesson: 'target_product', path: '.llm-wiki/wiki/target-product.md',
      sourceMergeSha: sha('2'), sourceDiffSha256: digest('b'), contentSha256: digest('f') },
  ];
  const prScopes = [prScope('squire', '3', '4', 'c'), prScope('target', '5', '6', 'd')];
  const freshRefChecks = prScopes.map(scope => ({ project: scope.project, repository: scope.repository,
    branch: scope.baseBranch, baseSha: scope.baseSha, headSha: scope.headSha,
    source: 'synthetic_ref_check', checkedAtMs: 1_990 }));
  return {
    schemaVersion: 1,
    evidenceClass: 'synthetic_fixture',
    fixtureId: 'dual-retro-sanitized-v1',
    decisionTimeMs: 2_000,
    repositories: structuredClone(projects),
    mergeEvidence,
    changes,
    prScopes,
    freshRefChecks,
    ticketDisposition: { action: 'refine_existing', reason: 'An existing scoped ticket covers this lesson.',
      existingCandidates: [{ ticketId: 'SQUIRE-12', relevant: true }], selectedTicketId: 'SQUIRE-12' },
  };
}

test('allows only a fully matched synthetic dual-retro and two separate wiki-only merge simulations', () => {
  const result = evaluateDualRetroFixture(fixture());
  assert.equal(result.decision, 'allow');
  assert.equal(result.mode, 'synthetic_fixture_only');
  assert.equal(result.simulatedMerges.length, 2);
  assert.deepEqual(result.simulatedMerges.map(item => [item.project, item.repository, item.paths[0]]), [
    ['squire', 'Zkrausman/Squire', '.llm-wiki/wiki/squire-workflow.md'],
    ['target', 'Zkrausman/Gelt', '.llm-wiki/wiki/target-product.md'],
  ]);
  assert.deepEqual(result.ticketDisposition, { action: 'refine_existing', ticketId: 'SQUIRE-12' });
  assert.match(result.notice, /no repository, ticket, or merge action was performed/);
});

test('does not treat non-fixture inputs or model opinions as receipts', () => {
  const missingMarker = fixture();
  missingMarker.evidenceClass = 'host_claimed';
  assert.deepEqual(evaluateDualRetroFixture(missingMarker), { decision: 'stop', reason: 'SYNTHETIC_FIXTURE_REQUIRED' });

  const modelReview = fixture();
  modelReview.mergeEvidence[0].reviewedDiff.review.source = 'model_opinion';
  assert.equal(evaluateDualRetroFixture(modelReview).reason, 'REVIEWED_DIFF_MISSING_OR_MISMATCHED');
});

test('stops on missing, contradictory, or mismatched merge, diff, CI, and run receipts', () => {
  const missing = fixture();
  missing.mergeEvidence[0].mergeReceipt = null;
  assert.equal(evaluateDualRetroFixture(missing).reason, 'MERGE_RECEIPT_MISSING_OR_MISMATCHED');

  const contradictory = fixture();
  contradictory.mergeEvidence[0].mergeReceipt.sha = sha('9');
  assert.equal(evaluateDualRetroFixture(contradictory).reason, 'WIKI_EVIDENCE_ROUTE_MISMATCH');

  const ciMismatch = fixture();
  ciMismatch.mergeEvidence[0].hostedCi.headSha = sha('9');
  assert.equal(evaluateDualRetroFixture(ciMismatch).reason, 'HOSTED_CI_MISSING_OR_MISMATCHED');

  const runMismatch = fixture();
  runMismatch.mergeEvidence[1].runReceipt.hostedCiRunId = 'different-run';
  assert.equal(evaluateDualRetroFixture(runMismatch).reason, 'RUN_RECEIPT_MISSING_OR_MISMATCHED');

  const changedRunHead = fixture();
  changedRunHead.mergeEvidence[1].runReceipt.headSha = sha('b');
  assert.equal(evaluateDualRetroFixture(changedRunHead).reason, 'RUN_RECEIPT_MISSING_OR_MISMATCHED');

  const mergeTreeMismatch = fixture();
  mergeTreeMismatch.mergeEvidence[0].mergeReceipt.treeSha = sha('b');
  assert.equal(evaluateDualRetroFixture(mergeTreeMismatch).reason, 'REVIEWED_DIFF_MISSING_OR_MISMATCHED');

  const sourceHeadMismatch = fixture();
  sourceHeadMismatch.mergeEvidence[1].mergeReceipt.sourceHeadSha = sha('b');
  assert.equal(evaluateDualRetroFixture(sourceHeadMismatch).reason, 'REVIEWED_DIFF_MISSING_OR_MISMATCHED');

  const reroutedEvidence = fixture();
  reroutedEvidence.changes[0].sourceMergeSha = sha('9');
  assert.equal(evaluateDualRetroFixture(reroutedEvidence).reason, 'WIKI_EVIDENCE_ROUTE_MISMATCH');
});

test('routes each lesson to its own repository and constrains both proposed PR scopes', () => {
  const crossedLesson = fixture();
  crossedLesson.changes[0].lesson = 'target_product';
  assert.equal(evaluateDualRetroFixture(crossedLesson).reason, 'WIKI_PATH_NOT_ALLOWED');

  const crossedRepository = fixture();
  crossedRepository.prScopes[1].repository = 'Zkrausman/Squire';
  assert.equal(evaluateDualRetroFixture(crossedRepository).reason, 'PR_SCOPE_INVALID');

  const extraPath = fixture();
  extraPath.prScopes[0].paths.push('src/index.mjs');
  assert.equal(evaluateDualRetroFixture(extraPath).reason, 'PR_SCOPE_INVALID');

  const changedContent = fixture();
  changedContent.changes[0].contentSha256 = digest('0');
  assert.equal(evaluateDualRetroFixture(changedContent).reason, 'PR_SCOPE_INVALID');

  const changedPrContent = fixture();
  changedPrContent.prScopes[1].contentSha256 = digest('0');
  assert.equal(evaluateDualRetroFixture(changedPrContent).reason, 'PR_SCOPE_INVALID');

  const missingPrContent = fixture();
  delete missingPrContent.prScopes[0].contentSha256;
  assert.equal(evaluateDualRetroFixture(missingPrContent).reason, 'PR_SCOPE_INVALID');
});

test('rejects source edits, raw/private paths, traversal, and non-Markdown changes', () => {
  for (const path of [
    'src/index.mjs',
    '.llm-wiki/raw/private.md',
    '.llm-wiki/wiki/meta/notes.md',
    '.llm-wiki/wiki/private/notes.md',
    '.llm-wiki/wiki/../notes.md',
    '.llm-wiki/wiki/source.json',
  ]) {
    const invalid = fixture();
    invalid.changes[0].path = path;
    assert.equal(evaluateDualRetroFixture(invalid).reason, 'WIKI_PATH_NOT_ALLOWED', path);
  }
});

test('requires independent review and hosted CI for each proposed PR at its exact head and diff', () => {
  const missingReview = fixture();
  missingReview.prScopes[0].review.independent = false;
  assert.equal(evaluateDualRetroFixture(missingReview).reason, 'PR_REVIEW_MISSING_OR_MISMATCHED');

  const modelReviewer = fixture();
  modelReviewer.prScopes[0].review.reviewerId = 'model-luna';
  assert.equal(evaluateDualRetroFixture(modelReviewer).reason, 'PR_REVIEW_MISSING_OR_MISMATCHED');

  const ciMismatch = fixture();
  ciMismatch.prScopes[1].hostedCi.diffSha256 = digest('0');
  assert.equal(evaluateDualRetroFixture(ciMismatch).reason, 'PR_HOSTED_CI_MISSING_OR_MISMATCHED');
});

test('rechecks exact base and head immediately before the fixture-only merge decision', () => {
  const changedHead = fixture();
  changedHead.freshRefChecks[0].headSha = sha('8');
  assert.equal(evaluateDualRetroFixture(changedHead).reason, 'FRESH_HEAD_MISMATCH');

  const changedBase = fixture();
  changedBase.freshRefChecks[1].baseSha = sha('8');
  assert.equal(evaluateDualRetroFixture(changedBase).reason, 'FRESH_BASE_MISMATCH');

  const stale = fixture();
  stale.decisionTimeMs = 31_000;
  stale.freshRefChecks[0].checkedAtMs = 1;
  assert.equal(evaluateDualRetroFixture(stale).reason, 'FRESH_REF_CHECK_STALE');
});

test('prefers a relevant existing ticket and permits a reasoned no-ticket outcome', () => {
  const duplicate = fixture();
  duplicate.ticketDisposition.action = 'create_new';
  duplicate.ticketDisposition.selectedTicketId = null;
  assert.equal(evaluateDualRetroFixture(duplicate).reason, 'TICKET_DISPOSITION_INVALID');

  const noTicket = fixture();
  noTicket.ticketDisposition = { action: 'no_ticket_warranted',
    reason: 'The lesson is already documented and needs no follow-up.', existingCandidates: [], selectedTicketId: null };
  const result = evaluateDualRetroFixture(noTicket);
  assert.equal(result.decision, 'allow');
  assert.deepEqual(result.ticketDisposition, { action: 'no_ticket_warranted', ticketId: null });

  noTicket.ticketDisposition.existingCandidates = [{ ticketId: 'GELT-7', relevant: true }];
  assert.equal(evaluateDualRetroFixture(noTicket).reason, 'TICKET_DISPOSITION_INVALID');
});

test('rejects extra unbounded content fields rather than carrying ticket or private material through', () => {
  const withBody = fixture();
  withBody.changes[0].rawContent = 'not allowed in fixture output';
  assert.equal(evaluateDualRetroFixture(withBody).reason, 'WIKI_CHANGE_SCOPE_INVALID');
});
