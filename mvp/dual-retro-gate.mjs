/**
 * Offline-only shape gate for sanitized synthetic dual-retro fixtures.
 * This module performs no I/O and is not connected to Squire runtime authority.
 */
const PROJECTS = Object.freeze({
  squire: 'Zkrausman/Squire',
  target: 'Zkrausman/Gelt',
});
const WIKI_ROOT = '.llm-wiki/wiki/';
const MAX_REF_AGE_MS = 30_000;
const SHA_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;

const stop = reason => ({ decision: 'stop', reason });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function exactKeys(value, keys) {
  return object(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}
function boundedText(value, max = 160) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
function isSha(value) { return typeof value === 'string' && SHA_RE.test(value); }
function isDigest(value) { return typeof value === 'string' && DIGEST_RE.test(value); }
function isReceiptId(value) { return boundedText(value, 128) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value); }
function isReviewer(value, proposer) {
  return boundedText(value, 100) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
    && value !== proposer && !/(?:^|[-_.])(model|assistant|luna|pi)(?:$|[-_.])/i.test(value);
}
function isSafeWikiPath(value, approvedRoot) {
  if (approvedRoot !== WIKI_ROOT || !boundedText(value, 240) || value.includes('\\')
    || value.startsWith('/') || value.startsWith('./')) return false;
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return false;
  if (!value.startsWith(WIKI_ROOT) || parts.length < 3 || !value.endsWith('.md')) return false;
  if (parts.some(part => /raw|private|secret|credential/i.test(part)
    || /^(meta|logs?|tickets?|sessions?|evidence)$/i.test(part))) return false;
  return parts.slice(2).every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part));
}
function validReview(review, { repository, headSha, diffSha256, proposerId }) {
  return exactKeys(review, ['source', 'status', 'independent', 'reviewerId', 'repository', 'headSha', 'diffSha256'])
    && review.source === 'independent_reviewer' && review.status === 'approved' && review.independent === true
    && isReviewer(review.reviewerId, proposerId) && review.repository === repository
    && review.headSha === headSha && review.diffSha256 === diffSha256;
}
function validHostedCi(ci, { repository, headSha, diffSha256 }) {
  return exactKeys(ci, ['source', 'status', 'repository', 'headSha', 'diffSha256', 'workflow', 'runId'])
    && ci.source === 'hosted_ci' && ci.status === 'passed' && ci.repository === repository
    && ci.headSha === headSha && ci.diffSha256 === diffSha256
    && boundedText(ci.workflow, 100) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(ci.workflow)
    && isReceiptId(ci.runId);
}
function validateTicketDecision(value) {
  if (!exactKeys(value, ['action', 'reason', 'existingCandidates', 'selectedTicketId'])
    || !['refine_existing', 'create_new', 'no_ticket_warranted'].includes(value.action)
    || !boundedText(value.reason, 500) || value.reason.length < 16
    || !Array.isArray(value.existingCandidates) || value.existingCandidates.length > 10) {
    return false;
  }
  const candidates = new Map();
  for (const candidate of value.existingCandidates) {
    if (!exactKeys(candidate, ['ticketId', 'relevant'])
      || !/^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,8}$/.test(candidate.ticketId)
      || typeof candidate.relevant !== 'boolean' || candidates.has(candidate.ticketId)) return false;
    candidates.set(candidate.ticketId, candidate.relevant);
  }
  const hasRelevant = [...candidates.values()].some(Boolean);
  if (value.action === 'refine_existing') {
    return typeof value.selectedTicketId === 'string' && candidates.get(value.selectedTicketId) === true;
  }
  return value.selectedTicketId === null && !hasRelevant;
}

