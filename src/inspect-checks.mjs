import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withInspectionSnapshot, inspectionError, inspectionLimits } from './inspection-snapshot.mjs';
import { digest } from './contracts.mjs';
import { checkEvidenceLimits } from './check-evidence.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const hashText = bytes => createHash('sha256').update(bytes).digest('hex');
const error = (code, message) => Object.assign(new Error(message), { code });
const badIdentity = () => error('inspection_check_evidence_identity', 'Check evidence does not match the selected ticket and current verification record.');
const badArtifact = () => error('inspection_check_evidence_artifact', 'Check evidence contains a missing, unsafe, altered or incompatible artifact.');
const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(':');
const exactKeys = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

function requireDirectory(filename) {
  let stat;
  try { stat = lstatSync(filename, { bigint: true }); } catch { throw badArtifact(); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw badArtifact();
  return fingerprint(stat);
}

function readRegular(filename, maximum) {
  let before;
  try { before = lstatSync(filename, { bigint: true }); } catch { throw badArtifact(); }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > BigInt(maximum)) throw badArtifact();
  let fd;
  try { fd = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { throw badArtifact(); }
  try {
    if (fingerprint(fstatSync(fd, { bigint: true })) !== fingerprint(before)) throw badArtifact();
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, Math.min(64 * 1024, bytes.length - offset), offset);
      if (count <= 0) throw badArtifact();
      offset += count;
    }
    if (fingerprint(fstatSync(fd, { bigint: true })) !== fingerprint(before) ||
        fingerprint(lstatSync(filename, { bigint: true })) !== fingerprint(before)) throw badArtifact();
    return bytes;
  } catch (cause) {
    if (cause.code === 'check_evidence_artifact') throw cause;
    throw badArtifact();
  } finally { closeSync(fd); }
}

function projectFromSnapshot(db, projectId) {
  const schema = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name='project'").get();
  if (schema?.type !== 'table' || typeof schema.sql !== 'string' || /^\s*CREATE\s+VIRTUAL\b/i.test(schema.sql) ||
      !db.prepare('PRAGMA table_info(project)').all().some(row => row.name === 'id') ||
      !db.prepare('PRAGMA table_info(project)').all().some(row => row.name === 'state')) throw inspectionError('inspection_unavailable');
  const row = db.prepare('SELECT state FROM project WHERE id=?').get(projectId);
  if (!row || typeof row.state !== 'string' || Buffer.byteLength(row.state) > inspectionLimits.stateBytes) throw inspectionError('inspection_project');
  let state;
  try { state = JSON.parse(row.state); } catch { throw inspectionError('inspection_unavailable'); }
  if (!object(state) || state.id !== projectId || !Array.isArray(state.tickets)) throw inspectionError('inspection_unavailable');
  return state;
}

function checkOperationTable(db) {
  const schema = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name='process_operations'").get();
  const columns = ['id', 'scope_id', 'job_id', 'request_digest', 'phase', 'terminal'];
  if (schema?.type !== 'table' || typeof schema.sql !== 'string' || /^\s*CREATE\s+VIRTUAL\b/i.test(schema.sql)) return false;
  const found = db.prepare('PRAGMA table_info(process_operations)').all().map(row => row.name);
  return columns.every(column => found.includes(column));
}

function currentBinding(project, ticket, verification, phase) {
  const headSha = phase === 'postmerge-verification' ? ticket.mergeSha : ticket.headSha;
  if (headSha !== verification.headSha || ticket.treeSha !== verification.treeSha) throw badIdentity();
  const serviceId = ticket.spec?.service;
  const service = project.config?.services?.[serviceId];
  if (!service || !Array.isArray(service.checks)) throw badIdentity();
  const correction = ticket.correctionAdmission ? {
    admissionId: ticket.correctionAdmission.admissionId,
    digest: digest({ outcome: ticket.correctionAdmission.outcome, instructions: ticket.correctionAdmission.instructions, checklist: ticket.correctionAdmission.checklist })
  } : null;
  return {
    phase, projectId: project.id, ticketId: ticket.spec?.id, serviceId,
    candidateCheckpointId: ticket.candidateCheckpointId ?? null,
    baseSha: ticket.baseSha ?? null, headSha: headSha ?? null, treeSha: ticket.treeSha ?? null,
    attempt: ticket.attempts ?? null, generation: ticket.generation ?? null,
    contractDigest: ticket.spec.execution ? digest(ticket.spec.execution) : null,
    correctionAdmission: correction,
    policyDigest: digest(service.checks), implementationJobId: ticket.implementation?.jobId ?? null,
    checks: service.checks
  };
}

