import test from './standalone.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { Controller } from '../src/controller.mjs';
import { checkpointFixtureCandidate, fixture, ticket, FixtureRuntime, statusUntil, git } from './support.mjs';
import { correctiveTicket, prepareInterruptedCorrection, reserveHistoricalTicketJob } from './controller-fixtures.mjs';

test('interrupted implementation retains partial work and re-enters trusted gates', { timeout: 90000 }, async t => {
  const f = await fixture(t), runtime = new FixtureRuntime(), first = new Controller(f.store, f.config.id, { runtime });
  await statusUntil(f.store, first, 'prepared'); const before = f.store.get(f.config.id).tickets[0];
  const jobId = await reserveHistoricalTicketJob(f, first);
  await writeFile(path.join(before.workspace, 'feature-a.mjs'), 'export const add=(a,b)=>a+b;\n');
  first.transition('a', 'implementing', { beforeAgentHead: before.baseSha, activeJob: jobId, implementationSessions: ['lost-session'] });
  const result = await new Controller(f.store, f.config.id, { runtime }).run();
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.tickets[0].recovered, true);
  const checkpoint = f.store.candidateCheckpoint(result.tickets[0].candidateCheckpointId);
  assert.equal(checkpoint.phase, 'projected'); assert.equal(checkpoint.purpose, 'automatic_recovery');
  assert.equal(checkpoint.jobId, result.tickets[0].activeJob);
  assert.equal(runtime.calls.filter(c => c.role === 'implement').length, 0); assert.equal(runtime.calls.filter(c => c.role === 'review').length, 1);
});

test('explicit timed-out implementation recovery checkpoints only owned partial work before continuation', { timeout: 90000 }, async t => {
  const f = await fixture(t, [correctiveTicket()]), runtime = new FixtureRuntime(), controller = new Controller(f.store, f.config.id, { runtime });
  await statusUntil(f.store, controller, 'prepared');
  const prepared = f.store.get(f.config.id).tickets[0], partialPath = path.join(prepared.workspace, 'feature-a.mjs');
  await writeFile(partialPath, 'export const add=(a,b)=>a+b;\n// useful work from stopped implementation\n');
  f.store.update(f.config.id, state => {
    state.agentCalls = 4;
    Object.assign(state.tickets[0], {
      status: 'blocked', attempts: 2, repairs: 2, rebases: 1, reviewAttempts: 0,
      beforeAgentHead: prepared.baseSha, headSha: null, treeSha: null, implementation: null, activeJob: null,
      blocker: { code: 'runtime_failed', role: 'implement', message: 'Implementation timed out.', detail: { receipt: {
        argv: ['codex', 'exec', '--sandbox', 'workspace-write'], exitCode: null, stopped: false, timedOut: true,
        outputExceeded: false, launchError: null
      } } }
    });
  });
  f.store.pause(f.config.id);
  const before = f.store.get(f.config.id), ticketBefore = before.tickets[0];
  const request = { ticketId: 'a', expectedWorkspace: ticketBefore.workspace,
    expectedBaseSha: ticketBefore.baseSha, expectedBeforeAgentHead: ticketBefore.beforeAgentHead };
  const recovered = await controller.recoverInterruptedImplementation(request);
  const savedState = f.store.get(f.config.id), saved = savedState.tickets[0];
  assert.equal(recovered.status, 'blocked'); assert.equal(saved.recovered, true);
  assert.equal(saved.partialRecovery.status, 'completed');
  assert.deepEqual(saved.partialRecovery.candidate.files, ['feature-a.mjs']);
  assert.deepEqual(saved.spec, ticketBefore.spec);
  assert.equal(saved.attempts, ticketBefore.attempts); assert.equal(saved.repairs, ticketBefore.repairs);
  assert.equal(saved.rebases, ticketBefore.rebases); assert.equal(savedState.agentCalls, before.agentCalls);
  assert.equal(saved.headSha, recovered.headSha); assert.equal(saved.treeSha, recovered.treeSha);
  const checkpoint = f.store.candidateCheckpoint(saved.candidateCheckpointId);
  assert.equal(checkpoint.phase, 'projected'); assert.equal(checkpoint.purpose, 'partial_recovery');
  assert.equal(checkpoint.recoveryId, saved.partialRecovery.recoveryId);
  assert.equal(saved.blocker.code, 'runtime_failed'); assert.equal(saved.implementation, null);
  const cleanCandidate = await controller.workspace.identity(saved.workspace);
  assert.equal(cleanCandidate.headSha, saved.headSha); assert.equal(cleanCandidate.treeSha, saved.treeSha); assert.equal(cleanCandidate.dirty, '');
  assert.equal(runtime.calls.length, 0);

  const continuation = f.store.continueInterrupted(f.config, { ticketId: 'a', expectedHeadSha: saved.headSha,
    instructions: 'Continue this same attempt from the checkpointed partial work within the original owned paths.' });
  assert.equal(continuation.status, 'continuing');
  assert.equal(f.store.get(f.config.id).tickets[0].attempts, ticketBefore.attempts);
});