function evaluate(input) {
  const topKeys = ['schemaVersion', 'evidenceClass', 'fixtureId', 'decisionTimeMs', 'repositories',
    'mergeEvidence', 'changes', 'prScopes', 'freshRefChecks', 'ticketDisposition'];
  if (!exactKeys(input, topKeys) || input.schemaVersion !== 1) return stop('SCHEMA_INVALID');
  if (input.evidenceClass !== 'synthetic_fixture' || !boundedText(input.fixtureId, 64)
    || !/^[a-z0-9][a-z0-9._-]*$/.test(input.fixtureId)) return stop('SYNTHETIC_FIXTURE_REQUIRED');
  if (!Number.isSafeInteger(input.decisionTimeMs) || input.decisionTimeMs < 1) return stop('DECISION_TIME_INVALID');

  if (!exactKeys(input.repositories, ['squire', 'target'])) return stop('PROJECT_DECLARATION_INVALID');
  for (const project of ['squire', 'target']) {
    const repo = input.repositories[project];
    if (!exactKeys(repo, ['repository', 'branch', 'declared', 'instructionsDeclared', 'testsAndCiDeclared', 'isolatedEvidence', 'approvedWikiRoot'])
      || repo.repository !== PROJECTS[project] || repo.branch !== (project === 'squire' ? 'main' : 'master') || repo.declared !== true
      || repo.instructionsDeclared !== true || repo.testsAndCiDeclared !== true || repo.isolatedEvidence !== true
      || repo.approvedWikiRoot !== WIKI_ROOT) return stop('PROJECT_DECLARATION_INVALID');
  }

  if (!Array.isArray(input.mergeEvidence) || input.mergeEvidence.length !== 2) return stop('MERGE_EVIDENCE_MISSING');
  const evidence = new Map();
  for (const item of input.mergeEvidence) {
    if (!exactKeys(item, ['project', 'mergeReceipt', 'reviewedDiff', 'hostedCi', 'runReceipt'])
      || !['squire', 'target'].includes(item.project) || evidence.has(item.project)) return stop('MERGE_EVIDENCE_CONTRADICTORY');
    const repository = PROJECTS[item.project];
    const merge = item.mergeReceipt;
    if (!exactKeys(merge, ['source', 'status', 'repository', 'targetBranch', 'sha', 'sourceHeadSha', 'treeSha', 'receiptId'])
      || merge.source !== 'verified_merge_receipt' || merge.status !== 'verified'
      || merge.repository !== repository || merge.targetBranch !== input.repositories[item.project].branch
      || !isSha(merge.sha) || !isSha(merge.sourceHeadSha) || merge.sourceHeadSha === merge.sha
      || !isSha(merge.treeSha) || !isReceiptId(merge.receiptId)) return stop('MERGE_RECEIPT_MISSING_OR_MISMATCHED');

    const diff = item.reviewedDiff;
    if (!exactKeys(diff, ['repository', 'baseSha', 'headSha', 'treeSha', 'diffSha256', 'proposerId', 'review'])
      || diff.repository !== repository || !isSha(diff.baseSha) || diff.baseSha === diff.headSha
      || diff.headSha !== merge.sourceHeadSha || diff.treeSha !== merge.treeSha
      || !isDigest(diff.diffSha256) || !boundedText(diff.proposerId, 100)
      || !validReview(diff.review, { repository, headSha: diff.headSha, diffSha256: diff.diffSha256, proposerId: diff.proposerId })) {
      return stop('REVIEWED_DIFF_MISSING_OR_MISMATCHED');
    }
    if (!validHostedCi(item.hostedCi, { repository, headSha: diff.headSha, diffSha256: diff.diffSha256 })) {
      return stop('HOSTED_CI_MISSING_OR_MISMATCHED');
    }
    const run = item.runReceipt;
    if (!exactKeys(run, ['source', 'status', 'repository', 'headSha', 'diffSha256', 'hostedCiRunId', 'receiptId'])
      || run.source !== 'squire_run_receipt' || run.status !== 'success' || run.repository !== repository
      || run.headSha !== diff.headSha || run.diffSha256 !== diff.diffSha256
      || run.hostedCiRunId !== item.hostedCi.runId || !isReceiptId(run.receiptId)) {
      return stop('RUN_RECEIPT_MISSING_OR_MISMATCHED');
    }
    evidence.set(item.project, item);
  }
  if (!evidence.has('squire') || !evidence.has('target')) return stop('MERGE_EVIDENCE_MISSING');

  if (!Array.isArray(input.changes) || input.changes.length !== 2) return stop('WIKI_CHANGE_SCOPE_INVALID');
  const changes = new Map();
  for (const change of input.changes) {
    if (!exactKeys(change, ['project', 'lesson', 'path', 'sourceMergeSha', 'sourceDiffSha256', 'contentSha256'])
      || !['squire', 'target'].includes(change.project) || changes.has(change.project)) return stop('WIKI_CHANGE_SCOPE_INVALID');
    const expectedLesson = change.project === 'squire' ? 'squire_workflow' : 'target_product';
    const proof = evidence.get(change.project);
    if (change.lesson !== expectedLesson || !isSafeWikiPath(change.path, input.repositories[change.project].approvedWikiRoot)) {
      return stop('WIKI_PATH_NOT_ALLOWED');
    }
    if (change.sourceMergeSha !== proof.mergeReceipt.sha || change.sourceDiffSha256 !== proof.reviewedDiff.diffSha256
      || !isDigest(change.contentSha256)) return stop('WIKI_EVIDENCE_ROUTE_MISMATCH');
    changes.set(change.project, change);
  }
  if (!changes.has('squire') || !changes.has('target')) return stop('WIKI_CHANGE_SCOPE_INVALID');

  if (!Array.isArray(input.prScopes) || input.prScopes.length !== 2) return stop('PR_SCOPE_INVALID');
  const scopes = new Map();
  for (const scope of input.prScopes) {
    if (!exactKeys(scope, ['project', 'repository', 'baseBranch', 'baseSha', 'headSha', 'diffSha256',
      'contentSha256', 'proposerId', 'paths', 'review', 'hostedCi']) || !['squire', 'target'].includes(scope.project)
      || scopes.has(scope.project)) return stop('PR_SCOPE_INVALID');
    const project = scope.project;
    const repository = PROJECTS[project];
    const change = changes.get(project);
    if (scope.repository !== repository || scope.baseBranch !== input.repositories[project].branch
      || !isSha(scope.baseSha) || !isSha(scope.headSha) || scope.baseSha === scope.headSha
      || !isDigest(scope.diffSha256) || !isDigest(scope.contentSha256)
      || scope.contentSha256 !== change.contentSha256 || !boundedText(scope.proposerId, 100)
      || !Array.isArray(scope.paths) || scope.paths.length !== 1 || scope.paths[0] !== change.path) {
      return stop('PR_SCOPE_INVALID');
    }
    if (!validReview(scope.review, { repository, headSha: scope.headSha,
      diffSha256: scope.diffSha256, proposerId: scope.proposerId })) return stop('PR_REVIEW_MISSING_OR_MISMATCHED');
    if (!validHostedCi(scope.hostedCi, { repository, headSha: scope.headSha, diffSha256: scope.diffSha256 })) {
      return stop('PR_HOSTED_CI_MISSING_OR_MISMATCHED');
    }
    scopes.set(project, scope);
  }
  if (!scopes.has('squire') || !scopes.has('target')) return stop('PR_SCOPE_INVALID');

  if (!Array.isArray(input.freshRefChecks) || input.freshRefChecks.length !== 2) return stop('FRESH_REF_CHECK_MISSING');
  const refs = new Map();
  for (const ref of input.freshRefChecks) {
    if (!exactKeys(ref, ['project', 'repository', 'branch', 'baseSha', 'headSha', 'source', 'checkedAtMs'])
      || !['squire', 'target'].includes(ref.project) || refs.has(ref.project)) return stop('FRESH_REF_CHECK_INVALID');
    const scope = scopes.get(ref.project);
    if (ref.source !== 'synthetic_ref_check' || ref.repository !== scope.repository || ref.branch !== scope.baseBranch
      || !isSha(ref.baseSha) || !isSha(ref.headSha)) return stop('FRESH_REF_CHECK_INVALID');
    if (ref.baseSha !== scope.baseSha) return stop('FRESH_BASE_MISMATCH');
    if (ref.headSha !== scope.headSha) return stop('FRESH_HEAD_MISMATCH');
    if (!Number.isSafeInteger(ref.checkedAtMs) || ref.checkedAtMs < 1 || ref.checkedAtMs > input.decisionTimeMs
      || input.decisionTimeMs - ref.checkedAtMs > MAX_REF_AGE_MS) return stop('FRESH_REF_CHECK_STALE');
    refs.set(ref.project, ref);
  }
  if (!refs.has('squire') || !refs.has('target')) return stop('FRESH_REF_CHECK_MISSING');

  if (!validateTicketDecision(input.ticketDisposition)) return stop('TICKET_DISPOSITION_INVALID');
  return {
    decision: 'allow',
    mode: 'synthetic_fixture_only',
    fixtureId: input.fixtureId,
    simulatedMerges: ['squire', 'target'].map(project => {
      const scope = scopes.get(project);
      return { project, repository: scope.repository, baseBranch: scope.baseBranch,
        baseSha: scope.baseSha, headSha: scope.headSha, paths: [...scope.paths] };
    }),
    ticketDisposition: {
      action: input.ticketDisposition.action,
      ticketId: input.ticketDisposition.action === 'refine_existing'
        ? input.ticketDisposition.selectedTicketId : null,
    },
    notice: 'Fixture-only simulated decision; no repository, ticket, or merge action was performed.',
  };
}

/** Return a deterministic fixture-only decision; never fetches, writes, or invokes another service. */
export function evaluateDualRetroFixture(input) {
  try { return evaluate(input); } catch { return stop('INPUT_INVALID'); }
}