function checkpointLink(db, project, ticket, binding) {
  const id = binding.candidateCheckpointId;
  const unbound = (state, reason) => ({ state, id: id ?? null, reason });
  const schema = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name='candidate_checkpoints'").get();
  if (schema?.type !== 'table' || typeof schema.sql !== 'string' || /^\s*CREATE\s+VIRTUAL\b/i.test(schema.sql)) {
    return unbound('unresolved', 'journal_unavailable');
  }
  const columns = db.prepare('PRAGMA table_info(candidate_checkpoints)').all().map(row => row.name);
  if (!['id', 'project', 'ticket', 'scope_id', 'purpose', 'generation', 'base_sha', 'tree_sha', 'commit_sha', 'phase'].every(name => columns.includes(name))) {
    return unbound('unresolved', 'journal_schema_incompatible');
  }
  if (!uuid(id)) return unbound('unresolved', 'checkpoint_id_missing');
  const row = db.prepare(`SELECT id,project,ticket,scope_id,purpose,generation,base_sha,tree_sha,commit_sha,phase
    FROM candidate_checkpoints WHERE id=?`).get(id);
  if (!row) return unbound('stale', 'checkpoint_missing');
  if (row.project !== project.id || row.ticket !== ticket.spec?.id) return unbound('stale', 'journal_identity_mismatch');
  const observed = { baseSha: row.base_sha, headSha: row.commit_sha, treeSha: row.tree_sha,
    generation: Number.isSafeInteger(row.generation) ? row.generation : null, phase: row.phase, purpose: row.purpose };
  if (row.phase !== 'projected') return { ...unbound('stale', 'checkpoint_not_projected'), observed };
  const scopeSchema = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name='producer_scopes'").get();
  const scopeColumns = scopeSchema?.type === 'table' && typeof scopeSchema.sql === 'string' && !/^\s*CREATE\s+VIRTUAL\b/i.test(scopeSchema.sql)
    ? db.prepare('PRAGMA table_info(producer_scopes)').all().map(value => value.name) : [];
  if (!['id', 'project', 'lane'].every(name => scopeColumns.includes(name))) {
    return { ...unbound('unresolved', 'checkpoint_scope_unavailable'), observed };
  }
  const scope = db.prepare('SELECT id,project,lane FROM producer_scopes WHERE id=?').get(row.scope_id);
  if (!scope || scope.project !== project.id || scope.lane !== `ticket:${ticket.spec.id}`) {
    return { ...unbound('stale', 'checkpoint_scope_mismatch'), observed };
  }
  if (row.commit_sha !== binding.headSha || row.tree_sha !== binding.treeSha || row.base_sha !== binding.baseSha ||
      row.generation !== binding.generation || !['implementation', 'automatic_recovery', 'partial_recovery', 'interrupted_candidate_verification'].includes(row.purpose)) {
    return { ...unbound('stale', 'checkpoint_candidate_mismatch'), observed };
  }
  return { state: 'current', id, observed };
}

function matchBinding(actual, expected) {
  return object(actual) && actual.phase === expected.phase &&
    ['projectId', 'ticketId', 'serviceId', 'candidateCheckpointId', 'baseSha', 'headSha', 'treeSha', 'attempt', 'generation',
      'contractDigest', 'policyDigest', 'implementationJobId'].every(key => actual[key] === expected[key]) &&
    JSON.stringify(actual.correctionAdmission) === JSON.stringify(expected.correctionAdmission);
}

