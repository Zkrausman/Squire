import test from './standalone.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import { beginJobEvidence, finishJobEvidence, readJobEvidence, recordCandidateDisposition } from '../src/job-evidence.mjs';
import { Controller } from '../src/controller.mjs';
import { FixtureRuntime, fixture, statusUntil } from './support.mjs';
import { withProducer } from '../src/producer-context.mjs';

async function evidenceFixture(t, id = 'job') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'squire-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return beginJobEvidence({ id, role: 'implement', directory: path.join(root, id) }, { ticketId: 'a', attempt: 1, continuationId: 'continuation' });
}
const completed = { outcome: 'completed', sessionRef: 'session', result: 'Done' };
test('write-once terminal manifests validate hashes and never replace prior bytes', async t => {
  const evidence = await evidenceFixture(t);
  await finishJobEvidence(evidence, { outcome: completed });
  const file = path.join(evidence.directory, 'terminal.json'), before = await readFile(file);
  assert.equal((await readJobEvidence(evidence.directory, 'job')).outcome, 'completed');
  await assert.rejects(() => finishJobEvidence(evidence, { outcome: completed }), { code: 'job_evidence_incomplete' });
  assert.deepEqual(await readFile(file), before);
  await assert.rejects(() => readJobEvidence(evidence.directory, 'other-job'), { code: 'job_evidence_incomplete' });
  await writeFile(path.join(evidence.directory, 'normalized-result.json'), '{}');
  await assert.rejects(() => readJobEvidence(evidence.directory, 'job'), { code: 'job_evidence_incomplete' });
});
test('missing, malformed, conflicting and interrupted exports remain incomplete and poison scope closure', async t => {
  const evidence = await evidenceFixture(t);
  const lifecycle = {};
  await withProducer({ lifecycle }, async () => {
    await assert.rejects(() => readJobEvidence(evidence.directory, 'job'), { code: 'job_evidence_incomplete' });
    assert.equal(lifecycle.persistenceFailed, true);
  });
  await writeFile(path.join(evidence.directory, '.terminal.interrupted.tmp'), '{');
  await assert.rejects(() => readJobEvidence(evidence.directory, 'job'), { code: 'job_evidence_incomplete' });
  await writeFile(path.join(evidence.directory, 'terminal.json'), '{');
  await assert.rejects(() => readJobEvidence(evidence.directory, 'job'), { code: 'job_evidence_incomplete' });
  await assert.rejects(() => finishJobEvidence(evidence, { outcome: { ...completed, result: 'x'.repeat(1024 * 1024) } }), { code: 'job_evidence_incomplete' });
  assert.equal(await readFile(path.join(evidence.directory, 'terminal.json'), 'utf8'), '{');
});
test('completed, failed, capacity and no-change have separate immutable facts without free-form diagnostics', async t => {
  for (const status of ['completed', 'failed', 'waiting_capacity']) {
    const evidence = await evidenceFixture(t, status);
    await finishJobEvidence(evidence, status === 'failed' ? { error: new Error('credential sentinel') } : { outcome: { ...completed, outcome: status } });
    const terminal = await readJobEvidence(evidence.directory, status);
    assert.equal(terminal.outcome, status);
    assert.ok(!JSON.stringify(terminal).includes('credential sentinel'));
    if (status === 'completed') {
      await recordCandidateDisposition(evidence, { outcome: 'no_change' });
      assert.equal(JSON.parse(await readFile(path.join(evidence.directory, 'candidate.json'))).outcome, 'no_change');
      assert.equal((await readJobEvidence(evidence.directory, status)).outcome, 'completed');
    }
  }
});
test('capacity retry of one continuation isolates physical files and retains accounting and source provenance', async t => {
  const f = await fixture(t), jobs = [];
  const runtime = new FixtureRuntime(async job => {
    jobs.push(job);
    await writeFile(path.join(job.directory, 'prompt.txt'), `prompt-${jobs.length}`);
    await writeFile(path.join(job.directory, 'result.txt'), `result-${jobs.length}`);
    await mkdir(path.join(job.directory, 'worker-temp'));
    await writeFile(path.join(job.directory, 'worker-temp', 'partial'), `partial-${jobs.length}`);
    if (jobs.length === 1) return { outcome: 'waiting_capacity', retryAt: 1, evidenceArtifacts: ['prompt.txt', 'result.txt'] };
  });
  const controller = new Controller(f.store, f.config.id, { runtime });
  await statusUntil(f.store, controller, 'prepared');
  const prepared = controller.current('a');
  const identity = await controller.workspace.identity(prepared.workspace);
  controller.transition('a', 'continuing', { attempts: 1, ...identity, interruptedContinuation: { continuationId: 'same-continuation', status: 'authorized' } });
  await controller.step('a');
  assert.equal(controller.current('a').status, 'waiting_capacity');
  const firstFiles = ['intent.json', 'terminal.json', 'prompt.txt', 'result.txt', 'worker-temp/partial'];
  const firstBytes = await Promise.all(firstFiles.map(name => readFile(path.join(jobs[0].directory, name))));
  await controller.step('a'); // Wake the existing logical continuation.
  await controller.step('a');
  assert.equal(jobs.length, 2);
  assert.notEqual(jobs[0].directory, jobs[1].directory);
  for (let i = 0; i < firstFiles.length; i++) assert.deepEqual(await readFile(path.join(jobs[0].directory, firstFiles[i])), firstBytes[i]);
  for (const job of jobs) {
    const intent = JSON.parse(await readFile(path.join(job.directory, 'intent.json')));
    assert.equal(intent.jobId, job.id); assert.equal(intent.ticketId, 'a'); assert.equal(intent.attempt, 1);
    assert.equal(intent.continuationId, 'same-continuation'); assert.equal(intent.source.headSha, identity.headSha);
  }
  assert.equal((await readJobEvidence(jobs[0].directory, jobs[0].id)).outcome, 'waiting_capacity');
  assert.equal((await readJobEvidence(jobs[1].directory, jobs[1].id)).outcome, 'completed');
  assert.equal(controller.current('a').attempts, 1); assert.equal(controller.current('a').repairs, 0);
  assert.equal(f.store.get(f.config.id).agentCalls, 2);
});
test('export failure retains debit and blocks a replacement across reopen', async t => {
  const f = await fixture(t);
  const controller = new Controller(f.store, f.config.id, { runtime: new FixtureRuntime(async job => {
    await mkdir(path.join(job.directory, 'terminal.json'));
    return completed;
  }) });
  await statusUntil(f.store, controller, 'prepared');
  await assert.rejects(() => controller.step('a'), { code: 'job_evidence_incomplete' });
  assert.equal(f.store.get(f.config.id).agentCalls, 1);
  for (let i = 0; i < 2; i++) await assert.rejects(() => new Controller(f.store, f.config.id, { runtime: new FixtureRuntime() }).step('a'), { code: 'producer_unresolved' });
  assert.equal(f.store.get(f.config.id).agentCalls, 1);
});
test('process evidence distinguishes timeout/cancellation and refuses malformed or truncated spools', async t => {
  for (const variant of ['timeout', 'cancelled', 'malformed', 'truncated', 'conflict']) {
    const evidence = await evidenceFixture(t, variant), id = '11111111-1111-4111-8111-111111111111';
    const receipt = { operationId: id, startedAt: 1, endedAt: 2, exitCode: null, timedOut: variant === 'timeout', stopped: ['timeout', 'cancelled'].includes(variant), outputExceeded: false,
      stdoutPath: path.join(evidence.directory, `${id}.stdout.log`), stderrPath: path.join(evidence.directory, `${id}.stderr.log`) };
    await writeFile(receipt.stdoutPath, variant === 'malformed' ? '{bad}\n' : variant === 'truncated' ? '{"type":' : '{"type":"turn.failed"}\n');
    await writeFile(receipt.stderrPath, 'private diagnostic sentinel');
    await writeFile(path.join(evidence.directory, `${id}.receipt.json`), JSON.stringify({ ...receipt, ...(variant === 'conflict' ? { exitCode: 9 } : {}) }));
    const error = { evidenceProcess: true, detail: { receipt } };
    if (['timeout', 'cancelled'].includes(variant)) {
      await finishJobEvidence(evidence, { error });
      const terminal = await readJobEvidence(evidence.directory, variant);
      assert.equal(terminal.outcome, variant); assert.equal(terminal.spool.records, 1);
      assert.ok(!JSON.stringify(terminal).includes('private diagnostic sentinel'));
    } else await assert.rejects(() => finishJobEvidence(evidence, { error }), { code: 'job_evidence_incomplete' });
  }
});

