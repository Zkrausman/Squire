import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {verifyArtifacts} from '../src/artifact-verifier.mjs';
import {createLifecycle, advanceLifecycle} from '../src/lifecycle.mjs';
import {spec} from './fixtures.mjs';

const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const io = patch => ({lstat: fs.lstat, realpath: fs.realpath, open: fs.open, ...patch});
async function fixture(action) {
  const root = await fs.mkdtemp(join(import.meta.dirname, '.sq04-fixture-'));
  try { return await action(root, {...spec(), task_scope: root}); }
  finally { await fs.rm(root, {recursive: true, force: true}); }
}

test('physical verifier returns known byte count and SHA-256 for a real declared file', () => fixture(async (root, job) => {
  await fs.writeFile(join(root, 'result.txt'), 'abc', {flag: 'wx'});
  const result = await verifyArtifacts(job);
  assert.equal(result.verified, true); assert.equal(result.failure, null);
  assert.deepEqual({...result.artifact_witness['result.txt']}, {byte_count: 3, sha256: abc});
  assert.throws(() => { result.artifact_witness['result.txt'].byte_count = 4; }, TypeError);
  assert.equal((await fs.readFile(join(root, 'result.txt'), 'utf8')), 'abc');
}));
test('missing and empty output fail even with a prior native exit0', () => fixture(async (root, job) => {
  const submitted = createLifecycle(job);
  const running = advanceLifecycle(submitted, 'EVENT_ADMISSION_PASSED', {admission_passed: true, workspace_fence_passed: true, history_fence_passed: true, process_group_allocated: true});
  const verifying = advanceLifecycle(running, 'EVENT_PROCESS_EXIT_ZERO', {process_exit_code: 0});
  for (const phase of ['missing', 'empty']) {
    if (phase === 'empty') await fs.writeFile(join(root, 'result.txt'), '', {flag: 'wx'});
    const result = await verifyArtifacts(job);
    assert.equal(result.verified, false); assert.equal(Object.keys(result.artifact_witness).length, 0);
    assert.equal(result.failure.classification, phase === 'missing' ? 'missing_path' : 'empty_artifact');
    const failed = advanceLifecycle(verifying, 'EVENT_ARTIFACT_VERIFICATION_FAILED');
    assert.equal(failed.terminal_intent, 'FAILED');
    assert.throws(() => advanceLifecycle(verifying, 'EVENT_ARTIFACTS_VERIFIED', {artifact_witness: result.artifact_witness}));
  }
}));
test('nested regular artifacts verify without scanning undeclared files', () => fixture(async (root, job) => {
  await fs.mkdir(join(root, 'output')); await fs.writeFile(join(root, 'output', 'item.txt'), 'abc');
  await fs.writeFile(join(root, 'undeclared.txt'), 'PRIVATE_UNDECLARED_BODY');
  const result = await verifyArtifacts({...job, required_artifacts: ['output/item.txt']});
  assert.equal(result.verified, true); assert.deepEqual(Object.keys(result.artifact_witness), ['output/item.txt']);
  assert.equal(JSON.stringify(result).includes('PRIVATE_UNDECLARED_BODY'), false);
}));
test('leaf and intermediate symlinks are rejected before target content is opened', () => fixture(async (root, job) => {
  await fs.mkdir(join(root, 'actual')); await fs.writeFile(join(root, 'actual', 'body.txt'), 'PRIVATE_TARGET_BODY');
  await fs.symlink('actual/body.txt', join(root, 'result.txt'));
  await fs.symlink('actual', join(root, 'alias'));
  let opens = 0;
  const counted = io({open(...args) { opens++; return fs.open(...args); }});
  for (const name of ['result.txt', 'alias/body.txt']) {
    const result = await verifyArtifacts({...job, required_artifacts: [name]}, {fs: counted});
    assert.equal(result.verified, false); assert.equal(result.failure.classification, 'unsafe_path');
    assert.equal(JSON.stringify(result).includes('PRIVATE_TARGET_BODY'), false);
  }
  assert.equal(opens, 0);
}));
test('root symlink and filesystem root are rejected', () => fixture(async (root, job) => {
  await fs.mkdir(join(root, 'actual')); await fs.symlink('actual', join(root, 'alias'));
  assert.equal((await verifyArtifacts({...job, task_scope: join(root, 'alias')})).failure.classification, 'unsafe_root');
  assert.equal((await verifyArtifacts({...job, task_scope: '/'})).failure.classification, 'unsafe_root');
}));
test('injected read denial fails once and excludes native messages and absolute paths', () => fixture(async (root, job) => {
  await fs.writeFile(join(root, 'result.txt'), 'abc'); let opens = 0;
  const result = await verifyArtifacts(job, {fs: io({open() { opens++; throw Object.assign(new Error('PRIVATE_NATIVE_MESSAGE'), {code: 'EACCES'}); }})});
  assert.equal(result.verified, false); assert.equal(result.failure.classification, 'unreadable_path'); assert.equal(opens, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE_NATIVE_MESSAGE'), false); assert.equal(JSON.stringify(result).includes(root), false);
}));
test('expected capture is job-bound and detects modified real bytes', () => fixture(async (root, job) => {
  await fs.writeFile(join(root, 'result.txt'), 'abc'); const first = await verifyArtifacts(job);
  const expected_capture = {job_id: job.job_id, artifact_witness: first.artifact_witness};
  assert.equal((await verifyArtifacts(job, {expected_capture})).verified, true);
  await fs.writeFile(join(root, 'result.txt'), 'abd');
  const changed = await verifyArtifacts(job, {expected_capture});
  assert.equal(changed.verified, false); assert.equal(changed.failure.classification, 'expected_mismatch');
  await assert.rejects(verifyArtifacts(job, {expected_capture: {...expected_capture, job_id: 'other'}}));
  await assert.rejects(verifyArtifacts(job, {expected_capture: {job_id: job.job_id, artifact_witness: {}}}));
}));
test('a file changed during its read is rejected and its handle is closed', () => fixture(async (root, job) => {
  const path = join(root, 'result.txt'); await fs.writeFile(path, 'abc'); let closed = 0, changed = false;
  const result = await verifyArtifacts(job, {fs: io({async open(...args) {
    const handle = await fs.open(...args);
    return {stat: value => handle.stat(value), async read(...params) {
      const result = await handle.read(...params);
      if (!changed) { changed = true; await fs.writeFile(path, 'different-length'); }
      return result;
    }, async close() { closed++; await handle.close(); }};
  }})});
  assert.equal(result.verified, false); assert.equal(result.failure.classification, 'artifact_changed'); assert.equal(closed, 1);
}));
test('injected directory identity change fails closed without publishing a partial witness', () => fixture(async (root, job) => {
  await fs.writeFile(join(root, 'result.txt'), 'abc'); let rootReads = 0;
  const result = await verifyArtifacts(job, {fs: io({async lstat(path, options) {
    const stat = await fs.lstat(path, options);
    if (path === root && ++rootReads > 1) return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {ino: stat.ino + 1n});
    return stat;
  }})});
  assert.equal(result.verified, false); assert.equal(result.failure.classification, 'directory_changed');
  assert.equal(Object.keys(result.artifact_witness).length, 0);
}));
test('read and close failures discard all witnesses and close once without retry', () => fixture(async (root, job) => {
  await fs.writeFile(join(root, 'result.txt'), 'abc');
  for (const phase of ['read', 'close']) {
    let closes = 0;
    const result = await verifyArtifacts(job, {fs: io({async open(...args) {
      const handle = await fs.open(...args);
      return {stat: value => handle.stat(value), read: (...params) => phase === 'read' ? Promise.reject(new Error('PRIVATE_READ_BODY')) : handle.read(...params),
        async close() { closes++; await handle.close(); if (phase === 'close') throw new Error('PRIVATE_CLOSE_BODY'); }};
    }})});
    assert.equal(result.verified, false); assert.equal(result.failure.classification, phase === 'read' ? 'io_failure' : 'close_failed');
    assert.equal(closes, 1); assert.equal(Object.keys(result.artifact_witness).length, 0);
    assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  }
}));
test('pre-abort performs no I/O and abort during reading closes the opened file', () => fixture(async (root, job) => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const none = {lstat() { calls++; }, realpath() { calls++; }, open() { calls++; }};
  assert.equal((await verifyArtifacts(job, {fs: none, signal: controller.signal})).failure.classification, 'aborted');
  assert.equal(calls, 0);
  await fs.writeFile(join(root, 'result.txt'), 'abc'); const active = new AbortController(); let closes = 0;
  const result = await verifyArtifacts(job, {signal: active.signal, fs: io({async open(...args) {
    const handle = await fs.open(...args);
    return {stat: value => handle.stat(value), async read(...params) { const value = await handle.read(...params); active.abort(); return value; },
      async close() { closes++; await handle.close(); }};
  }})});
  assert.equal(result.verified, false); assert.equal(result.failure.classification, 'aborted'); assert.equal(closes, 1);
}));
test('directory in place of an output is not opened or accepted', () => fixture(async (root, job) => {
  await fs.mkdir(join(root, 'result.txt')); const result = await verifyArtifacts(job);
  assert.equal(result.verified, false); assert.equal(result.failure.classification, 'unsafe_path');
}));
test('a later missing artifact discards previously computed entries', () => fixture(async (root, job) => {
  await fs.writeFile(join(root, 'result.txt'), 'abc');
  const result = await verifyArtifacts({...job, required_artifacts: ['result.txt', 'missing.txt']});
  assert.equal(result.verified, false); assert.equal(result.failure.artifact_path, 'missing.txt');
  assert.equal(Object.keys(result.artifact_witness).length, 0);
}));
test('abort after a metadata await prevents subsequent filesystem operations', () => fixture(async (root, job) => {
  const controller = new AbortController(); let paths = 0, opens = 0;
  const result = await verifyArtifacts(job, {signal: controller.signal, fs: {
    async lstat(...args) { const value = await fs.lstat(...args); controller.abort(); return value; },
    realpath(...args) { paths++; return fs.realpath(...args); }, open(...args) { opens++; return fs.open(...args); }
  }});
  assert.equal(result.failure.classification, 'aborted'); assert.equal(paths, 0); assert.equal(opens, 0);
}));
test('malformed injected stat cannot yield a zero-byte accepted witness', () => fixture(async (root, job) => {
  const result = await verifyArtifacts(job, {fs: io({lstat: async () => ({isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false})})});
  assert.equal(result.verified, false); assert.equal(result.failure.classification, 'invalid_stat');
}));
