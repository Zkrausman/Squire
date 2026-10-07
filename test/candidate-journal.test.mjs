import test from './standalone.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { fixture, git } from './support.mjs';
import { GitWorkspace } from '../src/workspace.mjs';
import { withProducer } from '../src/producer-context.mjs';
import { digest } from '../src/contracts.mjs';
import { beginJobEvidence, finishJobEvidence, readJobEvidence, recordCandidateDisposition } from '../src/job-evidence.mjs';

async function candidateFixture(t) {
  const f = await fixture(t), projectRoot = path.join(f.stateDir, 'projects', f.config.id);
  await mkdir(projectRoot, { recursive: true });
  const workspace = new GitWorkspace(projectRoot), directory = path.join(projectRoot, 'workspaces', 'a-1');
  const prepared = await workspace.prepare(f.config.services.app, directory, 'squire/journal-a');
  const sha = value => git(directory, 'rev-parse', value);
  const state = f.store.get(f.config.id), saved = state.tickets[0];
  const current = { ...saved, status: 'implementing', workspace: directory, branch: prepared.branch,
    generation: 1, baseSha: prepared.baseSha, beforeAgentHead: prepared.baseSha,
    headSha: prepared.baseSha, treeSha: sha('HEAD^{tree}'), activeJob: randomUUID() };
  f.store.update(f.config.id, value => { value.tickets[0] = current; });
  await writeFile(path.join(directory, 'feature-a.mjs'), 'export const add=(a,b)=>a+b;\n');
  const release = f.store.lease(`controller:${f.config.id}`);
  f.addCleanup(release);
  const scopeId = f.store.beginProducer(f.config.id, 'ticket:a', release, [workspace.key(f.config.services.app)]);
  const producer = { store: f.store, project: f.config.id, scopeId };
  withProducer(producer, () => f.store.reserveProducerCall(scopeId, current.activeJob));
  const context = (purpose = 'implementation', overrides = {}) => ({ store: f.store,
    projectId: f.config.id, scopeId, purpose, policyDigest: digest(f.config),
    jobId: current.activeJob, recoveryId: null, ...overrides });
  const checkpoint = (ticketState = current, checkpointContext = context()) => withProducer(producer,
    () => workspace.checkpoint(ticketState, f.config.services.app, undefined, checkpointContext));
  return { ...f, workspace, directory, prepared, current, scopeId, producer, context, checkpoint, sha, release };
}

test('candidate intent carries exact identities and projects atomically with its ticket outcome', async t => {
  const f = await candidateFixture(t), candidate = await f.checkpoint();
  assert.match(candidate.operationId, /^[a-f0-9-]{36}$/);
  const journal = f.store.candidateCheckpoint(candidate.operationId);
  assert.equal(journal.phase, 'intent');
  assert.equal(journal.parentSha, f.prepared.baseSha);
  assert.equal(journal.treeSha, candidate.treeSha);
  assert.equal(journal.commitSha, candidate.headSha);
  assert.equal(journal.scopeId, f.scopeId);
  assert.equal(journal.project, f.config.id);
  assert.equal(journal.ticket, 'a');
  assert.equal(journal.workspace, f.directory);
  assert.equal(journal.gitDir, git(f.directory, 'rev-parse', '--absolute-git-dir'));
  assert.equal(journal.generation, 1);
  assert.equal(journal.jobId, f.current.activeJob);
  assert.equal(journal.policyDigest, digest(f.config));
  assert.equal(f.sha('HEAD'), candidate.headSha);

  const projected = withProducer(f.producer, () => f.store.update(f.config.id, state => {
    const saved = state.tickets[0];
    Object.assign(saved, candidate, { candidateCheckpointId: candidate.operationId, status: 'verifying', activeJob: null,
      implementation: { jobId: f.current.activeJob, sessionRef: 'fixture-session', usage: {} } });
  }, 'ticket.transition', { status: 'verifying' }, null, candidate.operationId));
  const saved = projected.tickets[0];
  assert.equal(saved.headSha, candidate.headSha);
  assert.equal(f.store.candidateCheckpoint(candidate.operationId).phase, 'projected');
  assert.throws(() => f.store.db.prepare('DELETE FROM candidate_checkpoints WHERE id=?').run(candidate.operationId), /immutable/);
  assert.throws(() => f.store.db.prepare('UPDATE candidate_checkpoints SET commit_sha=? WHERE id=?').run('f'.repeat(40), candidate.operationId), /immutable/);
  assert.throws(() => f.store.update(f.config.id, () => {}, 'ticket.transition', {}, null, candidate.operationId),
    /candidate|project/i);
});

