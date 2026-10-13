import test from './standalone.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { Controller } from '../src/controller.mjs';
import { Blocker, digest } from '../src/contracts.mjs';
import { LocalDelivery } from '../src/delivery.mjs';
import { pathToFileURL } from 'node:url';
import { fixture, ticket, FixtureRuntime, statusUntil, git } from './support.mjs';
import { correctiveExecution, correctiveTicket, correctiveAdmission } from './controller-fixtures.mjs';

test('unsettled planning and GitHub records block repeated startup before preflight or dispatch without spending counters', async t => {
  for (const directory of ['planning/2/job', 'github-logs']) {
    await t.test(directory, async t => {
      const f = await fixture(t), runtime = new FixtureRuntime();
      const controller = new Controller(f.store, f.config.id, { runtime });
      const preflight = t.mock.method(runtime, 'preflight');
      const target = path.join(controller.root, directory, 'previous.active.json');
      await mkdir(path.dirname(target), { recursive: true });
      f.store.update(f.config.id, state => {
        state.agentCalls = 7; state.planningAttempt = 2;
        Object.assign(state.tickets[0], { attempts: 2, repairs: 1, rebases: 1, reviewAttempts: 1 });
      });
      const before = f.store.get(f.config.id);
      const observed = t.mock.method(process, 'kill', () => true);
      t.mock.method(globalThis, 'setTimeout', callback => { queueMicrotask(callback); });
      for (const [record, message] of [
        [{ supervisorPid: process.pid, childPid: process.pid, startedAt: 1 }, 'Legacy active evidence'],
        [{ supervisorPid: process.pid }, 'Invalid active process record']
      ]) {
        await writeFile(target, JSON.stringify(record));
        for (let restart = 0; restart < 2; restart++) {
          const result = await controller.run(undefined, { wait: false });
          assert.equal(result.status, 'blocked'); assert.ok(result.blocker.message.startsWith(message));
          assert.ok(result.blocker.message.endsWith(target));
          assert.equal(result.agentCalls, before.agentCalls); assert.equal(result.planningAttempt, before.planningAttempt);
          assert.deepEqual(result.tickets, before.tickets); assert.deepEqual(result.config.limits, before.config.limits);
          assert.equal(preflight.mock.callCount(), 0); assert.equal(runtime.calls.length, 0);
          const release = f.store.lease(`controller:${f.config.id}`); release();
        }
      }
      assert.ok(observed.mock.calls.every(call => call.arguments[1] === 0), 'startup must never terminate a discovered process');
    });
  }
});
test('paused and completed projects retain their state without reconciling or dispatching', async t => {
  const f = await fixture(t), runtime = new FixtureRuntime(), controller = new Controller(f.store, f.config.id, { runtime });
  const preflight = t.mock.method(runtime, 'preflight');
  const directory = path.join(controller.root, 'planning', '1', 'job');
  await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'old.active.json'), '{}');
  for (const fields of [{ paused: true }, { paused: false, status: 'completed' }]) {
    f.store.update(f.config.id, state => Object.assign(state, fields));
    const before = f.store.get(f.config.id);
    assert.deepEqual(await controller.run(), before);
    assert.deepEqual(await controller.run(), before);
  }
  assert.equal(preflight.mock.callCount(), 0); assert.equal(runtime.calls.length, 0);
});
test('an existing controller lease prevents reconciliation and replacement dispatch', async t => {
  const f = await fixture(t), runtime = new FixtureRuntime(), controller = new Controller(f.store, f.config.id, { runtime });
  const directory = path.join(controller.root, 'github-logs');
  await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'old.active.json'), '{}');
  const before = f.store.get(f.config.id), release = f.store.lease(`controller:${f.config.id}`);
  try {
    await assert.rejects(controller.run(), error => error.code === 'lease_busy');
    assert.deepEqual(f.store.get(f.config.id), before); assert.equal(runtime.calls.length, 0);
  } finally { release(); }
});