function currentResultMatches(check, result) {
  if (!object(result) || result.name !== check.name || typeof result.passed !== 'boolean') return false;
  if (check.state === 'not_run') return false;
  const flags = result;
  return result.passed === (check.state === 'passed') && result.exitCode === check.exitCode &&
    (flags.startedAt ?? null) === check.startedAt && (flags.endedAt ?? null) === check.endedAt &&
    (flags.stopped === true) === check.stopped && (flags.timedOut === true) === check.timedOut &&
    (flags.outputExceeded === true) === check.outputExceeded && Boolean(flags.launchError) === check.launchError &&
    hashText(Buffer.from(JSON.stringify(result.argv ?? []))) === check.argvSha256;
}

function validateSequence(checks, passed) {
  let failed = false;
  for (const check of checks) {
    if (!object(check) || !['passed', 'failed', 'not_run'].includes(check.state)) throw badArtifact();
    if (failed && check.state !== 'not_run') throw badArtifact();
    if (check.state === 'not_run') {
      if (!failed) throw badArtifact();
      if (!exactKeys(check, ['index', 'name', 'definitionSha256', 'state', 'process', 'output']) || check.process !== null ||
          !exactKeys(check.output, ['state']) || check.output.state !== 'not_run') throw badArtifact();
      failed = true; continue;
    }
    if (!exactKeys(check, ['index', 'name', 'definitionSha256', 'state', 'process', 'argvSha256', 'startedAt', 'endedAt', 'exitCode',
      'stopped', 'timedOut', 'outputExceeded', 'launchError', 'output'])) throw badArtifact();
    if (check.process !== null && (!exactKeys(check.process, ['operationId', 'scopeId', 'jobId', 'requestDigest', 'phase', 'terminal']) ||
        !uuid(check.process.operationId) || !uuid(check.process.scopeId) ||
        (check.process.jobId !== null && !uuid(check.process.jobId)) || !/^[a-f0-9]{64}$/.test(check.process.requestDigest) ||
        check.process.phase !== 'target' || !exactKeys(check.process.terminal, ['kind', 'exitCode', 'endedAt', 'receiptDigest']) ||
        !['terminal', 'not_started'].includes(check.process.terminal.kind) ||
        (check.process.terminal.exitCode !== null && !Number.isInteger(check.process.terminal.exitCode)) ||
        !Number.isSafeInteger(check.process.terminal.endedAt) || !/^[a-f0-9]{64}$/.test(check.process.terminal.receiptDigest))) throw badArtifact();
    if (typeof check.argvSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(check.argvSha256) ||
        !Number.isSafeInteger(check.startedAt) || !Number.isSafeInteger(check.endedAt) || check.endedAt < check.startedAt ||
        ['stopped', 'timedOut', 'outputExceeded', 'launchError'].some(key => typeof check[key] !== 'boolean') ||
        (check.exitCode !== null && !Number.isInteger(check.exitCode))) throw badArtifact();
    if (check.output?.state === 'retained') {
      const slot = value => exactKeys(value, ['slot', 'bytes', 'sha256']) && Number.isSafeInteger(value.bytes) && value.bytes >= 0 &&
        value.bytes <= checkEvidenceLimits.artifactBytes && /^[a-f0-9]{64}$/.test(value.sha256);
      if (!exactKeys(check.output, ['state', 'stdout', 'stderr']) || !slot(check.output.stdout) || !slot(check.output.stderr) ||
          check.output.stdout.slot !== 'stdout' || check.output.stderr.slot !== 'stderr') throw badArtifact();
    } else if (check.output?.state === 'omitted_run_limit') {
      if (!exactKeys(check.output, ['state', 'stdoutBytes', 'stderrBytes']) || !Number.isSafeInteger(check.output.stdoutBytes) ||
          !Number.isSafeInteger(check.output.stderrBytes) || check.output.stdoutBytes < 0 || check.output.stderrBytes < 0 ||
          !Number.isSafeInteger(check.output.stdoutBytes + check.output.stderrBytes)) throw badArtifact();
    } else throw badArtifact();
    const qualifies = check.exitCode === 0 && !check.stopped && !check.timedOut && !check.outputExceeded && !check.launchError;
    if ((check.state === 'passed') !== qualifies) throw badArtifact();
    if (check.state === 'failed') failed = true;
    if (check.output?.state === 'not_run') throw badArtifact();
  }
  if (checks.length === 0 || checks.some(check => check.state === 'failed') === passed ||
      (passed && checks.some(check => check.state !== 'passed'))) throw badArtifact();
}

