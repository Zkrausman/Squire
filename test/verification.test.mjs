import test from './standalone.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, readFile, writeFile } from 'node:fs/promises';
import { VerificationRunner } from '../src/verification.mjs';
import { digest } from '../src/contracts.mjs';
import { randomUUID } from 'node:crypto';
import { fixture } from './support.mjs';

const checkNames = ['first', 'middle', 'last'];

const structuredTicket = () => ({
  id: 'a', service: 'app', title: 'Feature a', description: 'Implement feature a.',
  acceptance: ['Feature behavior is correct.'], dependsOn: [],
  execution: {
    version: 1, outcome: 'Implement feature a.', ownedPaths: ['feature-a.mjs'], contextPaths: [],
    invariants: ['Keep the exported feature stable.'],
    checklist: [{ id: 'base-one', assertion: 'Basic behavior works.', steps: ['Run the behavior check.'], evidence: 'Passing assertion.' }],
    stopWhen: 'Stop after one unresolved outcome.', maxAttempts: 1
  }
});

async function checkedFixture(t, failingIndex = -1) {
  const markers = [];
  const f = await fixture(t, [structuredTicket()], async ({ root, source }) => {
    const checks = [];
    for (let index = 0; index < checkNames.length; index++) {
      const marker = path.join(root, `${checkNames[index]}.marker`);
      const script = path.join(root, `${checkNames[index]}.mjs`);
      markers.push(marker);
      await writeFile(script, [
        "import { writeFile } from 'node:fs/promises';",
        `await writeFile(${JSON.stringify(marker)}, 'ran');`,
        'await new Promise(resolve => setTimeout(resolve, 100));',
        ...(index === failingIndex ? ['process.exitCode = 7;'] : [])
      ].join('\n'));
      checks.push({ name: `check-${index + 1}`, argv: [process.execPath, script], timeoutSeconds: 10 });
    }
    return { services: { app: { source, branch: 'main', delivery: { kind: 'local' }, checks } } };
  });
  return { ...f, markers };
}

test('middle failure stops execution and reports later checks as NOTRUN without receipt fields', async t => {
  const f = await checkedFixture(t, 1);
  const checks = f.config.services.app.checks;
  const result = await new VerificationRunner(f.root).run(f.seed, checks, 'middle-failure');

  assert.equal(result.passed, false);
  assert.deepEqual(result.results.map(item => item.name), ['check-1', 'check-2']);
  assert.equal(result.results[0].passed, true);
  assert.equal(result.results[1].passed, false);
  assert.equal(result.results[1].exitCode, 7);
  assert.deepEqual(result.notRun, [{ name: 'check-3', status: 'NOTRUN' }]);
  assert.equal(Object.hasOwn(result.notRun[0], 'durationMs'), false);
  assert.equal(Object.hasOwn(result.notRun[0], 'exitCode'), false);
  assert.equal(Object.hasOwn(result.notRun[0], 'operationId'), false);

  assert.equal(await readFile(f.markers[0], 'utf8'), 'ran');
  assert.equal(await readFile(f.markers[1], 'utf8'), 'ran');
  await assert.rejects(access(f.markers[2]), { code: 'ENOENT' });

  // The existing correction-admission consumer accepts its established
  // executed-results receipt shape while preserving the additive NOTRUN list.
  const headSha = 'a'.repeat(40), treeSha = 'b'.repeat(40);
  const verification = { ...result, headSha, treeSha, policyDigest: digest(checks) };
  f.store.update(f.config.id, state => Object.assign(state.tickets[0], {
    status: 'blocked', attempts: 1, repairs: 0, rebases: 0,
    workspace: path.join(f.root, 'workspaces', 'a-1'), generation: 1,
    baseSha: 'c'.repeat(40), headSha, treeSha,
    blocker: { code: 'repair_budget', message: 'A required verification check failed.' },
    implementation: { sessionRef: 'completed-implementation', jobId: 'implementation-job' },
    verification
  }));
  f.store.pause(f.config.id);
  const correction = {
    ticketId: 'a', expectedHeadSha: headSha, outcome: 'Handle the failed check.',
    instructions: 'Keep the correction within feature-a.mjs.',
    checklist: [{ id: 'correction-one', assertion: 'The correction is covered.', steps: ['Run its regression.'], evidence: 'Observed expected output.' }]
  };
  assert.equal(f.store.authorizeCorrection(f.config, correction).status, 'repairing');
  const saved = f.store.get(f.config.id).tickets[0];
  assert.deepEqual(saved.correctionAdmission.evidence.originalVerification.notRun, result.notRun);
  assert.deepEqual(saved.repairReason.actualFailure.failedChecks, [
    { name: 'check-2', exitCode: 7, failureTail: verification.results[1].failureTail }
  ]);
});

