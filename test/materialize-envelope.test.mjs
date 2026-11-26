import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {PROJECT_OUTPUT_LARGE_PROFILE} from '../src/project-coding-profile.mjs';
import {materializeSyntheticStage} from '../bin/squire-materialize-envelope.mjs';
import {verifyStage, verifyLargeProjectStage} from '../src/multifile-staging.mjs';
import {buildExport, buildLargeProjectExport, verifyExport, verifyLargeProjectExport} from '../src/multifile-export.mjs';
import {artifactCliChild} from './helpers/artifact-cli-child.mjs';

const command = new URL('../bin/squire-materialize-envelope.mjs', import.meta.url);
const author = new URL('../bin/squire-author-envelope.mjs', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const ports = {fs, uid: process.getuid()};
const wire = (files) => Buffer.from(JSON.stringify({schema: 'SQUIRE2_PROJECT_FILE_ENVELOPE_V1', files}));
const entry = (path, classification, content, encoding = 'utf-8') => ({path, classification, encoding, content});
const small = entry('src/a.mjs', 'SOURCE', '// fixture only\n');

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'squire-materialize-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const input = join(root, 'envelope.json');
  const stage = join(root, 'stage');
  const run = (profile, source = input, dest = stage, op = 'fixture-1') => artifactCliChild(command, [profile, source, op, dest]);
  return {root, input, stage, run};
}
async function rejectFresh(result, stage) {
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr === 'SYNTHETIC_STAGE_COPY_REJECTED\n' || result.stderr.startsWith('Usage:'));
  await assert.rejects(fs.lstat(stage), {code: 'ENOENT'});
}

for (const [profile, verify, exportCopy, verifyCopy] of [
  ['standard', verifyStage, buildExport, verifyExport],
  ['large', verifyLargeProjectStage, buildLargeProjectExport, verifyLargeProjectExport],
]) {
  test(`${profile} materializes authored mixed fixture and exports the exact verified bytes`, async t => {
    const {root, input, stage, run} = await fixture(t);
    const rows = [
      ['src/main.mjs', 'SOURCE', 'utf-8', Buffer.from('not valid JS syntax @\r\n// 雪\n')],
      ['doc/readme.md', 'DOC', 'utf-8', Buffer.from('"café"\n')],
      ['assets/data.bin', 'LOCAL_ASSET', 'base64', Buffer.from([0, 255, 128, 13])],
      ['assets/empty.bin', 'LOCAL_ASSET', 'base64', Buffer.alloc(0)],
    ];
    const args = [];
    for (const [i, [path, classification, encoding, bytes]] of rows.entries()) {
      const local = join(root, 'input-' + i);
      await fs.writeFile(local, bytes);
      args.push('--file', local, path, classification, encoding);
    }
    const authored = await artifactCliChild(author, [profile, input, ...args]);
    assert.equal(authored.code, 0, authored.stderr);
    const original = await fs.readFile(input);
    const result = await run(profile);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    const receipt = JSON.parse(result.stdout);
    const inspected = await verify(stage, ports);
    assert.equal(inspected.status, 'VERIFIED');
    assert.equal(inspected.caller_label, 'synthetic_stage_fixture');
    assert.equal(inspected.stage_operation_id, 'fixture-1');
    assert.deepEqual(receipt, {
      schema: 'SQUIRE_SYNTHETIC_STAGE_COPY_V1', profile, copy_integrity: 'VERIFIED',
      envelope_sha256: hash(original), stage_manifest_sha256: inspected.manifest_sha256,
      file_count: rows.length, total_bytes: rows.reduce((n, row) => n + row[3].length, 0),
    });
    assert.equal(receipt.stage_manifest_sha256, hash(await fs.readFile(join(stage, 'stage-manifest.json'))));
    assert.equal((await fs.stat(stage)).mode & 0o777, 0o700);
    const exported = join(root, 'export');
    const copied = await exportCopy({stage_dir: stage, stage_manifest_sha256: receipt.stage_manifest_sha256,
      export_operation_id: 'copy-1', caller_label: 'synthetic_fixture', export_dir: exported,
      ...(profile === 'large' ? {output_profile: PROJECT_OUTPUT_LARGE_PROFILE} : {})}, ports);
    assert.equal(copied.completion_status, 'COMPLETE');
    assert.equal((await verifyCopy(exported, ports)).status, 'VERIFIED');
    for (const [i, [path, , , bytes]] of rows.entries()) {
      assert.deepEqual(await fs.readFile(join(stage, path)), bytes);
      assert.equal((await fs.stat(join(stage, path))).mode & 0o777, 0o400);
      assert.deepEqual(await fs.readFile(join(exported, 'project', path)), bytes);
      assert.deepEqual(await fs.readFile(join(root, 'input-' + i)), bytes);
    }
    assert.deepEqual(await fs.readFile(input), original);
    const again = await run(profile);
    assert.equal(again.code, 2);
    assert.equal(again.stdout, '');
    assert.deepEqual(await verify(stage, ports), inspected);
  });
}