function verifyOperation(db, operationTable, check, binding) {
  if (check.state === 'not_run') return true;
  if (!object(check.process)) return false;
  if (!operationTable || !uuid(check.process.operationId)) throw badArtifact();
  const row = db.prepare('SELECT id,scope_id,job_id,request_digest,phase,terminal FROM process_operations WHERE id=?').get(check.process.operationId);
  if (!row || row.id !== check.process.operationId || row.scope_id !== check.process.scopeId || row.scope_id !== binding.producerScopeId ||
      row.job_id !== check.process.jobId || row.request_digest !== check.process.requestDigest || row.phase !== 'target') throw badArtifact();
  let terminal;
  try { terminal = JSON.parse(row.terminal); } catch { throw badArtifact(); }
  if (!object(terminal) || JSON.stringify(terminal) !== JSON.stringify(check.process.terminal) ||
      terminal.exitCode !== check.exitCode || terminal.endedAt !== check.endedAt) throw badArtifact();
  return true;
}

function verifyScope(db, binding) {
  const schema = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name='producer_scopes'").get();
  if (schema?.type !== 'table' || typeof schema.sql !== 'string' || /^\s*CREATE\s+VIRTUAL\b/i.test(schema.sql)) throw badArtifact();
  const columns = db.prepare('PRAGMA table_info(producer_scopes)').all().map(row => row.name);
  if (!['id', 'project', 'lane'].every(name => columns.includes(name))) throw badArtifact();
  const row = db.prepare('SELECT id,project,lane FROM producer_scopes WHERE id=?').get(binding.producerScopeId);
  if (!row || row.project !== binding.projectId || row.lane !== `ticket:${binding.ticketId}`) throw badArtifact();
}

function safeArtifactRoot(stateDir, projectId, evidenceId) {
  if (!uuid(evidenceId)) throw badArtifact();
  let stateRoot;
  try { stateRoot = realpathSync(stateDir); } catch { throw badArtifact(); }
  const projects = path.join(stateRoot, 'projects'), projectRoot = path.join(projects, projectId);
  const evidenceRoot = path.join(projectRoot, 'check-evidence'), runRoot = path.join(evidenceRoot, evidenceId);
  const directories = [projects, projectRoot, evidenceRoot, runRoot].map(filename => [filename, requireDirectory(filename)]);
  return { runRoot, manifest: path.join(runRoot, 'manifest.json'), directories };
}

function recheckDirectories(directories) {
  for (const [filename, expected] of directories) {
    let actual;
    try { actual = lstatSync(filename, { bigint: true }); } catch { throw badArtifact(); }
    if (!actual.isDirectory() || actual.isSymbolicLink() || fingerprint(actual) !== expected) throw badArtifact();
  }
}

function outputTail(runRoot, check, total) {
  if (check.output?.state !== 'retained') return { outputState: check.output?.state ?? 'missing' };
  const stdoutName = `${check.index}.stdout.txt`, stderrName = `${check.index}.stderr.txt`;
  const stdout = readRegular(path.join(runRoot, stdoutName), checkEvidenceLimits.artifactBytes);
  const stderr = readRegular(path.join(runRoot, stderrName), checkEvidenceLimits.artifactBytes);
  if (stdout.length !== check.output.stdout?.bytes || hashText(stdout) !== check.output.stdout?.sha256 ||
      stderr.length !== check.output.stderr?.bytes || hashText(stderr) !== check.output.stderr?.sha256) throw badArtifact();
  total.bytes += stdout.length + stderr.length;
  if (total.bytes > checkEvidenceLimits.artifactBytes) throw badArtifact();
  return { outputState: 'retained', untrustedOutputTail: `${stdout.toString('utf8')}\n${stderr.toString('utf8')}`.slice(-1600) };
}

