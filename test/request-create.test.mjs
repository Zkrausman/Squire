import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {artifactCliChild} from './helpers/artifact-cli-child.mjs';
import {parseSingleJsRequest, SINGLE_JS_PREFIX} from '../src/single-js-task.mjs';
import {parseProjectRequest, PROJECT_CODEGEN_PREFIX, DESKTOP_CODEGEN_PREFIX} from '../src/project-task.mjs';

const author = new URL('../bin/squire-request-create.mjs', import.meta.url);
const checker = new URL('../bin/squire-request-check.mjs', import.meta.url);
const taskId = 'fixture-author_42';
const profiles = [
  {family: 'single-js', parse: parseSingleJsRequest, minimum: 100, prefix: SINGLE_JS_PREFIX},
  {family: 'node', parse: parseProjectRequest, minimum: 1, prefix: PROJECT_CODEGEN_PREFIX},
  {family: 'desktop', parse: parseProjectRequest, minimum: 1, prefix: DESKTOP_CODEGEN_PREFIX},
];

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'squire-request-create-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return {dir, input: join(dir, 'instruction.txt'), output: join(dir, 'request.json')};
}

function created(result) {
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'REQUEST_CREATED\n');
}

function rejected(result, diagnostic) {
  assert.equal(result.signal, null);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, diagnostic + '\n');
}

for (const {family, parse, minimum, prefix} of profiles) {
  test('request creation preserves the instruction and fits the ' + family + ' budgets', async t => {
    const {dir, input, output} = await fixture(t);
    const args = [family, taskId, input, output];
    const max = 32768 - Buffer.byteLength(prefix);
    const exact = 'é'.repeat(Math.floor(max / 2)) + 'a'.repeat(max % 2);
    for (const prompt of [
      'a'.repeat(minimum),
      '  Write "café" to C:\\tmp.\tKeep e\u0301 and 🌱.\r\n'.repeat(4),
      exact,
    ]) {
      const original = Buffer.from(prompt);
      await writeFile(input, original);
      created(await artifactCliChild(author, args));
      const request = parse(await readFile(output));
      assert.equal(request.task_id, taskId);
      assert.deepEqual(Buffer.from(request.task_prompt), original);
      assert.deepEqual(await readFile(input), original);
      assert.equal((await stat(output)).mode & 0o777, 0o600);
      const checked = await artifactCliChild(checker, [family, output]);
      assert.equal(checked.code, 0, checked.stderr);
      const summary = JSON.parse(checked.stdout);
      assert.equal(summary.instruction_bytes, original.length);
      assert.equal(summary.remaining_prompt_bytes, max - original.length);
      await unlink(output);
    }
    for (const prompt of ['a'.repeat(minimum - 1), exact + 'x', ' '.repeat(100)]) {
      await writeFile(input, prompt);
      rejected(await artifactCliChild(author, args), 'INVALID_REQUEST');
      assert.deepEqual(await readdir(dir), ['instruction.txt']);
    }
  });
}

test('request creation checks the final escaped byte count', async t => {
  const {input, output} = await fixture(t);
  const args = ['node', taskId, input, output];
  await writeFile(input, 'x');
  created(await artifactCliChild(author, args));
  const overhead = (await stat(output)).size - 1;
  await unlink(output);
  const available = 65536 - overhead;
  // Each allowed U+0001 byte requires six ASCII bytes inside a JSON string.
  const exact = '\x01'.repeat(Math.floor(available / 6)) + 'x'.repeat(available % 6);
  await writeFile(input, exact);
  created(await artifactCliChild(author, args));
  assert.equal((await stat(output)).size, 65536);
  assert.equal(parseProjectRequest(await readFile(output)).task_prompt, exact);
  await unlink(output);
  await writeFile(input, exact + 'x');
  rejected(await artifactCliChild(author, args), 'REQUEST_TOO_LARGE');
  await assert.rejects(stat(output), {code: 'ENOENT'});
});

test('request creation rejects malformed bytes, invalid IDs and unsuitable inputs', async t => {
  const {dir, input, output} = await fixture(t);
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from([0xef, 0xbb, 0xbf, 0x78]), Buffer.from('a\0b')]) {
    await writeFile(input, bytes);
    rejected(await artifactCliChild(author, ['node', taskId, input, output]), 'INVALID_REQUEST');
    assert.deepEqual(await readFile(input), bytes);
  }
  await writeFile(input, Buffer.alloc(32769, 97));
  rejected(await artifactCliChild(author, ['node', taskId, input, output]), 'INSTRUCTION_TOO_LARGE');
  await writeFile(input, 'bounded');
  for (const id of ['Invalid!', 'a'.repeat(65)]) {
    rejected(await artifactCliChild(author, ['desktop', id, input, output]), 'INVALID_REQUEST');
  }
  const alias = join(dir, 'input-link');
  await symlink(input, alias);
  for (const path of [alias, dir, join(dir, 'missing')]) {
    rejected(await artifactCliChild(author, ['desktop', taskId, path, output]), 'INSTRUCTION_READ_FAILED');
  }
  await assert.rejects(stat(output), {code: 'ENOENT'});
});

test('request creation preserves occupied destinations and rejects invalid output paths', async t => {
  const {dir, input, output} = await fixture(t);
  const create = path => artifactCliChild(author, ['node', taskId, input, path]);
  await writeFile(input, 'synthetic text');
  await writeFile(output, 'existing data');
  for (const path of [input, output]) rejected(await create(path), 'DESTINATION_OCCUPIED');
  assert.equal(await readFile(output, 'utf8'), 'existing data');
  await unlink(output);
  for (const target of [input, join(dir, 'missing')]) {
    await symlink(target, output);
    rejected(await create(output), 'DESTINATION_OCCUPIED');
    await unlink(output);
  }
  rejected(await create(join(dir, 'missing', 'request')), 'REQUEST_WRITE_FAILED');
  assert.deepEqual(await readdir(dir), ['instruction.txt']);
  assert.equal(await readFile(input, 'utf8'), 'synthetic text');
});

test('failed partial write leaves the destination available for retry', async t => {
  const {dir, input, output} = await fixture(t);
  await writeFile(input, 'synthetic instruction');
  const args = ['node', taskId, input, output];
  const before = `
    const {default: fs} = await import('node:fs/promises');
    const {syncBuiltinESMExports} = await import('node:module');
    const open = fs.open;
    fs.open = async (path, flags, mode) => {
      const handle = await open(path, flags, mode);
      if (flags === 'wx') handle.writeFile = async bytes => {
        await handle.write(bytes.subarray(0, 16));
        throw Object.assign(Error(), {code: 'ENOSPC'});
      };
      return handle;
    };
    syncBuiltinESMExports();
  `;
  rejected(await artifactCliChild(author, args, {before}), 'REQUEST_WRITE_FAILED');
  assert.deepEqual(await readdir(dir), ['instruction.txt']);
  created(await artifactCliChild(author, args));
  assert.equal(parseProjectRequest(await readFile(output)).task_prompt, 'synthetic instruction');
});

test('request creation requires an explicit family, ID, input and output', async () => {
  const help = await artifactCliChild(author, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /<single-js\|node\|desktop>/);
  for (const args of [[], ['other', 'id', 'in', 'out'], ['node', 'id', 'in'], ['node', 'id', 'in', 'out', 'extra']]) {
    rejected(await artifactCliChild(author, args), help.stdout.trimEnd());
  }
});