test('three dependent tickets automatically verify, review, merge and pass integrated acceptance', { timeout: 120000 }, async t => {
  const f = await fixture(t, [ticket('a'), ticket('b', ['a']), ticket('c', ['b'])]);
  const runtime = new FixtureRuntime(), controller = new Controller(f.store, f.config.id, { runtime });
  const result = await controller.run();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.deepEqual(result.tickets.map(t => t.status), ['shipped', 'shipped', 'shipped']);
  assert.equal(runtime.calls.filter(c => c.role === 'implement').length, 3); assert.equal(runtime.calls.filter(c => c.role === 'review').length, 3);
  assert.equal(result.tickets[1].baseSha, result.tickets[0].mergeSha); assert.equal(result.tickets[2].baseSha, result.tickets[1].mergeSha);
  const delivered = git(f.root, '--git-dir', f.source, 'rev-parse', 'main'); assert.equal(delivered, result.tickets[2].mergeSha);
  assert.equal(result.acceptance.app.status, 'passed');
  assert.ok(result.tickets.every(t => t.review.headSha === t.headSha && t.verification.passed && t.postmerge.passed));
});
test('failed executable check feeds repair, invalidates evidence, then ships new commit', { timeout: 90000 }, async t => {
  const f = await fixture(t); let first = true;
  const runtime = new FixtureRuntime(async job => {
    if (job.role === 'implement' && first) { first = false; await writeFile(path.join(job.workspace, 'feature-a.mjs'), 'export const add=(a,b)=>a-b;\n'); return { outcome: 'completed', sessionRef: 'bad-first', result: 'Incorrect fixture' }; }
  });
  const result = await new Controller(f.store, f.config.id, { runtime }).run();
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.tickets[0].repairs, 1);
  assert.equal(runtime.calls.filter(c => c.role === 'implement').length, 2);
  assert.equal(runtime.calls.filter(c => c.role === 'review').length, 1);
  assert.match(runtime.calls.filter(c => c.role === 'implement')[1].instructions, /Incorrect feature/);
});
test('review rejection requires new candidate, checks and fresh review', { timeout: 90000 }, async t => {
  const f = await fixture(t); let rejected = false;
  const runtime = new FixtureRuntime(async job => {
    if (job.role === 'review' && !rejected) { rejected = true; return { outcome: 'completed', sessionRef: 'reject', result: { headSha: /HEAD ([a-f0-9]{40})/.exec(job.instructions)[1], verdict: 'fail', summary: 'Fixture finding', findings: [{ priority: 'P2', file: 'feature-a.mjs', line: 1, message: 'Add missing requested behavior' }] } }; }
  });
  const result = await new Controller(f.store, f.config.id, { runtime }).run();
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.tickets[0].repairs, 1); assert.equal(result.tickets[0].reviewAttempts, 2);
  const reviews = runtime.calls.filter(c => c.role === 'review'); assert.notEqual(/HEAD (\w+)/.exec(reviews[0].instructions)[1], /HEAD (\w+)/.exec(reviews[1].instructions)[1]);
});
test('exhausted repair budget blocks dependency instead of producing success', { timeout: 90000 }, async t => {
  const f = await fixture(t, [ticket('a'), ticket('b', ['a'])], { limits: { maxRepairs: 1 } }); let n = 0;
  const runtime = new FixtureRuntime(async job => {
    if (job.role === 'implement') { await writeFile(path.join(job.workspace, 'feature-a.mjs'), `export const add=(a,b)=>a-b;\n// ${n++}`); return { outcome: 'completed', sessionRef: `bad-${n}`, result: 'Broken' }; }
  });
  const result = await new Controller(f.store, f.config.id, { runtime }).run();
  assert.equal(result.status, 'blocked'); assert.equal(result.tickets[0].blocker.code, 'repair_budget'); assert.equal(result.tickets[1].status, 'dependency_blocked');
  assert.equal(runtime.calls.length, 2); assert.equal(git(f.root, '--git-dir', f.source, 'rev-list', '--count', 'main'), '1');
});

