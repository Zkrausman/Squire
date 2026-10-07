import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Blocker, digest, isSha } from './contracts.mjs';
import { producerContext } from './producer-context.mjs';
import { assertOwner, scopeRow } from './operation-store.mjs';

export const candidateJournalSchema = `
  CREATE TABLE IF NOT EXISTS candidate_checkpoints (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    ticket TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK(purpose IN ('implementation','automatic_recovery','partial_recovery','interrupted_candidate_verification')),
    workspace TEXT NOT NULL,
    git_dir TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation > 0),
    branch_ref TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    parent_sha TEXT NOT NULL,
    tree_sha TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    policy_digest TEXT NOT NULL,
    job_id TEXT,
    recovery_id TEXT,
    files_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('intent','projected')),
    projected_at INTEGER,
    projected_status TEXT,
    projected_ticket_digest TEXT
  );
  CREATE INDEX IF NOT EXISTS candidate_checkpoint_project_ticket
    ON candidate_checkpoints(project,ticket,created_at);
  CREATE TRIGGER IF NOT EXISTS immutable_candidate_intent
    BEFORE UPDATE OF id,project,ticket,scope_id,purpose,workspace,git_dir,generation,branch_ref,base_sha,parent_sha,tree_sha,commit_sha,policy_digest,job_id,recovery_id,files_json,created_at
    ON candidate_checkpoints BEGIN SELECT RAISE(ABORT,'immutable candidate checkpoint intent'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_candidate_projection
    BEFORE UPDATE ON candidate_checkpoints WHEN OLD.phase='projected'
    BEGIN SELECT RAISE(ABORT,'immutable candidate checkpoint projection'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_candidate_checkpoint_delete
    BEFORE DELETE ON candidate_checkpoints BEGIN SELECT RAISE(ABORT,'immutable candidate checkpoint'); END;
`;

const purposes = new Set(['implementation', 'automatic_recovery', 'partial_recovery', 'interrupted_candidate_verification']);
const uuid = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const identityError = message => new Blocker('candidate_checkpoint_identity', message);

function validateInput(store, input) {
  const context = producerContext();
  if (!context || context.store !== store || context.project !== input.projectId || context.scopeId !== input.scopeId ||
      !uuid(input.scopeId) || !uuid(input.id) || !purposes.has(input.purpose)) throw identityError('Candidate checkpoint requires its active durable producer scope');
  if (typeof input.ticketId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(input.ticketId) ||
      typeof input.workspace !== 'string' || !input.workspace || !Number.isSafeInteger(input.generation) || input.generation < 1 ||
      typeof input.gitDir !== 'string' || !path.isAbsolute(input.gitDir) ||
      typeof input.branchRef !== 'string' || !input.branchRef.startsWith('refs/heads/') ||
      !isSha(input.baseSha) || !isSha(input.parentSha) || !isSha(input.treeSha) || !isSha(input.commitSha) ||
      typeof input.policyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.policyDigest) ||
      (input.jobId !== null && !uuid(input.jobId)) || (input.recoveryId !== null && !uuid(input.recoveryId)) ||
      !Array.isArray(input.files) || input.files.length > 10000 || input.files.some(file => typeof file !== 'string' || !file || file.includes('\0')) ||
      new Set(input.files).size !== input.files.length || !Number.isSafeInteger(input.createdAt) || input.createdAt <= 0) {
    throw identityError('Candidate checkpoint identity is missing or malformed');
  }
  const gitRelative = path.relative(path.resolve(input.workspace), path.resolve(input.gitDir));
  if (!gitRelative || gitRelative === '..' || gitRelative.startsWith(`..${path.sep}`) || path.isAbsolute(gitRelative)) {
    throw identityError('Candidate Git directory must belong to its exact managed workspace');
  }
  const project = store.get(input.projectId), ticket = project.tickets.find(item => item.spec.id === input.ticketId);
  const configHash = store.db.prepare('SELECT config_hash FROM project WHERE id=?').get(input.projectId)?.config_hash;
  if (!ticket || !configHash || configHash !== digest(project.config) || input.policyDigest !== configHash ||
      ticket.workspace !== input.workspace || ticket.generation !== input.generation || ticket.baseSha !== input.baseSha ||
      input.jobId !== (ticket.activeJob ?? null) ||
      ticket.beforeAgentHead !== input.parentSha || `refs/heads/${ticket.branch}` !== input.branchRef ||
      ticket.status !== ({ implementation: 'implementing', automatic_recovery: 'recovering', partial_recovery: 'recovering_partial', interrupted_candidate_verification: 'recovering_candidate' })[input.purpose]) {
    throw identityError('Candidate checkpoint differs from the durable ticket, generation, branch, or policy');
  }
  if (input.purpose === 'implementation' && (!input.jobId || ticket.activeJob !== input.jobId || input.recoveryId !== null)) {
    throw identityError('Implementation checkpoint must identify its active physical job');
  }
  if (input.purpose === 'partial_recovery' && (!uuid(input.recoveryId) || ticket.partialRecovery?.recoveryId !== input.recoveryId || ticket.partialRecovery?.status !== 'authorized')) {
    throw identityError('Partial recovery checkpoint must match its existing admission');
  }
  if (input.purpose === 'interrupted_candidate_verification' && (!uuid(input.recoveryId) || ticket.interruptedCandidateVerification?.recoveryId !== input.recoveryId || ticket.interruptedCandidateVerification?.status !== 'authorized')) {
    throw identityError('Interrupted-candidate checkpoint must match its existing admission');
  }
  if (input.purpose === 'automatic_recovery' && input.recoveryId !== null) throw identityError('Automatic recovery cannot invent a manual recovery admission');
  const scope = scopeRow(store, input.scopeId);
  assertOwner(store, scope);
  if (scope.project !== input.projectId || scope.lane !== `ticket:${input.ticketId}`) throw identityError('Candidate checkpoint producer scope does not own this ticket');
  if (input.jobId !== null) {
    const reservation = store.db.prepare(`SELECT c.scope_id,s.project,s.lane FROM producer_calls c
      JOIN producer_scopes s ON s.id=c.scope_id WHERE c.job_id=?`).get(input.jobId);
    if (!reservation || reservation.project !== input.projectId || reservation.lane !== `ticket:${input.ticketId}` ||
        (input.purpose === 'implementation' && reservation.scope_id !== input.scopeId)) {
      throw identityError('Candidate checkpoint job must match its durable ticket producer reservation');
    }
  }
}