test('first failure reports the complete unrun suffix and leaves later markers absent', async t => {
  const f = await checkedFixture(t, 0);
  const result = await new VerificationRunner(f.root).run(f.seed, f.config.services.app.checks, 'first-failure');

  assert.equal(result.passed, false);
  assert.deepEqual(result.results.map(item => item.name), ['check-1']);
  assert.equal(result.results[0].passed, false);
  assert.equal(result.results[0].exitCode, 7);
  assert.deepEqual(result.notRun, [
    { name: 'check-2', status: 'NOTRUN' },
    { name: 'check-3', status: 'NOTRUN' }
  ]);
  assert.equal(Object.hasOwn(result.notRun[0], 'exitCode'), false);
  assert.equal(Object.hasOwn(result.notRun[1], 'operationId'), false);

  assert.equal(await readFile(f.markers[0], 'utf8'), 'ran');
  await assert.rejects(access(f.markers[1]), { code: 'ENOENT' });
  await assert.rejects(access(f.markers[2]), { code: 'ENOENT' });
});

test('all passing checks keep their execution receipts and return an empty NOTRUN list', async t => {
  const f = await checkedFixture(t);
  const result = await new VerificationRunner(f.root).run(f.seed, f.config.services.app.checks, 'all-pass');

  assert.equal(result.passed, true);
  assert.deepEqual(result.results.map(item => item.name), ['check-1', 'check-2', 'check-3']);
  assert.ok(result.results.every(item => item.passed && Number.isSafeInteger(item.exitCode) && item.operationId));
  assert.deepEqual(result.notRun, []);
  for (const marker of f.markers) assert.equal(await readFile(marker, 'utf8'), 'ran');
});

const binding = { phase: 'candidate-verification', projectId: 'fixture', ticketId: 'ticket', serviceId: 'app',
  candidateCheckpointId: randomUUID(), baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), treeSha: 'c'.repeat(40),
  attempt: 1, generation: 1, producerScopeId: randomUUID(), contractDigest: null, correctionAdmission: null,
  policyDigest: null, implementationJobId: null };
const checks = ['first', 'second', 'third'].map(name => ({ name, argv: ['node', '-e', name], timeoutSeconds: 1 }));
const receipt = (operationId, overrides = {}) => ({ operationId, argv: ['/usr/bin/node', '-e', 'check'], startedAt: 10, endedAt: 20,
  exitCode: 0, stopped: false, timedOut: false, outputExceeded: false, launchError: null, stdout: 'out', stderr: '', ...overrides });

test('legacy verification keeps its result shape while candidate evidence records not_run additively', async () => {
  const outputs = [receipt(randomUUID()), receipt(randomUUID(), { stopped: true }), receipt(randomUUID())];
  let index = 0;
  const runner = new VerificationRunner('/unused', { processRunner: async () => outputs[index++] });
  const legacy = await runner.run('/workspace', checks, 'legacy');
  assert.deepEqual(Object.keys(legacy), ['passed', 'results', 'notRun']);
  assert.equal(legacy.passed, false);
  assert.equal(legacy.results.length, 2);
  assert.deepEqual(legacy.results.map(item => item.passed), [true, false]);
  assert.match(legacy.results[1].failureTail, /out/);

  index = 0;
  const evidence = await runner.runForCandidate('/workspace', checks, 'candidate', undefined,
    { ...binding, policyDigest: digest(checks) });
  assert.equal(evidence.passed, false);
  assert.equal(evidence.results.length, 2);
  assert.deepEqual(evidence.evidenceDraft.checks.map(item => item.state), ['passed', 'failed', 'not_run']);
  assert.equal(evidence.evidenceDraft.checks[2].output.state, 'not_run');
});

for (const [label, flags] of [
  ['stopped', { stopped: true }], ['timed out', { timedOut: true }],
  ['output limited', { outputExceeded: true }], ['launch failed', { launchError: 'missing executable' }]
]) test(`exit zero with ${label} flags never becomes a passing verification`, async () => {
  const runner = new VerificationRunner('/unused', { processRunner: async () => receipt(randomUUID(), flags) });
  const result = await runner.run('/workspace', [checks[0]], 'candidate');
  assert.equal(result.results[0].exitCode, 0);
  assert.equal(result.passed, false);
});
