import test from './standalone.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Controller } from '../src/controller.mjs';
import { assertCriterionDefinitions, resolveCriterionEvidence } from '../src/criterion-evidence.mjs';
import { digest } from '../src/contracts.mjs';
import { fixture, ticket, FixtureRuntime, statusUntil } from './support.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const execution = (owner, declaredInputs) => ({ version: 2, outcome: 'Implement feature a', ownedPaths: ['feature-a.mjs'], contextPaths: [],
  invariants: ['Keep exact checked behavior'],
  checklist: [{ id: 'behavior', assertion: 'Addition works', steps: ['Run frozen behavior check'], evidence: 'Current configured check receipt',
    evidenceKinds: ['configured-check'], checks: ['behavior'] }],
  checkOwnership: [owner], stopWhen: 'Stop at unresolved evidence', maxAttempts: 2,
  ...(declaredInputs ? { declaredInputs } : {}) });

async function strongFixture(t, { withManifest = true } = {}) {
  const content = Buffer.from('Owner-reviewed helper data; verifier must not execute it.');
  const f = await fixture(t, [ticket('a')], async ({ root, check }) => {
    const ownerRoot = path.join(root, 'owner-inputs'); await mkdir(ownerRoot);
    await writeFile(path.join(ownerRoot, 'helper.txt'), content);
    await writeFile(path.join(ownerRoot, 'unlisted.txt'), 'initial unrelated file');
    const declaredInputs = { version: 1, root: ownerRoot, files: [{ path: 'helper.txt', sha256: sha(content) }] };
    const owner = { check: 'behavior', kind: 'trusted-node-file', path: check, sha256: sha(await readFile(check)) };
    return { tickets: [{ ...ticket('a'), execution: execution(owner, withManifest ? declaredInputs : undefined) }] };
  });
  const runtime = new FixtureRuntime(async (job, _runtime, sessionRef) => {
    if (job.role !== 'review') return;
    const saved = f.store.get(f.config.id).tickets[0];
    return { outcome: 'completed', sessionRef, result: { version: 2, headSha: saved.headSha, verdict: 'pass', summary: 'Observed current criterion', findings: [],
      checklist: [{ id: 'behavior', verdict: 'pass', evidence: 'Frozen owner check passed', observationIds: [`${saved.verification.checkEvidence.reference.id}:0`] }] } };
  });
  const controller = new Controller(f.store, f.config.id, { runtime });
  return { ...f, controller, runtime, ownerRoot: path.join(f.root, 'owner-inputs'), helper: path.join(f.root, 'owner-inputs', 'helper.txt'),
    unlisted: path.join(f.root, 'owner-inputs', 'unlisted.txt'), content };
}

test('opt-in delivery projects only the narrow declared-input assurance on candidate, delivered and accepted proof', { timeout: 120000 }, async t => {
  const f = await strongFixture(t), result = await f.controller.run();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const saved = result.tickets[0], manifest = saved.spec.execution.declaredInputs;
  const expected = { label: 'declared inputs verified', manifestDigest: digest(manifest), dependencyCoverage: 'UNKNOWN', loaderEnvironment: 'UNKNOWN' };
  assert.deepEqual(saved.criterionEvidence.candidate.oracleAssurance, expected);
  assert.deepEqual(saved.criterionEvidence.delivered.oracleAssurance, expected);
  assert.deepEqual(saved.acceptedCriteria.oracleAssurance, expected);
  const serialized = JSON.stringify(expected);
  assert.equal(serialized.includes(f.ownerRoot), false);
  assert.equal(serialized.includes(f.content.toString()), false);
  await writeFile(f.unlisted, 'unlisted file changed after delivery');
  const candidate = await resolveCriterionEvidence(f.store, f.config.id, 'a');
  const delivered = await resolveCriterionEvidence(f.store, f.config.id, 'a', 'postmerge-verification');
  assert.deepEqual(candidate.oracleAssurance, expected);
  assert.deepEqual(delivered.oracleAssurance, expected);
});

test('changed listed helper blocks before worker dispatch', { timeout: 120000 }, async t => {
  const f = await strongFixture(t);
  await writeFile(f.helper, 'changed helper content');
  await f.controller.step('a');
  const saved = f.store.get(f.config.id).tickets[0];
  assert.equal(saved.status, 'blocked');
  assert.equal(saved.blocker.code, 'criterion_inputs_changed');
  assert.equal(f.runtime.calls.length, 0);
  assert.equal(f.store.get(f.config.id).agentCalls, 0);
});

test('changed listed helper invalidates retained candidate and delivered observations', { timeout: 120000 }, async t => {
  const f = await strongFixture(t), result = await f.controller.run();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  await writeFile(f.helper, 'changed helper content');
  await assert.rejects(resolveCriterionEvidence(f.store, f.config.id, 'a'), { code: 'criterion_inputs_changed' });
  await assert.rejects(resolveCriterionEvidence(f.store, f.config.id, 'a', 'postmerge-verification'), { code: 'criterion_inputs_changed' });
});

test('a different valid owner manifest cannot rebind existing A2 observations', { timeout: 120000 }, async t => {
  const f = await strongFixture(t);
  await statusUntil(f.store, f.controller, 'publishing');
  const saved = f.store.get(f.config.id).tickets[0], manifest = structuredClone(saved.spec.execution.declaredInputs);
  await writeFile(path.join(f.ownerRoot, 'helper-copy.txt'), f.content);
  manifest.files[0].path = 'helper-copy.txt';
  await assertCriterionDefinitions({ ...saved.spec.execution, declaredInputs: manifest }, f.config.services.app, f.controller.root);
  f.store.update(f.config.id, state => { state.tickets[0].spec.execution.declaredInputs = manifest; });
  await assert.rejects(resolveCriterionEvidence(f.store, f.config.id, 'a'), { code: 'criterion_evidence_incomplete' });
});

test('entry-only version 2 keeps the prior projection without oracleAssurance', { timeout: 120000 }, async t => {
  const f = await strongFixture(t, { withManifest: false }), result = await f.controller.run();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const saved = result.tickets[0];
  assert.equal(saved.criterionEvidence.candidate.oracleAssurance, undefined);
  assert.equal(saved.criterionEvidence.delivered.oracleAssurance, undefined);
  assert.equal(Object.hasOwn(saved.acceptedCriteria, 'oracleAssurance'), false);
});