test('physical-job candidate evidence links the exact journal operation, parent, tree and commit', async t => {
  const f = await candidateFixture(t), candidate = await f.checkpoint();
  const evidence = await beginJobEvidence({ id: f.current.activeJob, role: 'implement',
    directory: path.join(f.stateDir, 'jobs', 'a', f.current.activeJob) },
  { projectId: f.config.id, scopeId: f.scopeId, ticketId: 'a', attempt: 1 });
  await finishJobEvidence(evidence, { outcome: { outcome: 'completed', sessionRef: 'fixture-session' },
    sessionRef: 'fixture-session', models: {} });
  await recordCandidateDisposition(evidence, { outcome: 'candidate', headSha: candidate.headSha, treeSha: candidate.treeSha }, candidate);
  const saved = await readJobEvidence(evidence.directory, f.current.activeJob);
  assert.equal(saved.disposition.version, 2);
  assert.deepEqual(saved.disposition.candidateOperation, { id: candidate.operationId, parentSha: candidate.parentSha,
    commitSha: candidate.headSha, treeSha: candidate.treeSha });
});

test('intent persistence failure cannot move the branch ref', async t => {
  const f = await candidateFixture(t), before = f.sha('HEAD');
  f.store.db.exec(`CREATE TRIGGER reject_candidate_intent BEFORE INSERT ON candidate_checkpoints
    BEGIN SELECT RAISE(ABORT, 'fixture intent failure'); END`);
  await assert.rejects(() => f.checkpoint());
  assert.equal(f.sha('HEAD'), before);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM candidate_checkpoints').get().n, 0);
});

test('implementation checkpoint requires the active physical-job reservation', async t => {
  const f = await candidateFixture(t), before = f.sha('HEAD');
  f.store.db.prepare('DELETE FROM producer_calls WHERE job_id=?').run(f.current.activeJob);
  await assert.rejects(() => f.checkpoint(), error => error.code === 'candidate_checkpoint_identity');
  assert.equal(f.sha('HEAD'), before);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM candidate_checkpoints').get().n, 0);
});

test('candidate projection succeeds under the exact durable scope owner', async t => {
  const f = await candidateFixture(t), candidate = await f.checkpoint();
  const project = withProducer(f.producer, () => f.store.update(f.config.id, state => {
    Object.assign(state.tickets[0], candidate, { candidateCheckpointId: candidate.operationId, status: 'verifying', activeJob: null,
      implementation: { jobId: f.current.activeJob, sessionRef: 'fixture-session', usage: {} } });
  }, 'ticket.transition', { status: 'verifying' }, null, candidate.operationId));
  assert.equal(project.tickets[0].status, 'verifying');
  assert.equal(f.store.candidateCheckpoint(candidate.operationId).phase, 'projected');
});

test('candidate projection without scope context or current lease owner stays unresolved', async t => {
  const f = await candidateFixture(t), candidate = await f.checkpoint();
  const project = () => f.store.update(f.config.id, state => {
    Object.assign(state.tickets[0], candidate, { candidateCheckpointId: candidate.operationId, status: 'verifying', activeJob: null,
      implementation: { jobId: f.current.activeJob, sessionRef: 'fixture-session', usage: {} } });
  }, 'ticket.transition', { status: 'verifying' }, null, candidate.operationId);
  assert.throws(project, error => error.code === 'candidate_checkpoint_unprojected');
  f.release();
  const replacement = f.store.lease(`controller:${f.config.id}`);
  f.addCleanup(replacement);
  assert.throws(() => withProducer(f.producer, project), error => error.code === 'producer_unresolved');
  assert.equal(f.store.get(f.config.id).tickets[0].status, 'implementing');
  assert.equal(f.store.candidateCheckpoint(candidate.operationId).phase, 'intent');
});

test('ref movement after intent fails CAS and preserves the competing ref and unresolved intent', async t => {
  const f = await candidateFixture(t), before = f.sha('HEAD');
  const update = f.workspace.git.bind(f.workspace);
  let competed = false;
  f.workspace.git = async (cwd, argv, signal, env) => {
    if (!competed && argv.includes('update-ref')) {
      competed = true;
      const competingCommit = git(f.directory, 'commit-tree', `${before}^{tree}`, '-p', before, '-m', 'unowned competing movement');
      git(f.directory, 'update-ref', 'refs/heads/squire/journal-a', competingCommit, before);
    }
    return update(cwd, argv, signal, env);
  };
  await assert.rejects(() => f.checkpoint(), error => error.code === 'candidate_ref_conflict');
  const competing = f.sha('HEAD');
  assert.notEqual(competing, before); assert.equal(competed, true);
  const intents = f.store.db.prepare('SELECT * FROM candidate_checkpoints').all();
  assert.equal(intents.length, 1);
  assert.equal(intents[0].phase, 'intent');
  assert.equal(intents[0].parent_sha, before);
  assert.notEqual(intents[0].commit_sha, competing);
});

