import test from './standalone.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { Controller } from '../src/controller.mjs';
import { fixture, FixtureRuntime, statusUntil, git } from './support.mjs';
import { correctiveTicket, prepareInterruptedCorrection, reserveHistoricalTicketJob } from './controller-fixtures.mjs';

test('interrupted-candidate projection failure leaves the authorized record and candidate intent unresolved', { timeout: 90000 }, async t => {
  const { f, controller, prepared, ticketBefore, request } = await prepareInterruptedCorrection(t, 'export const add=(a,b)=>a+b;\n// interrupted candidate\n');
  f.store.db.exec(`CREATE TRIGGER reject_candidate_projection BEFORE UPDATE OF phase ON candidate_checkpoints
    BEGIN SELECT RAISE(ABORT,'fixture projection failure'); END`);
  await assert.rejects(() => controller.checkpointInterruptedCandidateVerification(request), error =>
    error.storeTransactionFailed === true && error.message.includes('fixture projection failure'));
  const saved = f.store.get(f.config.id).tickets[0], intent = f.store.db.prepare('SELECT * FROM candidate_checkpoints WHERE ticket=? ORDER BY created_at DESC LIMIT 1').get('a');
  assert.equal(saved.status, 'recovering_candidate');
  assert.equal(saved.interruptedCandidateVerification.status, 'authorized');
  assert.equal(saved.headSha, ticketBefore.headSha); assert.equal(saved.treeSha, ticketBefore.treeSha);
  assert.equal(intent.purpose, 'interrupted_candidate_verification');
  assert.equal(intent.recovery_id, saved.interruptedCandidateVerification.recoveryId); assert.equal(intent.phase, 'intent');
  assert.equal(git(prepared.workspace, 'rev-parse', 'HEAD'), intent.commit_sha);
  assert.equal(f.store.db.prepare('SELECT closed_at FROM producer_scopes WHERE id=?').get(intent.scope_id).closed_at, null);
});

test('normal implementation projection failure preserves the candidate intent and producer fence', { timeout: 90000 }, async t => {
  const f = await fixture(t), controller = new Controller(f.store, f.config.id, { runtime: new FixtureRuntime() });
  await statusUntil(f.store, controller, 'prepared');
  f.store.db.exec(`CREATE TRIGGER reject_candidate_projection BEFORE UPDATE OF phase ON candidate_checkpoints
    BEGIN SELECT RAISE(ABORT,'fixture projection failure'); END`);
  await assert.rejects(() => controller.step('a'), error =>
    error.storeTransactionFailed === true && error.message.includes('fixture projection failure'));
  const ticketState = f.store.get(f.config.id).tickets[0];
  const intent = f.store.db.prepare('SELECT * FROM candidate_checkpoints WHERE ticket=?').get('a');
  assert.equal(ticketState.status, 'implementing'); assert.equal(ticketState.activeJob, intent.job_id);
  assert.equal(intent.purpose, 'implementation'); assert.equal(intent.phase, 'intent');
  assert.equal(git(ticketState.workspace, 'rev-parse', 'HEAD'), intent.commit_sha);
  assert.equal(f.store.db.prepare('SELECT closed_at FROM producer_scopes WHERE id=?').get(intent.scope_id).closed_at, null);
});

test('automatic-recovery projection failure keeps its old job identity and unresolved intent', { timeout: 90000 }, async t => {
  const f = await fixture(t), controller = new Controller(f.store, f.config.id, { runtime: new FixtureRuntime() });
  await statusUntil(f.store, controller, 'prepared');
  const prepared = f.store.get(f.config.id).tickets[0], jobId = await reserveHistoricalTicketJob(f, controller);
  await writeFile(path.join(prepared.workspace, 'feature-a.mjs'), 'export const add=(a,b)=>a+b;\n');
  controller.transition('a', 'recovering', { beforeAgentHead: prepared.baseSha, activeJob: jobId });
  f.store.db.exec(`CREATE TRIGGER reject_candidate_projection BEFORE UPDATE OF phase ON candidate_checkpoints
    BEGIN SELECT RAISE(ABORT,'fixture projection failure'); END`);
  await assert.rejects(() => controller.step('a'), error =>
    error.storeTransactionFailed === true && error.message.includes('fixture projection failure'));
  const saved = f.store.get(f.config.id).tickets[0], intent = f.store.db.prepare('SELECT * FROM candidate_checkpoints WHERE ticket=?').get('a');
  assert.equal(saved.status, 'recovering'); assert.equal(saved.activeJob, jobId);
  assert.equal(intent.purpose, 'automatic_recovery'); assert.equal(intent.job_id, jobId); assert.equal(intent.phase, 'intent');
  assert.equal(git(saved.workspace, 'rev-parse', 'HEAD'), intent.commit_sha);
  assert.equal(f.store.db.prepare('SELECT closed_at FROM producer_scopes WHERE id=?').get(intent.scope_id).closed_at, null);
});

test('partial-recovery projection failure retains the authorized recovery and open fence', { timeout: 90000 }, async t => {
  const f = await fixture(t, [correctiveTicket()]), controller = new Controller(f.store, f.config.id, { runtime: new FixtureRuntime() });
  await statusUntil(f.store, controller, 'prepared');
  const prepared = f.store.get(f.config.id).tickets[0];
  await writeFile(path.join(prepared.workspace, 'feature-a.mjs'), 'export const add=(a,b)=>a+b;\n// useful partial work\n');
  f.store.update(f.config.id, state => Object.assign(state.tickets[0], {
    status: 'blocked', attempts: 1, repairs: 0, beforeAgentHead: prepared.baseSha, headSha: null, treeSha: null,
    implementation: null, activeJob: null,
    blocker: { code: 'runtime_failed', role: 'implement', message: 'Implementation timed out.', detail: { receipt: {
      argv: ['codex', 'exec', '--sandbox', 'workspace-write'], exitCode: null, stopped: false, timedOut: true,
      outputExceeded: false, launchError: null
    } } }
  }));
  f.store.pause(f.config.id);
  const before = f.store.get(f.config.id).tickets[0];
  f.store.db.exec(`CREATE TRIGGER reject_candidate_projection BEFORE UPDATE OF phase ON candidate_checkpoints
    BEGIN SELECT RAISE(ABORT,'fixture projection failure'); END`);
  await assert.rejects(() => controller.recoverInterruptedImplementation({ ticketId: 'a', expectedWorkspace: before.workspace,
    expectedBaseSha: before.baseSha, expectedBeforeAgentHead: before.beforeAgentHead }), error =>
    error.storeTransactionFailed === true && error.message.includes('fixture projection failure'));
  const saved = f.store.get(f.config.id).tickets[0], intent = f.store.db.prepare('SELECT * FROM candidate_checkpoints WHERE ticket=?').get('a');
  assert.equal(saved.status, 'recovering_partial'); assert.equal(saved.partialRecovery.status, 'authorized');
  assert.equal(intent.purpose, 'partial_recovery'); assert.equal(intent.recovery_id, saved.partialRecovery.recoveryId); assert.equal(intent.phase, 'intent');
  assert.equal(git(saved.workspace, 'rev-parse', 'HEAD'), intent.commit_sha);
  assert.equal(f.store.db.prepare('SELECT closed_at FROM producer_scopes WHERE id=?').get(intent.scope_id).closed_at, null);
});