const plannedTicket = (id, ownedPaths, dependsOn = []) => ({
  ...ticket(id, dependsOn),
  execution: { ...structuredClone(correctiveExecution), ownedPaths }
});
async function planningFixture(t, plannedTickets) {
  const f = await fixture(t, [], ({ source, check }) => ({
    goal: 'Prepare a small complete feature outcome.',
    tickets: undefined,
    services: { app: {
      source, branch: 'main', delivery: { kind: 'local' },
      setup: [{ name: 'native-setup', argv: [process.execPath, '-e', 'void 0'], timeoutSeconds: 10 }],
      checks: [{ name: 'focused-test', argv: [process.execPath, check], timeoutSeconds: 10 }]
    } }
  }));
  const runtime = new FixtureRuntime(async (job, _runtime, sessionRef) => job.role === 'plan'
    ? { outcome: 'completed', sessionRef, result: { tickets: plannedTickets } }
    : undefined);
  return { f, runtime, controller: new Controller(f.store, f.config.id, { runtime }) };
}
test('preparation preserves alternative decompositions and captures focused tests and native commands before dispatch', { timeout: 120000 }, async t => {
  const plans = [
    plannedTicket('combined', ['src/feature.mjs', 'test/feature.test.mjs']),
    plannedTicket('code-first', ['src/separate.mjs']),
    plannedTicket('tests-second', ['test/separate.test.mjs'], ['code-first']),
    ...Array.from({ length: 18 }, (_, index) => plannedTicket(`outcome-${index}`, [`src/outcome-${index}.mjs`, `test/outcome-${index}.test.mjs`]))
  ];
  const { f, runtime, controller } = await planningFixture(t, plans);
  assert.equal(await controller.plan(), true);
  const saved = f.store.get(f.config.id).tickets;
  assert.equal(saved.length, 21);
  assert.deepEqual(saved[0].spec.execution.ownedPaths, ['src/feature.mjs', 'test/feature.test.mjs']);
  assert.deepEqual(saved[1].spec.dependsOn, []);
  assert.deepEqual(saved[2].spec.dependsOn, ['code-first']);
  assert.deepEqual(saved[0].preparation.focusedTestOwnership, {
    ticket: 'combined', authorizedPaths: ['src/feature.mjs', 'test/feature.test.mjs'],
    recognizedTestPaths: ['test/feature.test.mjs'], plannedTestOwners: [], required: true
  });
  assert.deepEqual(saved[1].preparation.focusedTestOwnership, {
    ticket: 'code-first', authorizedPaths: ['src/separate.mjs'], recognizedTestPaths: [],
    plannedTestOwners: [{ ticket: 'tests-second', paths: ['test/separate.test.mjs'] }], required: true
  });
  assert.deepEqual(saved[2].preparation.focusedTestOwnership.recognizedTestPaths, ['test/separate.test.mjs']);
  assert.equal(saved[0].preparation.nativeEnvironment.platform, process.platform);
  assert.equal(saved[0].preparation.nativeEnvironment.architecture, process.arch);
  assert.equal(saved[0].preparation.nativeEnvironment.node, process.version);
  assert.equal(saved[0].preparation.nativeEnvironment.nodeExecutable, process.execPath);
  assert.equal(saved[0].preparation.nativeEnvironment.workingDirectory, 'prepared ticket workspace');
  assert.deepEqual(saved[0].preparation.nativeEnvironment.setup, f.config.services.app.setup);
  assert.deepEqual(saved[0].preparation.nativeEnvironment.checks, f.config.services.app.checks);
  const persisted = JSON.parse(await readFile(path.join(controller.root, 'ticket-plan.json'), 'utf8'));
  assert.deepEqual(persisted[0].preparation, saved[0].preparation);

  const implementationPrompts = [];
  runtime.handler = async (job, _runtime, sessionRef) => {
    if (job.role === 'implement') {
      implementationPrompts.push(job.instructions);
      return { outcome: 'waiting_capacity', sessionRef, retryAt: Date.now() + 60_000, detail: 'Fixture only' };
    }
  };
  await controller.step('combined');
  await controller.step('combined');
  await controller.step('code-first');
  await controller.step('code-first');
  const combinedPrompt = implementationPrompts.find(prompt => prompt.includes('combined: Feature'));
  const splitPrompt = implementationPrompts.find(prompt => prompt.includes('code-first: Feature'));
  assert.ok(combinedPrompt);
  assert.ok(splitPrompt);
  assert.match(combinedPrompt, /Preparation evidence \(controller-generated before implementation dispatch\)/);
  assert.match(combinedPrompt, /focusedTestOwnership/);
  assert.match(combinedPrompt, /nativeEnvironment/);
  assert.match(combinedPrompt, new RegExp(process.platform));
  assert.match(combinedPrompt, /focused-test/);
  const evidenceMarker = 'Preparation evidence (controller-generated before implementation dispatch):\n';
  const evidenceStart = combinedPrompt.indexOf(evidenceMarker) + evidenceMarker.length;
  const evidenceEnd = combinedPrompt.indexOf('\nUse the focused test ownership', evidenceStart);
  assert.ok(evidenceStart >= evidenceMarker.length && evidenceEnd > evidenceStart);
  assert.deepEqual(JSON.parse(combinedPrompt.slice(evidenceStart, evidenceEnd)), saved[0].preparation);
  assert.match(splitPrompt, /tests-second/);
  assert.match(splitPrompt, /test\/separate\.test\.mjs/);
  assert.equal(runtime.calls.filter(call => call.role === 'implement').length, 2);
});
test('generated plans still reject unsafe ownership and missing prerequisites', { timeout: 120000 }, async t => {
  const invalidPlans = [
    { name: 'unsafe ownership', ticket: plannedTicket('unsafe', ['../outside.mjs']), message: /safe relative path/ },
    { name: 'missing dependency', ticket: plannedTicket('orphan', ['src/orphan.mjs'], ['missing']), message: /Unknown dependency/ },
    { name: 'missing focused test owner', ticket: plannedTicket('untested', ['src/untested.mjs']), message: /focused test owner/ },
    {
      name: 'unrelated test owner does not satisfy prerequisite',
      tickets: [plannedTicket('untested', ['src/untested.mjs']), plannedTicket('unrelated-tests', ['test/unrelated.test.mjs'])],
      message: /focused test owner/
    }
  ];
  for (const invalid of invalidPlans) await t.test(invalid.name, async subtest => {
    const { f, runtime, controller } = await planningFixture(subtest, invalid.tickets ?? [invalid.ticket]);
    await assert.rejects(() => controller.plan(), invalid.message);
    assert.equal(f.store.get(f.config.id).tickets.length, 0);
    assert.equal(runtime.calls.filter(call => call.role === 'implement').length, 0);
  });
});
test('explicit structured tickets expose preparation before their implementation handoff', { timeout: 120000 }, async t => {
  const spec = plannedTicket('explicit', ['feature-explicit.mjs', 'test/feature-explicit.test.mjs']);
  const f = await fixture(t, [spec]);
  let handoff;
  const runtime = new FixtureRuntime(async (job, _runtime, sessionRef) => {
    if (job.role !== 'implement') return undefined;
    const saved = f.store.get(f.config.id).tickets[0];
    const persisted = JSON.parse(await readFile(path.join(controller.root, 'ticket-plan.json'), 'utf8'))[0];
    handoff = { prompt: job.instructions, preparation: saved.preparation, persistedPreparation: persisted.preparation };
    return { outcome: 'waiting_capacity', sessionRef, retryAt: Date.now() + 60_000, detail: 'Fixture handoff captured' };
  });
  const controller = new Controller(f.store, f.config.id, { runtime });
  const result = await controller.run(undefined, { wait: false });

  assert.equal(result.status, 'waiting_capacity');
  assert.ok(handoff, 'the explicit ticket reached the implementation runtime');
  assert.deepEqual(handoff.preparation.focusedTestOwnership, {
    ticket: 'explicit', authorizedPaths: spec.execution.ownedPaths,
    recognizedTestPaths: ['test/feature-explicit.test.mjs'], plannedTestOwners: [], required: true
  });
  assert.deepEqual(handoff.preparation.nativeEnvironment, {
    platform: process.platform, architecture: process.arch, node: process.version,
    nodeExecutable: process.execPath, workingDirectory: 'prepared ticket workspace',
    setup: f.config.services.app.setup ?? [], checks: f.config.services.app.checks
  });
  assert.deepEqual(handoff.persistedPreparation, handoff.preparation);
  assert.match(handoff.prompt, /Preparation evidence \(controller-generated before implementation dispatch\)/);
  assert.match(handoff.prompt, /focusedTestOwnership/);
  assert.match(handoff.prompt, /nativeEnvironment/);
  assert.equal(runtime.calls.filter(call => call.role === 'implement').length, 1);
});
test('explicit structured tickets reject unsafe ownership and expose configured validation ownership for existing inputs', { timeout: 120000 }, async t => {
  await t.test('unsafe ownership is rejected during project validation', async subtest => {
    await assert.rejects(() => fixture(subtest, [plannedTicket('unsafe-explicit', ['../outside.mjs'])]), /safe relative path/);
  });
  await t.test('existing configured checks remain visible before implementation dispatch', async subtest => {
    const f = await fixture(subtest, [plannedTicket('untested-explicit', ['src/untested.mjs'])]);
    const runtime = new FixtureRuntime();
    const controller = new Controller(f.store, f.config.id, { runtime });
    await controller.ensureTicketPreparation();
    const result = f.store.get(f.config.id);
    assert.equal(result.tickets[0].status, 'queued');
    assert.deepEqual(result.tickets[0].preparation.focusedTestOwnership.configuredCheckOwners,
      f.config.services.app.checks.map(({name,argv})=>({name,argv})));
    assert.deepEqual(result.tickets[0].preparation.nativeEnvironment.checks,f.config.services.app.checks);
    assert.equal(runtime.calls.filter(call => call.role === 'implement').length, 0);
  });
});
test('brief plans without structured ownership retain trusted validation preparation and complete', { timeout: 120000 }, async t => {
  const { f, runtime, controller } = await planningFixture(t, [ticket('legacy')]);
  let implementationPrompt;
  runtime.handler = async (job, _runtime, sessionRef) => {
    if (job.role === 'plan') return { outcome: 'completed', sessionRef, result: { tickets: [ticket('legacy')] } };
    if (job.role === 'implement') implementationPrompt = job.instructions;
  };

  const result = await controller.run();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.tickets[0].status, 'shipped');
  assert.equal(result.tickets[0].spec.execution, undefined);
  assert.deepEqual(result.tickets[0].preparation.focusedTestOwnership, {
    ticket: 'legacy', authorizedPaths: [], recognizedTestPaths: [], plannedTestOwners: [],
    configuredCheckOwners: f.config.services.app.checks.map(({ name, argv }) => ({ name, argv })), required: true
  });
  assert.deepEqual(result.tickets[0].preparation.nativeEnvironment.checks, f.config.services.app.checks);
  assert.match(implementationPrompt, /Preparation evidence \(controller-generated before implementation dispatch\)/);
  assert.match(implementationPrompt, /configuredCheckOwners/);
  assert.match(implementationPrompt, /nativeEnvironment/);
});
async function reachCorrectionBlock(f, runtime) {
  const initial = await new Controller(f.store, f.config.id, { runtime }).run();
  assert.equal(initial.tickets[0].blocker.code, 'slice_budget', JSON.stringify(initial.tickets[0]));
  f.store.pause(f.config.id);
  const ticketState = f.store.get(f.config.id).tickets[0];
  const receipt = f.store.authorizeCorrection(f.config, correctiveAdmission(ticketState.headSha));
  assert.equal(receipt.status, 'repairing');
  f.store.resume(f.config.id);
}

