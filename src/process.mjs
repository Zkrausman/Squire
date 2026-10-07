import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink, readdir, access } from 'node:fs/promises';
import { openSync, writeSync, closeSync, fsyncSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from './store.mjs';
import { digest, Blocker } from './contracts.mjs';
import { producerContext } from './producer-context.mjs';
import { captureProcessIdentity, sameProcessIdentity, unknownProcessIdentity } from './process-identity.mjs';

const self = fileURLToPath(import.meta.url);
const MAX_OUTPUT = 16 * 1024 * 1024;
export async function resolveArgv(argv) {
  if (argv[0] === 'node') return [process.execPath, ...argv.slice(1)];
  if (['npm', 'npx'].includes(argv[0])) {
    const entry = `${argv[0]}-cli.js`, bin = path.dirname(process.execPath);
    const candidates = [path.join(bin, 'node_modules', 'npm', 'bin', entry), path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', entry)];
    for (const candidate of candidates) { try { await access(candidate); return [process.execPath, candidate, ...argv.slice(1)]; } catch {} }
    if (process.platform === 'win32') throw new Error('Cannot locate npm Node entrypoint; configure its native Node argv explicitly');
  }
  return argv;
}
const alive = pid => { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

/** Settle the spawned child and restore deadline/output state before awaiting
 * asynchronous process identity evidence. The recorder has no authority to
 * delay lifecycle cleanup or change its timeout outcome. */
export async function settleChildBeforeIdentity({ settled, targetIdentity, cleanup }) {
  const exitCode = await settled;
  cleanup();
  const targetEvidence = await targetIdentity;
  return { exitCode, targetEvidence };
}

/** An interrupted controller must not race an old worker still settling. */
export async function reconcileProcesses(root, signal, { refuseLegacy = false, store, project } = {}) {
  const entries = directory => readdir(directory, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  async function scan(directory, recursive = true) {
    const files = [];
    for (const entry of await entries(directory)) {
      if (recursive && entry.isDirectory()) files.push(...await scan(path.join(directory, entry.name)));
      else if (entry.isFile() && entry.name.endsWith('.active.json')) files.push(path.join(directory, entry.name));
    }
    return files;
  }
  const files = (await Promise.all(['jobs', 'checks', 'git-logs', 'github-logs', 'auth-checks', 'catalog'].map(name => scan(path.join(root, name))))).flat();
  // Planning also contains cloned service workspaces. Only the attempt's job
  // directory owns process records; neither sibling repositories nor job temp
  // content may become recovery authority merely by containing .active.json.
  const planning = path.join(root, 'planning');
  for (const attempt of await entries(planning)) {
    if (!attempt.isDirectory() || !/^[1-9][0-9]*$/.test(attempt.name)) continue;
    const directory = path.join(planning, attempt.name);
    if ((await entries(directory)).some(entry => entry.isDirectory() && entry.name === 'job')) {
      files.push(...await scan(path.join(directory, 'job'), false));
    }
  }
  for (const file of files) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const contents = await readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return undefined; throw e; });
      if (contents === undefined) break;
      let data;
      try { data = JSON.parse(contents); } catch (cause) { throw new Error(`Invalid active process record; recovery refused: ${file}`, { cause }); }
      if (!data || Array.isArray(data) || !Number.isSafeInteger(data.supervisorPid) || data.supervisorPid <= 0 ||
          !Number.isSafeInteger(data.childPid) || data.childPid <= 0 || !Number.isSafeInteger(data.startedAt) || data.startedAt <= 0) {
        throw new Error(`Invalid active process record; recovery refused: ${file}`);
      }
      if (store && typeof data.operationId === 'string') {
        const registered = store.db.prepare(`SELECT o.directory,o.scope_id,s.project FROM process_operations o
          JOIN producer_scopes s ON s.id=o.scope_id WHERE o.id=?`).get(data.operationId);
        // Registered work is fenced by its durable producer scope, independently
        // of PID liveness. This permits unrelated lanes to continue on restart.
        if (registered?.project === project && path.resolve(registered.directory) === path.dirname(file) &&
            path.basename(file) === `${data.operationId}.active.json`) break;
      }
      if (refuseLegacy) throw new Blocker('producer_unresolved', `Legacy active evidence has no durable producer outcome; recovery refused: ${file}`);
      // PID liveness is not ownership or process-start identity. Only observe:
      // a live (possibly reused/foreign) PID must settle or block, never be killed.
      if (!alive(data.supervisorPid) && !alive(data.childPid)) break;
      if (signal?.aborted) throw new Error('Recovery cancelled');
      if (attempt === 49) throw new Error(`Interrupted job remains live; recovery refused: ${file}`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}
function terminate(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } }
}

async function saveReceipt(filename, receipt) {
  const fd = openSync(filename, 'wx', 0o600);
  try { writeSync(fd, JSON.stringify(receipt)); fsyncSync(fd); } finally { closeSync(fd); }
}
const terminalRecord = (receipt, kind) => ({ kind, exitCode: receipt.exitCode, endedAt: receipt.endedAt, receiptDigest: digest(receipt) });

function unknownIdentityEvidence(operationId, requestDigest, reason) {
  return { version: 1, operationId, requestDigest,
    supervisor: unknownProcessIdentity({ operationId, requestDigest, role: 'supervisor' }, reason),
    target: unknownProcessIdentity({ operationId, requestDigest, role: 'target' }, reason),
    directTerminal: { status: 'unknown', reason, provenance: 'supervisor-child-lifecycle', observedAt: Date.now() },
    descendantCoverage: { status: 'unknown', reason: 'no_complete_descendant_inventory',
      provenance: 'process-group-and-stdio-observations-do-not-prevent-descendant-escape', observedAt: Date.now() } };
}

async function observedIdentityEvidence({ operationId, requestDigest, supervisorStart, target, spawned, closeObserved, exitCode, signal }) {
  const supervisorEnd = await captureProcessIdentity({ operationId, requestDigest, role: 'supervisor', pid: process.pid });
  const supervisor = supervisorStart.status !== 'verified' ? supervisorStart :
    supervisorEnd.status !== 'verified' ? supervisorEnd :
      sameProcessIdentity(supervisorStart, supervisorEnd)
        ? { ...supervisorStart, continuity: { status: 'verified', provenance: 'same-supervisor-birth-identity-at-target-terminal', observedAt: supervisorEnd.observedAt } }
        : unknownProcessIdentity({ operationId, requestDigest, role: 'supervisor' }, 'supervisor_identity_not_stable');
  const directTerminal = spawned && closeObserved && target.status === 'verified'
    ? { status: 'verified', provenance: 'node-close-event-for-the-spawned-target-handle', observedAt: Date.now(), exitCode, signal: signal ?? null }
    : { status: 'unknown', provenance: 'supervisor-child-lifecycle', observedAt: Date.now(),
      reason: !spawned ? 'target_spawn_not_observed' : !closeObserved ? 'target_close_not_observed' : target.reason ?? 'target_identity_unknown' };
  return { version: 1, operationId, requestDigest, supervisor, target,
    directTerminal,
    // Node's stdio close and a direct-child identity do not establish that every
    // descendant remained registered or stayed in the original process group.
    descendantCoverage: { status: 'unknown', reason: 'no_complete_descendant_inventory',
      provenance: 'process-group-and-stdio-observations-do-not-prevent-descendant-escape', observedAt: Date.now() } };
}

/** Registration precedes the outer spawn. Neither a new controller nor a second
 * supervisor may consume an existing grant again. Random tokens prove protocol
 * ownership only; they are not OS process identities. */
export async function runProcess(options) {
  const context = producerContext();
  if (!context?.scopeId && context?.standalone !== true) throw new Blocker('producer_context_required', 'A durable producer scope is required before launching a process');
  try { return await registeredProcess(options, context); }
  catch (error) {
    // Existing adapter catches must not turn unreadable/incompatible evidence
    // into permission for another launch, debit or successful scope closure.
    if (context.scopeId) context.lifecycle.persistenceFailed = true;
    throw error;
  }
}
async function registeredProcess({ argv, cwd, directory, timeoutSeconds = 120, input = '', env = {}, signal, onLine }, context) {
  argv = await resolveArgv(argv);
  directory = path.resolve(directory); cwd = path.resolve(cwd);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID(), request = path.join(directory, `${id}.request.json`), receiptFile = path.join(directory, `${id}.receipt.json`);
  const payload = { argv, cwd, timeoutSeconds, input, env, directory, id };
  const grant = context.scopeId ? context.store.registerProcess(context.scopeId, context.jobId, id, directory, digest(payload)) : null;
  await writeFile(request, JSON.stringify({ ...payload, grant, standalone: !grant }), { mode: 0o600, flag: 'wx' });
  await context.onRegistered?.({ id, request, grant });
  let child;
  const outerFailure = async error => {
    const stdoutPath = path.join(directory, `${id}.stdout.log`), stderrPath = path.join(directory, `${id}.stderr.log`);
    await writeFile(stdoutPath, '', { flag: 'wx', mode: 0o600 }); await writeFile(stderrPath, '', { flag: 'wx', mode: 0o600 });
    const now = Date.now(), result = { operationId: id, argv, startedAt: now, endedAt: now, exitCode: null, stopped: false, timedOut: false, outputExceeded: false,
      launchError: error.message, stdoutPath, stderrPath, identityEvidence: unknownIdentityEvidence(id, digest(payload), 'supervisor_spawn_not_observed') };
    await saveReceipt(receiptFile, result);
    if (grant) context.store.finishProcess(grant, 'registered', terminalRecord(result, 'not_started'));
  };
  try { child = spawn(process.execPath, [self, '--supervise', request], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
  catch (error) { await outerFailure(error); throw error; }
  let error, launchError, buffer = '';
  child.stdin.on('error', () => {});
  const cancel = () => { child.stdin.end(); };
  const timeout = setTimeout(cancel, timeoutSeconds * 1000 + 5000);
  const hardTimeout = setTimeout(() => { error = new Error('Supervisor failed to settle after cancellation'); terminate(child.pid); }, timeoutSeconds * 1000 + 15000);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  child.stdout.on('data', chunk => {
    buffer += chunk.toString();
    if (buffer.length > MAX_OUTPUT) { error = new Error('Supervisor output exceeded limit'); cancel(); buffer = ''; }
    let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); try { onLine?.(line); } catch {} }
  });
  child.stderr.on('data', () => {});
  // Error does not mean stdio is closed. Always wait for close, including ENOENT.
  await new Promise(resolve => { child.on('error', e => { launchError = e; }); child.on('close', resolve); });
  if (buffer.length > 0) { try { onLine?.(buffer); } catch {} }
  clearTimeout(timeout); clearTimeout(hardTimeout); signal?.removeEventListener('abort', cancel);
  if (launchError) { await outerFailure(launchError); throw launchError; }
  if (error) throw error;
  let result;
  try { result = JSON.parse(await readFile(receiptFile, 'utf8')); } catch { throw new Blocker('producer_unresolved', 'Subprocess ended without durable receipt', { operationId: id }); }
  if (grant) {
    let terminal; try { terminal = JSON.parse(context.store.processOperation(id).terminal); } catch {}
    if (!terminal || terminal.receiptDigest !== digest(result) || result.operationId !== id)
      throw new Blocker('producer_unresolved', 'Canonical process outcome is absent or incompatible', { operationId: id });
  }
  await context.onTerminal?.({ id, result });
  const output = { ...result, stdout: await readFile(result.stdoutPath, 'utf8'), stderr: await readFile(result.stderrPath, 'utf8') };
  // Preserve private request evidence until the complete result can be returned.
  await unlink(request).catch(() => {});
  return output;
}

async function supervise(requestPath) {
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  const { grant, standalone, ...payload } = request;
  if (!grant && standalone !== true) throw new Error('Missing durable process grant');
  const store = grant ? new Store(grant.directory) : null;
  try {
    // Consume supervisor ownership before touching logs, and the target grant
    // immediately before spawn. A duplicate wrapper cannot corrupt evidence.
    if (grant) store.claimProcess(grant, 'registered', 'supervisor', digest(payload));
    const stdoutPath = path.join(request.directory, `${request.id}.stdout.log`), stderrPath = path.join(request.directory, `${request.id}.stderr.log`);
    const out = openSync(stdoutPath, 'wx', 0o600), err = openSync(stderrPath, 'wx', 0o600);
    const environment = { ...process.env, ...request.env };
    for (const key of Object.keys(environment)) if (environment[key] === null) delete environment[key];
    const startedAt = Date.now(); let stopped = false, timedOut = false, outputExceeded = false, bytes = 0, launchError, child, spawned = false;
    const requestDigest = digest(payload);
    let timer;
    const stop = () => { stopped = true; terminate(child?.pid); };
    process.stdin.resume(); process.stdin.on('end', stop); process.on('SIGTERM', stop); process.on('SIGINT', stop);
    const supervisorIdentityStart = await captureProcessIdentity({ operationId: request.id, requestDigest, role: 'supervisor', pid: process.pid });
    if (grant) store.claimProcess(grant, 'supervisor', 'target', digest(payload));
    try {
      child = spawn(request.argv[0], request.argv.slice(1), { cwd: request.cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    } catch (error) {
      fsyncSync(out); fsyncSync(err); closeSync(out); closeSync(err);
      const receipt = { operationId: request.id, argv: request.argv, startedAt, endedAt: Date.now(), exitCode: null,
        stopped, timedOut, outputExceeded, launchError: error.message, stdoutPath, stderrPath,
        identityEvidence: await observedIdentityEvidence({ operationId: request.id, requestDigest, supervisorStart: supervisorIdentityStart,
          target: unknownProcessIdentity({ operationId: request.id, requestDigest, role: 'target' }, 'target_spawn_not_observed'),
          spawned: false, closeObserved: false }) };
      await saveReceipt(path.join(request.directory, `${request.id}.receipt.json`), receipt);
      if (grant) store.finishProcess(grant, 'target', terminalRecord(receipt, 'not_started'));
      process.exit(0);
      return;
    }
    const activeFile = path.join(request.directory, `${request.id}.active.json`);
    const activeWriting = writeFile(activeFile, JSON.stringify({ operationId: request.id, supervisorPid: process.pid, childPid: child.pid, startedAt }), { mode: 0o600, flag: 'wx' });
    timer = setTimeout(() => { timedOut = true; stop(); }, request.timeoutSeconds * 1000);
    const capture = (fd, chunk, forward) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) { outputExceeded = true; stop(); return; }
      writeSync(fd, chunk);
      if (forward) process.stdout.write(chunk);
    };
    child.stdout.on('data', c => capture(out, c, true)); child.stderr.on('data', c => capture(err, c, false));
    let targetIdentity = Promise.resolve(unknownProcessIdentity({ operationId: request.id, requestDigest, role: 'target' }, 'target_spawn_not_observed'));
    child.on('spawn', () => {
      spawned = true;
      targetIdentity = captureProcessIdentity({ operationId: request.id, requestDigest, role: 'target', pid: child.pid,
        expectedParentPid: process.pid, launchHandle: child, requireSessionLeader: process.platform !== 'win32' });
      if (stopped) stop();
    });
    child.on('exit', () => { terminate(child.pid); });
    child.stdin.on('error', () => {});
    let closeObserved = false, terminalSignal = null;
    const settled = new Promise(resolve => {
      child.on('error', e => { launchError = e.message; });
      child.on('close', (code, signal) => { closeObserved = true; terminalSignal = signal; resolve(code); });
    });
    let activeError;
    await activeWriting.catch(error => { activeError = error; stop(); });
    child.stdin.end(request.input);
    const { exitCode, targetEvidence } = await settleChildBeforeIdentity({ settled, targetIdentity, cleanup: () => {
      terminate(child.pid); clearTimeout(timer);
      fsyncSync(out); fsyncSync(err); closeSync(out); closeSync(err);
    } });
    if (activeError) throw activeError;
    const receipt = { operationId: request.id, argv: request.argv, startedAt, endedAt: Date.now(), exitCode, stopped, timedOut, outputExceeded, launchError, stdoutPath, stderrPath,
      identityEvidence: await observedIdentityEvidence({ operationId: request.id, requestDigest, supervisorStart: supervisorIdentityStart,
        target: targetEvidence, spawned, closeObserved, exitCode, signal: terminalSignal }) };
    await saveReceipt(path.join(request.directory, `${request.id}.receipt.json`), receipt);
    if (grant) store.finishProcess(grant, 'target', terminalRecord(receipt, spawned ? 'terminal' : 'not_started'));
    await unlink(activeFile);
  } finally { store?.close(); }
  process.exit(0);
}
if (process.argv[2] === '--supervise') supervise(process.argv[3]).catch(e => { console.error(e.message); process.exit(1); });