test('optional version-1 results remain explicitly absent and malformed manifests never pass inspection', async t => {
  const evidence = await evidenceFixture(t);
  await finishJobEvidence(evidence, { outcome: { outcome: 'completed', sessionRef: 'session' } });
  assert.equal(JSON.parse(await readFile(path.join(evidence.directory, 'normalized-result.json'))).present, false);
  const terminal = JSON.parse(await readFile(path.join(evidence.directory, 'terminal.json')));
  await writeFile(path.join(evidence.directory, 'terminal.json'), JSON.stringify({ ...terminal, artifacts: [] }));
  await assert.rejects(() => readJobEvidence(evidence.directory, 'job'), { code: 'job_evidence_incomplete' });
  await writeFile(path.join(evidence.directory, 'terminal.json'), JSON.stringify(terminal));
  await recordCandidateDisposition(evidence, { outcome: 'no_change' });
  await writeFile(path.join(evidence.directory, 'candidate.json'), '{}');
  await assert.rejects(() => readJobEvidence(evidence.directory, 'job'), { code: 'job_evidence_incomplete' });
});
test('completed result cannot bless a failed process and inspection recomputes bound spool counters', async t => {
  const evidence = await evidenceFixture(t), id = '22222222-2222-4222-8222-222222222222';
  const receipt = { operationId: id, startedAt: 1, endedAt: 2, exitCode: 9, timedOut: false, stopped: false, outputExceeded: false,
    stdoutPath: path.join(evidence.directory, `${id}.stdout.log`), stderrPath: path.join(evidence.directory, `${id}.stderr.log`) };
  await writeFile(receipt.stdoutPath, '{"type":"turn.failed"}\n');
  await writeFile(receipt.stderrPath, '');
  await writeFile(path.join(evidence.directory, `${id}.receipt.json`), JSON.stringify(receipt));
  await assert.rejects(() => finishJobEvidence(evidence, { outcome: { ...completed, receipt, evidenceProcess: true } }), { code: 'job_evidence_incomplete' });
  await finishJobEvidence(evidence, { error: { evidenceProcess: true, detail: { receipt } } });
  const terminal = JSON.parse(await readFile(path.join(evidence.directory, 'terminal.json')));
  await writeFile(path.join(evidence.directory, 'terminal.json'), JSON.stringify({ ...terminal, spool: { ...terminal.spool, records: 99 } }));
  await assert.rejects(() => readJobEvidence(evidence.directory, 'job'), { code: 'job_evidence_incomplete' });
});
test('crash after terminal export before event projection retains evidence and never adopts or redebits on reopen', async t => {
  const f = await fixture(t); let directory, jobId;
  const runtime = new FixtureRuntime(async job => { directory = job.directory; jobId = job.id; return completed; });
  const controller = new Controller(f.store, f.config.id, { runtime });
  await statusUntil(f.store, controller, 'prepared');
  const update = f.store.update.bind(f.store);
  f.store.update = (...args) => {
    if (args[2] === 'job.finished') throw Object.assign(new Error('injected crash before event projection'), { storeTransactionFailed: true });
    return update(...args);
  };
  await assert.rejects(() => controller.step('a'), /injected crash/);
  f.store.update = update;
  const bytes = await readFile(path.join(directory, 'terminal.json'));
  assert.equal((await readJobEvidence(directory, jobId)).outcome, 'completed');
  assert.equal((await readJobEvidence(directory, jobId)).disposition, null);
  for (let i = 0; i < 2; i++) await assert.rejects(() => new Controller(f.store, f.config.id, { runtime }).step('a'), { code: 'producer_unresolved' });
  assert.deepEqual(await readFile(path.join(directory, 'terminal.json')), bytes);
  assert.equal(f.store.get(f.config.id).agentCalls, 1);
});

