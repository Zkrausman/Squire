import test from './standalone.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, link, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Controller } from '../src/controller.mjs';
import { assertCriterionDefinitions, resolveCriterionEvidence } from '../src/criterion-evidence.mjs';
import { digest, validateTickets, validateReview, reviewSchemaFor, reviewSchema } from '../src/contracts.mjs';
import { CodexRuntime } from '../src/runtime-codex.mjs';
import { fixture, ticket, FixtureRuntime, statusUntil, git } from './support.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const execution = (owner, evidenceKinds = ['configured-check']) => ({ version: 2, outcome: 'Implement feature a',
  ownedPaths: ['feature-a.mjs'], contextPaths: [], invariants: ['Keep exact checked behavior'],
  checklist: [{ id: 'behavior', assertion: 'Addition works', steps: ['Run frozen behavior check'], evidence: 'Current configured check receipt', evidenceKinds, checks: ['behavior'] }],
  checkOwnership: [owner], stopWhen: 'Stop at unresolved evidence', maxAttempts: 2 });
async function strongFixture(t, { kind, review, repair = false } = {}) {
  const f = await fixture(t, [ticket('a')], async ({ check }) => ({ tickets: [{ ...ticket('a'), execution: execution({ check: 'behavior', kind: 'trusted-node-file', path: check, sha256: sha(await readFile(check)) }, kind ? [kind] : undefined) }] }));
  let broken = repair;
  const runtime = new FixtureRuntime(async (job, _runtime, sessionRef) => {
    if (job.role === 'implement' && broken) {
      broken = false; await writeFile(path.join(job.workspace, 'feature-a.mjs'), 'export const add=(a,b)=>a-b;\n');
      return { outcome: 'completed', sessionRef, result: 'Incorrect first candidate' };
    }
    if (job.role !== 'review') return;
    const saved = f.store.get(f.config.id).tickets[0];
    const result = { version: 2, headSha: saved.headSha, verdict: 'pass', summary: 'Observed current criterion', findings: [],
      checklist: [{ id: 'behavior', verdict: 'pass', evidence: 'Frozen owner check passed', observationIds: [`${saved.verification.checkEvidence.reference.id}:0`] }] };
    if (review) review(result, saved);
    assert.equal(job.provenance.reviewExecution.version, 2);
    return { outcome: 'completed', sessionRef, result };
  });
  const controller = new Controller(f.store, f.config.id, { runtime });
  return { ...f, controller, runtime };
}

test('version2 delivers exact reviewed and delivered criterion receipts through actual controller gates', { timeout: 90000 }, async t => {
  const f = await strongFixture(t), result = await f.controller.run();
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const saved = result.tickets[0]; assert.equal(saved.status, 'shipped');
  assert.equal(saved.acceptedCriteria.version, 2); assert.equal(saved.acceptedCriteria.headSha, saved.mergeSha);
  assert.notEqual(saved.criterionEvidence.candidate.reference.id, saved.criterionEvidence.delivered.reference.id);
  assert.equal(saved.criterionEvidence.delivered.phase, 'postmerge-verification');
  assert.deepEqual(saved.review.checklist[0].observationIds, saved.criterionEvidence.candidate.criteria[0].observationIds);
  assert.deepEqual((await resolveCriterionEvidence(f.store, f.config.id, 'a', 'postmerge-verification')).criteria, saved.acceptedCriteria.criteria);
  assert.equal(f.runtime.calls.filter(c => c.role === 'review').length, 1);
});

test('repair retains old failed observation bytes but requires new-head proof and fresh references', { timeout: 90000 }, async t => {
  const f = await strongFixture(t, { repair: true });
  await statusUntil(f.store, f.controller, 'repairing');
  assert.equal(f.store.get(f.config.id).tickets[0].verification, null);
  const retained = await readdir(path.join(f.controller.root, 'check-evidence')); assert.equal(retained.length, 1);
  const old = { id: retained[0] };
  const oldFile = path.join(f.controller.root, 'check-evidence', old.id, 'manifest.json'), oldBytes = await readFile(oldFile);
  const result = await f.controller.run(); assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.notEqual(result.tickets[0].criterionEvidence.candidate.reference.id, old.id);
  assert.deepEqual(await readFile(oldFile), oldBytes);
  assert.equal(result.tickets[0].repairs, 1);
});

