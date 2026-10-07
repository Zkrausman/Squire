import test from './standalone.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runProcess, reconcileProcesses } from '../src/process.mjs';

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'squire-test-process-'));
  t.after(async () => { const target = await realpath(root), relative = path.relative(await realpath(os.tmpdir()), target); assert.ok(!path.isAbsolute(relative) && !relative.includes(path.sep) && relative.startsWith('squire-test-')); await rm(target, { recursive: true, force: true, maxRetries: 5 }); }); return root;
}
test('process captures fast output and durable failure receipts without shell expansion', async t => {
  const root = await temporary(t);
  const result = await runProcess({ argv: [process.execPath, '-e', 'console.log(process.argv[1]);console.error("failure");process.exit(7)', '$(echo should-not-run)'], cwd: root, directory: root, timeoutSeconds: 5 });
  assert.equal(result.exitCode, 7); assert.match(result.stdout, /\$\(echo should-not-run\)/); assert.match(result.stderr, /failure/);
  assert.ok(result.endedAt >= result.startedAt);
});
test('silent child timeout settles and is never a passing check', async t => {
  const root = await temporary(t), start = Date.now();
  const result = await runProcess({ argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: root, directory: root, timeoutSeconds: 1 });
  assert.equal(result.timedOut, true); assert.equal(result.stopped, true); assert.ok(Date.now() - start < 10000);
});
test('cancellation kills a running subprocess', async t => {
  const root = await temporary(t), abort = new AbortController();
  const running = runProcess({ argv: [process.execPath, '-e', 'console.log("ready");setInterval(()=>{},1000)'], cwd: root, directory: root, timeoutSeconds: 20, signal: abort.signal, onLine: line => { if (line === 'ready') abort.abort(); } });
  const result = await running; assert.equal(result.stopped, true);
});

const activeRecord = { supervisorPid: 100000001, childPid: 100000002, startedAt: 1 };
async function activeFile(root, directory, contents = JSON.stringify(activeRecord), name = 'fixture.active.json') {
  const target = path.join(root, directory, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
  return target;
}
function observeOnly(t, isAlive) {
  const observed = t.mock.method(process, 'kill', pid => {
    if (!isAlive(pid)) throw Object.assign(new Error('Fixture process absent'), { code: 'ESRCH' });
    return true;
  });
  // Assert outside the mock: liveness deliberately catches probe errors.
  t.after(() => { for (const call of observed.mock.calls) assert.equal(call.arguments[1], 0, 'reconciliation must never signal a discovered process'); });
  return observed;
}
function immediateWait(t, onWait = () => {}) {
  return t.mock.method(globalThis, 'setTimeout', (callback, milliseconds) => {
    assert.equal(milliseconds, 200, 'retain the bounded settling interval');
    queueMicrotask(() => { onWait(); callback(); });
  });
}
test('reconciliation covers every supervised directory, including nested planning and GitHub commands', async t => {
  for (const directory of ['jobs/implement/1', 'planning/2/job', 'checks/a/behavior', 'git-logs', 'github-logs', 'auth-checks', 'catalog']) {
    await t.test(directory, async t => {
      const root = await temporary(t), file = await activeFile(root, directory);
      // This PID could belong to a stale record or an unrelated/reused process.
      // The current format cannot prove identity, so it must only wait/refuse.
      const observed = observeOnly(t, () => true), waited = immediateWait(t);
      await assert.rejects(reconcileProcesses(root), error => error.message === `Interrupted job remains live; recovery refused: ${file}`);
      assert.equal(waited.mock.callCount(), 49);
      assert.ok(observed.mock.callCount() > 0);
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), activeRecord);
    });
  }
});
test('planning and GitHub records settle read-only and repeated reconciliation has no stop effect', async t => {
  for (const directory of ['planning/3/job', 'github-logs']) {
    await t.test(directory, async t => {
      const root = await temporary(t), file = await activeFile(root, directory);
      let live = true;
      const observed = observeOnly(t, pid => live && pid === activeRecord.childPid);
      const waited = immediateWait(t, () => { live = false; });
      await reconcileProcesses(root);
      await reconcileProcesses(root);
      assert.equal(waited.mock.callCount(), 1);
      assert.equal(observed.mock.callCount(), 6);
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), activeRecord);
    });
  }
});
test('reconciliation ignores other artifacts, unowned directories and missing process roots', async t => {
  const root = await temporary(t);
  for (const [directory, name] of [['planning/1/job', 'fixture.receipt.json'], ['github-logs', 'fixture.request.json'], ['github-logs', 'fixture.active.json.tmp'], ['workspaces/project', 'fixture.active.json'],
    ['planning/1/app', 'fixture.active.json'], ['planning/1/app/nested', 'fixture.active.json'], ['planning/1/job/worker-temp', 'fixture.active.json'], ['planning/unowned/job', 'fixture.active.json']]) {
    await activeFile(root, directory, 'not a process record', name);
  }
  const observed = observeOnly(t, () => { assert.fail('irrelevant files must not be inspected'); });
  await reconcileProcesses(root);
  assert.equal(observed.mock.callCount(), 0);
});
test('malformed active evidence blocks with its path before any PID observation', async t => {
  const malformed = ['{', 'null', 'false', '[]', '{}', JSON.stringify({ ...activeRecord, supervisorPid: '12' }),
    JSON.stringify({ ...activeRecord, supervisorPid: 0 }), JSON.stringify({ ...activeRecord, childPid: -1 }),
    JSON.stringify({ ...activeRecord, childPid: undefined }), JSON.stringify({ ...activeRecord, childPid: 1.5 }),
    JSON.stringify({ ...activeRecord, startedAt: undefined }), JSON.stringify({ ...activeRecord, startedAt: 'yesterday' })];
  for (const directory of ['planning/1/job', 'github-logs']) {
    await t.test(directory, async t => {
      const root = await temporary(t), observed = observeOnly(t, () => false);
      for (const contents of malformed) {
        const file = await activeFile(root, directory, contents);
        await assert.rejects(reconcileProcesses(root), error => error.message === `Invalid active process record; recovery refused: ${file}`);
        assert.equal(await readFile(file, 'utf8'), contents);
      }
      assert.equal(observed.mock.callCount(), 0);
    });
  }
});
test('a receipt never overrides still-live or malformed active evidence', async t => {
  const root = await temporary(t), file = await activeFile(root, 'github-logs');
  await activeFile(root, 'github-logs', JSON.stringify({ stopped: true, exitCode: 0 }), 'fixture.receipt.json');
  observeOnly(t, () => true); immediateWait(t);
  await assert.rejects(reconcileProcesses(root), /Interrupted job remains live/);
  await writeFile(file, '{}');
  await assert.rejects(reconcileProcesses(root), /Invalid active process record/);
});
test('a concurrently removed active file settles, while cancellation and uncertain liveness refuse recovery', async t => {
  const root = await temporary(t), file = await activeFile(root, 'planning/1/job');
  observeOnly(t, () => true);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(reconcileProcesses(root, aborted.signal), /Recovery cancelled/);
  t.mock.method(globalThis, 'setTimeout', callback => { void unlink(file).then(callback); });
  await reconcileProcesses(root);
  t.mock.restoreAll();
  await activeFile(root, 'github-logs');
  const uncertain = t.mock.method(process, 'kill', () => { throw Object.assign(new Error('Permission unavailable'), { code: 'EPERM' }); });
  immediateWait(t);
  await assert.rejects(reconcileProcesses(root), /Interrupted job remains live/);
  assert.ok(uncertain.mock.calls.every(call => call.arguments[1] === 0));
});
