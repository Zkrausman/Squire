import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { publishEvidence } from './job-evidence.mjs';

export const checkEvidenceLimits = Object.freeze({ manifestBytes: 128 * 1024, artifactBytes: 16 * 1024 * 1024, checks: 30 });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
const fixedMessage = 'Check evidence could not be retained as an immutable record';

function directory(filename) {
  try {
    const stat = lstatSync(filename);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(fixedMessage);
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  mkdirSync(filename, { mode: 0o700 });
  const stat = lstatSync(filename);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(fixedMessage);
}

function writeNew(filename, bytes) {
  const fd = openSync(filename, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

function freezeBinding(value, policyDigest) {
  const missing = [];
  if (!object(value)) return { binding: null, missing: ['controller_context_missing'] };
  const check = (condition, name) => { if (!condition) missing.push(name); };
  check(['candidate-verification', 'postmerge-verification'].includes(value.phase), 'phase');
  check(identifier(value.projectId), 'project');
  check(identifier(value.ticketId), 'ticket');
  check(identifier(value.serviceId), 'service');
  check(uuid(value.producerScopeId), 'producer_scope');
  check(uuid(value.candidateCheckpointId), 'candidate_checkpoint');
  check(sha(value.baseSha), 'base');
  check(sha(value.headSha), 'head');
  check(sha(value.treeSha), 'tree');
  check(Number.isSafeInteger(value.attempt) && value.attempt > 0, 'attempt');
  check(Number.isSafeInteger(value.generation) && value.generation > 0, 'generation');
  check(value.contractDigest === null || digest(value.contractDigest), 'contract');
  check(digest(value.policyDigest) && value.policyDigest === policyDigest, 'policy');
  check(value.correctionAdmission === null || (object(value.correctionAdmission) && identifier(value.correctionAdmission.admissionId) && digest(value.correctionAdmission.digest)), 'correction');
  check(value.implementationJobId === null || uuid(value.implementationJobId), 'implementation_job');
  if (missing.length) return { binding: null, missing: [...new Set(missing)] };
  return { binding: {
    phase: value.phase, projectId: value.projectId, ticketId: value.ticketId, serviceId: value.serviceId,
    candidateCheckpointId: value.candidateCheckpointId, baseSha: value.baseSha, headSha: value.headSha,
    treeSha: value.treeSha, attempt: value.attempt, generation: value.generation, producerScopeId: value.producerScopeId,
    contractDigest: value.contractDigest, correctionAdmission: value.correctionAdmission ? { ...value.correctionAdmission } : null,
    policyDigest: value.policyDigest, implementationJobId: value.implementationJobId
  }, missing: [] };
}

function processRecord(check, operations, scopeId) {
  if (!uuid(check.operationId)) return null;
  const operation = operations.find(item => item?.id === check.operationId);
  if (!operation || operation.scopeId !== scopeId || operation.phase !== 'target' || !digest(operation.requestDigest) ||
      !object(operation.terminal) || !['terminal', 'not_started'].includes(operation.terminal.kind) ||
      (operation.terminal.exitCode !== null && !Number.isInteger(operation.terminal.exitCode)) ||
      !Number.isSafeInteger(operation.terminal.endedAt) || !digest(operation.terminal.receiptDigest) ||
      operation.terminal.exitCode !== check.exitCode || operation.terminal.endedAt !== check.endedAt ||
      (check.launchError && operation.terminal.kind !== 'not_started')) return null;
  return { operationId: operation.id, scopeId: operation.scopeId, jobId: uuid(operation.jobId) ? operation.jobId : null,
    requestDigest: operation.requestDigest, phase: operation.phase, terminal: operation.terminal };
}

/** Persist an additive diagnostic manifest after the controller has reasserted
 * the candidate. A record never grants acceptance, replay or recovery authority. */
export async function persistCandidateCheckEvidence(projectRoot, draft, operations, assertedCandidate) {
  if (!object(draft) || draft.version !== 1 || !uuid(draft.id) || !Array.isArray(draft.checks) ||
      draft.checks.length > checkEvidenceLimits.checks || !Array.isArray(operations)) throw new Error(fixedMessage);
  const bound = freezeBinding(draft.binding, draft.policyDigest);
  if (bound.binding && (!object(assertedCandidate) || assertedCandidate.headSha !== bound.binding.headSha ||
      assertedCandidate.treeSha !== bound.binding.treeSha || assertedCandidate.dirty === true)) throw new Error(fixedMessage);
  const projectStat = lstatSync(projectRoot);
  if (!projectStat.isDirectory() || projectStat.isSymbolicLink()) throw new Error(fixedMessage);
  const evidenceRoot = path.join(projectRoot, 'check-evidence');
  directory(evidenceRoot);
  const runRoot = path.join(evidenceRoot, draft.id);
  mkdirSync(runRoot, { mode: 0o700 });
  const issues = [];
  let artifactBytes = 0, sawFailure = false;
  const checks = draft.checks.map((item, index) => {
    if (!object(item) || item.index !== index || typeof item.name !== 'string' || !identifier(item.name) || !digest(item.definitionSha256) ||
        !['passed', 'failed', 'not_run'].includes(item.state)) throw new Error(fixedMessage);
    const base = { index, name: item.name, definitionSha256: item.definitionSha256, state: item.state };
    if (item.state === 'not_run') {
      if (!sawFailure) throw new Error(fixedMessage);
      sawFailure = true;
      if (item.operationId !== null || item.output?.state !== 'not_run') throw new Error(fixedMessage);
      return { ...base, process: null, output: { state: 'not_run' } };
    }
    if (sawFailure) throw new Error(fixedMessage);
    const expectedScopeId = uuid(draft.binding?.producerScopeId) ? draft.binding.producerScopeId : null;
    const process = processRecord(item, operations, expectedScopeId);
    if (!process) issues.push('process_operation_unresolved');
    if (!digest(item.argvSha256) || !Number.isSafeInteger(item.startedAt) || !Number.isSafeInteger(item.endedAt) || item.endedAt < item.startedAt ||
        (item.exitCode !== null && !Number.isInteger(item.exitCode)) || ['stopped', 'timedOut', 'outputExceeded', 'launchError'].some(key => typeof item[key] !== 'boolean')) {
      throw new Error(fixedMessage);
    }
    const qualifies = item.exitCode === 0 && !item.stopped && !item.timedOut && !item.outputExceeded && !item.launchError;
    if ((item.state === 'passed') !== qualifies) throw new Error(fixedMessage);
    if (item.state === 'failed') sawFailure = true;
    const output = item.output;
    if (output?.state === 'retained') {
      const stdout = Buffer.from(output.stdout, 'utf8'), stderr = Buffer.from(output.stderr, 'utf8');
      artifactBytes += stdout.length + stderr.length;
      if (stdout.length + stderr.length > checkEvidenceLimits.artifactBytes || artifactBytes > checkEvidenceLimits.artifactBytes) throw new Error(fixedMessage);
      const stdoutName = `${index}.stdout.txt`, stderrName = `${index}.stderr.txt`;
      writeNew(path.join(runRoot, stdoutName), stdout); writeNew(path.join(runRoot, stderrName), stderr);
      return { ...base, process, argvSha256: item.argvSha256,
        startedAt: item.startedAt, endedAt: item.endedAt, exitCode: item.exitCode,
        stopped: item.stopped, timedOut: item.timedOut, outputExceeded: item.outputExceeded, launchError: item.launchError,
        output: { state: 'retained', stdout: { slot: 'stdout', bytes: stdout.length, sha256: sha256(stdout) },
          stderr: { slot: 'stderr', bytes: stderr.length, sha256: sha256(stderr) } } };
    }
    if (output?.state !== 'omitted_run_limit' || !Number.isSafeInteger(output.stdoutBytes) || !Number.isSafeInteger(output.stderrBytes) ||
        output.stdoutBytes < 0 || output.stderrBytes < 0 || !Number.isSafeInteger(output.stdoutBytes + output.stderrBytes)) throw new Error(fixedMessage);
    return { ...base, process, argvSha256: item.argvSha256,
      startedAt: item.startedAt, endedAt: item.endedAt, exitCode: item.exitCode,
      stopped: item.stopped, timedOut: item.timedOut, outputExceeded: item.outputExceeded, launchError: item.launchError,
      output: { state: 'omitted_run_limit', stdoutBytes: output.stdoutBytes, stderrBytes: output.stderrBytes } };
  });
  const computedPass = checks.length > 0 && checks.every(check => check.state === 'passed');
  if (typeof draft.passed !== 'boolean' || draft.passed !== computedPass) throw new Error(fixedMessage);
  const manifest = { type: 'squire.check-evidence', version: 1, id: draft.id, diagnosticOnly: true,
    verificationOutcome: draft.passed ? 'passed' : 'failed', acceptance: 'not_evaluated',
    binding: bound.binding ? { state: 'bound', value: bound.binding } : { state: 'unbound', missing: bound.missing },
    policyDigest: draft.policyDigest, checks, issues: [...new Set(issues)].sort() };
  const bytes = Buffer.from(JSON.stringify(manifest));
  if (bytes.length > checkEvidenceLimits.manifestBytes) throw new Error(fixedMessage);
  await publishEvidence(runRoot, 'manifest.json', manifest, checkEvidenceLimits.manifestBytes);
  return { type: 'squire.check-evidence-ref', version: 1, id: draft.id, bytes: bytes.length, sha256: sha256(bytes) };
}