test('completed failed application verification admits a bounded repair and still requires fresh gates', { timeout: 120000 }, async t => {
  const f = await fixture(t, [correctiveTicket()], { limits: { maxRepairs: 0 } });
  let implementationPrompt = '';
  const runtime = new FixtureRuntime(async job => {
    if (job.role === 'implement' && job.instructions.includes('Authorized bounded correction')) implementationPrompt = job.instructions;
    if (job.role === 'review') {
      const headSha = /HEAD ([a-f0-9]{40})/.exec(job.instructions)[1];
      return { outcome: 'completed', sessionRef: 'verification-repair-review', result: { headSha, verdict: 'pass', summary: 'All original and corrective criteria pass.', findings: [],
        checklist: ['base-one', 'base-two', 'corrective-one'].map(id => ({ id, verdict: 'pass', evidence: `Observed ${id} on this candidate.` })) } };
    }
  });
  const controller = new Controller(f.store, f.config.id, { runtime });
  await statusUntil(f.store, controller, 'prepared');
  const realRun = controller.verifier.run.bind(controller.verifier); let failCandidateCheck = true;
  controller.verifier.run = async (workspace, checks, label, signal) => {
    if (failCandidateCheck && !label.startsWith('delivered-')) {
      failCandidateCheck = false;
      return { passed: false, results: [{ name: checks[0].name, argv: checks[0].argv, passed: false, exitCode: 1, stopped: false, timedOut: false, outputExceeded: false, launchError: null, failureTail: 'Pinned manifest digest did not match.' }] };
    }
    return realRun(workspace, checks, label, signal);
  };
  const stopped = await controller.run();
  const failed = stopped.tickets[0];
  assert.equal(stopped.status, 'blocked', JSON.stringify(stopped)); assert.equal(failed.blocker.code, 'repair_budget');
  assert.equal(failed.implementation.sessionRef !== undefined, true);
  assert.equal(failed.verification.passed, false); assert.equal(failed.verification.headSha, failed.headSha);
  assert.equal(failed.verification.treeSha, failed.treeSha); assert.equal(failed.verification.policyDigest, digest(f.config.services.app.checks));
  assert.equal(failed.review, null);

  f.store.pause(f.config.id);
  const admitted = f.store.authorizeCorrection(f.config, correctiveAdmission(failed.headSha));
  assert.equal(admitted.status, 'repairing');
  assert.equal(f.store.get(f.config.id).tickets[0].correctionAdmission.evidence.proofType, 'failed_verification');
  f.store.resume(f.config.id);
  const result = await controller.run(), saved = result.tickets[0];
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(saved.status, 'shipped');
  assert.equal(saved.attempts, 2); assert.equal(saved.repairs, 1);
  assert.equal(saved.verification.passed, true); assert.equal(saved.verification.headSha, saved.headSha);
  assert.equal(saved.review.verdict, 'pass'); assert.equal(saved.review.headSha, saved.headSha);
  assert.deepEqual(saved.checklistEvidence.items.map(item => item.id), ['base-one', 'base-two', 'corrective-one']);
  assert.match(implementationPrompt, /Pinned manifest digest did not match/);
  assert.equal(runtime.calls.filter(call => call.role === 'implement').length, 2);
  assert.equal(runtime.calls.filter(call => call.role === 'review').length, 1);
});

