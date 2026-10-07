import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, link, unlink, lstat, readFile } from 'node:fs/promises';
import { Blocker, digest } from './contracts.mjs';
import { producerContext } from './producer-context.mjs';

const LIMIT = 128 * 1024, ARTIFACT_LIMIT = 16 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => {
  const context = producerContext();
  if (context?.lifecycle) context.lifecycle.persistenceFailed = true;
  return new Blocker('job_evidence_incomplete', 'Physical job evidence is incomplete; producer remains fenced');
};
async function guarded(work) { try { return await work(); } catch { throw fail(); } }
// Hard-link publication is atomic and refuses replacement on both supported OSes.
// An interrupted temporary file is never a terminal manifest.
async function publish(directory, name, value, limit = LIMIT) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > limit) throw fail();
  const temporary = path.join(directory, `.${name}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await link(temporary, path.join(directory, name)); } finally { await unlink(temporary); }
  return { file: name, bytes: bytes.length, sha256: hash(bytes) };
}
async function artifact(directory, name) {
  if (path.basename(name) !== name) throw fail();
  const file = path.join(directory, name), stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > ARTIFACT_LIMIT) throw fail();
  const bytes = await readFile(file);
  if (bytes.length !== stat.size || bytes.length > ARTIFACT_LIMIT) throw fail();
  return { file: name, bytes: bytes.length, sha256: hash(bytes) };
}
function spoolRecord(id, bytes) {
  const end = bytes.lastIndexOf(10) + 1;
  let records = 0;
  for (const line of new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)).split('\n').slice(0, -1)) {
    const event = JSON.parse(line);
    if (!event || typeof event.type !== 'string') throw fail();
    records++;
  }
  if (end !== bytes.length) throw fail();
  return { file: `${id}.stdout.log`, bytes: bytes.length, completeBytes: end, records, trailingBytes: 0, malformed: false };
}
function processRecord(raw) {
  return { operationId: raw.operationId, exitCode: raw.exitCode, startedAt: raw.startedAt, endedAt: raw.endedAt,
    timedOut: raw.timedOut, stopped: raw.stopped, outputExceeded: raw.outputExceeded };
}
function validateProcess(raw, outcome) {
  if (!Number.isSafeInteger(raw.startedAt) || !Number.isSafeInteger(raw.endedAt) || raw.startedAt <= 0 || raw.endedAt < raw.startedAt ||
      (raw.exitCode !== null && !Number.isInteger(raw.exitCode)) || ['stopped', 'timedOut', 'outputExceeded'].some(key => typeof raw[key] !== 'boolean') ||
      (outcome === 'completed' && (raw.exitCode !== 0 || raw.stopped || raw.timedOut || raw.outputExceeded)) ||
      (raw.timedOut ? outcome !== 'timeout' : raw.stopped ? outcome !== 'cancelled' : ['timeout', 'cancelled'].includes(outcome))) throw fail();
}
export async function beginJobEvidence(job, provenance) {
  return guarded(async () => {
    await mkdir(path.dirname(job.directory), { recursive: true, mode: 0o700 });
    await mkdir(job.directory, { mode: 0o700 }); // Never adopt a previous directory.
    const intent = { version: 1, jobId: job.id, role: job.role, runtime: provenance.runtime ?? 'version-1-adapter', projectId: provenance.projectId ?? null, scopeId: provenance.scopeId ?? null, ticketId: provenance.ticketId ?? null, attempt: provenance.attempt ?? null, continuationId: provenance.continuationId ?? null, source: provenance.source ?? null };
    const reference = await publish(job.directory, 'intent.json', intent);
    return { directory: job.directory, intent, reference };
  });
}
export async function finishJobEvidence(evidence, { outcome, error, sessionRef, models }) {
  return guarded(async () => {
    const { directory, intent, reference } = evidence;
    const current = await artifact(directory, 'intent.json');
    if (current.sha256 !== reference.sha256) throw fail();
    const receipt = outcome?.evidenceProcess === true ? outcome.receipt : error?.evidenceProcess === true ? error.detail?.receipt : undefined;
    const status = receipt?.timedOut ? 'timeout' : receipt?.stopped ? 'cancelled' : error ? 'failed' : outcome?.outcome;
    if (!['completed', 'waiting_capacity', 'failed', 'timeout', 'cancelled'].includes(status)) throw fail();
    if (outcome?.outcome === 'completed' && status !== 'completed') throw fail();
    const artifacts = [reference];
    // Free-form results stay private, outside the bounded metadata manifest.
    if (status === 'completed') {
      if (typeof outcome.sessionRef !== 'string' || !outcome.sessionRef) throw fail();
      artifacts.push(await publish(directory, 'normalized-result.json', { version: 1, present: outcome.result !== undefined, ...(outcome.result !== undefined ? { result: outcome.result } : {}) }, 1024 * 1024));
    }
    let processEvidence = null, spool = null;
    if (outcome?.evidenceProcess === true || error?.evidenceProcess === true) {
      const id = receipt?.operationId;
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw fail();
      for (const suffix of ['receipt.json', 'stdout.log', 'stderr.log']) artifacts.push(await artifact(directory, `${id}.${suffix}`));
      const raw = JSON.parse(await readFile(path.join(directory, `${id}.receipt.json`), 'utf8'));
      if (raw.operationId !== id || raw.exitCode !== receipt.exitCode || raw.timedOut !== receipt.timedOut || raw.stopped !== receipt.stopped ||
          path.resolve(raw.stdoutPath) !== path.join(directory, `${id}.stdout.log`) || path.resolve(raw.stderrPath) !== path.join(directory, `${id}.stderr.log`)) throw fail();
      validateProcess(raw, status);
      const context = producerContext();
      if (context?.store) {
        const operation = context.store.processOperation(id);
        if (operation.job_id !== intent.jobId || operation.scope_id !== intent.scopeId || path.resolve(operation.directory) !== directory ||
            JSON.parse(operation.terminal).receiptDigest !== digest(raw)) throw fail();
      }
      processEvidence = processRecord(raw);
      const bytes = await readFile(path.join(directory, `${id}.stdout.log`));
      spool = spoolRecord(id, bytes);

    }
    // Only the Codex adapter declares these artifacts. Other version-1 adapters
    // retain their existing result contract without invented process provenance.
    const declaredArtifacts = outcome?.evidenceArtifacts !== undefined ? outcome.evidenceArtifacts : error?.evidenceArtifacts;
    if (declaredArtifacts !== undefined) {
      if (!Array.isArray(declaredArtifacts) || declaredArtifacts.length > 3 || new Set(declaredArtifacts).size !== declaredArtifacts.length) throw fail();
      for (const name of declaredArtifacts) {
        if (!['prompt.txt', 'result.txt', 'schema.json'].includes(name)) throw fail();
        artifacts.push(await artifact(directory, name));
      }
    }
    const terminal = { version: 1, jobId: intent.jobId, intentSha256: reference.sha256, outcome: status,
      sessionRef: outcome?.sessionRef ?? sessionRef ?? null, models, process: processEvidence, spool, artifacts };
    return await publish(directory, 'terminal.json', terminal);
  });
}
export async function recordCandidateDisposition(evidence, disposition) {
  return guarded(async () => {
    const terminal = await artifact(evidence.directory, 'terminal.json');
    return publish(evidence.directory, 'candidate.json', { version: 1, jobId: evidence.intent.jobId,
      terminalSha256: terminal.sha256, intentSha256: evidence.reference.sha256, ...disposition });
  });
}
// Inspection only. No result adoption, replay, scope release, or accounting writes.
export async function readJobEvidence(directory, jobId, expectedTerminal = null) {
  return guarded(async () => {
    const terminalRef = await artifact(directory, 'terminal.json');
    if (terminalRef.bytes > LIMIT || (expectedTerminal && (expectedTerminal.sha256 !== terminalRef.sha256 || expectedTerminal.bytes !== terminalRef.bytes))) throw fail();
    const terminal = JSON.parse(await readFile(path.join(directory, 'terminal.json'), 'utf8'));
    if (terminal.version !== 1 || terminal.jobId !== jobId || !Array.isArray(terminal.artifacts) || terminal.artifacts.length > 8 ||
        !['completed', 'waiting_capacity', 'failed', 'timeout', 'cancelled'].includes(terminal.outcome)) throw fail();
    const intent = await artifact(directory, 'intent.json');
    const identity = JSON.parse(await readFile(path.join(directory, 'intent.json'), 'utf8'));
    if (identity.version !== 1 || !['codex', 'version-1-adapter'].includes(identity.runtime) || !['plan', 'implement', 'review'].includes(identity.role) ||
        ['projectId', 'scopeId', 'ticketId', 'continuationId'].some(key => identity[key] !== null && (typeof identity[key] !== 'string' || identity[key].length > 256)) ||
        (identity.attempt !== null && (!Number.isSafeInteger(identity.attempt) || identity.attempt < 1))) throw fail();
    if (intent.sha256 !== terminal.intentSha256 || JSON.parse(await readFile(path.join(directory, 'intent.json'), 'utf8')).jobId !== jobId) throw fail();
    const names = terminal.artifacts.map(item => item?.file);
    if (new Set(names).size !== names.length || !names.includes('intent.json') ||
        (terminal.outcome === 'completed' && (!names.includes('normalized-result.json') || typeof terminal.sessionRef !== 'string' || !terminal.sessionRef)) ||
        !('process' in terminal) || !('spool' in terminal)) throw fail();
    for (const expected of terminal.artifacts) {
      const actual = await artifact(directory, expected.file);
      if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw fail();
    }
    const allowed = new Set(['intent.json', 'normalized-result.json', 'prompt.txt', 'result.txt', 'schema.json']);
    if (terminal.process !== null) {
      const id = terminal.process?.operationId;
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw fail();
      for (const suffix of ['receipt.json', 'stdout.log', 'stderr.log']) {
        const name = `${id}.${suffix}`; allowed.add(name); if (!names.includes(name)) throw fail();
      }
      const raw = JSON.parse(await readFile(path.join(directory, `${id}.receipt.json`), 'utf8'));
      validateProcess(raw, terminal.outcome);
      if (JSON.stringify(processRecord(raw)) !== JSON.stringify(terminal.process)) throw fail();
      const actualSpool = spoolRecord(id, await readFile(path.join(directory, `${id}.stdout.log`)));
      if (JSON.stringify(actualSpool) !== JSON.stringify(terminal.spool)) throw fail();
      const spool = terminal.spool;
      if (!spool || spool.file !== `${id}.stdout.log` || spool.malformed !== false || spool.trailingBytes !== 0 ||
          !Number.isSafeInteger(spool.bytes) || spool.bytes < 0 || spool.completeBytes !== spool.bytes ||
          !Number.isSafeInteger(spool.records) || spool.records < 0) throw fail();
    } else if (terminal.spool !== null) throw fail();
    if (names.some(name => !allowed.has(name))) throw fail();
    let disposition = null;
    try {
      const ref = await artifact(directory, 'candidate.json');
      if (ref.bytes > LIMIT) throw fail();
      disposition = JSON.parse(await readFile(path.join(directory, 'candidate.json'), 'utf8'));
      if (disposition.version !== 1 || disposition.jobId !== jobId || disposition.intentSha256 !== intent.sha256 ||
          disposition.terminalSha256 !== terminalRef.sha256 || terminal.outcome !== 'completed' ||
          !['candidate', 'no_change', 'failed'].includes(disposition.outcome) ||
          (disposition.outcome === 'candidate' && (!/^[a-f0-9]{40,64}$/.test(disposition.headSha) || !/^[a-f0-9]{40,64}$/.test(disposition.treeSha)))) throw fail();
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { ...terminal, disposition };
  });
}
