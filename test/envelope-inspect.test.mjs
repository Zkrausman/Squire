import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {artifactCliChild} from './helpers/artifact-cli-child.mjs';

const cli = new URL('../bin/squire-envelope-inspect.mjs', import.meta.url);
const run = (...args) => artifactCliChild(cli, args);
const file = (path, classification, encoding, content) => ({path, classification, encoding, content});
const envelope = files => JSON.stringify({schema: 'SQUIRE2_PROJECT_FILE_ENVELOPE_V1', files});
const source = file('src/a.mjs', 'SOURCE', 'utf-8', 'é\n');
const mixed = envelope([
  source,
  file('src/b.mjs', 'SOURCE', 'utf-8', 'bad syntax!'),
  file('note.txt', 'DOC', 'utf-8', '日'),
  file('logo.bin', 'LOCAL_ASSET', 'base64', 'AP8='),
]) + '\n';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'envelope-inspection-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return {dir, path: join(dir, 'input.json')};
}

function accepted(result, profile, encoded, decoded, counts) {
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    profile, envelope_valid: true, encoded_envelope_bytes: encoded,
    decoded_bytes: decoded, files_by_class: counts,
  });
}

function rejected(result, diagnostic) {
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, diagnostic + '\n');
}

for (const profile of ['standard', 'large']) {
  test(profile + ' reports only envelope totals for mixed encodings and classes', async t => {
    const {dir, path} = await fixture(t);
    await writeFile(path, mixed);
    // Decoded lengths are 3 + 11 + 3 + 2. Encoded bytes include the final LF.
    accepted(await run(profile, path), profile, 395, 19, {SOURCE: 2, LOCAL_ASSET: 1, DOC: 1});
    assert.equal(await readFile(path, 'utf8'), mixed);
    assert.deepEqual(await readdir(dir), ['input.json']);
  });

  test(profile + ' rejects malformed and out-of-policy envelopes with fixed diagnostics', async t => {
    const {path} = await fixture(t);
    const docs = Array.from({length: 6}, (_, i) => file(i + '.txt', 'DOC', 'utf-8', 'note'));
    for (const [input, diagnostic] of [
      ['{"unfinished"', 'PROJECT_SCHEMA_MISMATCH'],
      [envelope([source, file('image.bin', 'LOCAL_ASSET', 'base64', 'bad!')]), 'PROJECT_BASE64_INVALID'],
      [envelope([source, source]), 'PROJECT_PATH_COLLISION'],
      [envelope(docs), 'PROJECT_AGGREGATE_CAPACITY_EXCEEDED'],
    ]) {
      await writeFile(path, input);
      rejected(await run(profile, path), diagnostic);
    }
  });

  test(profile + ' accepts its exact encoded cap and rejects one more byte', async t => {
    const {path} = await fixture(t);
    const limit = profile === 'standard' ? 1048576 : 4194304;
    const input = envelope([file('a', 'DOC', 'utf-8', '')]).padEnd(limit, ' ');
    await writeFile(path, input);
    accepted(await run(profile, path), profile, limit, 0, {SOURCE: 0, LOCAL_ASSET: 0, DOC: 1});
    await writeFile(path, input + ' ');
    rejected(await run(profile, path), 'PROJECT_PAYLOAD_TOO_LARGE');
  });
}

test('a 65,537-byte source fits only the large profile', async t => {
  const {path} = await fixture(t);
  const input = envelope([{...source, content: 'x'.repeat(65537)}]);
  await writeFile(path, input);
  rejected(await run('standard', path), 'PROJECT_FILE_SIZE_EXCEEDED');
  accepted(await run('large', path), 'large', Buffer.byteLength(input), 65537,
    {SOURCE: 1, LOCAL_ASSET: 0, DOC: 0});
});

test('requires an explicit profile and one regular file', async t => {
  const {dir, path} = await fixture(t);
  const help = await run('--help');
  assert.equal(help.code, 0);
  assert.equal(help.stderr, '');
  assert.match(help.stdout, /<standard\|large>/);
  for (const args of [[], [path], ['other', path], ['standard', path, 'extra']]) {
    rejected(await run(...args), help.stdout.trimEnd());
  }
  rejected(await run('large', path), 'ENVELOPE_READ_FAILED');
  rejected(await run('standard', dir), 'ENVELOPE_READ_FAILED');
  await writeFile(path, mixed);
  await symlink(path, path + '-link');
  rejected(await run('large', path + '-link'), 'ENVELOPE_READ_FAILED');
});