test('standard source boundary, large-only source, and exact large bytes', async t => {
  const {root, input, stage, run} = await fixture(t);
  const fit = 'a'.repeat(65536);
  await fs.writeFile(input, wire([entry('large.txt', 'SOURCE', fit)]));
  assert.equal((await run('standard', input, join(root, 'fit'))).code, 0);
  const larger = fit + 'b';
  const original = wire([entry('large.txt', 'SOURCE', larger)]);
  await fs.writeFile(input, original);
  await rejectFresh(await run('standard'), stage);
  const result = await run('large');
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await verifyLargeProjectStage(stage, ports)).status, 'VERIFIED');
  assert.deepEqual(await fs.readFile(join(stage, 'large.txt')), Buffer.from(larger));
  assert.deepEqual(await fs.readFile(input), original);
});

test('wrong, duplicate, malformed, and decoded overflow inputs reject prior to staging', async t => {
  const {input, stage, run} = await fixture(t);
  for (const bytes of [
    Buffer.from('{"schema":"wrong","files":[]}'), Buffer.from([0xc0]),
    Buffer.from('{"schema":"SQUIRE2_PROJECT_FILE_ENVELOPE_V1","files":[],"files":[]}'),
    wire([small, small]), wire([small, entry('SRC/A.mjs', 'DOC', 'same')]),
    wire([entry('bad.bin', 'LOCAL_ASSET', 'a===', 'base64')]),
    wire([0, 1, 2].map(i => entry(`doc${i}.md`, 'DOC', 'd'.repeat(65536)))),
  ]) {
    await fs.writeFile(input, bytes);
    for (const profile of ['standard', 'large']) await rejectFresh(await run(profile), stage);
    assert.deepEqual(await fs.readFile(input), bytes);
  }
});

test('serialized envelope budgets apply separately from decoded bytes', async t => {
  const {root, input, stage, run} = await fixture(t);
  const body = Buffer.alloc(400000, 0xfe).toString('base64');
  const original = wire(['a.bin', 'b.bin'].map(path => entry(path, 'LOCAL_ASSET', body, 'base64')));
  assert.ok(original.length > 1048576);
  await fs.writeFile(input, original);
  await rejectFresh(await run('standard'), stage);
  assert.equal((await run('large', input, join(root, 'large'))).code, 0);
  const tooLarge = Buffer.alloc(4194305, 32);
  await fs.writeFile(input, tooLarge);
  await rejectFresh(await run('large'), stage);
  assert.deepEqual(await fs.readFile(input), tooLarge);
});

test('wrong profile, input symlink, occupied destination, and invalid ID preserve inputs', async t => {
  const {root, input, stage, run} = await fixture(t);
  const original = wire([small]);
  await fs.writeFile(input, original);
  const link = join(root, 'input-link');
  await fs.symlink(input, link);
  await rejectFresh(await run('standard', link), stage);
  await rejectFresh(await run('unknown'), stage);
  await rejectFresh(await run('standard', input, stage, 'bad id'), stage);
  await fs.mkdir(stage, {mode: 0o700});
  await fs.writeFile(join(stage, 'keep'), 'prior bytes');
  const occupied = await run('standard');
  assert.equal(occupied.code, 2);
  assert.equal(occupied.stdout, '');
  assert.deepEqual(await fs.readdir(stage), ['keep']);
  assert.equal(await fs.readFile(join(stage, 'keep'), 'utf8'), 'prior bytes');
  assert.deepEqual(await fs.readFile(input), original);
});

for (const [profile, verify] of [['standard', verifyStage], ['large', verifyLargeProjectStage]]) {
  test(`${profile} partial stage is not acknowledged`, async t => {
    const {input, stage} = await fixture(t);
    const bytes = wire([small, entry('z.txt', 'DOC', 'notes')]);
    await fs.writeFile(input, bytes);
    const failing = {...fs, async open(path, ...args) {
      if (path === join(stage, 'z.txt')) throw Error('injected copy failure');
      return fs.open(path, ...args);
    }};
    await assert.rejects(materializeSyntheticStage(profile, input, 'fixture', stage, {...ports, fs: failing}));
    assert.equal((await fs.stat(stage)).isDirectory(), true);
    assert.equal((await verify(stage, ports)).status, 'CORRUPT_OR_INCOMPLETE');
    assert.deepEqual(await fs.readFile(input), bytes);
  });
}