test('admitted correction gets one implementation, fresh verification/review, and all added criteria ship as evidence', { timeout: 90000 }, async t => {
  const f = await fixture(t, [correctiveTicket()]); let reviews = 0;
  const runtime = new FixtureRuntime(async job => {
    if (job.role === 'review') {
      const headSha = /HEAD ([a-f0-9]{40})/.exec(job.instructions)[1];
      if (++reviews === 1) return { outcome: 'completed', sessionRef: 'failed-review', result: { headSha, verdict: 'fail', summary: 'Boundary behavior is missing.', findings: [{ priority: 'P1', file: 'feature-a.mjs', line: 1, message: 'Handle the reviewed boundary case.' }] } };
      return { outcome: 'completed', sessionRef: 'fresh-correction-review', result: { headSha, verdict: 'pass', summary: 'All criteria verified.', findings: [], checklist: ['base-one', 'base-two', 'corrective-one'].map(id => ({ id, verdict: 'pass', evidence: `Observed ${id} in the candidate test.` })) } };
    }
  });
  await reachCorrectionBlock(f, runtime);
  const result = await new Controller(f.store, f.config.id, { runtime }).run();
  const saved = result.tickets[0];
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(saved.status, 'shipped');
  assert.equal(saved.attempts, 2); assert.equal(saved.repairs, 1); assert.equal(reviews, 2);
  assert.equal(runtime.calls.filter(call => call.role === 'implement').length, 2);
  const evidence = saved.checklistEvidence;
  assert.deepEqual(evidence.items.map(item => item.id), ['base-one', 'base-two', 'corrective-one']);
  assert.deepEqual(evidence.correctionChecklist.map(item => item.id), ['corrective-one']);
  assert.ok(evidence.correctionAdmissionId); assert.ok(evidence.correctionDigest);
  assert.equal(evidence.headSha, saved.mergeSha); assert.equal(evidence.reviewedHeadSha, saved.headSha);
});

