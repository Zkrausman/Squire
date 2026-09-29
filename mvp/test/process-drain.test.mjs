import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { drainProcessStream } from '../process-drain.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('short-lived Git HEAD remains exact in memory and retained log when log open is delayed', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'squire-drain-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Capture fixture');
  git('config', 'user.email', 'capture@example.invalid');
  await writeFile(path.join(repo, 'file.txt'), 'fixed\n');
  git('add', 'file.txt'); git('commit', '--quiet', '-m', 'fixed base');
  const expected = `${git('rev-parse', 'HEAD')}\n`;
  const delayedOpen = async (...args) => { await delay(100); return open(...args); };
  for (let index = 0; index < 12; index++) {
    const child = spawn('git', ['-C', repo, 'rev-parse', 'HEAD'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const output = path.join(root, `head-${index}.stdout.log`);
    const errors = path.join(root, `head-${index}.stderr.log`);
    const stdout = drainProcessStream(child.stdout, output, 1024, true, () => child.kill(), undefined, delayedOpen);
    const stderr = drainProcessStream(child.stderr, errors, 1024, false, () => child.kill(), undefined, delayedOpen);
    const [exit, captured, err] = await Promise.all([closed, stdout, stderr]);
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(captured.bytes, Buffer.byteLength(expected));
    assert.equal(captured.buffer.toString('utf8'), expected);
    assert.equal((await readFile(output, 'utf8')), expected);
    assert.equal(err.bytes, 0);
    assert.equal((await readFile(errors)).length, 0);
  }
});

test('empty producer remains empty; limit and open failures fail closed', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'squire-drain-controls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const delayedOpen = async (...args) => { await delay(100); return open(...args); };
  const empty = await drainProcessStream(Readable.from([]), path.join(root, 'empty.log'), 10, true, () => {}, undefined, delayedOpen);
  assert.equal(empty.bytes, 0);
  assert.equal((await readFile(path.join(root, 'empty.log'))).length, 0);
  let kills = 0;
  const over = await drainProcessStream(Readable.from([Buffer.from('too many')]), path.join(root, 'over.log'), 2, true, () => { kills++; });
  assert.equal(over.exceeded, true);
  assert.equal(over.bytes, 8);
  assert.equal(kills, 1);
  assert.equal((await readFile(path.join(root, 'over.log'))).length, 0);
  await assert.rejects(() => drainProcessStream(Readable.from([Buffer.from('text')]), path.join(root, 'missing.log'), 10, true,
    () => { kills++; }, undefined, async () => { await delay(10); throw new Error('open failure'); }), /open failure/);
  assert.equal(kills, 2);
});