export function prepareCandidateCheckpoint(store, input) {
  validateInput(store, input);
  store.db.prepare(`INSERT INTO candidate_checkpoints
    (id,project,ticket,scope_id,purpose,workspace,git_dir,generation,branch_ref,base_sha,parent_sha,tree_sha,commit_sha,policy_digest,job_id,recovery_id,files_json,created_at,phase)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'intent')`).run(input.id, input.projectId, input.ticketId, input.scopeId,
    input.purpose, input.workspace, input.gitDir, input.generation, input.branchRef, input.baseSha, input.parentSha, input.treeSha,
    input.commitSha, input.policyDigest, input.jobId, input.recoveryId, JSON.stringify(input.files), input.createdAt);
  return input.id;
}

export function projectCandidateCheckpoint(store, state, operationId) {
  const row = store.db.prepare('SELECT * FROM candidate_checkpoints WHERE id=?').get(operationId);
  if (!row || row.phase !== 'intent' || row.project !== state.id) throw new Blocker('candidate_checkpoint_unprojected', 'Candidate checkpoint intent is missing, foreign, or already projected');
  const context = producerContext();
  if (!context || context.store !== store || context.project !== row.project || context.scopeId !== row.scope_id || context.lifecycle?.persistenceFailed) {
    throw new Blocker('candidate_checkpoint_unprojected', 'Candidate checkpoint projection requires its active producer scope');
  }
  const scope = scopeRow(store, row.scope_id);
  assertOwner(store, scope);
  if (scope.project !== row.project || scope.lane !== `ticket:${row.ticket}`) throw new Blocker('candidate_checkpoint_identity', 'Candidate checkpoint scope no longer owns its ticket');
  const ticket = state.tickets.find(item => item.spec.id === row.ticket);
  if (!ticket || ticket.candidateCheckpointId !== operationId || ticket.headSha !== row.commit_sha || ticket.treeSha !== row.tree_sha ||
      ticket.beforeAgentHead !== row.parent_sha || ticket.baseSha !== row.base_sha || ticket.workspace !== row.workspace ||
      ticket.generation !== row.generation || `refs/heads/${ticket.branch}` !== row.branch_ref || digest(state.config) !== row.policy_digest ||
      (row.purpose === 'implementation' && ticket.implementation?.jobId !== row.job_id) ||
      (row.purpose === 'automatic_recovery' && (ticket.activeJob !== row.job_id || ticket.recovered !== true)) ||
      (row.purpose === 'partial_recovery' && (ticket.partialRecovery?.recoveryId !== row.recovery_id || ticket.partialRecovery?.status !== 'completed')) ||
      (row.purpose === 'interrupted_candidate_verification' && (ticket.interruptedCandidateVerification?.recoveryId !== row.recovery_id || ticket.interruptedCandidateVerification?.status !== 'completed'))) {
    throw new Blocker('candidate_checkpoint_identity', 'Candidate ticket projection does not match its durable intent');
  }
  const result = store.db.prepare(`UPDATE candidate_checkpoints SET phase='projected',projected_at=?,projected_status=?,projected_ticket_digest=?
    WHERE id=? AND phase='intent'`).run(Date.now(), ticket.status, digest(ticket), operationId);
  if (result.changes !== 1) throw new Blocker('candidate_checkpoint_unprojected', 'Candidate checkpoint projection was not unique');
  return row;
}

export function getCandidateCheckpoint(store, operationId) {
  const row = store.db.prepare('SELECT * FROM candidate_checkpoints WHERE id=?').get(operationId);
  if (!row) return null;
  return { ...row, projectId: row.project, ticketId: row.ticket, scopeId: row.scope_id, workspace: row.workspace,
    gitDir: row.git_dir, generation: row.generation, branchRef: row.branch_ref, baseSha: row.base_sha, parentSha: row.parent_sha,
    treeSha: row.tree_sha, commitSha: row.commit_sha, policyDigest: row.policy_digest, jobId: row.job_id,
    recoveryId: row.recovery_id, createdAt: row.created_at, projectedAt: row.projected_at,
    projectedStatus: row.projected_status, projectedTicketDigest: row.projected_ticket_digest, files: JSON.parse(row.files_json) };
}

export function candidateCheckpointSummary(row) {
  return { id: row.id, parentSha: row.parent_sha, treeSha: row.tree_sha, commitSha: row.commit_sha,
    purpose: row.purpose, phase: row.phase, jobId: row.job_id, recoveryId: row.recovery_id };
}

export const newCandidateCheckpointId = () => randomUUID();