test('corrective attempt cannot exceed its admitted ceilings or receive a second lifetime admission', { timeout: 90000 }, async t => {
  const f = await fixture(t, [correctiveTicket()]); let reviews = 0;
  const runtime = new FixtureRuntime(async (job, runtimeApi, sessionRef) => {
    if (job.role === 'review') {
      const headSha = /HEAD ([a-f0-9]{40})/.exec(job.instructions)[1];
      reviews++;
      return { outcome: 'completed', sessionRef, result: { headSha, verdict: 'fail', summary: 'Boundary behavior is missing.', findings: [{ priority: 'P1', file: 'feature-a.mjs', line: 1, message: 'Handle the reviewed boundary case.' }] } };
    }
    if (job.role === 'implement' && runtimeApi.calls.filter(call => call.role === 'implement').length === 2) {
      await writeFile(path.join(job.workspace, 'feature-a.mjs'), 'export const add=(a,b)=>a-b;\n');
      return { outcome: 'completed', sessionRef, result: 'Attempted the correction' };
    }
  });
  await reachCorrectionBlock(f, runtime);
  const result = await new Controller(f.store, f.config.id, { runtime }).run();
  const saved = result.tickets[0];
  assert.equal(saved.status, 'blocked'); assert.equal(saved.blocker.code, 'repair_budget');
  assert.equal(saved.attempts, 2); assert.equal(saved.repairs, 1); assert.equal(reviews, 1);
  assert.equal(runtime.calls.filter(call => call.role === 'implement').length, 2);
  f.store.pause(f.config.id);
  assert.throws(() => f.store.authorizeCorrection(f.config, correctiveAdmission(saved.headSha)), /already received/);
});
test('moving base triggers new candidate verification and review before local CAS merge', { timeout: 90000 }, async t => {
  const f = await fixture(t), runtime = new FixtureRuntime(), controller = new Controller(f.store, f.config.id, { runtime });
  await statusUntil(f.store, controller, 'merging'); const old = f.store.get(f.config.id).tickets[0];
  await writeFile(path.join(f.seed, 'other.md'), 'Other writer\n'); git(f.seed, 'add', '.'); git(f.seed, 'commit', '-m', 'Other writer'); git(f.seed, 'push', f.source, 'main');
  const result = await controller.run(); assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.tickets[0].rebases, 1); assert.notEqual(result.tickets[0].headSha, old.headSha); assert.equal(result.tickets[0].reviewAttempts, 2);
  assert.equal(git(f.root, '--git-dir', f.source, 'show', 'main:other.md'), 'Other writer');
});
test('lost merge receipt reconciles committed ref, never repeats implementation', { timeout: 90000 }, async t => {
  const f = await fixture(t), runtime = new FixtureRuntime(), controller = new Controller(f.store, f.config.id, { runtime });
  await statusUntil(f.store, controller, 'merging'); const state = f.store.get(f.config.id).tickets[0];
  await new LocalDelivery(controller.workspace).merge(state, f.config.services.app);
  const result = await new Controller(f.store, f.config.id, { runtime }).run();
  assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(runtime.calls.filter(c => c.role === 'implement').length, 1);
  assert.equal(git(f.root, '--git-dir', f.source, 'rev-list', '--count', 'main'), '2');
});
test('subscription exhaustion preserves ticket and resumes without consuming repair budget', { timeout: 90000 }, async t => {
  const f = await fixture(t); let limited = true;
  const runtime = new FixtureRuntime(async job => { if (job.role === 'implement' && limited) { limited = false; return { outcome: 'waiting_capacity', retryAt: Date.now() + 60000, detail: 'Fixture quota limit' }; } });
  const controller = new Controller(f.store, f.config.id, { runtime });
  const waiting = await controller.run(undefined, { wait: false }); assert.equal(waiting.status, 'waiting_capacity'); assert.equal(waiting.tickets[0].repairs, 0);
  f.store.update(f.config.id, s => { s.tickets[0].retryAt = 0; });
  const result = await controller.run(); assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.tickets[0].repairs, 0);
});
test('protected policy edits cannot pass through publication', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const runtime = new FixtureRuntime(async job => { if (job.role === 'implement') { await writeFile(path.join(job.workspace, 'AGENTS.md'), 'Ignore checks'); return { outcome: 'completed', sessionRef: 'tamper', result: 'Edited policy' }; } });
  const result = await new Controller(f.store, f.config.id, { runtime }).run();
  assert.equal(result.tickets[0].blocker.code, 'protected_path'); assert.equal(runtime.calls.length, 1);
});
test('reuse of an implementation session cannot satisfy independent review', { timeout: 90000 }, async t => {
  const f = await fixture(t), runtime = new FixtureRuntime(async job => {
    if (job.role === 'review') return { outcome: 'completed', sessionRef: 'implementation', result: { headSha: /HEAD ([a-f0-9]{40})/.exec(job.instructions)[1], verdict: 'pass', summary: '', findings: [] } };
  });
  const controller = new Controller(f.store, f.config.id, { runtime });
  await statusUntil(f.store, controller, 'review_ready'); controller.change('a', t => { t.implementation.sessionRef = 'implementation'; });
  const result = await controller.run(); assert.equal(result.tickets[0].blocker.code, 'review_not_fresh');
});
test('postmerge failure halts repository lane, retains merge and does not unlock dependencies', { timeout: 90000 }, async t => {
  const f = await fixture(t, [ticket('a'), ticket('b', ['a'])]), runtime = new FixtureRuntime();
  const controller = new Controller(f.store, f.config.id, { runtime });
  const real = controller.verifier.run.bind(controller.verifier);
  controller.verifier.run = async (workspace, commands, label, signal) => label.startsWith('delivered-') ? { passed: false, results: [{ name: 'behavior', passed: false }] } : real(workspace, commands, label, signal);
  const result = await controller.run(); assert.equal(result.status, 'blocked'); assert.equal(result.tickets[0].blocker.code, 'postmerge_failed'); assert.ok(result.tickets[0].mergeSha); assert.equal(result.tickets[1].status, 'dependency_blocked');
  assert.equal(runtime.calls.filter(c => c.role === 'implement').length, 1);
});
test('conflicting base changes become bounded agent repair on a fresh updated workspace', { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.seed, 'feature-a.mjs'), 'export const add=(a,b)=>a+b;\n// baseline\n'); git(f.seed, 'add', '.'); git(f.seed, 'commit', '-m', 'baseline feature'); git(f.seed, 'push', f.source, 'main');
  const runtime = new FixtureRuntime(async job => {
    if (job.role === 'implement' && job.instructions.includes('rebase_conflict')) {
      await writeFile(path.join(job.workspace, 'feature-a.mjs'), "export const add=(a,b)=>{if(typeof a!=='number'||typeof b!=='number')throw new TypeError('numeric inputs');return a+b};\n// repaired\n");
      return { outcome: 'completed', sessionRef: 'conflict-repair', result: 'Repaired while retaining updated validation' };
    }
  });
  const controller = new Controller(f.store, f.config.id, { runtime }); await statusUntil(f.store, controller, 'merging');
  await writeFile(path.join(f.seed, 'feature-a.mjs'), "export const add=(a,b)=>{if(typeof a!=='number'||typeof b!=='number')throw new TypeError('numeric inputs');return a+b};\n// updated base\n");
  git(f.seed, 'add', '.'); git(f.seed, 'commit', '-m', 'new validation contract'); git(f.seed, 'push', f.source, 'main');
  const result = await controller.run(); assert.equal(result.status, 'completed', JSON.stringify(result));
  const saved = result.tickets[0]; assert.equal(saved.repairs, 1); assert.equal(saved.rebases, 1); assert.equal(saved.previousWorkspaces.length, 1); assert.equal(saved.reviewAttempts, 2);
  const module = await import(pathToFileURL(path.join(controller.root, 'delivered', `a-${saved.mergeSha}`, 'feature-a.mjs')));
  assert.equal(module.add(2, 3), 5); assert.throws(() => module.add('invalid', 1), TypeError);
});
