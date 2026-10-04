import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink, readdir, access } from 'node:fs/promises';
import { openSync, writeSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** An interrupted controller must not race an old worker still settling. */
export async function reconcileProcesses(root, signal) {
  async function scan(directory) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
    const files = [];
    for (const entry of entries) {
      if (entry.isDirectory()) files.push(...await scan(path.join(directory, entry.name)));
      else if (entry.isFile() && entry.name.endsWith('.active.json')) files.push(path.join(directory, entry.name));
    }
    return files;
  }
  const files = (await Promise.all(['jobs', 'checks', 'git-logs', 'auth-checks', 'catalog'].map(name => scan(path.join(root, name))))).flat();
  for (const file of files) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const data = await readFile(file, 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      if (!data || !alive(data.supervisorPid) && !alive(data.childPid)) break;
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

/** Shell-free commands; wrapper stdin is a lifeline separate from the job stdin.
 * A killed controller closes it, so the wrapper kills the entire job tree. */
export async function runProcess({ argv, cwd, directory, timeoutSeconds = 120, input = '', env = {}, signal, onLine }) {
  argv = await resolveArgv(argv);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID(), request = path.join(directory, `${id}.request.json`), receipt = path.join(directory, `${id}.receipt.json`);
  await writeFile(request, JSON.stringify({ argv, cwd, timeoutSeconds, input, env, directory, id }), { mode: 0o600, flag: 'wx' });
  const child = spawn(process.execPath, [self, '--supervise', request], { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let error, buffer = '';
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
  await new Promise(resolve => { child.on('error', e => { error = e; resolve(); }); child.on('close', resolve); });
  if (buffer.length > 0) { try { onLine?.(buffer); } catch {} buffer = ''; }
  clearTimeout(timeout); clearTimeout(hardTimeout); signal?.removeEventListener('abort', cancel);
  await unlink(request).catch(() => {});
  if (error) throw error;
  let result;
  try { result = JSON.parse(await readFile(receipt, 'utf8')); } catch { throw new Error('Subprocess ended without durable receipt'); }
  return { ...result, stdout: await readFile(result.stdoutPath, 'utf8'), stderr: await readFile(result.stderrPath, 'utf8') };
}

async function supervise(requestPath) {
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  const stdoutPath = path.join(request.directory, `${request.id}.stdout.log`), stderrPath = path.join(request.directory, `${request.id}.stderr.log`);
  const out = openSync(stdoutPath, 'wx', 0o600), err = openSync(stderrPath, 'wx', 0o600);
  const environment = { ...process.env, ...request.env };
  for (const key of Object.keys(environment)) if (environment[key] === null) delete environment[key];
  const startedAt = Date.now(); let stopped = false, timedOut = false, outputExceeded = false, bytes = 0, launchError;
  const child = spawn(request.argv[0], request.argv.slice(1), { cwd: request.cwd, env: environment, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
  const activeFile = path.join(request.directory, `${request.id}.active.json`);
  const activeWriting = writeFile(activeFile, JSON.stringify({ supervisorPid: process.pid, childPid: child.pid, startedAt }), { mode: 0o600 });
  const stop = () => { stopped = true; terminate(child.pid); };
  process.stdin.resume(); process.stdin.on('end', stop); process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const timer = setTimeout(() => { timedOut = true; stop(); }, request.timeoutSeconds * 1000);
  const capture = (fd, chunk, forward) => {
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT) { outputExceeded = true; stop(); return; }
    writeSync(fd, chunk);
    if (forward) process.stdout.write(chunk);
  };
  child.stdout.on('data', c => capture(out, c, true)); child.stderr.on('data', c => capture(err, c, false));
  child.on('exit', () => { terminate(child.pid); });
  child.stdin.on('error', () => {});
  const settled = new Promise(resolve => { child.on('error', e => { launchError = e.message; resolve(null); }); child.on('close', resolve); });
  await activeWriting.catch(e => { stop(); throw e; });
  child.stdin.end(request.input);
  const exitCode = await settled;
  // Descendants must not retain pipes or continue after their leader settles.
  terminate(child.pid); clearTimeout(timer); closeSync(out); closeSync(err);
  const receipt = { argv: request.argv, startedAt, endedAt: Date.now(), exitCode, stopped, timedOut, outputExceeded, launchError, stdoutPath, stderrPath };
  await writeFile(path.join(request.directory, `${request.id}.receipt.json`), JSON.stringify(receipt), { mode: 0o600 });
  await unlink(activeFile);
  process.exit(0);
}
if (process.argv[2] === '--supervise') supervise(process.argv[3]).catch(e => { console.error(e.message); process.exit(1); });