test('persuasive passing review with nonexistent observation IDs is blocked before publication', { timeout: 90000 }, async t => {
  const f = await strongFixture(t, { review: result => { result.checklist[0].observationIds = [`${randomUUID()}:0`]; } });
  const result = await f.controller.run(); assert.equal(result.tickets[0].status, 'blocked');
  assert.match(result.tickets[0].blocker.message, /nonexistent or incompatible evidence/);
  assert.equal(result.tickets[0].publication, undefined); assert.equal(git(f.root, '--git-dir', f.source, 'rev-list', '--count', 'main'), '1');
});

test('tampered receipt after fresh review blocks existing delivery without spending another call', { timeout: 90000 }, async t => {
  const f = await strongFixture(t); await statusUntil(f.store, f.controller, 'publishing');
  const saved = f.store.get(f.config.id).tickets[0], calls = f.runtime.calls.length;
  await writeFile(path.join(f.controller.root, 'check-evidence', saved.verification.checkEvidence.reference.id, '0.stdout.txt'), 'altered');
  await f.controller.step('a');
  assert.equal(f.store.get(f.config.id).tickets[0].blocker.code, 'criterion_evidence_incomplete');
  assert.equal(f.runtime.calls.length, calls); assert.equal(git(f.root, '--git-dir', f.source, 'rev-list', '--count', 'main'), '1');
});

for (const kind of ['browser', 'native', 'screenshot', 'human']) test(`unsupported ${kind} requirement cannot be replaced by a command or mock`, async t => {
  const f = await strongFixture(t, { kind }); await f.controller.step('a');
  assert.equal(f.store.get(f.config.id).tickets[0].blocker.code, 'criterion_kind_unsupported');
  assert.equal(f.runtime.calls.length, 0); assert.equal(f.store.get(f.config.id).agentCalls, 0);
});

test('changed frozen oracle blocks before a worker call', async t => {
  const f = await strongFixture(t); await writeFile(f.check, 'process.exit(0)'); await f.controller.step('a');
  assert.equal(f.store.get(f.config.id).tickets[0].blocker.code, 'criterion_oracle_changed'); assert.equal(f.runtime.calls.length, 0);
});

test('inline owner policy is frozen and candidate-controlled check files are ineligible', async t => {
  const f = await fixture(t), root = path.join(f.stateDir, 'projects', f.config.id);
  await mkdir(root, { recursive: true });
  const inline = { name: 'behavior', argv: ['node', '-e', 'if(1+1!==2)process.exit(1)'], timeoutSeconds: 1 };
  const spec = execution({ check: 'behavior', kind: 'trusted-inline-node', path: null, sha256: digest(inline) });
  await assertCriterionDefinitions(spec, { checks: [inline] }, root);
  await assert.rejects(assertCriterionDefinitions(spec, { checks: [{ ...inline, argv: ['node', '-e', 'process.exit(0)'] }] }, root), { code: 'criterion_oracle_changed' });
  await assert.rejects(assertCriterionDefinitions(execution({ check: 'behavior', kind: 'trusted-node-file', path: f.check, sha256: sha(await readFile(f.check)) }), { checks: [{ ...inline, argv: [process.execPath, path.relative(process.cwd(), f.check)] }] }, root), { code: 'criterion_oracle_changed' });
  const alias = path.join(root, 'oracle-alias'); await link(f.check, alias);
  await assert.rejects(assertCriterionDefinitions(execution({ check: 'behavior', kind: 'trusted-node-file', path: f.check, sha256: sha(await readFile(f.check)) }), { checks: [{ ...inline, argv: [process.execPath, f.check] }] }, root), { code: 'criterion_oracle_changed' });
  await unlink(alias);
  const owned = path.join(root, 'check.mjs'); await writeFile(owned, 'process.exit(0)');
  await assert.rejects(assertCriterionDefinitions(execution({ check: 'behavior', kind: 'trusted-node-file', path: owned, sha256: sha(await readFile(owned)) }), { checks: [{ ...inline, argv: [process.execPath, owned] }] }, root), { code: 'criterion_oracle_changed' });
});

