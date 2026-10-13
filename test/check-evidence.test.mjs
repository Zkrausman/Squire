import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, lstat, link, symlink, unlink, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fixture, ticket } from './support.mjs';
import { VerificationRunner } from '../src/verification.mjs';
import { persistCandidateCheckEvidence } from '../src/check-evidence.mjs';
import { inspectChecks } from '../src/inspect-checks.mjs';
import { digest } from '../src/contracts.mjs';
import { withProducer } from '../src/producer-context.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

async function stateFingerprint(root) {
  const result = [];
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const filename = path.join(directory, name), relative = path.relative(root, filename), stat = await lstat(filename);
      if (stat.isDirectory()) { result.push([relative, 'directory', stat.mtimeMs, stat.ctimeMs]); await walk(filename); }
      else if (stat.isFile()) result.push([relative, 'file', stat.size, stat.mtimeMs, stat.ctimeMs, sha256(await readFile(filename))]);
      else result.push([relative, 'other', stat.mode, stat.mtimeMs, stat.ctimeMs]);
    }
  }
  await walk(root);
  return result;
}

async function makeBoundEvidence(t, { rebased = false, checkpointPhase = 'projected' } = {}) {
  const checks = [
    { name: 'fails', argv: [process.execPath, '-e', 'process.stdout.write("deterministic check failure");process.exit(9)'], timeoutSeconds: 10 },
    { name: 'not-run', argv: [process.execPath, '-e', 'process.stdout.write("must not execute")'], timeoutSeconds: 10 }
  ];
  const f = await fixture(t, [ticket('a')], ({ source }) => ({ services: { app: {
    source, branch: 'main', delivery: { kind: 'local' }, checks, setup: [], acceptance: []
  } } }));
  const currentChecks = f.config.services.app.checks;
  const projectRoot = path.join(f.stateDir, 'projects', f.config.id);
  await mkdir(projectRoot, { recursive: true });
  const lease = f.store.lease('ticket:check-evidence-test');
  const scopeId = f.store.beginProducer(f.config.id, 'ticket:a', lease, []);
  const checkpoint = { candidateCheckpointId: randomUUID(), baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), treeSha: 'c'.repeat(40),
    attempt: 1, generation: 1 };
  const candidate = rebased ? { ...checkpoint, baseSha: 'd'.repeat(40), headSha: 'e'.repeat(40), treeSha: 'f'.repeat(40) } : checkpoint;
  const checkpointNow = Date.now();
  f.store.db.prepare(`INSERT INTO candidate_checkpoints
    (id,project,ticket,scope_id,purpose,workspace,git_dir,generation,branch_ref,base_sha,parent_sha,tree_sha,commit_sha,policy_digest,
     job_id,recovery_id,files_json,created_at,phase,projected_at,projected_status,projected_ticket_digest)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(checkpoint.candidateCheckpointId, f.config.id, 'a', scopeId,
    'implementation', '/tmp/squire-fixture/workspaces/a-1', '/tmp/squire-fixture/workspaces/a-1/.git', checkpoint.generation,
    'refs/heads/squire/fixture/a', checkpoint.baseSha, '1'.repeat(40), checkpoint.treeSha, checkpoint.headSha,
    digest(f.store.get(f.config.id).config), null, null, '[]', checkpointNow, checkpointPhase,
    checkpointPhase === 'projected' ? checkpointNow : null, checkpointPhase === 'projected' ? 'verifying' : null,
    checkpointPhase === 'projected' ? digest({ checkpoint }) : null);
  let reference, evidenceDirectory;
  await withProducer({ store: f.store, project: f.config.id, scopeId }, async () => {
    const processRunner = async ({ argv, directory }) => {
      const operationId = randomUUID(), startedAt = Date.now(), endedAt = startedAt + 1;
      const requestDigest = digest({ argv });
      const grant = f.store.registerProcess(scopeId, null, operationId, directory, requestDigest);
      f.store.claimProcess(grant, 'registered', 'supervisor', requestDigest);
      f.store.claimProcess(grant, 'supervisor', 'target', requestDigest);
      const exitCode = 9;
      f.store.finishProcess(grant, 'target', { kind: 'terminal', exitCode, endedAt,
        receiptDigest: digest({ operationId, argv, startedAt, endedAt, exitCode }) });
      return { operationId, argv, startedAt, endedAt, exitCode, stopped: false, timedOut: false,
        outputExceeded: false, launchError: null, stdout: 'deterministic check failure', stderr: '' };
    };
    const runner = new VerificationRunner(projectRoot, { processRunner });
    const outcome = await runner.runForCandidate(f.root, currentChecks, 'a-bound-candidate', undefined, {
      phase: 'candidate-verification', projectId: f.config.id, ticketId: 'a', serviceId: 'app', ...candidate,
      producerScopeId: scopeId, contractDigest: null, correctionAdmission: null,
      policyDigest: digest(currentChecks), implementationJobId: null
    });
    assert.equal(outcome.passed, false);
    assert.equal(outcome.results.length, 1);
    assert.equal(outcome.evidenceDraft.checks.length, 2);
    const operations = outcome.evidenceDraft.checks.filter(check => check.operationId).map(check => {
      const row = f.store.processOperation(check.operationId);
      return { id: row.id, scopeId: row.scope_id, jobId: row.job_id, requestDigest: row.request_digest,
        phase: row.phase, terminal: JSON.parse(row.terminal) };
    });
    reference = await persistCandidateCheckEvidence(projectRoot, outcome.evidenceDraft, operations,
      { headSha: candidate.headSha, treeSha: candidate.treeSha, dirty: false });
    evidenceDirectory = path.join(projectRoot, 'check-evidence', reference.id);
    f.store.update(f.config.id, state => {
      const saved = state.tickets.find(item => item.spec.id === 'a');
      Object.assign(saved, candidate, { attempts: 1, generation: 1, status: 'blocked' });
      saved.verification = { passed: outcome.passed, results: outcome.results,
        headSha: candidate.headSha, treeSha: candidate.treeSha, policyDigest: digest(currentChecks),
        checkEvidence: { state: 'recorded', reference } };
    }, 'ticket.transition', { ticket: 'a', status: 'blocked' });
    f.store.update(f.config.id, () => {}, 'producer.completed', { scopeId, lane: 'ticket:a' }, scopeId);
  });
  lease();
  return { f, reference, evidenceDirectory, candidate, checkpoint, inspect: () => inspectChecks({ id: f.config.id, stateDir: f.stateDir, ticketId: 'a' }) };
}

test('ticket inspector resolves candidate-linked check evidence without changing source state', async t => {
  const f = await makeBoundEvidence(t);
  const before = await stateFingerprint(f.f.stateDir);
  const report = f.inspect();
  const after = await stateFingerprint(f.f.stateDir);
  assert.deepEqual(after, before);
  assert.equal(report.type, 'squire.check-inspection');
  assert.equal(report.status, 'resolved');
  assert.equal(report.binding, 'candidate_contract_policy_bound');
  assert.equal(report.artifactIntegrity, 'verified');
  assert.equal(report.checkpointLink.state, 'current');
  assert.equal(report.identity.candidateCheckpointId, f.candidate.candidateCheckpointId);
  assert.equal(report.verificationOutcome, 'failed');
  assert.equal(report.acceptance, 'not_evaluated');
  assert.deepEqual(report.checks.map(check => check.state), ['failed', 'not_run']);
  assert.equal(report.checks.length, 2);
  assert.match(report.checks[0].untrustedOutputTail, /deterministic check failure/);
  assert.equal(report.checks[1].outputState, 'not_run');
  const configFile = path.join(f.f.root, 'inspect-only.json');
  await writeFile(configFile, JSON.stringify({ id: f.f.config.id, stateDir: f.f.stateDir }));
  const beforeCli = await stateFingerprint(f.f.stateDir);
  const cli = JSON.parse(execFileSync(process.execPath, ['bin/squire.mjs', 'inspect-checks', configFile, 'a'], { encoding: 'utf8', windowsHide: true }));
  assert.equal(cli.status, 'resolved'); assert.equal(cli.acceptance, 'not_evaluated');
  assert.deepEqual(await stateFingerprint(f.f.stateDir), beforeCli);
});

test('rebased verification preserves current head diagnostics and marks its retained old checkpoint stale', async t => {
  const f = await makeBoundEvidence(t, { rebased: true });
  const report = f.inspect();
  assert.equal(report.status, 'incomplete');
  assert.equal(report.binding, 'candidate_contract_policy_bound');
  assert.equal(report.checkpointLink.state, 'stale');
  assert.equal(report.checkpointLink.reason, 'checkpoint_candidate_mismatch');
  assert.equal(report.checkpointLink.id, f.checkpoint.candidateCheckpointId);
  assert.equal(report.checkpointLink.observed.headSha, f.checkpoint.headSha);
  assert.equal(report.checkpointLink.observed.treeSha, f.checkpoint.treeSha);
  assert.equal(report.identity.candidateCheckpointId, null);
  assert.equal(report.identity.headSha, f.candidate.headSha);
  assert.equal(report.identity.treeSha, f.candidate.treeSha);
  assert.equal(report.checks.length, 2);
  assert.ok(report.issues.includes('candidate_checkpoint_stale'));
  assert.equal(report.acceptance, 'not_evaluated');
});

test('checkpoint journal intent cannot resolve as a projected candidate link', async t => {
  const f = await makeBoundEvidence(t, { checkpointPhase: 'intent' });
  const report = f.inspect();
  assert.equal(report.status, 'incomplete');
  assert.equal(report.checkpointLink.state, 'stale');
  assert.equal(report.checkpointLink.reason, 'checkpoint_not_projected');
  assert.equal(report.checkpointLink.observed.phase, 'intent');
  assert.equal(report.identity.headSha, f.candidate.headSha);
  assert.equal(report.checks.length, 2);
  assert.equal(report.acceptance, 'not_evaluated');
});

test('inspector rejects changed bytes, links, escaped manifest slots and stale ticket identity', async t => {
  const f = await makeBoundEvidence(t);
  const manifestPath = path.join(f.evidenceDirectory, 'manifest.json');
  const stdoutPath = path.join(f.evidenceDirectory, '0.stdout.txt');
  const originalOutput = await readFile(stdoutPath);
  const originalManifest = await readFile(manifestPath, 'utf8');

  f.f.store.update(f.f.config.id, state => { state.tickets[0].headSha = 'd'.repeat(40); });
  assert.throws(f.inspect, { code: 'inspection_check_evidence_identity' });
  f.f.store.update(f.f.config.id, state => { state.tickets[0].headSha = f.candidate.headSha; });

  await writeFile(stdoutPath, 'altered diagnostic output');
  assert.throws(f.inspect, { code: 'inspection_check_evidence_artifact' });
  await writeFile(stdoutPath, originalOutput);

  const alias = path.join(f.evidenceDirectory, 'hardlink-alias');
  await link(stdoutPath, alias);
  assert.throws(f.inspect, { code: 'inspection_check_evidence_artifact' });
  await unlink(alias);

  const held = `${f.evidenceDirectory}-held`;
  await rename(f.evidenceDirectory, held);
  await symlink(held, f.evidenceDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(f.inspect, { code: 'inspection_check_evidence_artifact' });
  await rm(f.evidenceDirectory, { recursive: true });
  await rename(held, f.evidenceDirectory);

  const manifest = JSON.parse(originalManifest);
  manifest.checks[0].output.stdout.slot = '../../outside.txt';
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(manifestPath, bytes);
  const reference = { ...f.reference, bytes: bytes.length, sha256: sha256(bytes) };
  f.f.store.update(f.f.config.id, state => { state.tickets[0].verification.checkEvidence.reference = reference; });
  assert.throws(f.inspect, error => ['inspection_check_evidence_identity', 'inspection_check_evidence_artifact'].includes(error.code));
});

test('legacy verification has no reference and remains explicitly unbound', async t => {
  const f = await makeBoundEvidence(t);
  f.f.store.update(f.f.config.id, state => { delete state.tickets[0].verification.checkEvidence; });
  const report = f.inspect();
  assert.equal(report.status, 'unbound');
  assert.equal(report.binding, 'unbound');
  assert.equal(report.artifactIntegrity, 'not_available');
  assert.equal(report.acceptance, 'not_evaluated');
  assert.equal(report.legacy.results.length, 1);
});

test('exit zero combined with a terminal failure flag cannot resolve as a passed check', async t => {
  const f = await makeBoundEvidence(t);
  const manifestPath = path.join(f.evidenceDirectory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.checks[0].exitCode = 0;
  manifest.checks[0].stopped = true;
  const bytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(manifestPath, bytes);
  const reference = { ...f.reference, bytes: bytes.length, sha256: sha256(bytes) };
  f.f.store.update(f.f.config.id, state => { state.tickets[0].verification.checkEvidence.reference = reference; });
  assert.throws(f.inspect, error => ['inspection_check_evidence_identity', 'inspection_check_evidence_artifact'].includes(error.code));
});

test('output omitted after the run cap records bounded byte counts without retaining it', async t => {
  const f = await fixture(t, [ticket('a')]);
  const projectRoot = path.join(f.stateDir, 'projects', f.config.id);
  await mkdir(projectRoot, { recursive: true });
  const definitions = [{ name: 'large-output', argv: ['tool'], timeoutSeconds: 1 }, { name: 'empty-failure', argv: ['tool'], timeoutSeconds: 1 }];
  const now = Date.now();
  const common = { argvSha256: digest(['tool']), startedAt: now, endedAt: now + 1, stopped: false, timedOut: false,
    outputExceeded: false, launchError: false, process: null };
  const reference = await persistCandidateCheckEvidence(projectRoot, { version: 1, id: randomUUID(), policyDigest: digest(definitions),
    passed: false, binding: null, checks: [
      { ...common, index: 0, name: definitions[0].name, definitionSha256: digest(definitions[0]), state: 'passed', operationId: null,
        exitCode: 0, output: { state: 'omitted_run_limit', stdoutBytes: 16 * 1024 * 1024 + 8, stderrBytes: 0 } },
      { ...common, index: 1, name: definitions[1].name, definitionSha256: digest(definitions[1]), state: 'failed', operationId: null,
        exitCode: 1, output: { state: 'omitted_run_limit', stdoutBytes: 0, stderrBytes: 0 } }
    ] }, [], null);
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'check-evidence', reference.id, 'manifest.json'), 'utf8'));
  assert.equal(manifest.binding.state, 'unbound');
  assert.deepEqual(manifest.checks.map(check => check.output), [
    { state: 'omitted_run_limit', stdoutBytes: 16 * 1024 * 1024 + 8, stderrBytes: 0 },
    { state: 'omitted_run_limit', stdoutBytes: 0, stderrBytes: 0 }
  ]);
});