/** Read from a stable private SQLite snapshot and fixed controller-issued slots. */
export function inspectChecks({ id, stateDir, ticketId, phase = 'candidate-verification' }) {
  if (!['candidate-verification', 'postmerge-verification'].includes(phase)) throw inspectionError('inspection_input');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id ?? '') || typeof stateDir !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(ticketId ?? '')) throw inspectionError('inspection_input');
  return withInspectionSnapshot(stateDir, (db, snapshot) => {
    const project = projectFromSnapshot(db, id);
    const ticket = project.tickets.find(item => item?.spec?.id === ticketId);
    if (!ticket) throw inspectionError('inspection_project');
    const verification = phase === 'postmerge-verification' ? ticket.postmerge : ticket.verification;
    const checkEvidence = verification?.checkEvidence;
    const reference = checkEvidence?.reference;
    const legacy = verification ? { passed: verification.passed === true, headSha: verification.headSha ?? null,
      treeSha: verification.treeSha ?? null, policyDigest: verification.policyDigest ?? null,
      results: Array.isArray(verification.results) ? verification.results.map(item => ({ name: item?.name ?? null, passed: item?.passed === true,
        exitCode: Number.isInteger(item?.exitCode) ? item.exitCode : null, stopped: item?.stopped === true,
        timedOut: item?.timedOut === true, outputExceeded: item?.outputExceeded === true, launchError: Boolean(item?.launchError) })) : [] } : null;
    if (!object(reference)) {
      if (checkEvidence?.state === 'recorded') throw badIdentity();
      return { type: 'squire.check-inspection', version: 1, projectId: id, ticketId,
      status: checkEvidence?.state === 'unavailable' ? 'incomplete' : 'unbound', binding: 'unbound', artifactIntegrity: 'not_available', acceptance: 'not_evaluated',
      reason: checkEvidence?.state === 'unavailable' ? 'The controller could not retain the additive diagnostic manifest.' :
        'No controller-issued immutable check-evidence reference is attached to this verification.', legacy };
    }
    if (!exactKeys(checkEvidence, ['state', 'reference']) || checkEvidence.state !== 'recorded' ||
        !exactKeys(reference, ['type', 'version', 'id', 'bytes', 'sha256']) || reference.type !== 'squire.check-evidence-ref' || reference.version !== 1 || !uuid(reference.id) ||
        !Number.isSafeInteger(reference.bytes) || reference.bytes < 1 || reference.bytes > checkEvidenceLimits.manifestBytes ||
        !/^[a-f0-9]{64}$/.test(reference.sha256) || !object(verification)) throw badIdentity();
    const { runRoot, manifest: manifestPath, directories } = safeArtifactRoot(stateDir, id, reference.id);
    const manifestBytes = readRegular(manifestPath, checkEvidenceLimits.manifestBytes);
    if (manifestBytes.length !== reference.bytes || hashText(manifestBytes) !== reference.sha256) throw badArtifact();
    let manifest;
    try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)); } catch { throw badArtifact(); }
    if (!exactKeys(manifest, ['type', 'version', 'id', 'diagnosticOnly', 'verificationOutcome', 'acceptance', 'binding', 'policyDigest', 'checks', 'issues']) ||
        manifest.type !== 'squire.check-evidence' || manifest.version !== 1 || manifest.id !== reference.id ||
        manifest.diagnosticOnly !== true || manifest.acceptance !== 'not_evaluated' || !Array.isArray(manifest.checks) ||
        manifest.checks.length > checkEvidenceLimits.checks || manifest.policyDigest !== verification.policyDigest ||
        !Array.isArray(manifest.issues) || manifest.issues.some(item => typeof item !== 'string' || item.length > 80)) throw badIdentity();
    const expected = currentBinding(project, ticket, verification, phase);
    if (expected.policyDigest !== verification.policyDigest || expected.policyDigest !== digest(expected.checks)) throw badIdentity();
    const bound = manifest.binding?.state === 'bound';
    if (bound && (!exactKeys(manifest.binding, ['state', 'value']) ||
        !exactKeys(manifest.binding.value, ['phase', 'projectId', 'ticketId', 'serviceId', 'candidateCheckpointId', 'baseSha', 'headSha',
          'treeSha', 'attempt', 'generation', 'producerScopeId', 'contractDigest', 'correctionAdmission', 'policyDigest', 'implementationJobId']) ||
        !matchBinding(manifest.binding.value, expected) || !sha(expected.headSha) || !sha(expected.treeSha))) throw badIdentity();
    if (!bound && (!exactKeys(manifest.binding, ['state', 'missing']) || manifest.binding?.state !== 'unbound' ||
        !Array.isArray(manifest.binding.missing) || manifest.binding.missing.some(item => typeof item !== 'string'))) throw badArtifact();
    if (bound) verifyScope(db, manifest.binding.value);
    const checkpoint = bound ? checkpointLink(db, project, ticket, manifest.binding.value) :
      { state: 'unbound', id: null, reason: 'verification_binding_unbound' };
    if (manifest.policyDigest !== digest(expected.checks) || manifest.checks.length !== expected.checks.length) throw badIdentity();
    const processTable = checkOperationTable(db);
    const total = { bytes: 0 };
    const resolvedChecks = [];
    let resultIndex = 0;
    validateSequence(manifest.checks, manifest.verificationOutcome === 'passed');
    for (let index = 0; index < manifest.checks.length; index++) {
      const check = manifest.checks[index], definition = expected.checks[index];
      if (!object(check) || check.index !== index || check.name !== definition.name || check.definitionSha256 !== digest(definition)) throw badIdentity();
      if (check.state !== 'not_run') {
        const result = verification.results?.[resultIndex++];
        if (!currentResultMatches(check, result)) throw badIdentity();
      }
      if (bound && check.state !== 'not_run') {
        if (check.process) verifyOperation(db, processTable, check, manifest.binding.value);
        else if (!manifest.issues.includes('process_operation_unresolved')) throw badArtifact();
      }
      const tail = outputTail(runRoot, check, total);
      resolvedChecks.push({ index, name: check.name, state: check.state, operationId: check.process?.operationId ?? null,
        startedAt: check.startedAt ?? null, endedAt: check.endedAt ?? null, exitCode: check.exitCode ?? null,
        stopped: check.stopped === true, timedOut: check.timedOut === true, outputExceeded: check.outputExceeded === true,
        launchError: check.launchError === true, ...tail });
    }
    if (resultIndex !== (verification.results?.length ?? -1) || manifest.verificationOutcome !== (verification.passed ? 'passed' : 'failed')) throw badIdentity();
    const issues = Array.isArray(manifest.issues) ? manifest.issues.filter(item => typeof item === 'string' && item.length <= 80) : [];
    if (checkpoint.state === 'stale') issues.push('candidate_checkpoint_stale');
    if (checkpoint.state === 'unresolved') issues.push('candidate_checkpoint_unresolved');
    const uniqueIssues = [...new Set(issues)].sort();
    recheckDirectories(directories);
    return { type: 'squire.check-inspection', version: 1, projectId: id, ticketId,
      status: uniqueIssues.length || checkpoint.state !== 'current' && bound ? 'incomplete' : bound ? 'resolved' : 'unbound',
      binding: bound ? 'candidate_contract_policy_bound' : 'unbound', artifactIntegrity: 'verified',
      verificationOutcome: manifest.verificationOutcome, acceptance: 'not_evaluated',
      checkpointLink: checkpoint,
      identity: bound ? { serviceId: expected.serviceId, candidateCheckpointId: checkpoint.state === 'current' ? expected.candidateCheckpointId : null,
        baseSha: expected.baseSha, headSha: expected.headSha, treeSha: expected.treeSha,
        attempt: expected.attempt, generation: expected.generation,
        contractDigest: expected.contractDigest, correctionAdmission: expected.correctionAdmission,
        policyDigest: expected.policyDigest } : null,
      snapshot: { kind: snapshot.kind, sha256: snapshot.sha256, capturedAt: snapshot.capturedAt },
      referenceId: reference.id, checks: resolvedChecks, issues: uniqueIssues };
  });
}