test('version2 schema requires references while version1 remains unchanged; invalid mapping refuses admission', () => {
  assert.equal(reviewSchemaFor({ version: 1 }), reviewSchema);
  assert.ok(reviewSchemaFor({ version: 2 }).properties.checklist.items.required.includes('observationIds'));
  const spec = { ...ticket('a'), execution: execution({ check: 'unknown', kind: 'trusted-inline-node', path: null, sha256: digest('wrong') }) };
  assert.throws(() => validateTickets([spec], { app: { checks: [{ name: 'behavior' }] } }), /frozen check ownership/);
  const value = { version: 2, headSha: 'a'.repeat(40), verdict: 'pass', summary: 'Strong prose', findings: [], checklist: [{ id: 'behavior', verdict: 'pass', evidence: 'Says it passed', observationIds: [] }] };
  assert.throws(() => validateReview(value, value.headSha, execution({ check: 'behavior', kind: 'trusted-inline-node', path: null, sha256: digest('x') })), /Current criterion proof/);
});

test('runtime writes the version2 reference schema through its existing job producer without live inference', async t => {
  const f = await fixture(t), directory = path.join(f.root, 'schema-job');
  const script = path.join(f.root, 'fake-schema-cli.mjs');
  await writeFile(script, `import {writeFileSync,readFileSync} from 'node:fs'; const a=process.argv.slice(2); const schema=JSON.parse(readFileSync(a[a.indexOf('--output-schema')+1])); if(schema.properties.version.const!==2 || !schema.properties.checklist.items.required.includes('observationIds'))process.exit(7); writeFileSync(a[a.indexOf('-o')+1],JSON.stringify({version:2,headSha:'${'a'.repeat(40)}',verdict:'fail',summary:'fixture',findings:[],checklist:[]})); console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-schema'}));console.log(JSON.stringify({type:'turn.completed',usage:{}}));`);
  const runtime = new CodexRuntime({ command: [process.execPath, script] }, f.root);
  t.mock.method(runtime, 'preflight', async () => {}); t.mock.method(runtime, 'settings', async () => ({ model: 'offline-fixture', reasoning: 'low' }));
  const result = await runtime.execute({ id: randomUUID(), role: 'review', workspace: f.seed, directory, instructions: 'Offline schema fixture', timeoutSeconds: 10, backoffSeconds: 1, provenance: { reviewExecution: { version: 2 } } });
  assert.equal(result.outcome, 'completed'); assert.equal(result.result.version, 2);
});

test('current proof rejects changed candidate, contract, policy and failed result without trusting cached projections', { timeout: 90000 }, async t => {
  const f = await strongFixture(t); await statusUntil(f.store, f.controller, 'publishing');
  const original = f.store.get(f.config.id), calls = f.runtime.calls.length;
  for (const mutate of [
    state => { state.tickets[0].headSha = 'b'.repeat(40); },
    state => { state.tickets[0].spec.execution.checklist[0].assertion = 'Different criterion'; },
    state => { state.config.services.app.checks[0].timeoutSeconds++; },
    state => { state.tickets[0].verification.results[0].passed = false; },
    state => { delete state.tickets[0].verification.checkEvidence; }
  ]) {
    f.store.update(f.config.id, mutate);
    await assert.rejects(resolveCriterionEvidence(f.store, f.config.id, 'a'), { code: 'criterion_evidence_incomplete' });
    f.store.update(f.config.id, state => Object.assign(state, structuredClone(original)));
  }
  assert.equal(f.runtime.calls.length, calls);
});

test('version2 still rejects an implementation session reused for review', { timeout: 90000 }, async t => {
  const f = await strongFixture(t);
  const original = f.runtime.handler;
  f.runtime.handler = async (...args) => {
    const result = await original(...args);
    if (result && args[0].role === 'review') result.sessionRef = f.store.get(f.config.id).tickets[0].implementation.sessionRef;
    return result;
  };
  const result = await f.controller.run();
  assert.equal(result.tickets[0].blocker.code, 'review_not_fresh'); assert.equal(result.tickets[0].publication, undefined);
});
