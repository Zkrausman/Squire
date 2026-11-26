import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {validateProjectPayloadJson, validateLargeProjectPayloadJson} from '../src/project-task.mjs';
import {artifactCliChild} from './helpers/artifact-cli-child.mjs';

const author = new URL('../bin/squire-author-envelope.mjs', import.meta.url);
const inspector = new URL('../bin/squire-envelope-inspect.mjs', import.meta.url);
const file = (local, wire, classification, encoding) => ['--file', local, wire, classification, encoding];
const profiles = [['standard', validateProjectPayloadJson], ['large', validateLargeProjectPayloadJson]];

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'squire-author-envelope-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return {
    dir, output: join(dir, 'envelope.json'),
    async input(name, bytes) {
      const path = join(dir, name);
      await writeFile(path, bytes);
      return path;
    },
  };
}

async function rejectsFresh(output, args) {
  const result = await artifactCliChild(author, args);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.ok(result.stderr === 'SYNTHETIC_ENVELOPE_REJECTED\n' || result.stderr.startsWith('Usage:'));
  await assert.rejects(stat(output), {code: 'ENOENT'});
}

for (const [profile, validate] of profiles) {
  test(profile + ' authors and inspects the exact declared synthetic fixture bytes', async t => {
    const {input, output} = await fixture(t);
    const rows = [
      ['src/z.mjs', 'SOURCE', 'utf-8', Buffer.from('throw Error("never run");\r\n// \\雪\n')],
      ['assets/zero.bin', 'LOCAL_ASSET', 'base64', Buffer.alloc(0)],
      ['assets/data.bin', 'LOCAL_ASSET', 'base64', Buffer.from(Array.from({length: 256}, (_, i) => i))],
      ['doc.md', 'DOC', 'utf-8', Buffer.from('"café"\n')],
    ];
    const args = [];
    for (const [i, [wire, classification, encoding, bytes]] of rows.entries()) {
      args.push(...file(await input('local ' + i, bytes), wire, classification, encoding));
    }
    await input('unselected', Buffer.from([0xff]));
    const result = await artifactCliChild(author, [profile, output, ...args]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'SYNTHETIC_ENVELOPE_WRITTEN\n');
    const bytes = await readFile(output);
    const wireFiles = JSON.parse(bytes).files;
    const decoded = validate(bytes).files;
    assert.equal(decoded.length, rows.length);
    for (const [i, [path, classification, encoding, original]] of rows.entries()) {
      assert.equal(wireFiles[i].encoding, encoding);
      assert.equal(decoded[i].path, path);
      assert.equal(decoded[i].classification, classification);
      assert.deepEqual(Buffer.from(decoded[i].content), original);
    }
    assert.equal((await stat(output)).mode & 0o077, 0);
    const inspection = await artifactCliChild(inspector, [profile, output]);
    assert.equal(inspection.code, 0, inspection.stderr);
    assert.deepEqual(JSON.parse(inspection.stdout), {
      profile, envelope_valid: true, encoded_envelope_bytes: bytes.length,
      decoded_bytes: rows.reduce((n, row) => n + row[3].length, 0),
      files_by_class: {SOURCE: 1, LOCAL_ASSET: 2, DOC: 1},
    });
  });
}

test('65,536 SOURCE bytes fit standard and the next byte requires large', async t => {
  const {input, output} = await fixture(t);
  const local = await input('source', Buffer.alloc(65536, 97));
  const args = file(local, 'a.js', 'SOURCE', 'utf-8');
  assert.equal((await artifactCliChild(author, ['standard', output + '.fit', ...args])).code, 0);
  const larger = Buffer.alloc(65537, 97);
  await writeFile(local, larger);
  await rejectsFresh(output, ['standard', output, ...args]);
  assert.equal((await artifactCliChild(author, ['large', output, ...args])).code, 0);
  assert.deepEqual(Buffer.from(validateLargeProjectPayloadJson(await readFile(output)).files[0].content), larger);
});

test('base64 expansion exceeds the standard serialized budget before decoded capacity', async t => {
  const {input, output} = await fixture(t);
  const local = await input('asset', Buffer.alloc(400000, 0xfe));
  const args = ['a.bin', 'b.bin'].flatMap(path => file(local, path, 'LOCAL_ASSET', 'base64'));
  await rejectsFresh(output, ['standard', output, ...args]);
  assert.equal((await artifactCliChild(author, ['large', output, ...args])).code, 0);
  const envelope = await readFile(output);
  assert.ok(envelope.length > 1048576);
  assert.equal(validateLargeProjectPayloadJson(envelope).files.reduce((n, f) => n + f.bytes, 0), 800000);
});

test('decoded class totals apply even when the serialized envelope fits', async t => {
  const {input, output} = await fixture(t);
  const local = await input('document', Buffer.alloc(65536, 97));
  const args = ['a', 'b', 'c'].flatMap(path => file(local, path, 'DOC', 'utf-8'));
  await rejectsFresh(output, ['large', output, ...args]);
});

test('invalid declarations, paths, encodings and inputs produce no envelope', async t => {
  const {dir, input, output} = await fixture(t);
  const text = await input('text', 'synthetic');
  const invalid = await input('invalid', Buffer.from([0xc0]));
  const bom = await input('bom', Buffer.from([0xef, 0xbb, 0xbf, 97]));
  const link = join(dir, 'link');
  await symlink(text, link);
  const valid = file(text, 'a', 'SOURCE', 'utf-8');
  for (const args of [
    ['unknown', output, ...valid], ['standard', output], ['large', output, ...valid.slice(0, -1)],
    ['large', output, ...valid, ...valid], ['standard', output, ...file(text, '../a', 'DOC', 'utf-8')],
    ['standard', output, ...file(text, 'a', 'UNKNOWN', 'utf-8')], ['large', output, ...file(text, 'a', 'DOC', 'hex')],
    ...[dir, link, invalid, bom, join(dir, 'missing')].map(source =>
      ['standard', output, ...file(source, 'a', 'DOC', 'utf-8')]),
  ]) await rejectsFresh(output, args);
});

test('fresh publication preserves existing destinations including the selected input', async t => {
  const {input, output} = await fixture(t);
  const local = await input('source', 'synthetic');
  await writeFile(output, 'occupied');
  for (const destination of [output, local]) {
    const result = await artifactCliChild(author, ['large', destination, ...file(local, 'a', 'DOC', 'utf-8')]);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
  }
  assert.equal(await readFile(output, 'utf8'), 'occupied');
  assert.equal(await readFile(local, 'utf8'), 'synthetic');
});