test('opaque version-1 receipt identifiers do not invent local process provenance', async t => {
  const evidence = await evidenceFixture(t);
  await finishJobEvidence(evidence, { outcome: { ...completed, receipt: { operationId: 'provider-run-17', timedOut: true } } });
  const terminal = await readJobEvidence(evidence.directory, 'job');
  assert.equal(terminal.outcome, 'completed');
  assert.equal(terminal.process, null); assert.equal(terminal.spool, null);
  assert.ok(!JSON.stringify(terminal).includes('provider-run-17'));
});

test('opaque adapter error receipts remain uninterpreted', async t => {
  const evidence = await evidenceFixture(t);
  await finishJobEvidence(evidence, { error: { detail: { receipt: { operationId: 'provider-run', timedOut: true } } } });
  const terminal = await readJobEvidence(evidence.directory, 'job');
  assert.equal(terminal.outcome, 'failed'); assert.equal(terminal.process, null);
});
test('missing adapter outcomes and null throws retain debit and producer fence', async t => {
  for (const throws of [false, true]) {
    const f = await fixture(t);
    const runtime = new FixtureRuntime();
    runtime.execute = async () => { if (throws) throw null; return null; };
    const controller = new Controller(f.store, f.config.id, { runtime });
    await statusUntil(f.store, controller, 'prepared');
    await assert.rejects(() => controller.step('a'), { code: 'job_evidence_incomplete' });
    assert.equal(f.store.get(f.config.id).agentCalls, 1);
    await assert.rejects(() => new Controller(f.store, f.config.id, { runtime }).step('a'), { code: 'producer_unresolved' });
  }
});
