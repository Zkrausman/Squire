import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runProcess } from '../src/process.mjs';

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