test('partial recovery rejects out-of-scope work without discarding it', { timeout: 90000 }, async t => {
  const f = await fixture(t, [correctiveTicket()]), runtime = new FixtureRuntime(), controller = new Controller(f.store, f.config.id, { runtime });
  await statusUntil(f.store, controller, 'prepared');
  const prepared = f.store.get(f.config.id).tickets[0], unexpected = path.join(prepared.workspace, 'unowned.txt');
  await writeFile(unexpected, 'Preserve this out-of-scope partial work.\n');
  f.store.update(f.config.id, state => Object.assign(state.tickets[0], {
    status: 'blocked', attempts: 1, repairs: 0, beforeAgentHead: prepared.baseSha, headSha: null, treeSha: null,
    implementation: null, activeJob: null,
    blocker: { code: 'runtime_failed', role: 'implement', message: 'Implementation timed out.', detail: { receipt: {
      argv: ['codex', 'exec', '--sandbox', 'workspace-write'], exitCode: null, stopped: false, timedOut: true,
      outputExceeded: false, launchError: null
    } } }
  }));
  f.store.pause(f.config.id);
  const ticketBefore = f.store.get(f.config.id).tickets[0];
  await assert.rejects(() => controller.recoverInterruptedImplementation({ ticketId: 'a', expectedWorkspace: ticketBefore.workspace,
    expectedBaseSha: ticketBefore.baseSha, expectedBeforeAgentHead: ticketBefore.beforeAgentHead }), error => error.code === 'scope_escape');
  const after = f.store.get(f.config.id).tickets[0];
  assert.equal(after.status, 'blocked'); assert.equal(after.recovered, undefined);
  assert.equal(after.headSha, null); assert.equal(after.blocker.code, 'runtime_failed');
  assert.equal(after.partialRecovery.status, 'failed');
  assert.equal(git(prepared.workspace, 'rev-parse', 'HEAD'), prepared.baseSha);
  assert.equal(await readFile(unexpected, 'utf8'), 'Preserve this out-of-scope partial work.\n');
  assert.equal(runtime.calls.length, 0);
});
test('interrupted corrective candidate is checkpointed without implementation completion and passes fresh gates', { timeout: 120000 }, async t => {
  const fctx = await prepareInterruptedCorrection(t, 'export const add=(a,b)=>a+b;\n// interrupted corrective candidate\n');
  const { f, runtime, controller, ticketBefore, request } = fctx;
  runtime.handler = async (job, _runtime, sessionRef) => {
    if (job.role !== 'review') return undefined;
    const headSha = /HEAD ([a-f0-9]{40})/.exec(job.instructions)[1];
    return { outcome: 'completed', sessionRef, result: { headSha, verdict: 'pass', summary: 'Every original and corrective criterion is supported.', findings: [],
      checklist: ['base-one', 'base-two', 'corrective-one'].map(id => ({ id, verdict: 'pass', evidence: `Observed ${id} against this exact candidate.` })) } };
  };
  const checkpoint = await controller.checkpointInterruptedCandidateVerification(request);
  let saved = f.store.get(f.config.id).tickets[0];
  assert.equal(checkpoint.status, 'verifying'); assert.equal(checkpoint.implementationCompleted, false);
  assert.equal(saved.interruptedCandidateVerification.implementationCompleted, false);
  assert.equal(saved.interruptedCandidateVerification.status, 'completed');
  const candidateCheckpoint = f.store.candidateCheckpoint(saved.candidateCheckpointId);
  assert.equal(candidateCheckpoint.phase, 'projected'); assert.equal(candidateCheckpoint.purpose, 'interrupted_candidate_verification');
  assert.equal(candidateCheckpoint.recoveryId, saved.interruptedCandidateVerification.recoveryId);
  assert.notEqual(saved.headSha, ticketBefore.headSha); assert.deepEqual(saved.interruptedCandidateVerification.candidate.files, ['feature-a.mjs']);
  assert.deepEqual(saved.implementation, ticketBefore.implementation); assert.deepEqual(saved.implementationSessions, ticketBefore.implementationSessions);
  assert.deepEqual(saved.interruptedContinuation, ticketBefore.interruptedContinuation); assert.deepEqual(saved.partialRecovery, ticketBefore.partialRecovery);
  assert.equal(saved.attempts, ticketBefore.attempts); assert.equal(saved.repairs, ticketBefore.repairs); assert.equal(f.store.get(f.config.id).agentCalls, 7);

  f.store.resume(f.config.id);
  const result = await controller.run(); saved = result.tickets[0];
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(saved.status, 'shipped');
  assert.equal(saved.verification.passed, true); assert.equal(saved.review.verdict, 'pass');
  assert.deepEqual(saved.checklistEvidence.items.map(item => item.id), ['base-one', 'base-two', 'corrective-one']);
  assert.deepEqual(saved.implementation, ticketBefore.implementation);
  assert.equal(runtime.calls.filter(call => call.role === 'implement').length, 0);
  assert.equal(runtime.calls.filter(call => call.role === 'review').length, 1);
});
test('interrupted candidate verification failure stops at consumed correction ceiling without another implementation', { timeout: 90000 }, async t => {
  const fctx = await prepareInterruptedCorrection(t, 'export const add=(a,b)=>a-b;\n// failed interrupted corrective candidate\n');
  const { f, runtime, controller, ticketBefore, request } = fctx;
  const checkpoint = await controller.checkpointInterruptedCandidateVerification(request);
  f.store.resume(f.config.id);
  const result = await controller.run(), saved = result.tickets[0];
  assert.equal(result.status, 'blocked', JSON.stringify(result)); assert.equal(saved.status, 'blocked');
  assert.equal(saved.blocker.code, 'repair_budget'); assert.equal(saved.verification.passed, false);
  assert.equal(saved.verification.headSha, saved.headSha); assert.equal(saved.verification.treeSha, saved.treeSha);
  assert.equal(saved.interruptedCandidateVerification.status, 'completed');
  assert.equal(saved.attempts, ticketBefore.attempts); assert.equal(saved.repairs, ticketBefore.repairs);
  assert.equal(saved.implementation.sessionRef, ticketBefore.implementation.sessionRef);
  assert.equal(runtime.calls.filter(call => call.role === 'implement').length, 0);
  assert.equal(runtime.calls.filter(call => call.role === 'review').length, 0);
  assert.equal(checkpoint.implementationCompleted, false);
});
test('interrupted candidate checkpoint rejects scope escape and preserves dirty partial files', { timeout: 90000 }, async t => {
  const fctx = await prepareInterruptedCorrection(t, 'export const add=(a,b)=>a+b;\n// interrupted candidate\n');
  const { f, controller, runtime, prepared, ticketBefore, request } = fctx;
  const unowned = path.join(prepared.workspace, 'unowned.txt'); await writeFile(unowned, 'Keep this partial file.\n');
  await assert.rejects(() => controller.checkpointInterruptedCandidateVerification(request), error => error.code === 'scope_escape');
  const after = f.store.get(f.config.id).tickets[0];
  assert.equal(after.status, 'blocked'); assert.equal(after.interruptedCandidateVerification.status, 'failed');
  assert.equal(after.headSha, ticketBefore.headSha); assert.equal(after.treeSha, ticketBefore.treeSha);
  assert.equal(after.attempts, ticketBefore.attempts); assert.equal(after.repairs, ticketBefore.repairs);
  assert.deepEqual(after.implementation, ticketBefore.implementation);
  assert.equal(git(prepared.workspace, 'rev-parse', 'HEAD'), ticketBefore.headSha);
  assert.equal(await readFile(unowned, 'utf8'), 'Keep this partial file.\n');
  assert.equal(runtime.calls.length, 0);
  assert.throws(() => f.store.resume(f.config.id, true, ['a']), { code: 'producer_unresolved' });
});
test('one interrupted logical attempt continues with unchanged counters and fresh verification and review', { timeout: 120000 }, async t => {
  const f = await fixture(t, [correctiveTicket()], { limits: { maxRepairs: 0 } }); let reviewCount = 0, continuationJobDirectory;
  const runtime = new FixtureRuntime(async job => {
    if (job.role === 'review') {
      const headSha = /HEAD ([a-f0-9]{40})/.exec(job.instructions)[1];
      if (++reviewCount === 1) return { outcome: 'completed', sessionRef: 'partial-review', result: { headSha, verdict: 'fail', summary: 'Startup cleanup is missing.', findings: [{ priority: 'P1', file: 'feature-a.mjs', line: 1, message: 'Dispose the startup resource when shutdown interrupts startup.' }] } };
      return { outcome: 'completed', sessionRef: 'continuation-review', result: { headSha, verdict: 'pass', summary: 'Original and corrective criteria passed.', findings: [], checklist: ['base-one', 'base-two'].map(id => ({ id, verdict: 'pass', evidence: `Observed ${id} in the candidate regression.` })) } };
    }
    if (job.role === 'implement' && job.provenance?.continuationId) {
      continuationJobDirectory = job.directory;
      assert.match(job.instructions, /actualPartialReview/);
      assert.match(job.instructions, /Finish the interrupted startup cleanup/);
      await writeFile(path.join(job.workspace, 'feature-a.mjs'), 'export const add=(a,b)=>a+b;\n// startup cleanup continuation\n');
      return { outcome: 'completed', sessionRef: 'continued-implementation', result: 'Completed the interrupted startup cleanup.' };
    }
  });
  const first = new Controller(f.store, f.config.id, { runtime });
  await statusUntil(f.store, first, 'prepared');
  const prepared = f.store.get(f.config.id).tickets[0];
  await writeFile(path.join(prepared.workspace, 'feature-a.mjs'), 'export const add=(a,b)=>a+b;\n// recovered partial candidate\n');
  f.store.update(f.config.id, state => { state.agentCalls = 1; }); // The lost implementation call was already budgeted.
  const lostJobId = await reserveHistoricalTicketJob(f, first);
  first.transition('a', 'implementing', { attempts: 1, beforeAgentHead: prepared.baseSha, activeJob: lostJobId });
  const blocked = await new Controller(f.store, f.config.id, { runtime }).run();
  const partial = blocked.tickets[0];
  assert.equal(blocked.status, 'blocked'); assert.equal(partial.blocker.code, 'repair_budget');
  assert.equal(partial.recovered, true); assert.equal(partial.implementation, undefined);
  assert.equal(partial.attempts, 1); assert.equal(partial.repairs, 0); assert.equal(partial.reviewAttempts, 1);
  assert.equal(f.store.get(f.config.id).agentCalls, 2);

  f.store.pause(f.config.id);
  const authorized = f.store.continueInterrupted(f.config, { ticketId: 'a', expectedHeadSha: partial.headSha, instructions: 'Finish the interrupted startup cleanup within the original owned paths.' });
  assert.equal(authorized.status, 'continuing');
  const admitted = f.store.get(f.config.id).tickets[0];
  assert.equal(admitted.attempts, 1); assert.equal(admitted.repairs, 0); assert.equal(admitted.interruptedContinuation.status, 'authorized');
  f.store.resume(f.config.id);

  const result = await new Controller(f.store, f.config.id, { runtime }).run();
  const saved = result.tickets[0];
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(saved.status, 'shipped');
  assert.equal(saved.attempts, 1); assert.equal(saved.repairs, 0); assert.equal(saved.reviewAttempts, 2);
  assert.equal(saved.interruptedContinuation.status, 'completed');
  assert.equal(saved.interruptedContinuation.partial.review.summary, 'Startup cleanup is missing.');
  assert.equal(saved.interruptedContinuation.logicalAttempt, 1);
  assert.equal(f.store.get(f.config.id).agentCalls, 4);
  assert.equal(runtime.calls.filter(call => call.role === 'implement').length, 1);
  assert.equal(runtime.calls.filter(call => call.role === 'review').length, 2);
  assert.match(path.basename(continuationJobDirectory), /^[a-f0-9-]{36}$/);
});
test('continuation refuses an unexpected dirty partial workspace before starting an agent', { timeout: 90000 }, async t => {
  const f = await fixture(t, [correctiveTicket()], { limits: { maxRepairs: 0 } });
  const setup = new Controller(f.store, f.config.id, { runtime: new FixtureRuntime() });
  await statusUntil(f.store, setup, 'prepared');
  const prepared = f.store.get(f.config.id).tickets[0];
  await writeFile(path.join(prepared.workspace, 'feature-a.mjs'), 'export const add=(a,b)=>a+b;\n// retained recovered partial\n');
  const candidate = await checkpointFixtureCandidate(f, setup.workspace, { ...prepared, beforeAgentHead: prepared.baseSha }, f.config.services.app);
  f.store.update(f.config.id, state => {
    const ticket = state.tickets[0];
    Object.assign(ticket, { status: 'blocked', attempts: 1, beforeAgentHead: prepared.baseSha, ...candidate, recovered: true,
      blocker: { code: 'repair_budget', message: 'Recovered partial candidate was rejected.' },
      review: { headSha: candidate.headSha, verdict: 'fail', summary: 'A reviewed boundary is incomplete.', findings: [{ priority: 'P1', file: 'feature-a.mjs', line: 1, message: 'Implement the missing boundary.' }] } });
    delete ticket.implementation;
  });
  f.store.pause(f.config.id);
  f.store.continueInterrupted(f.config, { ticketId: 'a', expectedHeadSha: candidate.headSha, instructions: 'Implement the reviewed boundary.' });
  f.store.resume(f.config.id);
  const unexpected = path.join(prepared.workspace, 'unexpected-agent-work.txt');
  await writeFile(unexpected, 'Do not discard.\n');
  const runtime = new FixtureRuntime();
  const controller = new Controller(f.store, f.config.id, { runtime });
  await controller.step('a');
  const blocked = f.store.get(f.config.id).tickets[0];
  assert.equal(blocked.status, 'blocked'); assert.equal(blocked.blocker.code, 'continuation_identity_mismatch');
  assert.equal(blocked.attempts, 1); assert.equal(blocked.repairs, 0);
  assert.equal(runtime.calls.filter(call => call.role === 'implement').length, 0);
  assert.equal(await readFile(unexpected, 'utf8'), 'Do not discard.\n');
});
test('clean checkout autocrlf migration discards stale gates and reruns verification and review', { timeout: 90000 }, async t => {
  const f = await fixture(t), runtime = new FixtureRuntime();
  const controller = new Controller(f.store, f.config.id, { runtime });
  await statusUntil(f.store, controller, 'publishing');
  const candidate = f.store.get(f.config.id).tickets[0];
  git(candidate.workspace, 'config', '--local', 'core.autocrlf', 'true');
  git(candidate.workspace, 'reset', '--hard', candidate.headSha);
  assert.equal(git(candidate.workspace, 'status', '--porcelain'), '');

  await controller.step('a');
  const migrated = f.store.get(f.config.id).tickets[0];
  assert.equal(migrated.status, 'verifying'); assert.equal(migrated.review, null); assert.equal(migrated.verification, null);
  assert.equal(await controller.workspace.localAutocrlf(candidate.workspace), 'false');
  const result = await controller.run();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.tickets[0].reviewAttempts, 2);
  assert.equal(runtime.calls.filter(call => call.role === 'review').length, 2);
  assert.equal(result.tickets[0].review.headSha, result.tickets[0].headSha);
  assert.equal(result.tickets[0].verification.headSha, result.tickets[0].headSha);
});