test('index and worktree changes after intent leave the branch untouched and producer fenced', async t => {
  const f = await candidateFixture(t), before = f.sha('HEAD');
  writeFileSync(path.join(f.directory, ' feature-a.mjs'), 'export const spaced=true;\n');
  assert.equal(await f.workspace.git(f.directory, ['ls-files', '--others', '--exclude-standard', '-z']), ' feature-a.mjs\0feature-a.mjs\0');
  const prepare = f.store.prepareCandidateCheckpoint.bind(f.store);
  f.store.prepareCandidateCheckpoint = record => {
    const id = prepare(record);
    writeFileSync(path.join(f.directory, 'late-change.mjs'), 'export const late=true;\n');
    git(f.directory, 'add', 'late-change.mjs');
    return id;
  };
  await assert.rejects(() => f.checkpoint(), error => error.code === 'candidate_checkpoint_identity');
  assert.equal(f.sha('HEAD'), before);
  const intent = f.store.db.prepare('SELECT * FROM candidate_checkpoints').get();
  assert.equal(intent.phase, 'intent');
  assert.equal(intent.parent_sha, before);
});

test('late worktree mutation can follow CAS but leaves intent unprojected and producer fenced', async t => {
  const f = await candidateFixture(t), before = f.sha('HEAD'), update = f.workspace.git.bind(f.workspace);
  let mutated = false;
  f.workspace.git = async (cwd, argv, signal, env) => {
    if (!mutated && argv.includes('update-ref')) {
      mutated = true;
      writeFileSync(path.join(f.directory, 'late-check-to-cas.mjs'), 'export const late=true;\n');
      git(f.directory, 'add', 'late-check-to-cas.mjs');
    }
    return update(cwd, argv, signal, env);
  };
  await assert.rejects(() => f.checkpoint(), error => error.code === 'candidate_checkpoint_identity');
  const intent = f.store.db.prepare('SELECT * FROM candidate_checkpoints').get();
  assert.equal(mutated, true);
  assert.equal(f.sha('HEAD'), intent.commit_sha);
  assert.notEqual(intent.commit_sha, before);
  assert.equal(intent.phase, 'intent');
  assert.equal(f.store.get(f.config.id).tickets[0].status, 'implementing');
  assert.equal(f.store.db.prepare('SELECT closed_at FROM producer_scopes WHERE id=?').get(f.scopeId).closed_at, null);
});

test('projection failure after ref update leaves ticket unchanged and producer fenced after reopen', async t => {
  const f = await candidateFixture(t), candidate = await f.checkpoint();
  f.store.db.exec(`CREATE TRIGGER reject_candidate_projection BEFORE UPDATE OF phase ON candidate_checkpoints
    BEGIN SELECT RAISE(ABORT, 'fixture projection failure'); END`);
  assert.throws(() => withProducer(f.producer, () => f.store.update(f.config.id, state => {
    Object.assign(state.tickets[0], candidate, { candidateCheckpointId: candidate.operationId, status: 'verifying', activeJob: null,
      implementation: { jobId: f.current.activeJob, sessionRef: 'fixture-session', usage: {} } });
  }, 'ticket.transition', { status: 'verifying' }, null, candidate.operationId)),
  error => error.message.includes('fixture projection failure'));
  assert.equal(f.sha('HEAD'), candidate.headSha);
  assert.equal(f.store.get(f.config.id).tickets[0].status, 'implementing');
  assert.equal(f.store.candidateCheckpoint(candidate.operationId).phase, 'intent');
  f.release();
  const reopened = new (await import('../src/store.mjs')).Store(f.stateDir);
  f.addCleanup(() => reopened.close());
  assert.equal(reopened.get(f.config.id).tickets[0].status, 'implementing');
  assert.equal(reopened.candidateCheckpoint(candidate.operationId).phase, 'intent');
  const nextLease = reopened.lease(`controller:${f.config.id}`);
  f.addCleanup(nextLease);
  assert.throws(() => reopened.beginProducer(f.config.id, 'ticket:a', nextLease), error => error.code === 'producer_unresolved');
});

test('wrong generation, job, policy or missing journal identity blocks before ref mutation', async t => {
  const f = await candidateFixture(t), before = f.sha('HEAD');
  await assert.rejects(() => f.checkpoint({ ...f.current, generation: 2 }), error => error.code === 'candidate_checkpoint_identity');
  await assert.rejects(() => f.checkpoint(f.current, f.context('implementation', { jobId: 'wrong-job' })),
    error => error.code === 'candidate_checkpoint_identity');
  await assert.rejects(() => f.checkpoint(f.current, f.context('implementation', { policyDigest: '0'.repeat(64) })),
    error => error.code === 'candidate_checkpoint_identity');
  await assert.rejects(() => withProducer({ store: f.store, project: f.config.id, scopeId: f.scopeId },
    () => f.workspace.checkpoint(f.current, f.config.services.app)), error => error.code === 'candidate_checkpoint_identity');
  assert.equal(f.sha('HEAD'), before);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM candidate_checkpoints').get().n, 0);
});
